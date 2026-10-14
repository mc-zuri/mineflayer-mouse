// Extraction layer: reads vanilla decompiled sources from the extracted_minecraft_data git repo
// (read-only, via git cat-file on remote branches; never checks anything out).
'use strict'
const { execFileSync, spawnSync } = require('child_process')
const crypto = require('crypto')

// EXTRACTED_MINECRAFT_DATA: the extracted_minecraft_data checkout (one client<version> branch per version)
const REPO = process.env.EXTRACTED_MINECRAFT_DATA || 'D:/projects/mc-zuri/mc-data/extracted_minecraft_data'

function git (args, opts = {}) {
  return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 1 << 30, ...opts })
}

function listReleaseRefs () {
  const out = git(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/'])
  const refs = out.split('\n').map(s => s.trim()).filter(r => /^origin\/client\d+(\.\d+)+$/.test(r))
  const ver = r => r.replace('origin/client', '')
  const cmp = (a, b) => {
    const pa = ver(a).split('.').map(Number); const pb = ver(b).split('.').map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d
    }
    return 0
  }
  return refs.sort(cmp).map(r => ({ ref: r, version: ver(r) }))
}

// read many blobs at once
function readBlobs (ref, paths) {
  const input = paths.map(p => `${ref}:${p}`).join('\n') + '\n'
  const res = spawnSync('git', ['-C', REPO, 'cat-file', '--batch'], { input, maxBuffer: 1 << 30 })
  const buf = res.stdout
  const out = {}
  let pos = 0
  for (const p of paths) {
    const nl = buf.indexOf(10, pos)
    const header = buf.slice(pos, nl).toString()
    pos = nl + 1
    if (header.endsWith('missing')) { out[p] = null; continue }
    const size = Number(header.split(' ')[2])
    out[p] = buf.slice(pos, pos + size).toString('utf8')
    pos += size + 1
  }
  return out
}

function lsTree (ref, dir) {
  const out = git(['ls-tree', '-r', '--name-only', ref, '--', dir])
  return out.split('\n').filter(Boolean)
}

// ---- java helpers ----
function matchBrace (src, openIdx) {
  // src[openIdx] === '{' or '('; returns index of matching close. Skips strings/chars/comments.
  const open = src[openIdx]; const close = open === '{' ? '}' : open === '(' ? ')' : ']'
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]
    if (c === '"' || c === '\'') {
      const q = c; i++
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++ }
      continue
    }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return src.length; continue }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue }
    if (c === open) depth++
    else if (c === close) { depth--; if (depth === 0) return i }
  }
  return -1
}

