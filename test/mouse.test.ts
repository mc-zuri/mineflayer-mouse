import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { Block } from 'prismarine-block'
import { Entity } from 'prismarine-entity'
import { MouseManager, inject } from '../src/mouse'
import { EventEmitter } from 'events'
import * as entityRaycast from '../src/entityRaycast'
import { botTryPlaceBlockPrediction } from '../src/blockPlacePrediction'
import MinecraftData from 'minecraft-data'

// Track method calls and events
interface TestState {
    methodCalls: string[]
    emittedEvents: string[]
}

function createMockBot(testState: TestState): Bot {
    const bot = new EventEmitter() as Bot

    // Track emitted events
    const originalEmit = bot.emit
    bot.version = '1.20.4'
    bot.entities = {} as any
    bot.emit = function (event: string, ...args: any[]) {
        testState.emittedEvents.push(`${event}(${args.map(arg => arg && typeof arg === 'object' ? 'object' : `${arg}`).join(', ')})`)
        //@ts-ignore
        return originalEmit.call(this, event, ...args)
    }

    bot.entity = {
        id: 1,
        position: new Vec3(0, 0, 0),
        onGround: true
    } as any
    bot.game = { gameMode: 'survival' } as any
    bot._client = new EventEmitter() as any
    bot._client.write = vi.fn().mockImplementation((packet) => {
        testState.methodCalls.push(packet)
    })
    bot.canDigBlock = () => true
    bot.digTime = () => 1000 // 1 second break time for survival mode
    bot.blockAtCursor = () => null
    bot.controlState = {
        forward: false,
        back: false,
        left: false,
        right: false,
        jump: false,
        sprint: false,
        sneak: false
    }

    // Track method calls
    bot.dig = vi.fn().mockImplementation(async (block) => {
        testState.methodCalls.push('startdig')
    })
    bot.stopDigging = vi.fn().mockImplementation(() => {
        testState.methodCalls.push('stopdig')
    })
    bot.swingArm = vi.fn()
    bot.attack = vi.fn().mockImplementation((entity) => {
        testState.methodCalls.push('attack')
    })
    bot.supportFeature = () => true as any
    bot.world = {
        getBlockStateId: () => 1,
        setBlock: vi.fn(),
        getBlock: () => null
    } as any
    bot.getControlState = () => false
    //@ts-ignore
    bot._block_placeWithOptions = vi.fn().mockImplementation(async () => {
        testState.methodCalls.push('block_place')
    })
    bot.activateBlock = vi.fn().mockImplementation(async () => {
        testState.methodCalls.push('activateBlock')
    })
    bot.activateItem = vi.fn().mockImplementation(() => {
        testState.methodCalls.push('activateItem')
    })
    bot.deactivateItem = vi.fn().mockImplementation(() => {
        testState.methodCalls.push('deactivateItem')
    })
    bot.inventory = {
        slots: []
    } as any

    return bot
}

function createMockBlock(position: Vec3): Block {
    return {
        position,
        name: 'stone',
        shapes: [[0, 0, 0, 1, 1, 1]],
        face: 1,
        stateId: 1,
        type: 1,
        metadata: 0,
        light: 0,
        intersect: new Vec3(0.5, 1, 0.5),
    } as unknown as Block
}

function createMockEntity(): Entity {
    return {
        id: 2,
        position: new Vec3(1, 1, 1),
        type: 'mob'
    } as Entity
}

// At the top of the file, before tests
vi.mock('../src/entityRaycast', () => ({
    raycastEntity: vi.fn().mockImplementation((bot) => null),
    getEntityHitLocation: vi.fn().mockImplementation(() => new Vec3(0, 0, 0))
}))

