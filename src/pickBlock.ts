/**
 * The middle click (Minecraft.pickBlock / pickBlockOrEntity) as the vanilla client sends it:
 * - 1.21.4+: the server picks: pick_item_from_block / pick_item_from_entity, with includeData (Ctrl held)
 * - up to 1.21.3 the client picks: the block's (or in creative the entity's) item, found in the inventory or, in
 *   creative, put in the hotbar (Inventory.setPickedItem) and sent with set_creative_slot; in survival an item in the
 *   main inventory is asked for (pick_item from 1.13, the MC|PickItem channel 1.9 - 1.12); the selected hotbar slot
 *   goes out with the next tick's held_item_slot
 */
import { Bot } from 'mineflayer'
import { Block } from 'prismarine-block'
import { Entity } from 'prismarine-entity'
import PrismarineItem, { Item } from 'prismarine-item'
import MinecraftData from 'minecraft-data'
import type { VersionCompare } from './interactionRules'
import { getLatestEntityName } from './attackableEntity'

interface PickedItem {
  name: string
  metadata?: number
  nbt?: any
}

/** blocks whose item is another one (Block.getCloneItemStack); null: no item */
const BLOCK_PICK: Record<string, string | null> = {
  wheat: 'wheat_seeds',
  carrots: 'carrot',
  potatoes: 'potato',
  beetroots: 'beetroot_seeds',
  torchflower_crop: 'torchflower_seeds',
  pitcher_crop: 'pitcher_pod',
  melon_stem: 'melon_seeds',
  attached_melon_stem: 'melon_seeds',
  pumpkin_stem: 'pumpkin_seeds',
  attached_pumpkin_stem: 'pumpkin_seeds',
  sweet_berry_bush: 'sweet_berries',
  cave_vines: 'glow_berries',
  cave_vines_plant: 'glow_berries',
  kelp_plant: 'kelp',
  weeping_vines_plant: 'weeping_vines',
  twisting_vines_plant: 'twisting_vines',
  bamboo_sapling: 'bamboo',
  big_dripleaf_stem: 'big_dripleaf',
  tall_seagrass: 'seagrass',
  redstone_wire: 'redstone',
  tripwire: 'string',
  cocoa: 'cocoa_beans',
  powder_snow: 'powder_snow_bucket',
  water_cauldron: 'cauldron',
  lava_cauldron: 'cauldron',
  powder_snow_cauldron: 'cauldron',
  // before 1.13
  standing_sign: 'sign',
  wall_sign: 'sign',
  standing_banner: 'banner',
  wall_banner: 'banner',
  lit_furnace: 'furnace',
  lit_redstone_ore: 'redstone_ore',
  lit_redstone_lamp: 'redstone_lamp',
  unpowered_repeater: 'repeater',
  powered_repeater: 'repeater',
  unpowered_comparator: 'comparator',
  powered_comparator: 'comparator',
  daylight_detector_inverted: 'daylight_detector',
  unlit_redstone_torch: 'redstone_torch',
  double_stone_slab: 'stone_slab',
  double_wooden_slab: 'wooden_slab',
  // nothing to pick
  moving_piston: null,
  piston_extension: null,
  end_portal: null,
  end_gateway: null,
  nether_portal: null,
  portal: null,
  frosted_ice: null,
  water: null,
  flowing_water: null,
  lava: null,
  flowing_lava: null,
  fire: null,
  soul_fire: null,
  bubble_column: null,
  air: null,
  cave_air: null,
  void_air: null
}

