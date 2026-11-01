import { describe, expect, it } from 'vitest'
import { aggregateMissionGitState } from '../src/mission-git-state'

describe('aggregateMissionGitState', () => {
    it('no refs', () => {
        expect(aggregateMissionGitState([])).toMatchObject({ state: 'no_refs', partialUnknown: false })
    })
    it('all contained (either method) is landed', () => {
        expect(aggregateMissionGitState(['contained_ancestor', 'contained_patch_equivalent']).state).toBe('landed')
    })
    it('some contained is partial; unknown among the rest sets partialUnknown', () => {
        expect(aggregateMissionGitState(['contained_ancestor', 'not_contained'])).toMatchObject({ state: 'partial', partialUnknown: false })
        expect(aggregateMissionGitState(['contained_ancestor', 'unknown'])).toMatchObject({ state: 'partial', partialUnknown: true })
    })
    it('all not_contained is not_landed; any unknown with nothing contained is unknown (never not_landed)', () => {
        expect(aggregateMissionGitState(['not_contained', 'not_contained']).state).toBe('not_landed')
        expect(aggregateMissionGitState(['not_contained', 'unknown']).state).toBe('unknown')
        expect(aggregateMissionGitState(['unknown']).state).toBe('unknown')
    })
})
