/**
 * The 1.21.11+ attack components: MINIMUM_ATTACK_CHARGE (Player.cannotAttackWithItem), ATTACK_RANGE
 * (AttackRange.isInRange, and the crosshair's entity pick) and the attack speed they are measured against. Vanilla
 * gives them to the spears only; a server can put them on any item.
 */
import { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { getBotEyeHeight } from './botCommon'

export interface AttackRange {
  minRange: number
  maxRange: number
  minCreativeRange: number
  maxCreativeRange: number
  hitboxMargin: number
}

/** Item.Properties.spear: the attack duration that sets a spear's attack speed (1 / duration) */
const SPEAR_ATTACK_DURATION: Record<string, number> = {
  wooden_spear: 0.65,
  stone_spear: 0.75,
  copper_spear: 0.85,
  iron_spear: 0.95,
  golden_spear: 0.95,
  diamond_spear: 1.05,
  netherite_spear: 1.15
}

const SPEAR_RANGE: AttackRange = { minRange: 2, maxRange: 4.5, minCreativeRange: 2, maxCreativeRange: 6.5, hitboxMargin: 0.125 }

function component(item: any, name: string): any {
  const c = item?.componentMap?.get?.(name) ?? item?.componentMap?.get?.(`minecraft:${name}`)
  return c === undefined ? undefined : c.data ?? c
}

const number = (v: any) => (typeof v === 'number' ? v : typeof v?.value === 'number' ? v.value : undefined)

export function getMinimumAttackCharge(item: any): number {
  if (!item) return 0
  const charge = number(component(item, 'minimum_attack_charge'))
  if (charge !== undefined) return charge
  return SPEAR_ATTACK_DURATION[item.name] !== undefined ? 1 : 0
}

export function getAttackRange(item: any): AttackRange | undefined {
  if (!item) return undefined
  const data = component(item, 'attack_range')
  if (data && typeof data === 'object') {
    return {
      minRange: data.minRange ?? data.min_reach ?? SPEAR_RANGE.minRange,
      maxRange: data.maxRange ?? data.max_reach ?? SPEAR_RANGE.maxRange,
      minCreativeRange: data.minCreativeRange ?? data.min_creative_reach ?? SPEAR_RANGE.minCreativeRange,
      maxCreativeRange: data.maxCreativeRange ?? data.max_creative_reach ?? SPEAR_RANGE.maxCreativeRange,
      hitboxMargin: data.hitboxMargin ?? data.hitbox_margin ?? SPEAR_RANGE.hitboxMargin
    }
  }
  return SPEAR_ATTACK_DURATION[item.name] !== undefined ? SPEAR_RANGE : undefined
}

/** the reach the player gets from the range: a spectator from 0, creative its creative reach */
export function effectiveRange(range: AttackRange, gameMode: string) {
  const creative = gameMode === 'creative'
  const min = gameMode === 'spectator' ? 0 : creative ? range.minCreativeRange : range.minRange
  const max = creative ? range.maxCreativeRange : range.maxRange
  return { min, max }
}

/** AttackRange.isInRange: the hit point's distance from the eyes within the range, with the hitbox margin */
export function isInAttackRange(range: AttackRange, bot: Bot, hit: Vec3) {
  const eye = bot.entity.position.offset(0, getBotEyeHeight(bot), 0)
  const d = hit.distanceTo(eye)
  const { min, max } = effectiveRange(range, bot.game.gameMode)
  return d >= min - range.hitboxMargin && d <= max + range.hitboxMargin
}

/**
 * The attack_speed attribute as the server sent it (base and modifiers: add_value, add_multiplied_base,
 * add_multiplied_total); without it the base 4, or a spear's 1 / attack duration (its main hand modifier)
 */
export function getAttackSpeed(bot: Bot): number {
  const attributes = (bot.entity as any)?.attributes ?? {}
  const attr = attributes['minecraft:attack_speed'] ?? attributes.attack_speed ?? attributes['minecraft:generic.attack_speed'] ?? attributes['generic.attack_speed'] ?? attributes.generic_attack_speed
  if (attr && typeof attr.value === 'number') {
    const mods: any[] = attr.modifiers ?? []
    const op = (m: any) => (typeof m.operation === 'number' ? m.operation : m.operation === 'add_multiplied_base' ? 1 : m.operation === 'add_multiplied_total' ? 2 : 0)
    const amount = (m: any) => m.amount ?? m.value ?? 0
    let value = attr.value + mods.filter(m => op(m) === 0).reduce((sum, m) => sum + amount(m), 0)
    const base = value
    value += mods.filter(m => op(m) === 1).reduce((sum, m) => sum + base * amount(m), 0)
    for (const m of mods.filter(m => op(m) === 2)) value *= 1 + amount(m)
    return Math.max(0, Math.min(1024, value))
  }
  const duration = SPEAR_ATTACK_DURATION[bot.heldItem?.name ?? '']
  // the modifier is (double)(1.0F / duration) - 4.0 on the base 4
  if (duration !== undefined) return Math.fround(1 / Math.fround(duration))
  return 4
}
