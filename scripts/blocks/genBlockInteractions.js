#!/usr/bin/env node
// Generates blockInteractions.json: for every vanilla version source, which blocks CONSUME a right click
// on the client (so the client does not go on to use the held item / try the off hand), and under which condition.
//
// Pipeline per version:
//   1. read every class under net/minecraft/(world/level/)block (git cat-file on the extracted_minecraft_data branches,
//      never checking anything out; plus physics-data-generator decompiled sources for 1.9.4-1.12.2)
//   2. build the class hierarchy (class X extends Y) and find, for every block class, the nearest class (inclusive)
//      overriding the interaction method(s):
//        1.7.10 func_149727_a / 1.8.9 func_180639_a / 1.9-1.12 use|method_421 / 1.13.2 func_196250_a (onBlockActivated)
//        1.14-1.20.4 use(BlockState, Level, BlockPos, Player, InteractionHand, BlockHitResult)
//        1.20.5+ useWithoutItem(...) and useItemOn(ItemStack, ...)
//   3. map registry names -> classes from Blocks.java / Block.java registrations (string ids, BlockItemIds/BlockIds,
//      Color/WeatheringCopper collections, helper methods, local vars)
//   4. classify via the curated per-era table in rules.js (bodies were reviewed with dump.js/view.js)
//   5. verify names against minecraft-data, compare with mineflayer-mouse's regex list, write JSON + reports.
//
// Usage: node gen.js            (writes blockInteractions.json, report.txt next to this file)
'use strict'
const fs = require('fs')
const path = require('path')
const X = require('./extract')
const { loadVersion } = require('./dump')
const { classify, cmp } = require('./rules')

const OUT_DIR = __dirname
// MINECRAFT_DATA_DIR: a minecraft-data that knows every version (the published one lacks 26.2+)
const MCDATA = process.env.MINECRAFT_DATA_DIR || 'minecraft-data'
const REGEX_FILE = 'E:/github/mineflayer-mouse/src/itemBlocksStatic.ts'
const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
const COPPER_STATES = ['', 'exposed_', 'weathered_', 'oxidized_']
const INTERACTION_METHODS = ['use', 'useWithoutItem', 'useItemOn']

// ---------------------------------------------------------------- java scanning helpers
function scanMembers (body) {
  // splits a class body (text between braces) into { fields: [stmt], methods: {name: [body]}, staticBlocks: [body] }
  const res = { fields: [], methods: Object.create(null), staticBlocks: [] }
  let i = 0
  const n = body.length
  while (i < n) {
    // skip whitespace / comments / annotations
    while (i < n && /\s/.test(body[i])) i++
    if (body.startsWith('//', i)) { i = body.indexOf('\n', i); if (i < 0) break; continue }
    if (body.startsWith('/*', i)) { i = body.indexOf('*/', i) + 2; continue }
    if (i >= n) break
    const start = i
    let depthP = 0
    let sawEq = false
    while (i < n) {
      const c = body[i]
      if (c === '"' || c === '\'') { const q = c; i++; while (i < n && body[i] !== q) { if (body[i] === '\\') i++; i++ } i++; continue }
      if (c === '(') depthP++
      else if (c === ')') depthP--
      else if (c === '=' && depthP === 0 && body[i + 1] !== '=' && body[i - 1] !== '=' && body[i - 1] !== '!' && body[i - 1] !== '<' && body[i - 1] !== '>') sawEq = true
      if (depthP === 0 && c === ';') { res.fields.push(body.slice(start, i)); i++; break }
      if (depthP === 0 && c === '{') {
        const header = body.slice(start, i).trim()
        const close = X.matchBrace(body, i)
        if (sawEq) { i = close + 1; continue } // initializer containing braces: keep scanning to ';'
        if (/^static$/.test(header)) res.staticBlocks.push(body.slice(i + 1, close))
        else if (/\(/.test(header)) {
          const name = /([A-Za-z_$][\w$]*)\s*\(/.exec(header.replace(/<[^<>]*>/g, ''))
          if (name) (res.methods[name[1]] = res.methods[name[1]] || []).push(body.slice(i + 1, close))
        } // else nested class/enum: ignore
        i = close + 1
        break
      }
      i++
    }
  }
  return res
}

function splitStatements (body) {
  const out = []
  let depth = 0; let start = 0
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '"' || c === '\'') { const q = c; i++; while (i < body.length && body[i] !== q) { if (body[i] === '\\') i++; i++ } continue }
    if (body.startsWith('//', i)) { i = body.indexOf('\n', i); if (i < 0) break; continue }
    if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') depth--
    else if (c === ';' && depth === 0) { out.push(body.slice(start, i)); start = i + 1 }
  }
  return out
}