export function blockPickItem(data: MinecraftData.IndexedData, block: Block): PickedItem | null {
  const name = block.name
  let item: string | null | undefined = BLOCK_PICK[name]
  if (item === undefined) {
    if (/candle_cake$/.test(name)) item = 'cake'
    else if (name.startsWith('potted_')) item = name.slice('potted_'.length)
    else if (name === 'piston_head') item = (block.getProperties?.() as any)?.type === 'sticky' ? 'sticky_piston' : 'piston'
    else if (/wall_torch$/.test(name)) item = name.replace(/wall_torch$/, 'torch')
    else if (/_wall_(sign|hanging_sign|banner|head|skull|fan)$/.test(name)) item = name.replace('_wall_', '_')
    else item = name
  }
  if (!item || !data.itemsByName[item]) return null
  // before 1.13 an item with subtypes keeps the block's metadata (wool colours, planks...)
  const variations = (data.itemsByName[item] as any).variations as Array<{ metadata: number }> | undefined
  const metadata = variations?.some(v => v.metadata === block.metadata) ? block.metadata : undefined
  return { name: item, metadata }
}

const MINECARTS = /^(minecart|chest_minecart|furnace_minecart|tnt_minecart|hopper_minecart|command_block_minecart)$/

/** Entity.getPickResult (creative only up to 1.21.3) */
export function entityPickItem(data: MinecraftData.IndexedData, version: VersionCompare, entity: Entity): PickedItem | null {
  const name = getLatestEntityName(entity.name ?? '') ?? entity.name ?? ''
  const has = (item: string) => !!data.itemsByName[item]
  let item: string | null = null
  if (name === 'painting' || name === 'armor_stand' || name === 'end_crystal' || name === 'item_frame' || name === 'glow_item_frame') item = name
  else if (name === 'leash_knot') item = 'lead'
  else if (MINECARTS.test(name)) item = name
  else if (name === 'spawner_minecart') item = 'minecart'
  else if (/(boat|raft)$/.test(name)) item = has(name) ? name : has('oak_boat') ? 'oak_boat' : 'boat'
  else if (has(`${name}_spawn_egg`)) item = `${name}_spawn_egg`
  else if (has('spawn_egg') && data.entitiesByName[entity.name ?? '']?.type !== 'player') {
    // before 1.13 one spawn egg: the entity id as metadata (1.8 - 1.10), then its EntityTag (1.11 - 1.12)
    const id = data.entitiesByName[entity.name ?? '']?.id
    if (id === undefined) return null
    if (version['<']('1.11')) return { name: 'spawn_egg', metadata: id }
    return { name: 'spawn_egg', nbt: { type: 'compound', name: '', value: { EntityTag: { type: 'compound', value: { id: { type: 'string', value: `minecraft:${entity.name}` } } } } } }
  }
  if (!item || !has(item)) return null
  return { name: item }
}

/** Inventory index (0 - 8 hotbar, 9 - 35 main) to mineflayer's window slot */
const windowSlot = (index: number) => (index < 9 ? 36 + index : index)

export class PickBlock {
  /** the hotbar slot to send with the next tick's held_item_slot (ensureHasSentCarriedItem) */
  pendingSelected: number | null = null

  constructor(private bot: Bot, private version: () => VersionCompare) {}

  private slots(): Array<Item | null> {
    return this.bot.inventory.slots as Array<Item | null>
  }

  private itemAt(index: number) {
    return this.slots()[windowSlot(index)] ?? null
  }

  private setItemAt(index: number, item: Item | null) {
    const inventory: any = this.bot.inventory
    if (typeof inventory.updateSlot === 'function') inventory.updateSlot(windowSlot(index), item)
    else inventory.slots[windowSlot(index)] = item
  }

  private get selected() {
    return this.pendingSelected ?? this.bot.quickBarSlot
  }

  /** Inventory.findSlotMatchingItem: same item, same metadata (an item with subtypes), no tag */
  private findSlotMatchingItem(picked: PickedItem, type: number) {
    for (let i = 0; i < 36; i++) {
      const item: any = this.itemAt(i)
      if (!item || item.type !== type) continue
      if (picked.metadata !== undefined && item.metadata !== picked.metadata) continue
      const hasTag = !!item.nbt || (item.componentMap instanceof Map && [...item.componentMap.keys()].some((k: string) => k !== 'damage'))
      if (hasTag !== !!picked.nbt) continue
      return i
    }
    return -1
  }

