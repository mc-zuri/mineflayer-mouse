import { Bot } from 'mineflayer'
import { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'
import * as iterators from 'prismarine-world/src/iterators'
import { getBotEyeHeight } from './botCommon'
import { Shape } from 'prismarine-world/types/iterators'
import { isEntityAttackable } from './attackableEntity'
import MinecraftData from 'minecraft-data'

export function raycastEntity(bot: Bot, maxDistance?: number) {
    if (!bot.entity) return null

    const minecraftData = MinecraftData(bot.version)

    // TODO shouldn't .5 be added to maxDistance?
    maxDistance ??= bot.game.gameMode === 'creative' ? 5 : 3
    const block = bot.blockAtCursor(maxDistance)
    maxDistance = block?.['intersect'].distanceTo(bot.entity.position) ?? maxDistance

    const entities = bot.entities
    const playerGameMode = (entity: Entity) => {
        const player = Object.values(bot.players ?? {}).find(p => p.entity === entity || (!!entity.username && p.username === entity.username))
        return player?.gamemode === 3 ? 'spectator' : undefined
    }

    const dir = new Vec3(-Math.sin(bot.entity.yaw) * Math.cos(bot.entity.pitch), Math.sin(bot.entity.pitch), -Math.cos(bot.entity.yaw) * Math.cos(bot.entity.pitch))
    const iterator = new iterators.RaycastIterator(bot.entity.position.offset(0, getBotEyeHeight(bot), 0), dir.normalize(), maxDistance)

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
                const dist = bot.entity.position.distanceTo(intersect.pos)
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
