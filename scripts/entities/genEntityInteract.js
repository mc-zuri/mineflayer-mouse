// Generates entityInteract.json: client-side InteractionResult prediction table for
// right-clicking an entity (Minecraft.startUseItem -> gameMode.interact[At] -> Player.interactOn).
// Sources: decompiled vanilla client (mojmap) 1.14.4, 1.15.2*, 1.16.5*, 20w45a, 1.18.1 .. 26.3, plus
// yarn-mapped 1.8.9/1.9.4/1.10.2/1.11.2/1.12.2/1.13.2. (*decompiled locally from the gradle-cached mojmap jars)
// Run: node generate.js  -> writes entityInteract.json next to this file.
const fs = require('fs');
const path = require('path');

// ---------- entity groups (latest vanilla names; legacy aliases included where the name changed) ----------
const BOATS = ['oak_boat', 'spruce_boat', 'birch_boat', 'jungle_boat', 'acacia_boat', 'cherry_boat', 'dark_oak_boat', 'pale_oak_boat', 'mangrove_boat', 'bamboo_raft', 'boat'];
const CHEST_BOATS = ['oak_chest_boat', 'spruce_chest_boat', 'birch_chest_boat', 'jungle_chest_boat', 'acacia_chest_boat', 'cherry_chest_boat', 'dark_oak_chest_boat', 'pale_oak_chest_boat', 'mangrove_chest_boat', 'bamboo_chest_raft', 'chest_boat'];
const HORSES_STD = ['horse', 'donkey', 'mule', 'llama', 'trader_llama'];
const CHESTED = ['donkey', 'mule', 'llama', 'trader_llama'];
const UNDEAD_HORSES = ['skeleton_horse', 'zombie_horse'];
const FISH = ['cod', 'salmon', 'pufferfish', 'tropical_fish'];

const entityGroups = {
  livingNonMob: { members: ['armor_stand', 'player', 'mannequin'], note: 'LivingEntity but not Mob. Everything else that is a LivingEntity is a Mob.' },
  living: { predicate: 'entity is a LivingEntity: every Mob plus @livingNonMob. With minecraft-data: entity.type in [mob, hostile, passive, animal, water_creature, ambient, player, living] (armor_stand/mannequin are "living"/"other" depending on data version -> also accept @livingNonMob by name).' },
  mob: { predicate: '@living and not @livingNonMob' },
  boat: { members: BOATS, note: 'Boat / AbstractBoat (Leashable since 1.21). Pre-1.21.2 all boats were entity "boat" (variant in metadata).' },
  chest_boat: { members: CHEST_BOATS, note: 'ChestBoat / AbstractChestBoat (1.19+). Pre-1.21.2 entity "chest_boat".' },
  horses: { members: HORSES_STD },
  chested_horses: { members: CHESTED },
  undead_horses: { members: UNDEAD_HORSES },
  camels: { members: ['camel', 'camel_husk'] },
  fish: { members: FISH, note: 'AbstractFish bucketable (tadpole handled separately)' },
  nautili: { members: ['nautilus', 'zombie_nautilus'] },
  ageable: {
    members: ['allay?', 'armadillo', 'axolotl', 'bee', 'camel', 'camel_husk', 'cat', 'chicken', 'cow', 'donkey', 'fox', 'frog', 'goat', 'happy_ghast', 'hoglin', 'horse', 'llama', 'mooshroom', 'mule', 'nautilus', 'ocelot', 'panda', 'parrot', 'pig', 'polar_bear', 'rabbit', 'sheep', 'skeleton_horse', 'sniffer', 'strider', 'trader_llama', 'turtle', 'wolf', 'zombie_horse', 'zombie_nautilus', 'villager', 'wandering_trader', 'dolphin', 'squid', 'glow_squid'].filter(x => !x.endsWith('?')),
    note: 'AgeableMob (golden dandelion age-lock 26.1+, legacy spawn-egg offspring <1.16). dolphin/squid/glow_squid are AgeableMob only since 1.21.2 (AgeableWaterCreature); villager/wandering_trader are AgeableMob but not Animal.',
  },
  animal: {
    members: ['armadillo', 'axolotl', 'bee', 'camel', 'camel_husk', 'cat', 'chicken', 'cow', 'donkey', 'fox', 'frog', 'goat', 'happy_ghast', 'hoglin', 'horse', 'llama', 'mooshroom', 'mule', 'nautilus', 'ocelot', 'panda', 'parrot', 'pig', 'polar_bear', 'rabbit', 'sheep', 'skeleton_horse', 'sniffer', 'strider', 'trader_llama', 'turtle', 'wolf', 'zombie_horse', 'zombie_nautilus'],
    note: 'Animal subclasses; Animal.mobInteract breeding-food fallback (item #food:self). parrot/polar_bear have isFood()==false.',
  },
  leashable: {
    members: ['allay', 'armadillo', 'axolotl', 'bee', 'camel', 'camel_husk', 'cat', 'chicken', 'copper_golem', 'cow', 'dolphin', 'donkey', 'fox', 'frog', 'glow_squid', 'goat', 'happy_ghast', 'hoglin', 'horse', 'iron_golem', 'llama', 'mooshroom', 'mule', 'nautilus', 'ocelot', 'parrot', 'pig', 'polar_bear', 'rabbit', 'sheep', 'skeleton_horse', 'sniffer', 'snow_golem', 'squid', 'strider', 'trader_llama', 'wolf', 'zoglin', 'zombie_horse', 'zombie_nautilus', 'sulfur_cube'],
    note: 'Mob.canBeLeashed() true: non-Enemy mobs + overrides (hoglin, zoglin, axolotl, dolphin, squid true; bat/AmbientCreature, fish/WaterAnimal, tadpole, villager, wandering_trader, panda, turtle false). Only consulted <1.21.6 (from 1.21.6 the client no longer checks leashability). Extra runtime conditions: wolf requires !angry; skeleton_horse/zombie_horse NOT leashable <1.17 (removed between 1.14.4 and 20w45a, exact version unverified, 1.16.5 confirmed leashable via Mob default); sulfur_cube requires hasBodyItem; nautilus requires !aggravated.',
  },
};

