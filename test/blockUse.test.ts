/**
 * Block.use / useItemOn / useWithoutItem results (blockInteractionsData.json, generated from the decompiled clients):
 * whether the block takes the click, whether the client swings, whether the off hand is tried.
 */
import { describe, it, expect } from 'vitest'
import { createFakeBot, FakeBot } from './harness/fakeBot'
import { representativeVersions, atLeast, supportedReleases } from './harness/versions'
import { parseAllConditions, getBlockEntry } from '../src/blockInteractions'
import MinecraftData from 'minecraft-data'

const swing = (v: string, hand: 0 | 1) => (atLeast(v, '26.3') ? [] : [`swing(hand=${hand})`])

const click = (f: FakeBot) => {
  f.pressRight()
  const packets = f.takeCompact()
  f.releaseRight()
  return packets
}

describe('block interaction data', () => {
  it('every condition parses', () => {
    expect(parseAllConditions()).toBeGreaterThan(500)
  })

  it.each(supportedReleases)('%s: every block it names exists', (version) => {
    const data = MinecraftData(version)
    const missing = Object.keys((require('../src/blockInteractionsData.json') as any).blocks)
      .filter(name => getBlockEntry(version, name) && !data.blocksByName[name])
    expect(missing).toEqual([])
  })

  it('fixes the hand-written list: tables that are not used, signs and pots that are', () => {
    expect(getBlockEntry('1.21.4', 'fletching_table')).toBeNull()
    expect(getBlockEntry('1.21.4', 'beetroots')).toBeNull()
    expect(getBlockEntry('1.21.4', 'observer')).toBeNull()
    expect(getBlockEntry('1.21.4', 'oak_sign')).not.toBeNull()
    expect(getBlockEntry('1.21.4', 'potted_poppy')).not.toBeNull()
  })
})

describe.each(representativeVersions.filter(v => atLeast(v, '1.9')))('%s block use', (v) => {
  const bot = (options = {}) => createFakeBot(v, options).inject()

  it('an iron door does not take the click (1.11+), the off hand places its torch', () => {
    const f = bot().hold(null, 'torch')
    f.lookAtBlock('iron_door')
    if (atLeast(v, '1.11')) expect(click(f)).toEqual(['use_item_on(hand=0)', 'use_item_on(hand=1)', ...swing(v, 1)])
    else expect(click(f)).toEqual(['use_item_on(hand=0)', ...swing(v, 0)])
  })

  it('a lever takes the click', () => {
    const f = bot().hold(null, 'torch')
    f.lookAtBlock('lever')
    expect(click(f)).toEqual(['use_item_on(hand=0)', ...swing(v, 0)])
  })

  it('a bed takes the click without a client swing from 1.15', () => {
    const f = bot().hold(null, 'torch')
    f.lookAtBlock(atLeast(v, '1.13') ? 'red_bed' : 'bed')
    expect(click(f)).toEqual(['use_item_on(hand=0)', ...(atLeast(v, '1.15') ? [] : swing(v, 0))])
  })

  it.runIf(atLeast(v, '1.13'))('a powered button takes the click without a swing (1.15+)', () => {
    const f = bot().hold(null)
    f.lookAtBlock('stone_button', { properties: { powered: true, face: 'wall', facing: 'north' } })
    expect(click(f)).toEqual(['use_item_on(hand=0)', ...(atLeast(v, '1.15') ? [] : swing(v, 0))])
  })

  it.runIf(atLeast(v, '1.14'))('a sign takes the click: no item use, no off hand', () => {
    const f = bot().hold('diamond_sword', 'torch')
    f.lookAtBlock('oak_sign')
    // the client swings only for a sign it changes (dye, ink, honeycomb) from 1.15
    expect(click(f)).toEqual(['use_item_on(hand=0)', ...(atLeast(v, '1.15') ? [] : swing(v, 0))])
  })

  it.runIf(atLeast(v, '1.13'))('a block held against a fence is placed (from 1.13 the fence only takes a lead)', () => {
    const f = bot().hold('oak_planks')
    f.lookAtBlock('oak_fence')
    expect(click(f)).toEqual(['use_item_on(hand=0)', ...swing(v, 0)])
  })

  it.runIf(atLeast(v, '1.21.9'))('a copper golem statue takes the click: the off hand is not tried', () => {
    const f = bot().hold(null, 'torch')
    f.lookAtBlock('copper_golem_statue')
    expect(click(f)).toEqual(['use_item_on(hand=0)', ...swing(v, 0)])
  })

  it('a chest takes the click of any main hand item', () => {
    const f = bot().hold('diamond_sword', 'torch')
    f.lookAtBlock('chest')
    expect(click(f)).toEqual(['use_item_on(hand=0)', ...swing(v, 0)])
  })
})

describe.each(representativeVersions.filter(v => atLeast(v, '1.11')))('%s block items on blocks that pass', (v) => {
  it('a block held against an iron door is placed (the old hand-written list called every door interactive)', () => {
    const f = createFakeBot(v).inject().hold('stone', 'torch')
    f.lookAtBlock('iron_door')
    expect(click(f)).toEqual(['use_item_on(hand=0)', ...swing(v, 0)])
  })
})
