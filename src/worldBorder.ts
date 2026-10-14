/**
 * The world border as the vanilla client keeps it (WorldBorder), from the server's packets: the clicks on blocks
 * outside it do nothing (MultiPlayerGameMode.useItemOn / startDestroyBlock, the creative re-break, and from 1.18 the
 * use of an entity outside it).
 */
import { Bot } from 'mineflayer'
import type { VersionCompare } from './interactionRules'

const DEFAULT_ABSOLUTE_MAX_SIZE = 29_999_984
const DEFAULT_SIZE = 59_999_968

export class WorldBorderTracker {
  centerX = 0
  centerZ = 0
  /** the diameter */
  private size = DEFAULT_SIZE
  private lerp: { from: number, to: number, start: number, duration: number } | null = null
  absoluteMaxSize = DEFAULT_ABSOLUTE_MAX_SIZE

  constructor(bot: Bot, private version: () => VersionCompare) {
    const client = bot._client
    // 1.8 - 1.16.5: one packet with an action
    client.on('world_border', (p: any) => {
      switch (p.action) {
        case 0: this.setSize(p.radius); break
        case 1: this.lerpSize(p.old_radius, p.new_radius, Number(p.speed)); break
        case 2: this.setCenter(p.x, p.z); break
        case 3: this.initialize(p.x, p.z, p.old_radius, p.new_radius, Number(p.speed), p.portalBoundary); break
      }
    })
    // 1.17+
    client.on('initialize_world_border', (p: any) => this.initialize(p.x, p.z, p.oldDiameter, p.newDiameter, Number(p.speed), p.portalTeleportBoundary))
    client.on('world_border_center', (p: any) => this.setCenter(p.x, p.z))
    client.on('world_border_size', (p: any) => this.setSize(p.diameter))
    client.on('world_border_lerp_size', (p: any) => this.lerpSize(p.oldDiameter, p.newDiameter, Number(p.speed)))
  }

  /** from 1.21.11 a moving border moves tick by tick (its speed is in ticks), before in milliseconds */
  private get tickBased() {
    return this.version()['>=']('1.21.11')
  }

  setCenter(x: number, z: number) {
    this.centerX = x
    this.centerZ = z
  }

  setSize(size: number) {
    this.size = size
    this.lerp = null
  }

  lerpSize(from: number, to: number, duration: number) {
    if (!(duration > 0) || from === to) return this.setSize(to)
    this.lerp = { from, to, start: this.tickBased ? 0 : Date.now(), duration }
  }

  private initialize(x: number, z: number, oldSize: number, newSize: number, speed: number, absoluteMaxSize?: number) {
    this.setCenter(x, z)
    if (speed > 0) this.lerpSize(oldSize, newSize, speed)
    else this.setSize(newSize)
    if (typeof absoluteMaxSize === 'number' && absoluteMaxSize > 0) this.absoluteMaxSize = absoluteMaxSize
  }

  /** WorldBorder.tick (1.21.11+: the moving border's progress) */
  tick() {
    if (this.lerp && this.tickBased) {
      this.lerp.start++
      if (this.lerp.start >= this.lerp.duration) this.setSize(this.lerp.to)
    }
  }

  /** the current diameter */
  getSize() {
    if (!this.lerp) return this.size
    const elapsed = this.tickBased ? this.lerp.start : Date.now() - this.lerp.start
    const t = elapsed / this.lerp.duration
    if (t >= 1) {
      this.setSize(this.lerp.to)
      return this.size
    }
    return this.lerp.from + (this.lerp.to - this.lerp.from) * t
  }

  private clamp(value: number) {
    return Math.max(-this.absoluteMaxSize, Math.min(this.absoluteMaxSize, value))
  }

  getMinX() { return this.clamp(this.centerX - this.getSize() / 2) }
  getMaxX() { return this.clamp(this.centerX + this.getSize() / 2) }
  getMinZ() { return this.clamp(this.centerZ - this.getSize() / 2) }
  getMaxZ() { return this.clamp(this.centerZ + this.getSize() / 2) }

  /**
   * WorldBorder.isWithinBounds(BlockPos): up to 1.20.6 the block overlaps the border box, from 1.21 its corner is
   * inside it
   */
  isWithinBounds(x: number, z: number) {
    const bx = Math.floor(x)
    const bz = Math.floor(z)
    if (this.version()['<']('1.21')) {
      return bx + 1 > this.getMinX() && bx < this.getMaxX() && bz + 1 > this.getMinZ() && bz < this.getMaxZ()
    }
    return bx >= this.getMinX() && bx < this.getMaxX() && bz >= this.getMinZ() && bz < this.getMaxZ()
  }
}
