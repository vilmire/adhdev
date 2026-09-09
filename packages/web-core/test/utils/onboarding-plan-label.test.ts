import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { describeOnboardingPlanFailure } from '../../src/utils/onboarding-plan-label'

const read = (rel: string) => fs.readFileSync(path.join(import.meta.dirname, rel), 'utf8')

/**
 * ★ G5-6 THE LEAKED-ERROR-CODE REGRESSION.
 *
 * plan_mesh_onboarding failures used to render as
 * `${code || 'onboarding_blocked'}: ${error} ${action}` directly to the
 * user in three places — MeshNodeList.tsx, MeshCreateForm.tsx, and (thrown
 * as an Error message that flows into setError) useMeshNodeActions.ts — so
 * a real failure read e.g. "onboarding_blocked: not a git repository ".
 */
describe('describeOnboardingPlanFailure — G5-6 no raw snake_case code prefix', () => {
    it('never includes the raw code, even when one is present', () => {
        const text = describeOnboardingPlanFailure({ error: 'not a git repository' } as any)
        expect(text).not.toMatch(/onboarding_blocked/)
        expect(text).not.toMatch(/[a-z]+_[a-z]+:/)
    })

    it('shows the error and action, in that order, with no leading code', () => {
        const text = describeOnboardingPlanFailure({ error: 'not a git repository', action: 'Choose a different folder.' })
        expect(text).toBe('not a git repository Choose a different folder.')
    })

    it('falls back to a friendly generic message when error is missing', () => {
        const text = describeOnboardingPlanFailure({})
        expect(text).toBe('Git discovery failed')
    })

    it('omits the action when absent, without a trailing space artifact', () => {
        const text = describeOnboardingPlanFailure({ error: 'not a git repository' })
        expect(text).toBe('not a git repository')
    })

    it('handles null/undefined plan gracefully', () => {
        expect(describeOnboardingPlanFailure(null)).toBe('Git discovery failed')
        expect(describeOnboardingPlanFailure(undefined)).toBe('Git discovery failed')
    })
})

describe('G5-6 all three call sites use the shared helper, not an inline code-prefixed template', () => {
    it('MeshNodeList.tsx has no onboarding_blocked literal', () => {
        const source = read('../../src/pages/repo-mesh/MeshNodeList.tsx')
        expect(source).not.toContain('onboarding_blocked')
        expect(source).toContain('describeOnboardingPlanFailure')
    })

    it('MeshCreateForm.tsx has no onboarding_blocked literal', () => {
        const source = read('../../src/components/mesh-onboarding/MeshCreateForm.tsx')
        expect(source).not.toContain('onboarding_blocked')
        expect(source).toContain('describeOnboardingPlanFailure')
    })

    it('useMeshNodeActions.ts has no onboarding_blocked literal', () => {
        const source = read('../../src/pages/repo-mesh/useMeshNodeActions.ts')
        expect(source).not.toContain('onboarding_blocked')
        expect(source).toContain('describeOnboardingPlanFailure')
    })
})
