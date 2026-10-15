/**
 * Left click parity with vanilla's Minecraft.startAttack / continueAttack and MultiPlayerGameMode's block breaking,
 * per version, as the decompiled clients dictate. A click belongs to the tick that follows it, as vanilla handles
 * clicks in Minecraft.tick: `press(); tick()` is one vanilla tick.
 */
import { describe, it, expect } from 'vitest'
import { Vec3 } from 'vec3'
import { createFakeBot, FakeBot } from './harness/fakeBot'
import { representativeVersions, atLeast } from './harness/versions'

const swing = (v: string) => (atLeast(v, '26.3') ? 'punch' : 'swing(hand=0)')
const status = (v: string, action: 'start' | 'abort' | 'stop') => {
  const shifted = atLeast(v, '26.3')
  return `player_action(${{ start: 0, abort: shifted ? 2 : 1, stop: shifted ? 3 : 2 }[action]})`
}

const pos = new Vec3(0, 63, 2)

describe.each(representativeVersions)('%s left click', (v) => {
  const bot = (options = {}) => createFakeBot(v, options).inject()
  /** START then the swing (1.8: the swing first) */
  const startAndSwing = () => (atLeast(v, '1.9') ? [status(v, 'start'), swing(v)] : [swing(v), status(v, 'start')])

  const dig = (f: FakeBot) => {
    f.hold('wooden_pickaxe')
    f.lookAtBlock('dirt', { position: pos, face: 4 })
  }

  it('mines a block: START, a swing every tick, STOP when broken, 5 ticks of destroy delay', () => {
    const f = bot()
    dig(f)
    const ticks = Math.round(f.bot.digTime(f.mouse.cursorBlock ?? (f.bot.blockAtCursor() as any)) / 50)
    expect(ticks).toBeGreaterThan(2)
    f.pressLeft().tick()
    // the click tick: START and its swing, then continueAttack's first progress and swing
    expect(f.takeCompact()).toEqual([...startAndSwing(), swing(v)])
    for (let i = 2; i < ticks; i++) {
      f.tick()
      expect(f.takeCompact()).toEqual([swing(v)])
    }
    f.tick()
    expect(f.takeCompact()).toEqual([status(v, 'stop'), swing(v)])
    // the next block: 5 ticks of destroy delay (swinging), then START with a single swing
    dig(f)
    for (let i = 0; i < 5; i++) {
      f.tick()
      expect(f.takeCompact()).toEqual([swing(v)])
    }
    f.tick()
    expect(f.takeCompact()).toEqual([status(v, 'start'), swing(v)])
    f.releaseLeft().tick()
    const [abort] = f.take()
    expect(abort!.name).toBe('block_dig')
    // ABORT names the block, facing down, with sequence 0
    expect(abort!.params).toMatchObject({ location: pos, face: 0 })
    if (atLeast(v, '1.19')) expect(abort!.params.sequence).toBe(0)
  })

  it('START and STOP carry the rising prediction sequence (1.19+)', () => {
    const f = bot()
    dig(f)
    f.pressLeft().tick(40)
    const sequences = f.take().filter(p => p.name === 'block_dig').map(p => p.params.sequence)
    if (atLeast(v, '1.19')) {
      expect(sequences.length).toBeGreaterThanOrEqual(2)
      expect(sequences[1]).toBeGreaterThan(sequences[0])
    }
  })

  it('a block that breaks at once: START only, no STOP, no destroy delay', () => {
    const f = bot().hold(null)
    f.lookAtBlock(atLeast(v, '1.13') ? 'torch' : 'torch', { position: pos })
    f.pressLeft().tick()
    expect(f.takeCompact()).toEqual(startAndSwing())
  })

  it('creative: START and a swing, then a swing every tick and another break every 6 ticks', () => {
    const f = bot({ gameMode: 'creative' }).hold(null)
    f.lookAtBlock('stone', { position: pos })
    f.pressLeft().tick()
    expect(f.takeCompact()).toEqual(startAndSwing())
    f.lookAtBlock('stone', { position: pos })
    for (let i = 0; i < 5; i++) {
      f.tick()
      expect(f.takeCompact()).toEqual([swing(v)])
    }
    f.tick()
    expect(f.takeCompact()).toEqual([status(v, 'start'), swing(v)])
  })

  it('a click on nothing swings once; holding does nothing', () => {
    const f = bot().hold(null)
    f.lookAtNothing()
    f.pressLeft().tick()
    expect(f.takeCompact()).toEqual([swing(v)])
    f.tick(10)
    expect(f.takeCompact()).toEqual([])
  })

  it('after a click on nothing, holding the button does not mine for 10 ticks (missTime)', () => {
    const f = bot()
    f.lookAtNothing()
    f.pressLeft().tick()
    f.take()
    dig(f)
    f.tick(8)
    expect(f.takeCompact()).toEqual([])
    f.tick(2)
    expect(f.takeCompact()).toEqual([status(v, 'start'), swing(v)])
  })

  it('adventure: a click on a block swings without mining', () => {
    const f = bot({ gameMode: 'adventure' })
    dig(f)
    f.pressLeft().tick(5)
    expect(f.takeCompact()).toEqual([swing(v)])
  })

  it('attacks an entity once per click, with its swing', () => {
    const f = bot().hold('wooden_sword')
    f.lookAtEntity('pig')
    f.pressLeft().tick()
    const attack = atLeast(v, '26.1') ? 'attack' : 'attack'
    expect(f.takeCompact()).toEqual(atLeast(v, '1.9') ? [attack, swing(v)] : [swing(v), attack])
    f.tick(10)
    expect(f.takeCompact()).toEqual([])
  })

  it('an entity coming under the crosshair while mining aborts it', () => {
    const f = bot()
    dig(f)
    f.pressLeft().tick(3)
    f.take()
    f.lookAtEntity('pig')
    f.tick()
    expect(f.takeCompact()).toEqual([status(v, 'abort')])
  })

  it('mines the block again when it comes back at the same position', () => {
    const f = bot().hold(null)
    f.lookAtBlock('torch', { position: pos })
    f.pressLeft().tick()
    f.take()
    // the server puts a block back (one block skyblock)
    f.lookAtBlock('torch', { position: pos })
    f.tick()
    expect(f.takeCompact()).toEqual([status(v, 'start'), swing(v)])
  })

  it('right click does nothing while mining', () => {
    const f = bot()
    dig(f)
    f.pressLeft().tick(2)
    f.take()
    f.pressRight().tick()
    expect(f.takeCompact()).toEqual([swing(v)])
  })

  it('left click does nothing while an item is used', () => {
    const f = bot().hold('potion')
    f.lookAtNothing()
    f.pressRight().tick()
    f.take()
    dig(f)
    f.hold('potion')
    f.pressLeft().tick(3)
    expect(f.takeCompact()).toEqual([])
  })
})

