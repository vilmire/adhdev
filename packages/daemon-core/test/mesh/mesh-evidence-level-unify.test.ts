import { describe, expect, it } from 'vitest';

// EVIDENCE-LEVEL-UNIFY — the ledger-append block in markSessionTerminal
// (mesh-event-forwarding.ts) used to compute evidenceLevel independently of whatever
// applyTaskModeCompletionEvidence (mesh-completion-side-effect-evidence.ts) had already
// stamped onto the SAME metadataEvent object earlier in the same function. The two
// diverged on the same completion: the ledger persisted the locally-computed value, but
// buildMeshSystemMessage — which reads metadataEvent later, unaware of the ledger's
// computation — surfaced the earlier, less specific stamp ('reported') instead of the
// ledger's 'insufficient'. A coordinator reading only the notification therefore judged
// a genuinely evidence-insufficient completion as merely 'reported'.
//
// resolveUnifiedCompletionEvidenceLevel is the merge the ledger-append block now applies
// before writing evidenceLevel to both the ledger payload and back onto metadataEvent.

import { resolveUnifiedCompletionEvidenceLevel } from '../../src/mesh/mesh-event-forwarding.js';

describe('resolveUnifiedCompletionEvidenceLevel (evidence-level unify)', () => {
    it('never downgrades away from a locally-computed insufficient, even when a prior stamp says reported', () => {
        // This is the exact reported symptom: applyTaskModeCompletionEvidence's git-clean
        // gate had already stamped 'reported' onto metadataEvent.evidenceLevel BEFORE the
        // ledger-append block ran its own computation off completionEvidence, and got
        // 'insufficient' (workerResult.source === 'default' — no parseable answer at all).
        expect(resolveUnifiedCompletionEvidenceLevel({
            computedLevel: 'insufficient',
            priorLevel: 'reported',
        })).toBe('insufficient');
    });

    it('never downgrades away from a prior insufficient, even when the local computation says sufficient', () => {
        expect(resolveUnifiedCompletionEvidenceLevel({
            computedLevel: 'sufficient',
            priorLevel: 'insufficient',
        })).toBe('insufficient');
    });

    it('keeps the computed level when there is no prior stamp', () => {
        expect(resolveUnifiedCompletionEvidenceLevel({
            computedLevel: 'sufficient',
            priorLevel: undefined,
        })).toBe('sufficient');
        expect(resolveUnifiedCompletionEvidenceLevel({
            computedLevel: 'insufficient',
            priorLevel: undefined,
        })).toBe('insufficient');
    });

    it('falls back to the prior stamp when there is no local computation (no completionEvidence)', () => {
        expect(resolveUnifiedCompletionEvidenceLevel({
            computedLevel: undefined,
            priorLevel: 'reported',
        })).toBe('reported');
    });

    it('returns undefined when neither side has a value', () => {
        expect(resolveUnifiedCompletionEvidenceLevel({
            computedLevel: undefined,
            priorLevel: undefined,
        })).toBeUndefined();
    });

    it('agrees with sufficient when both sides independently say sufficient', () => {
        expect(resolveUnifiedCompletionEvidenceLevel({
            computedLevel: 'sufficient',
            priorLevel: 'sufficient',
        })).toBe('sufficient');
    });
});
