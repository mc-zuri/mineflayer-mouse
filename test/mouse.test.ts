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

    describe('Block Breaking', () => {
        it('Survival hold break sequence multi-test', () => {
            const block1 = SET_CURSOR_BLOCK(new Vec3(1, 1, 1))

            // DIG START
            LEFT_START()
            ASSERT_ACTIONS(['stopdig', 'startdig'])
            ASSERT_EVENTS(['highlightCursorBlock(object)', 'startDigging(object)', 'botArmSwingStart(right)'])

            // DIG PROGRESS
            vi.advanceTimersByTime(100)
            UPDATE()
            ASSERT_EVENTS(['blockBreakProgressStage(object, 1)'])

            // DIG COMPLETE -> NEXT BLOCK -> WAIT
            SERVER_DIG_COMPLETE(block1)
            SET_CURSOR_BLOCK(new Vec3(2, 2, 2))
            UPDATE()
            ASSERT_ACTIONS(['stopdig'])
            ASSERT_EVENTS([
                "diggingCompleted(object)",
                "blockBreakProgressStage(object, null)",
                "highlightCursorBlock(object)",
            ])

            // DIG START
            vi.advanceTimersByTime(400)
            UPDATE()
            ASSERT_ACTIONS(['startdig'])
            ASSERT_EVENTS(["startDigging(object)", "botArmSwingStart(right)"])

            // DIG IN-MID BLOCK CHANGE (IMMEDIATELY SWITCH DIGGING)
            const block2 = SET_CURSOR_BLOCK(new Vec3(3, 3, 3))
            UPDATE()
            ASSERT_ACTIONS(['stopdig', 'startdig'])
            ASSERT_EVENTS(["highlightCursorBlock(object)", "startDigging(object)", "botArmSwingStart(right)"])

            // DIG PROGRESS
            vi.advanceTimersByTime(400)
            UPDATE()
            ASSERT_ACTIONS([])
            ASSERT_EVENTS(["blockBreakProgressStage(object, 4)"])

            // DIG COMPLETE -> NEXT BLOCK -> WAIT
            SERVER_DIG_COMPLETE(block2)
            SET_CURSOR_BLOCK(new Vec3(4, 4, 4))
            UPDATE()
            ASSERT_ACTIONS(['stopdig'])
            ASSERT_EVENTS(["diggingCompleted(object)", "blockBreakProgressStage(object, null)", "highlightCursorBlock(object)"])

            // DIG START
            vi.advanceTimersByTime(400)
            UPDATE()
            ASSERT_ACTIONS(['startdig'])

            // WE STOP DIGGING
            LEFT_END()
            ASSERT_ACTIONS(['stopdig'])
            LEFT_START()
            ASSERT_ACTIONS(['startdig'])
            LEFT_END()
            ASSERT_ACTIONS(['stopdig'])
        })

        it('Survival jump on the same block (conditions change but no dig time change)', () => {
            const block1 = SET_CURSOR_BLOCK(new Vec3(1, 1, 1))
            LEFT_START()
            ASSERT_ACTIONS(['stopdig', 'startdig'])
            vi.advanceTimersByTime(100)
            UPDATE()
            bot.entity.onGround = false
            UPDATE()
            // we dont change dig time in this test!
            ASSERT_ACTIONS([])
            bot.entity.onGround = true
            UPDATE()
            ASSERT_ACTIONS([])
            LEFT_END()
        })

        it('Validate events after in-mid block change', () => {
            const block1 = SET_CURSOR_BLOCK(new Vec3(1, 1, 1))
            LEFT_START()
            ASSERT_ACTIONS(['stopdig', 'startdig'])
            vi.advanceTimersByTime(100)
            UPDATE()
            testState.emittedEvents = []
            CLEAR_CURSOR_BLOCK()
            UPDATE()
            ASSERT_ACTIONS(['stopdig'])
            ASSERT_EVENTS(['highlightCursorBlock(undefined)', 'blockBreakProgressStage(object, null)', 'botArmSwingEnd(right)'])
        })
        it('Validate events after complete block change', () => {
            const block1 = SET_CURSOR_BLOCK(new Vec3(1, 1, 1))
            LEFT_START()
            ASSERT_ACTIONS(['stopdig', 'startdig'])
            vi.advanceTimersByTime(100)
            UPDATE()
            testState.emittedEvents = []
            SERVER_DIG_COMPLETE(block1)
            CLEAR_CURSOR_BLOCK()
            UPDATE()
            ASSERT_ACTIONS(['stopdig'])
            ASSERT_EVENTS(['diggingCompleted(object)', 'blockBreakProgressStage(object, null)', 'highlightCursorBlock(undefined)', 'botArmSwingEnd(right)'])
        })

        it('Creative hold break sequence', () => {
            bot.game.gameMode = 'creative'
            bot.digTime = () => 0

            const block1 = SET_CURSOR_BLOCK(new Vec3(1, 1, 1))

            LEFT_START()
            ASSERT_ACTIONS(['stopdig', 'startdig'])

            SERVER_DIG_COMPLETE(block1)

            SET_CURSOR_BLOCK(new Vec3(2, 2, 2))
            UPDATE()
            ASSERT_ACTIONS(['stopdig'])
            LEFT_START()
            ASSERT_ACTIONS([])

            // we have 250 delay
            vi.advanceTimersByTime(200)
            UPDATE()
            ASSERT_ACTIONS([])
            vi.advanceTimersByTime(200)
            UPDATE()
            ASSERT_ACTIONS(['startdig'])

            LEFT_END()
            ASSERT_ACTIONS(['stopdig'])
        })

        it('Creative click click break sequence', () => {
            bot.game.gameMode = 'creative'
            bot.digTime = () => 0

            const block1 = SET_CURSOR_BLOCK(new Vec3(1, 1, 1))

            LEFT_START()
            ASSERT_ACTIONS(['stopdig', 'startdig'])

            SERVER_DIG_COMPLETE(block1)

            SET_CURSOR_BLOCK(new Vec3(2, 2, 2))
            UPDATE()
            LEFT_END()
            LEFT_START()
            vi.advanceTimersByTime(400)
            UPDATE()
            ASSERT_ACTIONS(['stopdig', 'stopdig', 'startdig'])

            SERVER_DIG_COMPLETE(block1)
            LEFT_END()
            ASSERT_ACTIONS(['stopdig'])
        })

        it('should handle break sequence with entity interference', () => {
            const block = SET_CURSOR_BLOCK(new Vec3(1, 1, 1))

            LEFT_START()
            ASSERT_ACTIONS(['stopdig', 'startdig'])

            SET_CURSOR_ENTITY()
            bot.emit('physicsTick')
            UPDATE()
            expect(bot.mouse.debugDigStatus).toBe('stopped by entity interference')
            ASSERT_ACTIONS(['stopdig'])

            CLEAR_CURSOR_ENTITY()
            bot.emit('physicsTick')
            vi.advanceTimersByTime(400)
            UPDATE()
            ASSERT_ACTIONS(['stopdig', 'startdig'])

            LEFT_END()
            ASSERT_ACTIONS(['stopdig'])
        })

        it('resumes breaking when block stays at same position after diggingCompleted (e.g. oneblock)', () => {
            const pos = new Vec3(1, 1, 1)
            const block = SET_CURSOR_BLOCK(pos)

            LEFT_START()
            ASSERT_ACTIONS(['stopdig', 'startdig'])

            // Server completes break; may place same block again (oneblock) or new block at same position
            SERVER_DIG_COMPLETE(block)

            // Cursor still at same position; after 5-tick delay we should resume
            vi.advanceTimersByTime(260)
            bot.emit('physicsTick')
            ASSERT_ACTIONS(['startdig'])

            LEFT_END()
            ASSERT_ACTIONS(['stopdig'])
        })
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

        it('should handle hold block placement with item', () => {
            SET_CURSOR_BLOCK(new Vec3(1, 1, 1))

            RIGHT_START()
            PHYSICS_TICK()
            ASSERT_ACTIONS(['block_place'], true)

            // Should place again after delay
            for (let i = 0; i < 5; i++) PHYSICS_TICK()
            ASSERT_ACTIONS(['block_place'])
            UPDATE()
            ASSERT_ACTIONS([])

            for (let i = 0; i < 5; i++) PHYSICS_TICK()
            ASSERT_ACTIONS(['block_place'])
            UPDATE()

            RIGHT_END()
            PHYSICS_TICK()
            ASSERT_ACTIONS([]) // No additional placements
        })

        it('should handle block activation without item', () => {
            bot.heldItem = null
            SET_CURSOR_BLOCK(new Vec3(1, 1, 1))

            RIGHT_START()
            PHYSICS_TICK()
            ASSERT_ACTIONS(['block_place'], true)

            // Should activate again after delay
            for (let i = 0; i < 5; i++) PHYSICS_TICK()
            ASSERT_ACTIONS(['block_place'], true)

            RIGHT_END()
            PHYSICS_TICK()
            ASSERT_ACTIONS([])
        })

        it('should handle click click block placement', () => {
            SET_CURSOR_BLOCK(new Vec3(1, 1, 1))

            RIGHT_START()
            PHYSICS_TICK()
            ASSERT_ACTIONS(['block_place'], true)

            RIGHT_END()

            SET_CURSOR_BLOCK(new Vec3(2, 2, 2))

            RIGHT_START()
            ASSERT_ACTIONS(['block_place'], true)
            // for (let i = 0; i < 5; i++) PHYSICS_TICK()
            // ASSERT_ACTIONS(['block_place'], true)

            RIGHT_END()
            PHYSICS_TICK()
            ASSERT_ACTIONS([])
        })

        describe('off-hand use', () => {
            beforeEach(() => {
                // a real version's features, so the off-hand slot exists
                bot.supportFeature = MinecraftData(bot.version).supportFeature as any
                bot.heldItem = null
            })

            const usedHands = () => vi.mocked(bot._client.write).mock.calls
                .filter(([name]) => name === 'block_place')
                .map(([, data]) => data.hand)

            it('tries the off-hand on a block that does not take the click', () => {
                SET_CURSOR_BLOCK(new Vec3(1, 1, 1))

                RIGHT_START()
                PHYSICS_TICK()
                expect(usedHands()).toEqual([0, 1])
            })

            it('does not try the off-hand on a copper golem statue, which takes the click', () => {
                // vanilla cycles the pose once per click; an off-hand use_item_on cycled it a second time
                SET_CURSOR_BLOCK(new Vec3(1, 1, 1)).name = 'copper_golem_statue'

                RIGHT_START()
                PHYSICS_TICK()
                expect(usedHands()).toEqual([0])
            })
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
