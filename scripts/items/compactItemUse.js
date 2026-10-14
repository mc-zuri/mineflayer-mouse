// Compacts the per-version item use table (itemUse.json, made by ./genItemUse.js from the decompiled clients) into
// src/itemUseData.json: for each item, the versions from which its Item.use / Item.useOn behaviour starts, with the
// condition as a tag src/itemInteractions.ts evaluates. Items absent from a table pass (Item.use) or, for useOn,
// pass unless they are block items (placed: success, else fail).
//
// Usage: node scripts/items/compactItemUse.js [path/to/itemUse.json]
const fs = require('fs')
const path = require('path')

const input = process.argv[2] || path.join(__dirname, 'itemUse.json')
const table = JSON.parse(fs.readFileSync(input, 'utf8'))
const versions = Object.keys(table).filter(v => v !== '_meta')
const resolve = v => (typeof table[v] === 'string' ? resolve(table[v].slice(1)) : table[v])

// --- Item.use: [kind, cond] ---
// kinds: startUsing | instant | pass | fail ; conditional ones carry a tag with their onTrue / onFalse
function useTag (e) {
  if (e.kind === 'startUsing') return ['startUsing']
  if (e.kind === 'instant') return ['instant']
  if (e.kind === 'pass') return null
  const c = e.cond
  if (c.startsWith('canEat')) return [e.onTrue, 'canEat', e.onFalse]
  if (c.startsWith('notCreative')) return [e.onTrue, 'notCreative', e.onFalse]
  if (c === 'hasArrowOrInfiniteMaterials') return [e.onTrue, 'hasArrows', e.onFalse]
  if (c.startsWith('charged:')) return ['startUsing', 'crossbow', 'fail']
  if (c.startsWith('notBroken') || c.startsWith('notAboutToBreak')) return [e.onTrue, 'trident', e.onFalse]
  if (c === 'hasInstrument' || c === 'hasRecipes' || c === 'bundleNotEmpty') return [e.onTrue]
  if (c.startsWith('notLookingAtEndPortalFrame')) return [e.onTrue, 'notLookingAtEndPortalFrame', e.onFalse]
  if (c === 'fallFlying') return [e.onTrue, 'fallFlying', e.onFalse]
  if (c.startsWith('splashMeta')) return ['instant', 'splashPotion', 'startUsing']
  if (c === 'equipmentSlotEmpty') return [e.onTrue, 'equipmentSlotEmpty', e.onFalse]
  if (c.startsWith('swapDiffers')) return [e.onTrue, 'equipmentSlotDiffers', e.onFalse]
  if (c.startsWith('raycastFluidSource(fluid SOURCE_ONLY): pickupable')) return [e.onTrue, 'lookingAtFluidSource', e.onFalse, e.onMiss ?? 'pass']
  if (c.startsWith('raycastFluidSource(fluid SOURCE_ONLY) && canPlaceAbove')) return [e.onTrue, 'lookingAtWaterSource', e.onFalse]
  if (c.startsWith('raycastBlock(fluid NONE): canEmptyAt')) return [e.onTrue, 'lookingAtBlock', e.onFalse, e.onMiss ?? 'pass']
  if (c.startsWith('raycastBlock(fluid ANY)')) return [e.onTrue, 'lookingAtBlock', e.onFalse]
  if (c.startsWith('raycastBlock(fluid SOURCE_ONLY)')) return [e.onTrue, 'lookingAtBlock', e.onFalse]
  if (c.startsWith('dragonBreathCloudNearby')) return [e.onTrue, 'lookingAtWaterSource', e.onFalse]
  throw new Error(`unknown use cond ${c}`)
}

// --- Item.useOn: [cond, onFalse] ---
function useOnTag (e) {
  if (e.clientResult === 'pass') return null // the client passes (the block handles it, e.g. a lead on a fence from 1.21.2)
  const c = e.cond
  const shieldIntent = c.includes('offhandBlocksAttacks') ? '+notShieldIntent' : ''
  const tags = [
    [/^tillable/, 'tillable'], [/^axeTransformable|^strippable/, 'axeTransformable'], [/^pathable.*litCampfire/, 'pathableOrLitCampfire'],
    [/^pathable/, 'pathable'], [/^bonemealable|^boneMealMeta/, 'bonemealable'], [/^endPortalFrameWithoutEye/, 'endPortalFrameWithoutEye'],
    [/^lightableCampfireCandle/, 'fireOrLightable'], [/^rail/, 'rail'], [/^face!=DOWN && spaceFree/, 'notDownFace'],
    [/^validFace/, 'hangingFace'], [/^obsidianOrBedrock/, 'obsidianOrBedrock'], [/^fence/, 'fence'], [/^jukeboxWithoutRecord/, 'jukeboxWithoutRecord'],
    [/^lecternWithoutBook/, 'lecternWithoutBook'], [/^banner/, 'banner'], [/^lodestone/, 'lodestone'], [/^waxable/, 'waxable'],
    [/^growingPlantHead/, 'growingPlantHead'], [/^waterPotion/, 'mudConvertible'], [/^always/, 'always'], [/^never/, 'never'],
    [/^canPlace \|\| \(canEat/, 'placeOrEat'], [/^entityCanSpawn/, 'always'], [/^face==UP/, 'upFace'], [/^notFallFlying/, 'notFallFlying']
  ]
  const found = tags.find(([re]) => re.test(c))
  if (!found) throw new Error(`unknown useOn cond ${c}`)
  return [found[1] + shieldIntent, e.onFalse ?? 'pass']
}

const out = { use: {}, useOn: {}, alwaysEdible: {}, creativeCanAlwaysEat: {} }
const push = (map, name, v, value) => {
  const list = (map[name] ??= [])
  const last = list[list.length - 1]
  if (last && JSON.stringify(last.slice(1)) === JSON.stringify(value === null ? [null] : value)) return
  if (!last && value === null) return
  list.push([v, ...(value === null ? [null] : value)])
}
const allUse = new Set()
const allUseOn = new Set()
for (const v of versions) {
  const data = resolve(v)
  Object.keys(data.use).forEach(n => allUse.add(n))
  Object.keys(data.useOn).forEach(n => allUseOn.add(n))
}
for (const v of versions) {
  const data = resolve(v)
  for (const name of allUse) push(out.use, name, v, data.use[name] ? useTag(data.use[name]) : null)
  for (const name of allUseOn) push(out.useOn, name, v, data.useOn[name] ? useOnTag(data.useOn[name]) : null)
  out.alwaysEdible[v] = data.alwaysEdible
  out.creativeCanAlwaysEat[v] = data.creativeCanAlwaysEat
}
// dedupe the per-version lists
const dedupe = (obj) => {
  const res = {}
  let prev = null
  for (const [v, value] of Object.entries(obj)) {
    const s = JSON.stringify(value)
    if (s !== prev) res[v] = value
    prev = s
  }
  return res
}
out.alwaysEdible = dedupe(out.alwaysEdible)
out.creativeCanAlwaysEat = dedupe(out.creativeCanAlwaysEat)

const target = path.join(__dirname, '../../src/itemUseData.json')
fs.writeFileSync(target, JSON.stringify(out) + '\n')
console.log('wrote', target, fs.statSync(target).size, 'bytes')