  /** Inventory.getSuitableHotbarSlot: the first empty hotbar slot from the selected one, else the first not enchanted */
  private getSuitableHotbarSlot() {
    const selected = this.selected
    for (let k = 0; k < 9; k++) {
      const i = (selected + k) % 9
      if (!this.itemAt(i)) return i
    }
    for (let k = 0; k < 9; k++) {
      const i = (selected + k) % 9
      const item: any = this.itemAt(i)
      if (!(item?.enchants?.length > 0)) return i
    }
    return selected
  }

  private getFreeSlot() {
    for (let i = 0; i < 36; i++) if (!this.itemAt(i)) return i
    return -1
  }

  pick(target: { block?: Block | null, entity?: Entity | null }, includeData = false) {
    const v = this.version()
    const { block, entity } = target
    if (!block && !entity) return
    // 1.21.4+: the server picks, in every game mode
    if (v['>=']('1.21.4')) {
      if (entity) this.bot._client.write('pick_item_from_entity', { entityId: entity.id, includeData })
      else this.bot._client.write('pick_item_from_block', { position: block!.position, includeData })
      return
    }
    const data = MinecraftData(this.bot.version)
    const creative = this.bot.game.gameMode === 'creative'
    // up to 1.21.3 an entity is picked in creative only
    const picked = entity ? (creative ? entityPickItem(data, v, entity) : null) : blockPickItem(data, block!)
    if (!picked) return
    const type = data.itemsByName[picked.name]!.id
    const Item = PrismarineItem(this.bot.version as any) as any
    const j = this.findSlotMatchingItem(picked, type)
    if (creative) {
      const stack: Item = new Item(type, 1, picked.metadata ?? 0, picked.nbt)
      this.setPickedItem(stack, j, v)
      // MultiPlayerGameMode.handleCreativeModeItemAdd: the main hand's slot
      this.bot._client.write('set_creative_slot', { slot: 36 + this.selected, item: Item.toNotch(this.itemAt(this.selected)) })
      return
    }
    if (j === -1) return
    if (j < 9) {
      this.select(j)
    } else if (v['>=']('1.13')) {
      this.bot._client.write('pick_item', { slot: j })
    } else if (v['>=']('1.9')) {
      this.bot._client.write('custom_payload', { channel: 'MC|PickItem', data: varint(j) })
    }
  }

  private select(slot: number) {
    if (slot !== this.bot.quickBarSlot || this.pendingSelected !== null) this.pendingSelected = slot
  }

  /** Inventory.setPickedItem (1.8: addPickBlock, which does not swap with the main inventory) */
  private setPickedItem(stack: Item, j: number, v: VersionCompare) {
    if (j >= 0 && j < 9) {
      this.select(j)
      return
    }
    if (v['<']('1.9')) {
      const free = this.getFreeSlot()
      if (free >= 0 && free < 9) this.select(free)
      const found = j >= 9 ? this.itemAt(j) : null
      if (found) this.setItemAt(j, this.itemAt(this.selected))
      if (found) (stack as any).count = found.count
      this.setItemAt(this.selected, stack)
      return
    }
    if (j === -1) {
      this.select(this.getSuitableHotbarSlot())
      const current = this.itemAt(this.selected)
      if (current) {
        const free = this.getFreeSlot()
        if (free !== -1) this.setItemAt(free, current)
      }
      this.setItemAt(this.selected, stack)
    } else {
      // Inventory.pickSlot
      this.select(this.getSuitableHotbarSlot())
      const swapped = this.itemAt(this.selected)
      this.setItemAt(this.selected, this.itemAt(j))
      this.setItemAt(j, swapped)
    }
  }

  /** the next tick: the selected slot goes out (held_item_slot) */
  tick() {
    if (this.pendingSelected === null) return
    const slot = this.pendingSelected
    this.pendingSelected = null
    this.bot.setQuickBarSlot(slot)
  }
}

function varint(value: number) {
  const bytes: number[] = []
  do {
    let byte = value & 0x7f
    value >>>= 7
    if (value) byte |= 0x80
    bytes.push(byte)
  } while (value)
  return Buffer.from(bytes)
}
