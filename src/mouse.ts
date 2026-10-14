import { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { Entity } from 'prismarine-entity'
import PrismarineItem from 'prismarine-item'
import { Block } from 'prismarine-block'
import { EventEmitter } from 'events'
import { debug } from './debug'
import { getEntityHitLocation, raycastEntity } from './entityRaycast'
import { getBlockReach } from './botCommon'
import { getLatestEntityName } from './attackableEntity'
import { BlockPlacePredictionOverride, botTryPlaceBlockPrediction, directionToVector } from './blockPlacePrediction'
import { isBlockItem } from './itemInteractions'
import { consumesAction, HandContext, InteractionResult, predictBlockUse, predictEntityInteract, predictItemUse, predictItemUseOn, VersionCompare } from './interactionRules'
import MinecraftData from 'minecraft-data'
import itemUseData from './itemUseData.json'

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

export class MouseManager {
  /** stateId - seconds */
  customBreakTime: Record<string, number> = {}
  customBreakTimeToolAllowance: Set<string> = new Set()

  buttons = [false, false, false] as [boolean, boolean, boolean]
  lastButtons = [false, false, false] as [boolean, boolean, boolean]
  cursorBlock: Block | null = null
  tick: number = 0
  private entityRaycastCache: { key: string, entity: Entity | null } | null = null
  /** Minecraft.rightClickDelay: ticks until a held right click is repeated */
  rightClickDelay: number = 0
  /** a click handled since the last tick belongs to the next tick, which then does not count its delay down */
  private useClickedSinceTick = false
  /** Minecraft.missTime: after a left click on nothing, holding the button does not mine for 10 ticks */
  missTime = 0
  /** Minecraft.startAttack returned true (the block broke at once): no continueAttack in that tick (1.19+) */
  private instantAttack = false
  /** set while a block is being mined (survival), for compatibility */
  breakStartTime: number | undefined = undefined
  ended = false
  /** a visually synced one */
  currentBreakBlock: { block: Block, stage: number } | null = null

  // MultiPlayerGameMode's destroy state
  private isDestroyingBlock = false
  private destroyBlockPos: Vec3 | null = null
  private destroyFace = 0
  private destroyProgress = 0
  private destroyDelay = 0
  private destroyingItemKey = ''
  private destroyedLocally = false

  debugDigStatus: string = 'none'
  debugLastStopReason: string = 'none'
  brokenBlocks: Block[] = []
  itemBeingUsed: ItemUseState | null = null
  /** ticks until the item in use completes (food, drinks), as LivingEntity.useItemRemaining */
  private useItemRemaining = 0
  /**
   * LocalPlayer.handsBusy (1.9+): paddling a boat (a movement key held while riding it; from 1.19.4 only as its
   * driver) keeps clicks from attacking or using. Set at the end of each tick, as rideTick sets it after the clicks.
   */
  handsBusy = false
  /** ItemCooldowns: item (cooldown group) name -> ticks left */
  cooldowns = new Map<string, number>()

  swingTimeout: any = null
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
  }

  /** stops mining the block (ABORT_DESTROY_BLOCK when mining), as MultiPlayerGameMode.stopDestroyBlock */
  stopDiggingCompletely(reason: string, tempStopping = false) {
    if (this.isDestroyingBlock) {
      this.debugDigStatus = `stopped by ${reason}`
      this.debugLastStopReason = reason
    }
    this.stopDestroyBlock()
    if (!tempStopping) {
      this.bot.emit('botArmSwingEnd', 'right')
    }
  }

  private initBotEvents() {
    this.bot.on('physicsTick', () => this.onTick())

    this.bot.on('end', () => {
      this.ended = true
    })

    // the server's swing of the bot (another source, or the server swinging for a use): only shown
    this.bot.on('entitySwingArm', (entity: Entity) => {
      if (this.bot.entity && entity.id === this.bot.entity.id) {
        if (this.swingTimeout) {
          clearTimeout(this.swingTimeout)
        }
        this.bot.emit('botArmSwingStart', 'right')
        this.swingTimeout = setTimeout(() => {
          if (this.ended) return
          this.bot.emit('botArmSwingEnd', 'right')
          this.swingTimeout = null
        }, 250)
      }
    })

    this.bot._client.on('acknowledge_player_digging', (data: { location: { x: number, y: number, z: number }, block: number, status: number, successful: boolean } | { sequenceId: number }) => {
      if ('location' in data && !data.successful) {
        const packetPos = new Vec3(data.location.x, data.location.y, data.location.z)
        // restore the block if it was broken locally (the server refused)
        if (this.bot.world.getBlockStateId(packetPos) === 0) {
          const block = this.brokenBlocks.find(b => b.position.equals(packetPos))
          if (block) {
            this.bot.world.setBlock(packetPos, block)
          } else {
            debug(`Cannot find block to restore at ${packetPos}`)
          }
        }
      }
    })

    // ItemCooldowns: the server's cooldowns (an item id before 1.21.2, a cooldown group after)
    this.bot._client.on('set_cooldown', (packet: { itemID?: number, cooldownGroup?: string, cooldownTicks: number }) => {
      const name = packet.cooldownGroup?.replace(/^minecraft:/, '') ?? MinecraftData(this.bot.version).items[packet.itemID!]?.name
      if (!name) return
      if (packet.cooldownTicks > 0) this.cooldowns.set(name, packet.cooldownTicks)
      else this.cooldowns.delete(name)
    })

    // LivingEntity.updatingUsingItem: another item in the hand stops using it, locally (the server sees the slot change)
    this.bot.on('heldItemChanged' as any, () => {
      if (this.itemBeingUsed && !this.itemBeingUsed.isOffhand) {
        this.finishUsingItem()
      }
    })
  }

  /** a right click on the entity, as startUseItem does it */
  activateEntity(entity: Entity) {
    this.startUseItem({ cursorBlock: null, entity })
  }

  beforeUpdateChecks() { }

  /**
   * The buttons changed (or the caller wants the cursor refreshed): clicks are handled at once, as the next tick's
   * Minecraft.handleKeybinds would handle them.
   */
  update() {
    this.beforeUpdateChecks()
    const cursor = this.getCursorState()
    if (this.handleClicks(cursor)) this.useClickedSinceTick = true
    this.updateButtonStates()
  }

  /** Minecraft.handleKeybinds' clicks (the button changes since they were last handled); true when a right click ran */
  private handleClicks(cursor: CursorState) {
    let usedRightClick = false
    const leftPressed = this.buttons[0] && !this.lastButtons[0]
    const rightPressed = this.buttons[2] && !this.lastButtons[2]

    // while using an item, releasing the use key releases it and clicks do nothing
    if (this.itemBeingUsed) {
      if (!this.buttons[2]) this.stopUsingItem()
    } else {
      if (leftPressed) this.instantAttack = this.startAttack(cursor) || this.instantAttack
      if (rightPressed && !this.isDestroying()) {
        this.startUseItem(cursor)
        usedRightClick = true
      }
    }
    return usedRightClick
  }

  /** Minecraft.tick: the right click delay, the held right click, continueAttack, the item in use */
  private onTick() {
    this.tick++
    this.beforeUpdateChecks()
    const cursor = this.getCursorState()
    if (!this.useClickedSinceTick && this.rightClickDelay > 0) this.rightClickDelay--
    this.useClickedSinceTick = false
    // buttons set without an update() call
    this.handleClicks(cursor)

    if (this.itemBeingUsed && !this.buttons[2]) this.stopUsingItem()
    if (this.buttons[2] && this.rightClickDelay === 0 && !this.itemBeingUsed) {
      this.startUseItem(cursor)
    }
    this.continueAttack(this.buttons[0] && !this.instantAttack, cursor)
    this.instantAttack = false
    if (this.missTime > 0) this.missTime--
    for (const [name, ticks] of this.cooldowns) {
      if (ticks <= 1) this.cooldowns.delete(name)
      else this.cooldowns.set(name, ticks - 1)
    }

    // LivingEntity.updateUsingItem: food and drinks complete after their use duration
    if (this.itemBeingUsed && --this.useItemRemaining === 0) {
      this.finishUsingItem()
    }
    this.handsBusy = this.computeHandsBusy()
    this.updateButtonStates()
  }

  /** LocalPlayer.rideTick: a movement key held while riding a boat (1.19.4+: the boat the player drives) */
  private computeHandsBusy() {
    if (this.versionCompare['<']('1.9')) return false
    const vehicle: any = (this.bot as any).vehicle ?? (this.bot.entity as any)?.vehicle
    if (!vehicle) return false
    const name = getLatestEntityName(vehicle.name ?? '') ?? vehicle.name ?? ''
    if (!/boat|raft/.test(name)) return false
    // Entity.getControlledVehicle: the boat's first passenger controls it
    if (this.versionCompare['>=']('1.19.4') && Array.isArray(vehicle.passengers) && vehicle.passengers.length && vehicle.passengers[0] !== this.bot.entity) return false
    const c = this.bot.controlState
    return !!(c.forward || c.back || c.left || c.right)
  }

  /** 1.21.11+: the main hand holds an item with the piercing_weapon component (the spears) */
  private holdsPiercingWeapon() {
    const item: any = this.bot.heldItem
    if (!item || this.versionCompare['<']('1.21.11')) return false
    return item.componentMap?.has?.('piercing_weapon') || /_spear$/.test(item.name)
  }

  /** LocalPlayer.swing for a left click: the swing packet (26.3: a punch) */
  private swingAttack() {
    if (this.versionCompare['>=']('26.3')) this.bot._client.write('punch', {})
    else this.bot.swingArm('right')
    this.bot.emit('botArmSwingStart', 'right')
    this.bot.emit('botArmSwingEnd', 'right')
  }

  /** Minecraft.startAttack: true when the block broke at once */
  private startAttack({ entity, cursorBlock }: CursorState): boolean {
    if (this.missTime > 0) return false
    // paddling: nothing at all (no swing), continueAttack still runs
    if (this.handsBusy) return false
    const v = this.versionCompare
    const spectator = this.bot.game.gameMode === 'spectator'
    // 26.1+: a spectator spectates the entity instead of attacking it, without a swing (26.2: a click on nothing too)
    if (spectator && v['>=']('26.1')) {
      // ByteBufCodecs.OPTIONAL_VAR_INT (minecraft-data types it as a plain varint): 0 for none, else the id + 1
      if (v['>=']('26.2')) this.bot._client.write('spectator_action', { entityId: entity ? entity.id + 1 : 0 })
      else if (entity) this.bot._client.write('spectate_entity', { entityId: entity.id })
      return true
    }
    // 1.21.11+: a spear (PIERCING_WEAPON) stabs instead of attacking or mining
    if (!spectator && this.holdsPiercingWeapon()) {
      // ServerboundPlayerActionPacket.Action.STAB (26.3 inserted CHANGE_DESTROY_DIRECTION before it), at the origin
      this.bot._client.write('block_dig', { status: v['>=']('26.3') ? 8 : 7, location: new Vec3(0, 0, 0), face: 0, sequence: 0 })
      // the swing packet; 26.3 swings locally without a punch
      if (v['<']('26.3')) this.bot.swingArm('right')
      this.bot.emit('botArmSwingStart', 'right')
      this.bot.emit('botArmSwingEnd', 'right')
      return true
    }
    if (entity) {
      this.bot.emit('botArmSwingStart', 'right')
      this.bot.emit('botArmSwingEnd', 'right')
      // the attack packet, then the swing (1.8: the swing first; 26.3: a punch); 1.21.11+ spectators do not swing
      ;(this.bot.attack as (entity: Entity, swing?: boolean) => void)(entity, !(spectator && v['>=']('1.21.11')))
      return false
    }
    // 1.8 swings before anything else
    if (v['<']('1.9')) this.swingAttack()
    let instant = false
    if (cursorBlock && cursorBlock.type !== 0 && cursorBlock.name !== 'air') {
      this.destroyedLocally = false
      this.startDestroyBlock(cursorBlock)
      instant = this.destroyedLocally
    } else if (this.bot.game.gameMode !== 'creative') {
      this.missTime = 10
    }
    if (v['>=']('1.9') && !(spectator && v['>=']('1.21.11'))) this.swingAttack()
    return instant
  }

  /** Minecraft.continueAttack: keeps mining the block under the crosshair, swinging each tick it does */
  private continueAttack(down: boolean, { cursorBlock }: CursorState) {
    if (!down) this.missTime = 0
    if (this.missTime > 0 || this.itemBeingUsed) return
    // 1.21.11+: holding a spear does nothing here, not even stopDestroyBlock
    if (this.holdsPiercingWeapon()) return
    if (down && cursorBlock) {
      if (cursorBlock.type !== 0 && cursorBlock.name !== 'air' && this.continueDestroyBlock(cursorBlock)) {
        this.swingAttack()
      }
    } else {
      this.stopDestroyBlock()
    }
  }

  getCursorState(): CursorState {
    const entity = this.getCachedRaycastEntity()

    // the block reach: 4.5, 5 in creative (or the block_interaction_range attribute)
    let cursorBlock = this.bot.entity ? this.bot.blockAtCursor(getBlockReach(this.bot)) : null
    if (entity) cursorBlock = null

    // the block left click would start mining (Player.blockActionRestricted)
    const cursorBlockDiggable = cursorBlock && !this.blockActionRestricted(cursorBlock) ? cursorBlock : null

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
    // the same tick, look, position and entities: the same entity
    const { yaw, pitch, position } = this.bot.entity
    const key = `${this.tick}|${yaw}|${pitch}|${position}|${Object.keys(this.bot.entities ?? {}).join(',')}`
    if (this.entityRaycastCache?.key === key) {
      return this.entityRaycastCache.entity
    }
    const entity = raycastEntity(this.bot)
    this.entityRaycastCache = { key, entity }
    return entity
  }

  // --- vanilla block breaking: MultiPlayerGameMode.startDestroyBlock / continueDestroyBlock / stopDestroyBlock ---

  /** Player.blockActionRestricted: spectators never, adventure players only with an item that may break the block */
  private blockActionRestricted(block: Block) {
    const mode = this.bot.game.gameMode
    if (mode === 'spectator') return true
    if (mode !== 'adventure') return false
    const canDestroy = (this.bot.heldItem as any)?.blocksCanDestroy as Array<[string]> | undefined
    return !canDestroy?.some(([name]) => name === block.name || name === `minecraft:${block.name}`)
  }

  /** ServerboundPlayerActionPacket.Action ordinals; 26.3 put CHANGE_DESTROY_DIRECTION at 1 */
  private digStatus(action: 'start' | 'abort' | 'stop' | 'changeDirection') {
    const shifted = this.versionCompare['>=']('26.3')
    switch (action) {
      case 'start': return 0
      case 'changeDirection': return 1
      case 'abort': return shifted ? 2 : 1
      case 'stop': return shifted ? 3 : 2
    }
  }

  private writeDig(action: 'start' | 'abort' | 'stop' | 'changeDirection', position: Vec3, face: number) {
    const predicted = action === 'start' || action === 'stop'
    this.bot._client.write('block_dig', {
      status: this.digStatus(action),
      location: position,
      face,
      // 1.19+: START and STOP carry the prediction sequence, the others 0
      sequence: predicted ? this.nextSequence() : 0
    })
  }

  /** the item, as sameDestroyTarget compares it (another item restarts the mining) */
  private heldItemKey() {
    const item: any = this.bot.heldItem
    if (!item) return ''
    return `${item.name}:${item.metadata ?? 0}:${JSON.stringify(item.nbt ?? null)}`
  }

  /** BlockState.getDestroyProgress: the share of the block one tick of mining breaks */
  private destroyProgressPerTick(block: Block) {
    const time = this.digTime(block)
    if (time === Infinity || Number.isNaN(time)) return 0
    if (!time || time <= 0) return Infinity
    return 50 / time
  }

  private isCreativeDestroy() {
    return this.bot.game.gameMode === 'creative'
  }

  /** MultiPlayerGameMode.destroyBlock: the local prediction of the break */
  private destroyBlockLocally(block: Block) {
    const position = block.position
    this.brokenBlocks = [...this.brokenBlocks.slice(-5), block]
    this.destroyedLocally = true
    this.debugDigStatus = 'success'
    if (this.currentBreakBlock) this.resetDiggingVisual(this.currentBreakBlock.block)
    if (!this.settings.noBreakPositiveUpdate) {
      const updateBlockState = (this.bot as any)._updateBlockState
      if (typeof updateBlockState === 'function') updateBlockState(position, 0)
      else this.bot.world.setBlockStateId?.(position, 0)
    }
    this.bot.emit('diggingCompleted', block)
  }

  private startDestroyBlock(block: Block): boolean {
    if (this.blockActionRestricted(block)) return false
    const face: number = (block as any).face ?? 1
    if (this.isCreativeDestroy()) {
      this.writeDig('start', block.position, face)
      this.destroyBlockLocally(block)
      this.destroyDelay = 5
      return true
    }
    if (this.isDestroyingBlock && this.sameDestroyTarget(block)) return true
    if (this.isDestroyingBlock) {
      // the old block is aborted with the new face
      this.writeDig('abort', this.destroyBlockPos!, face)
      if (this.currentBreakBlock) this.resetDiggingVisual(this.currentBreakBlock.block)
    }
    this.bot.emit('startDigging', block)
    this.bot.emit('botArmSwingStart', 'right')
    if (this.destroyProgressPerTick(block) >= 1) {
      // an instant break: START only, never a STOP, no destroy delay
      this.writeDig('start', block.position, face)
      this.isDestroyingBlock = false
      this.breakStartTime = undefined
      this.destroyBlockLocally(block)
    } else {
      this.writeDig('start', block.position, face)
      this.isDestroyingBlock = true
      this.destroyBlockPos = block.position.clone()
      this.destroyFace = face
      this.destroyingItemKey = this.heldItemKey()
      this.destroyProgress = 0
      this.breakStartTime = performance.now()
      this.debugDigStatus = 'breaking'
      this.emitDestroyStage(block)
    }
    return true
  }

  private sameDestroyTarget(block: Block) {
    return !!this.destroyBlockPos && block.position.equals(this.destroyBlockPos) && this.heldItemKey() === this.destroyingItemKey
  }

  private continueDestroyBlock(block: Block): boolean {
    if (this.destroyDelay > 0) {
      this.destroyDelay--
      return true
    }
    if (this.isCreativeDestroy()) {
      // creative breaks the block under the crosshair every 5 ticks while held
      this.destroyDelay = 5
      if (this.blockActionRestricted(block)) return true
      this.writeDig('start', block.position, (block as any).face ?? 1)
      this.destroyBlockLocally(block)
      return true
    }
    if (this.isDestroyingBlock && this.sameDestroyTarget(block)) {
      this.destroyProgress += this.destroyProgressPerTick(block)
      const face: number = (block as any).face ?? 1
      if (this.destroyProgress >= 1 - 1e-9) {
        this.isDestroyingBlock = false
        this.breakStartTime = undefined
        this.writeDig('stop', block.position, face)
        this.destroyBlockLocally(block)
        this.destroyProgress = 0
        this.destroyDelay = 5
      } else {
        // 26.3: the face changed while mining
        if (this.versionCompare['>=']('26.3') && face !== this.destroyFace) {
          this.destroyFace = face
          this.writeDig('changeDirection', block.position, face)
        }
        this.emitDestroyStage(block)
      }
      return true
    }
    return this.startDestroyBlock(block)
  }

  private stopDestroyBlock() {
    if (!this.isDestroyingBlock) return
    this.writeDig('abort', this.destroyBlockPos!, 0)
    this.isDestroyingBlock = false
    this.destroyProgress = 0
    this.breakStartTime = undefined
    this.debugDigStatus = 'aborted'
    if (this.currentBreakBlock) this.resetDiggingVisual(this.currentBreakBlock.block)
  }

  /** the crack stage shown on the block (MultiPlayerGameMode.getDestroyStage) */
  private emitDestroyStage(block: Block) {
    const stage = this.destroyProgress > 0 ? Math.min(Math.floor(this.destroyProgress * 10), 9) : 0
    if (this.currentBreakBlock?.stage !== stage || !this.currentBreakBlock.block.position.equals(block.position)) {
      this.bot.emit('blockBreakProgressStage', block, stage)
    }
    this.currentBreakBlock = { block, stage }
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
      gameMode: this.bot.game.gameMode,
      cursorBlock: this.cursorBlock
    }
  }

  /** gameMode.isDestroying(): survival mining in progress */
  private isDestroying() {
    return this.isDestroyingBlock
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
    this.rightClickDelay = 4
    // paddling: the delay is set, nothing is used
    if (this.handsBusy) return

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
        // an item on cooldown is not used on the block
        if (item && !this.cooldowns.has(item.name)) {
          let predicted: boolean | undefined
          const placementPossible = () => {
            if (hand !== 0) return true
            predicted ??= botTryPlaceBlockPrediction(
              this.bot,
              cursorBlock,
              faceNum,
              delta,
              this.settings.blockPlacePrediction ?? true,
              this.settings.blockPlacePredictionDelay ?? 0,
              this.settings.blockPlacePredictionHandler ?? null,
              this.settings.blockPlacePredictionCheckEntities ?? true,
              // the block itself passed already
              true
            )
            return predicted
          }
          // 1.8 - 1.12: a block item that cannot be placed there fails before the packet (canPlaceBlockOnSide), and
          // vanilla goes on to use the item
          if (v['<']('1.13') && isBlockItem(ctx, item.name) && !placementPossible()) return 'fail'
          result = predictItemUseOn(ctx, cursorBlock, placementPossible)
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
    // on cooldown the packet still goes, and the result is PASS (the off hand is tried next)
    const onCooldown = this.cooldowns.has(item.name)
    const { result, startsUsing } = onCooldown ? { result: 'pass' as InteractionResult, startsUsing: false } : predictItemUse(ctx)
    this.bot.activateItem(hand === 1)
    if (consumesAction(result)) this.startClientCooldown(item.name)
    ;(this.bot as any).usingHeldItem = startsUsing
    // up to 1.14 FishingRodItem.use swings the arm itself (from 1.15 the result's shouldSwing does)
    if (item.name === 'fishing_rod' && this.versionCompare['<']('1.15')) {
      this.bot.swingArm(hand === 0 ? 'right' : 'left')
    }
    if (startsUsing) {
      this.itemBeingUsed = { item, isOffhand: hand === 1, name: item.name }
      const duration = (itemUseData.useDuration as Record<string, number>)[item.name] ?? 72000
      // 0 (an ender eye): never completes
      this.useItemRemaining = duration > 0 ? duration : Number.POSITIVE_INFINITY
      this.bot.emit('startUsingItem', item, hand === 1 ? 45 : this.bot.quickBarSlot, hand === 1, -1)
    }
    return result
  }

  /** the cooldowns the client starts itself when the item is used */
  private startClientCooldown(name: string) {
    const v = this.versionCompare
    // EnderpearlItem.use (1.9+), WindChargeItem (use_cooldown from 1.21.2), InstrumentItem (the horn's use duration)
    if (name === 'ender_pearl' && v['>=']('1.9')) this.cooldowns.set(name, 20)
    if (name === 'wind_charge' && v['>=']('1.21.2')) this.cooldowns.set(name, 10)
    if (name === 'goat_horn') this.cooldowns.set(name, 140)
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

  /** MultiPlayerGameMode.releaseUsingItem: RELEASE_USE_ITEM (mineflayer's deactivateItem) */
  private stopUsingItem() {
    if (!this.itemBeingUsed) return
    this.bot.deactivateItem()
    this.finishUsingItem()
  }

  /** the player is no longer using the item (released, completed, or another item in the hand) */
  private finishUsingItem() {
    if (!this.itemBeingUsed) return
    const { isOffhand, item } = this.itemBeingUsed
    const slot = isOffhand ? 45 : this.bot.quickBarSlot
    this.itemBeingUsed = null
    ;(this.bot as any).usingHeldItem = false
    this.bot.emit('stopUsingItem', item, slot, isOffhand)
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
