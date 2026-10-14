// Curated client-side classification of every vanilla block interaction override, per era.
// Keyed by the *defining* class (nearest class in the hierarchy, inclusive, that overrides
// use / onBlockActivated / useWithoutItem / useItemOn). Derived by reading every body variant
// (dump.js + view.js) from 1.7.10 to 26.3; see README section of gen.js for the condition DSL.
'use strict'

const ORDER = ['1.7.10', '1.8.9', '1.9.4', '1.10.2', '1.11.2', '1.12.2', '1.13.2', '1.14.4', '1.15.1', '1.16.4', '1.18.1', '1.19', '1.19.1', '1.19.3', '1.19.4', '1.20', '1.20.1', '1.20.2', '1.20.3', '1.20.4', '1.20.5', '1.20.6', '1.21', '1.21.1', '1.21.2', '1.21.3', '1.21.4', '1.21.5', '1.21.6', '1.21.7', '1.21.8', '1.21.9', '1.21.10', '1.21.11', '26.1', '26.1.1', '26.2', '26.3']
function cmp (a, b) {
  const x = a.split('.').map(Number); const y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d }
  return 0
}
const inRange = (v, from, to) => cmp(v, from) >= 0 && cmp(v, to) <= 0

const A = { kind: 'always' }
const C = cond => ({ kind: 'conditional', cond })
const I = (items, cond) => (cond ? { kind: 'itemOnly', items, cond } : { kind: 'itemOnly', items })
const NEVER = null
// [from, to, entry|fn(name, ctx)]
const ALL = (e) => [['0', '99', e]]

const LEGACY_POTTABLE_COND = 'holding(@pottable) & potEmpty'

// Door/trapdoor: whether this block can be opened by hand is static per block (iron variants cannot).
function openableByHand (name, ctx) {
  const t = ctx.regText || ''
  if (/BlockSetType\.IRON\b|Material\.METAL\b|Material\.IRON\b|Material\.field_151573_f\b/.test(t)) return false
  if (/^iron_(door|trapdoor)$/.test(name)) return false
  return true
}
const doorModern = (name, ctx) => (openableByHand(name, ctx) ? A : NEVER)

// cauldrons 1.17+ (AbstractCauldronBlock + CauldronInteraction maps); keyed by block name
function cauldron117 (name, ctx) {
  const v = ctx.version
  const fills = 'water_bucket,lava_bucket,powder_snow_bucket'
  const dyeable = 'leather_helmet,leather_chestplate,leather_leggings,leather_boots,leather_horse_armor' + (cmp(v, '1.20.5') >= 0 ? ',wolf_armor' : '')
  switch (name) {
    case 'cauldron': return C(`holding(${fills}) | holding(potion)`)
    case 'water_cauldron': return C(`holding(${fills},glass_bottle,${dyeable},*_banner,*_shulker_box) | (holding(bucket) & level=3) | (holding(potion) & level<3)`)
    case 'lava_cauldron': return I(['bucket', 'water_bucket', 'lava_bucket', 'powder_snow_bucket'])
    case 'powder_snow_cauldron': return C(`holding(${fills}) | (holding(bucket) & level=3)`)
  }
  return NEVER
}

