import { Block } from 'prismarine-block'
import type { HandContext, InteractionResult } from './interactionRules'
import { itemToBlockRemaps } from './itemBlocksStatic'

const isBlockItem = (ctx: HandContext, name: string) => !!ctx.data.blocksByName[itemToBlockRemaps[name] ?? name]

/** Item.useOn on the block (interim) */
export function itemUseOnResult(ctx: HandContext, block: Block, placementPossible: () => boolean): InteractionResult {
  if (!ctx.item) return 'pass'
  if (isBlockItem(ctx, ctx.item.name)) return placementPossible() ? 'success' : 'fail'
  return 'pass'
}

const STARTS_USING = new Set(['bow', 'crossbow', 'shield', 'spyglass', 'trident', 'goat_horn', 'brush', 'potion', 'milk_bucket', 'honey_bottle', 'ominous_bottle'])
const INSTANT = new Set(['snowball', 'egg', 'ender_pearl', 'experience_bottle', 'splash_potion', 'lingering_potion', 'fishing_rod', 'wind_charge'])
const ALWAYS_EDIBLE = new Set(['golden_apple', 'enchanted_golden_apple', 'chorus_fruit', 'suspicious_stew'])

/** Player.canEat: hungry, or an always edible food; from 1.15 always while invulnerable (creative, spectator) */
function canEat(ctx: HandContext, name: string) {
  const invulnerable = ctx.gameMode === 'creative' || ctx.gameMode === 'spectator'
  const hungry = ALWAYS_EDIBLE.has(name) || (ctx.bot.food ?? 20) < 20
  return ctx.version['>=']('1.15') ? invulnerable || hungry : !invulnerable && hungry
}

/** Item.use (interim) */
export function itemUseResult(ctx: HandContext): { result: InteractionResult, startsUsing: boolean } {
  const name = ctx.item?.name
  if (!name) return { result: 'pass', startsUsing: false }
  // 1.8 swords block
  if (ctx.version['<']('1.9') && name.endsWith('_sword')) return { result: 'consume', startsUsing: true }
  if (STARTS_USING.has(name)) return { result: 'consume', startsUsing: true }
  if (ctx.data.foodsByName[name]) return canEat(ctx, name) ? { result: 'consume', startsUsing: true } : { result: 'fail', startsUsing: false }
  if (INSTANT.has(name)) return { result: 'success', startsUsing: false }
  return { result: 'pass', startsUsing: false }
}
