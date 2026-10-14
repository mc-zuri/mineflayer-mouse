/**
 * Entity right click results (entityInteractData.json, generated from the decompiled clients): which entities take
 * the click (no off hand try), with or without a client swing.
 */
import { describe, it, expect } from 'vitest'
import { createFakeBot, FakeBot } from './harness/fakeBot'
import { representativeVersions, atLeast } from './harness/versions'

const swing = (v: string, hand: 0 | 1) => (atLeast(v, '26.3') ? [] : [`swing(hand=${hand})`])
const entitySwing = (v: string, hand: 0 | 1) => (atLeast(v, '1.15') ? swing(v, hand) : [])
const interact = (v: string, hand: 0 | 1) => (atLeast(v, '26.1') ? [`interact(hand=${hand})`] : [`interact_at(hand=${hand})`, `interact(hand=${hand})`])

const click = (f: FakeBot) => {
  f.pressRight()
  const packets = f.takeCompact()
  f.releaseRight()
  return packets
}

describe.each(representativeVersions.filter(v => atLeast(v, '1.9')))('%s entity use', (v) => {
  const bot = () => createFakeBot(v).inject()

  it('a villager takes the click of an empty hand: no off hand try', () => {
    const f = bot().hold(null, 'torch')
    f.lookAtEntity('villager')
    // a villager trades with the main hand (1.15+ SUCCESS swings; before, a consumed entity click never swings)
    expect(click(f)).toEqual([...interact(v, 0), ...entitySwing(v, 0)])
  })

  it('a lead on a cow takes the click', () => {
    const f = bot().hold('lead')
    f.lookAtEntity('cow')
    // 1.21.11+: the client's result is CONSUME (no swing)
    expect(click(f)).toEqual([...interact(v, 0), ...(atLeast(v, '1.21.11') ? [] : entitySwing(v, 0))])
  })

  it('a mob leashed to the bot is untied by any hand (mineflayer keeps the holder as its vehicle)', () => {
    const f = bot().hold(null)
    const cow = f.lookAtEntity('cow')
    cow.vehicle = f.bot.entity
    expect(click(f)).toEqual([...interact(v, 0), ...entitySwing(v, 0)])
  })

  it('an armor stand takes the click with interact_at alone (before 26.1), without a swing', () => {
    const f = bot().hold(null)
    f.lookAtEntity('armor_stand')
    expect(click(f)).toEqual(atLeast(v, '26.1') ? ['interact(hand=0)'] : ['interact_at(hand=0)'])
  })

  it('an empty item frame passes for empty hands from 1.15: both hands interact', () => {
    const f = bot().hold(null)
    f.lookAtEntity('item_frame')
    // up to 1.14 the frame's processInitialInteract always returned true
    expect(click(f)).toEqual(atLeast(v, '1.15') ? [...interact(v, 0), ...interact(v, 1)] : interact(v, 0))
  })

  it('a stick on a cow passes: use_item, then the off hand', () => {
    const f = bot().hold('stick')
    f.lookAtEntity('cow')
    expect(click(f)).toEqual([...interact(v, 0), 'use_item(hand=0)', ...interact(v, 1)])
  })
})
