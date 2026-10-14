/**
 * A fake mineflayer bot for driving the mouse plugin tick by tick and recording every serverbound packet it causes.
 *
 * The bot's own methods the plugin calls (swingArm, activateItem, deactivateItem, attack, dig, stopDigging) send the
 * packets the mineflayer the web client runs sends for them (the vanilla shapes per version), so a test sees the whole
 * serverbound stream. Every packet is serialized with minecraft-protocol for the version, so a wrong shape fails.
 */
import { EventEmitter } from 'events'
import { Vec3 } from 'vec3'
import MinecraftData from 'minecraft-data'
import PrismarineBlock, { Block } from 'prismarine-block'
import PrismarineItem, { Item } from 'prismarine-item'
import { createSerializer } from 'minecraft-protocol'
import { Bot } from 'mineflayer'
import { inject, MouseManager } from '../../src/mouse'

export interface SentPacket {
  tick: number
  name: string
  params: any
}

export interface FakeBotOptions {
  gameMode?: 'survival' | 'creative' | 'adventure' | 'spectator'
  food?: number
  /** serialize every packet with minecraft-protocol (default true) */
  serialize?: boolean
}

export type Face = 0 | 1 | 2 | 3 | 4 | 5

export interface CursorBlockOptions {
  position?: Vec3
  face?: Face
  /** hit point relative to the block's position */
  hit?: Vec3
  properties?: Record<string, any>
}

const serializers = new Map<string, any>()
function getSerializer(version: string) {
  let serializer = serializers.get(version)
  if (!serializer) {
    serializer = createSerializer({ state: 'play' as any, isServer: false, version })
    serializers.set(version, serializer)
  }
  return serializer
}

const faceHit: Record<Face, Vec3> = {
  0: new Vec3(0.5, 0, 0.5),
  1: new Vec3(0.5, 1, 0.5),
  2: new Vec3(0.5, 0.5, 0),
  3: new Vec3(0.5, 0.5, 1),
  4: new Vec3(0, 0.5, 0.5),
  5: new Vec3(1, 0.5, 0.5)
}

export class FakeBot {
  bot: Bot
  mouse!: MouseManager
  data: MinecraftData.IndexedData
  packets: SentPacket[] = []
  tickCount = 0
  Item: typeof Item
  Block: typeof Block
  private sequence = 0
  private cursorBlock: Block | null = null

  constructor(public version: string, public options: FakeBotOptions = {}) {
    this.data = MinecraftData(version)
    this.Item = PrismarineItem(version as any) as any
    this.Block = PrismarineBlock(version as any) as any
    this.bot = this.createBot()
  }

  get v() {
    return this.data.version as any as Record<'>=' | '<' | '>' | '<=', (v: string) => boolean>
  }

  private write(name: string, params: any) {
    if (this.options.serialize !== false) {
      // throws on a field missing or of the wrong type for this version
      getSerializer(this.version).createPacketBuffer({ name, params })
    }
    this.packets.push({ tick: this.tickCount, name, params })
  }

