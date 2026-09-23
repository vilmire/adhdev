import { describe, expect, it } from 'vitest'
import {
    MISSION_BRIEF_RENDER_MAX_CHARS,
    normalizeMissionBrief,
    renderMissionBriefBlock,
} from '../src/mission-brief'

describe('normalizeMissionBrief', () => {
    it('returns brief: null when there is no usable goal', () => {
        expect(normalizeMissionBrief(undefined)).toEqual({ brief: null, truncated: [] })
        expect(normalizeMissionBrief(null)).toEqual({ brief: null, truncated: [] })
        expect(normalizeMissionBrief({})).toEqual({ brief: null, truncated: [] })
        expect(normalizeMissionBrief({ goal: '   ' })).toEqual({ brief: null, truncated: [] })
        expect(normalizeMissionBrief('just a string')).toEqual({ brief: null, truncated: [] })
    })

    it('normalizes a minimal brief (goal only)', () => {
        const { brief, truncated } = normalizeMissionBrief({ goal: 'Ship the thing' })
        expect(brief).toEqual({ goal: 'Ship the thing' })
        expect(truncated).toEqual([])
    })

    it('normalizes every optional field, accepting both camelCase and snake_case', () => {
        const { brief } = normalizeMissionBrief({
            goal: 'g',
            constraints: ['no npm install'],
            done_criteria: ['tests green'],
            handoffNotes: ['ask alice'],
            owned_paths: ['src/foo.ts'],
        })
        expect(brief).toEqual({
            goal: 'g',
            constraints: ['no npm install'],
            doneCriteria: ['tests green'],
            handoffNotes: ['ask alice'],
            ownedPaths: ['src/foo.ts'],
        })
    })

    it('camelCase alias wins when both spellings are present', () => {
        const { brief } = normalizeMissionBrief({
            goal: 'g',
            doneCriteria: ['camel wins'],
            done_criteria: ['snake loses'],
        })
        expect(brief?.doneCriteria).toEqual(['camel wins'])
    })

    it('trims and drops empty/non-string list entries', () => {
        const { brief } = normalizeMissionBrief({ goal: 'g', constraints: ['  a  ', '', '   ', 42, null, 'b'] })
        expect(brief?.constraints).toEqual(['a', 'b'])
    })

    it('caps the goal length and reports truncation', () => {
        const long = 'x'.repeat(600)
        const { brief, truncated } = normalizeMissionBrief({ goal: long })
        expect(brief?.goal.length).toBeLessThanOrEqual(500)
        expect(brief?.goal.endsWith('…')).toBe(true)
        expect(truncated).toContainEqual({ field: 'goal', reason: 'field_too_long' })
    })

    it('caps individual list items and reports truncation', () => {
        const longItem = 'y'.repeat(300)
        const { brief, truncated } = normalizeMissionBrief({ goal: 'g', constraints: [longItem] })
        expect(brief?.constraints?.[0].length).toBeLessThanOrEqual(200)
        expect(truncated).toContainEqual({ field: 'constraints', reason: 'item_too_long' })
    })

    it('caps list length and reports truncation', () => {
        const many = Array.from({ length: 20 }, (_, i) => `item${i}`)
        const { brief, truncated } = normalizeMissionBrief({ goal: 'g', constraints: many })
        expect(brief?.constraints?.length).toBe(12)
        expect(truncated).toContainEqual({ field: 'constraints', reason: 'list_too_long' })
    })

    it('omits an optional field entirely when its list normalizes to empty', () => {
        const { brief } = normalizeMissionBrief({ goal: 'g', constraints: ['', '   '] })
        expect(brief).toEqual({ goal: 'g' })
        expect(brief).not.toHaveProperty('constraints')
    })
})

describe('renderMissionBriefBlock', () => {
    it('renders a minimal brief deterministically', () => {
        const block = renderMissionBriefBlock({ goal: 'Ship the thing' })
        expect(block).toBe('Mission goal: Ship the thing')
    })

    it('renders sections in a fixed order: goal, constraints, done criteria, owned paths, handoff notes', () => {
        const block = renderMissionBriefBlock({
            goal: 'g',
            handoffNotes: ['note1'],
            ownedPaths: ['src/a.ts'],
            doneCriteria: ['done1'],
            constraints: ['constraint1'],
        })
        const goalIdx = block.indexOf('Mission goal:')
        const constraintsIdx = block.indexOf('Constraints:')
        const doneIdx = block.indexOf('Done when:')
        const ownedIdx = block.indexOf('Owned paths:')
        const handoffIdx = block.indexOf('Handoff notes:')
        expect(goalIdx).toBeLessThan(constraintsIdx)
        expect(constraintsIdx).toBeLessThan(doneIdx)
        expect(doneIdx).toBeLessThan(ownedIdx)
        expect(ownedIdx).toBeLessThan(handoffIdx)
        expect(block).toContain('- constraint1')
        expect(block).toContain('- done1')
        expect(block).toContain('- src/a.ts')
        expect(block).toContain('- note1')
    })

    it('two renders of the same brief object produce byte-identical output', () => {
        const brief = { goal: 'g', constraints: ['a', 'b'], doneCriteria: ['c'] }
        expect(renderMissionBriefBlock(brief)).toBe(renderMissionBriefBlock(brief))
    })

    it('never exceeds MISSION_BRIEF_RENDER_MAX_CHARS, and truncation drops whole trailing sections with a marker', () => {
        const brief = {
            goal: 'g'.repeat(400),
            constraints: Array.from({ length: 12 }, (_, i) => `constraint-${i}-${'z'.repeat(150)}`),
            doneCriteria: Array.from({ length: 12 }, (_, i) => `done-${i}-${'z'.repeat(150)}`),
            handoffNotes: Array.from({ length: 12 }, (_, i) => `note-${i}-${'z'.repeat(150)}`),
        }
        const block = renderMissionBriefBlock(brief)
        expect(block.length).toBeLessThanOrEqual(MISSION_BRIEF_RENDER_MAX_CHARS)
        expect(block.endsWith('(brief truncated)')).toBe(true)
        // Never cut mid-line: every line up to the marker is a full section heading or full '- item' line.
        const bodyLines = block.slice(0, block.length - '\n(brief truncated)'.length).split('\n')
        for (const line of bodyLines) {
            expect(line === '' || line.endsWith(':') || line.startsWith('- ') || line.startsWith('Mission goal:')).toBe(true)
        }
    })

    it('a brief so large even the goal alone cannot fit still returns a bounded, marked string', () => {
        const block = renderMissionBriefBlock({ goal: 'g'.repeat(5000) })
        expect(block.length).toBeLessThanOrEqual(MISSION_BRIEF_RENDER_MAX_CHARS)
        expect(block.endsWith('(brief truncated)')).toBe(true)
    })
})
