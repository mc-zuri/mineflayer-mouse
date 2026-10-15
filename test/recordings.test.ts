/**
 * Replays real vanilla client recordings (test/fixtures/recordings, imported from the physics-data-generator by
 * scripts/fixtures/importRecordings.js) through the plugin on the fake bot, and compares the click packets it sends,
 * tick by tick, with the ones vanilla sent.
 */
import fs from 'fs'
import path from 'path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Vec3 } from 'vec3'
import { createFakeBot, SentPacket } from './harness/fakeBot'
import { supportedReleases } from './harness/versions'

interface FixtureTick {
  t: number
  in: string[]
  target?: { block?: { stateId: number, pos: [number, number, number], face: number, hit?: [number, number, number] }, entity?: number }
  packets?: Array<[string, any]>
  /** the server's state packets of the tick (world border, riding, selected slot) */
  server?: Array<[string, any]>
  /** the food level the server last sent */
  food?: number
}
interface Fixture {
  name: string
  version: string
  gamemode: string
  position?: [number, number, number] | null
  /** the player's entity id in the recording */
  playerEntityId?: number
  food?: number
  selected: number
  inventory: Record<string, [string, number]>
  entities: Record<string, string>
  ticks: FixtureTick[]
}

const root = path.join(__dirname, 'fixtures/recordings')
const fixtures: Array<[string, string, Fixture]> = []
for (const version of fs.existsSync(root) ? fs.readdirSync(root) : []) {
  if (!supportedReleases.includes(version)) continue
  for (const file of fs.readdirSync(path.join(root, version))) {
    fixtures.push([version, file.replace(/\.json$/, ''), JSON.parse(fs.readFileSync(path.join(root, version, file), 'utf8'))])
  }
}

/** vanilla's inventory index (0-8 hotbar, 9-35 main, 36-39 feet..head, 40 off hand) as a mineflayer window slot */
const windowSlot = (index: number) => (index <= 8 ? 36 + index : index <= 35 ? index : index === 40 ? 45 : 8 - (index - 36))

/** the fields that tell what a packet does; sequence numbers are compared for their order only */
export function describePacket(name: string, p: any): string {
  const pos = (l: any) => (l ? `${l.x},${l.y},${l.z}` : '-')
  switch (name) {
    case 'block_place':
      if (p.direction === -1 || p.direction === 255) return 'use_item(1.8)'
      return `use_item_on(hand=${p.hand ?? 0} ${pos(p.location)} face=${p.direction})`
    case 'use_item': return `use_item(hand=${p.hand})`
    case 'arm_animation': return `swing(hand=${p.hand ?? 0})`
    case 'use_entity': {
      const hand = p.hand === 'off_hand' || p.hand === 1 ? 1 : 0
      if (p.location) return `interact(hand=${hand})`
      return p.mouse === 1 ? 'attack' : p.mouse === 2 ? `interact_at(hand=${hand})` : `interact(hand=${hand})`
    }
    case 'attack': return 'attack'
    case 'punch': return 'punch'
    case 'block_dig': return `player_action(${p.status} ${pos(p.location)} face=${p.face})`
    default: return name
  }
}

/** the server's packets a replay feeds back to the bot, as mineflayer would apply them */
function applyServerPacket(f: ReturnType<typeof createFakeBot>, fixture: Fixture, name: string, params: any) {
  if (name === 'set_passengers') {
    const playerId = fixture.playerEntityId
    const vehicle: any = { id: params.entityId, name: fixture.entities[params.entityId] ?? 'oak_boat', passengers: [] }
    vehicle.passengers = (params.passengers ?? []).map((id: number) => (id === playerId ? f.bot.entity : { id }))
    if (vehicle.passengers.includes(f.bot.entity)) (f.bot.entity as any).vehicle = vehicle
    else if ((f.bot.entity as any).vehicle?.id === params.entityId) delete (f.bot.entity as any).vehicle
    return
  }
  if (name === 'held_item_slot') {
    f.bot.quickBarSlot = params.slot ?? params.slotId ?? f.bot.quickBarSlot
    return
  }
  f.bot._client.emit(name, params)
}

const IGNORED = new Set(['held_item_slot', 'position_look', 'position', 'look', 'flying'])

