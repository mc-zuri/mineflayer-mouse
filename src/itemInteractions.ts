/**
 * Item.use and Item.useOn as the vanilla client evaluates them, from itemUseData.json (generated from the decompiled
 * clients by scripts/items): which items consume a click, start being used (and are released with the button), or
 * pass so vanilla goes on to the off hand.
 */
import { Block } from 'prismarine-block'
import { Vec3 } from 'vec3'
import type { HandContext, InteractionResult } from './interactionRules'
import { itemToBlockRemaps } from './itemBlocksStatic'
import itemUseData from './itemUseData.json'
import { versionToNumber } from './utils'

type UseEntry = [version: string, kind: string | null, cond?: string, onFalse?: string, onMiss?: string]
type UseOnEntry = [version: string, cond: string | null, onFalse?: string]

const useTable = itemUseData.use as unknown as Record<string, UseEntry[]>
const useOnTable = itemUseData.useOn as unknown as Record<string, UseOnEntry[]>

/**
 * The data has the 1.8.9 client and then 1.13.2 on: 1.9 - 1.13.1 behave as 1.13.2 does (1.9 dropped sword blocking,
 * the rest of these item uses are the same), 1.8.x as 1.8.9.
 */
function dataVersion(ctx: HandContext): number {
  if (ctx.version['<']('1.9')) return versionToNumber('1.8.9')
  if (ctx.version['<']('1.13.2')) return versionToNumber('1.13.2')
  return versionToNumber(ctx.data.version.minecraftVersion!)
}

function entryFor<T extends [string, ...any[]]>(list: T[] | undefined, version: number): T | undefined {
  if (!list) return undefined
  let found: T | undefined
  for (const entry of list) {
    if (versionToNumber(entry[0]) <= version) found = entry
  }
  return found
}

function byVersion<T>(table: Record<string, T>, version: number): T {
  let found: T | undefined
  for (const [v, value] of Object.entries(table)) {
    if (versionToNumber(v) <= version || found === undefined) found = value
  }
  return found!
}

export const isBlockItem = (ctx: HandContext, name: string) => !!ctx.data.blocksByName[itemToBlockRemaps[name] ?? name]

/** Player.canEat: hungry or an always edible food; from 1.15 always while invulnerable (creative, spectator) */
function canEat(ctx: HandContext, name: string) {
  const version = dataVersion(ctx)
  const alwaysEdible = byVersion(itemUseData.alwaysEdible as Record<string, string[]>, version).includes(name)
  const invulnerable = ctx.gameMode === 'creative' || ctx.gameMode === 'spectator'
  const hungry = alwaysEdible || (ctx.bot.food ?? 20) < 20
  // Player.canEat: `abilities.invulnerable || ...` from 1.15 (bytecode of 1.15 / 1.15.2), `... && !invulnerable` before
  return ctx.version['>=']('1.15') ? invulnerable || hungry : !invulnerable && hungry
}

const ARROWS = /^(arrow|spectral_arrow|tipped_arrow)$/

function hasAmmo(ctx: HandContext, fireworks: boolean) {
  if (ctx.gameMode === 'creative') return true
  const slots = ctx.bot.inventory?.slots ?? []
  return slots.some((slot, i) => slot && (ARROWS.test(slot.name) || (fireworks && /^(firework_rocket|fireworks)$/.test(slot.name) && (i === 45 || slot === ctx.bot.heldItem))))
}

function isChargedCrossbow(item: any) {
  return item?.componentMap?.get?.('charged_projectiles')?.data?.projectiles?.length > 0 || !!item?.nbt?.value?.Charged?.value
}

function equipmentSlotIndex(name: string): number | undefined {
  if (/helmet|_head$|_skull$|carved_pumpkin/.test(name)) return 5
  if (/chestplate|elytra/.test(name)) return 6
  if (/leggings/.test(name)) return 7
  if (/boots/.test(name)) return 8
  return undefined
}