  private createBot(): Bot {
    const bot = new EventEmitter() as any as Bot
    const fake = this
    bot.setMaxListeners(100)
    bot.version = this.version
    ;(bot as any).registry = this.data
    bot.supportFeature = this.data.supportFeature as any
    bot.game = { gameMode: this.options.gameMode ?? 'survival' } as any
    bot.food = this.options.food ?? 20
    bot.entity = {
      id: 1,
      type: 'player',
      name: 'player',
      position: new Vec3(0.5, 64, 0.5),
      velocity: new Vec3(0, 0, 0),
      yaw: 0,
      pitch: 0,
      onGround: true,
      height: 1.8,
      width: 0.6,
      metadata: []
    } as any
    bot.entities = {} as any
    bot.controlState = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
    bot.getControlState = (state) => bot.controlState[state]
    bot.setControlState = (state, value) => { bot.controlState[state] = value }
    bot.quickBarSlot = 0
    const slots: (Item | null)[] = new Array(46).fill(null)
    bot.inventory = { slots } as any
    Object.defineProperty(bot, 'heldItem', { get: () => slots[36 + bot.quickBarSlot] ?? null, configurable: true })
    bot.blockAtCursor = () => fake.cursorBlock as any
    bot.canDigBlock = () => true
    bot.digTime = () => 1000
    bot.world = {
      getBlock: (pos: Vec3) => (fake.cursorBlock?.position.equals(pos) ? fake.cursorBlock : null),
      getBlockStateId: (pos: Vec3) => (fake.cursorBlock?.position.equals(pos) ? fake.cursorBlock.stateId : 0),
      setBlock: () => {},
      setBlockStateId: () => {}
    } as any
    bot.lookAt = async () => {}
    bot.sleep = async () => {}
    ;(bot as any)._nextInteractionSequence = () => ++fake.sequence
    bot._client = { write: (name: string, params: any) => fake.write(name, params), on: () => {} } as any

    // --- the mineflayer methods the plugin calls, as the web client's mineflayer sends them ---

    bot.swingArm = (arm = 'right', showHand = true) => {
      if (fake.v['>=']('26.3')) {
        // 26.3 has no swing packet: an attack's or a dig's swing is a punch
        if (arm === 'right') fake.write('punch', {})
        return
      }
      const params: any = {}
      if (showHand && !bot.supportFeature('doesntHaveOffHandSlot')) params.hand = arm === 'right' ? 0 : 1
      fake.write('arm_animation', params)
    }

    bot.activateItem = (offHand = false) => {
      ;(bot as any).usingHeldItem = true
      if (fake.v['>=']('1.17') && fake.v['<']('1.21')) {
        const { position, onGround } = bot.entity
        fake.write('position_look', { x: position.x, y: position.y, z: position.z, yaw: 0, pitch: 0, onGround, flags: { onGround, hasHorizontalCollision: false } })
      }
      if (bot.supportFeature('useItemWithBlockPlace')) {
        fake.write('block_place', {
          location: new Vec3(-1, 255, -1),
          direction: -1,
          heldItem: fake.Item.toNotch(bot.heldItem),
          cursorX: -1,
          cursorY: -1,
          cursorZ: -1
        })
      } else {
        fake.write('use_item', { hand: offHand ? 1 : 0, sequence: bot.supportFeature('useItemWithOwnPacket') ? ++fake.sequence : undefined, rotation: { x: 0, y: 0 } })
      }
    }

    bot.deactivateItem = () => {
      const params: any = { status: fake.v['>=']('26.3') ? 6 : 5, location: new Vec3(0, 0, 0), face: 0 }
      if (fake.v['>=']('1.19')) params.sequence = 0
      fake.write('block_dig', params)
      ;(bot as any).usingHeldItem = false
    }

    const useEntity = (target: any, mouse: number) => {
      const sneaking = bot.getControlState('sneak')
      if (bot.supportFeature('attackUsesOwnPacket')) {
        if (mouse === 1) fake.write('attack', { entityId: target.id })
        else fake.write('use_entity', { target: target.id, hand: 0, location: { x: 0, y: 0, z: 0 }, sneaking })
        return
      }
      fake.write('use_entity', { target: target.id, mouse, sneaking })
    }

    bot.attack = (target: any, swing = true) => {
      if (bot.supportFeature('armAnimationBeforeUse')) {
        if (swing) bot.swingArm()
        useEntity(target, 1)
      } else {
        useEntity(target, 1)
        if (swing) bot.swingArm()
      }
    }

    // digging: a stand-in that sends what mineflayer's dig sends at the start and on an abort
    let digging: Block | null = null
    bot.dig = (async (block: Block, _forceLook: any, _faceVec: any, face = 1) => {
      if (digging) bot.stopDigging()
      const params: any = { status: 0, location: block.position, face }
      if (fake.v['>=']('1.19')) params.sequence = ++fake.sequence
      fake.write('block_dig', params)
      digging = block
      bot.swingArm()
    }) as any
    bot.stopDigging = () => {
      if (!digging) return
      const params: any = { status: fake.v['>=']('26.3') ? 2 : 1, location: digging.position, face: 0 }
      if (fake.v['>=']('1.19')) params.sequence = ++fake.sequence
      fake.write('block_dig', params)
      digging = null
    }
    return bot
  }

  // --- world setup ---

  makeItem(name: string, count = 1): Item {
    const data = this.data.itemsByName[name]
    if (!data) throw new Error(`no item ${name} in ${this.version}`)
    return new this.Item(data.id, count)
  }

