// Generates per-version entity "pickable" (crosshair-targetable) classification from decompiled
// Minecraft client sources (one git branch per version), plus a merged table for mineflayer-mouse.
//
// Vanilla crosshair pick: GameRenderer.pick / LocalPlayer.pick -> ProjectileUtil.getEntityHitResult(...,
// EntitySelector.CAN_BE_PICKED) where CAN_BE_PICKED = NO_SPECTATORS.and(Entity::isPickable)
// (26.x: Entity::isPickable, with Player.isPickable() doing the spectator check). 1.8.9: EntityRenderer
// getMouseOver uses EntitySelectors.NOT_SPECTATING + canBeCollidedWith() (SRG func_70067_L).
// Left click then attacks whatever was picked, regardless of isAttackable().
//
// Usage: node gen.js            (reads git, writes entityPickable.json + entityData.json next to this file)
// Read-only on the source repo: uses `git show` / `git grep` against refs, never checks anything out.

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

// EXTRACTED_MINECRAFT_DATA: a checkout of extracted_minecraft_data with one client<version> branch per version
const REPO = process.env.EXTRACTED_MINECRAFT_DATA || 'D:/projects/mc-zuri/mc-data/extracted_minecraft_data'
// entityData.json goes to src/, the per-version tables next to this script
const OUT = __dirname
const SRC = path.join(__dirname, '../../src')
const BRANCHES = ['1.8.9', '1.13.2', '1.14.4', '1.16.4', '1.18.1', '1.19', '1.19.1', '1.19.3', '1.19.4',
  '1.20', '1.20.1', '1.20.2', '1.20.3', '1.20.4', '1.20.5', '1.20.6',
  '1.21', '1.21.1', '1.21.2', '1.21.3', '1.21.4', '1.21.5', '1.21.6', '1.21.7', '1.21.8', '1.21.9', '1.21.10', '1.21.11',
  '26.1', '26.1.1', '26.2', '26.3']

const git = (...args) => {
  try {
    return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 })
  } catch (e) {
    if (e.status === 1 && typeof e.stdout === 'string') return e.stdout // grep: no match
    throw e
  }
}
const ref = v => 'origin/client' + v
const isMcp = v => v === '1.8.9' || v === '1.13.2' // SRG-named sources
const show = (v, p) => git('show', `${ref(v)}:${p}`)
const exists = (v, p) => git('ls-tree', '--name-only', ref(v), '--', p).trim() !== ''

// ---------- class hierarchy ----------
function parseClasses (v) {
  const out = git('grep', '-n', '-E', '^\\s*((public|protected|private|abstract|final|static|sealed|non-sealed|strictfp)\\s+)*class\\s+\\w+', ref(v), '--', 'client/net/minecraft')
  const classes = {} // simpleName -> [{file, ext, topLevel}]
  for (const line of out.split('\n')) {
    if (!line) continue
    const m = /^[^:]+:([^:]+):\d+:(.*)$/.exec(line)
    if (!m) continue
    const file = m[1]; const decl = m[2]
    const cm = /\bclass\s+(\w+)/.exec(decl)
    let rest = decl.slice(cm.index + cm[0].length)
    if (rest.startsWith('<')) { // skip generic params
      let depth = 0; let i = 0
      for (; i < rest.length; i++) { if (rest[i] === '<') depth++; else if (rest[i] === '>' && --depth === 0) break }
      rest = rest.slice(i + 1)
    }
    const em = /^\s*extends\s+([\w.]+)/.exec(rest)
    const name = cm[1]
    const topLevel = path.basename(file, '.java') === name
    ;(classes[name] ??= []).push({ name, file, ext: em ? em[1].split('.').pop() : null, topLevel })
  }
  return classes
}
function pickClass (classes, name) {
  const c = classes[name]
  if (!c) return null
  const entityish = x => /\/(world\/)?entity\//.test(x.file)
  return c.find(x => x.topLevel && entityish(x)) || c.find(x => x.topLevel) || c.find(entityish) || c[0]
}

// ---------- isPickable / canBeCollidedWith overrides ----------
function parseOverrides (v) {
  const m = isMcp(v) ? 'func_70067_L' : 'isPickable'
  const out = git('grep', '-n', '-A3', '-E', `boolean ${m}\\(\\) \\{`, ref(v), '--', 'client/net/minecraft')
  const res = {} // file -> body
  for (const blk of out.split(/\n--\n/)) {
    if (!blk.trim()) continue
    const lines = blk.split('\n')
    const file = lines[0].split(':')[1]
    const body = lines.slice(1).map(l => l.replace(/^.*?-\d+-/, '').trim()).join(' ').split('}')[0].trim()
    res[file] = body
  }
  return res
}

