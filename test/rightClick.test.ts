/**
 * Right click parity with vanilla's Minecraft.startUseItem and MultiPlayerGameMode, per version, as the decompiled
 * clients dictate (see the version notes in each case). The fake bot records every serverbound packet.
 */
import { describe, it, expect } from 'vitest'
import { Vec3 } from 'vec3'
import { createFakeBot, FakeBot } from './harness/fakeBot'
import { representativeVersions, atLeast } from './harness/versions'

const twoHands = (v: string) => atLeast(v, '1.9')
/** LocalPlayer.swing sends the swing packet (1.8: no hand field); 26.3 removed it, a right click swings client-side only */
const swing = (v: string, hand: 0 | 1) => (atLeast(v, '26.3') ? [] : [`swing(hand=${hand})`])
/** up to 1.14 only a block's SUCCESS swings; from 1.15 InteractionResult.shouldSwing applies to items and entities too */
const itemSwing = (v: string, hand: 0 | 1) => (atLeast(v, '1.15') ? swing(v, hand) : [])
const useItem = (v: string, hand: 0 | 1) => (twoHands(v) ? `use_item(hand=${hand})` : 'use_item(1.8)')
const release = (v: string) => `player_action(${atLeast(v, '26.3') ? 6 : 5})`

const click = (f: FakeBot) => {
  f.pressRight()
  const packets = f.takeCompact()
  f.releaseRight()
  return packets
}

describe.each(representativeVersions)('%s right click', (v) => {
  const bot = () => createFakeBot(v).inject()

  it('on a plain block with empty hands: use_item_on for each hand (sent though both pass)', () => {
    const f = bot().hold(null)
    f.lookAtBlock('stone')
    // 1.8: an empty hand never falls back to using the item, and there is no off hand
    expect(click(f)).toEqual(twoHands(v) ? ['use_item_on(hand=0)', 'use_item_on(hand=1)'] : ['use_item_on(hand=0)'])
  })

  it('placing a block with the main hand stops the click: no off hand try', () => {
    const f = bot().hold('stone', twoHands(v) ? 'torch' : null)
    f.lookAtBlock('stone')
    expect(click(f)).toEqual(['use_item_on(hand=0)', ...swing(v, 0)])
  })

  it.runIf(twoHands(v))('an empty main hand passes on a plain block, the off hand places its block', () => {
    const f = bot().hold(null, 'torch')
    f.lookAtBlock('stone')
    expect(click(f)).toEqual(['use_item_on(hand=0)', 'use_item_on(hand=1)', ...swing(v, 1)])
  })

  it('a chest takes the click of an empty hand', () => {
    const f = bot().hold(null, twoHands(v) ? 'torch' : null)
    f.lookAtBlock('chest')
    expect(click(f)).toEqual(['use_item_on(hand=0)', ...swing(v, 0)])
  })

  it('sneaking with an item skips the chest and places the block', () => {
    const f = bot().hold('stone')
    f.lookAtBlock('chest')
    f.sneak()
    expect(click(f)).toEqual(['use_item_on(hand=0)', ...swing(v, 0)])
  })

  it('an item without a use on a plain block: use_item_on, use_item, then the off hand', () => {
    const f = bot().hold('diamond_sword')
    f.lookAtBlock('stone')
    if (twoHands(v)) {
      expect(click(f)).toEqual(['use_item_on(hand=0)', 'use_item(hand=0)', 'use_item_on(hand=1)'])
    } else {
      // 1.8 swords block: the sword is used (and released with the button)
      f.pressRight()
      expect(f.takeCompact()).toEqual(['use_item_on(hand=0)', 'use_item(1.8)'])
      f.releaseRight()
      expect(f.takeCompact()).toEqual([release(v)])
    }
  })

  it('an instant use (a snowball) in the air: one use_item, nothing for the off hand, no release', () => {
    const f = bot().hold('snowball', twoHands(v) ? 'snowball' : null)
    f.lookAtNothing()
    f.pressRight()
    expect(f.takeCompact()).toEqual([useItem(v, 0), ...itemSwing(v, 0)])
    f.releaseRight()
    expect(f.takeCompact()).toEqual([])
  })

  it('a drink starts using: no repeat while held, released with the button', () => {
    const f = bot().hold('potion')
    f.lookAtNothing()
    f.pressRight()
    expect(f.takeCompact()).toEqual([useItem(v, 0)])
    f.tick(10)
    expect(f.takeCompact()).toEqual([])
    f.releaseRight()
    expect(f.takeCompact()).toEqual([release(v)])
  })

  it('food when not hungry fails: the off hand is not tried and nothing is used', () => {
    const f = bot().hold('bread', twoHands(v) ? 'snowball' : null)
    f.lookAtNothing()
    // 1.9 - 1.12: FAIL of an item use is not a consume either, the loop goes on to the off hand
    const offHand = twoHands(v) ? [useItem(v, 1), ...itemSwing(v, 1)] : []
    expect(click(f)).toEqual([useItem(v, 0), ...offHand])
  })

  // a click belongs to the tick that follows it (vanilla handles clicks in Minecraft.tick): the repeat is 4 ticks later
  it('held right click placing blocks repeats every 4 ticks', () => {
    const f = bot().hold('stone')
    f.lookAtBlock('stone')
    f.pressRight()
    expect(f.takeCompact()).toEqual(['use_item_on(hand=0)', ...swing(v, 0)])
    f.tick(4)
    expect(f.takeCompact()).toEqual([])
    f.tick(1)
    expect(f.takeCompact()).toEqual(['use_item_on(hand=0)', ...swing(v, 0)])
    f.tick(4)
    expect(f.takeCompact()).toEqual(['use_item_on(hand=0)', ...swing(v, 0)])
    f.releaseRight()
    f.tick(8)
    expect(f.takeCompact()).toEqual([])
  })

  it('on an entity that does not take the click: each hand interacts', () => {
    const f = bot().hold(null)
    f.lookAtEntity('cow')
    const perHand = (hand: 0 | 1) => (atLeast(v, '26.1') ? [`interact(hand=${hand})`] : [`interact_at(hand=${hand})`, `interact(hand=${hand})`])
    expect(click(f)).toEqual(twoHands(v) ? [...perHand(0), ...perHand(1)] : perHand(0))
  })

  it('held right click on an entity repeats every 4 ticks', () => {
    const f = bot().hold(null)
    f.lookAtEntity('cow')
    f.pressRight()
    const first = f.takeCompact()
    f.tick(4)
    expect(f.takeCompact()).toEqual([])
    f.tick(1)
    expect(f.takeCompact()).toEqual(first)
    f.releaseRight()
  })

  it('use_item_on carries the hit and, from 1.19, a rising sequence shared with use_item', () => {
    const f = bot().hold('diamond_sword')
    const hit = f.lookAtBlock('stone', { face: 1 })
    f.pressRight()
    const packets = f.take().filter(p => p.name !== 'position_look')
    const place = packets[0]!
    expect(place.name).toBe('block_place')
    expect(place.params.location).toEqual(hit.position)
    expect(place.params.direction).toBe(1)
    if (atLeast(v, '1.11')) expect([place.params.cursorX, place.params.cursorY, place.params.cursorZ]).toEqual([0.5, 1, 0.5])
    else expect([place.params.cursorX, place.params.cursorY, place.params.cursorZ]).toEqual([8, 16, 8])
    if (atLeast(v, '1.19')) {
      const sequences = packets.filter(p => p.name === 'block_place' || p.name === 'use_item').map(p => p.params.sequence)
      expect(sequences).toEqual([1, 2, 3])
    }
  })

  it.runIf(atLeast(v, '1.17') && !atLeast(v, '1.21'))('1.17 - 1.20.6 send the position and look right before use_item', () => {
    const f = bot().hold('snowball')
    f.lookAtNothing()
    f.pressRight()
    expect(f.take().map(p => p.name)).toEqual(['position_look', 'use_item', ...swing(v, 0).map(() => 'arm_animation')])
  })

  it('spectator: use_item_on is sent and consumed, use_item is not sent', () => {
    const f = createFakeBot(v, { gameMode: 'spectator' }).inject().hold('stone')
    f.lookAtBlock('stone')
    // up to 1.21.1 the spectator result is SUCCESS (swings), from 1.21.2 CONSUME
    expect(click(f)).toEqual(['use_item_on(hand=0)', ...(atLeast(v, '1.21.2') ? [] : swing(v, 0))])
    f.lookAtNothing()
    expect(click(f)).toEqual([])
  })
})