  /** hotbar slot 0 is the main hand, slot 45 the off hand */
  hold(main: string | null, off: string | null = null) {
    const slots = this.bot.inventory.slots as (Item | null)[]
    slots[36 + this.bot.quickBarSlot] = main ? this.makeItem(main) : null
    slots[45] = off ? this.makeItem(off) : null
    return this
  }

  makeBlock(name: string, properties: Record<string, any> = {}): Block {
    const data = this.data.blocksByName[name]
    if (!data) throw new Error(`no block ${name} in ${this.version}`)
    let block: Block
    if (Object.keys(properties).length && (this.Block as any).fromProperties) {
      block = (this.Block as any).fromProperties(data.id, properties, 0)
    } else if (data.defaultState !== undefined && (this.Block as any).fromStateId) {
      block = (this.Block as any).fromStateId(data.defaultState, 0)
    } else {
      block = new (this.Block as any)(data.id, 0, 0)
    }
    return block
  }

  lookAtBlock(name: string, { position = new Vec3(0, 63, 2), face = 1, hit, properties = {} }: CursorBlockOptions = {}) {
    const block = this.makeBlock(name, properties) as any
    block.position = position
    block.face = face
    block.intersect = position.plus(hit ?? faceHit[face])
    this.cursorBlock = block
    return block as Block
  }

  lookAtNothing() {
    this.cursorBlock = null
    this.bot.entities = {} as any
  }

  /** puts an entity right in front of the player, under the crosshair (the player looks along -z... yaw 0 looks to -z) */
  lookAtEntity(name: string, { id = 2, metadata = [] as any[] } = {}) {
    const data = this.data.entitiesByName[name]
    if (!data) throw new Error(`no entity ${name} in ${this.version}`)
    const eye = this.bot.entity.position.offset(0, 1.62, 0)
    const entity = {
      id,
      name,
      type: data.type,
      position: new Vec3(eye.x, eye.y - (data.height ?? 1) / 2, eye.z - 2),
      width: data.width ?? 0.6,
      height: data.height ?? 1,
      metadata
    } as any
    this.cursorBlock = null
    this.bot.entities = { [id]: entity } as any
    return entity
  }

  inject(settings: Parameters<typeof inject>[1] = {}) {
    this.mouse = inject(this.bot, { warnings: false, blockPlacePrediction: false, ...settings })
    return this
  }

  // --- input ---

  tick(n = 1) {
    for (let i = 0; i < n; i++) {
      this.tickCount++
      this.bot.emit('physicsTick')
    }
    return this
  }

  pressRight() { this.bot.rightClickStart(); return this }
  releaseRight() { this.bot.rightClickEnd(); return this }
  pressLeft() { this.bot.leftClickStart(); return this }
  releaseLeft() { this.bot.leftClickEnd(); return this }
  sneak(value = true) { this.bot.setControlState('sneak', value); return this }

  // --- assertions ---

  /** the packets sent since the last take, as [name, params] */
  take(filter?: (p: SentPacket) => boolean) {
    const packets = filter ? this.packets.filter(filter) : this.packets
    this.packets = []
    return packets
  }

  /** compact form: names with the fields that tell the action */
  takeCompact(): string[] {
    return this.take().filter(p => p.name !== 'position_look').map(compactPacket)
  }
}

export function compactPacket(p: { name: string, params: any }): string {
  const { name, params } = p
  switch (name) {
    case 'block_place':
      if (params.direction === -1) return 'use_item(1.8)'
      return `use_item_on(hand=${params.hand ?? 0})`
    case 'use_item':
      return `use_item(hand=${params.hand})`
    case 'arm_animation':
      return `swing(hand=${params.hand ?? 0})`
    case 'use_entity':
      if (params.location) return `interact(hand=${typeof params.hand === 'string' ? (params.hand === 'off_hand' ? 1 : 0) : params.hand})`
      return params.mouse === 1 ? 'attack' : params.mouse === 2 ? `interact_at(hand=${params.hand ?? 0})` : `interact(hand=${params.hand ?? 0})`
    case 'attack':
      return 'attack'
    case 'punch':
      return 'punch'
    case 'block_dig':
      return `player_action(${params.status})`
    default:
      return name
  }
}

export function createFakeBot(version: string, options: FakeBotOptions = {}) {
  return new FakeBot(version, options)
}
