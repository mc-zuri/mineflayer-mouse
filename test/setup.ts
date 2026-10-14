import Module from 'module'

// Let MINECRAFT_DATA_DIR / MINECRAFT_PROTOCOL_DIR override the packages for every require (prismarine-* load
// minecraft-data themselves), so the tests can cover versions the published packages do not know yet.
const overrides: Record<string, string | undefined> = {
  'minecraft-data': process.env.MINECRAFT_DATA_DIR,
  'minecraft-protocol': process.env.MINECRAFT_PROTOCOL_DIR
}
if (Object.values(overrides).some(Boolean)) {
  const original = (Module as any)._resolveFilename
  ;(Module as any)._resolveFilename = function (request: string, ...rest: any[]) {
    const override = overrides[request]
    return original.call(this, override ?? request, ...rest)
  }
}