describe.each(representativeVersions)('%s reach', (v) => {
  it('a block beyond 4.5 blocks is out of reach in survival (the click is in the air), within reach in creative', () => {
    const eye = new Vec3(0.5, 64 + 1.62, 0.5)
    for (const [gameMode, reached] of [['survival', false], ['creative', true]] as const) {
      const f = createFakeBot(v, { gameMode }).inject().hold('snowball')
      // the hit point 4.8 blocks in front of the eyes
      f.lookAtBlock('stone', { position: new Vec3(0, 65, -5), face: 3, hit: eye.offset(0, 0, -4.8).minus(new Vec3(0, 65, -5)) })
      f.pressRight()
      const packets = f.takeCompact()
      f.releaseRight()
      expect(packets[0]).toBe(reached ? 'use_item_on(hand=0)' : (atLeast(v, '1.9') ? 'use_item(hand=0)' : 'use_item(1.8)'))
    }
  })
})

describe('buttons set without update()', () => {
  it('a button set directly is clicked on the next tick', () => {
    const f = createFakeBot('1.20.4').inject().hold('stone')
    f.lookAtBlock('stone')
    f.mouse.buttons[2] = true
    f.tick()
    expect(f.takeCompact()).toEqual(['use_item_on(hand=0)', 'swing(hand=0)'])
    f.tick(3)
    expect(f.takeCompact()).toEqual([])
    f.tick()
    expect(f.takeCompact()).toEqual(['use_item_on(hand=0)', 'swing(hand=0)'])
  })
})
