import { describe, it, expect } from 'vitest'
import {
    isMeshTaskDifficulty,
    normalizeThinkingLevel,
    normalizeBrainSlot,
    normalizeDifficultyBrainMap,
    DEFAULT_DIFFICULTY_BRAINS,
    normalizeNodeCapabilitySlot,
    normalizeNodeCapabilitySlots,
    deriveSlotsFromLegacy,
} from '../src/brain-routing'

describe('brain-routing', () => {
    it('isMeshTaskDifficulty accepts the fixed axis, rejects others', () => {
        for (const d of ['easy', 'medium', 'difficult', 'freeform']) expect(isMeshTaskDifficulty(d)).toBe(true)
        expect(isMeshTaskDifficulty('hard')).toBe(false)
        expect(isMeshTaskDifficulty('')).toBe(false)
        expect(isMeshTaskDifficulty(undefined)).toBe(false)
    })

    it('normalizeThinkingLevel clamps to low/medium/high', () => {
        expect(normalizeThinkingLevel('HIGH')).toBe('high')
        expect(normalizeThinkingLevel('  low ')).toBe('low')
        expect(normalizeThinkingLevel('max')).toBeUndefined()
        expect(normalizeThinkingLevel(3)).toBeUndefined()
    })

    it('normalizeBrainSlot trims and drops empties', () => {
        expect(normalizeBrainSlot({ provider: ' claude-cli ', model: '', thinkingLevel: 'high' }))
            .toEqual({ provider: 'claude-cli', thinkingLevel: 'high' })
        expect(normalizeBrainSlot({ model: 'opus' })).toEqual({ model: 'opus' })
        expect(normalizeBrainSlot({})).toEqual({})
        expect(normalizeBrainSlot(null)).toEqual({})
    })

    it('normalizeDifficultyBrainMap keeps known keys with content, drops the rest', () => {
        const out = normalizeDifficultyBrainMap({
            easy: { model: 'haiku' },
            medium: {},                       // empty → dropped
            bogus: { model: 'x' },            // unknown key → dropped
            difficult: { thinkingLevel: 'high' },
        })
        expect(Object.keys(out).sort()).toEqual(['difficult', 'easy'])
        expect(out.easy).toEqual({ model: 'haiku' })
        expect(out.difficult).toEqual({ thinkingLevel: 'high' })
    })

    it('DEFAULT_DIFFICULTY_BRAINS covers easy/medium/difficult with model+thinking', () => {
        expect(DEFAULT_DIFFICULTY_BRAINS.easy).toEqual({ model: 'haiku', thinkingLevel: 'low' })
        expect(DEFAULT_DIFFICULTY_BRAINS.medium).toEqual({ model: 'sonnet', thinkingLevel: 'medium' })
        expect(DEFAULT_DIFFICULTY_BRAINS.difficult).toEqual({ model: 'opus', thinkingLevel: 'high' })
        expect(DEFAULT_DIFFICULTY_BRAINS.freeform).toBeUndefined()
    })
})

describe('node capability slots', () => {
    it('normalizeNodeCapabilitySlot requires a provider and cleans fields', () => {
        expect(normalizeNodeCapabilitySlot({ model: 'opus' })).toBeNull()
        expect(normalizeNodeCapabilitySlot({ provider: '  ' })).toBeNull()
        expect(normalizeNodeCapabilitySlot({
            provider: ' claude-cli ',
            model: ' opus ',
            thinkingLevel: 'HIGH',
            difficulty: ['difficult', 'nope', 'medium'],
            capability: [' worktree ', '', 'os=darwin'],
            maxParallel: '2',
        })).toEqual({
            provider: 'claude-cli',
            model: 'opus',
            thinkingLevel: 'high',
            difficulty: ['difficult', 'medium'],
            capability: ['worktree', 'os=darwin'],
            maxParallel: 2,
        })
    })

    it('normalizeNodeCapabilitySlot drops empty/invalid optionals', () => {
        expect(normalizeNodeCapabilitySlot({ provider: 'codex-cli', maxParallel: 0, difficulty: [], capability: [] }))
            .toEqual({ provider: 'codex-cli' })
    })

    it('normalizeNodeCapabilitySlots drops provider-less entries', () => {
        const slots = normalizeNodeCapabilitySlots([
            { provider: 'claude-cli' },
            { model: 'opus' },
            'garbage',
            { provider: 'codex-cli', maxParallel: 3 },
        ])
        expect(slots).toEqual([
            { provider: 'claude-cli' },
            { provider: 'codex-cli', maxParallel: 3 },
        ])
    })

    it('deriveSlotsFromLegacy returns [] with no providerPriority', () => {
        expect(deriveSlotsFromLegacy({})).toEqual([])
        expect(deriveSlotsFromLegacy({ providerPriority: [] })).toEqual([])
    })

    it('deriveSlotsFromLegacy maps priority order → slots and folds roles + shared brains', () => {
        const slots = deriveSlotsFromLegacy({
            providerPriority: ['claude-cli', 'codex-cli'],
            providerRoles: [{ providerType: 'codex-cli', maxParallel: 2 }],
            // provider-agnostic brains apply to every slot as a shared model/thinking default
            difficultyBrains: {
                difficult: { model: 'opus', thinkingLevel: 'high' },
                easy: { model: 'haiku', thinkingLevel: 'low' },
            },
        })
        expect(slots).toHaveLength(2)
        // order preserved from providerPriority
        expect(slots[0].provider).toBe('claude-cli')
        expect(slots[1].provider).toBe('codex-cli')
        // per-provider maxParallel folded onto the matching slot only
        expect(slots[0].maxParallel).toBeUndefined()
        expect(slots[1].maxParallel).toBe(2)
        // shared brains → difficulty range on each slot (first model/thinking wins)
        expect(slots[0].difficulty).toEqual(['easy', 'difficult'])
        expect(slots[0].model).toBe('haiku')
        expect(slots[0].thinkingLevel).toBe('low')
    })

    it('deriveSlotsFromLegacy honors provider-specific brains over shared', () => {
        const slots = deriveSlotsFromLegacy({
            providerPriority: ['claude-cli', 'codex-cli'],
            difficultyBrains: {
                // provider-specific: only the claude slot gets difficult
                difficult: { provider: 'claude-cli', model: 'opus', thinkingLevel: 'high' },
            },
        })
        const claude = slots.find(s => s.provider === 'claude-cli')!
        const codex = slots.find(s => s.provider === 'codex-cli')!
        expect(claude.difficulty).toEqual(['difficult'])
        expect(claude.model).toBe('opus')
        // codex has no specific brain and no shared → no difficulty/model
        expect(codex.difficulty).toBeUndefined()
        expect(codex.model).toBeUndefined()
    })
})
