import MinecraftData from 'minecraft-data'
import { versionToNumber } from '../../src/utils'

/** every release mineflayer supports (1.8.8+) that the minecraft-data in use knows, by its full version ("1.8" is 1.8.8) */
export const supportedReleases = [...new Set(MinecraftData.supportedVersions.pc
  .filter(v => /^\d+\.\d+(\.\d+)?$/.test(v))
  .map(v => MinecraftData(v).version.minecraftVersion as string)
  .filter(v => versionToNumber(v) >= versionToNumber('1.8.8')))]

/** the versions where click behaviour changes, as far as the minecraft-data in use knows them */
export const representativeVersions = [
  '1.8.8', '1.9.4', '1.12.2', '1.13.2', '1.14.4', '1.15.2', '1.16.5', '1.17.1', '1.18.2', '1.19.4', '1.20.4', '1.20.6',
  '1.21.1', '1.21.4', '1.21.5', '1.21.11', '26.1', '26.2', '26.3'
].filter(v => supportedReleases.includes(v))

export const atLeast = (version: string, min: string) => versionToNumber(version) >= versionToNumber(min)
