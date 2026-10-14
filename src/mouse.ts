import { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { Entity } from 'prismarine-entity'
import PrismarineItem from 'prismarine-item'
import { Block } from 'prismarine-block'
import { EventEmitter } from 'events'
import { debug } from './debug'
import { getEntityHitLocation, raycastEntity } from './entityRaycast'
import { BlockPlacePredictionOverride, botTryPlaceBlockPrediction, directionToVector } from './blockPlacePrediction'
import { consumesAction, HandContext, InteractionResult, predictBlockUse, predictEntityInteract, predictItemUse, predictItemUseOn, VersionCompare } from './interactionRules'
import MinecraftData from 'minecraft-data'

export interface BlockInteractionHandler {
  test: (block: Block) => boolean
  /** return false to let the vanilla click go on */
  handle: (block: Block, bot: Bot) => void | boolean | Promise<void>
}

export interface ItemUseState {
  item: { name: string }
  isOffhand: boolean
  name: string
}

export interface BotPluginSettings {
  /** @default true */
  warnings?: boolean
  /** @default true */
  blockPlacePrediction?: boolean
  /** @default 0 */
  blockPlacePredictionDelay?: number
  /** @default true */
  blockPlacePredictionCheckEntities?: boolean
  blockPlacePredictionHandler?: BlockPlacePredictionOverride
  blockInteractionHandlers?: Record<string, BlockInteractionHandler>

  noBreakPositiveUpdate?: boolean
  /** @default true */
  preventVehicleInteraction?: boolean

  /** @default true */
  useMineflayerInteractMethods?: boolean
  /**
   * When true, allow starting a break while not on ground (mid-air).
   * Swimming in water without ground contact is always allowed without this flag.
   * @default false
   */
  allowInAirMining?: boolean
}

const defaultBlockHandlers: Record<string, BlockInteractionHandler> = {
  bed: {
    test: (block) => block.name === 'bed' || block.name.endsWith('_bed'),
    // the click itself goes to the server as vanilla sends it; the server puts the player to bed
    handle: (block, bot) => {
      bot.emit('goingToSleep', block)
      return false
    }
  }
}

export interface CursorState {
  cursorBlock: Block | null
  cursorBlockDiggable: Block | null
  cursorChanged: boolean
  /** True when block position changed (not just stateId); used to avoid spurious stops from server sync */
  cursorPositionChanged: boolean
  entity: Entity | null
}

// The delay is always 5 ticks between blocks
// https://github.com/extremeheat/extracted_minecraft_data/blob/158aff8ad2a9051505e05703f554af8e50741d69/client/net/minecraft/client/multiplayer/MultiPlayerGameMode.java#L200
const BLOCK_BREAK_DELAY_TICKS = 5

/**
 * Checks if an entity is a vehicle (minecart or boat) that could cause the bot to get stuck
 * @param entity The entity to check
 * @returns true if the entity is a minecart or boat
 */
function isProblematicVehicleEntity(entity: Entity): boolean {
  if (!entity.name) return false
  const name = entity.name.toLowerCase()
  return name === 'minecart' || name.includes('boat')
}

/** Matches anvil / chipped_anvil / damaged_anvil block ids */
const matchAnvilBlockType = (type: string) => /minecraft:(?:chipped_|damaged_)?anvil/.test(type)

const matchEnchantmentTableBlockType = (type: string) => type.startsWith('minecraft:enchant')

function blockTypeId(block: Block): string {
  return block.name.includes(':') ? block.name : `minecraft:${block.name}`
}

/** True if item is a block that exists in the registry (placeable block item) */
function isPlaceableBlockItem(bot: Bot, item: { name: string } | null | undefined): boolean {
  if (!item) return false
  try {
    return MinecraftData(bot.version).blocksByName[item.name] !== undefined
  } catch {
    return false
  }
}

/**
 * Use openAnvil / openEnchantmentTable instead of block_place when not trying to place on the block:
 * vanilla: sneak + block in hand places on the block; otherwise open GUI.
 */
function shouldOpenBlockGuiInsteadOfPlacePackets(bot: Bot): boolean {
  const sneak = bot.getControlState('sneak')
  const mainBlock = isPlaceableBlockItem(bot, bot.heldItem)
  const offBlock = bot.supportFeature('doesntHaveOffHandSlot') ? false : isPlaceableBlockItem(bot, bot.inventory.slots[45])
  return !sneak || (!mainBlock && !offBlock)
}

function isVillagerForTrade(entity: Entity): boolean {
  const n = entity.name?.toLowerCase()
  return n === 'villager' || n === 'zombie_villager'
}

/** True if feet or head are in water / bubble column (typical swimming case when `onGround` is false). */
function isEntityInWater(bot: Bot): boolean {
  return bot.entity?.['isInWater']
}

/** Whether vanilla-like mining may start: on ground, in water while airborne, or mid-air when setting allows. */
function canStartBreakMining(bot: Bot, onGround: boolean, allowInAirMining: boolean | undefined): boolean {
  if (onGround) return true
  if (allowInAirMining === true) return true
  if (isEntityInWater(bot) && !onGround) return true
  return false
}

export class MouseManager {
  /** stateId - seconds */
  customBreakTime: Record<string, number> = {}
  customBreakTimeToolAllowance: Set<string> = new Set()

  buttons = [false, false, false] as [boolean, boolean, boolean]
  lastButtons = [false, false, false] as [boolean, boolean, boolean]
  cursorBlock: Block | null = null
  tick: number = 0
  private entityRaycastCache: { tick: number, entity: Entity | null } | null = null
  prevBreakState: number | null = null
  currentDigTime: number | null = null
  prevOnGround: boolean | null = null
  rightClickDelay: number = 4
  breakStartTime: number | undefined = undefined
  ended = false
  lastDugBlock: Vec3 | null = null
  lastDugTime: number = 0
  /** a visually synced one */
  currentBreakBlock: { block: Block, stage: number } | null = null

  debugDigStatus: string = 'none'
  debugLastStopReason: string = 'none'
  brokenBlocks: Block[] = []
  lastSwing = 0
  itemBeingUsed: ItemUseState | null = null

  swingTimeout: any = null
  // todo clear when got a packet from server
  private blockHandlers: Record<string, BlockInteractionHandler>
  originalDigTime: (block: Block) => number

  constructor(private bot: Bot, public settings: BotPluginSettings = {}) {
    this.blockHandlers = {
      ...defaultBlockHandlers,
      ...(settings.blockInteractionHandlers ?? {})
    }
    this.initBotEvents()

    // patch mineflayer
    this.originalDigTime = bot.digTime
    bot.digTime = this.digTime.bind(this)
  }

  resetDiggingVisual(block: Block) {
    this.bot.emit('blockBreakProgressStage', block, null)
    this.currentBreakBlock = null
    this.prevBreakState = null
  }

  stopDiggingCompletely(reason: string, tempStopping = false) {
    // try { this.bot.stopDigging() } catch (err) { console.warn('stopDiggingCompletely', err) }
    try { this.bot.stopDigging() } catch (err) { }
    this.breakStartTime = undefined
    if (this.currentBreakBlock) {
      this.resetDiggingVisual(this.currentBreakBlock.block)
    }
    this.debugDigStatus = `stopped by ${reason}`
    this.debugLastStopReason = reason
    this.currentDigTime = null
    if (!tempStopping) {
      this.bot.emit('botArmSwingEnd', 'right')
    }
  }

  private initBotEvents() {
    this.bot.on('physicsTick', () => {
      this.tick++
      if (this.rightClickDelay < 4) this.rightClickDelay++
      this.update()
    })

    this.bot.on('end', () => {
      this.ended = true
    })

    this.bot.on('diggingCompleted', (block) => {
      this.breakStartTime = undefined
      this.lastDugBlock = block.position
      this.lastDugTime = Date.now()
      this.debugDigStatus = 'success'
      this.brokenBlocks = [...this.brokenBlocks.slice(-5), block]
      this.resetDiggingVisual(block)
      // TODO: If the tool and enchantments immediately exceed the hardness times 30, the block breaks with no delay; SO WE NEED TO CHECK THAT
      // TODO: Any blocks with a breaking time of 0.05
    })

    this.bot.on('diggingAborted', (block) => {
      if (!this.cursorBlock?.position.equals(block.position)) return
      this.debugDigStatus = 'aborted'
      this.breakStartTime = undefined
      if (this.buttons[0]) {
        this.buttons[0] = false
        this.update()
        this.buttons[0] = true // trigger again
      }
      this.lastDugBlock = null
      this.resetDiggingVisual(block)
    })

    this.bot.on('entitySwingArm', (entity: Entity) => {
      if (this.bot.entity && entity.id === this.bot.entity.id) {
        if (this.swingTimeout) {
          clearTimeout(this.swingTimeout)
        }
        this.bot.swingArm('right')
        this.bot.emit('botArmSwingStart', 'right')
        this.swingTimeout = setTimeout(() => {
          if (this.ended) return
          this.bot.emit('botArmSwingEnd', 'right')
          this.swingTimeout = null
        }, 250)
      }
    })

    //@ts-ignore
    this.bot.on('blockBreakProgressStageObserved', (block: Block, destroyStage: number, entity: Entity) => {
      if (this.bot.entity && this.cursorBlock?.position.equals(block.position) && entity.id === this.bot.entity.id) {
        if (!this.buttons[0]) {
          this.buttons[0] = true
          this.update()
        }
      }
    })

    //@ts-ignore
    this.bot.on('blockBreakProgressStageEnd', (block: Block, entity: Entity) => {
      if (this.bot.entity && this.currentBreakBlock?.block.position.equals(block.position) && entity.id === this.bot.entity.id) {
        if (!this.buttons[0]) {
          this.buttons[0] = false
          this.update()
        }
      }
    })

    this.bot._client.on('acknowledge_player_digging', (data: { location: { x: number, y: number, z: number }, block: number, status: number, successful: boolean } | { sequenceId: number }) => {
      if ('location' in data && !data.successful) {
        const packetPos = new Vec3(data.location.x, data.location.y, data.location.z)
        if (this.cursorBlock?.position.equals(packetPos)) {
          // restore the block to the world if already digged
          if (this.bot.world.getBlockStateId(packetPos) === 0) {
            const block = this.brokenBlocks.find(b => b.position.equals(packetPos))
            if (block) {
              this.bot.world.setBlock(packetPos, block)
            } else {
              debug(`Cannot find block to restore at ${packetPos}`)
            }
          }
          this.buttons[0] = false
          this.update()
        }
      }
    })

    this.bot.on('heldItemChanged' as any, () => {
      if (this.itemBeingUsed && !this.itemBeingUsed.isOffhand) {
        this.stopUsingItem()
      }
    })
  }

  /** a right click on the entity, as startUseItem does it */
  activateEntity(entity: Entity) {
    this.startUseItem({ cursorBlock: null, entity })
  }

  beforeUpdateChecks() { }

  update() {
    this.beforeUpdateChecks()
    const cursor = this.getCursorState()
    const { cursorBlock, cursorBlockDiggable, cursorChanged, cursorPositionChanged, entity } = cursor
    const leftPressed = this.buttons[0] && !this.lastButtons[0]
    const rightPressed = this.buttons[2] && !this.lastButtons[2]

    // Minecraft.handleKeybinds: while using an item, releasing the use key releases it and clicks do nothing
    if (this.itemBeingUsed) {
      if (!this.buttons[2]) this.stopUsingItem()
    } else {
      if (leftPressed) this.startAttack(cursor)
      if (rightPressed) this.startUseItem(cursor)
    }
    // held right click repeats every 4 ticks
    if (this.buttons[2] && !rightPressed && this.rightClickDelay >= 4 && !this.itemBeingUsed) {
      this.startUseItem(cursor)
    }

    if (!entity) {
      this.updateBreaking(cursorBlock, cursorBlockDiggable, cursorChanged, cursorPositionChanged)
    }

    this.updateButtonStates()
  }

  /** Minecraft.startAttack for an entity or a miss; a block is left to the breaking logic */
  private startAttack({ entity, cursorBlock, cursorBlockDiggable }: CursorState) {
    if (entity) {
      this.bot.emit('botArmSwingStart', 'right')
      this.bot.emit('botArmSwingEnd', 'right')
      this.bot.attack(entity) // sends the attack, then the swing (1.8: swing first; 26.3: a punch)
      return
    }
    if (cursorBlock && cursorBlockDiggable) return
    // a miss, or a block that cannot be broken here (adventure): one swing per click
    this.bot.swingArm('right')
    this.bot.emit('botArmSwingStart', 'right')
    this.bot.emit('botArmSwingEnd', 'right')
  }

  getCursorState(): CursorState {
    const inSpectator = this.bot.game.gameMode === 'spectator'
    const inAdventure = this.bot.game.gameMode === 'adventure'
    const entity = this.getCachedRaycastEntity()

    // If entity is found, we should stop any current digging
    let cursorBlock = this.bot.entity ? this.bot.blockAtCursor(5) : null
    if (entity) {
      cursorBlock = null
      if (this.breakStartTime !== undefined) {
        this.stopDiggingCompletely('entity interference')
      }
    }

    let cursorBlockDiggable = cursorBlock
    if (cursorBlock && (!this.bot.canDigBlock(cursorBlock) || inAdventure) && this.bot.game.gameMode !== 'creative') {
      cursorBlockDiggable = null
    }

    let cursorChanged = this.cursorBlock !== cursorBlock
    let cursorPositionChanged = false
    if (cursorBlock && this.cursorBlock) {
      const samePos = this.cursorBlock.position.equals(cursorBlock.position)
      const sameState = this.cursorBlock.stateId === cursorBlock.stateId
      cursorChanged = !(samePos && sameState)
      cursorPositionChanged = !samePos
    } else {
      cursorPositionChanged = cursorChanged
    }

    if (cursorChanged) {
      this.bot.emit('highlightCursorBlock', cursorBlock ? { block: cursorBlock } : undefined)
    }

    this.cursorBlock = cursorBlock
    return { cursorBlock, cursorBlockDiggable, cursorChanged, cursorPositionChanged, entity }
  }

  private getCachedRaycastEntity(): Entity | null {
    if (!this.bot.entity) return null
    if (this.entityRaycastCache?.tick === this.tick) {
      return this.entityRaycastCache.entity
    }
    const entity = raycastEntity(this.bot)
    this.entityRaycastCache = { tick: this.tick, entity }
    return entity
  }


  // --- vanilla right click: Minecraft.startUseItem and MultiPlayerGameMode.useItemOn / useItem / interact ---

  private get versionCompare(): VersionCompare {
    return ((this.bot as any).registry?.version ?? MinecraftData(this.bot.version).version) as VersionCompare
  }

  private ownSequence = 0
  /** the block prediction sequence (1.19+), shared with mineflayer's digging when it counts them */
  private nextSequence(): number {
    const next = (this.bot as any)._nextInteractionSequence
    return typeof next === 'function' ? next() : ++this.ownSequence
  }

  private itemInHand(hand: 0 | 1) {
    if (hand === 0) return this.bot.heldItem ?? null
    if (this.bot.supportFeature('doesntHaveOffHandSlot')) return null
    return this.bot.inventory.slots[45] ?? null
  }

  private handContext(hand: 0 | 1): HandContext {
    const mainItem = this.itemInHand(0)
    const offItem = this.itemInHand(1)
    return {
      bot: this.bot,
      data: MinecraftData(this.bot.version),
      version: this.versionCompare,
      hand,
      item: hand === 0 ? mainItem : offItem,
      mainItem,
      offItem,
      sneaking: this.bot.getControlState('sneak'),
      gameMode: this.bot.game.gameMode
    }
  }

  /** gameMode.isDestroying(): survival mining in progress */
  private isDestroying() {
    return this.breakStartTime !== undefined && this.bot.game.gameMode !== 'creative'
  }

  /** LocalPlayer.swing for a right click result: the arm swing packet goes after the action packet, none from 26.3 */
  private swingForUse(hand: 0 | 1, result: InteractionResult, kind: 'block' | 'item' | 'entity') {
    if (result !== 'success') return
    // up to 1.14 only a block's SUCCESS swings
    if (kind !== 'block' && this.versionCompare['<']('1.15')) return
    const arm = hand === 0 ? 'right' : 'left'
    if (this.versionCompare['<']('26.3')) this.bot.swingArm(arm)
    this.bot.emit('botArmSwingStart', arm)
    this.bot.emit('botArmSwingEnd', arm)
  }

  startUseItem(cursor: Pick<CursorState, 'cursorBlock' | 'entity'>) {
    if (this.isDestroying()) return
    this.rightClickDelay = 0

    const { cursorBlock, entity } = cursor

    if (entity && !this.allowEntityUse(entity)) return

    if (cursorBlock && this.runBlockInteractionHandler(cursorBlock)) return

    const v = this.versionCompare
    const hands: Array<0 | 1> = this.bot.supportFeature('doesntHaveOffHandSlot') ? [0] : [0, 1]
    for (const hand of hands) {
      const item = this.itemInHand(hand)
      if (entity) {
        const result = this.interactEntity(entity, hand)
        if (consumesAction(result)) {
          this.swingForUse(hand, result, 'entity')
          return
        }
      } else if (cursorBlock) {
        const result = this.useItemOn(cursorBlock, hand)
        if (consumesAction(result)) {
          this.swingForUse(hand, result, 'block')
          return
        }
        // 1.8: an empty hand never goes on to use the item; 1.13+: FAIL ends the click (1.9 - 1.12 go on to use the item)
        if (!item && hands.length === 1) return
        if (result === 'fail' && v['>=']('1.13')) return
      }
      if (item) {
        const result = this.useItem(hand)
        if (consumesAction(result)) {
          this.swingForUse(hand, result, 'item')
          return
        }
      }
    }
  }

  /** the plugin's own guards and mineflayer interact methods, which replace the vanilla click */
  private allowEntityUse(entity: Entity) {
    if (isVillagerForTrade(entity) && typeof this.bot.openVillager === 'function' && this.settings.useMineflayerInteractMethods !== false) {
      void this.bot.openVillager!(entity).catch((err: unknown) => this.bot.emit('error', err instanceof Error ? err : new Error(String(err))))
      return false
    }
    // Prevent activation of vehicles (minecarts/boats) to avoid getting stuck
    if (this.settings.preventVehicleInteraction !== false && isProblematicVehicleEntity(entity)) {
      // Skip activation with vehicles to prevent getting stuck inside them, which could cause server kick for flying
      console.warn(`Prevented vehicle interaction with ${entity.name} to avoid getting stuck because of Mineflayer bug`)
      return false
    }
    return true
  }

  /** true when a handler (or a mineflayer GUI method) took the click instead of the vanilla packets */
  private runBlockInteractionHandler(cursorBlock: Block) {
    if (shouldOpenBlockGuiInsteadOfPlacePackets(this.bot) && this.settings.useMineflayerInteractMethods !== false) {
      const typeId = blockTypeId(cursorBlock)
      if (matchAnvilBlockType(typeId) && typeof this.bot.openAnvil === 'function') {
        void this.bot.openAnvil!(cursorBlock).catch((err: unknown) => this.bot.emit('error', err instanceof Error ? err : new Error(String(err))))
        return true
      }
      if (matchEnchantmentTableBlockType(typeId) && typeof this.bot.openEnchantmentTable === 'function') {
        void this.bot.openEnchantmentTable!(cursorBlock).catch((err: unknown) => this.bot.emit('error', err instanceof Error ? err : new Error(String(err))))
        return true
      }
    }

    if (this.bot.getControlState('sneak')) return false
    for (const handler of Object.values(this.blockHandlers)) {
      if (!handler.test(cursorBlock)) continue
      try {
        // a handler returning false lets the vanilla click go on
        return handler.handle(cursorBlock, this.bot) !== false
      } catch (err) {
        this.bot.emit('error', err)
      }
    }
    return false
  }

  /** gameMode.interactAt then interact (one interact from 26.1): the packets are sent whatever the result */
  private interactEntity(entity: Entity, hand: 0 | 1): InteractionResult {
    const ctx = this.handContext(hand)
    const predicted = predictEntityInteract(ctx, entity)
    const spectator = this.bot.game.gameMode === 'spectator'
    const location = getEntityHitLocation(this.bot, entity)
    const sneaking = this.bot.getControlState('sneak')

    if (this.bot.supportFeature('useEntityHasLocation')) {
      // 26.1+: one ServerboundInteractPacket, interactAt is merged in
      this.bot._client.write('use_entity', { target: entity.id, hand, location: { x: location.x, y: location.y, z: location.z }, sneaking })
      if (spectator) return 'pass'
      return consumesAction(predicted.interactAt) ? predicted.interactAt : predicted.interact
    }

    this.bot._client.write('use_entity', { target: entity.id, mouse: 2, x: location.x, y: location.y, z: location.z, hand, sneaking })
    const atResult = spectator ? 'pass' : predicted.interactAt
    if (consumesAction(atResult)) return atResult
    this.bot._client.write('use_entity', { target: entity.id, mouse: 0, hand, sneaking })
    if (spectator) return 'pass'
    return predicted.interact
  }

  /** gameMode.useItemOn: block use, then the item's useOn; the packet goes whatever the result */
  private useItemOn(cursorBlock: Block, hand: 0 | 1): InteractionResult {
    const v = this.versionCompare
    const ctx = this.handContext(hand)
    const { item, mainItem, offItem } = ctx
    const delta = cursorBlock['intersect'].minus(cursorBlock.position)
    const faceNum: number = cursorBlock['face']
    const direction = directionToVector[faceNum]!

    let result: InteractionResult
    if (this.bot.game.gameMode === 'spectator') {
      result = v['>=']('1.21.2') ? 'consume' : 'success'
    } else {
      // Player.isSecondaryUseActive: sneaking with something in either hand skips the block
      const suppressUsingBlock = ctx.sneaking && (!!mainItem || !!offItem)
      result = suppressUsingBlock ? 'pass' : predictBlockUse(ctx, cursorBlock)
      if (!consumesAction(result) && result !== 'fail') {
        if (item) {
          let predicted = false
          result = predictItemUseOn(ctx, cursorBlock, () => {
            if (hand !== 0) return true
            predicted = botTryPlaceBlockPrediction(
              this.bot,
              cursorBlock,
              faceNum,
              delta,
              this.settings.blockPlacePrediction ?? true,
              this.settings.blockPlacePredictionDelay ?? 0,
              this.settings.blockPlacePredictionHandler ?? null,
              this.settings.blockPlacePredictionCheckEntities ?? true
            )
            return predicted
          })
          if (predicted) {
            this.bot.emit('mouseBlockPlaced', cursorBlock, direction, delta, false, true)
          }
        } else {
          result = 'pass'
        }
      }
    }

    this.writeUseItemOn(cursorBlock, direction, delta, hand)
    return result
  }

  private writeUseItemOn(cursorBlock: Block, direction: Vec3, delta: Vec3, hand: 0 | 1) {
    const { bot } = this
    const pos = cursorBlock.position
    const dx = delta.x
    const dy = delta.y
    const dz = delta.z
    if (bot.supportFeature('blockPlaceHasHeldItem')) {
      const Item = PrismarineItem(bot.version)
      bot._client.write('block_place', {
        location: pos,
        direction: vectorToDirection(direction),
        heldItem: Item.toNotch(bot.heldItem),
        cursorX: Math.floor(dx * 16),
        cursorY: Math.floor(dy * 16),
        cursorZ: Math.floor(dz * 16)
      })
    } else if (bot.supportFeature('blockPlaceHasHandAndIntCursor')) {
      bot._client.write('block_place', {
        location: pos,
        direction: vectorToDirection(direction),
        hand,
        cursorX: Math.floor(dx * 16),
        cursorY: Math.floor(dy * 16),
        cursorZ: Math.floor(dz * 16)
      })
    } else if (bot.supportFeature('blockPlaceHasHandAndFloatCursor')) {
      bot._client.write('block_place', {
        location: pos,
        direction: vectorToDirection(direction),
        hand,
        cursorX: dx,
        cursorY: dy,
        cursorZ: dz
      })
    } else {
      bot._client.write('block_place', {
        hand,
        location: pos,
        direction: vectorToDirection(direction),
        cursorX: dx,
        cursorY: dy,
        cursorZ: dz,
        insideBlock: false,
        worldBorderHit: false, // 1.21.2+
        sequence: this.nextSequence() // 1.19+
      })
    }
  }

  /** gameMode.useItem: no packet in spectator; otherwise use_item (mineflayer's activateItem), on cooldown too */
  private useItem(hand: 0 | 1): InteractionResult {
    if (this.bot.game.gameMode === 'spectator') return 'pass'
    const ctx = this.handContext(hand)
    const item = ctx.item!
    const { result, startsUsing } = predictItemUse(ctx)
    this.bot.activateItem(hand === 1)
    ;(this.bot as any).usingHeldItem = startsUsing
    if (startsUsing) {
      this.itemBeingUsed = { item, isOffhand: hand === 1, name: item.name }
      this.bot.emit('startUsingItem', item, hand === 1 ? 45 : this.bot.quickBarSlot, hand === 1, -1)
    }
    return result
  }

  /** kept for API compatibility: sends one use_item_on for the hand, as vanilla's useItemOn does */
  async placeBlock(cursorBlock: Block, direction: Vec3, delta: Vec3, offhand: boolean, forceLook: 'ignore' | 'lookAt' | 'lookAtForce' = 'ignore', doClientSwing = true) {
    if (offhand && this.bot.supportFeature('doesntHaveOffHandSlot')) return
    if (forceLook !== 'ignore') {
      await this.bot.lookAt(cursorBlock.position.plus(delta), forceLook === 'lookAtForce')
    }
    this.writeUseItemOn(cursorBlock, direction, delta, offhand ? 1 : 0)
    if (doClientSwing) this.swingForUse(offhand ? 1 : 0, 'success', 'block')
  }


  getCustomBreakTime(block: Block) {
    if (this.customBreakTimeToolAllowance.size) {
      const heldItemId = this.bot.heldItem?.name
      if (!this.customBreakTimeToolAllowance.has(heldItemId ?? '')) {
        return undefined
      }
    }

    return this.customBreakTime[block.stateId] ?? this.customBreakTime[block.name] ?? this.customBreakTime['*']
  }

  digTime(block: Block) {
    const customTime = this.getCustomBreakTime(block)
    if (customTime !== undefined) return customTime * 1000
    const time = this.originalDigTime(block)
    if (!time) return time
    return time
  }


  // TODO use it when item cant be used (define another map)
  // useItemOnce(item: { name: string }, isOffhand: boolean) {
  // }

  private stopUsingItem() {
    if (this.itemBeingUsed) {
      const { isOffhand, item } = this.itemBeingUsed
      const slot = isOffhand ? 45 : this.bot.quickBarSlot
      this.bot.emit('stopUsingItem', item, slot, isOffhand)
      this.bot.deactivateItem()
      this.itemBeingUsed = null
    }
  }

  private updateBreaking(cursorBlock: Block | null, cursorBlockDiggable: Block | null, cursorChanged: boolean, cursorPositionChanged: boolean) {
    // Only stop when block position changed - stateId-only changes (server sync) can cause spurious stops and stuck state
    if (cursorPositionChanged) {
      this.stopDiggingCompletely('block change delay', !!cursorBlockDiggable)
    }

    // We stopped breaking
    if (!this.buttons[0] && this.lastButtons[0]) {
      this.stopDiggingCompletely('user stopped')
    }

    const hasCustomBreakTime = cursorBlockDiggable ? this.getCustomBreakTime(cursorBlockDiggable) !== undefined : false
    const onGround = this.bot.entity?.onGround || this.bot.game.gameMode === 'creative' || hasCustomBreakTime
    const canStartBreak = canStartBreakMining(this.bot, onGround, this.settings.allowInAirMining)
    this.prevOnGround ??= onGround // todo this should be fixed in mineflayer to involve correct calculations when this changes as this is very important when mining straight down

    this.updateBreakingBlockState(cursorBlockDiggable)

    // Start break
    if (this.buttons[0]) {
      this.maybeStartBreaking(cursorBlock, cursorBlockDiggable, cursorChanged, cursorPositionChanged, canStartBreak, onGround)
    }

    this.prevOnGround = onGround
  }

  private updateBreakingBlockState(cursorBlockDiggable: Block | null) {
    // Calculate and emit break progress
    if (cursorBlockDiggable && this.breakStartTime !== undefined && this.bot.game.gameMode !== 'creative') {
      const elapsed = performance.now() - this.breakStartTime
      const time = this.digTime(cursorBlockDiggable)
      if (time !== this.currentDigTime) {
        console.warn('dig time changed! cancelling!', this.currentDigTime, '->', time)
        this.stopDiggingCompletely('dig time changed')
      } else {
        const state = Math.floor((elapsed / time) * 10)
        if (state !== this.prevBreakState) {
          this.bot.emit('blockBreakProgressStage', cursorBlockDiggable, Math.min(state, 9))
          this.currentBreakBlock = { block: cursorBlockDiggable, stage: state }
        }
        this.prevBreakState = state
      }
    }
  }

  private maybeStartBreaking(cursorBlock: Block | null, cursorBlockDiggable: Block | null, cursorChanged: boolean, cursorPositionChanged: boolean, canStartBreak: boolean, onGround: boolean) {
    const justStartingNewBreak = !this.lastButtons[0]
    // Allow resume when stopped and still on a diggable block (e.g. server restored block at same position)
    const stoppedWithBlock = this.breakStartTime === undefined && !!cursorBlockDiggable
    const blockChanged = cursorPositionChanged || (this.lastDugBlock && cursorBlock && !this.lastDugBlock.equals(cursorBlock.position)) || stoppedWithBlock
    const diggingCompletedEnoughTimePassed = !this.lastDugTime || (Date.now() - this.lastDugTime > BLOCK_BREAK_DELAY_TICKS * 1000 / 20)
    const hasCustomBreakTime = cursorBlockDiggable && this.getCustomBreakTime(cursorBlockDiggable) !== undefined
    const breakStartConditionsChanged = onGround !== this.prevOnGround && !this.currentBreakBlock

    if (cursorBlockDiggable) {
      if (
        canStartBreak
        && (justStartingNewBreak || (diggingCompletedEnoughTimePassed && (blockChanged || breakStartConditionsChanged)))
      ) {
        this.startBreaking(cursorBlockDiggable)
      }
    }
  }

  setConfigFromPacket(packet: any) {
    if (packet.customBreakTime) {
      this.customBreakTime = packet.customBreakTime
    }
    if (packet.customBreakTimeToolAllowance) {
      this.customBreakTimeToolAllowance = new Set(packet.customBreakTimeToolAllowance)
    }
    if (packet.noBreakPositiveUpdate !== undefined) {
      this.settings.noBreakPositiveUpdate = packet.noBreakPositiveUpdate
    }

    if (packet.blockPlacePrediction !== undefined) {
      this.settings.blockPlacePrediction = packet.blockPlacePrediction
    }
    if (packet.blockPlacePredictionDelay !== undefined) {
      this.settings.blockPlacePredictionDelay = packet.blockPlacePredictionDelay
    }
    if (packet.blockPlacePredictionCheckEntities !== undefined) {
      this.settings.blockPlacePredictionCheckEntities = packet.blockPlacePredictionCheckEntities
    }
    if (packet.preventVehicleInteraction !== undefined) {
      this.settings.preventVehicleInteraction = packet.preventVehicleInteraction
    }
    if (packet.allowInAirMining !== undefined) {
      this.settings.allowInAirMining = packet.allowInAirMining
    }
  }

  private startBreaking(block: Block) {
    // patch mineflayer
    if (this.settings.noBreakPositiveUpdate && !this.bot['_updateBlockStateOld']) {
      this.bot['_updateBlockStateOld'] = this.bot['_updateBlockState']
      this.bot['_updateBlockState'] = () => {}
    } else if (!this.settings.noBreakPositiveUpdate && this.bot['_updateBlockStateOld']) {
      this.bot['_updateBlockState'] = this.bot['_updateBlockStateOld']
      delete this.bot['_updateBlockStateOld']
    }

    this.lastDugBlock = null
    this.debugDigStatus = 'breaking'
    this.currentDigTime = this.digTime(block)
    this.breakStartTime = performance.now()

    // Reset break state when starting new break
    this.prevBreakState = null

    const vecArray = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)]
    this.bot.dig(
      //@ts-ignore
      block, 'ignore', vecArray[block.face], block.face
    ).catch((err) => {
      if (err.message === 'Digging aborted') return
      throw err
    })

    this.bot.emit('startDigging', block)
    this.bot.emit('botArmSwingStart', 'right')
  }

  private updateButtonStates() {
    this.lastButtons[0] = this.buttons[0]
    this.lastButtons[1] = this.buttons[1]
    this.lastButtons[2] = this.buttons[2]
  }

  getDataFromShape(shape: [number, number, number, number, number, number]) {
    const width = shape[3] - shape[0]
    const height = shape[4] - shape[1]
    const depth = shape[5] - shape[2]
    const centerX = (shape[3] + shape[0]) / 2
    const centerY = (shape[4] + shape[1]) / 2
    const centerZ = (shape[5] + shape[2]) / 2
    const position = new Vec3(centerX, centerY, centerZ)
    return { position, width, height, depth }
  }

  getBlockCursorShapes(block: Block): [number, number, number, number, number, number][] {
    const shapes = [...block.shapes ?? [], ...block['interactionShapes'] ?? []]
    if (!shapes.length) return []

    return shapes
  }

  getMergedCursorShape(block: Block): [number, number, number, number, number, number] | undefined {
    const shapes = this.getBlockCursorShapes(block)
    if (!shapes.length) return undefined

    return shapes.reduce((acc, cur) => {
      return [
        Math.min(acc[0]!, cur[0]!),
        Math.min(acc[1]!, cur[1]!),
        Math.min(acc[2]!, cur[2]!),
        Math.max(acc[3]!, cur[3]!),
        Math.max(acc[4]!, cur[4]!),
        Math.max(acc[5]!, cur[5]!)
      ]
    }) as [number, number, number, number, number, number]
  }
}

