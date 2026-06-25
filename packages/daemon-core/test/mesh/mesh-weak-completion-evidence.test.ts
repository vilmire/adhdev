import { describe, expect, it } from 'vitest';
import {
    isWeakCompletionEvidence,
    isWeakCompletionMetadata,
    isFalseIdleCompletion,
    isMissingFinalAssistantDiagnostic,
} from '../../src/mesh/mesh-events-utils.js';

// D-1: the weak-completion judgement used to be copy-pasted into FOUR diverged variants —
// two ledger-payload checks (mesh-events-coordinator / mesh-events-stale) that OMITTED the
// evidenceLevel:'weak' branch, and two metadata checks (mesh-events-pending / utils) that
// included it. Consolidated to one isWeakCompletionEvidence, applied to BOTH the ledger and
// metadata paths, so a producer that one day emits evidenceLevel:'weak' can no longer have its
// weak terminal misjudged as authoritative on the ledger path (which would block a genuine
// completion from superseding it — the FALSEIDLE regression).
describe('isWeakCompletionEvidence — unified weak-completion judgement', () => {
    it('treats evidenceLevel "insufficient" as weak', () => {
        expect(isWeakCompletionEvidence({ evidenceLevel: 'insufficient' })).toBe(true);
    });

    // The branch the ledger variants used to omit — the core of D-1.
    it('treats evidenceLevel "weak" as weak (the previously-divergent ledger branch)', () => {
        expect(isWeakCompletionEvidence({ evidenceLevel: 'weak' })).toBe(true);
    });

    it('treats reviewRecommended === true as weak', () => {
        expect(isWeakCompletionEvidence({ reviewRecommended: true })).toBe(true);
    });

    it('treats a missing-final-assistant completionDiagnostic as weak', () => {
        expect(isWeakCompletionEvidence({
            completionDiagnostic: { finalAssistantPresent: false },
        })).toBe(true);
        expect(isWeakCompletionEvidence({
            completionDiagnostic: { blockReason: 'missing_final_assistant' },
        })).toBe(true);
    });

    it('is NOT weak for a genuine completion (sufficient evidence, final assistant present)', () => {
        expect(isWeakCompletionEvidence({
            evidenceLevel: 'sufficient',
            finalSummary: 'done',
            completionDiagnostic: { finalAssistantPresent: true },
        })).toBe(false);
    });

    it('is NOT weak for an empty/absent payload', () => {
        expect(isWeakCompletionEvidence(undefined)).toBe(false);
        expect(isWeakCompletionEvidence({})).toBe(false);
    });

    it('isWeakCompletionMetadata is an exact alias of isWeakCompletionEvidence', () => {
        for (const record of [
            { evidenceLevel: 'weak' },
            { evidenceLevel: 'insufficient' },
            { reviewRecommended: true },
            { completionDiagnostic: { finalAssistantPresent: false } },
            { finalSummary: 'done' },
            {},
        ]) {
            expect(isWeakCompletionMetadata(record)).toBe(isWeakCompletionEvidence(record));
        }
    });
});

// isFalseIdleCompletion is the NARROW subset that isGenuineCompletionEvidence gates on. It must
// look ONLY at the completionDiagnostic and DELIBERATELY ignore evidenceLevel/reviewRecommended —
// folding those in would change the genuine-completion judgement that drives truncated-terminal
// supersession.
describe('isFalseIdleCompletion — narrow completionDiagnostic-only subset (preserved)', () => {
    it('is true for a missing-final-assistant diagnostic', () => {
        expect(isFalseIdleCompletion({ completionDiagnostic: { finalAssistantPresent: false } })).toBe(true);
        expect(isFalseIdleCompletion({ completionDiagnostic: { blockReason: 'missing_final_assistant' } })).toBe(true);
    });

    // The key distinction from isWeakCompletionEvidence: these are weak but NOT false-idle.
    it('does NOT treat a self-declared weak/insufficient/reviewRecommended event as false-idle', () => {
        expect(isFalseIdleCompletion({ evidenceLevel: 'weak' })).toBe(false);
        expect(isFalseIdleCompletion({ evidenceLevel: 'insufficient' })).toBe(false);
        expect(isFalseIdleCompletion({ reviewRecommended: true })).toBe(false);
    });

    it('matches isMissingFinalAssistantDiagnostic (the extracted shared clause)', () => {
        for (const record of [
            { completionDiagnostic: { finalAssistantPresent: false } },
            { completionDiagnostic: { blockReason: 'missing_final_assistant' } },
            { completionDiagnostic: { finalAssistantPresent: true } },
            { evidenceLevel: 'weak' },
            {},
        ]) {
            expect(isFalseIdleCompletion(record)).toBe(isMissingFinalAssistantDiagnostic(record));
        }
    });
});
