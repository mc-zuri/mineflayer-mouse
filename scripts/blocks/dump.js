// Dump all interaction-method bodies per defining class, grouped by identical normalized body across versions.
// Used for manual review when curating the classification table in gen.js (node dump.js && node view.js > dump/view.txt).
'use strict'
const fs = require('fs')
const path = require('path')
const X = require('./extract')

const OUT = path.join(__dirname, 'dump')

function blockDirOf (src) {
  for (const d of ['net/minecraft/world/level/block/', 'net/minecraft/block/']) {
    const files = X.srcList(src, d)
    if (files.length) return { dir: d, files }
  }
  throw new Error('no block dir for ' + src.version)
}

function loadVersion (src) {
  const { dir, files } = blockDirOf(src)
  const javaFiles = files.filter(f => f.endsWith('.java') && !/^(entity|state|grower)\//.test(f.slice(dir.length)))
  const blobs = X.srcRead(src, javaFiles)
  const classes = {}
  for (const f of javaFiles) {
    if (!blobs[f]) continue
    for (const c of X.parseJavaFile(blobs[f])) {
      c.file = f
      if (!classes[c.name]) classes[c.name] = c
    }
  }
  return { classes, blobs, dir }
}

if (require.main === module) {
  fs.mkdirSync(OUT, { recursive: true })
  const groups = {}
  const perVersion = {}
  for (const src of X.listSources()) {
    const { version } = src
    const { classes } = loadVersion(src)
    const list = []
    for (const c of Object.values(classes)) {
      for (const [k, m] of Object.entries(c.methods)) {
        const h = X.hash(X.normBody(m.body))
        const key = `${c.name}|${k}|${h}`
        groups[key] = groups[key] || { cls: c.name, method: k, hash: h, versions: [], body: m.body, sig: m.sig }
        groups[key].versions.push(version)
        list.push(`${c.name}.${k}`)
      }
    }
    perVersion[version] = list.sort()
    process.stderr.write(`${version}: ${list.length} overrides\n`)
  }
  const byCls = {}
  for (const g of Object.values(groups)) (byCls[g.cls] = byCls[g.cls] || []).push(g)
  let txt = ''
  for (const cls of Object.keys(byCls).sort()) {
    for (const g of byCls[cls]) txt += `\n===== ${cls}.${g.method} [${g.hash}] versions: ${g.versions.join(',')}\n${g.sig}\n${g.body}\n`
  }
  fs.writeFileSync(path.join(OUT, 'bodies.txt'), txt)
  fs.writeFileSync(path.join(OUT, 'perVersion.json'), JSON.stringify(perVersion, null, 1))
}

module.exports = { loadVersion, blockDirOf }