export const versionToNumber = (ver: string) => {
  const [x, y = '0', z = '0'] = ver.split('.')
  return +`${x!.padStart(2, '0')}${y.padStart(2, '0')}${z.padStart(2, '0')}`
}

const OLD_UNSUPPORTED_VERSIONS = versionToNumber('1.16.5')

let warningPrinted = false
export function inject(bot: Bot, settings: BotPluginSettings) {
  if (settings.warnings !== false && !warningPrinted && versionToNumber(bot.version) <= OLD_UNSUPPORTED_VERSIONS) {
    console.warn(`[mineflayer-mouse] This version of Minecraft (${bot.version}) has known issues like doors interactions or item using. Please upgrade to a newer, better tested version for now.`)
    warningPrinted = true
  }

  const mouse = new MouseManager(bot, settings)
  bot.mouse = mouse

  bot.rightClickStart = () => {
    mouse.buttons[2] = true
    mouse.update()
  }
  bot.rightClickEnd = () => {
    mouse.buttons[2] = false
    mouse.update()
  }
  bot.leftClickStart = () => {
    mouse.buttons[0] = true
    mouse.update()
  }
  bot.leftClickEnd = () => {
    mouse.buttons[0] = false
    mouse.update()
  }
  bot.leftClick = () => {
    bot.leftClickStart()
    bot.leftClickEnd()
  }
  bot.rightClick = () => {
    bot.rightClickStart()
    bot.rightClickEnd()
  }
  Object.defineProperty(bot, 'usingItem', {
    get: () => mouse.itemBeingUsed
  })

  return mouse
}

