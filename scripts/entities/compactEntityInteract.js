// Compacts entityInteract.json (the rule table made by ./genEntityInteract.js from the decompiled clients' interact
// methods) into src/entityInteractData.json, without the notes. src/entityInteractions.ts evaluates the rules.
//
// Usage: node scripts/entities/compactEntityInteract.js [path/to/entityInteract.json]
const fs = require('fs')
const path = require('path')

const input = process.argv[2] || path.join(__dirname, 'entityInteract.json')
const table = JSON.parse(fs.readFileSync(input, 'utf8'))

const rule = ({ id, note, ...r }) => r
const out = {
  entityGroups: Object.fromEntries(Object.entries(table.entityGroups).map(([k, g]) => [k, { members: g.members ?? [] }])),
  itemGroups: Object.fromEntries(Object.entries(table.itemGroups).map(([k, g]) => {
    const { note, desc, ...rest } = g
    return [k, rest]
  })),
  conditions: Object.fromEntries(Object.entries(table.conditions).map(([k, c]) => [k, c.default === true])),
  phases: { entity: table.phases.entity.map(rule), item: table.phases.item.map(rule) }
}
const target = path.join(__dirname, '../../src/entityInteractData.json')
fs.writeFileSync(target, JSON.stringify(out) + '\n')
console.log('wrote', target, fs.statSync(target).size, 'bytes')
