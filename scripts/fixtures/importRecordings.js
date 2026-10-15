// Turns real-client recordings of the physics-data-generator (trimmed scenario JSONs: per tick the input and the
// serverbound packets as [type, hex]) into the small replay fixtures of test/fixtures/recordings/<version>/<case>.json:
// per tick the mouse input, what the crosshair was on, and the click packets vanilla sent, decoded.
//
// The target under the crosshair is not recorded; it comes from the packets that name it (use_item_on, player_action,
// use_entity / attack), with the block state from the scenario's world fills and the block updates the server sent.
// A target is carried to later ticks while the look does not change and the block is still there.
//
// Usage: node scripts/fixtures/importRecordings.js <trimmed fixtures dir (<ver>/<case>.json)> [case...]
// env MINECRAFT_PROTOCOL_DIR / MINECRAFT_DATA_DIR: packages that know every recorded version (26.x)
const fs = require('fs')
const path = require('path')
const Module = require('module')

// the packages prismarine-* load themselves take the same overrides
const overrides = { 'minecraft-data': process.env.MINECRAFT_DATA_DIR, 'minecraft-protocol': process.env.MINECRAFT_PROTOCOL_DIR }
const resolveFilename = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) { return resolveFilename.call(this, overrides[request] || request, ...rest) }
const mc = require(process.env.MINECRAFT_PROTOCOL_DIR || 'minecraft-protocol')
const MinecraftData = require(process.env.MINECRAFT_DATA_DIR || 'minecraft-data')

const [inputDir, ...onlyCases] = process.argv.slice(2)
if (!inputDir) {
  console.error('usage: node scripts/fixtures/importRecordings.js <dir> [case...]')
  process.exit(1)
}
const outDir = path.join(__dirname, '../../test/fixtures/recordings')

const CLICK_PACKETS = new Set(['block_place', 'use_item', 'arm_animation', 'use_entity', 'attack', 'punch', 'block_dig', 'held_item_slot', 'spectate', 'spectator_action',
  'pick_item', 'pick_item_from_block', 'pick_item_from_entity', 'set_creative_slot', 'custom_payload'])
// the server packets a replay feeds back: the world border, riding, the selected slot
const SERVER_STATE_PACKETS = new Set(['world_border', 'initialize_world_border', 'world_border_center', 'world_border_size', 'world_border_lerp_size', 'set_passengers', 'held_item_slot'])
// the input keys a replay presses: the buttons, sneaking, the movement keys (paddling) and the middle button (pick)
const INPUT_KEYS = ['use', 'attack', 'sneak', 'forward', 'back', 'left', 'right', 'pickItem', ...Array.from({ length: 9 }, (_, i) => `hotbar${i + 1}`)]

const round = (n) => (typeof n === 'number' && !Number.isInteger(n) ? Math.round(n * 1e6) / 1e6 : n)
function clean (v) {
  if (v === null || v === undefined) return v
  if (typeof v === 'bigint') return Number(v)
  if (Buffer.isBuffer(v)) return undefined
  if (Array.isArray(v)) return v.map(clean)
  if (typeof v === 'object') {
    const o = {}
    for (const [k, x] of Object.entries(v)) {
      const c = clean(x)
      if (c !== undefined) o[k] = c
    }
    return o
  }
  return round(v)
}

function stateIdFor (data, Block, spec) {
  // before 1.13 the fills say the block id and metadata: 'dirt[variant=dirt]@3:0'
  const legacy = /@([0-9]+):([0-9]+)$/.exec(spec)
  if (legacy) return (+legacy[1] << 4) | +legacy[2]
  const m = /^(?:minecraft:)?([a-z0-9_]+)(?:\[(.*)\])?$/.exec(spec)
  if (!m) return undefined
  const block = data.blocksByName[m[1]]
  if (!block) return undefined
  if (block.minStateId === undefined || !Block.fromProperties) return block.id << 4
  if (!m[2]) return block.defaultState
  const props = Object.fromEntries(m[2].split(',').map(kv => kv.split('=')))
  try {
    return Block.fromProperties(block.id, props, 0).stateId
  } catch {
    return block.defaultState
  }
}

