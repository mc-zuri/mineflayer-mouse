/**
 * The world border: clicks on blocks (and from 1.18 entities) outside it, as MultiPlayerGameMode and
 * Minecraft.startUseItem check WorldBorder.isWithinBounds.
 */
import { describe, it, expect } from 'vitest'
import { Vec3 } from 'vec3'
import { createFakeBot, FakeBot } from './harness/fakeBot'
import { representativeVersions, atLeast } from './harness/versions'

const swing = (v: string) => (atLeast(v, '26.3') ? 'punch' : 'swing(hand=0)')
const useItem = (v: string, hand: 0 | 1) => (atLeast(v, '1.9') ? `use_item(hand=${hand})` : 'use_item(1.8)')

/** a 10 wide border centred on 0,0: blocks -5..4 are inside */
function border(f: FakeBot, v: string, size = 10) {
  // the player stands by the border, the blocks within reach
  f.bot.entity.position = new Vec3(4.5, 64, 0.5)
  if (atLeast(v, '1.17')) {
    f.bot._client.emit('initialize_world_border', { x: 0, z: 0, oldDiameter: size, newDiameter: size, speed: 0, portalTeleportBoundary: 29999984, warningBlocks: 5, warningTime: 15 })
  } else {
    f.bot._client.emit('world_border', { action: 3, x: 0, z: 0, old_radius: size, new_radius: size, speed: 0, portalBoundary: 29999984, warning_time: 15, warning_blocks: 5 })
  }
}

describe.each(representativeVersions)('%s world border', (v) => {
  const outside = new Vec3(5, 63, 0)
  const inside = new Vec3(4, 63, 0)

  it('a block outside the border is not used: no use_item_on; up to 1.12 the item is used instead', () => {
    const f = createFakeBot(v).inject().hold('snowball', atLeast(v, '1.9') ? 'torch' : null)
    border(f, v)
    f.lookAtBlock('stone', { position: outside, face: 1 })
    f.pressRight()
    const packets = f.takeCompact()
    f.releaseRight()
    if (atLeast(v, '1.13')) expect(packets).toEqual([])
    // 1.8 - 1.12: the FAIL falls through to the item's use (a snowball: thrown)
    else expect(packets[0]).toBe(useItem(v, 0))
    f.lookAtBlock('stone', { position: inside, face: 1 })
    f.pressRight()
    expect(f.takeCompact()[0]).toBe('use_item_on(hand=0)')
  })

  it('a block outside the border is not mined: the click only swings', () => {
    const f = createFakeBot(v).inject().hold('wooden_pickaxe')
    border(f, v)
    f.lookAtBlock('dirt', { position: outside })
    f.pressLeft().tick(3)
    expect(f.takeCompact()).toEqual([swing(v)])
  })

  it('creative does not re-break a block outside the border', () => {
    const f = createFakeBot(v, { gameMode: 'creative' }).inject().hold(null)
    border(f, v)
    f.lookAtBlock('stone', { position: inside })
    f.pressLeft().tick()
    f.take()
    // the crosshair moves to a block outside: after the destroy delay nothing is broken nor swung
    f.lookAtBlock('stone', { position: outside })
    f.tick(5)
    f.take()
    f.tick(3)
    expect(f.takeCompact()).toEqual([])
  })

  it('an entity outside the border is not used from 1.18', () => {
    const f = createFakeBot(v).inject().hold(null)
    border(f, v)
    f.bot.entity.position = new Vec3(5.5, 64, 2.5)
    f.lookAtEntity('cow')
    f.pressRight()
    const packets = f.takeCompact()
    if (atLeast(v, '1.18')) expect(packets).toEqual([])
    else expect(packets.length).toBeGreaterThan(0)
  })

  it('a moving border is followed', () => {
    const f = createFakeBot(v).inject()
    const tracker = f.mouse.worldBorder
    tracker.lerpSize(10, 20, atLeast(v, '1.21.11') ? 20 : 1000)
    if (atLeast(v, '1.21.11')) f.tick(10)
    else {
      const start = Date.now()
      while (Date.now() - start < 2) { /* a moment passes */ }
    }
    expect(tracker.getSize()).toBeGreaterThan(10)
    expect(tracker.getSize()).toBeLessThanOrEqual(20)
  })
})

describe('WorldBorder.isWithinBounds', () => {
  it('a block partly inside a fractional border is inside up to 1.20.6, outside from 1.21', () => {
    for (const [version, partlyInside] of [['1.20.4', true], ['1.21.1', false]] as const) {
      const tracker = createFakeBot(version).inject().mouse.worldBorder
      tracker.setCenter(0.5, 0.5)
      tracker.setSize(10)
      // the border runs from -4.5 to 5.5: block -5 is half inside, block 5 has its corner inside
      expect(tracker.isWithinBounds(-5, 0)).toBe(partlyInside)
      expect(tracker.isWithinBounds(5, 0)).toBe(true)
      expect(tracker.isWithinBounds(6, 0)).toBe(false)
    }
  })
})