// era-specific interaction method signatures
const METHOD_PATTERNS = [
  { key: 'use', re: /\bboolean func_149727_a\(World \w+, int/g }, // 1.7.10 onBlockActivated
  { key: 'use', re: /\bboolean func_180639_a\(World \w+, BlockPos/g }, // 1.8.9 onBlockActivated
  { key: 'use', re: /\bboolean func_196250_a\(IBlockState/g }, // 1.13.2 onBlockActivated
  { key: 'use', re: /\bboolean (?:use|method_421)\(\s*World \w+, BlockPos/g }, // 1.9.4-1.12.2 (legacy yarn, physics-data-generator)
  { key: 'use', re: /\b(?:boolean|InteractionResult) use\((?:final )?BlockState \w+, (?:final )?Level/g }, // 1.14 - 1.20.4
  { key: 'useWithoutItem', re: /\bInteractionResult useWithoutItem\((?:final )?BlockState/g }, // 1.20.5+
  { key: 'useItemOn', re: /\b(?:ItemInteractionResult|InteractionResult) useItemOn\((?:final )?ItemStack/g } // 1.20.5+
]

function stripGenerics (s) {
  let prev
  do { prev = s; s = s.replace(/<[^<>]*>/g, '') } while (s !== prev)
  return s
}

// parse a java file: top-level + nested classes with extends + interaction methods
function parseJavaFile (src, pkgPrefix) {
  const classes = []
  const re = /(^|\n)([ \t]*)((?:public |protected |private |abstract |static |final |sealed |non-sealed )*)(class|record|enum|interface) ([\w$]+)([^{]*)\{/g
  let m
  while ((m = re.exec(src))) {
    const name = m[5]
    const header = stripGenerics(m[6])
    const ext = /\bextends ([\w.]+)/.exec(header)
    const openIdx = m.index + m[0].length - 1
    const closeIdx = matchBrace(src, openIdx)
    classes.push({ name, kind: m[4], extends: ext ? ext[1].split('.').pop() : null, extendsFull: ext ? ext[1] : null, start: openIdx, end: closeIdx, indent: m[2].length, abstract: /abstract/.test(m[3]) })
  }
  // assign methods to the innermost class containing them
  for (const c of classes) c.methods = {}
  for (const { key, re: mre } of METHOD_PATTERNS) {
    mre.lastIndex = 0
    let mm
    while ((mm = mre.exec(src))) {
      const sigEnd = src.indexOf(')', mm.index)
      const brace = src.indexOf('{', sigEnd)
      const semi = src.indexOf(';', sigEnd)
      if (semi !== -1 && semi < brace) continue // abstract
      const end = matchBrace(src, brace)
      const lineStart = src.lastIndexOf('\n', mm.index) + 1
      const sig = src.slice(lineStart, brace).trim()
      const body = src.slice(brace, end + 1)
      let owner = null
      for (const c of classes) if (c.start < mm.index && c.end > mm.index && (!owner || c.start > owner.start)) owner = c
      if (owner) owner.methods[key] = { sig, body }
    }
  }
  return classes
}

// ---- version sources ----
// Every release branch of the repo, plus: real 1.16.4 (branch tip is 20w45a!), 1.15.1 (commit on 'nmc' branch, no client/ prefix),
// and 1.9.4-1.12.2 decompiled sources (legacy yarn names) from physics-data-generator.
// PHYSICS_DATA_GENERATOR_MC: the physics-data-generator mc/ folder (decompiled 1.9 - 1.12 sources)
const PDG = process.env.PHYSICS_DATA_GENERATOR_MC || 'D:/minecraft/java/physics-data-generator/mc'
function listSources () {
  const fs = require('fs')
  const out = []
  for (const { ref, version } of listReleaseRefs()) {
    if (version === '1.16.4') out.push({ version, kind: 'git', ref: 'origin/client1.16.4~1', root: 'client/' })
    else out.push({ version, kind: 'git', ref, root: 'client/' })
  }
  out.push({ version: '1.15.1', kind: 'git', ref: '900aa199d', root: '' })
  for (const v of ['1.9.4', '1.10.2', '1.11.2', '1.12.2']) {
    const dir = `${PDG}/${v}/build/src-mc/`
    if (fs.existsSync(dir + 'net/minecraft/block/Block.java')) out.push({ version: v, kind: 'fs', dir, root: '' })
  }
  const key = v => v.split('.').map(Number)
  out.sort((a, b) => { const x = key(a.version); const y = key(b.version); for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d } return 0 })
  return out
}

function srcList (src, dir) {
  if (src.kind === 'git') return lsTree(src.ref, src.root + dir).map(p => p.slice(src.root.length))
  const fs = require('fs'); const path = require('path')
  const base = src.dir + dir
  if (!fs.existsSync(base)) return []
  const res = []
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else res.push(dir + path.relative(base, p).split(path.sep).join('/')) } }
  walk(base)
  return res
}
function srcRead (src, paths) {
  if (src.kind === 'git') {
    const r = readBlobs(src.ref, paths.map(p => src.root + p))
    const o = {}; for (const p of paths) o[p] = r[src.root + p]; return o
  }
  const fs = require('fs'); const o = {}
  for (const p of paths) o[p] = fs.existsSync(src.dir + p) ? fs.readFileSync(src.dir + p, 'utf8') : null
  return o
}

function normBody (b) {
  return b.replace(/\bvar\d+\b/g, 'v').replace(/\b(final)\s+/g, '').replace(/\s+/g, '')
}
function hash (s) { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 10) }

module.exports = { REPO, git, listReleaseRefs, listSources, srcList, srcRead, readBlobs, lsTree, matchBrace, parseJavaFile, normBody, hash, stripGenerics }