function importCase (file, version) {
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
  const data = MinecraftData(version)
  const Block = require('prismarine-block')(data)
  const deserC = mc.createDeserializer({ state: 'play', isServer: true, version })
  const deserS = mc.createDeserializer({ state: 'play', isServer: false, version })
  const decode = (deser, hex) => {
    try {
      const r = deser.parsePacketBuffer(Buffer.from(hex, 'hex'))
      return { name: r.data.name, params: clean(r.data.params) }
    } catch (e) {
      return { name: '?', params: { error: e.message.split('\n')[0] } }
    }
  }

  // the world: fills, then setBlock steps, then the server's block updates
  const fills = (rec.world?.fills ?? rec.sourceSession?.world?.fills ?? []).map(f => [...f.slice(0, 6), stateIdFor(data, Block, f[6])])
  const updates = new Map()
  const key = (p) => `${p.x},${p.y},${p.z}`
  // the blocks the scenario's steps set (relative to its origin)
  const origin = rec.origin ?? rec.world?.origin ?? [0, 0, 0]
  for (const step of rec.steps ?? []) {
    for (const action of step.actions ?? []) {
      if (action.block?.at && action.block.state) {
        const [x, y, z] = action.block.at
        updates.set(key({ x: origin[0] + x, y: origin[1] + y, z: origin[2] + z }), stateIdFor(data, Block, action.block.state))
      }
    }
  }
  // unknown (no fill covers it): stone stands in
  const stoneState = stateIdFor(data, Block, 'stone')
  const stateAt = (p) => {
    const k = key(p)
    if (updates.has(k)) return updates.get(k)
    if (!fills.length) return stoneState
    for (let i = fills.length - 1; i >= 0; i--) {
      const [x1, y1, z1, x2, y2, z2, state] = fills[i]
      if (p.x >= Math.min(x1, x2) && p.x <= Math.max(x1, x2) && p.y >= Math.min(y1, y2) && p.y <= Math.max(y1, y2) && p.z >= Math.min(z1, z2) && p.z <= Math.max(z1, z2)) return state
    }
    return 0
  }

  // entities: the summoned ones, by the ids the packets name
  const summons = rec.setup?.summon ?? []
  const entities = {}
  // a summoned entity no packet names gets an id of its own
  const summonIds = summons.map((_, i) => 1000 + i)

  /**
   * The crosshair, when no packet names what it was on (a pick block before 1.21.4, a click that sent nothing): the
   * look from the eyes through the world's blocks (full cubes) and the summoned entities, 4.5 blocks
   */
  const playerPos = rec.start?.pos ?? rec.at
  const crosshair = (look, sneaking) => {
    if (!playerPos || !fills.length) return null
    const eye = [playerPos[0], playerPos[1] + (sneaking ? (version.startsWith('1.8') || /^1\.(9|10|11|12|13)/.test(version) ? 1.54 : 1.27) : 1.62), playerPos[2]]
    const yaw = look[0] * Math.PI / 180
    const pitch = look[1] * Math.PI / 180
    const dir = [-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)]
    const reach = (rec.gamemode ?? rec.start?.gameMode) === 'creative' ? 5 : 4.5
    // the nearest summoned entity on the ray
    let entityHit = null
    summons.forEach((summon, i) => {
      const at = [origin[0] + summon.at[0], origin[1] + summon.at[1], origin[2] + summon.at[2]]
      const e = data.entitiesByName[summon.entity]
      if (!e) return
      const w = (e.width ?? 0.6) / 2
      const box = [at[0] - w, at[1], at[2] - w, at[0] + w, at[1] + (e.height ?? 1), at[2] + w]
      let t0 = 0
      let t1 = reach
      for (let a = 0; a < 3; a++) {
        if (Math.abs(dir[a]) < 1e-9) { if (eye[a] < box[a] || eye[a] > box[a + 3]) { t0 = Infinity; break } continue }
        let ta = (box[a] - eye[a]) / dir[a]
        let tb = (box[a + 3] - eye[a]) / dir[a]
        if (ta > tb) [ta, tb] = [tb, ta]
        t0 = Math.max(t0, ta)
        t1 = Math.min(t1, tb)
      }
      if (t0 <= t1 && (!entityHit || t0 < entityHit.t)) entityHit = { t: t0, id: summonIds[i], entity: summon.entity }
    })
    // the first block on the ray (Amanatides - Woo)
    const pos = eye.map(Math.floor)
    const step = dir.map(d => (d > 0 ? 1 : -1))
    const tDelta = dir.map(d => (Math.abs(d) < 1e-9 ? Infinity : Math.abs(1 / d)))
    const tMax = dir.map((d, a) => (Math.abs(d) < 1e-9 ? Infinity : (d > 0 ? pos[a] + 1 - eye[a] : eye[a] - pos[a]) / Math.abs(d)))
    let t = 0
    let face = -1
    while (t <= reach) {
      const state = stateAt({ x: pos[0], y: pos[1], z: pos[2] })
      if (state && state !== 0 && face !== -1) {
        if (entityHit && entityHit.t < t) break
        const hit = eye.map((e, a) => e + dir[a] * t - pos[a])
        return { block: { stateId: state, pos: [...pos], face, hit } }
      }
      const a = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2)
      t = tMax[a]
      pos[a] += step[a]
      tMax[a] += tDelta[a]
      // the face entered: down 0, up 1, north 2, south 3, west 4, east 5
      face = a === 1 ? (step[1] > 0 ? 0 : 1) : a === 2 ? (step[2] > 0 ? 2 : 3) : (step[0] > 0 ? 4 : 5)
    }
    if (entityHit) {
      entities[entityHit.id] ??= entityHit.entity
      return { entity: entityHit.id }
    }
    return null
  }

  const inventory = {}
  for (const [slot, item] of Object.entries(rec.setup?.inventory ?? {})) inventory[slot] = [item.id, item.count ?? 1]
  for (const [slot, item] of Object.entries(rec.setup?.equipment ?? {})) {
    const index = { mainhand: 0, offhand: 40, head: 39, chest: 38, legs: 37, feet: 36 }[slot]
    if (index !== undefined && item) inventory[index] = [item.id ?? item, item.count ?? 1]
  }

  const ticks = []
  let food
  let target = null
  let lastLook = null
  const anyClick = (inp) => !!(inp?.use || inp?.attack)
  for (const tick of rec.ticks) {
    const inp = tick.in ?? {}
    const look = [inp.yaw, inp.pitch]
    if (lastLook && (look[0] !== lastLook[0] || look[1] !== lastLook[1])) target = null
    lastLook = look
    const packets = (tick.c ?? []).map(([, hex]) => decode(deserC, hex)).filter(p => CLICK_PACKETS.has(p.name))
    let breaksNow = false
    // the target the packets name
    for (const p of packets) {
      const { name, params } = p
      if (name === 'block_place' && params.direction !== -1 && params.direction !== 255 && params.location && params.location.y >= 0) {
        target = { block: { stateId: stateAt(params.location), pos: [params.location.x, params.location.y, params.location.z], face: params.direction, hit: [params.cursorX, params.cursorY, params.cursorZ] } }
        if (version.startsWith('1.8') || (params.cursorX > 1 || params.cursorY > 1 || params.cursorZ > 1)) {
          target.block.hit = target.block.hit.map(c => c / 16)
        }
        break
      }
      if (name === 'block_dig' && params.status === 0) {
        target = { block: { stateId: stateAt(params.location), pos: [params.location.x, params.location.y, params.location.z], face: params.face } }
        // creative breaks the block at once: the crosshair is on something else after this tick
        if ((rec.gamemode ?? rec.start?.gameMode) === 'creative') breaksNow = true
        break
      }
      const entityId = name === 'attack' ? params.entityId : name === 'use_entity' ? params.target : undefined
      if (entityId !== undefined) {
        if (!entities[entityId]) entities[entityId] = summons[Object.keys(entities).length]?.entity ?? summons[0]?.entity ?? 'pig'
        target = { entity: entityId }
        break
      }
    }
    if (target?.block) {
      const [x, y, z] = target.block.pos
      // the block went away (broken): nothing known under the crosshair
      if (stateAt({ x, y, z }) === 0 && !packets.some(p => p.name === 'block_dig' && p.params.status === 0)) target = null
    }
    for (const p of packets) {
      if (p.name === 'block_dig' && ((p.params.status === 0 && (rec.gamemode ?? rec.start?.gameMode) === 'creative') || p.params.status === (version === '26.3' ? 3 : 2))) {
        updates.set(key(p.params.location), 0)
      }
    }
    const keys = INPUT_KEYS.filter(k => inp[k] || (k === 'pickItem' && (inp.pick || inp.pickBlock || inp.middle)))
    // a click nothing named a target for: what the crosshair met
    if (!target && (keys.includes('pickItem') || keys.includes('use') || keys.includes('attack'))) target = crosshair(look, keys.includes('sneak'))
    // a swing from an inventory screen action (dropping an item) is not a click
    const inScreen = (tick.c ?? []).some(([, hex]) => /^(window_click|close_window)$/.test(decode(deserC, hex).name))
    if (inScreen && !keys.length) packets.splice(0, packets.length, ...packets.filter(p => p.name !== 'arm_animation'))
    const server = (tick.s ?? []).map(([, hex]) => decode(deserS, hex)).filter(p => SERVER_STATE_PACKETS.has(p.name) && (p.name !== 'custom_payload'))
    ticks.push({ t: tick.t, in: keys, look, target, food, server: server.map(p => [p.name, p.params]), packets: packets.map(p => [p.name, p.params]).filter(([name, params]) => name !== 'custom_payload' || params.channel === 'MC|PickItem') })
    if (breaksNow) target = null
    for (const [, hex] of tick.s ?? []) {
      const p = decode(deserS, hex)
      if (p.name === 'update_health') food = p.params.food
      if (p.name === 'set_passengers' && !entities[p.params.entityId]) entities[p.params.entityId] = summons.find(s => /boat|raft/.test(s.entity))?.entity ?? 'oak_boat'
      if (p.name === 'block_change') updates.set(key(p.params.location), p.params.type)
      if (p.name === 'multi_block_change' && Array.isArray(p.params.records)) {
        // modern: records as varlongs (state << 12 | x << 8 | z << 4 | y), relative to the chunk section
        const section = p.params.chunkCoordinates
        for (const r of p.params.records) {
          if (typeof r === 'number' && section) {
            const n = BigInt(r)
            const state = Number(n >> 12n)
            const pos = { x: section.x * 16 + Number((n >> 8n) & 15n), y: section.y * 16 + Number(n & 15n), z: section.z * 16 + Number((n >> 4n) & 15n) }
            updates.set(key(pos), state)
          }
        }
      }
      // a block update stops a target that turned to air from being carried on
      if (target?.block && p.name === 'block_change' && key(p.params.location) === key({ x: target.block.pos[0], y: target.block.pos[1], z: target.block.pos[2] })) {
        target = p.params.type === 0 ? null : { block: { ...target.block, stateId: p.params.type } }
      }
      // a block placed elsewhere may now be in front of the crosshair: what it meets is not known until a packet names it
      else if (target?.block && p.name === 'block_change' && p.params.type !== 0) target = null
    }
  }

  // a target the crosshair had before a packet named it: back-fill over the held ticks with the same look
  for (let i = ticks.length - 2; i >= 0; i--) {
    const next = ticks[i + 1]
    if (!ticks[i].target && next.target && anyClick({ use: ticks[i].in.includes('use'), attack: ticks[i].in.includes('attack') }) &&
      ticks[i].look[0] === next.look[0] && ticks[i].look[1] === next.look[1]) {
      ticks[i].target = next.target
    }
  }

  // keep the ticks from the first click on, without the empty ones at the end
  const active = (t) => t.in.length || t.packets.length
  const first = ticks.findIndex(active)
  let last = ticks.length - 1
  while (last > first && !active(ticks[last])) last--
  const kept = first < 0 ? [] : ticks.slice(first, last + 1)
  // the server state set before the first click (a world border, a ride) comes with the first kept tick
  const setupServer = (rec.setupS ?? []).map(([, hex]) => decode(deserS, hex)).filter(p => SERVER_STATE_PACKETS.has(p.name)).map(p => [p.name, p.params])
  for (const [name, params] of setupServer) {
    if (name === 'set_passengers' && !entities[params.entityId]) entities[params.entityId] = rec.setup?.mount?.entity ?? 'oak_boat'
  }
  const initialServer = first < 0 ? [] : [...setupServer, ...ticks.slice(0, first).flatMap(t => t.server ?? [])]

  return {
    name: rec.name,
    version,
    source: rec.source ?? null,
    gamemode: rec.gamemode ?? rec.start?.gameMode ?? 'survival',
    // the player's feet, where the blocks are measured from
    position: rec.start?.pos ?? rec.at ?? null,
    playerEntityId: rec.start?.netState?.entityId ?? null,
    // the server's state packets before the first click (a world border, a ride)
    initialServer,
    // the recordings keep no health packets: a scenario that gives the hunger effect leaves the player hungry
    food: rec.setup?.food ?? (JSON.stringify(rec.steps ?? []).includes('minecraft:hunger') ? 19 : undefined),
    selected: rec.setup?.selected ?? 0,
    inventory,
    entities,
    // ticks with no input and no click packet are left out; t keeps the tick count
    ticks: kept.filter(t => t.in.length || t.packets.length || t.server?.length).map(t => {
      const o = { t: t.t, in: t.in }
      if (t.target) o.target = t.target
      if (t.food !== undefined) o.food = t.food
      if (t.server?.length) o.server = t.server
      if (t.packets.length) o.packets = t.packets
      return o
    })
  }
}

for (const version of fs.readdirSync(inputDir)) {
  const dir = path.join(inputDir, version)
  if (!fs.statSync(dir).isDirectory()) continue
  for (const file of fs.readdirSync(dir)) {
    const name = file.replace(/\.json$/, '')
    if (onlyCases.length && !onlyCases.includes(name)) continue
    try {
      const fixture = importCase(path.join(dir, file), version)
      if (!fixture.ticks.length) continue
      const target = path.join(outDir, version, file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, JSON.stringify(fixture) + '\n')
      console.log(version, name, fixture.ticks.length, 'ticks')
    } catch (e) {
      console.error(version, name, 'FAILED', e.stack.split(String.fromCharCode(10)).slice(0, 4).join(' | '))
    }
  }
}
