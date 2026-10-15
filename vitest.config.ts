import { defineConfig } from 'vitest/config'

// MINECRAFT_DATA_DIR / MINECRAFT_PROTOCOL_DIR point the tests at local checkouts that know newer versions than the
// published packages (e.g. 26.2, 26.3). test/setup.ts redirects the packages' own requires the same way.
const dataDir = process.env.MINECRAFT_DATA_DIR
const protocolDir = process.env.MINECRAFT_PROTOCOL_DIR
const mineflayerDir = process.env.MINEFLAYER_DIR

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts']
  },
  resolve: {
    alias: {
      ...dataDir ? { 'minecraft-data': dataDir } : {},
      ...protocolDir ? { 'minecraft-protocol': protocolDir } : {},
      ...mineflayerDir ? { mineflayer: mineflayerDir } : {}
    }
  }
})
