import { Bot } from 'mineflayer'
import MinecraftData from 'minecraft-data'

export const getBotEyeHeight = (bot: Bot) => {
    // todo use bot.entity.eyeHeight when its not broken
    if (!bot.controlState.sneak) return 1.62
    // a sneaking player's eyes: 1.27 from 1.14 (the crouching pose), 1.54 before
    const version = ((bot as any).registry?.version ?? MinecraftData(bot.version).version) as { '>=': (v: string) => boolean }
    return version['>=']('1.14') ? 1.27 : 1.54
}

/** an attribute of the bot (base plus its add_value modifiers), if the server sent it */
function attribute(bot: Bot, names: string[]): number | undefined {
    const attributes = (bot.entity as any)?.attributes
    if (!attributes) return undefined
    for (const name of names) {
        const attr = attributes[name] ?? attributes[`minecraft:${name}`]
        if (attr && typeof attr.value === 'number') {
            const added = (attr.modifiers ?? []).filter((m: any) => m.operation === 0 || m.operation === 'add_value').reduce((sum: number, m: any) => sum + (m.amount ?? m.value ?? 0), 0)
            return attr.value + added
        }
    }
    return undefined
}

const atLeast1205 = (bot: Bot) => {
    const version = ((bot as any).registry?.version ?? MinecraftData(bot.version).version) as { '>=': (v: string) => boolean }
    return version['>=']('1.20.5')
}

/**
 * How far the crosshair reaches blocks: 4.5, 5 in creative (MultiPlayerGameMode.getPickRange, then from 1.20.5 the
 * block_interaction_range attribute, which creative raises by 0.5)
 */
export function getBlockReach(bot: Bot): number {
    const creative = bot.game?.gameMode === 'creative'
    if (atLeast1205(bot)) {
        const value = attribute(bot, ['player.block_interaction_range', 'block_interaction_range'])
        if (value !== undefined) return value + (creative ? 0.5 : 0)
    }
    return creative ? 5 : 4.5
}

/**
 * How far the crosshair reaches entities: 3, in creative 6 (GameRenderer.pick, hasFarPickRange) up to 1.20.4, then the
 * entity_interaction_range attribute, which creative raises by 2
 */
export function getEntityReach(bot: Bot): number {
    const creative = bot.game?.gameMode === 'creative'
    if (atLeast1205(bot)) {
        const value = attribute(bot, ['player.entity_interaction_range', 'entity_interaction_range']) ?? 3
        return value + (creative ? 2 : 0)
    }
    return creative ? 6 : 3
}
