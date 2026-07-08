import { describe, it, expect } from 'vitest'
import {
    isMeshTaskDifficulty,
    normalizeThinkingLevel,
    normalizeBrainSlot,
    normalizeDifficultyBrainMap,
    DEFAULT_DIFFICULTY_BRAINS,
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
