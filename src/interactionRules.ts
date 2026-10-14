/**
 * The client-side results vanilla predicts for a right click, which decide what it sends next: whether the click is
 * consumed (no more packets for this click), whether the client swings, and whether the item starts being used.
 *
 * InteractionResult as the plugin models it:
 * - success: consumed, the client swings (SUCCESS / Success(swingSource CLIENT|PREDICTED))
 * - consume: consumed, no client swing (CONSUME, CONSUME_PARTIAL, SUCCESS_SERVER)
 * - pass: not consumed, vanilla goes on (the item's use, then the off hand)
 * - fail: stops the whole click (1.13+), or is ignored (1.9 - 1.12)
 */
import { Bot } from 'mineflayer'
import { Block } from 'prismarine-block'
import { Entity } from 'prismarine-entity'
import MinecraftData from 'minecraft-data'
import { blockUseResult } from './blockInteractions'
import { itemUseOnResult, itemUseResult } from './itemInteractions'
import { entityInteractResult } from './entityInteractions'

export type InteractionResult = 'success' | 'consume' | 'pass' | 'fail'

export const consumesAction = (result: InteractionResult) => result === 'success' || result === 'consume'

export interface VersionCompare {
  '>=': (v: string) => boolean
  '<': (v: string) => boolean
  '>': (v: string) => boolean
  '<=': (v: string) => boolean
}

export interface HandContext {
  bot: Bot
  data: MinecraftData.IndexedData
  version: VersionCompare
  hand: 0 | 1
  item: { name: string, count?: number, nbt?: any, componentMap?: Map<string, any> } | null
  mainItem: HandContext['item']
  offItem: HandContext['item']
  sneaking: boolean
  gameMode: string
}

/** Block.use (up to 1.20.4) or Block.useItemOn and, for the main hand, useWithoutItem (1.20.5+) */
export function predictBlockUse(ctx: HandContext, block: Block): InteractionResult {
  return blockUseResult(ctx, block)
}

/** Item.useOn, after the block passed; a block item places itself (success) or fails */
export function predictItemUseOn(ctx: HandContext, block: Block, placementPossible: () => boolean): InteractionResult {
  return itemUseOnResult(ctx, block, placementPossible)
}

/** Item.use: the result, and whether the player then is using the item (it takes time, as a bow or food) */
export function predictItemUse(ctx: HandContext): { result: InteractionResult, startsUsing: boolean } {
  return itemUseResult(ctx)
}

/** Entity.interactAt (before 26.1), then Player.interactOn (Entity.interact, then the item's interactLivingEntity) */
export function predictEntityInteract(ctx: HandContext, entity: Entity): { interactAt: InteractionResult, interact: InteractionResult } {
  return entityInteractResult(ctx, entity)
}
