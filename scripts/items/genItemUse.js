// Generates itemUse.json: per-version client-side Item.use / Item.useOn classification.
// Source: decompiled vanilla client (git branches origin/client<ver>, read-only via `git show`).
// Item -> class mapping is parsed from Items.java (Item.java for 1.8.9 / 1.13.2); the per-class
// result semantics are hand-curated from the use()/useOn() bodies (the method bodies across versions).
// Usage: node scripts/items/genItemUse.js && node scripts/items/compactItemUse.js
// EXTRACTED_MINECRAFT_DATA: the extracted_minecraft_data checkout; MINECRAFT_DATA_DIR: a minecraft-data that knows every
// version (the published one lacks 26.2+)
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const mcDataFn = require(process.env.MINECRAFT_DATA_DIR || 'minecraft-data')

const R = process.env.EXTRACTED_MINECRAFT_DATA || 'D:/projects/mc-zuri/mc-data/extracted_minecraft_data'
const OUT = path.join(__dirname, 'itemUse.json')
const VERSIONS = ['1.8.9', '1.13.2', '1.14.4', '1.16.4', '1.18.1', '1.19', '1.19.3', '1.19.4', '1.20', '1.20.1', '1.20.2', '1.20.3', '1.20.4', '1.20.5', '1.20.6', '1.21', '1.21.1', '1.21.2', '1.21.3', '1.21.4', '1.21.5', '1.21.6', '1.21.7', '1.21.8', '1.21.9', '1.21.10', '1.21.11', '26.1', '26.2', '26.3']
const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']

