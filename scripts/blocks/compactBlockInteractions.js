// Compacts blockInteractions.json (per-version tables, made by ./genBlockInteractions.js from the decompiled clients)
// into src/blockInteractionsData.json: for each block, the versions from which its entry changes, and the item groups
// the conditions name, the same way. src/blockInteractions.ts evaluates the entries.
//
// Usage: node scripts/blocks/compactBlockInteractions.js [path/to/blockInteractions.json]
const fs = require('fs')
const path = require('path')

const input = process.argv[2] || path.join(__dirname, 'blockInteractions.json')
const table = JSON.parse(fs.readFileSync(input, 'utf8'))
const resolve = (obj, key) => {
  let v = obj[key]
  while (typeof v === 'string' && v.startsWith('=')) v = obj[v.slice(1)]
  return v
}
const versions = Object.keys(table).filter(v => !v.startsWith('$'))

const blocks = {}
const names = new Set()
for (const v of versions) for (const name of Object.keys(resolve(table, v))) names.add(name)
for (const name of [...names].sort()) {
  const list = []
  let last = 'none'
  for (const v of versions) {
    const entry = resolve(table, v)[name] ?? null
    const s = JSON.stringify(entry)
    if (s !== last) list.push([v, entry])
    last = s
  }
  // a block absent in the first versions starts with its first entry
  if (list[0]?.[1] === null) list.shift()
  blocks[name] = list
}

const groups = {}
for (const [group, perVersion] of Object.entries(table.$itemGroups)) {
  const list = []
  let last = null
  for (const v of Object.keys(perVersion)) {
    const value = resolve(perVersion, v)
    const s = JSON.stringify(value)
    if (s !== last) list.push([v, value])
    last = s
  }
  groups[group] = list
}

const target = path.join(__dirname, '../../src/blockInteractionsData.json')
fs.writeFileSync(target, JSON.stringify({ blocks, groups }) + '\n')
console.log('wrote', target, fs.statSync(target).size, 'bytes')
