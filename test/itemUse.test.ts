/**
 * Item.use / Item.useOn results, which decide whether vanilla goes on to use_item and to the off hand
 * (itemUseData.json, generated from the decompiled clients).
 */
import { describe, it, expect } from 'vitest'
import { createFakeBot, FakeBot } from './harness/fakeBot'
import { representativeVersions, atLeast } from './harness/versions'

const twoHands = (v: string) => atLeast(v, '1.9')
const swing = (v: string, hand: 0 | 1) => (atLeast(v, '26.3') ? [] : [`swing(hand=${hand})`])
const itemSwing = (v: string, hand: 0 | 1) => (atLeast(v, '1.15') ? swing(v, hand) : [])
const useItem = (v: string, hand: 0 | 1) => (twoHands(v) ? `use_item(hand=${hand})` : 'use_item(1.8)')
const release = (v: string) => `player_action(${atLeast(v, '26.3') ? 6 : 5})`

const click = (f: FakeBot) => {
  f.pressRight()
  const packets = f.takeCompact()
  f.releaseRight()
  return [packets, f.takeCompact()]
}

describe.each(representativeVersions.filter(twoHands))('%s item use', (v) => {
  const bot = (options = {}) => createFakeBot(v, options).inject()

  it('a bow without arrows fails: no use, the off hand is tried', () => {
    const f = bot().hold('bow', 'snowball')
    f.lookAtNothing()
    expect(click(f)).toEqual([[useItem(v, 0), useItem(v, 1), ...itemSwing(v, 1)], []])
  })

  it('a bow with arrows starts using and is released with the button', () => {
    const f = bot().hold('bow', 'snowball')
    f.bot.inventory.slots[9] = f.makeItem('arrow', 16)
    f.lookAtNothing()
    expect(click(f)).toEqual([[useItem(v, 0)], [release(v)]])
  })

  it('food starts using when hungry', () => {
    const f = bot({ food: 10 }).hold('bread')
    f.lookAtNothing()
    expect(click(f)).toEqual([[useItem(v, 0)], [release(v)]])
  })

  it('creative eats when not hungry from 1.15 (Player.canEat)', () => {
    const f = bot({ gameMode: 'creative' }).hold('bread', 'snowball')
    f.lookAtNothing()
    if (atLeast(v, '1.15')) expect(click(f)).toEqual([[useItem(v, 0)], [release(v)]])
    else expect(click(f)).toEqual([[useItem(v, 0), useItem(v, 1)], []])
  })

  it('an ender pearl is used at once (no release), and stops the click', () => {
    const f = bot().hold('ender_pearl', 'snowball')
    f.lookAtNothing()
    expect(click(f)).toEqual([[useItem(v, 0), ...itemSwing(v, 0)], []])
  })

  it('a fishing rod swings itself up to 1.14, by its SUCCESS from 1.15', () => {
    const f = bot().hold('fishing_rod')
    f.lookAtNothing()
    expect(click(f)).toEqual([[useItem(v, 0), ...swing(v, 0)], []])
  })

  it('a hoe tills dirt: the click ends with the block use', () => {
    const f = bot().hold('iron_hoe', 'torch')
    f.lookAtBlock(atLeast(v, '1.13') ? 'dirt' : 'dirt')
    expect(click(f)).toEqual([['use_item_on(hand=0)', ...swing(v, 0)], []])
  })

  it('a hoe on stone passes: use_item, then the off hand places its torch', () => {
    const f = bot().hold('iron_hoe', 'torch')
    f.lookAtBlock('stone')
    expect(click(f)).toEqual([['use_item_on(hand=0)', useItem(v, 0), 'use_item_on(hand=1)', ...swing(v, 1)], []])
  })

  it('a minecart off a rail fails: from 1.13 nothing more, before that use_item', () => {
    const f = bot().hold('minecart', 'torch')
    f.lookAtBlock('stone')
    const rest = atLeast(v, '1.13') ? [] : [useItem(v, 0), 'use_item_on(hand=1)', ...swing(v, 1)]
    expect(click(f)).toEqual([['use_item_on(hand=0)', ...rest], []])
  })

  it('a minecart on a rail is placed', () => {
    const f = bot().hold('minecart', 'torch')
    f.lookAtBlock('rail')
    expect(click(f)).toEqual([['use_item_on(hand=0)', ...swing(v, 0)], []])
  })

  it('armor in the air is put on (instant), unless the same piece is worn', () => {
    const f = bot().hold('iron_helmet', 'snowball')
    f.lookAtNothing()
    expect(click(f)).toEqual([[useItem(v, 0), ...itemSwing(v, 0)], []])
    f.bot.inventory.slots[5] = f.makeItem('iron_helmet')
    // before 1.19.4 a worn helmet of any kind fails; from 1.19.4 the same item fails (a swap otherwise)
    expect(click(f)).toEqual([[useItem(v, 0), useItem(v, 1), ...itemSwing(v, 1)], []])
  })
})