const RULES = {
  // ---------------- 1.7.10 / 1.8.9 / 1.13.2 (MCP class names) ----------------
  BlockAnvil: ALL(A),
  BlockBeacon: ALL(A),
  BlockBed: ALL(A),
  BlockBrewingStand: ALL(A),
  BlockButton: ALL(A),
  BlockChest: ALL(A),
  BlockDispenser: ALL(A),
  BlockDragonEgg: ALL(A),
  BlockEnchantmentTable: ALL(A),
  BlockEnderChest: ALL(A),
  BlockFenceGate: ALL(A),
  BlockFurnace: ALL(A),
  BlockHopper: ALL(A),
  BlockLever: ALL(A),
  BlockNote: ALL(A),
  BlockShulkerBox: ALL(A),
  BlockWorkbench: ALL(A),
  BlockSign: ALL(A), // client: if (isRemote) return true
  BlockCake: [['1.7.10', '1.8.9', A], ['1.13.2', '1.13.2', C('hungry | emptyHand')]],
  BlockCauldron: [['1.7.10', '1.8.9', A], ['1.13.2', '1.13.2', C('emptyHand | holding(water_bucket,bucket,glass_bottle,potion) | (level>0 & holding(*_banner,@block_item))')]],
  BlockFence: [['1.7.10', '1.8.9', A], ['1.13.2', '1.13.2', C('holding(lead) | emptyHand')]],
  BlockRedstoneComparator: [['1.7.10', '1.7.10', A], ['1.8.9', '1.13.2', C('mayBuild')]],
  BlockRedstoneRepeater: [['1.7.10', '1.7.10', A], ['1.8.9', '1.13.2', C('mayBuild')]],
  BlockDaylightDetector: ALL(C('mayBuild')),
  BlockCommandBlock: [['1.7.10', '1.7.10', A], ['1.8.9', '1.8.9', C('creative')], ['1.13.2', '1.13.2', C('opCreative')]],
  BlockDoor: [['1.7.10', '1.8.9', A], ['1.13.2', '1.13.2', doorModern]], // iron doors consumed (no-op) before 1.11
  BlockTrapDoor: [['1.7.10', '1.8.9', A], ['1.13.2', '1.13.2', doorModern]],
  BlockJukebox: ALL(C('has_record')),
  BlockFlowerPot: [['1.7.10', '1.8.9', C(LEGACY_POTTABLE_COND)], ['1.13.2', '1.13.2', A]],
  BlockPumpkin: ALL(I(['shears'])),
  BlockTNT: [['1.7.10', '1.7.10', I(['flint_and_steel'])], ['1.8.9', '1.13.2', I(['flint_and_steel', 'fire_charge'])]],
  BlockStructure: ALL(C('opCreative')),
  BlockPistonMoving: ALL(NEVER), // client returns false
  BlockPistonBase: ALL(NEVER),
  BlockRedstoneOre: ALL(NEVER), // super -> false
  BlockStairs: ALL(NEVER), // delegates to base block (never interactive)

  // ---------------- 1.9.4 - 1.12.2 (legacy yarn names) + 1.14.4+ (Mojang names); ranges disambiguate ----------------
  AbstractButtonBlock: ALL(A),
  AbstractSignBlock: ALL(A),
  AnvilBlock: ALL(A),
  BeaconBlock: ALL(A),
  BedBlock: ALL(A),
  AbstractBedBlock: ALL(A),
  BrewingStandBlock: ALL(A),
  ChestBlock: ALL(A),
  CraftingTableBlock: ALL(A),
  DispenserBlock: ALL(A),
  DragonEggBlock: ALL(A),
  EnchantingTableBlock: ALL(A),
  EnchantmentTableBlock: ALL(A),
  EnderChestBlock: ALL(A),
  FenceGateBlock: ALL(A),
  FurnaceBlock: ALL(A),
  AbstractFurnaceBlock: ALL(A),
  HopperBlock: ALL(A),
  LeverBlock: ALL(A),
  ShulkerBoxBlock: ALL(A),
  BarrelBlock: ALL(A),
  ButtonBlock: ALL(A), // powered button still returns CONSUME
  CartographyTableBlock: ALL(A),
  CrafterBlock: ALL(A),
  GrindstoneBlock: ALL(A),
  LoomBlock: ALL(A),
  StonecutterBlock: ALL(A),
  LightBlock: ALL(A), // client returns CONSUME (only targetable while holding a light item)
  DecoratedPotBlock: ALL(A), // client CONSUME for any held stack (incl. empty)
  FlowerPotBlock: [
    ['1.9.4', '1.10.2', C(LEGACY_POTTABLE_COND)],
    ['1.11.2', '1.12.2', C('holding(@pottable) | !potEmpty')],
    ['1.14.4', '99', A] // 1.14: returns true; 1.16+: CONSUME when nothing to do; 1.20.5+: useWithoutItem CONSUME on empty pot
  ],
  NoteBlock: [['1.9.4', '1.19.4', A], ['1.20', '99', C('!(holding(@note_block_top_instruments) & face=up)')]], // 1.19.4: head check only behind the update_1_20 feature flag
  SmithingTableBlock: [['1.14.4', '1.15.1', NEVER], ['1.16.4', '99', A]],
  FletchingTableBlock: ALL(NEVER),
  MovingPistonBlock: ALL(NEVER),
  PistonExtensionBlock: ALL(NEVER),
  StairBlock: ALL(NEVER),
  StairsBlock: ALL(NEVER),
  RedstoneOreBlock: ALL(NEVER), // yarn 1.9-1.12: super -> false
  RedStoneOreBlock: [['1.14.4', '1.14.4', NEVER], ['1.15.1', '1.15.1', A], ['1.16.4', '99', C('!holding(@block_item)')]], // 1.16+: PASS only if a placeable block item (BlockPlaceContext.canPlace)
  SignBlock: ALL(A), // 1.14-1.19.4 client CONSUME/SUCCESS; 1.20+ CONSUME or SUCCESS (waxed/applicator); 1.20.5+ useItemOn same for every stack
  CeilingHangingSignBlock: [['1.19.3', '1.19.4', C('!holding(@block_item)')], ['1.20', '99', C('!(holding(*_hanging_sign) & face=down)')]],
  WallHangingSignBlock: [['1.19.3', '1.19.4', C('!holding(@block_item)')], ['1.20', '99', C('!(holding(*_hanging_sign) & !hitFacingAxis)')]],
  BellBlock: ALL(C('bellProperHit')),
  CakeBlock: [
    ['1.9.4', '1.10.2', A],
    ['1.11.2', '1.16.4', C('hungry | emptyHand')],
    ['1.17', '99', C('(holding(@candles) & bites=0) | hungry | emptyHand')]
  ],
  CandleCakeBlock: ALL(C('!holding(flint_and_steel,fire_charge) & ((candleHit & emptyHand & lit) | hungry)')),
  CandleBlock: ALL(C('mayBuild & emptyHand & lit')),
  CampfireBlock: [
    ['1.14.4', '1.15.1', I(['@campfire_food'], 'lit')],
    ['1.16.4', '26.2', I(['@campfire_food'])],
    ['26.3', '99', C('holding(@campfire_food) | (lit & holding(*_shovel))')]
  ],
  CaveVinesBlock: ALL(C('berries')),
  CaveVinesPlantBlock: ALL(C('berries')),
  ChiseledBookShelfBlock: ALL(C('hitFacing')),
  ShelfBlock: [['1.21.9', '1.21.10', C('hitFacing')], ['1.21.11', '99', C('hitFacing & !emptyHand')]],
  CommandBlock: [['1.9.4', '1.9.4', C('creative')], ['1.10.2', '99', C('opCreative')]],
  JigsawBlock: ALL(C('opCreative')),
  StructureBlock: [['1.9.4', '1.9.4', NEVER], ['1.10.2', '99', C('opCreative')]],
  TestBlock: ALL(C('opCreative')),
  TestInstanceBlock: ALL(C('opCreative')),
  ComparatorBlock: ALL(C('mayBuild')),
  RepeaterBlock: ALL(C('mayBuild')),
  DaylightDetectorBlock: ALL(C('mayBuild')),
  ComposterBlock: ALL(C('level=8 | (level<8 & holding(@compostable))')),
  CopperGolemStatueBlock: ALL(C('!holding(*_axe)')),
  WeatheringCopperGolemStatueBlock: ALL((name) => (name === 'copper_golem_statue' ? C('!holding(honeycomb)') : C('!holding(honeycomb,*_axe)'))),
  DoorBlock: [['1.9.4', '1.10.2', A], ['1.11.2', '99', doorModern]],
  TrapdoorBlock: [['1.9.4', '1.10.2', A], ['1.11.2', '1.12.2', doorModern]],
  TrapDoorBlock: ALL(doorModern),
  FenceBlock: [
    ['1.9.4', '1.10.2', A],
    ['1.11.2', '1.14.4', C('holding(lead) | emptyHand')],
    ['1.15.1', '1.21.1', I(['lead'])],
    ['1.21.2', '99', NEVER] // leash attaching moved to LeadItem.useOn
  ],
  JukeboxBlock: [['1.9.4', '1.20.6', C('has_record')], ['1.21', '99', C('has_record | holding(@music_discs)')]],
  LecternBlock: [
    ['1.14.4', '1.14.4', C('has_book')],
    ['1.15.1', '1.20.4', C('has_book | (!emptyHand & !holding(@lectern_books))')],
    ['1.20.5', '99', C('has_book | !emptyHand')]
  ],
  PumpkinBlock: ALL(I(['shears'])),
  RedStoneWireBlock: ALL(C('mayBuild & wireDotOrCross')),
  RedstoneWireBlock: ALL(C('mayBuild & wireDotOrCross')),
  RespawnAnchorBlock: [
    ['1.16.4', '1.20.4', C('(holding(glowstone) & charges<4) | (charges>0 & !(offhandHolding(glowstone) & !holding(glowstone)))')],
    ['1.20.5', '99', C('(holding(glowstone) & charges<4) | (charges>0 & !(offhandHolding(glowstone) & charges<4))')]
  ],
  SweetBerryBushBlock: ALL(C('age>1 & !(holding(bone_meal) & age<3)')),
  TntBlock: [['1.9.4', '99', I(['flint_and_steel', 'fire_charge'])]],
  VaultBlock: ALL(C('vault_state=active & !emptyHand')),
  BeehiveBlock: [['1.15.1', '1.21.8', I(['shears', 'glass_bottle'], 'honey_level>=5')], ['1.21.9', '99', I(['glass_bottle'], 'honey_level>=5')]],
  CauldronBlock: [
    ['1.9.4', '1.10.2', C('emptyHand | holding(water_bucket,bucket,glass_bottle) | (level>0 & holding(banner))')],
    ['1.11.2', '1.12.2', C('emptyHand | holding(water_bucket,bucket,glass_bottle,potion) | (level>0 & holding(banner))')],
    ['1.14.4', '1.14.4', C('emptyHand | holding(water_bucket,bucket,glass_bottle,potion) | (level>0 & holding(*_banner,@block_item))')],
    ['1.15.1', '1.16.4', C('holding(water_bucket,bucket,glass_bottle,potion) | (level>0 & holding(*_banner,@block_item))')],
    ['1.17', '99', cauldron117]
  ],
  AbstractCauldronBlock: ALL(cauldron117),
  // base classes: default implementation (false / PASS / TRY_WITH_EMPTY_HAND)
  Block: ALL(NEVER),
  BlockBehaviour: ALL(NEVER)
}

