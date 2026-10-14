/**
 * LocalPlayer.isHandsBusy (1.9+): paddling a boat keeps startAttack and startUseItem from doing anything.
 */
import { describe, it, expect } from 'vitest'
import { createFakeBot, FakeBot } from './harness/fakeBot'
import { representativeVersions, atLeast } from './harness/versions'

const swing = (v: string) => (atLeast(v, '26.3') ? 'punch' : 'swing(hand=0)')

function rideBoat(f: FakeBot, driver = true) {
  const boatName = f.data.entitiesByName.oak_boat ? 'oak_boat' : f.data.entitiesByName.boat ? 'boat' : 'Boat'
  const other = { id: 7, name: 'pig' }
  const boat: any = { id: 5, name: boatName, passengers: driver ? [f.bot.entity] : [other, f.bot.entity] }
  ;(f.bot.entity as any).vehicle = boat
  return boat
}

describe.each(representativeVersions)('%s paddling', (v) => {
  const paddling = (f: FakeBot, driver = true) => {
    rideBoat(f, driver)
    f.bot.setControlState('forward', true)
    // rideTick sets handsBusy at the end of the tick
    f.tick()
    f.take()
  }

  it('a right click while paddling uses nothing (1.9+), and is retried 4 ticks later', () => {
    const f = createFakeBot(v).inject().hold('stone')
    f.lookAtBlock('stone')
    paddling(f)
    f.pressRight().tick()
    if (!atLeast(v, '1.9')) {
      expect(f.takeCompact()[0]).toBe('use_item_on(hand=0)')
      return
    }
    expect(f.takeCompact()).toEqual([])
    // the keys released: the next retry (4 ticks after the click) places the block
    f.bot.setControlState('forward', false)
    f.tick(4)
    expect(f.takeCompact()).toEqual(['use_item_on(hand=0)', 'swing(hand=0)'].map(p => (atLeast(v, '26.3') && p.startsWith('swing') ? null : p)).filter(Boolean))
  })

  it('a left click while paddling neither attacks nor swings (1.9+)', () => {
    const f = createFakeBot(v).inject().hold(null)
    f.lookAtEntity('pig')
    paddling(f)
    f.pressLeft().tick()
    expect(f.takeCompact()).toEqual(atLeast(v, '1.9') ? [] : [swing(v), 'attack'])
  })

  it('mining goes on while paddling (continueAttack does not check it)', () => {
    const f = createFakeBot(v).inject().hold('wooden_pickaxe')
    f.lookAtBlock('dirt')
    f.pressLeft().tick(2)
    f.take()
    paddling(f)
    f.tick()
    expect(f.takeCompact()).toEqual([swing(v)])
  })

  it.runIf(atLeast(v, '1.9'))('a rear passenger paddles only before 1.19.4', () => {
    const f = createFakeBot(v).inject().hold(null)
    f.lookAtNothing()
    paddling(f, false)
    f.pressLeft().tick()
    expect(f.takeCompact()).toEqual(atLeast(v, '1.19.4') ? [swing(v)] : [])
  })
})