function replay(version: string, fixture: Fixture) {
  const f = createFakeBot(version, { gameMode: fixture.gamemode as any, food: fixture.food })
  f.inject()
  if (fixture.position) f.bot.entity.position = new Vec3(...fixture.position)
  for (const [index, [name, count]] of Object.entries(fixture.inventory)) {
    try {
      f.bot.inventory.slots[windowSlot(+index)] = f.makeItem(name, count)
    } catch {
      // an item this version names otherwise: left out
    }
  }
  f.bot.quickBarSlot = fixture.selected
  // the server's side of eating: a meal completed with the button held fills the food bar
  f.bot.on('stopUsingItem', () => {
    if (f.mouse.buttons[2] && f.bot.food < 20) f.bot.food = 20
  })
  const entityIds: Record<string, any> = {}

  const mismatches: string[] = []
  const lastSequence = { value: -1 }
  const byTick = new Map(fixture.ticks.map(t => [t.t, t]))
  const first = fixture.ticks[0]!.t
  const last = fixture.ticks[fixture.ticks.length - 1]!.t
  const held = { use: false, attack: false, pickItem: false }
  for (let t = first; t <= last; t++) {
    const tick = byTick.get(t)
    const input = tick?.in ?? []
    if (tick) {
      if (tick.target?.block) {
        const { stateId, pos, face, hit } = tick.target.block
        f.lookAtBlockState(stateId, { position: new Vec3(...pos), face: face as any, hit: hit ? new Vec3(...hit) : undefined })
      } else if (tick.target?.entity !== undefined) {
        const id = tick.target.entity
        entityIds[id] ??= f.lookAtEntity(fixture.entities[id] ?? 'pig', { id })
        f.lookAtNothing()
        f.bot.entities = { [f.bot.entity.id]: f.bot.entity, [id]: entityIds[id] } as any // the same entity, with its state
      } else {
        f.lookAtNothing()
      }
    } else {
      f.lookAtNothing()
    }
    f.sneak(input.includes('sneak'))
    for (const key of ['forward', 'back', 'left', 'right'] as const) f.bot.setControlState(key, input.includes(key))
    if (tick?.food !== undefined) f.bot.food = tick.food
    // the clicks since the last tick, then the tick (they belong to it, as to vanilla's handleKeybinds)
    for (const button of ['attack', 'use', 'pickItem'] as const) {
      const down = input.includes(button)
      if (down !== held[button]) {
        held[button] = down
        if (button === 'use') down ? f.pressRight() : f.releaseRight()
        else if (button === 'attack') down ? f.pressLeft() : f.releaseLeft()
        else down ? f.bot.middleClickStart() : f.bot.middleClickEnd()
      }
    }
    vi.advanceTimersByTime(50)
    f.tick()
    // the server's state packets of the tick: the world border, riding, the selected slot
    for (const [name, params] of tick?.server ?? []) applyServerPacket(f, fixture, name, params)

    const actual = f.take().filter(p => !IGNORED.has(p.name))
    // the server's side of a lead: the first interaction attaches the mob to the player, the next unties it
    const leashed = actual.find(p => p.name === 'use_entity' && (p.params.mouse === 0 || p.params.location))
    if (leashed && f.bot.heldItem?.name === 'lead') {
      const mob: any = f.bot.entities[leashed.params.target]
      if (mob) mob.vehicle = mob.vehicle ? undefined : f.bot.entity
    }
    const expected = (tick?.packets ?? []).filter(([name]) => !IGNORED.has(name))
    const a = actual.map(p => describePacket(p.name, p.params))
    const e = expected.map(([name, params]) => describePacket(name, params))
    if (JSON.stringify(a) !== JSON.stringify(e)) {
      mismatches.push(`t${t} [${input.join(',')}]: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`)
    }
    for (const p of actual as SentPacket[]) {
      if (typeof p.params.sequence === 'number' && p.params.sequence > 0) {
        if (p.params.sequence <= lastSequence.value) mismatches.push(`t${t}: sequence ${p.params.sequence} does not rise`)
        lastSequence.value = p.params.sequence
      }
    }
  }
  return mismatches
}

/**
 * Ticks of recordings that depend on what the recording does not keep, by "<version> <case>" or "<case>", with the
 * reason. Every other tick must match.
 */
export const knownDivergences: Record<string, { from?: number, to?: number, reason: string }> = {
  // the client completes the meal after 32 ticks; when it sends the next use_item (one or two ticks later in some
  // versions) follows the server's item and health updates, which the recordings do not keep
  m_damage_food: { from: 110, reason: 'eating completion timing follows server packets' },
  // a lead on a mob is CONSUME on the client from 1.21.11 (no swing in startUseItem); the swing two ticks later
  // follows the server's slot update, not the click
  '1.21.11 m_leash': { from: 2, to: 4, reason: 'the swing after the server attached the lead' },
  '26.1 m_leash': { from: 2, to: 4, reason: 'the swing after the server attached the lead' }
}

const tickOf = (mismatch: string) => Number(/^t(\d+)/.exec(mismatch)?.[1])
/**
 * 1.15.2's recordings repeat (or move) the swing of a use on the next tick, as a lone swing packet; its
 * Minecraft.startUseItem and LocalPlayer.swing (bytecode of the 1.15.2 client) send one swing in the click's tick
 */
const lateSwing115 = /: expected \["swing\(hand=[01]\)"\], got \[\]$/
function unexplained(version: string, name: string, mismatches: string[]) {
  if (version === '1.15.2') mismatches = mismatches.filter(m => !lateSwing115.test(m))
  const known = knownDivergences[`${version} ${name}`] ?? knownDivergences[name]
  if (!known) return mismatches
  return mismatches.filter(m => {
    const t = tickOf(m)
    return !((known.from === undefined || t >= known.from) && (known.to === undefined || t <= known.to))
  })
}

describe('vanilla recordings', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(fixtures.map(([v, name, fixture]) => [`${v} ${name}`, v, fixture] as const))('%s', (_, version, fixture) => {
    vi.useFakeTimers()
    const mismatches = replay(version, fixture)
    expect(unexplained(version, fixture.name, mismatches)).toEqual([])
  })
})

if (process.env.REPLAY_REPORT) {
  it('report', () => {
    vi.useFakeTimers()
    for (const [v, name, fixture] of fixtures) {
      const mismatches = replay(v, fixture)
      const left = unexplained(v, name, mismatches)
      console.log(`${v} ${name}: ${left.length ? left.slice(0, 4).join('\n    ') : mismatches.length ? 'ok (known divergences)' : 'ok'}`)
    }
    vi.useRealTimers()
  })
}