const vnum = (v) => { const p = v.split('.').map(Number); while (p.length < 3) p.push(0); return p }
const cmp = (a, b) => { const x = vnum(a); const y = vnum(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0 }
const ge = (v, b) => cmp(v, b) >= 0
const lt = (v, b) => cmp(v, b) < 0

const show = (v, p) => {
  try { return execFileSync('git', ['-C', R, 'show', `origin/client${v}:${p}`], { encoding: 'utf8', maxBuffer: 1 << 27, stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return null }
}

// Old MCP class names -> modern Mojang names (only those that matter for use/useOn)
const MCP = {
  ItemBow: 'BowItem', ItemSword: 'SwordItem', ItemFood: 'FoodItem', ItemSeedFood: 'FoodBlockItem', ItemSoup: 'FoodItem', ItemAppleGold: 'FoodItem', ItemFishFood: 'FoodItem', ItemChorusFruit: 'FoodItem',
  ItemBucketMilk: 'MilkBucketItem', ItemPotion: 'PotionItem', ItemSplashPotion: 'SplashPotionItem', ItemLingeringPotion: 'LingeringPotionItem',
  ItemMonsterPlacer: 'SpawnEggItem', ItemSpawnEgg: 'SpawnEggItem', ItemEnderPearl: 'EnderpearlItem', ItemExpBottle: 'ExperienceBottleItem',
  ItemEditableBook: 'WrittenBookItem', ItemWrittenBook: 'WrittenBookItem', ItemWritableBook: 'WritableBookItem', ItemGlassBottle: 'BottleItem', ItemLilyPad: 'PlaceOnWaterBlockItem',
  ItemCarrotOnAStick: 'FoodOnAStickItem', ItemArmor: 'ArmorItem', ItemElytra: 'ElytraItem', ItemFirework: 'FireworkRocketItem', ItemFireworkRocket: 'FireworkRocketItem',
  ItemFireball: 'FireChargeItem', ItemFireCharge: 'FireChargeItem', ItemHangingEntity: 'HangingEntityItem', ItemArmorStand: 'ArmorStandItem', ItemMinecart: 'MinecartItem', ItemLead: 'LeadItem',
  ItemRecord: 'RecordItem', ItemDye: 'DyeItem', ItemBoneMeal: 'BoneMealItem', ItemSpade: 'ShovelItem', ItemHoe: 'HoeItem', ItemAxe: 'AxeItem', ItemFlintAndSteel: 'FlintAndSteelItem',
  ItemEnderEye: 'EnderEyeItem', ItemEndCrystal: 'EndCrystalItem', ItemMap: 'MapItem', ItemEmptyMap: 'EmptyMapItem', ItemKnowledgeBook: 'KnowledgeBookItem', ItemShield: 'ShieldItem',
  ItemTrident: 'TridentItem', ItemSnowball: 'SnowballItem', ItemEgg: 'EggItem', ItemFishingRod: 'FishingRodItem', ItemBoat: 'BoatItem', ItemBucket: 'BucketItem', ItemBucketFish: 'BucketItem',
  ItemDebugStick: 'DebugStickItem', ItemCocoa: 'BlockItem', ItemSeeds: 'BlockItem', ItemReed: 'BlockItem', ItemRedstone: 'BlockItem', ItemBlock: 'BlockItem', ItemSlab: 'BlockItem', ItemDoor: 'BlockItem',
  ItemBed: 'BlockItem', ItemSign: 'BlockItem', ItemSkull: 'BlockItem', ItemBanner: 'BlockItem', ItemSnow: 'BlockItem', ItemBlockSpecial: 'BlockItem', ItemCompass: 'CompassItem', ItemShears: 'ShearsItem',
  ItemNameTag: 'Item', ItemArmorDyeable: 'ArmorItem', ItemItemFrame: 'HangingEntityItem', ItemGMOnly: 'GameMasterBlockItem', ItemString: 'BlockItem', ItemAppleGoldEnchanted: 'FoodItem', ItemMultiTexture: 'BlockItem', ItemCloth: 'BlockItem', ItemColored: 'BlockItem', ItemPiston: 'BlockItem', ItemLeaves: 'BlockItem', ItemDoublePlant: 'BlockItem', ItemAnvilBlock: 'BlockItem', ItemSaddle: 'Item', ItemTool: 'Item', ItemPickaxe: 'Item', ItemWallOrFloor: 'BlockItem', ItemBlockTall: 'BlockItem', ItemLilyPadBlock: 'PlaceOnWaterBlockItem', ItemTippedArrow: 'Item', ItemArrow: 'Item',
}

// ---------- registry parsing ----------
function parseRegistry (v) {
  const items = {}
  const add = (name, cls, stmt) => {
    if (!name) return
    const feats = new Set()
    const s = stmt
    if (/\.food\(/.test(s)) feats.add('food')
    if (/DataComponents\.CONSUMABLE/.test(s)) feats.add('consumable')
    if (/humanoidArmor\(|DataComponents\.EQUIPPABLE|\.equippable\(/.test(s) && !/setSwappable\(false\)|equippableUnswappable|llamaSwag|saddle\(\)|harness\(/.test(s)) feats.add('equippableSwappable')
    if (/equippableUnswappable|setSwappable\(false\)/.test(s)) feats.add('equippableUnswappable')
    if (/wolfArmor\(|horseArmor\(|nautilusArmor\(|llamaSwag|Equippable\.saddle|Equippable\.harness|AnimalArmorItem/.test(s)) feats.add('bodyEquippable')
    if (/BLOCKS_ATTACKS/.test(s)) feats.add('blocksAttacks')
    if (/\.spear\(|KINETIC_WEAPON/.test(s)) feats.add('kineticWeapon')
    if (/\.useCooldown\(/.test(s)) feats.add('useCooldown')
    if (/\.axe\(/.test(s)) cls = 'AxeItem'
    if (/\.hoe\(/.test(s)) cls = 'HoeItem'
    if (/\.shovel\(/.test(s)) cls = 'ShovelItem'
    items[name] = { cls, feats: [...feats] }
  }
  let src
  if (v === '1.8.9' || v === '1.13.2') {
    src = show(v, 'client/net/minecraft/item/Item.java')
    // 1.8.9: func_179217_a(id, "name", (new ItemX(...)) ; 1.13.2: func_195936_a("name", new ItemX(...))
    const re = /func_(?:179217_a|195936_a)\((?:\d+, )?"([a-z0-9_]+)", \(?new (Item\w*)\(([^\n]*)/g
    let m
    while ((m = re.exec(src))) {
      const cls = MCP[m[2]] ?? (m[2] === 'Item' ? 'Item' : m[2])
      add(m[1], cls, m[0])
    }
    // items registered through a local variable: `ItemBucket var0 = new ItemBucket(...)` / `Item var0 = (new ItemBucket(...))`
    const locals = {}
    const reL = /\b(var\d+) = \(?new (Item\w*)\(/g
    while ((m = reL.exec(src))) locals[m[1]] = m[2]
    const reV = /func_(?:179217_a|195936_a)\((?:\d+, )?"([a-z0-9_]+)", (var\d+)\)/g
    while ((m = reV.exec(src))) if (locals[m[2]]) add(m[1], MCP[locals[m[2]]] ?? locals[m[2]], m[0])
    // block items registered by SRG block field (no name literal): only the special one matters
    if (v === '1.8.9') add('waterlily', 'PlaceOnWaterBlockItem', '')
    if (v === '1.13.2') add('lily_pad', 'PlaceOnWaterBlockItem', '')
    return { items, src }
  }
  src = show(v, 'client/net/minecraft/world/item/Items.java')
  const re = /(?:public static final Item )?\b([A-Z0-9_]+) = (registerItem|registerBlock|registerSpawnEgg|ColorCollection\.register\w+)\(([\s\S]*?)\);\s*\n/g
  let m
  while ((m = re.exec(src))) {
    const [, field, fn, args] = m
    const stmt = m[0]
    let cls = null
    const cm = /new ([A-Z]\w*Item)\b/.exec(args) || /\b([A-Z]\w*Item)::new/.exec(args)
    if (cm) cls = cm[1]
    else if (fn === 'registerSpawnEgg') cls = 'SpawnEggItem'
    else if (/createBlockItemWithCustomItemName/.test(args)) cls = 'ItemNameBlockItem'
    else if (fn.startsWith('registerBlock') || fn === 'ColorCollection.registerBlockItems') cls = 'BlockItem'
    else if (/registerBlock\(/.test(args)) cls = 'BlockItem'
    else cls = 'Item'
    if (fn.startsWith('ColorCollection')) {
      const tmpl = { HARNESS: '_harness', DYED_BUNDLE: '_bundle', CUSHION: '_cushion', DYE: '_dye', BED: '_bed', BANNER: '_banner', CARPET: '_carpet', WOOL: '_wool', DYED_SHULKER_BOX: '_shulker_box', DYED_CANDLE: '_candle' }[field]
      if (tmpl) for (const c of COLORS) add(c + tmpl, cls, stmt)
      continue
    }
    const lit = /^\s*(?:\(String\))?"([a-z0-9_]+)"/.exec(args)
    let name = lit ? lit[1] : field.toLowerCase()
    add(name, cls, stmt)
  }
  return { items, src }
}

// alwaysEdible food item names (Foods.X with alwaysEat()/alwaysEdible(), mapped via Items.java .food(Foods.X))
function alwaysEdibleItems (v, itemsSrc) {
  if (v === '1.8.9') return ['golden_apple']
  if (v === '1.13.2') return ['golden_apple', 'enchanted_golden_apple', 'chorus_fruit']
  const foods = show(v, 'client/net/minecraft/world/food/Foods.java') || ''
  const always = new Set()
  for (const st of foods.split(';')) {
    const mm = /\b([A-Z0-9_]+) = /.exec(st)
    if (mm && /alwaysEat\(\)|alwaysEdible\(\)/.test(st)) always.add(mm[1])
  }
  // honey bottle pre-1.21.2 was HoneyBottleItem (always drinkable), handled by class rule
  const out = []
  const re = /\b([A-Z0-9_]+) = register\w*\(([\s\S]*?)\);\s*\n/g
  let m
  while ((m = re.exec(itemsSrc))) {
    const f = /\.food\(Foods\.([A-Z0-9_]+)/.exec(m[2])
    if (f && always.has(f[1])) {
      const lit = /^\s*(?:\(String\))?"([a-z0-9_]+)"/.exec(m[2])
      out.push(lit ? lit[1] : m[1].toLowerCase())
    }
  }
  return out.sort()
}

// ---------- curated per-class rules ----------
// use kinds: startUsing (client starts using -> RELEASE_USE_ITEM on key-up), instant (consumes, no using), conditional, pass
// result when condition false: 'fail' (not consumed -> off hand still tried) or 'pass'
function useRule (v, name, info, ctx) {
  const { cls, feats } = info
  const comp = ge(v, '1.21.2') // component driven Item.use
  // --- class-specific overrides first (they win over Item.use) ---
  switch (cls) {
    case 'BowItem': return { kind: 'conditional', cond: 'hasArrowOrInfiniteMaterials', onTrue: 'startUsing', onFalse: 'fail', duration: 72000 }
    case 'CrossbowItem': return { kind: 'conditional', cond: 'charged:instant(shoot) | hasAmmoOrCreative:startUsing', onTrue: 'startUsing', onFalse: 'fail', duration: ge(v, '1.21.5') ? 72000 : 'chargeDuration+3' }
    case 'TridentItem': return { kind: 'conditional', cond: lt(v, '1.16') ? 'notBroken && (noRiptide || inWaterOrRain)' : 'notAboutToBreak && (noRiptide || inWaterOrRain)', onTrue: 'startUsing', onFalse: 'fail', duration: 72000 }
    case 'ShieldItem': if (lt(v, '1.21.5')) return { kind: 'startUsing', cond: 'always', duration: 72000 }; break
    case 'SpyglassItem': return { kind: 'startUsing', cond: 'always', duration: 1200 }
    case 'InstrumentItem': return { kind: 'conditional', cond: 'hasInstrument', onTrue: 'startUsing', onFalse: 'fail', duration: 'instrument.useDuration', cooldown: 'instrument.useDuration' }
    case 'MilkBucketItem': case 'HoneyBottleItem': case 'OminousBottleItem':
      if (!comp) return { kind: 'startUsing', cond: 'always', duration: cls === 'HoneyBottleItem' ? 40 : 32 }
      break
    case 'PotionItem': if (!comp || v === '1.8.9') return v === '1.8.9' ? { kind: 'conditional', cond: 'splashMeta(damage&16384)?instant:startUsing', onTrue: 'startUsing', onFalse: 'instant', duration: 32 } : { kind: 'startUsing', cond: 'always', duration: 32 }; break
    case 'SplashPotionItem': case 'LingeringPotionItem': case 'SnowballItem': case 'EggItem': case 'ExperienceBottleItem': case 'FishingRodItem': case 'EmptyMapItem': case 'WritableBookItem': case 'WrittenBookItem':
      return { kind: 'instant', cond: 'always' }
    case 'EnderpearlItem': return { kind: 'instant', cond: 'always', cooldown: 20 }
    case 'WindChargeItem': return { kind: 'instant', cond: 'always', cooldown: 10, cooldownClientSide: ge(v, '1.21.2') }
    case 'EnderEyeItem':
      if (lt(v, '1.13')) return { kind: 'conditional', cond: 'notLookingAtEndPortalFrame(raycast fluid NONE)', onTrue: 'instant', onFalse: 'pass' }
      return { kind: 'conditional', cond: 'notLookingAtEndPortalFrame(raycast fluid NONE)', onTrue: 'startUsing', onFalse: 'pass', duration: 0, note: 'startUsingItem with duration 0 never completes: client stays "using" until key-up -> RELEASE_USE_ITEM (unless last eye consumed)' }
    case 'FireworkRocketItem': return { kind: 'conditional', cond: 'fallFlying', onTrue: 'instant', onFalse: 'pass' }
    case 'KnowledgeBookItem': return { kind: 'conditional', cond: 'hasRecipes', onTrue: 'instant', onFalse: 'fail' }
    case 'FoodOnAStickItem': return { kind: 'pass', cond: 'clientAlwaysPass', note: 'server boosts when riding matching saddled mob; client result PASS so off hand is tried too' }
    case 'BoatItem': return { kind: 'conditional', cond: 'raycastBlock(fluid ANY) && noEntityInPath', onTrue: 'instant', onFalse: 'pass', onNoRoom: 'fail' }
    case 'BucketItem': case 'MobBucketItem': case 'FishBucketItem':
      if (name === 'bucket') return { kind: 'conditional', cond: 'raycastFluidSource(fluid SOURCE_ONLY): pickupable', onTrue: 'instant', onFalse: 'fail', onMiss: 'pass' }
      return { kind: 'conditional', cond: 'raycastBlock(fluid NONE): canEmptyAt', onTrue: 'instant', onFalse: 'fail', onMiss: 'pass' }
    case 'BottleItem': return { kind: 'conditional', cond: 'dragonBreathCloudNearby || raycastWaterSource', onTrue: 'instant', onFalse: 'pass' }
    case 'SpawnEggItem':
      if (lt(v, '1.16')) return { kind: 'pass', cond: 'clientAlwaysPass' }
      return { kind: 'conditional', cond: ge(v, '26.2') ? 'raycastBlock(fluid SOURCE_ONLY) && entityCanSpawn' : 'raycastBlock(fluid SOURCE_ONLY)', onTrue: 'instant', onFalse: ge(v, '26.2') ? 'pass(miss)|fail(cannotSpawn)' : 'pass' }
    case 'PlaceOnWaterBlockItem': case 'WaterLilyBlockItem':
      return { kind: 'conditional', cond: 'raycastFluidSource(fluid SOURCE_ONLY) && canPlaceAbove', onTrue: 'instant', onFalse: 'fail' }
    case 'BundleItem':
      if (lt(v, '1.21.2')) return { kind: 'conditional', cond: 'bundleNotEmpty', onTrue: 'instant', onFalse: 'fail' }
      if (lt(v, '1.21.4')) return { kind: 'instant', cond: 'always', note: 'client returns CONSUME without startUsingItem (server starts using); no client RELEASE_USE_ITEM' }
      return { kind: 'startUsing', cond: 'always', duration: 200 }
    case 'SwordItem': if (v === '1.8.9') return { kind: 'startUsing', cond: 'always', duration: 72000, note: '1.8 sword blocking' }; break
    case 'ArmorItem': case 'ElytraItem':
      if (feats.includes('bodyEquippable') || /horse_armor|wolf_armor/.test(name)) return { kind: 'pass', cond: 'bodySlotNotUsableByPlayer' }
      if (lt(v, '1.21.2')) {
        if (lt(v, '1.19.4')) return { kind: 'conditional', cond: 'equipmentSlotEmpty', onTrue: 'instant', onFalse: 'fail' }
        return { kind: 'conditional', cond: 'swapDiffersAndNoBindingCurse', onTrue: 'instant', onFalse: 'fail' }
      }
      break
  }
  // --- Item.use (generic) ---
  if (!comp) {
    const isFood = ctx.foods.has(name)
    if (isFood) {
      const always = ctx.alwaysEdible.has(name)
      const creativeCan = ge(v, '1.16')
      if (always && creativeCan) return { kind: 'startUsing', cond: 'always(alwaysEdible)', duration: 'eatTicks(32|16 fast)' }
      return { kind: 'conditional', cond: always ? 'notCreative(alwaysEdible)' : (creativeCan ? 'canEat(hunger<20 || creative)' : 'canEat(hunger<20 && !creative)'), onTrue: 'startUsing', onFalse: 'fail', duration: 'eatTicks(32|16 fast)' }
    }
    return { kind: 'pass', cond: 'none' }
  }
  if (feats.includes('consumable') || feats.includes('food') || ctx.foods.has(name) || ['potion', 'milk_bucket', 'honey_bottle', 'ominous_bottle'].includes(name)) {
    const isFood = feats.includes('food') || ctx.foods.has(name)
    if (isFood && !ctx.alwaysEdible.has(name) && name !== 'honey_bottle') return { kind: 'conditional', cond: 'canEat(hunger<20 || creative)', onTrue: 'startUsing', onFalse: 'fail', duration: 'consumable.consumeSeconds*20', component: 'consumable+food' }
    return { kind: 'startUsing', cond: isFood ? 'always(alwaysEdible)' : 'always', duration: 'consumable.consumeSeconds*20', component: 'consumable' }
  }
  if (feats.includes('equippableSwappable') || cls === 'ArmorItem' || name === 'elytra' || name === 'turtle_helmet') {
    if (feats.includes('bodyEquippable')) return { kind: 'pass', cond: 'bodySlotNotUsableByPlayer', component: 'equippable' }
    return { kind: 'conditional', cond: 'swapDiffersAndNoPreventArmorChange', onTrue: 'instant', onFalse: 'fail', component: 'equippable(swappable)' }
  }
  if (cls === 'ShieldItem' || feats.includes('blocksAttacks')) return { kind: 'startUsing', cond: 'always', duration: 72000, component: 'blocks_attacks' }
  if (feats.includes('kineticWeapon')) return { kind: 'startUsing', cond: 'always', duration: 72000, component: 'kinetic_weapon' }
  return { kind: 'pass', cond: 'none' }
}

const BLOCK_ITEM_CLASSES = new Set(['BlockItem', 'ItemNameBlockItem', 'SignItem', 'HangingSignItem', 'BedItem', 'DoubleHighBlockItem', 'ScaffoldingBlockItem', 'StandingAndWallBlockItem', 'PlayerHeadItem', 'SolidBucketItem', 'GameMasterBlockItem', 'BannerItem', 'ShulkerBoxItem', 'AirItem', 'FoodBlockItem', 'WallOrFloorItem', 'SkullItem', 'TallBlockItem', 'SeedFoodItem', 'ItemNameBlockItem'])

function useOnRule (v, name, info, ctx) {
  const { cls } = info
  const o = (cond, extra = {}) => ({ cond, ...extra })
  switch (cls) {
    case 'AxeItem': if (lt(v, '1.13')) return null; return o(ge(v, '1.21') ? 'axeTransformable(strip|scrape|waxOff) && !(mainHand && offhandBlocksAttacks && !sneaking)' : (ge(v, '1.17') ? 'axeTransformable(strip|scrape|waxOff)' : 'strippable'), { onFalse: 'pass', component: ge(v, '26.3') ? 'block_transformer' : undefined })
    case 'HoeItem': return o(ge(v, '26.3') ? 'tillable && !(mainHand && offhandBlocksAttacks && !sneaking)' : 'tillable', { onFalse: 'pass', component: ge(v, '26.3') ? 'block_transformer' : undefined })
    case 'ShovelItem': if (lt(v, '1.13')) return null; return o(ge(v, '26.3') ? 'pathable(face!=DOWN, air above) && !(mainHand && offhandBlocksAttacks && !sneaking)' : (ge(v, '1.14') && !lt(v, '1.16') ? 'pathable(face!=DOWN, air above) || litCampfire' : 'pathable(face!=DOWN, air above)'), { onFalse: 'pass', component: ge(v, '26.3') ? 'block_transformer' : undefined })
    case 'FlintAndSteelItem': return o('lightableCampfireCandle || firePlaceableAtRelative', { onFalse: 'fail' })
    case 'FireChargeItem': return o('lightableCampfireCandle || firePlaceableAtRelative', { onFalse: 'fail' })
    case 'BoneMealItem': return o('bonemealable || (waterBlock && coralGrowable)', { onFalse: 'pass' })
    case 'DyeItem': return v === '1.8.9' ? o('boneMealMeta(15) && bonemealable | cocoaMeta(3) on jungle log side', { onFalse: 'pass' }) : null
    case 'SpawnEggItem': return o(ge(v, '26.2') ? 'entityCanSpawn' : 'always', { onFalse: 'fail' })
    case 'EnderEyeItem': return o('endPortalFrameWithoutEye', { onFalse: 'pass' })
    case 'FireworkRocketItem': return o(ge(v, '1.21.6') ? 'notFallFlying' : 'always', { onFalse: 'pass' })
    case 'ArmorStandItem': return o('face!=DOWN && spaceFree', { onFalse: 'fail' })
    case 'HangingEntityItem': return o('validFace && mayUseItemAt && survives (painting: has variant else CONSUME)', { onFalse: 'fail' })
    case 'MinecartItem': return o('rail', { onFalse: 'fail' })
    case 'LeadItem': return ge(v, '1.21.2') ? o('fence', { clientResult: 'pass', note: 'client returns PASS; FenceBlock itself consumes when holding lead' }) : o('fence', { onFalse: 'pass' })
    case 'EndCrystalItem': return o('obsidianOrBedrock && airAbove && noEntities', { onFalse: 'fail' })
    case 'CompassItem': return ge(v, '1.16') ? o('lodestone', { onFalse: 'pass' }) : null
    case 'MapItem': return ge(v, '1.14') ? o('banner', { onFalse: 'pass' }) : null
    case 'DebugStickItem': return o('always')
    case 'ShearsItem': return ge(v, '1.17') ? o('growingPlantHeadNotMaxAge', { onFalse: 'pass' }) : null
    case 'HoneycombItem': return o('waxable', { onFalse: 'pass' })
    case 'PotionItem': return ge(v, '1.19') ? o('waterPotion && face!=DOWN && convertibleToMud', { onFalse: 'pass' }) : null
    case 'RecordItem': return lt(v, '1.21') ? o('jukeboxWithoutRecord', { onFalse: 'pass' }) : null
    case 'WritableBookItem': case 'WrittenBookItem': return ge(v, '1.14') && lt(v, '1.20.5') ? o('lecternWithoutBook', { onFalse: 'pass' }) : null
    case 'BrushItem': return o('always', { result: 'startUsing', duration: 200 })
    case 'CushionItem': return o('face==UP && canBePlacedAt && noCushionThere', { onFalse: 'fail' })
    case 'PlaceOnWaterBlockItem': case 'WaterLilyBlockItem': return o('never', { onFalse: 'pass', note: 'placement happens in use() via fluid raycast' })
  }
  if (BLOCK_ITEM_CLASSES.has(cls) || (cls === 'Item' && ctx.blockNames.has(name))) {
    const edible = ctx.foods.has(name)
    return o(edible ? 'canPlace || (canEat -> startUsing)' : 'canPlace', { onFalse: 'fail', blockItem: true, ...(edible ? { edibleFallback: true } : {}) })
  }
  return null
}

// classes the rules know about; anything else is resolved through its `extends` chain
const KNOWN = new Set(['Item', 'BowItem', 'CrossbowItem', 'TridentItem', 'ShieldItem', 'SpyglassItem', 'InstrumentItem', 'MilkBucketItem', 'HoneyBottleItem', 'OminousBottleItem', 'PotionItem',
  'SplashPotionItem', 'LingeringPotionItem', 'SnowballItem', 'EggItem', 'ExperienceBottleItem', 'FishingRodItem', 'EmptyMapItem', 'WritableBookItem', 'WrittenBookItem', 'EnderpearlItem', 'WindChargeItem',
  'EnderEyeItem', 'FireworkRocketItem', 'KnowledgeBookItem', 'FoodOnAStickItem', 'BoatItem', 'BucketItem', 'BottleItem', 'SpawnEggItem', 'PlaceOnWaterBlockItem', 'WaterLilyBlockItem', 'BundleItem',
  'SwordItem', 'ArmorItem', 'ElytraItem', 'AxeItem', 'HoeItem', 'ShovelItem', 'FlintAndSteelItem', 'FireChargeItem', 'BoneMealItem', 'ArmorStandItem', 'HangingEntityItem', 'MinecartItem', 'LeadItem',
  'EndCrystalItem', 'CompassItem', 'MapItem', 'DebugStickItem', 'ShearsItem', 'HoneycombItem', 'RecordItem', 'BrushItem', 'CushionItem', ...BLOCK_ITEM_CLASSES])
const resolveCache = new Map()
const ALIAS = { CarrotOnAStickItem: 'FoodOnAStickItem' }
function resolveClass (v, cls) {
  if (ALIAS[cls]) return ALIAS[cls]
  if (v === '1.8.9' || v === '1.13.2' || KNOWN.has(cls)) return cls
  const key = v + ':' + cls
  if (resolveCache.has(key)) return resolveCache.get(key)
  let cur = cls; let out = 'Item'
  for (let i = 0; i < 8; i++) {
    if (KNOWN.has(cur)) { out = cur; break }
    const src = show(v, `client/net/minecraft/world/item/${cur}.java`)
    const m = src && /\bclass \w+(?:<[^>]*>)? extends (\w+)/.exec(src)
    if (!m) { out = BLOCK_ITEM_CLASSES.has(cur) ? 'BlockItem' : 'Item'; break }
    cur = m[1]
  }
  resolveCache.set(key, out)
  return out
}
// minecraft-data item lists that are stale for some versions -> validate against the protocol-identical sibling
const MD_ALIAS = { '1.21.2': '1.21.3', '1.21.7': '1.21.8' }

// ---------- main ----------
const result = {}
const report = { unknownNames: {}, foodMismatch: {} }
for (const v of VERSIONS) {
  const md = mcDataFn(MD_ALIAS[v] ?? v)
  const { items, src } = parseRegistry(v)
  for (const i of Object.values(items)) { i.rawCls = i.cls; i.cls = resolveClass(v, i.cls) }
  const valid = md.itemsByName
  const blockNames = new Set(Object.keys(md.blocksByName))
  const foods = new Set()
  // registry-derived foods
  for (const [n, i] of Object.entries(items)) if (i.feats.includes('food')) foods.add(n)
  // old versions: FoodItem classes are food
  for (const [n, i] of Object.entries(items)) if (i.cls === 'FoodItem' || i.cls === 'FoodBlockItem') foods.add(n)
  const mdFoods = Object.keys(md.foodsByName || {})
  report.foodMismatch[v] = { onlyInMinecraftData: mdFoods.filter((n) => !foods.has(n)), onlyInSource: [...foods].filter((n) => !md.foodsByName?.[n] && md.itemsByName[n]) }
  const alwaysEdible = new Set(alwaysEdibleItems(v, src || ''))
  const ctx = { foods, alwaysEdible, blockNames }
  report.unknownNames[v] = Object.keys(items).filter((n) => !valid[n])
  const use = {}; const useOn = {}
  for (const name of Object.keys(valid).sort()) {
    let info = items[name]
    if (!info) info = { cls: blockNames.has(name) ? 'BlockItem' : 'Item', feats: [] }
    if (info.cls === 'FoodBlockItem') info = { ...info, cls: 'BlockItem' }
    const u = useRule(v, name, info, ctx)
    if (u && u.kind !== 'pass') use[name] = Object.fromEntries(Object.entries(u).filter(([, x]) => x !== undefined))
    else if (u && u.kind === 'pass' && u.cond !== 'none') use[name] = u
    const uo = useOnRule(v, name, info, ctx)
    if (uo && !uo.blockItem) useOn[name] = Object.fromEntries(Object.entries(uo).filter(([, x]) => x !== undefined))
    else if (uo && uo.blockItem && uo.edibleFallback) useOn[name] = { cond: uo.cond, onFalse: uo.onFalse, blockItem: true }
  }
  // block items summarized: every other BlockItem -> canPlace, FAIL otherwise
  const blockItems = Object.keys(valid).filter((n) => { const i = items[n] || { cls: blockNames.has(n) ? 'BlockItem' : 'Item' }; return BLOCK_ITEM_CLASSES.has(i.cls) || (i.cls === 'Item' && blockNames.has(n)) })
  // items that can put the client into "using" state (=> RELEASE_USE_ITEM player_action on key-up while still using)
  const usingItems = {}
  for (const [n, r] of Object.entries(use)) if (r.kind === 'startUsing' || r.onTrue === 'startUsing' || (n === 'crossbow')) usingItems[n] = r.duration ?? '?'
  for (const [n, r] of Object.entries(useOn)) {
    if (r.result === 'startUsing') usingItems[n] = r.duration
    if (r.blockItem && foods.has(n)) usingItems[n] = 'eatTicks (via useOn fallback or use)'
  }
  const cooldowns = {}
  const has = (n) => !!valid[n]
  if (has('ender_pearl')) cooldowns.ender_pearl = ge(v, '1.21.2') ? 'use_cooldown 1.0s (20t), applied client+server on use' : '20t, set in use() on both sides'
  if (has('chorus_fruit')) cooldowns.chorus_fruit = ge(v, '1.21.2') ? 'use_cooldown 1.0s, applied when eating finishes' : '20t, server on finishUsingItem (synced via cooldown packet)'
  if (has('goat_horn')) cooldowns.goat_horn = ge(v, '26.3') ? 'instrument useDuration (only if > 0), set in use() both sides' : 'instrument useDuration (7s for vanilla horns), set in use() both sides'
  if (has('wind_charge')) cooldowns.wind_charge = ge(v, '1.21.2') ? 'use_cooldown 0.5s (10t), client+server' : '10t, server only (client learns via cooldown packet)'
  if (has('shield')) cooldowns.shield = ge(v, '1.21.5') ? 'disabled by axe/mace hits (blocks_attacks.disable_cooldown_scale, default 100t), server-sent' : 'disabled 100t by axe hits, server-sent'
  result[v] = {
    use,
    useOn,
    blockItemDefault: { cond: 'canPlace', onFalse: 'fail', count: blockItems.length, note: 'all BlockItem subclasses not listed in useOn: SUCCESS when placed, FAIL otherwise (FAIL stops startUseItem: no use_item, no off hand)' },
    alwaysEdible: [...alwaysEdible].filter((n) => valid[n]),
    creativeCanAlwaysEat: ge(v, '1.16'),
    usingItems,
    cooldowns,
  }
}

// dedupe identical consecutive versions
const out = {
  _meta: {
    source: 'decompiled vanilla client, origin/client<ver> branches of extracted_minecraft_data (origin/client1.16.4 is actually snapshot 20w45a)',
    generator: 'gen.js (item->class parsed from Items.java; class semantics hand-curated)',
    kinds: {
      startUsing: 'client result consumes AND client calls startUsingItem (getUseDuration>0 or ender eye 0) -> later RELEASE_USE_ITEM on key-up if still using; stops hand loop',
      instant: 'client result consumes (SUCCESS/CONSUME), no using state; stops hand loop',
      conditional: 'onTrue when cond holds, else onFalse (fail/pass). FAIL from use() does NOT stop the hand loop (off hand still tried); FAIL from useOn DOES stop it',
      pass: 'not consumed; use_item packet still sent for every non-empty hand stack, then next hand is tried',
    },
    packetFlow: [
      'for hand in [MAIN, OFF]: (stack disabled feature -> return)',
      'BLOCK hit: send use_item_on(hand) ALWAYS (even empty hand); result = block interaction (skipped if sneaking with any item in either hand) then item.useOn (skipped if stack empty or on cooldown)',
      '  Success -> return; Fail -> return (no use_item, no off hand); Pass -> continue',
      'if stack non-empty: send use_item(hand) (1.17-1.20.6: preceded by move_player_pos_rot; 1.21+: yaw/pitch inside packet); cooldown -> PASS; result Success -> return',
      'MISS: only the use_item step per hand; ENTITY: interact packets then use_item step',
      'spectator: use_item not sent (PASS), use_item_on sent and returns success',
    ],
    components_1_21_2: 'Item.use order: consumable -> startConsuming (FAIL if food && !canEat; startUsing if consume_seconds>0 else instant) ; equippable.swappable -> swap (PASS if slot not usable by player e.g. body/saddle, FAIL if same item or prevent_armor_change) ; blocks_attacks (1.21.5+) -> startUsing ; kinetic_weapon (1.21.11+) -> startUsing ; else PASS. getUseDuration: consumable.consume_seconds*20, 72000 for blocks_attacks/kinetic_weapon. use_cooldown applied on instant success / on finish. 26.3: useOn also data-driven via block_transformer (axe/hoe/shovel)',
  },
}
let prevKey = null; let prevV = null
for (const v of VERSIONS) {
  const key = JSON.stringify(result[v])
  if (key === prevKey) out[v] = `=${prevV}`
  else { out[v] = result[v]; prevV = v; prevKey = key }
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 1))
fs.writeFileSync(path.join(__dirname, 'gen_report.json'), JSON.stringify(report, null, 1))
console.log('wrote', OUT)
for (const v of VERSIONS) console.log(v, typeof out[v] === 'string' ? out[v] : `use=${Object.keys(out[v].use).length} useOn=${Object.keys(out[v].useOn).length} unknown=${report.unknownNames[v].length}`)