// ---------------------------------------------------------------- client swing
// Does the CONSUMING client result swing the arm? <=1.14.4: block use returned boolean -> SUCCESS -> always swings.
// 1.15-1.21.1: swings iff the client result is SUCCESS (sidedSuccess on client), not CONSUME/CONSUME_PARTIAL.
// 1.21.2+: swings iff InteractionResult.Success with swingSource CLIENT (SUCCESS), not SUCCESS_SERVER / CONSUME.
// Value: false (never swings when consuming) | '<cond>' (swings iff cond) | absent (always swings).
const SIGN_SWING = [
  ['1.15.1', '1.16.4', 'mayBuild & holding(*_dye)'], // client: dye && mayBuild ? SUCCESS : CONSUME
  ['1.17', '1.19.4', 'mayBuild & holding(*_dye,ink_sac,glow_ink_sac)'],
  ['1.20', '99', '(mayBuild & holding(*_dye,ink_sac,glow_ink_sac,honeycomb)) | signWaxed'] // !applicator && !waxed ? CONSUME : SUCCESS
]
const SWING = {
  BedBlock: [['1.15.1', '99', false]], // client CONSUME; 1.21.2+ SUCCESS_SERVER
  AbstractBedBlock: [['0', '99', false]],
  ButtonBlock: [['1.15.1', '99', '!powered']], // powered -> CONSUME
  CakeBlock: [['1.15.1', '1.16.4', 'hungry'], ['1.17', '99', 'hungry | (holding(@candles) & bites=0)']], // empty hand & not hungry -> CONSUME
  CampfireBlock: [['1.15.1', '26.2', false], ['26.3', '99', 'lit & holding(*_shovel)']], // placing food: client CONSUME; dousing: SUCCESS
  ChiseledBookShelfBlock: [['0', '99', 'hitSlotOccupied | holding(@bookshelf_books)']], // empty slot + non-book -> CONSUME
  FlowerPotBlock: [['1.15.1', '99', (name) => (name === 'flower_pot' ? 'holding(@pottable)' : '!holding(@pottable)')]], // nothing to do -> CONSUME
  LecternBlock: [['1.15.1', '1.20.4', 'has_book'], ['1.20.5', '99', 'has_book | holding(@lectern_books)']],
  LightBlock: [['0', '99', false]], // client CONSUME
  RespawnAnchorBlock: [['1.16.4', '1.21.10', '(holding(glowstone) & charges<4) | !anchorWorks'], ['1.21.11', '99', 'holding(glowstone) & charges<4']], // setting spawn: client CONSUME
  SignBlock: SIGN_SWING,
  CeilingHangingSignBlock: SIGN_SWING,
  WallHangingSignBlock: SIGN_SWING,
  VaultBlock: [['0', '99', false]], // client CONSUME; 1.21.2+ SUCCESS_SERVER
  DecoratedPotBlock: [['1.20.3', '1.21.1', false]], // client CONSUME; 1.21.2+ client SUCCESS
  ShelfBlock: [['26.3', '99', false]], // 26.3: client CONSUME
  CauldronBlock: [['1.15.1', '1.16.4', '!holding(@block_item) | holding(*_banner)']] // block item on non-empty cauldron -> client CONSUME
}