// ---------- registry ----------
const MINECART_1_8 = { RIDEABLE: 'MinecartRideable', CHEST: 'MinecartChest', FURNACE: 'MinecartFurnace', TNT: 'MinecartTNT', HOPPER: 'MinecartHopper', SPAWNER: 'MinecartSpawner', COMMAND_BLOCK: 'MinecartCommandBlock' }
function parseRegistry (v) {
  const reg = {} // registryName -> className
  const fieldToName = {}
  if (v === '1.8.9') {
    const src = show(v, 'client/net/minecraft/entity/EntityList.java')
    for (const m of src.matchAll(/func_756(?:18|14)_a\((\w+)\.class, (?:"([^"]+)"|EntityMinecart\.EnumMinecartType\.(\w+)\.\w+\(\))/g)) {
      reg[m[2] || MINECART_1_8[m[3]]] = m[1]
    }
    // not in EntityList but exist as entities with names mineflayer/minecraft-data uses
    reg.Player = 'EntityPlayer'
    reg.LightningBolt = 'EntityLightningBolt'
    reg.FishingHook = 'EntityFishHook' // minecraft-data calls it "Fishing Float"
    return { reg, fieldToName }
  }
  const files = ['EntityType.java', 'EntityTypes.java', 'EntityTypeIds.java']
    .map(f => (isMcp(v) ? 'client/net/minecraft/entity/' : 'client/net/minecraft/world/entity/') + f)
    .filter(f => exists(v, f))
  const src = files.map(f => show(v, f)).join('\n')
  const ids = {} // EntityTypeIds field -> name (26.2+)
  for (const m of src.matchAll(/ResourceKey<EntityType<\?>>\s+(\w+)\s*=\s*create\("([a-z0-9_]+)"\)/g)) ids[m[1]] = m[2]
  for (const m of src.matchAll(/EntityType<([\w.]+)>\s+(\w+)\s*[;=]/g)) {
    const cls = m[1].split('.').pop(); const field = m[2]
    const rm = new RegExp(`\\b${field}\\s*=\\s*\\w+\\(\\s*(?:"([a-z0-9_]+)"|EntityTypeIds\\.(\\w+))`).exec(src)
    if (!rm) throw new Error(`${v}: no registration for ${field}`)
    const name = rm[1] || ids[rm[2]]
    if (!name) throw new Error(`${v}: cannot resolve id for ${field}`)
    reg[name] = cls
    fieldToName[field] = name
  }
  return { reg, fieldToName }
}

function parseRedirectableTag (v, fieldToName) {
  const set = new Set()
  if (isMcp(v)) return set
  const out = git('grep', '-h', 'REDIRECTABLE_PROJECTILE)', ref(v), '--', 'client/net/minecraft/data')
  for (const m of out.matchAll(/EntityType(?:Ids)?\.(\w+)/g)) {
    const n = fieldToName[m[1]]
    if (!n) throw new Error(`${v}: unknown tag member ${m[1]}`)
    set.add(n)
  }
  return set
}

// ---------- evaluation ----------
function makeEvaluator (v, classes, overrides, redirectable) {
  const unknownBodies = []
  function evalFrom (clsName, regName, trail) {
    const c = pickClass(classes, clsName)
    if (!c) throw new Error(`${v}: class ${clsName} not found (trail ${trail.join('<')})`)
    trail = [...trail, clsName]
    const body = c.topLevel ? overrides[c.file] : undefined
    if (body !== undefined) {
      const sup = () => evalFrom(c.ext, regName, trail)
      const and = (r, cond) => r.v ? { v: true, cond: [...r.cond, cond], via: r.via } : r
      const at = path.basename(c.file, '.java')
      if (/^return false;$/.test(body)) return { v: false, cond: [], via: at }
      if (/^return true;$/.test(body)) return { v: true, cond: [], via: at }
      if (/^return !this\.(isRemoved\(\)|removed|field_70128_L);$/.test(body)) return { v: true, cond: [], via: at }
      if (/^return super\.\w+\(\) && !this\.(isMarker\(\)|func_181026_s\(\));$/.test(body)) return and(sup(), 'notMarker')
      if (/^return !this\.isSpectator\(\) && super\.isPickable\(\);$/.test(body)) return and(sup(), 'notSpectator')
      if (/^return super\.isPickable\(\) && !this\.(inGround|isInGround\(\));$/.test(body)) return and(sup(), 'notInGround')
      if (/REDIRECTABLE_PROJECTILE/.test(body)) return { v: redirectable.has(regName), cond: [], via: at + '#REDIRECTABLE_PROJECTILE' }
      unknownBodies.push(`${c.file}: ${body}`)
      throw new Error(`${v}: unknown isPickable body in ${c.file}: ${body}`)
    }
    if (clsName === 'Entity') return { v: false, cond: [], via: 'Entity' }
    if (!c.ext) throw new Error(`${v}: ${clsName} has no superclass and is not Entity (trail ${trail.join('<')})`)
    return evalFrom(c.ext, regName, trail)
  }
  return (cls, regName) => evalFrom(cls, regName, [])
}

// Vanilla pick predicate already excludes spectators (NO_SPECTATORS / Player.isPickable 26.x)
const EXTRA_CONDITIONAL = {
  player: 'notSpectator',
  // EnderDragon.isPickable() is false in every version, but its EnderDragonPart sub-entities (not registered
  // entity types; ids dragonId+1..+8 on the client) are pickable and attacking them damages the dragon.
  ender_dragon: 'multipartPickable'
}

function genVersion (v) {
  const classes = parseClasses(v)
  const overrides = parseOverrides(v)
  const { reg, fieldToName } = parseRegistry(v)
  const redirectable = parseRedirectableTag(v, fieldToName)
  const ev = makeEvaluator(v, classes, overrides, redirectable)
  const pickable = []; const notPickable = []; const conditional = {}; const detail = {}
  for (const [name, cls] of Object.entries(reg).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (v === '1.8.9' && (name === 'Mob' || name === 'Monster')) continue // abstract EntityLiving/EntityMob registrations
    const r = ev(cls, name)
    detail[name] = { cls, via: r.via }
    ;(r.v ? pickable : notPickable).push(name)
    const conds = [...r.cond]
    const snake = toModern(name, v)
    if (EXTRA_CONDITIONAL[snake] && !conds.includes(EXTRA_CONDITIONAL[snake])) conds.push(EXTRA_CONDITIONAL[snake])
    if (conds.length) conditional[name] = conds.join('&')
  }
  return { pickable, notPickable, conditional, redirectable: [...redirectable], detail, classByName: reg }
}

// ---------- renames ----------
// Legacy (1.8-1.10 CamelCase, 1.11/1.12 snake, minecraft-data quirk) names -> modern registry names.
// Renames between registry ids of 1.13+ versions.
const SNAKE_RENAMES = {
  zombie_pigman: 'zombified_piglin', // 1.16
  boat: 'oak_boat', // 1.21.2
  chest_boat: 'oak_chest_boat' // 1.21.2
}
const LEGACY_RENAMES_1_11_12 = { // minecraft-data 1.11-1.12.2 names that differ from 1.13+
  xp_orb: 'experience_orb',
  xp_bottle: 'experience_bottle',
  eye_of_ender_signal: 'eye_of_ender',
  fireworks_rocket: 'firework_rocket',
  evocation_fangs: 'evoker_fangs',
  evocation_illager: 'evoker',
  vindication_illager: 'vindicator',
  illusion_illager: 'illusioner',
  commandblock_minecart: 'command_block_minecart',
  snowman: 'snow_golem',
  villager_golem: 'iron_golem',
  ender_crystal: 'end_crystal',
  'Fishing Hook': 'fishing_bobber'
}
// minecraft-data quirk names (object entries with spaces/typos) seen in 1.13-1.13.2 data
const MCDATA_QUIRK_RENAMES = {
  item_stack: 'item',
  'area_effect cloud': 'area_effect_cloud',
  activated_tnt: 'tnt',
  endercrystal: 'end_crystal',
  tipped_arrow: 'arrow',
  firecharge: 'fireball',
  thrown_enderpearl: 'ender_pearl',
  falling_objects: 'falling_block',
  item_frames: 'item_frame',
  'eye_of ender': 'eye_of_ender',
  thrown_potion: 'potion',
  'thrown_exp bottle': 'experience_bottle',
  thrown_exp_bottle: 'experience_bottle',
  armorstand: 'armor_stand',
  fishing_hook: 'fishing_bobber',
  'iron_golem}': 'iron_golem',
  creaking_transient: 'creaking', // 1.21.2/1.21.3 only
  'Fishing Float': 'fishing_bobber'
}
let legacy189 = {} // filled from MCP class matching 1.8.9 -> 1.13.2
function toModern (name, v) {
  if (v === '1.8.9') name = legacy189[name] ?? name
  name = LEGACY_RENAMES_1_11_12[name] ?? MCDATA_QUIRK_RENAMES[name] ?? name
  return SNAKE_RENAMES[name] ?? name
}

// ---------- main ----------
function main () {
  const perVersion = {}
  // 1.8.9 legacy names -> 1.13.2 names via identical MCP class names
  const r189 = parseRegistry('1.8.9').reg
  const r1132 = parseRegistry('1.13.2').reg
  const cls1132 = Object.fromEntries(Object.entries(r1132).map(([n, c]) => [c, n]))
  for (const [n, c] of Object.entries(r189)) {
    if (cls1132[c]) legacy189[n] = cls1132[c]
  }
  legacy189.Mob = false; legacy189.Monster = false // abstract EntityLiving / EntityMob, never spawned
  legacy189.Boat = 'boat'
  legacy189.Arrow = 'arrow' // EntityArrow (1.8.9) became EntityTippedArrow in 1.9+
  for (const v of BRANCHES) {
    process.stderr.write(`processing ${v}\n`)
    perVersion[v] = genVersion(v)
  }

  // compact per-version json (dedupe identical consecutive versions)
  const compact = {}
  let prevKey = null; let prevLabel = null
  const ranges = []
  for (const v of BRANCHES) {
    const { pickable, notPickable, conditional, redirectable } = perVersion[v]
    const data = { pickable, notPickable, conditional }
    if (redirectable.length) data.redirectableProjectileTag = redirectable
    const key = JSON.stringify(data)
    if (key === prevKey) {
      ranges[ranges.length - 1].to = v
    } else {
      ranges.push({ from: v, to: v, data })
      prevKey = key
    }
  }
  for (const r of ranges) {
    prevLabel = r.from === r.to ? r.from : `${r.from}..${r.to}`
    compact[prevLabel] = r.data
  }
  const pickableJson = {
    _comment: 'Crosshair-pickable entities per client version (Entity.isPickable / 1.8.9 canBeCollidedWith), generated by gen.js from decompiled client sources. Keys "a..b" cover all source branches between a and b inclusive. Names are the registry names of that version (1.8.9: EntityList names). Versions without a source branch (1.9-1.12.2, 1.15, 1.17) take the nearest neighbour.',
    branches: BRANCHES,
    versions: compact
  }
  fs.writeFileSync(path.join(OUT, 'entityPickable.json'), JSON.stringify(pickableJson, null, 2) + '\n')

  // merged table (modern names)
  const status = {} // modernName -> { v: Set(bool), versions: {v: bool}, cond: Set }
  for (const v of BRANCHES) {
    const pv = perVersion[v]
    for (const [list, val] of [[pv.pickable, true], [pv.notPickable, false]]) {
      for (const n of list) {
        const modern = toModern(n, v)
        if (modern === false) continue
        const s = (status[modern] ??= { vals: new Set(), versions: {}, cond: new Set() })
        s.vals.add(val); s.versions[v] = val
        if (pv.conditional[n]) pv.conditional[n].split('&').forEach(c => s.cond.add(c))
      }
    }
  }
  const attackable = []; const notAttackable = []; const conditional = {}; const versionDependent = {}
  for (const [n, s] of Object.entries(status).sort((a, b) => a[0].localeCompare(b[0]))) {
    const ever = s.vals.has(true)
    if (s.vals.size > 1) {
      // compress into ranges
      const segs = []
      for (const v of BRANCHES) {
        if (!(v in s.versions)) continue
        const last = segs[segs.length - 1]
        if (last && last.val === s.versions[v]) last.to = v
        else segs.push({ from: v, to: v, val: s.versions[v] })
      }
      versionDependent[n] = Object.fromEntries(segs.map(x => [x.from === x.to ? x.from : `${x.from}..${x.to}`, x.val]))
    }
    if (ever || n === 'ender_dragon') attackable.push(n)
    else notAttackable.push(n)
    if (s.cond.size) conditional[n] = [...s.cond].join('&')
  }
  const entityRenames = {}
  for (const [k, val] of Object.entries(legacy189)) {
    const m = val === false ? false : toModern(val, '1.13.2')
    if (k !== m) entityRenames[k] = m
  }
  Object.assign(entityRenames, LEGACY_RENAMES_1_11_12, MCDATA_QUIRK_RENAMES, SNAKE_RENAMES)
  // 1.9-1.10 minecraft-data CamelCase names that 1.8.9 lacks (added 1.9)
  Object.assign(entityRenames, { Shulker: 'shulker', ShulkerBullet: 'shulker_bullet', 'Dragon Fireball': 'dragon_fireball', DragonFireball: 'dragon_fireball', SpectralArrow: 'spectral_arrow', AreaEffectCloud: 'area_effect_cloud', PolarBear: 'polar_bear' })
  const sortObj = o => Object.fromEntries(Object.entries(o).sort((a, b) => a[0].localeCompare(b[0])))
  const merged = {
    version: `${BRANCHES[0]}..${BRANCHES[BRANCHES.length - 1]}`,
    attackable,
    notAttackable,
    conditional: sortObj(conditional),
    versionDependent: sortObj(versionDependent),
    entityRenames: sortObj(entityRenames)
  }
  fs.writeFileSync(path.join(SRC, 'entityData.json'), JSON.stringify(merged, null, 2) + '\n')

  // debug detail
  const detail = Object.fromEntries(BRANCHES.map(v => [v, perVersion[v].detail]))
  fs.writeFileSync(path.join(OUT, 'entityPickable.detail.json'), JSON.stringify(detail, null, 1) + '\n')
  process.stderr.write('done\n')
}

main()