declare module 'mineflayer' {
  interface Bot {
    mouse: MouseManager

    rightClickStart: () => void
    rightClickEnd: () => void
    leftClickStart: () => void
    leftClickEnd: () => void
    leftClick: () => void
    rightClick: () => void
    readonly usingItem: ItemUseState | null
  }

  interface BotEvents {
    'botArmSwingStart': (hand: 'right' | 'left') => void
    'botArmSwingEnd': (hand: 'right' | 'left') => void
    'blockBreakProgressStage': (block: Block, stage: number | null) => void
    'startDigging': (block: Block) => void
    'goingToSleep': (block: Block) => void
    'startUsingItem': (item: { name: string }, slot: number, isOffhand: boolean, duration: number) => void
    'stopUsingItem': (item: { name: string }, slot: number, isOffhand: boolean) => void
    'highlightCursorBlock': (data?: { block: Block }) => void
    'mouseBlockPlaced': (block: Block, direction: Vec3, delta: Vec3, offhand: boolean, wasPredicted: boolean) => void
  }
}


export { MouseManager as MousePlugin }

function vectorToDirection (v: Vec3) {
  if (v.y < 0) {
    return 0
  } else if (v.y > 0) {
    return 1
  } else if (v.z < 0) {
    return 2
  } else if (v.z > 0) {
    return 3
  } else if (v.x < 0) {
    return 4
  } else if (v.x > 0) {
    return 5
  }
  throw new Error(`invalid direction vector ${v}`)
}