/** the first block or fluid the crosshair ray meets (vanilla's Item.getPlayerPOVHitResult with a fluid mode) */
function rayFluidOrBlock(ctx: HandContext, fluids: 'source' | 'any'): Block | null {
  const { bot } = ctx
  const world = bot.world as any
  if (!bot.entity || typeof world?.raycast !== 'function') return ctx.cursorBlock ?? null
  const { yaw, pitch } = bot.entity
  const dir = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
  const eye = bot.entity.position.offset(0, bot.getControlState('sneak') ? 1.27 : 1.62, 0)
  const isFluid = (block: Block) => block.name === 'water' || block.name === 'lava'
  const matcher = (block: Block) => {
    if (!isFluid(block)) return true
    return fluids === 'any' || Number(block.getProperties?.().level ?? block.metadata) === 0
  }
  try {
    return world.raycast(eye, dir, 5, matcher) ?? null
  } catch {
    return ctx.cursorBlock ?? null
  }
}

function evalUseCond(ctx: HandContext, cond: string): boolean | 'miss' {
  const item: any = ctx.item
  const name = item.name
  switch (cond) {
    case 'canEat': return canEat(ctx, name)
    case 'notCreative': return ctx.gameMode !== 'creative'
    case 'hasArrows': return hasAmmo(ctx, false)
    case 'trident': {
      if ((item.durabilityUsed ?? 0) >= 250 - 1) return false
      const riptide = (Array.isArray(item.enchants) ? item.enchants : []).some((e: any) => /riptide$/.test(e.name))
      return !riptide || !!(ctx.bot.entity as any)?.isInWater || !!ctx.bot.isRaining
    }
    case 'notLookingAtEndPortalFrame': return ctx.cursorBlock?.name !== 'end_portal_frame'
    case 'fallFlying': return !!((ctx.bot.entity as any)?.elytraFlying ?? (ctx.bot.entity as any)?.fallFlying)
    case 'splashPotion': return ((item.metadata ?? 0) & 16384) !== 0
    case 'equipmentSlotEmpty': {
      const index = equipmentSlotIndex(name)
      return index === undefined || !ctx.bot.inventory?.slots[index]
    }
    case 'equipmentSlotDiffers': {
      const index = equipmentSlotIndex(name)
      return index === undefined || ctx.bot.inventory?.slots[index]?.name !== name
    }
    case 'lookingAtFluidSource': {
      const hit = rayFluidOrBlock(ctx, 'source')
      if (!hit) return 'miss'
      return hit.name === 'water' || hit.name === 'lava' || hit.name === 'powder_snow'
    }
    case 'lookingAtWaterSource': {
      const hit = rayFluidOrBlock(ctx, 'source')
      return hit?.name === 'water'
    }
    case 'lookingAtBlock': {
      const hit = rayFluidOrBlock(ctx, 'any')
      return hit ? true : 'miss'
    }
    default:
      return true
  }
}

const toResult = (kind: string | undefined): { result: InteractionResult, startsUsing: boolean } => {
  switch (kind) {
    case 'startUsing': return { result: 'consume', startsUsing: true }
    case 'instant': return { result: 'success', startsUsing: false }
    case 'fail': return { result: 'fail', startsUsing: false }
    default: return { result: 'pass', startsUsing: false }
  }
}

/** Item.use */
export function itemUseResult(ctx: HandContext): { result: InteractionResult, startsUsing: boolean } {
  const item: any = ctx.item
  if (!item) return { result: 'pass', startsUsing: false }
  const entry = entryFor(useTable[item.name], dataVersion(ctx))
  if (!entry || !entry[1]) return { result: 'pass', startsUsing: false }
  const [, kind, cond, onFalse, onMiss] = entry
  if (!cond) return toResult(kind!)
  if (cond === 'crossbow') {
    if (isChargedCrossbow(item)) return toResult('instant')
    return toResult(hasAmmo(ctx, true) ? 'startUsing' : 'fail')
  }
  const holds = evalUseCond(ctx, cond)
  if (holds === 'miss') return toResult(onMiss ?? 'pass')
  return toResult(holds ? kind! : onFalse)
}

const TILLABLE = /^(grass_block|dirt|dirt_path|grass_path|coarse_dirt|rooted_dirt)$/
const PATHABLE = /^(grass_block|dirt|podzol|coarse_dirt|mycelium|rooted_dirt)$/
const STRIPPABLE = /^(?!stripped_).*(_log|_wood|_stem|_hyphae|bamboo_block)$/
const OXIDIZABLE = /(exposed|weathered|oxidized)_|^waxed_/
const COPPER = /copper/
const BONEMEALABLE = /(_sapling|^wheat|^carrots|^potatoes|^beetroots|_stem$|^grass_block|^short_grass|^grass$|^fern|^tall_seagrass|^seagrass|^bamboo|^cocoa|^sweet_berry_bush|^kelp|^sea_pickle|^moss_block|azalea|glow_lichen|cave_vines|_vines|_nylium|_mushroom$|_fungus$|^torchflower_crop|^pitcher_crop|^mangrove_propagule|^pink_petals|^big_dripleaf|^small_dripleaf|^hanging_roots|^rooted_dirt|^pale_moss_block|^bush|^firefly_bush|^leaf_litter|^wildflowers|^cactus_flower|^short_dry_grass|^tall_dry_grass)/
const GROWING_PLANT_HEAD = /^(kelp|weeping_vines|twisting_vines|cave_vines)$/