// ---------------------------------------------------------------- off hand (1.20.5+)
// useItemOn runs for both hands (with that hand's item); useWithoutItem only for the main hand.
// Value: false (off hand never consumed by the block) | true (always) | 'same' (= the main entry's condition) | '<cond>'.
// In these conds holding()/emptyHand refer to the OFF-hand item.
const OFFHAND = {
  AbstractCauldronBlock: 'same',
  BeehiveBlock: 'same',
  CakeBlock: 'holding(@candles) & bites=0',
  CampfireBlock: 'same',
  CandleBlock: 'same',
  CandleCakeBlock: 'candleHit & emptyHand & lit',
  ChiseledBookShelfBlock: 'holding(@bookshelf_books) & hitFacing & !hitSlotOccupied',
  ComposterBlock: 'level<8 & holding(@compostable)',
  CopperGolemStatueBlock: 'same',
  WeatheringCopperGolemStatueBlock: 'same',
  DecoratedPotBlock: true,
  FlowerPotBlock: 'holding(@pottable)',
  JukeboxBlock: (v) => (cmp(v, '1.21') >= 0 ? '!has_record & holding(@music_discs)' : false), // useItemOn added in 1.21
  LecternBlock: '!has_book & holding(@lectern_books)',
  PumpkinBlock: 'same',
  TntBlock: 'same',
  VaultBlock: 'same',
  RedStoneOreBlock: 'same',
  RespawnAnchorBlock: 'holding(glowstone) & charges<4',
  SignBlock: true,
  CeilingHangingSignBlock: 'same',
  WallHangingSignBlock: 'same',
  FenceBlock: 'same'
}

