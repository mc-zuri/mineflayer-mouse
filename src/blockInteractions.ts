import { Block } from 'prismarine-block'
import type { HandContext, InteractionResult } from './interactionRules'
import { isBlockActivatable } from './itemBlocksStatic'

/** whether right clicking the block uses it (interim: the hand-written list) */
export function blockUseResult(ctx: HandContext, block: Block): InteractionResult {
  // 1.20.5+: useWithoutItem only runs for the main hand
  if (ctx.hand === 1 && ctx.version['>=']('1.20.5')) return 'pass'
  return isBlockActivatable(block.name) ? 'success' : 'pass'
}