// field declarations + static initializer statements of a class
function classStatements (src, className) {
  const ci = src.indexOf('{', src.search(new RegExp(`\\bclass ${className}\\b`)))
  const mem = scanMembers(src.slice(ci + 1, X.matchBrace(src, ci)))
  const out = [...mem.fields]
  for (const sb of mem.staticBlocks) out.push(...splitStatements(sb))
  return out
}

// ---------------------------------------------------------------- id files (26.2+)
function parseIdFile (src) {
  // returns { FIELD: { single:[names] } | { colored:[names] } | { copper:{weathering:[], waxed:[]} } }
  const out = {}
  if (!src) return out
  const re = /(?:public static final [\w.<>]+ )?([A-Z][A-Z0-9_]*) = ([\w.]+)\(([^;]*?)\);/g
  let m
  while ((m = re.exec(src))) {
    const [, field, fn, args] = m
    const lit = /"([a-z0-9_]+)"/.exec(args)
    const lits = [...args.matchAll(/"([a-z0-9_]+)"/g)].map(x => x[1])
    // BlockItemId.create("carrots", "carrot"): block id, item id
    if (/(^|\.)(create|createKey)$/.test(fn) && lit) out[field] = { single: [lit[1]], item: lits[1] || lits[0] }
    else if (/createSimpleColored$/.test(fn) && lit) out[field] = { colored: COLORS.map(c => `${c}_${lit[1]}`) }
    else if (/createSimpleCopper$/.test(fn) && lit) out[field] = { copper: { weathering: COPPER_STATES.map(s => s + lit[1]), waxed: COPPER_STATES.map(s => 'waxed_' + s + lit[1]) } }
    else out[field] = { unknown: fn }
  }
  return out
}

// ---------------------------------------------------------------- registrations
function findRegistrationRegion (blobs, dir) {
  const blocksJava = blobs[dir + 'Blocks.java']
  if (dir.includes('world/level/block') && blocksJava) {
    const ci = blocksJava.indexOf('{', blocksJava.search(/\bclass Blocks\b/))
    const body = blocksJava.slice(ci + 1, X.matchBrace(blocksJava, ci))
    const mem = scanMembers(body)
    const stmts = [...mem.fields]
    for (const sb of mem.staticBlocks) stmts.push(...splitStatements(sb))
    return { stmts, helpers: mem.methods, mode: 'mojang' }
  }
  // MCP / legacy yarn: Block.java static registration method containing "stone"
  const blockJava = blobs[dir + 'Block.java']
  const ci = blockJava.indexOf('{', blockJava.search(/\bclass Block\b/))
  const body = blockJava.slice(ci + 1, X.matchBrace(blockJava, ci))
  const mem = scanMembers(body)
  for (const [name, bodies] of Object.entries(mem.methods)) {
    for (const b of bodies) if (/"stone"/.test(b) && /"chest"/.test(b)) return { stmts: splitStatements(b), helpers: mem.methods, mode: 'legacy', regFn: name }
  }
  throw new Error('registration method not found')
}

