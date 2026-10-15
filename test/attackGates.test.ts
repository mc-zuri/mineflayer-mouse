/**
 * 1.21.11+ attack gates: MINIMUM_ATTACK_CHARGE (Player.cannotAttackWithItem), ATTACK_RANGE, and the spear's
 * crosshair pick (LocalPlayer.raycastHitResult).
 */
import { describe, it, expect } from 'vitest'
import { Vec3 } from 'vec3'
import { createFakeBot } from './harness/fakeBot'
import { representativeVersions, atLeast } from './harness/versions'

const swing = (v: string) => (atLeast(v, '26.3') ? 'punch' : 'swing(hand=0)')
const stab = (v: string) => `player_action(${atLeast(v, '26.3') ? 8 : 7})`
const stabAndSwing = (v: string) => (atLeast(v, '26.3') ? [stab(v)] : [stab(v), 'swing(hand=0)'])

describe.each(representativeVersions.filter(v => atLeast(v, '1.21.11')))('%s attack charge', (v) => {
  it('a spear stabs only when charged: 19 ticks for an iron spear, counted again after each stab', () => {
    const f = createFakeBot(v).inject().hold('iron_spear')
    f.lookAtNothing()
    f.tick(18)
    f.pressLeft().tick().releaseLeft()
    // not charged: no packet, no swing
    expect(f.takeCompact()).toEqual([])
    f.pressLeft().tick().releaseLeft()
    expect(f.takeCompact()).toEqual(stabAndSwing(v))
    f.tick(10)
    f.pressLeft().tick().releaseLeft()
    expect(f.takeCompact()).toEqual([])
  })

  it('a copper spear needs 18 ticks (its attack delay rounds to 17.0000019)', () => {
    const f = createFakeBot(v).inject().hold('copper_spear')
    f.lookAtNothing()
    f.tick(17)
    f.pressLeft().tick().releaseLeft()
    expect(f.takeCompact()).toEqual([])
    f.pressLeft().tick().releaseLeft()
    expect(f.takeCompact()).toEqual(stabAndSwing(v))
  })

  it('the attack speed the server sends sets the delay', () => {
    const f = createFakeBot(v).inject().hold('iron_spear')
    // haste-like: attack speed 2 (a 10 tick delay)
    ;(f.bot.entity as any).attributes = { 'minecraft:attack_speed': { value: 2, modifiers: [] } }
    f.lookAtNothing()
    f.tick(9)
    f.pressLeft().tick().releaseLeft()
    expect(f.takeCompact()).toEqual([])
    f.pressLeft().tick().releaseLeft()
    expect(f.takeCompact()).toEqual(stabAndSwing(v))
  })

  it('switching the held item restarts the charge', () => {
    const f = createFakeBot(v).inject().hold('iron_spear')
    f.lookAtNothing()
    f.tick(30)
    f.hold('stone')
    f.tick()
    f.hold('iron_spear')
    f.tick()
    f.pressLeft().tick().releaseLeft()
    expect(f.takeCompact()).toEqual([])
  })

  it('an item with an attack range attacks an entity only within it (else it only swings)', () => {
    const f = createFakeBot(v).inject().hold('stick')
    const stick: any = f.bot.heldItem
    stick.componentMap = new Map([['attack_range', { type: 'attack_range', data: { minRange: 2.5, maxRange: 4, minCreativeRange: 2.5, maxCreativeRange: 6, hitboxMargin: 0 } }]])
    // the cow is 2 blocks ahead: nearer than the range's start
    f.lookAtEntity('cow')
    f.pressLeft().tick().releaseLeft()
    expect(f.takeCompact()).toEqual([swing(v)])
  })

  it('holding a spear, the crosshair picks an entity up to 4.625 blocks away', () => {
    for (const held of ['iron_spear', 'stick']) {
      const f = createFakeBot(v).inject().hold(held)
      const cow = f.lookAtEntity('cow')
      // 4 blocks ahead: beyond the entity interaction range (3)
      cow.position = cow.position.offset(0, 0, -(4 - 2) - cow.width / 2)
      expect(f.mouse.getCursorState().entity?.id ?? null).toBe(held === 'iron_spear' ? cow.id : null)
    }
  })
})

describe.each(representativeVersions.filter(v => atLeast(v, '1.21.11')))('%s entity interaction range', (v) => {
  it('a cow picked 4 blocks away with a spear is not interacted with: the spear is used', () => {
    const f = createFakeBot(v).inject().hold('iron_spear')
    const cow = f.lookAtEntity('cow')
    cow.position = cow.position.offset(0, 0, -(4 - 2) - cow.width / 2)
    f.pressRight()
    expect(f.takeCompact()).toEqual(['use_item(hand=0)'])
  })
})
