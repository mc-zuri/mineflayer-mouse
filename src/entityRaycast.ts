import { Bot } from 'mineflayer'
import { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'
import * as iterators from 'prismarine-world/src/iterators'
import { getBotEyeHeight, getBlockReach, getEntityReach } from './botCommon'
import { Shape } from 'prismarine-world/types/iterators'
import { isEntityAttackable } from './attackableEntity'
import MinecraftData from 'minecraft-data'
import { AttackRange, effectiveRange } from './attackGates'

/**
 * The entity under the crosshair (GameRenderer.pick). With an item that has an attack range (1.21.11+, a spear),
 * LocalPlayer.raycastHitResult looks for entities between the range's ends first, their boxes widened by its margin;
 * a block nearer than the range's start wins; with no entity there, the ordinary pick follows.
 */
export function raycastEntity(bot: Bot, maxDistance?: number, attackRange?: AttackRange): Entity | null {
    if (!bot.entity) return null
    if (attackRange && maxDistance === undefined) {
        const { min, max } = effectiveRange(attackRange, bot.game.gameMode)
        const eye = bot.entity.position.offset(0, getBotEyeHeight(bot), 0)
        const block = bot.blockAtCursor(getBlockReach(bot))
        const blockDistance = block?.['intersect'] ? block['intersect'].distanceTo(eye) : Infinity
        if (blockDistance < min) return null
        const found = nearestEntityOnRay(bot, min, max, attackRange.hitboxMargin)
        if (found) return found
    }
    return ordinaryPick(bot, maxDistance)
}

function lookDirection(bot: Bot) {
    return new Vec3(-Math.sin(bot.entity.yaw) * Math.cos(bot.entity.pitch), Math.sin(bot.entity.pitch), -Math.cos(bot.entity.yaw) * Math.cos(bot.entity.pitch)).normalize()
}

/** the nearest pickable entity whose box (widened by margin) the ray meets between from and to blocks from the eyes */
function nearestEntityOnRay(bot: Bot, from: number, to: number, margin: number): Entity | null {
    const minecraftData = MinecraftData(bot.version)
    const eye = bot.entity.position.offset(0, getBotEyeHeight(bot), 0)
    const dir = lookDirection(bot)
    let best: Entity | null = null
    let bestT = Infinity
    for (const entity of Object.values(bot.entities)) {
        if (entity === bot.entity || !entity.position) continue
        const { width, height } = getEntitySize(minecraftData, entity)
        if (!width || !height) continue
        const w = width / 2 + margin
        const box = [entity.position.x - w, entity.position.y - margin, entity.position.z - w, entity.position.x + w, entity.position.y + height + margin, entity.position.z + w]
        const t = rayBoxEntry([eye.x, eye.y, eye.z], [dir.x, dir.y, dir.z], box, from, to)
        if (t !== null && t < bestT && isEntityAttackable(minecraftData, entity)) {
            best = entity
            bestT = t
        }
    }
    return best
}

/** where the ray (limited to [from, to]) enters the box, or null */
function rayBoxEntry(start: number[], d: number[], box: number[], from: number, to: number): number | null {
    let tNear = from
    let tFar = to
    for (let axis = 0; axis < 3; axis++) {
        if (Math.abs(d[axis]!) < 1e-12) {
            if (start[axis]! < box[axis]! || start[axis]! > box[axis + 3]!) return null
            continue
        }
        let t1 = (box[axis]! - start[axis]!) / d[axis]!
        let t2 = (box[axis + 3]! - start[axis]!) / d[axis]!
        if (t1 > t2) [t1, t2] = [t2, t1]
        tNear = Math.max(tNear, t1)
        tFar = Math.min(tFar, t2)
        if (tNear > tFar) return null
    }
    return tNear
}

function ordinaryPick(bot: Bot, maxDistance?: number): Entity | null {

    const minecraftData = MinecraftData(bot.version)

    const eye = bot.entity.position.offset(0, getBotEyeHeight(bot), 0)
    maxDistance ??= getEntityReach(bot)
    // a block closer than the entity hides it (GameRenderer.pick)
    const block = bot.blockAtCursor(getBlockReach(bot))
    const blockDistance = block?.['intersect'] ? block['intersect'].distanceTo(eye) : Infinity
    maxDistance = Math.min(maxDistance, blockDistance)

    const entities = bot.entities
    const playerGameMode = (entity: Entity) => {
        const player = Object.values(bot.players ?? {}).find(p => p.entity === entity || (!!entity.username && p.username === entity.username))
        return player?.gamemode === 3 ? 'spectator' : undefined
    }

    const dir = new Vec3(-Math.sin(bot.entity.yaw) * Math.cos(bot.entity.pitch), Math.sin(bot.entity.pitch), -Math.cos(bot.entity.yaw) * Math.cos(bot.entity.pitch))
    const iterator = new iterators.RaycastIterator(eye, dir.normalize(), maxDistance)

    let result: Entity | null = null
    let minDist = maxDistance!

    for (const entity of Object.values(entities)) {
        if (entity === bot.entity) continue
        if (!entity.position) continue
        const { width, height } = getEntitySize(minecraftData, entity)
        if (!width || !height) continue

        const w = width / 2

        const shapes = [[-w, 0, -w, w, height, w]] as Shape[]
        const intersect = iterator.intersect(shapes, entity.position)
        if (intersect) {
            const entityDir = entity.position.minus(bot.entity.position) // Can be combined into 1 line
            const sign = Math.sign(entityDir.dot(dir))
            if (sign !== -1) {
                const dist = eye.distanceTo(intersect.pos)
                if (dist < minDist) {
                    if (isEntityAttackable(minecraftData, entity, playerGameMode)) {
                        minDist = dist
                        result = entity
                    }
                }
            }
        }
    }

    return result
}

/** the entity's box size; an interaction entity (1.19.4+) has its size in its metadata, not in minecraft-data */
export function getEntitySize(data: MinecraftData.IndexedData, entity: Entity): { width: number, height: number } {
    if (entity.name === 'interaction') {
        const keys = data.entitiesByName.interaction?.metadataKeys
        const width = Number(entity.metadata?.[keys?.indexOf('width') ?? 8] ?? 1)
        const height = Number(entity.metadata?.[keys?.indexOf('height') ?? 9] ?? 1)
        return { width, height }
    }
    return { width: entity.width, height: entity.height }
}

/**
 * Where the crosshair ray meets the entity's box, relative to the entity's position: the location vanilla sends with an
 * interaction (`hitResult.getLocation().subtract(entity.getX(), entity.getY(), entity.getZ())`). From inside the box it
 * is the eye position, as ProjectileUtil.getEntityHitResult gives.
 */
export function getEntityHitLocation(bot: Bot, entity: Entity): Vec3 {
    const eye = bot.entity.position.offset(0, getBotEyeHeight(bot), 0)
    const { yaw, pitch } = bot.entity
    const dir = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).normalize()
    const { width, height } = getEntitySize(MinecraftData(bot.version), entity)
    const w = (width ?? 0) / 2
    const box = [entity.position.x - w, entity.position.y, entity.position.z - w, entity.position.x + w, entity.position.y + (height ?? 0), entity.position.z + w]
    const start = [eye.x, eye.y, eye.z]
    const d = [dir.x, dir.y, dir.z]
    let tNear = 0
    let tFar = Infinity
    for (let axis = 0; axis < 3; axis++) {
        if (Math.abs(d[axis]!) < 1e-12) {
            if (start[axis]! < box[axis]! || start[axis]! > box[axis + 3]!) tNear = Infinity
            continue
        }
        let t1 = (box[axis]! - start[axis]!) / d[axis]!
        let t2 = (box[axis + 3]! - start[axis]!) / d[axis]!
        if (t1 > t2) [t1, t2] = [t2, t1]
        tNear = Math.max(tNear, t1)
        tFar = Math.min(tFar, t2)
    }
    // the ray misses (a stale target): the eye position stands in, as it does from inside the box
    if (tNear > tFar || tNear === Infinity) return eye.minus(entity.position)
    return eye.plus(dir.scaled(tNear)).minus(entity.position)
}
