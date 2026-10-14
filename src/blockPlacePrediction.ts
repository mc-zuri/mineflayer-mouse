import { Bot } from 'mineflayer';
import { activatableBlockWithoutItemPatterns, itemToBlockRemaps } from './itemBlocksStatic';
import  PrismarineBlock, {Block}  from 'prismarine-block'
import { Vec3 } from 'vec3';
import MinecraftData from 'minecraft-data'
import { Shape } from 'prismarine-world/types/iterators';

export const directionToVector = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)]
const directionToAxis = ['y', 'y', 'z', 'z', 'x', 'x']
const directionToFacing = ['south', 'west', 'north', 'east', 'up', 'down']

export type BlockPlacePredictionOverride = (computedBlock: Block) => Block | null | undefined

/** skipInteractionCheck: the caller knows the block does not take the click (the mouse's own block rules) */
export const botTryPlaceBlockPrediction = (bot: Bot, cursorBlock: Block, faceNum: number, delta: Vec3, doWorldUpdate: boolean, doWorldUpdateDelay: number, override: BlockPlacePredictionOverride | null, checkEntities: boolean, skipInteractionCheck = false) => {
    if (!bot.heldItem) return false
    const isSneaking = bot.controlState.sneak;
    const adventurePlaceAllowed = bot.heldItem.blocksCanPlaceOn?.some(([blockName]) => blockName === cursorBlock.name) ?? false
    const isBlockPlaceAction =
        bot.game.gameMode === 'adventure' ? adventurePlaceAllowed : (
            isSneaking || skipInteractionCheck ||
            // not interact action
            activatableBlockWithoutItemPatterns.every(pattern => !pattern.test(cursorBlock.name))
        )
    if (!isBlockPlaceAction) return false;

    const referencePosition = cursorBlock.position.clone()
    const oldBlock = bot.world.getBlock(referencePosition)
    const blockIsEmpty = oldBlock?.shapes.length === 0 // grass
    const directionVector = blockIsEmpty ? new Vec3(0, 0, 0) : directionToVector[faceNum]!
    const placingPosition = referencePosition.plus(directionVector)
    const mcData = MinecraftData(bot.version)
    const itemName = bot.heldItem.name;
    const block = mcData.blocksByName[itemToBlockRemaps[itemName] ?? itemName]
    if (block) {
        const cursorY = delta.y
        let half = cursorY > 0.5 ? 'top' : 'bottom'
        if (faceNum === 0) half = 'top'
        else if (faceNum === 1) half = 'bottom'
        const axis = directionToAxis[faceNum]!
        const facing = directionToFacing[faceNum]!
        const prismarineBlock = PrismarineBlock(bot.version).fromStateId(block.defaultState, 0)
        let finalBlock = getBlockFromProperties(PrismarineBlock(bot.version), prismarineBlock, block, [
            {
                // like slabs
                matchingState: 'type',
                requireValues: ['bottom', 'top', 'double'],
                // todo support double
                value: half
            },
            {
                // like stairs
                matchingState: 'axis',
                requireValues: ['x', 'y', 'z'],
                value: axis
            },
            {
                // like fences, signs
                matchingState: 'facing',
                requireValues: ['north', 'south', 'east', 'west', 'up', 'down'],
                value: facing
            },
        ])
        finalBlock.position = placingPosition
        if (override) {
            const overriddenBlock = override(finalBlock)
            if (overriddenBlock === null) {
                // block placement cancelled
                return false
            } else if (overriddenBlock) {
                finalBlock = overriddenBlock
            }
        }
        const isIntersectsWithEntities = checkEntities ? isBlockIntersectsWithEntities(bot.entities, placingPosition, finalBlock.shapes) : false
        if (isIntersectsWithEntities) {
            // console.log('Intersecting with entity', isIntersectsWithEntities.name)
            return false
        }

        if (doWorldUpdate) {
            const doUpdate = () => {
                bot.world.setBlockStateId(placingPosition, finalBlock.stateId)
            }
            if (doWorldUpdateDelay) {
                let timeout = setTimeout(doUpdate, doWorldUpdateDelay)
                bot.on('end', () => {
                    clearTimeout(timeout)
                })
                bot.on('blockUpdate', (_, newBlock) => {
                    if (newBlock.position.equals(placingPosition)) {
                        clearTimeout(timeout)
                    }
                })
            } else {
                doUpdate()
            }
        }
    }
    return true
}

export const isBlockIntersectsWithEntities = (entities: Bot['entities'], position: Vec3, blockShapes: Shape[]) => {
    for (const entity of Object.values(entities)) {
        const w = entity.width / 2
        const entityShapes = [[-w, 0, -w, w, entity.height, w]] as Shape[]

        // Check each entity shape against each block shape for intersection
        for (const entityShape of entityShapes) {
            // Translate entity shape to entity position
            const translatedEntityShape: Shape = [
                entityShape[0] + entity.position.x,
                entityShape[1] + entity.position.y,
                entityShape[2] + entity.position.z,
                entityShape[3] + entity.position.x,
                entityShape[4] + entity.position.y,
                entityShape[5] + entity.position.z
            ]

            for (const blockShape of blockShapes) {
                // Translate block shape to target position
                const translatedBlockShape: Shape = [
                    blockShape[0] + position.x,
                    blockShape[1] + position.y,
                    blockShape[2] + position.z,
                    blockShape[3] + position.x,
                    blockShape[4] + position.y,
                    blockShape[5] + position.z
                ]

                // Check if boxes intersect
                if (boxesIntersect(translatedEntityShape, translatedBlockShape)) {
                    return entity
                }
            }
        }
    }
    return false
}

// Helper function to check if two boxes intersect
const boxesIntersect = (box1: Shape, box2: Shape): boolean => {
    return (box1[0] <= box2[3] && box1[3] >= box2[0]) && // X axis overlap
           (box1[1] <= box2[4] && box1[4] >= box2[1]) && // Y axis overlap
           (box1[2] <= box2[5] && box1[5] >= box2[2])    // Z axis overlap
}

interface SetBlockProperty {
    matchingState: string
    requireValues?: string[]
    value: string | number | boolean
}

const getBlockFromProperties = (prismarineBlockInstance: typeof Block, prismarineBlock: Block, blockData: MinecraftData.Block, properties: SetBlockProperty[]) => {
    const states = blockData.states;
    if (!states) return prismarineBlock
    const defaultProps = prismarineBlock.getProperties()

    const finalProps = {} as Record<string, any>
    for (const prop of states) {
        const propName = prop.name
        const propValue = properties.find(p => {
            if (p.matchingState !== propName) return false
            if (p.requireValues) {
                if (!p.requireValues.every(v => prop.values?.includes(v))) return false
            }
            return true
        })?.value
        finalProps[propName] = propValue ?? defaultProps[propName]
    }

    return prismarineBlockInstance.fromProperties(blockData.id, finalProps, 0)
}
