import { Entity } from 'prismarine-entity'
import type { HandContext, InteractionResult } from './interactionRules'
import { getLatestEntityName } from './attackableEntity'

/** Entity.interactAt then Player.interactOn (interim) */
export function entityInteractResult(ctx: HandContext, entity: Entity): { interactAt: InteractionResult, interact: InteractionResult } {
  const name = getLatestEntityName(entity.name ?? '')
  const interactAt: InteractionResult = name === 'armor_stand' && ctx.item?.name !== 'name_tag' ? 'consume' : 'pass'
  return { interactAt, interact: 'pass' }
}
