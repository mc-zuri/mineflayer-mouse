/**
 * The middle click (Minecraft.pickBlock / pickBlockOrEntity) per version: server picked from 1.21.4, client picked
 * before (set_creative_slot in creative; pick_item / MC|PickItem / the hotbar in survival).
 */
import { describe, it, expect } from 'vitest'
import { Vec3 } from 'vec3'
import { createFakeBot, FakeBot } from './harness/fakeBot'
import { representativeVersions, atLeast } from './harness/versions'

const serverPicks = (v: string) => atLeast(v, '1.21.4')

describe.each(representativeVersions)('%s pick block', (v) => {
  const bot = (gameMode: 'survival' | 'creative' = 'survival') => createFakeBot(v, { gameMode }).inject()
  const names = (f: FakeBot) => f.take().map(p => [p.name, p.params] as const)

  it.runIf(serverPicks(v))('1.21.4+: asks the server for the block or the entity, with includeData as Ctrl', () => {
    for (const gameMode of ['survival', 'creative'] as const) {
      const f = bot(gameMode)
      const block = f.lookAtBlock('stone', { position: new Vec3(0, 63, 2) })
      f.middleClick()
      expect(names(f)).toEqual([['pick_item_from_block', { position: block.position, includeData: false }]])
      f.mouse.ctrlDown = true
      const cow = f.lookAtEntity('cow')
      f.middleClick()
      expect(names(f)).toEqual([['pick_item_from_entity', { entityId: cow.id, includeData: true }]])
      f.lookAtNothing()
      f.middleClick()
      expect(names(f)).toEqual([])
    }
  })

  it.runIf(!serverPicks(v))('survival: an item in the hotbar is selected, sent with the next tick', () => {
    const f = bot()
    f.bot.inventory.slots[36 + 3] = f.makeItem('stone', 5)
    f.lookAtBlock('stone')
    f.middleClick()
    expect(names(f)).toEqual([])
    f.tick()
    expect(names(f)).toEqual([['held_item_slot', { slotId: 3 }]])
    expect(f.bot.quickBarSlot).toBe(3)
  })

  it.runIf(!serverPicks(v))('survival: an item in the main inventory is asked for (pick_item 1.13+, MC|PickItem 1.9 - 1.12, nothing in 1.8)', () => {
    const f = bot()
    f.bot.inventory.slots[20] = f.makeItem('stone', 5)
    f.lookAtBlock('stone')
    f.middleClick()
    const packets = names(f)
    if (atLeast(v, '1.13')) expect(packets).toEqual([['pick_item', { slot: 20 }]])
    else if (atLeast(v, '1.9')) expect(packets).toEqual([['custom_payload', { channel: 'MC|PickItem', data: Buffer.from([20]) }]])
    else expect(packets).toEqual([])
  })

  it.runIf(!serverPicks(v))('survival: an item not in the inventory, or an entity, picks nothing', () => {
    const f = bot()
    f.lookAtBlock('stone')
    f.middleClick()
    f.lookAtEntity('cow')
    f.middleClick()
    f.tick()
    expect(names(f)).toEqual([])
  })

  it.runIf(!serverPicks(v))('creative: the block\'s item goes to a suitable hotbar slot with set_creative_slot', () => {
    const f = bot('creative')
    f.bot.inventory.slots[36] = f.makeItem('dirt', 1)
    // a wall torch's item is the torch
    const wallTorch = f.data.blocksByName.wall_torch ? 'wall_torch' : 'torch'
    f.lookAtBlock(wallTorch)
    f.middleClick()
    const [creative] = f.take()
    // the selected slot holds dirt: the next empty hotbar slot (1) takes the torch
    expect(creative!.name).toBe('set_creative_slot')
    expect(creative!.params.slot).toBe(37)
    expect(f.bot.inventory.slots[37]?.name).toBe('torch')
    f.tick()
    expect(names(f)).toEqual([['held_item_slot', { slotId: 1 }]])
  })

  it.runIf(!serverPicks(v))('creative: an entity gives its spawn egg', () => {
    const f = bot('creative')
    f.lookAtEntity('cow')
    f.middleClick()
    const [creative] = f.take()
    expect(creative!.name).toBe('set_creative_slot')
    const item = f.bot.inventory.slots[36] as any
    expect(item.name).toBe(atLeast(v, '1.13') ? 'cow_spawn_egg' : 'spawn_egg')
  })

  it('a crop picks its seeds, water nothing', () => {
    const f = bot('creative')
    f.lookAtBlock('wheat')
    f.middleClick()
    if (!serverPicks(v)) expect((f.bot.inventory.slots[36] as any)?.name).toBe('wheat_seeds')
    f.take()
    if (!serverPicks(v)) {
      f.lookAtBlock('water')
      f.middleClick()
      expect(names(f)).toEqual([])
    }
  })

  it('nothing is picked while an item is used', () => {
    const f = bot().hold('potion')
    f.lookAtNothing()
    f.pressRight()
    f.take()
    f.lookAtBlock('stone')
    f.middleClick()
    expect(names(f)).toEqual([])
  })
})