function lookup (table, definer, version, name) {
  const rs = table[definer]
  if (!rs) return undefined
  for (const [from, to, v] of rs) if (inRange(version, from, to)) return typeof v === 'function' ? v(name) : v
  return undefined
}

function mainCondAsString (e) {
  if (e.kind === 'always') return true
  const h = e.kind === 'itemOnly' ? `holding(${e.items.join(',')})` : null
  if (h && e.cond) return `${h} & ${e.cond}`
  return h || e.cond
}

function classify (definer, version, name, ctx) {
  const rs = RULES[definer]
  if (!rs) return { unknown: true }
  for (const [from, to, e] of rs) {
    if (!inRange(version, from, to)) continue
    let entry = typeof e === 'function' ? e(name, ctx) : e
    if (!entry) return { entry }
    entry = { ...entry }
    const sw = cmp(version, '1.15.1') >= 0 ? lookup(SWING, definer, version, name) : undefined
    if (sw === false) entry.swing = false
    else if (typeof sw === 'string') entry.swingCond = sw
    if (cmp(version, '1.20.5') >= 0) {
      let oh = OFFHAND[definer]
      if (typeof oh === 'function') oh = oh(version)
      entry.offhand = oh === undefined ? false : oh === 'same' ? mainCondAsString(entry) : oh
    }
    return { entry }
  }
  return { unknown: true, outOfRange: true }
}

module.exports = { RULES, classify, cmp, ORDER }
