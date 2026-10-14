import { describe, it, expect } from 'vitest'
import MinecraftData from 'minecraft-data'
import { createFakeBot } from './harness/fakeBot'

const known = (v: string) => MinecraftData.supportedVersions.pc.includes(v)
const versionsWith = (...vs: string[]) => vs.filter(known)

describe('right click on an entity', () => {
  it.each(versionsWith('1.9.4', '1.12.2', '1.16.5', '1.20.4', '1.21.11'))('%s: interact_at with the hit location, then interact', (version) => {
    const f = createFakeBot(version).inject().hold(null)
    const cow = f.lookAtEntity('cow')
    f.pressRight()
    const [interactAt, interact] = f.take(p => p.name === 'use_entity')
    expect(interactAt!.params).toMatchObject({ target: cow.id, mouse: 2, hand: 0, sneaking: false })
    // the ray hits the middle of the cow's near face
    expect(interactAt!.params.x).toBeCloseTo(0)
    expect(interactAt!.params.y).toBeCloseTo(cow.height / 2)
    expect(interactAt!.params.z).toBeCloseTo(cow.width / 2)
    expect(interact!.params).toMatchObject({ target: cow.id, mouse: 0, hand: 0 })
  })

  it.each(versionsWith('26.1', '26.2', '26.3'))('%s: one interaction packet per hand with the hit location', (version) => {
    const f = createFakeBot(version).inject().hold(null)
    const cow = f.lookAtEntity('cow')
    f.sneak().pressRight()
    const interactions = f.take(p => p.name === 'use_entity')
    // empty hands pass: the main hand, then the off hand
    expect(interactions.map(p => p.params.hand)).toEqual([0, 1])
    expect(interactions[0]!.params).toMatchObject({ target: cow.id, hand: 0, sneaking: true })
    // a sneaking player's eyes are lower (1.27)
    expect(interactions[0]!.params.location.y).toBeCloseTo(f.bot.entity.position.y + 1.27 - cow.position.y)
    expect(interactions[0]!.params.location.z).toBeCloseTo(cow.width / 2)
  })
})
