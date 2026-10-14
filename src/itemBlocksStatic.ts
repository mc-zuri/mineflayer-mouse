// The hand-written list of blocks that take a right click, kept for botTryPlaceBlockPrediction and as a public
// helper; the click itself follows blockInteractionsData.json (src/blockInteractions.ts), generated from vanilla.
// these have
// protected InteractionResult useWithoutItem
// but not protected InteractionResult useItemOn
export const activatableBlockWithoutItemPatterns = [
  // Containers
  /^(barrel|hopper|dispenser|dropper)$/,
  /^.*chest$/,
  /^.*shulker_box$/,
  /^.*(furnace|smoker)$/,
  /^(brewing_stand|beacon)$/,
  // Crafting
  /^.*table$/,
  /^(grindstone|stonecutter|loom|smithing_table|cartography_table)$/,
  /^.*anvil$/,
  // Redstone
  /^(lever|repeater|comparator|daylight_detector|observer|note_block|jukebox|bell)$/,
  // Buttons
  /^.*button$/,
  // Doors, gates and trapdoors
  /^.*door$/,
  /^.*trapdoor$/,
  /^.*fence_gate$/,
  // Functional blocks
  /^(enchanting_table|lectern|composter|respawn_anchor|lodestone|conduit)$/,
  /^.*bee.*$/,
  // Beds
  /^.*bed$/,
  // Technical blocks
  /^(command_block|jigsaw|structure_block|moving_piston)$/,
  // Plants and natural blocks
  /^(dragon_egg|flower_pot|sweet_berry_bush|cave_vines.*|.*candle.*)$/,
  // Misc
  /^(cake|decorated_pot|crafter|trial_spawner|vault)$/,
  // CopperGolemStatueBlock (1.21.9+): useItemOn cycles the pose with any item but an axe, which then acts itself
  /^.*copper_golem_statue$/,
  // fence (ignore)
  // sign (ignore)
] as const

export const itemToBlockRemaps = {
  redstone: 'redstone_wire',
  tripwire_hook: 'tripwire'
}

export function isBlockActivatable(blockName: string): boolean {
  return activatableBlockWithoutItemPatterns.some(pattern => pattern.test(blockName))
}