describe.each(representativeVersions)('%s spectator and spear left click', (v) => {
  it('spectator: attacks (with a swing up to 1.21.10) before 26.1, spectates the entity after', () => {
    const f = createFakeBot(v, { gameMode: 'spectator' }).inject().hold(null)
    const pig = f.lookAtEntity('pig')
    f.pressLeft().tick()
    const packets = f.take()
    if (atLeast(v, '26.2')) {
      expect(packets.map(p => [p.name, p.params])).toEqual([['spectator_action', { entityId: pig.id + 1 }]])
    } else if (atLeast(v, '26.1')) {
      expect(packets.map(p => [p.name, p.params])).toEqual([['spectate_entity', { entityId: pig.id }]])
    } else {
      const names = packets.map(p => p.name)
      expect(names[atLeast(v, '1.9') ? 0 : 1]).toBe('use_entity')
      expect(names.includes('arm_animation')).toBe(!atLeast(v, '1.21.11'))
    }
  })

  it('spectator: a click on a block mines nothing', () => {
    const f = createFakeBot(v, { gameMode: 'spectator' }).inject().hold(null)
    f.lookAtBlock('stone')
    f.pressLeft().tick(3)
    const names = f.take().map(p => p.name)
    expect(names.filter(n => n === 'block_dig')).toEqual([])
    // 26.2+: a click on nothing to spectate
    if (atLeast(v, '26.2')) expect(names).toEqual(['spectator_action'])
  })

  it.runIf(atLeast(v, '1.21.11'))('a spear stabs (STAB at the origin) instead of mining, and holding does nothing', () => {
    const f = createFakeBot(v).inject().hold('iron_spear')
    f.lookAtBlock('stone')
    // charged: an iron spear needs 19 ticks since the last attack (or the item switch)
    f.tick(20)
    f.take()
    f.pressLeft().tick(5)
    const packets = f.take()
    expect(packets.map(p => p.name)).toEqual(atLeast(v, '26.3') ? ['block_dig'] : ['block_dig', 'arm_animation'])
    expect(packets[0]!.params).toMatchObject({ status: atLeast(v, '26.3') ? 8 : 7, location: { x: 0, y: 0, z: 0 }, face: 0, sequence: 0 })
  })
})

describe.each(representativeVersions.filter(v => atLeast(v, '26.3')))('%s destroy direction', (v) => {
  it('turning to another face of the block being mined sends CHANGE_DESTROY_DIRECTION', () => {
    const f = createFakeBot(v).inject().hold('wooden_pickaxe')
    f.lookAtBlock('dirt', { position: pos, face: 4 })
    f.pressLeft().tick()
    f.take()
    f.lookAtBlock('dirt', { position: pos, face: 2 })
    f.tick()
    const [change, punch] = f.take()
    expect(change!.name).toBe('block_dig')
    expect(change!.params).toMatchObject({ status: 1, location: pos, face: 2, sequence: 0 })
    expect(punch!.name).toBe('punch')
  })
})
