import { describe, expect, it } from 'vitest'
import {
    formatStageVerdictLine,
    resolveStagePlan,
    reviewIndependenceOf,
    validateFindingResponses,
    validateReviewReport,
    renderWorkerProtocolFooter,
} from '../src'

const finding = (over: Record<string, unknown> = {}) => ({
    id: 'f1', severity: 'major', category: 'correctness', claim: 'off by one', evidence: 'read loop in a.ts', ...over,
})
const base = (over: Record<string, unknown> = {}) => ({
    verdict: 'approve', findings: [], checked: ['diff'], notChecked: ['perf'], ...over,
})

describe('validateReviewReport', () => {
    it('accepts a clean approve', () => {
        const { report, errors } = validateReviewReport(base(), { round: 1 })
        expect(errors).toEqual([])
        expect(report?.verdict).toBe('approve')
    })

    it('rejects changes_requested without blocking/major findings', () => {
        const { errors } = validateReviewReport(base({ verdict: 'changes_requested', findings: [finding({ severity: 'nit' })] }), { round: 1 })
        expect(errors.map(e => e.message).join()).toMatch(/at least one blocking or major/)
    })

    it('rejects approve that carries a major finding', () => {
        const { errors } = validateReviewReport(base({ verdict: 'approve', findings: [finding()] }), { round: 1 })
        expect(errors.some(e => /approve cannot carry/.test(e.message))).toBe(true)
    })

    it('rejects empty checked / notChecked (empty review)', () => {
        const { errors } = validateReviewReport(base({ checked: [], notChecked: [] }), { round: 1 })
        expect(errors.map(e => e.field)).toEqual(expect.arrayContaining(['review.checked', 'review.notChecked']))
    })

    it('requires priorFindings for every prior blocking id from round 2', () => {
        const missing = validateReviewReport(base(), { round: 2, priorOpenBlockingIds: ['f1'] })
        expect(missing.errors[0].message).toMatch(/missing: f1/)
        const ok = validateReviewReport(base({ priorFindings: [{ id: 'f1', status: 'resolved' }] }), { round: 2, priorOpenBlockingIds: ['f1'] })
        expect(ok.errors).toEqual([])
    })

    it('rejects over-long claim, unknown keys and duplicate ids', () => {
        const long = validateReviewReport(base({ verdict: 'changes_requested', findings: [finding({ claim: 'x'.repeat(501) })] }), { round: 1 })
        expect(long.errors.some(e => e.field.endsWith('.claim'))).toBe(true)
        const unknown = validateReviewReport(base({ nope: 1 }), { round: 1 })
        expect(unknown.errors.some(e => e.field === 'review.nope')).toBe(true)
        const dup = validateReviewReport(base({ verdict: 'changes_requested', findings: [finding(), finding()] }), { round: 1 })
        expect(dup.errors.some(e => /duplicate finding id/.test(e.message))).toBe(true)
    })

    it('rejects more than 30 findings', () => {
        const many = Array.from({ length: 31 }, (_, i) => finding({ id: `f${i}`, severity: 'nit' }))
        const { errors } = validateReviewReport(base({ verdict: 'approve_with_nits', findings: many }), { round: 1 })
        expect(errors.some(e => /over the 30 limit/.test(e.message))).toBe(true)
    })
})

describe('validateFindingResponses', () => {
    it('requires a note and a valid response kind', () => {
        expect(validateFindingResponses([{ id: 'f1', response: 'fixed', note: 'done' }]).responses).toHaveLength(1)
        expect(validateFindingResponses([{ id: 'f1', response: 'maybe', note: 'x' }]).errors.length).toBeGreaterThan(0)
        expect(validateFindingResponses([{ id: 'f1', response: 'fixed', note: '' }]).errors.length).toBeGreaterThan(0)
    })
})

describe('resolveStagePlan (opt-in review)', () => {
    it('is off by default; defaultOn restores the medium/difficult code_change default', () => {
        // Owner decision 2026-11-08: review is opt-in — an unset option never starts a pipeline.
        expect(resolveStagePlan(undefined, { taskMode: 'code_change', difficulty: 'medium' })).toBeNull()
        expect(resolveStagePlan(undefined, { taskMode: 'code_change', difficulty: 'difficult' })).toBeNull()
        expect(resolveStagePlan(true, { taskMode: 'code_change', difficulty: 'medium' })).toMatchObject({ review: true, maxRevisions: 2, independence: 'fresh_session_ok' })
        expect(resolveStagePlan(undefined, { taskMode: 'code_change', difficulty: 'medium' }, { defaultOn: true })).toMatchObject({ review: true, maxRevisions: 2, independence: 'fresh_session_ok' })
        expect(resolveStagePlan(undefined, { taskMode: 'code_change', difficulty: 'difficult' }, { defaultOn: true })).not.toBeNull()
        expect(resolveStagePlan(undefined, { taskMode: 'code_change', difficulty: 'easy' })).toBeNull()
        expect(resolveStagePlan(undefined, { taskMode: 'code_change', difficulty: 'freeform' })).toBeNull()
        expect(resolveStagePlan(undefined, { taskMode: 'validation', difficulty: 'medium' })).toBeNull()
        expect(resolveStagePlan(undefined, { taskMode: 'code_change', difficulty: 'medium', readonly: true })).toBeNull()
    })
    it('honors explicit opt-out and options, rejects bad input', () => {
        expect(resolveStagePlan(false, { taskMode: 'code_change', difficulty: 'medium' })).toBeNull()
        expect(resolveStagePlan(true, { taskMode: 'code_change', difficulty: 'easy' })).not.toBeNull()
        expect(resolveStagePlan({ max_revisions: 0, independence: 'different_provider' }, { taskMode: 'code_change' })).toMatchObject({ maxRevisions: 0, independence: 'different_provider' })
        expect(() => resolveStagePlan({ max_revisions: 4 }, { taskMode: 'code_change' })).toThrow(/invalid_review_option/)
        expect(() => resolveStagePlan({ bogus: 1 }, { taskMode: 'code_change' })).toThrow(/invalid_review_option/)
        expect(() => resolveStagePlan(true, { taskMode: 'validation' })).toThrow(/invalid_review_option/)
    })
})

describe('legacy review constraint + footer + verdict line', () => {
    it('reads a legacy differentProvider:true row as different_provider', () => {
        expect(reviewIndependenceOf({ differentProvider: true })).toBe('different_provider')
        expect(reviewIndependenceOf({ independence: 'fresh_session' })).toBe('fresh_session')
    })
    it('renders the stage footer variants', () => {
        expect(renderWorkerProtocolFooter({ stage: { role: 'review', round: 1, maxRevisions: 2, workspace: '/opt/ws' } })).toContain('independent reviewer')
        expect(renderWorkerProtocolFooter({ stage: { role: 'revise', round: 2, maxRevisions: 2 } })).toContain('finding_responses')
        expect(renderWorkerProtocolFooter({})).not.toContain('STAGE:')
    })
    it('formats the verdict line', () => {
        expect(formatStageVerdictLine({ verdict: 'approve_with_nits', rounds: 2, reviewerProvider: 'codex-cli', independenceUsed: 'different_provider', fixed: 3, openNits: 1 }))
            .toBe('review: approve_with_nits · 2 rounds · reviewer codex-cli (different_provider) · 3 findings fixed, 1 nit open')
        expect(formatStageVerdictLine({ verdict: 'skipped_no_diff', rounds: 0 })).toBe('review: skipped_no_diff')
    })
})
