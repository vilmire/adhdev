import { describe, expect, it } from 'vitest'
import { stageChip } from '../src/utils/stage-chip'

describe('stageChip', () => {
    it('is null for ordinary tasks', () => {
        expect(stageChip(null)).toBeNull()
        expect(stageChip({})).toBeNull()
        expect(stageChip({ stageState: { phase: 'bogus' } })).toBeNull()
    })
    it('maps pipeline phases, with the round once a review started', () => {
        expect(stageChip({ stageState: { phase: 'implementing', round: 0 } })).toEqual({ key: 'stageImplementing', tone: 'active' })
        expect(stageChip({ stageState: { phase: 'reviewing', round: 2 } })).toEqual({ key: 'stageReviewing', round: 2, tone: 'active' })
        expect(stageChip({ stageState: { phase: 'done', round: 1 } })).toMatchObject({ key: 'stageDone', tone: 'done' })
    })
    it('marks a review child with its round', () => {
        expect(stageChip({ origin: 'stage', stageRole: 'review', stageRound: 3 })).toEqual({ key: 'stageReviewChild', round: 3, tone: 'muted' })
    })
})