// ---------- item groups ----------
const MEAT = ['beef', 'cooked_beef', 'porkchop', 'cooked_porkchop', 'chicken', 'cooked_chicken', 'mutton', 'cooked_mutton', 'rabbit', 'cooked_rabbit', 'rotten_flesh'];
const FISHES = ['cod', 'cooked_cod', 'salmon', 'cooked_salmon', 'pufferfish', 'tropical_fish'];
const SEEDS = ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds', 'torchflower_seeds', 'pitcher_pod'];
const FLOWERS = ['dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'wither_rose', 'torchflower', 'open_eyeblossom', 'closed_eyeblossom', 'sunflower', 'lilac', 'rose_bush', 'peony', 'pitcher_plant', 'pink_petals', 'wildflowers', 'cactus_flower', 'flowering_azalea', 'flowering_azalea_leaves', 'mangrove_propagule', 'cherry_leaves', 'chorus_flower', 'spore_blossom', 'golden_dandelion'];
const itemGroups = {
  spawn_egg: { suffix: '_spawn_egg', items: ['spawn_egg'], note: '"spawn_egg" is the pre-1.13 item name (entity in NBT).' },
  dye: { suffix: '_dye', items: ['dye'], note: '"dye" is the pre-1.13 item (color via damage). DyeItem.' },
  horse_armor: { suffix: '_horse_armor' },
  wool_carpet: { suffix: '_carpet', exclude: ['moss_carpet', 'pale_moss_carpet'] },
  harness: { suffix: '_harness', note: '1.21.6+' },
  nautilus_armor: { suffix: '_nautilus_armor', note: '1.21.11+' },
  axe: { suffix: '_axe' },
  fishes: { items: FISHES, note: 'tag minecraft:fishes (dolphin)' },
  creeper_igniter: { items: ['flint_and_steel', { name: 'fire_charge', versions: '>=1.19.4' }] },
  small_flower: { items: FLOWERS.slice(0, 13), note: 'approx tag minecraft:small_flowers; 1.21.4+ any item with suspicious-stew effects' },
  bee_effect_flower: { items: [{ name: 'wither_rose', versions: '>=1.21.4' }, { name: 'open_eyeblossom', versions: '>=1.21.4' }, { name: 'closed_eyeblossom', versions: '>=1.21.4' }], note: 'FlowerBlock.getBeeInteractionEffect() != null (Bee.mobInteract 1.21.4+)' },
  'food:cow': { items: ['wheat'] }, 'food:mooshroom': { items: ['wheat'] }, 'food:sheep': { items: ['wheat'] }, 'food:goat': { items: ['wheat'] },
  'food:pig': { items: ['carrot', 'potato', 'beetroot'] },
  'food:chicken': { items: SEEDS, note: 'pre-1.20: wheat/melon/pumpkin/beetroot seeds (+torchflower_seeds/pitcher_pod 1.20+)' },
  'food:rabbit': { items: ['carrot', 'golden_carrot', 'dandelion'] },
  'food:wolf': { items: [...MEAT, ...FISHES.filter(x => x !== 'cooked_cod' || true), 'rabbit_stew'], note: '<1.20.5: any edible item with isMeat() (meat + rotten_flesh, no fish/stew)' },
  'food:cat': { items: ['cod', 'salmon'], note: '<1.13: "fish" (raw)' }, 'food:ocelot': { items: ['cod', 'salmon'], note: '<1.13: "fish"' },
  'food:horse': { items: ['wheat', 'sugar', 'hay_block', 'apple', { name: 'carrot', versions: '>=1.21.6' }, 'golden_carrot', 'golden_apple', 'enchanted_golden_apple'] },
  'food:donkey': { alias: 'food:horse' }, 'food:mule': { alias: 'food:horse' }, 'food:skeleton_horse': { alias: 'food:horse' },
  'food:zombie_horse': { items: [{ name: 'red_mushroom', versions: '>=1.21.11' }], note: '<1.21.11 zombie_horse used food:horse but only via Animal fallback' },
  'food:llama': { items: ['wheat', 'hay_block'] }, 'food:trader_llama': { alias: 'food:llama' },
  'food:camel': { items: ['cactus'] }, 'food:camel_husk': { items: ['rabbit_foot'] },
  'food:turtle': { items: ['seagrass'] }, 'food:panda': { items: ['bamboo'] },
  'food:fox': { items: ['sweet_berries', { name: 'glow_berries', versions: '>=1.17' }] },
  'food:bee': { items: FLOWERS, note: 'tag minecraft:flowers (approximate list)' },
  'food:strider': { items: ['warped_fungus'] }, 'food:hoglin': { items: ['crimson_fungus'] },
  'food:axolotl': { items: ['tropical_fish_bucket'] }, 'food:frog': { items: ['slime_ball'] }, 'food:tadpole': { items: ['slime_ball'] },
  'food:sniffer': { items: ['torchflower_seeds'] }, 'food:armadillo': { items: ['spider_eye'] },
  'food:happy_ghast': { items: ['snowball'] },
  'food:nautilus': { items: [...FISHES, 'pufferfish_bucket', 'cod_bucket', 'salmon_bucket', 'tropical_fish_bucket'], note: 'Untamed ADULT nautilus: isFood == taming items only (pufferfish, pufferfish_bucket); baby or tamed: this list' },
  'food:zombie_nautilus': { alias: 'food:nautilus' },
  'food:nautilus_taming': { items: ['pufferfish', 'pufferfish_bucket'] },
  'food:parrot': { items: SEEDS, note: 'parrot taming food (not Animal.isFood)' },
  'food:polar_bear': { items: [] },
};

// ---------- conditions ----------
const conditions = {
  sneaking: { default: false, desc: 'player.isShiftKeyDown() (isSecondaryUseActive)' },
  mainHand: { default: true, desc: 'evaluated hand is MAIN_HAND' },
  creative: { default: false, desc: 'gameMode == creative (abilities.instabuild)' },
  canUseGameMasterBlocks: { default: false, desc: 'creative && permission level >= 2 (op)' },
  baby: { default: false, desc: 'entity isBaby (metadata baby flag; armor_stand: small)' },
  tamed: { default: false, desc: 'TamableAnimal tame flag / AbstractHorse tamed flag (camel is always tamed)' },
  ownedByPlayer: { default: false, desc: 'tamed and owner UUID == bot UUID (unknown -> false)' },
  angry: { default: false, desc: 'wolf angry / anger time > 0' },
  saddled: { default: false, desc: 'has saddle (pig/strider flag; horse/camel/nautilus saddle slot)' },
  wearingBodyArmor: { default: false, desc: 'BODY slot occupied (horse armor, llama carpet, wolf armor, happy-ghast harness, nautilus armor)' },
  hasShearableEquipment: { default: 'saddled || wearingBodyArmor', desc: '1.21.6+: any equipped item whose Equippable has canBeSheared (saddle, harness, horse/wolf/nautilus armor, llama carpet)' },
  hasChest: { default: false, desc: 'chested horse has chest' },
  sheared: { default: false, desc: 'sheep sheared / bogged sheared' },
  hasPumpkin: { default: true, desc: 'snow golem wears pumpkin' },
  vehicle: { default: false, desc: 'entity has passengers (isVehicle)' },
  boatHasRoom: { default: true, desc: 'boat/camel canAddPassenger: passengers < max (boat 2, raft 2; chest boat 1) and not underwater' },
  outOfControl: { default: false, desc: 'boat outOfControlTicks >= 60 (submerged/upside-down)' },
  leashedToPlayer: { default: false, desc: 'leash holder is the bot' },
  leashedToAnyPlayer: { default: false, desc: 'leash holder is any Player (incl. the bot)' },
  leashed: { default: false, desc: 'entity is leashed to anything' },
  hasLeashedEntities: { default: false, desc: 'some other entity is leashed to this entity' },
  leashableNow: { default: '(entity in @leashable) && !leashed', desc: 'pre-1.21.6 client lead check (Mob.canBeLeashed && !isLeashed); also apply @leashable notes (wolf !angry, legacy undead horses)' },
  itemHasCustomName: { default: false, desc: 'held stack has a custom name (name_tag usable)' },
  dyeColorDiffers: { default: true, desc: 'held dye color != sheep wool color / collar color' },
  needsHealing: { default: false, desc: 'entity health < max health' },
  frameHasItem: { default: false, desc: 'item frame holds an item' },
  frameFixed: { default: false, desc: 'item frame "Fixed" (invisible-fixed) flag' },
  armorStandMarker: { default: false, desc: 'armor stand marker flag' },
  interactionResponse: { default: false, desc: 'Interaction entity "response" flag' },
  trusting: { default: false, desc: 'ocelot trusting' },
  withinDistance3: { default: true, desc: 'player within 3 blocks (distanceToSqr < 9) of ocelot' },
  scared: { default: false, desc: 'armadillo rolled up / panda scared' },
  onBack: { default: false, desc: 'panda lying on back' },
  allayDancing: { default: false, desc: 'allay dancing AND can duplicate' },
  mobHoldsItem: { default: false, desc: 'entity main-hand equipment not empty (allay, copper golem)' },
  hasWeakness: { default: false, desc: 'zombie villager has Weakness (client usually cannot know -> false)' },
  admiring: { default: false, desc: 'piglin arm pose ADMIRING_ITEM' },
  sleeping: { default: false, desc: 'villager sleeping' },
  trading: { default: false, desc: 'villager/trader currently has a trading player' },
  hasTradesProfession: { default: true, desc: 'legacy (<1.16) client-generated offers non-empty: profession not none/nitwit' },
  flying: { default: false, desc: 'parrot flying' },
  brownMooshroom: { default: false, desc: 'mooshroom variant brown' },
  antennaPoppy: { default: false, desc: 'copper golem antenna slot holds a poppy (shearable)' },
  ageLocked: { default: false, desc: '26.1+ age-locked baby (golden dandelion)' },
  holdingGoldenDandelion: { default: false, desc: 'player holds golden_dandelion in either hand (26.1+)' },
  breedCooldown: { default: false, desc: '1.8.x only: adult animal on breeding cooldown (client age byte != 0)' },
  spawnEggMatchesEntity: { default: 'item == entity + "_spawn_egg"', desc: '1.13-1.15: SpawnEggItem.spawnsEntity(type)' },
};

// ---------- rule helpers ----------
const rules = [];
let seq = 0;
function R(entities, item, when, versions, result, note, extra = {}) {
  const r = { id: `r${++seq}`, entities: Array.isArray(entities) ? entities : [entities], item };
  if (when && when.length) r.when = when;
  if (versions) r.versions = versions;
  r.result = result;
  if (note) r.note = note;
  Object.assign(r, extra);
  rules.push(r);
  return r;
}
// result shorthand: versioned map (first matching range wins)
const S = 'success', C = 'consume', P = 'pass', F = 'fail';
const OLD = '<1.15'; // boolean era: true -> consume (never swings)
const V115 = '>=1.15 <1.16'; // boolean entity code, but true -> InteractionResult.SUCCESS -> swing
const MOD = '>=1.16';
const boolTrue = { '<1.15': C, '>=1.15': S }; // legacy true -> consume; 1.15 true -> success(swing)

// ======================= PHASE: entity (Entity.interactAt/interact, Mob.interact) =======================

// ---- non-mob entities ----
R('armor_stand', 'any', ['armorStandMarker'], null, P, 'interactAt PASS; then item phase (name tag) runs');
R('armor_stand', 'name_tag', null, '>=1.9', P, 'ArmorStand excludes name_tag -> item phase NameTagItem');
R('armor_stand', 'any', null, null, C, 'client: <1.15 interactAt SUCCESS but no entity swing pre-1.15; 1.15-1.21.1 CONSUME; 1.21.2+ SUCCESS_SERVER; 26.1+ merged interact SUCCESS_SERVER. (spectator would be SUCCESS but spectators get PASS earlier)');

R(['item_frame', 'glow_item_frame'], 'any', null, OLD, C, 'always true pre-1.15');
R(['item_frame', 'glow_item_frame'], 'empty', ['!frameHasItem'], '>=1.15', P);
R(['item_frame', 'glow_item_frame'], 'any', ['frameFixed'], '>=1.16', P, 'fixed frames (1.16+)');
R(['item_frame', 'glow_item_frame'], 'any', null, '>=1.15', S, 'client: (!frameHasItem && empty hand) ? PASS : SUCCESS');

R('leash_knot', 'any', null, null, boolTrue, 'client always SUCCESS (true pre-1.16)');
R('interaction', 'any', ['interactionResponse'], '>=1.19.4', S);
R('interaction', 'any', null, '>=1.19.4', C);
R('cushion', 'any', ['!sneaking', '!vehicle'], '>=26.3', C);
R('cushion', 'any', null, '>=26.3', P);

// boats
const BOAT_LEASH_NOTE = 'Entity.interact Leashable branch (boats are Leashable since 1.21)';
for (const grp of [BOATS, CHEST_BOATS]) {
  R(grp, 'shears', ['leashed|hasLeashedEntities'], '>=1.21.6', S, 'Entity.interact: shearOffAllLeashConnections');
  R(grp, 'any', ['leashedToPlayer'], '>=1.21', S, BOAT_LEASH_NOTE + ': unleash');
  R(grp, 'lead', ['!leashed'], '>=1.21 <1.21.6', S, BOAT_LEASH_NOTE + ': canHaveALeashAttachedToIt');
  R(grp, 'lead', ['!leashedToAnyPlayer'], '>=1.21.6', { '<1.21.11': S, '>=1.21.11': C }, BOAT_LEASH_NOTE + ': client no longer checks leashability; 1.21.11+ returns CONSUME on client');
}
R(BOATS, 'any', null, '<1.11', C, '1.8-1.10: always true (sneak not checked)');
R(BOATS, 'any', ['sneaking'], '>=1.11', P);
R(BOATS, 'any', null, '>=1.11 <1.15', C);
R(BOATS, 'any', null, V115, P, '1.15.x: client returns false (startRiding only server side)');
R(BOATS, 'any', ['outOfControl'], '>=1.16', P);
R(BOATS, 'any', null, '>=1.16', S);
R(CHEST_BOATS, 'any', ['sneaking'], '>=1.19', S, 'opens chest (interactWithContainerVehicle -> SUCCESS)');
R(CHEST_BOATS, 'any', ['!outOfControl'], '>=1.19', S, 'super Boat ride path -> SUCCESS');
R(CHEST_BOATS, 'any', ['boatHasRoom'], '>=1.19', P, 'canAddPassenger && !sneaking -> PASS (only reached when boat is out of control)');
R(CHEST_BOATS, 'any', null, '>=1.19', S, 'full boat -> open chest');

// minecarts
R('minecart', 'any', null, '<1.9', C, '1.8: true unless ridden by a non-player entity (then false)');
R('minecart', 'any', ['sneaking'], '>=1.9', P);
R('minecart', 'any', null, '>=1.9 <1.16', boolTrue, '1.9-1.15: true (also when already ridden)');
R('minecart', 'any', ['vehicle'], '>=1.16', P);
R('minecart', 'any', null, '>=1.16 <26.3', S);
R('minecart', 'any', null, '>=26.3', C, '26.3: client returns CONSUME (no swing)');
R(['chest_minecart', 'hopper_minecart'], 'any', null, null, boolTrue, 'open container; never PASS (no sneak check)');
R('furnace_minecart', 'any', null, null, boolTrue, 'always SUCCESS (fuel or push)');
R('command_block_minecart', 'any', null, '<1.13', P, 'returns false');
R('command_block_minecart', 'any', null, '>=1.13 <1.16', boolTrue, 'returns true unconditionally');
R('command_block_minecart', 'any', ['canUseGameMasterBlocks'], '>=1.16', S);
R('command_block_minecart', 'any', null, '>=1.16', P);
R(['tnt_minecart', 'spawner_minecart', 'end_crystal', 'painting', 'item', 'experience_orb', 'arrow', 'spectral_arrow', 'trident', 'falling_block', 'tnt', 'firework_rocket', 'eye_of_ender', 'fishing_bobber', 'lightning_bolt', 'area_effect_cloud', 'marker', 'block_display', 'item_display', 'text_display', 'ominous_item_spawner', 'wind_charge', 'breeze_wind_charge', 'ender_pearl', 'snowball', 'egg', 'potion', 'experience_bottle', 'llama_spit', 'shulker_bullet', 'small_fireball', 'fireball', 'dragon_fireball', 'wither_skull', 'evoker_fangs'],
  'any', null, null, P, 'no interact override -> Entity.interact PASS (1.21.6+ shears only matter with leash connections). Not living -> no item phase.');
R(['player', 'mannequin'], 'any', null, null, P, 'not Mob; Entity.interact PASS. Item phase: name tag never applies to player (canSerialize false / instanceof Player); mannequin gets name tag');

// ---- generic Mob prelude (Mob.interact) ----
// <1.21: leash holder check first
R('@mob', 'any', ['leashedToPlayer'], '<1.21', boolTrue, 'Mob.interact: holder == player -> dropLeash. Before everything else (<1.21)');
// legacy lead (before mobInteract; before name tag/spawn egg)
R('@mob', 'lead', ['leashableNow'], '<1.21', boolTrue, 'Mob.interact / checkAndHandleImportantInteractions: lead && canBeLeashed(player) (=!isLeashed && leashable type). 1.8: tamed mobs additionally require owner.');
// 1.16+: checkAndHandleImportantInteractions
R('@mob', '#spawn_egg', null, MOD, C, 'any SpawnEggItem on any Mob: client CONSUME (<1.21.2) / SUCCESS_SERVER (1.21.2+), regardless of egg type');
R('@mob', 'name_tag', ['itemHasCustomName'], MOD, S, 'NameTagItem.interactLivingEntity from checkAndHandleImportantInteractions');
// 1.21+: Entity.interact (Leashable) after important interactions
R('@mob', 'shears', ['leashed|hasLeashedEntities'], '>=1.21.6', S, 'Entity.interact shearOffAllLeashConnections');
R('@mob', 'shears', ['hasShearableEquipment', '!vehicle', '!sneaking', '!(entity=wolf&!ownedByPlayer)'], '>=1.21.6', S, 'Entity.interact attemptToShearEquipment (Mob.canShearEquipment: !isVehicle; wolf: isOwnedBy). Removes saddle/harness/body armor/carpet');
R('@mob', 'any', ['leashedToPlayer'], '>=1.21', S, 'Entity.interact: unleash (SUCCESS.withoutItem 1.21.4+)');
R('@mob', 'lead', ['leashableNow'], '>=1.21 <1.21.6', S, 'Entity.interact: canHaveALeashAttachedToIt');
R('@mob', 'lead', ['!leashedToAnyPlayer'], '>=1.21.6', { '<1.21.11': S, '>=1.21.11': C }, '1.21.6+: client does NOT check canBeLeashed (villagers, monsters too). 1.21.11+ client CONSUME');
// legacy spawn eggs (Ageable offspring)
R('@ageable', '#spawn_egg', null, '<1.13', C, '1.8-1.12 PassiveEntity: any "spawn_egg" item -> true on client (type checked server side)');
R('@ageable', '#spawn_egg', ['spawnEggMatchesEntity'], '>=1.13 <1.16', boolTrue, 'AgableMob.mobInteract: SpawnEggItem.spawnsEntity(type). Entities whose mobInteract runs before the AgableMob fallback (horses/cat/panda/wolf...) explicitly defer spawn eggs to it');

// ---- villagers ----
R('villager', 'name_tag', null, '<1.16', boolTrue, 'legacy Villager.mobInteract: any name tag -> interactEnemy, return true');
R('villager', 'any', ['!trading', '!sleeping'], MOD, S, 'baby (setUnhappy) or adult (trade): client always SUCCESS; offers only checked server side');
R('villager', 'any', ['baby'], '<1.16', P, 'baby: super.mobInteract -> false');
R('villager', 'any', ['!trading', '!sleeping', 'hasTradesProfession'], '<1.16', boolTrue, 'client-generated offers non-empty -> true; empty (unemployed/nitwit) -> super -> false. 1.8: no offers check (always true)');
R('villager', 'any', null, null, P);
R('wandering_trader', 'name_tag', null, '<1.16', boolTrue);
R('wandering_trader', 'any', ['!baby', '!trading'], '>=1.14 <1.16', boolTrue);
R('wandering_trader', 'any', ['!baby', '!trading'], '>=1.16 <26.3', S);
R('wandering_trader', 'any', ['!baby', '!trading'], '>=26.3', C, '26.3 client returns SUCCESS_SERVER');
R('wandering_trader', 'any', null, null, P);

// ---- golden dandelion (26.1+) for ageable babies; placed before species rules (results agree with species code paths) ----
R('@ageable', 'golden_dandelion', ['baby', '!ageLocked'], '>=26.1', S, 'AgeableMob.mobInteract age lock (cooldown 0, not in cannot_be_age_locked tag)');

// ---- wolf ----
R('wolf', 'any', ['ownedByPlayer|tamed'], '>=1.16 <1.20.5', C, 'client early-return: (owned||tame||bone&&!tame&&!angry) ? CONSUME : PASS');
R('wolf', 'bone', ['!tamed', '!angry'], '>=1.16 <1.20.5', C);
R('wolf', 'any', null, '>=1.16 <1.20.5', P);
R('wolf', '#food:wolf', ['baby'], '>=1.20.5 <1.21.2', S, '1.20.5: baby + food skips client early return -> heal/ageUp SUCCESS');
R('wolf', 'any', ['ownedByPlayer|tamed'], '>=1.20.5 <1.21.2', C);
R('wolf', 'bone', ['!tamed', '!angry'], '>=1.20.5 <1.21.2', C);
R('wolf', 'any', null, '>=1.20.5 <1.21.2', P);
// 1.21.2+: full shared logic
R('wolf', '#food:wolf', ['tamed', 'needsHealing'], '>=1.21.2', S);
R('wolf', '#dye', ['tamed', 'ownedByPlayer', 'dyeColorDiffers'], '>=1.21.2', S);
R('wolf', '#dye', ['tamed', 'ownedByPlayer'], '>=1.21.2', P, 'same collar color -> super Animal -> PASS (no sit toggle)');
R('wolf', 'wolf_armor', ['tamed', 'ownedByPlayer', '!wearingBodyArmor', '!baby'], '>=1.21.2', S);
R('wolf', 'shears', ['tamed', 'ownedByPlayer', 'wearingBodyArmor'], '>=1.21.2 <1.21.6', S, 'unequip armor (1.21.6+ handled by generic shear rule)');
R('wolf', '#food:wolf', ['baby'], '>=1.21.2', S, 'Animal: baby food -> ageUp SUCCESS');
R('wolf', '#food:wolf', null, '>=1.21.2', C, 'Animal: adult food on client -> CONSUME');
R('wolf', 'any', ['tamed', 'ownedByPlayer'], '>=1.21.2', S, 'sit toggle (SUCCESS.withoutItem)');
R('wolf', 'any', null, '>=1.21.2', P, 'untamed + bone: server-only taming -> client PASS; tamed by someone else -> PASS');
// legacy wolf (boolean)
R('wolf', 'any', ['ownedByPlayer'], V115, S, '1.15 client: isOwnedBy || bone&&!angry');
R('wolf', 'bone', ['!angry'], V115, S);
R('wolf', 'any', null, V115, P);
R('wolf', '#food:wolf', ['tamed', 'needsHealing'], OLD, C, 'meat');
R('wolf', '#dye', ['tamed', 'dyeColorDiffers'], OLD, C);
R('wolf', 'bone', ['!tamed', '!angry'], OLD, C);
R('wolf', '#food:wolf', ['baby'], OLD, C, 'Animal fallback (adult age reads 1 on client -> no breeding branch)');
R('wolf', 'any', null, OLD, P, 'owner sit toggle is server-only; client returns super -> false');

// ---- cat ----
R('cat', 'any', ['tamed', 'ownedByPlayer'], '>=1.16 <1.20.5', S, 'client early return');
R('cat', '#food:cat', ['needsHealing|!tamed'], '>=1.16 <1.20.5', S);
R('cat', 'any', null, '>=1.16 <1.20.5', P);
R('cat', '#dye', ['tamed', 'ownedByPlayer', 'dyeColorDiffers'], '>=1.20.5', S);
R('cat', '#food:cat', ['tamed', 'ownedByPlayer', 'needsHealing'], '>=1.20.5', S);
R('cat', '#food:cat', ['tamed', 'baby'], '>=1.20.5', S, 'super Animal');
R('cat', '#food:cat', ['tamed'], '>=1.20.5', C, 'super Animal adult (owned: CONSUME is consumed -> no sit toggle)');
R('cat', 'any', ['tamed', 'ownedByPlayer'], '>=1.20.5', S, 'sit toggle');
R('cat', '#food:cat', ['!tamed'], '>=1.20.5', S, 'taming attempt (server side)');
R('cat', 'any', null, '>=1.20.5', P);
R('cat', 'any', ['tamed', 'ownedByPlayer'], V115, S);
R('cat', '#food:cat', null, V115, S);
R('cat', 'any', null, V115, P);
R('cat', '#dye', ['tamed', 'ownedByPlayer', 'dyeColorDiffers'], OLD, C);
R('cat', '#food:cat', ['tamed', 'ownedByPlayer', 'needsHealing'], OLD, C);
R('cat', '#food:cat', ['!tamed'], OLD, C);
R('cat', '#food:cat', ['baby'], OLD, C);
R('cat', 'any', null, OLD, P);

// ---- parrot ----
R('parrot', '#food:parrot', ['!tamed'], null, boolTrue);
R('parrot', 'cookie', null, null, boolTrue);
R('parrot', 'any', ['tamed', 'ownedByPlayer', '!flying'], '>=1.15', S, 'sit toggle (1.15+ returns true; <1.15 server-only -> false)');
R('parrot', 'any', null, null, P);

// ---- ocelot ----
R('ocelot', '#food:ocelot', ['!trusting', 'withinDistance3'], '>=1.14', boolTrue, 'temptGoal is null on the client');
R('ocelot', '#food:ocelot', ['!tamed', 'withinDistance3'], '<1.14', C, 'pre-1.14 ocelot taming');

// ---- horses (horse, donkey, mule, llama, trader_llama) ----
R(HORSES_STD, '#food:self', ['vehicle', 'baby'], MOD, S, 'ridden -> Animal fallback');
R(HORSES_STD, '#food:self', ['vehicle'], MOD, C);
R(HORSES_STD, 'any', ['vehicle'], MOD, P);
R(HORSES_STD, 'any', ['sneaking', 'tamed', '!baby'], MOD, S, 'open inventory');
R(HORSES_STD, '#food:self', null, MOD, C, 'fedFood: client CONSUME (<1.21.2) / SUCCESS_SERVER (1.21.2+)');
R(HORSES_STD, 'nonEmpty', ['!tamed'], MOD, S, 'makeMad');
R(CHESTED, 'chest', ['tamed', '!hasChest'], MOD, S, 'equipChest');
R(HORSES_STD, 'any', ['baby'], MOD, P, 'baby -> Animal fallback (food handled above)');
R(HORSES_STD, 'any', null, MOD, S, 'saddle/body-armor equip or ride attempt (trader_llama led by a wandering trader: no ride, still SUCCESS)');
R(HORSES_STD, 'any', ['sneaking', 'tamed', '!baby'], '<1.16', boolTrue, 'legacy: open inventory');
R(HORSES_STD, 'any', ['vehicle', '!baby'], '<1.16', P);
R(HORSES_STD, 'nonEmpty', null, '<1.16', boolTrue, 'legacy: eat / interactEnemy / makeMad / chest / saddle / armor (approx: tamed baby + useless item -> false)');
R(HORSES_STD, 'empty', ['baby'], '<1.16', P);
R(HORSES_STD, 'empty', null, '<1.16', boolTrue, 'legacy ride');
// undead horses
R(UNDEAD_HORSES, 'any', ['!tamed'], '<1.21.11', P, 'SkeletonHorse/ZombieHorse(<1.21.11): untamed -> PASS');
R('skeleton_horse', 'any', ['!tamed'], '>=1.21.11', P);
R('skeleton_horse', '#food:horse', ['baby'], MOD, S, 'tamed: AbstractHorse -> baby/vehicle -> Animal fallback');
R('zombie_horse', '#food:horse', ['baby'], '>=1.16 <1.21.11', S);
R('skeleton_horse', '#food:horse', ['vehicle'], MOD, C);
R('zombie_horse', '#food:horse', ['vehicle'], '>=1.16 <1.21.11', C);
R(UNDEAD_HORSES, 'any', ['vehicle|baby'], '>=1.16 <1.21.11', P);
R(UNDEAD_HORSES, 'any', null, '>=1.16 <1.21.11', S, 'tamed: inventory (sneak) / saddle / ride');
R('skeleton_horse', 'any', ['vehicle|baby'], '>=1.21.11', P);
R('skeleton_horse', 'any', null, '>=1.21.11', S);
R('zombie_horse', 'any', ['vehicle'], '>=1.21.11', P, 'food-in-vehicle edge cases ignored');
R('zombie_horse', 'any', ['sneaking', 'tamed', '!baby'], '>=1.21.11', S);
R('zombie_horse', '#food:zombie_horse', null, '>=1.21.11', C, '1.21.11+: Horse-like logic (rideable when untamed)');
R('zombie_horse', 'nonEmpty', ['!tamed'], '>=1.21.11', S, 'makeMad');
R('zombie_horse', 'any', ['baby'], '>=1.21.11', P);
R('zombie_horse', 'any', null, '>=1.21.11', S, 'ride (untamed allowed)');
R(UNDEAD_HORSES, 'any', ['baby|vehicle'], '<1.16', P);
R(UNDEAD_HORSES, 'any', null, '<1.16', boolTrue);

// ---- camels ----
R(['camel', 'camel_husk'], 'any', ['sneaking', '!baby'], '>=1.20', S, 'open inventory (camel always tamed)');
R('camel', 'any', ['sneaking'], '>=1.19.3 <1.20', S, '1.19.3/1.19.4 experimental: no baby check');
R(['camel', 'camel_husk'], 'saddle', ['!saddled', '!baby'], '>=1.19.3', S, 'SaddleItem / Equippable');
R(['camel', 'camel_husk'], '#food:self', null, '>=1.19.3', C, 'fedFood');
R(['camel', 'camel_husk'], 'any', null, '>=1.19.3 <1.21.11', S, 'ride attempt (even if full or baby: still SUCCESS)');
R(['camel', 'camel_husk'], 'any', null, '>=1.21.11 <26.3', C, 'client CONSUME');
R(['camel', 'camel_husk'], 'any', ['boatHasRoom', '!baby'], '>=26.3', C, 'passengers < 2 -> ride, CONSUME');
R(['camel', 'camel_husk'], 'any', null, '>=26.3', F, 'FAIL (behaves like PASS for entities)');

// ---- pig / strider ----
R(['pig', 'strider'], '#food:self', ['baby'], MOD, S, 'Animal');
R(['pig', 'strider'], '#food:self', null, MOD, C, 'Animal adult');
R(['pig', 'strider'], 'any', ['saddled', '!vehicle', '!sneaking'], MOD, S, 'ride');
R(['pig', 'strider'], 'saddle', ['!saddled', '!baby'], MOD, S, 'SaddleItem / Equippable saddle (1.21.5+)');
R(['pig', 'strider'], 'any', null, MOD, P);
R('pig', '#food:pig', ['baby'], '<1.16', boolTrue, 'legacy Animal');
R('pig', 'name_tag', null, '>=1.11 <1.16', boolTrue, 'legacy Pig: any name tag -> true');
R('pig', 'any', ['saddled', '!vehicle'], '>=1.11 <1.16', boolTrue, 'legacy ride (no sneak check)');
R('pig', 'saddle', null, '>=1.11 <1.16', boolTrue, 'legacy: saddle item always true on pigs');
R('pig', 'any', null, '>=1.9 <1.16', P, '1.8-1.10: saddled ride returns false on client; saddle/name tag go through item phase');

// ---- sheep / snow golem / mooshroom / cow / goat ----
R('sheep', 'shears', null, MOD, C, 'client always CONSUME with shears (server shears)');
R('sheep', 'shears', ['!sheared', '!baby'], V115, S);
R('sheep', 'shears', null, '<1.16', P, '<1.15: shear() then return super -> false; ShearsItem has no interactEnemy');
R('snow_golem', 'shears', ['hasPumpkin'], '>=1.15', S);
R('snow_golem', 'any', null, null, P);
R('mooshroom', 'bowl', ['!baby'], '>=1.15', S);
R('mooshroom', 'bowl', ['!baby', '!creative'], OLD, C);
R('mooshroom', 'shears', ['!baby'], null, boolTrue);
R('mooshroom', '#small_flower', ['brownMooshroom'], MOD, S, 'feed flower (1.21.4+: any item with stew effects; else falls through)');
R(['cow', 'mooshroom'], 'bucket', ['!baby'], '>=1.15', S);
R(['cow', 'mooshroom'], 'bucket', ['!baby', '!creative'], OLD, C);
R('goat', 'bucket', ['!baby'], null, S);
R('bogged', 'shears', ['!sheared'], null, S);
R('bogged', 'any', null, null, P);

// ---- bucketables ----
R([...FISH, 'axolotl'], 'water_bucket', null, null, boolTrue, 'Bucketable.bucketMobPickup (26.2+: canBePickedUpWithBucket)');
R('tadpole', '#food:tadpole', ['!ageLocked'], null, S, 'feed');
R('tadpole', 'water_bucket', null, null, S);
R('tadpole', 'any', null, null, P);
R(FISH, 'any', null, null, P);
R('dolphin', '#fishes', null, null, boolTrue);

// ---- misc mobs ----
R('allay', 'amethyst_shard', ['allayDancing'], null, S, 'duplicate');
R('allay', 'nonEmpty', ['!mobHoldsItem'], null, S, 'give item');
R('allay', 'empty', ['mobHoldsItem', 'mainHand'], null, S, 'take item back (main hand only)');
R('allay', 'any', null, null, P);
R('iron_golem', 'iron_ingot', ['needsHealing'], '>=1.15', S);
R('iron_golem', 'any', null, null, P);
R('creeper', '#creeper_igniter', null, '>=1.15', S);
R('creeper', 'any', null, null, P, '<1.15 flint_and_steel: client calls player.swing() itself but returns false');
R('zombie_villager', 'golden_apple', ['hasWeakness'], '<1.15', C);
R('zombie_villager', 'golden_apple', ['hasWeakness'], '>=1.15 <1.21.2', S);
R('zombie_villager', 'golden_apple', null, '>=1.16 <1.21.2', C);
R('zombie_villager', 'golden_apple', null, '>=1.21.2', C, 'SUCCESS_SERVER / CONSUME');
R('zombie_villager', 'any', null, null, P);
R('piglin', 'gold_ingot', ['!baby', '!admiring'], '>=1.16', S);
R('piglin', 'any', null, null, P);
R('panda', 'any', ['scared'], null, P);
R('panda', 'any', ['onBack'], null, boolTrue);
R('panda', '#food:panda', ['baby'], null, boolTrue);
R('panda', 'any', null, null, P, 'adult + bamboo: client PASS');
R('armadillo', 'brush', ['!baby'], null, S);
R('armadillo', 'any', ['scared'], '>=1.21', P, 'FAIL -> Mob.interact turns it into PASS');
R('bee', '#bee_effect_flower', null, '>=1.21.4', S);
R('happy_ghast', '#harness', ['!baby', '!wearingBodyArmor'], null, S);
R('happy_ghast', 'any', ['!baby', 'wearingBodyArmor', '!sneaking'], null, S, 'ride');
R(['nautilus', 'zombie_nautilus'], 'any', ['tamed', 'sneaking', '!baby'], null, S);
R(['nautilus', 'zombie_nautilus'], '#food:nautilus_taming', ['!tamed', '!baby', 'needsHealing'], null, S, 'untamed adult: isFood == taming items; feed when hurt (taming itself is server-only)');
R(['nautilus', 'zombie_nautilus'], '#food:nautilus_taming', ['!tamed', '!baby'], null, C, 'Animal fallback adult');
R(['nautilus', 'zombie_nautilus'], 'any', ['!tamed', '!baby'], null, P);
R(['nautilus', 'zombie_nautilus'], '#food:self', ['tamed', '!baby', 'needsHealing'], null, S, 'feed');
R(['nautilus', 'zombie_nautilus'], ['saddle', '#nautilus_armor'], ['tamed', '!baby'], null, S, 'equip (assumes slot empty)');
R(['nautilus', 'zombie_nautilus'], '#food:self', ['tamed', '!baby'], null, C, 'Animal fallback adult');
R(['nautilus', 'zombie_nautilus'], 'any', ['tamed', '!baby'], null, S, 'ride');
R('copper_golem', 'empty', ['mobHoldsItem'], null, S);
R('copper_golem', 'shears', ['antennaPoppy'], null, S);
R('copper_golem', 'any', null, null, P, 'honeycomb/axe handled server side only');
R('sulfur_cube', 'any', null, '>=26.2', P, 'TODO: complex (baby slime_ball S, shears S, igniters CONSUME, bucket S); not modelled');

// ---- generic Animal breeding food fallback ----
R('@animal', '#food:self', ['baby', '!ageLocked'], '>=1.15', S, 'Animal.mobInteract: canAgeUp -> SUCCESS');
R('@animal', '#food:self', null, '>=1.16', C, 'adult (or age-locked baby) on client -> CONSUME');
R('@animal', '#food:self', ['baby'], OLD, C);
R('@animal', '#food:self', ['!breedCooldown'], '<1.9', C, '1.8: client age byte 0 for breedable adults');
R('@animal', '#food:self', null, '>=1.9 <1.16', P, 'client getAge() returns 1 for adults -> breeding branch skipped -> false');

// ---- generic fallback ----
R('@mob', 'any', null, null, P, 'Mob.mobInteract default PASS');
R('*', 'any', null, null, P, 'Entity.interact default PASS');

// ======================= PHASE: item (ItemStack.interactLivingEntity via Player.interactOn) =======================
const itemRules = [];
function I(entities, item, when, versions, result, note) {
  const r = { id: `i${itemRules.length + 1}`, entities: Array.isArray(entities) ? entities : [entities], item };
  if (when && when.length) r.when = when;
  if (versions) r.versions = versions;
  r.result = result; if (note) r.note = note;
  itemRules.push(r);
}
I('player', 'any', null, null, P, 'name tags never apply to players');
I('*', 'name_tag', ['itemHasCustomName'], null, boolTrue, 'NameTagItem (1.16+ Mobs already consumed it in the entity phase; this covers armor_stand/mannequin and legacy)');
I('sheep', '#dye', ['!sheared', 'dyeColorDiffers'], '>=1.15', S, 'DyeItem');
I('sheep', '#dye', null, OLD, C, 'legacy DyeItem returns true for any sheep');
I(['pig', 'strider'], 'saddle', ['!saddled', '!baby'], '>=1.15', S);
I('pig', 'saddle', null, OLD, C, 'legacy SaddleItem returns true for any pig');
I(['horse', 'donkey', 'mule', 'camel', 'camel_husk', 'skeleton_horse', 'zombie_horse', 'nautilus', 'zombie_nautilus'], 'saddle', ['tamed', '!baby', '!saddled'], '>=1.21.5', S, 'Equippable.equipOnTarget (only reached if the entity phase passed)');
I('happy_ghast', '#harness', ['!baby', '!wearingBodyArmor'], '>=1.21.6', S);
I('*', 'any', null, null, P);

// Fix up the one rule where I passed `when` via extra (undead horses baby food)

const out = {
  schema: 'mineflayer-mouse/entityInteract@1',
  generatedBy: 'generate.js',
  summary: 'Predicts the CLIENT-side InteractionResult of right-clicking an entity with the item in one hand. Evaluate MAIN_HAND then OFF_HAND; the first hand whose result consumes (success|consume) stops the loop; "success" additionally swings that hand (1.15+). pass/fail -> vanilla continues with useItem(hand) for that hand (when the stack is non-empty), then the next hand.',
  results: {
    success: 'consumed; client swings (enum SUCCESS / sealed Success{swingSource=CLIENT|PREDICTED}; legacy 1.15 boolean true)',
    consume: 'consumed; no client swing (CONSUME, CONSUME_PARTIAL, SUCCESS_SERVER; and every consumed result before 1.15 because the pre-1.15 entity branch never swings)',
    pass: 'not consumed -> continue (PASS)',
    fail: 'treated exactly like pass in the entity branch of startUseItem (FAIL never stops the hand loop for entities; Mob.interact also converts mobInteract FAIL to PASS)',
  },
  algorithm: [
    '0. if gameMode == spectator -> pass (MultiPlayerGameMode returns PASS for spectators; 1.8: false).',
    '1. evaluate phases.entity rules in order; the first rule whose entities/item/when/versions all match gives the result. (Covers Entity.interactAt (armor_stand, pre-26.1), Entity.interact / Mob.interact incl. checkAndHandleImportantInteractions, Leashable handling, mobInteract.)',
    '2. if that result is pass|fail AND the entity is @living AND the held stack is non-empty: evaluate phases.item rules (ItemStack.interactLivingEntity) the same way.',
    '3. otherwise pass.',
    'Before 1.9 there is no off hand: evaluate main hand only (consumed -> skip useItem).',
  ],
  matching: {
    entities: 'array of entity names (latest vanilla ids; legacy aliases boat/chest_boat included), "@group" (entityGroups), or "*" (any).',
    item: '"any" | "empty" | "nonEmpty" | item name | "#group" (itemGroups; supports suffix/exclude/alias and per-item versions) | "#food:self" (itemGroups["food:" + entityName]) | array (OR).',
    when: 'array, all must hold. Tag = conditions key; "!tag" negates; "a|b" = OR; supports & | ! and parentheses; "entity=<name>" compares the target entity name.',
    versions: 'space-separated comparators (AND): ">=1.16 <1.21.2". Absent = all versions. Compare numerically per dot segment (26.1 > 1.21.11).',
    result: 'string, or an object {range: result} evaluated in insertion order (first matching range wins; no match -> rule does not apply).',
  },
  versionEras: {
    '1.8.x': 'no off hand; Entity.interactFirst boolean; main hand only; no swing.',
    '1.9-1.14.4': 'boolean Entity/Mob.interact; Player.interactOn -> SUCCESS/PASS; startUseItem stops on == SUCCESS and never swings for entities -> report consume.',
    '1.15.x': 'still boolean entity/mob code (mojmap 1.15.2 verified), but startUseItem uses consumesAction()/shouldSwing(): true -> SUCCESS -> swing => success. ArmorStand interactAt returns CONSUME on client.',
    '1.16-1.21.1': 'InteractionResult enum with sidedSuccess(isClientSide) -> SUCCESS on client; CONSUME_PARTIAL (1.19+) and SUCCESS_NO_ITEM_USED (1.20.5+, swings) exist. 1.16.5 verified identical structure to 20w45a.',
    '1.21-1.21.1': 'Leash handling moved from Mob.interact to Entity.interact (Leashable: Mob + Boat); order became important-interactions (name tag, spawn egg) -> leash -> mobInteract.',
    '1.21.2-1.21.11': 'sealed InteractionResult: SUCCESS (swingSource CLIENT), SUCCESS_SERVER, CONSUME, PASS, FAIL, TRY_WITH_EMPTY_HAND. Client-side early returns of Wolf removed (bone on untamed wolf now PASS on client). Spawn egg -> SUCCESS_SERVER.',
    '1.21.6': 'Entity.interact: shears cut leash connections / shear equipment; lead no longer checks leashability on client (SUCCESS). happy_ghast.',
    '1.21.11': 'lead on client -> CONSUME; camel ride -> CONSUME; zombie_horse rideable/Horse-like; nautilus, camel_husk.',
    '26.1+': 'interactAt merged into interact(player, hand, location); SwingSource CLIENT renamed PREDICTED; golden dandelion age lock. 26.3: minecart & wandering trader -> CONSUME, camel FAIL when it cannot ride, cushion.',
  },
  entityGroups,
  itemGroups,
  conditions,
  phases: { entity: rules, item: itemRules },
  uncertainties: [
    '1.15.x rules are from the decompiled 1.15.2 mojmap jar for core classes (Mob, Player, Animal, Cat, Wolf, Sheep, Pig, Villager, horses, Boat, Minecart, ItemFrame, ...); entities not inspected for 1.15 inherit the 1.14 boolean logic but report success.',
    'Entity metadata that the vanilla client also does not know (owner UUID for others, inLove, offers, trading player, Weakness on zombie villagers, panda onBack, allay canDuplicate) default as listed in conditions; vanilla itself predicts with the synced subset, so defaults should mirror what the server-synced metadata says when available.',
    'Exact version of removing the undead-horse leash restriction (between 1.14.4 and 1.16.5); creeper fire_charge (1.19.4); horse carrot food (1.21.6); zombie_horse red_mushroom (1.21.11).',
    'Food item groups are taken from the 26.3 tags; older versions had slightly different sets (wolf: meat only <1.20.5; chicken seeds; fox glow_berries 1.17+).',
    'Mooshroom flower feeding, bee effect flowers, wolf armor repair, sulfur_cube and other niche branches are approximated.',
  ],
};

fs.writeFileSync(path.join(__dirname, 'entityInteract.json'), JSON.stringify(out, null, 1));
console.log('entity rules', rules.length, 'item rules', itemRules.length);