function getRegistrations (src, loaded, isBlockClass) {
  const { blobs, dir } = loaded
  const { stmts, helpers } = findRegistrationRegion(blobs, dir)
  const idsBI = parseIdFile(X.srcRead(src, ['net/minecraft/references/BlockItemIds.java'])['net/minecraft/references/BlockItemIds.java'])
  const idsB = parseIdFile(X.srcRead(src, ['net/minecraft/references/BlockIds.java'])['net/minecraft/references/BlockIds.java'])
  const idsRefBlocks = parseIdFile(X.srcRead(src, ['net/minecraft/references/Blocks.java'])['net/minecraft/references/Blocks.java'])
  const unresolvedIds = []
  const helperCache = Object.create(null)
  const vars = Object.create(null)

  function explicitClasses (text) {
    const found = []
    const re = /\bnew ([A-Z][\w]*)\s*\(|\b([A-Z][\w]*)::new\b/g
    let m
    while ((m = re.exec(text))) { const c = m[1] || m[2]; if (isBlockClass(c)) found.push(c) }
    return found
  }
  function helperClasses (name, depth) {
    if (depth > 4 || !helpers[name]) return []
    if (helperCache[name]) return helperCache[name]
    helperCache[name] = []
    const res = []
    for (const b of helpers[name]) res.push(...classesOf(b, depth + 1))
    helperCache[name] = res
    return res
  }
  function classesOf (text, depth = 0) {
    const ex = explicitClasses(text)
    if (ex.length) return ex
    const res = []
    const re = /\b([a-z][\w]*)\s*\(|\b(var\d+)\b/g
    let m
    while ((m = re.exec(text))) {
      if (m[2]) { if (vars[m[2]]) res.push(...vars[m[2]]) } else res.push(...helperClasses(m[1], depth))
    }
    return res
  }

  const regs = [] // { name, cls, text }
  for (let st of stmts) {
    st = st.trim()
    if (!st) continue
    // local var definitions (legacy registries): Block var0 = new ...
    const lv = /^(?:final\s+)?([A-Z][\w.]*)(?:<[^>]*>)?\s+(var\d+)\s*=\s*([^]*)$/.exec(st)
    if (lv) { vars[lv[2]] = classesOf(lv[3]); continue }
    const asg = /^(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:final\s+)?(?:[\w.<>?, ]+\s+)?([A-Z][A-Z0-9_]*)\s*=\s*([^]*)$/.exec(st)
    const expr = asg ? asg[2] : st
    const field = asg ? asg[1] : null
    // names
    let names = null; let copper = null
    const idm = /\b(BlockItemIds|BlockIds|net\.minecraft\.references\.Blocks)\.([A-Z][A-Z0-9_]*)\b/.exec(expr)
    const wcb = /\bWeatheringCopperBlocks\.create\(\s*"([a-z0-9_]+)"/.exec(expr) // 1.21.9 - 26.1
    if (wcb) {
      copper = { weathering: COPPER_STATES.map(s => s + wcb[1]), waxed: COPPER_STATES.map(s => 'waxed_' + s + wcb[1]) }
    } else if (idm) {
      const def = (idm[1] === 'BlockItemIds' ? idsBI : idm[1] === 'BlockIds' ? idsB : idsRefBlocks)[idm[2]]
      if (def && def.single) names = def.single
      else if (def && def.colored) names = def.colored
      else if (def && def.copper) copper = def.copper
      else { names = []; unresolvedIds.push(idm[0]) } // unknown creator (e.g. copper block special names): skip
    } else {
      const lit = /"([a-z0-9_]+)"/.exec(expr)
      if (lit) names = [lit[1]]
    }
    if (!names && !copper) continue
    const classes = classesOf(expr)
    if (copper) {
      const waxedCls = classes[0] || 'Block'
      const weatheringCls = classes[1] || classes[0] || 'Block'
      for (const nm of copper.weathering) regs.push({ name: nm, cls: weatheringCls, text: expr, field })
      for (const nm of copper.waxed) regs.push({ name: nm, cls: waxedCls, text: expr, field })
    } else {
      for (const nm of names) regs.push({ name: nm, cls: classes[0] || 'Block', text: expr, field })
    }
  }
  return regs
}

// ---------------------------------------------------------------- item groups
function itemFieldNames (src, blockFieldToName) {
  // Items.FIELD -> registry id (field names can differ: Items.DRY_SHORT_GRASS = registerBlock(Blocks.SHORT_DRY_GRASS))
  const p = 'net/minecraft/world/item/Items.java'
  const items = X.srcRead(src, [p])[p]
  const map = {}
  if (!items) return map
  const ids = {
    ItemIds: parseIdFile(X.srcRead(src, ['net/minecraft/references/ItemIds.java'])['net/minecraft/references/ItemIds.java']),
    BlockItemIds: parseIdFile(X.srcRead(src, ['net/minecraft/references/BlockItemIds.java'])['net/minecraft/references/BlockItemIds.java'])
  }
  for (const st of classStatements(items, 'Items')) {
    const m = /\b([A-Z][A-Z0-9_]*)\s*=\s*([^]*)$/.exec(st)
    if (!m) continue
    const lit = /"([a-z0-9_]+)"/.exec(m[2])
    const blk = /\bBlocks\.([A-Z][A-Z0-9_]*)\b/.exec(m[2])
    const idm = /\b(ItemIds|BlockItemIds)\.([A-Z][A-Z0-9_]*)\b/.exec(m[2])
    const idDef = idm && ids[idm[1]][idm[2]]
    if (idDef && idDef.single) map[m[1]] = idDef.item || idDef.single[0]
    else if (blk && blockFieldToName[blk[1]] && /^\s*register(Block|Item)?\w*\(\s*Blocks\./.test(m[2])) map[m[1]] = blockFieldToName[blk[1]]
    else if (lit) map[m[1]] = lit[1]
  }
  return map
}

function compostables (src, loaded, blockFieldToName) {
  const out = new Set()
  const comp = loaded.blobs[loaded.dir + 'ComposterBlock.java']
  if (comp) {
    const names = itemFieldNames(src, blockFieldToName)
    const re = /\badd\(\s*[\d.]+F,\s*(?:Items\.)?([A-Z][A-Z0-9_]*)\s*\)/g
    let m
    while ((m = re.exec(comp))) out.add(names[m[1]] || m[1].toLowerCase())
  }
  if (!out.size) {
    // 26.3+: Item.Properties#compostable(...) in Items.java
    const p = 'net/minecraft/world/item/Items.java'
    const items = X.srcRead(src, [p])[p]
    const ids = parseIdFile(X.srcRead(src, ['net/minecraft/references/ItemIds.java'])['net/minecraft/references/ItemIds.java'])
    const idsBI = parseIdFile(X.srcRead(src, ['net/minecraft/references/BlockItemIds.java'])['net/minecraft/references/BlockItemIds.java'])
    if (items) {
      for (const st of classStatements(items, "Items")) {
        if (!/\.compostable\(/.test(st)) continue
        const idm = /\b(ItemIds|BlockItemIds)\.([A-Z][A-Z0-9_]*)\b/.exec(st)
        const f = /([A-Z][A-Z0-9_]*)\s*=/.exec(st)
        const def = idm ? (idm[1] === 'ItemIds' ? ids : idsBI)[idm[2]] : null
        if (def && def.single) out.add(def.item || def.single[0])
        else if (def && def.colored) def.colored.forEach(x => out.add(x))
        else if (f) out.add(f[1].toLowerCase())
      }
    }
  }
  return [...out].sort()
}

function pottables (mcd, version) {
  if (cmp(version, '1.13') < 0) return ['sapling', 'red_flower', 'yellow_flower', 'red_mushroom', 'brown_mushroom', 'cactus', 'deadbush', 'tallgrass']
  const remap = { azalea_bush: 'azalea', flowering_azalea_bush: 'flowering_azalea' }
  return Object.keys(mcd.blocksByName).filter(n => n.startsWith('potted_')).map(n => { const c = n.slice(7); return remap[c] || c }).sort()
}

function itemGroups (src, loaded, mcd, version, blockFieldToName) {
  const g = {
    compostable: compostables(src, loaded, blockFieldToName),
    pottable: pottables(mcd, version),
    campfire_food: ['beef', 'chicken', 'cod', 'salmon', 'mutton', 'porkchop', 'rabbit', 'potato', 'kelp'],
    candles: ['candle', '*_candle'],
    music_discs: ['music_disc_*'],
    lectern_books: ['written_book', 'writable_book'],
    bookshelf_books: ['book', 'written_book', 'enchanted_book', 'writable_book', 'knowledge_book'],
    note_block_top_instruments: ['zombie_head', 'skeleton_skull', 'creeper_head', 'dragon_head', 'wither_skeleton_skull', 'piglin_head', 'player_head']
  }
  return g
}

// ---------------------------------------------------------------- condition DSL validation
function referencedTokens (entry) {
  const toks = { props: new Set(), items: new Set(), groups: new Set() }
  const txt = [entry.cond || '', entry.swingCond || '', typeof entry.offhand === 'string' ? entry.offhand : '', ...(entry.items || []).map(i => `holding(${i})`)].join(' ')
  const re = /(offhandHolding|holding)\(([^)]*)\)|\b([a-z_]+)\s*(?:[<>!]?=|[<>])|\b(lit|has_record|has_book|berries)\b/g
  let m
  while ((m = re.exec(txt))) {
    if (m[2]) for (const it of m[2].split(',').map(s => s.trim())) { if (it.startsWith('@')) toks.groups.add(it.slice(1)); else toks.items.add(it) }
    else if (m[3] && m[3] !== 'face') toks.props.add(m[3])
    else if (m[4]) toks.props.add(m[4])
  }
  return toks
}
const globRe = g => new RegExp('^' + g.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')

// ---------------------------------------------------------------- main
function main () {
  const mcdata = require(MCDATA)
  const sources = X.listSources()
  const perVersion = {}
  const groupsPerVersion = {}
  const mcPicked = {}
  const problems = []
  const definerNames = {}
  const notes = []

  for (const src of sources) {
    const { version } = src
    const loaded = loadVersion(src)
    const { classes } = loaded
    const chainCache = {}
    const chain = (c) => {
      if (chainCache[c]) return chainCache[c]
      const out = []; let cur = c; const seen = new Set()
      while (cur && classes[cur] && !seen.has(cur)) { seen.add(cur); out.push(cur); cur = classes[cur].extends }
      if (cur && !classes[cur]) out.push(cur) // external root
      chainCache[c] = out
      return out
    }
    const isBlockClass = (c) => { if (c === 'Block') return true; if (!classes[c]) return false; const ch = chain(c); return ch.includes('Block') || ch.includes('BlockBehaviour') }
    const definerOf = (c) => {
      for (const k of chain(c)) {
        const cl = classes[k]
        if (cl && INTERACTION_METHODS.some(m => cl.methods[m])) return k
      }
      return null
    }
    const regs = getRegistrations(src, loaded, isBlockClass)
    const mcd = pickMcData(mcdata, version)
    const mcNames = new Set(Object.keys(mcd.blocksByName))
    const blocks = {}
    const seen = new Set()
    for (const r of regs) {
      if (!mcNames.has(r.name) && NAME_ALIASES[r.name] && mcNames.has(NAME_ALIASES[r.name])) {
        notes.push(`${version}: registry id ${r.name} renamed to minecraft-data name ${NAME_ALIASES[r.name]}`)
        r.name = NAME_ALIASES[r.name]
      }
      if (seen.has(r.name)) continue
      seen.add(r.name)
      const def = definerOf(r.cls)
      if (!def) continue
      ;(definerNames[`${version} ${def}`] = definerNames[`${version} ${def}`] || []).push(r.name)
      const res = classify(def, version, r.name, { version, regText: r.text, cls: r.cls })
      if (res.unknown) { problems.push(`${version}: no rule for definer ${def} (block ${r.name}, class ${r.cls})`); continue }
      if (!res.entry) continue
      blocks[r.name] = res.entry
    }
    // verification against minecraft-data
    const regNames = new Set(regs.map(r => r.name))
    const missing = Object.keys(blocks).filter(n => !mcNames.has(n))
    if (missing.length) problems.push(`${version}: names not in minecraft-data ${mcd._picked}: ${missing.join(', ')}`)
    const unparsed = [...mcNames].filter(n => !regNames.has(n))
    if (unparsed.length) notes.push(`${version}: ${unparsed.length} minecraft-data blocks without a parsed registration: ${unparsed.slice(0, 15).join(', ')}${unparsed.length > 15 ? ' ...' : ''}`)
    const itemNames = Object.keys(mcd.itemsByName)
    // item groups: keep only groups referenced by this version's entries, and only entries that exist as items
    const blockFieldToName = {}; for (const r of regs) if (r.field && !blockFieldToName[r.field]) blockFieldToName[r.field] = r.name
    const allGroups = itemGroups(src, loaded, mcd, version, blockFieldToName)
    const used = new Set()
    for (const e of Object.values(blocks)) for (const gname of referencedTokens(e).groups) used.add(gname)
    const groups = {}
    for (const gname of used) {
      if (!allGroups[gname]) continue
      const kept = allGroups[gname].filter(it => itemNames.some(x => globRe(it).test(x)))
      const dropped = allGroups[gname].filter(it => !kept.includes(it))
      if (dropped.length) notes.push(`${version}: @${gname}: dropped (not items in minecraft-data ${mcd._picked}): ${dropped.join(', ')}`)
      groups[gname] = kept
    }
    for (const [n, e] of Object.entries(blocks)) {
      const t = referencedTokens(e)
      for (const it of t.items) if (!itemNames.some(x => globRe(it).test(x)) && !(it === 'potion' && cmp(version, '1.9') < 0)) problems.push(`${version}: ${n}: item '${it}' matches no minecraft-data item`)
      for (const gname of t.groups) if (!groups[gname] && gname !== 'block_item') problems.push(`${version}: ${n}: unknown group @${gname}`)
      const props = mcd.blocksByName[n] && mcd.blocksByName[n].states ? mcd.blocksByName[n].states.map(s => s.name) : null
      if (props && cmp(version, '1.13') >= 0) for (const p of t.props) if (!props.includes(p)) problems.push(`${version}: ${n}: state property '${p}' not in minecraft-data states [${props.join(',')}]`)
    }
    perVersion[version] = sortObj(blocks)
    mcPicked[version] = mcd._picked
    groupsPerVersion[version] = groups
    process.stderr.write(`${version}: ${regs.length} registrations, ${Object.keys(blocks).length} consuming blocks\n`)
  }

  // ------------- dedupe + write JSON
  const versions = Object.keys(perVersion)
  const out = {
    $schema: {
      description: 'Client-side block interaction consumption per vanilla version. An entry means a right click on that block with the main hand MAY be consumed by the block (the client then stops: no item use, no off-hand attempt). Blocks not listed never consume. Global rules not encoded per block: spectators always consume; with sneaking && (main or off hand non-empty) block interaction is skipped entirely (1.9+; 1.8: sneaking && held item); 1.20.5+ useWithoutItem only runs for the main hand.',
      swing: 'optional. Absent: the consuming client result swings the arm (SUCCESS / client SwingSource). swing:false -> consuming result never swings (CONSUME, CONSUME_PARTIAL, 1.21.2+ SUCCESS_SERVER/CONSUME). swingCond:<cond> -> swings iff cond (only meaningful when the entry consumes). <=1.14.4 always swings.',
      offhand: '1.20.5+ only. useItemOn runs for both hands, useWithoutItem only for the main hand. offhand:false -> the off hand is never consumed by this block; true -> always; <cond> -> consumed iff cond with holding()/emptyHand referring to the OFF-hand item. Before 1.20.5 Block.use ran for each hand with that hand item, so evaluate the main entry against the off-hand item.',
      kinds: { always: 'always consumed', conditional: 'consumed iff cond evaluates true', itemOnly: 'consumed iff held main-hand item matches one of items AND cond (if present) is true' },
      condGrammar: "expr := term ('|' term)* ; term := factor ('&' factor)* ; factor := '!' factor | '(' expr ')' | atom",
      atoms: {
        '<prop>': 'boolean block state property is true (prismarine-block getProperties()), e.g. lit, has_record, has_book, berries',
        '<prop><op><value>': 'op in = != < <= > >=, e.g. level=8, age>1, honey_level>=5, charges<4, bites=0, vault_state=active (pre-1.13: use metadata: cauldron level = metadata, jukebox has_record = metadata 1)',
        emptyHand: 'main hand empty',
        'holding(a,b,...)': 'main-hand item name matches any entry; entries are names, globs (*) or @group (see $itemGroups; @block_item = any item that places a block)',
        'offhandHolding(...)': 'same for the off hand',
        mayBuild: 'player abilities allow building (not adventure / spectator)',
        creative: 'creative gamemode',
        opCreative: 'creative && op permission level >= 2 (canUseGameMasterBlocks); approximate with creative',
        hungry: 'Player.canEat(false): creative/invulnerable or food < 20',
        'face=<dir>': 'clicked face (up/down/north/...)',
        hitFacing: 'clicked face == block state facing',
        hitFacingAxis: 'clicked face axis == block state facing axis',
        bellProperHit: 'BellBlock.isProperHit: face horizontal && hitY-blockY <= 0.8124 && (attachment floor: face axis == facing axis; single/double_wall: face axis != facing axis; ceiling: true)',
        candleHit: 'hit position y - block y > 0.5 (clicked the candle part)',
        wireDotOrCross: 'redstone wire with all 4 sides none (dot) or all 4 sides side (cross)',
        potEmpty: 'pre-1.13 flower pot block entity has no item (unknown -> assume true)',
        hitSlotOccupied: 'chiseled bookshelf: the slot under the cursor (front face, 3x2 grid from hit x/y) is occupied (slot_<n>_occupied)',
        signWaxed: 'sign block entity is_waxed (1.20+); unknown -> false',
        anchorWorks: 'respawn anchors work in this dimension (the nether)'
      }
    },
    $sources: Object.fromEntries(sources.map(s => [s.version, `${s.kind === 'git' ? `git ${s.ref}${s.root ? ' (' + s.root + ')' : ''}` : s.dir}; minecraft-data ${mcPicked[s.version]}`])),
    $itemGroups: dedupeGroups(groupsPerVersion, versions),
    $versionsWithoutSource: {
      '1.7 - 1.7.9': '=1.7.10', '1.8 - 1.8.8': '=1.8.9',
      '1.9 - 1.9.4': '=1.9.4 (physics-data-generator)', '1.10 - 1.10.2': '=1.10.2', '1.11 - 1.11.2': '=1.11.2', '1.12 - 1.12.2': '=1.12.2',
      '1.13 - 1.13.1': '=1.13.2', '1.14 - 1.14.3': '=1.14.4', '1.15 - 1.15.2': '=1.15.1 (nmc branch commit 900aa199d)',
      '1.16 - 1.16.5': '=1.16.4 (commit origin/client1.16.4~1; the branch tip is snapshot 20w45a)', '1.17 - 1.17.1': '=1.18.1 (no 1.17 source; 1.18 added no interactive blocks)', '1.18.2': '=1.18.1', '1.19.2': '=1.19.1'
    }
  }
  let prevKey = null; let prevVer = null
  for (const v of versions) {
    const key = JSON.stringify(perVersion[v])
    if (key === prevKey) out[v] = `=${firstOfRun(out, prevVer)}`
    else out[v] = perVersion[v]
    prevKey = key; prevVer = v
  }
  // one top-level key per line (meta keys: one sub-key per line)
  const lines = Object.entries(out).map(([k, v]) => (k.startsWith('$') && typeof v === 'object'
    ? `${JSON.stringify(k)}:{\n${Object.entries(v).map(([k2, v2]) => `  ${JSON.stringify(k2)}:${JSON.stringify(v2)}`).join(',\n')}\n}`
    : `${JSON.stringify(k)}:${JSON.stringify(v)}`))
  fs.writeFileSync(path.join(OUT_DIR, 'blockInteractions.json'), `{\n${lines.join(',\n')}\n}\n`)
  JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'blockInteractions.json'), 'utf8')) // sanity

  // ------------- report
  let rep = ''
  rep += '== problems\n' + (problems.length ? [...new Set(problems)].join('\n') : '(none)') + '\n\n'
  rep += '== version-to-version changes\n' + changeSummary(perVersion, versions) + '\n'
  rep += '== regex comparison\n' + regexComparison(perVersion, mcdata) + '\n'
  rep += '== definer -> names (latest)\n' + Object.entries(definerNames).filter(([k]) => k.startsWith(versions[versions.length - 1] + ' ')).map(([k, v]) => `${k}: ${v.length} ${v.slice(0, 6).join(',')}${v.length > 6 ? ',...' : ''}`).join('\n') + '\n\n'
  rep += '== notes\n' + notes.join('\n') + '\n'
  fs.writeFileSync(path.join(OUT_DIR, 'report.txt'), rep)
  process.stderr.write(`problems: ${problems.length}\n`)
}

// minecraft-data registry names that differ from the vanilla registry id
const NAME_ALIASES = { silver_shulker_box: 'light_gray_shulker_box', silver_glazed_terracotta: 'light_gray_glazed_terracotta' }

// minecraft-data silently falls back to other data for unsupported versions (1.21.7 -> 1.21); pick explicitly:
// nearest supported release >= version in the same major.minor line, else nearest <=.
function pickMcData (mcdata, version) {
  const rel = mcdata.supportedVersions.pc.filter(v => /^\d+\.\d+(\.\d+)?$/.test(v))
  const mm = v => v.split('.').slice(0, 2).join('.')
  const same = rel.filter(v => mm(v) === mm(version))
  const ge = same.filter(v => cmp(v, version) >= 0).sort(cmp)[0]
  const le = rel.filter(v => cmp(v, version) <= 0).sort(cmp).pop()
  const pick = ge || le
  const d = mcdata(pick)
  d._picked = pick
  return d
}

function firstOfRun (out, v) { const x = out[v]; return typeof x === 'string' ? x.slice(1) : v }
function sortObj (o) { const r = {}; for (const k of Object.keys(o).sort()) r[k] = o[k]; return r }

function dedupeGroups (gpv, versions) {
  const res = {}
  const names = new Set(); for (const v of versions) for (const k of Object.keys(gpv[v])) names.add(k)
  for (const g of names) {
    const per = {}; let prev = null; let prevVer = null
    for (const v of versions) {
      const val = gpv[v][g]; if (val === undefined) { prev = null; continue } const key = JSON.stringify(val)
      if (key === prev) { per[v] = `=${typeof per[prevVer] === 'string' ? per[prevVer].slice(1) : prevVer}` } else per[v] = val
      prev = key; prevVer = v
    }
    res[g] = per // only versions whose entries reference @g; "=x" points to an identical earlier list
  }
  return res
}

function compressNames (names) {
  // groups colored / wood / copper variants for readable summaries
  const groups = {}
  for (const n of names) {
    let k = n
    k = k.replace(new RegExp(`^(${COLORS.join('|')})_`), '<color>_')
    k = k.replace(/^(waxed_)?(exposed_|weathered_|oxidized_)?(?=copper)/, '<copper>')
    k = k.replace(/^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped|pale_oak|poplar)_(?!log|wood)/, '<wood>_')
    k = k.replace(/^potted_.*/, 'potted_*')
    k = k.replace(/^(nether_brick)_fence$/, '<wood>_fence')
    k = k.replace(/^(stone|polished_blackstone)_(?=button|pressure)/, '<stone>_')
    ;(groups[k] = groups[k] || []).push(n)
  }
  return Object.entries(groups).map(([k, v]) => (v.length > 1 ? `${k}(x${v.length})` : v[0])).join(', ')
}

function changeSummary (perVersion, versions) {
  let s = ''
  for (let i = 1; i < versions.length; i++) {
    const a = perVersion[versions[i - 1]]; const b = perVersion[versions[i]]
    const added = Object.keys(b).filter(n => !a[n]); const removed = Object.keys(a).filter(n => !b[n])
    const changed = Object.keys(b).filter(n => a[n] && JSON.stringify(a[n]) !== JSON.stringify(b[n]))
    if (!added.length && !removed.length && !changed.length) { s += `${versions[i]}: identical to ${versions[i - 1]}\n`; continue }
    s += `${versions[i]} (vs ${versions[i - 1]}):\n`
    if (added.length) s += `  + ${compressNames(added)}\n`
    if (removed.length) s += `  - ${compressNames(removed)}\n`
    const byChange = {}
    for (const n of changed) { const k = `${fmt(a[n])}  ->  ${fmt(b[n])}`; (byChange[k] = byChange[k] || []).push(n) }
    for (const [k, ns] of Object.entries(byChange)) s += `  ~ ${compressNames(ns)}: ${k}\n`
  }
  return s
}
function fmt (e) {
  const base = e.kind === 'always' ? 'always' : e.kind === 'itemOnly' ? `itemOnly[${e.items.join(',')}]${e.cond ? ' if ' + e.cond : ''}` : `if ${e.cond}`
  return base + (e.swing === false ? ' [no swing]' : e.swingCond ? ` [swing if ${e.swingCond}]` : '') + (e.offhand !== undefined ? ` [offhand: ${e.offhand}]` : '')
}

function regexComparison (perVersion, mcdata) {
  const src = fs.readFileSync(REGEX_FILE, 'utf8')
  const arr = src.slice(src.indexOf('activatableBlockWithoutItemPatterns'), src.indexOf('] as const'))
  const regexes = [...arr.matchAll(/\/(\^[^\n]*?\$)\//g)].map(m => new RegExp(m[1]))
  let s = `parsed ${regexes.length} regexes from ${REGEX_FILE}\n`
  for (const v of ['1.8.9', '1.12.2', '1.16.4', '1.20.4', '1.21.4', '1.21.11', '26.3']) {
    if (!perVersion[v]) continue
    const names = Object.keys(pickMcData(mcdata, v).blocksByName)
    const vanilla = perVersion[v]
    const rx = n => regexes.some(r => r.test(n))
    const fp = names.filter(n => rx(n) && !vanilla[n])
    const cond = names.filter(n => rx(n) && vanilla[n] && vanilla[n].kind !== 'always')
    const fn = names.filter(n => !rx(n) && vanilla[n])
    s += `\n-- ${v}\n`
    s += `false positives (regex says activatable, vanilla never consumes) [${fp.length}]: ${compressNames(fp)}\n`
    const byFmt = {}
    for (const n of fn) (byFmt[fmt(vanilla[n])] = byFmt[fmt(vanilla[n])] || []).push(n)
    s += `false negatives (vanilla may consume, regex misses) [${fn.length}]:\n${Object.entries(byFmt).map(([f, ns]) => `    ${compressNames(ns)}: ${f}`).join('\n')}\n`
    s += `regex-matched but only conditional in vanilla [${cond.length}]: ${compressNames(cond)}\n`
  }
  return s
}

main()