/** an age below the block's maximum, for blocks that grow */
function canGrow(block: Block) {
  const props: any = block.getProperties?.() ?? {}
  if (props.age === undefined) return true
  const ageState = (block as any).states?.find?.((s: any) => s.name === 'age')
  const max = ageState?.num_values ? ageState.num_values - 1 : Number.POSITIVE_INFINITY
  return Number(props.age) < max
}

function evalUseOnCond(ctx: HandContext, block: Block, cond: string, placementPossible: () => boolean): boolean {
  const [base, extra] = cond.split('+')
  // 1.21+: an axe, hoe or shovel in the main hand passes when the off hand blocks attacks (a shield) and not sneaking
  if (extra === 'notShieldIntent' && ctx.hand === 0 && ctx.offItem?.name === 'shield' && !ctx.sneaking) return false
  const name = block.name
  const props: any = block.getProperties?.() ?? {}
  const face: number = (block as any).face
  switch (base) {
    case 'always': return true
    case 'never': return false
    case 'tillable': return TILLABLE.test(name) && face !== 0
    case 'pathable': return PATHABLE.test(name) && face !== 0
    case 'pathableOrLitCampfire': return (PATHABLE.test(name) && face !== 0) || (/campfire$/.test(name) && props.lit === true)
    case 'axeTransformable': return STRIPPABLE.test(name) || (COPPER.test(name) && OXIDIZABLE.test(name))
    case 'waxable': return COPPER.test(name) && !name.startsWith('waxed_')
    case 'bonemealable': return BONEMEALABLE.test(name) && canGrow(block)
    case 'growingPlantHead': return GROWING_PLANT_HEAD.test(name) && canGrow(block)
    case 'endPortalFrameWithoutEye': return name === 'end_portal_frame' && props.eye !== true
    // flint and steel, fire charge: light a campfire or candle, or set fire next to the face (almost always possible)
    case 'fireOrLightable': return true
    case 'rail': return /rail$/.test(name)
    case 'notDownFace': return face !== 0
    case 'hangingFace': return ctx.item?.name === 'painting' ? face >= 2 : true
    case 'upFace': return face === 1
    case 'obsidianOrBedrock': return name === 'obsidian' || name === 'bedrock'
    case 'fence': return /fence$/.test(name) && !/gate/.test(name)
    case 'jukeboxWithoutRecord': return name === 'jukebox' && props.has_record !== true
    case 'lecternWithoutBook': return name === 'lectern' && props.has_book !== true
    case 'banner': return /banner$/.test(name)
    case 'lodestone': return name === 'lodestone'
    case 'mudConvertible': return /^(dirt|coarse_dirt|rooted_dirt)$/.test(name) && face !== 0
    case 'placeOrEat': return placementPossible() || canEat(ctx, ctx.item!.name)
    case 'notFallFlying': return !((ctx.bot.entity as any)?.elytraFlying ?? (ctx.bot.entity as any)?.fallFlying)
    default: return true
  }
}

/** Item.useOn on the block, once the block passed */
export function itemUseOnResult(ctx: HandContext, block: Block, placementPossible: () => boolean): InteractionResult {
  const item = ctx.item
  if (!item) return 'pass'
  const entry = entryFor(useOnTable[item.name], dataVersion(ctx))
  if (entry) {
    const [, cond, onFalse] = entry
    // listed with no condition: the client passes from this version (e.g. a lead on a fence from 1.21.2)
    if (!cond) return 'pass'
    return evalUseOnCond(ctx, block, cond, placementPossible) ? 'success' : (onFalse === 'fail' ? 'fail' : 'pass')
  }
  // BlockItem.useOn: placed (success) or not (fail)
  if (isBlockItem(ctx, item.name)) return placementPossible() ? 'success' : 'fail'
  return 'pass'
}
