import { describe, it, expect } from 'vitest'
import MinecraftData from 'minecraft-data'
import { getLatestEntityName, isEntityAttackable } from '../src/attackableEntity'
import { versionToNumber } from '../src/utils'

// every release mineflayer supports (1.8.8+) that the minecraft-data in use knows
export const supportedReleases = MinecraftData.supportedVersions.pc
  .filter(v => /^\d+\.\d+(\.\d+)?$/.test(v) && versionToNumber(v) >= versionToNumber('1.8.8'))

// 1.8 - 1.10 register these abstract names, which a server never spawns
const abstractNames = new Set(['Mob', 'Monster'])

describe('entityData.json', () => {
  it.each(supportedReleases)('classifies every entity of %s', (version) => {
    const data = MinecraftData(version)
    const unclassified = data.entitiesArray.map(e => e.name).filter(name => !abstractNames.has(name) && !getLatestEntityName(name))
    expect(unclassified).toEqual([])
  })

  const pick = (version: string, name: string, metadata: any[] = []) => isEntityAttackable(MinecraftData(version), { name, metadata } as any)

  it('picks what vanilla picks', () => {
    expect(pick('1.21.4', 'cow')).toBe(true)
    expect(pick('1.21.4', 'item')).toBe(false)
    expect(pick('1.21.4', 'arrow')).toBe(false)
    // Interaction.isPickable is true (1.19.4+)
    expect(pick('1.20.4', 'interaction')).toBe(true)
    expect(pick('1.20.4', 'text_display')).toBe(false)
    // a redirectable projectile
    expect(pick('1.21.4', 'fireball')).toBe(true)
    expect(pick('1.21.4', 'breeze_wind_charge')).toBe(true)
    expect(pick('1.21.4', 'small_fireball')).toBe(false)
    // 1.8 names
    expect(pick('1.8.8', 'PigZombie')).toBe(true)
    expect(pick('1.8.8', 'XPOrb')).toBe(false)
    expect(pick('1.8.8', 'Mob')).toBe(false)
  })

  it('picks the entities added since 1.21.4', () => {
    for (const name of ['happy_ghast', 'copper_golem', 'mannequin', 'camel_husk', 'nautilus', 'zombie_nautilus', 'parched']) {
      expect(getLatestEntityName(name), name).toBe(name)
      expect(pick('1.21.4', name), name).toBe(true)
    }
    for (const name of ['sulfur_cube', 'cushion', 'poplar_boat', 'poplar_chest_boat']) {
      expect(pick('1.21.4', name), name).toBe(true)
    }
    expect(pick('1.21.5', 'splash_potion')).toBe(false)
  })

  it('does not pick a marker armor stand or a spectator', () => {
    const data = MinecraftData('1.20.4')
    const flagsIndex = data.entitiesByName.armor_stand!.metadataKeys!.indexOf('client_flags')
    const metadata: any[] = []
    metadata[flagsIndex] = 16
    expect(pick('1.20.4', 'armor_stand')).toBe(true)
    expect(pick('1.20.4', 'armor_stand', metadata)).toBe(false)
    expect(isEntityAttackable(data, { name: 'player' } as any, () => 'spectator')).toBe(false)
    expect(isEntityAttackable(data, { name: 'player' } as any, () => 'survival')).toBe(true)
  })
})