describe('MouseManager', () => {
    let bot: Bot
    let mouse: MouseManager
    let testState: TestState

    beforeEach(() => {
        vi.useFakeTimers()
        testState = {
            methodCalls: [],
            emittedEvents: []
        }
        bot = createMockBot(testState)
        mouse = inject(bot, {
            blockPlacePrediction: false,
        })
    })

    // Add test utilities
    const SET_CURSOR_BLOCK = (position: Vec3, face: number = 1, intersect = new Vec3(0.5, 1, 0.5)) => {
        const block = createMockBlock(position) as any
        block.face = face
        block.intersect = intersect
        bot.blockAtCursor = vi.fn().mockReturnValue(block)
        return block
    }

    const LEFT_START = () => bot.leftClickStart()
    const RIGHT_START = () => bot.rightClickStart()
    const LEFT_END = () => bot.leftClickEnd()
    const RIGHT_END = () => bot.rightClickEnd()
    const SERVER_DIG_COMPLETE = (block: Block) => bot.emit('diggingCompleted', block)
    const UPDATE = () => bot.mouse.update()
    const ASSERT_ACTIONS = (expectedActions: string[], skipStopdig = false) => {
        const actions = skipStopdig ? testState.methodCalls.filter(action => action !== 'stopdig') : testState.methodCalls
        expect(actions).toEqual(expectedActions)
        testState.methodCalls = [] // Clear after assertion
    }
    const ASSERT_EVENTS = (expectedEvents: string[]) => {
        expect(testState.emittedEvents).toEqual(expectedEvents)
        testState.emittedEvents = [] // Clear after assertion
    }
    const SET_CURSOR_ENTITY = (entity: Entity = createMockEntity()) => {
        vi.mocked(entityRaycast.raycastEntity).mockReturnValue(entity)
        return entity
    }
    const CLEAR_CURSOR_ENTITY = () => {
        vi.mocked(entityRaycast.raycastEntity).mockReturnValue(null)
    }
    const CLEAR_CURSOR_BLOCK = () => {
        bot.blockAtCursor = vi.fn().mockReturnValue(null)
    }
    const PHYSICS_TICK = () => {
        bot.emit('physicsTick')
        UPDATE()
    }

    afterEach(() => {
        vi.useRealTimers()
        vi.clearAllMocks()
        CLEAR_CURSOR_ENTITY()
    })

    describe('Entity Interaction', () => {
        it('should handle entity attack', () => {
            SET_CURSOR_ENTITY()

            LEFT_START()
            ASSERT_ACTIONS(['attack'], true)

            vi.advanceTimersByTime(500)
            UPDATE()
            ASSERT_ACTIONS([]) // No additional calls

            LEFT_END()
            ASSERT_ACTIONS([]) // Still no additional calls
        })

        it('should handle hold attacking entity', () => {
            SET_CURSOR_BLOCK(new Vec3(1, 1, 1))
            SET_CURSOR_ENTITY()

            LEFT_START()
            ASSERT_ACTIONS(['attack'], true)

            // Entity moves away
            CLEAR_CURSOR_ENTITY()
            CLEAR_CURSOR_BLOCK()
            UPDATE()
            ASSERT_ACTIONS([])

            // Entity comes back
            SET_CURSOR_ENTITY()
            UPDATE()
            ASSERT_ACTIONS([]) // action happens only on first left click

            LEFT_END()
            ASSERT_ACTIONS([])
        })

        it('should handle entity interaction', () => {
            SET_CURSOR_BLOCK(new Vec3(1, 1, 1))
            SET_CURSOR_ENTITY()

            RIGHT_START()
            // the mock bot has no off hand: one interaction
            ASSERT_ACTIONS(['use_entity'], true)

            vi.advanceTimersByTime(500)
            UPDATE()
            ASSERT_ACTIONS([]) // No additional calls

            RIGHT_END()
            ASSERT_ACTIONS([]) // Still no additional calls
        })
    })

    describe('Block Placing', () => {
        beforeEach(() => {
            bot.heldItem = { name: 'stone' } as any
        })


        it('does not predict placing the held block on a copper golem statue', () => {
            const statue = SET_CURSOR_BLOCK(new Vec3(1, 1, 1))
            statue.name = 'oxidized_copper_golem_statue'

            expect(botTryPlaceBlockPrediction(bot, statue, 1, new Vec3(0.5, 1, 0.5), true, 0, null, false)).toBe(false)
            expect(bot.world.setBlock).not.toHaveBeenCalled()
        })
    })

    describe('Item Activation', () => {
        it('should handle item activation', () => {
            bot.heldItem = { name: 'shield' } as any

            RIGHT_START()
            ASSERT_ACTIONS(['activateItem'], true)

            PHYSICS_TICK()
            ASSERT_ACTIONS([])
            for (let i = 0; i < 4; i++) PHYSICS_TICK()
            ASSERT_ACTIONS([])

            RIGHT_END()
            ASSERT_ACTIONS(['deactivateItem'], true)
        })

        it('should handle item activation click-click', () => {
            bot.heldItem = { name: 'shield' } as any

            RIGHT_START()
            ASSERT_ACTIONS(['activateItem'], true)
            RIGHT_END()
            ASSERT_ACTIONS(['deactivateItem'], true)

            RIGHT_START()
            ASSERT_ACTIONS(['activateItem'], true)

            for (let i = 0; i < 4; i++) PHYSICS_TICK()
            ASSERT_ACTIONS([], true)

            RIGHT_END()
            ASSERT_ACTIONS(['deactivateItem'], true)
        })
    })
})
