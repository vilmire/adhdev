import { describe, expect, it } from 'vitest';
import { buildPendingEventFingerprint, type PendingMeshCoordinatorEvent } from '../../src/mesh/mesh-events-pending.js';

// DUPNOTIF: a finished direct-dispatch task is surfaced to the coordinator by TWO paths —
// the native completion (handleMeshCoordinatorEvent) and the transcript-reconciliation
// fallback (reconcileDirectDispatchCompletionFromTranscript). Both queue an
// agent:generating_completed for the same task but timestamp it differently, so a
// timestamp-bearing fingerprint let both surface → the coordinator notified twice.
// buildPendingEventFingerprint now anchors terminal completions on taskId (+ a weakness
// marker) so the two paths collapse to a single surface while a genuine completion still
// supersedes an earlier weak/false-idle one.
describe('buildPendingEventFingerprint — terminal completion taskId dedup (DUPNOTIF)', () => {
    const base = (overrides: Partial<PendingMeshCoordinatorEvent> & { metadataEvent: Record<string, unknown> }): PendingMeshCoordinatorEvent => ({
        event: 'agent:generating_completed',
        meshId: 'mesh-1',
        nodeLabel: "Node 'n1'",
        nodeId: 'n1',
        queuedAt: 0,
        ...overrides,
    });

    it('collapses the native + reconciliation completions of the same task despite differing timestamps', () => {
        const taskId = 'task-xyz';
        const nativeCompletion = base({
            metadataEvent: { sessionId: 's1', taskId, timestamp: 1000, finalSummary: 'done' },
        });
        const reconciledCompletion = base({
            // Same task, surfaced later by the transcript reconcile — different timestamp.
            metadataEvent: { sessionId: 's1', taskId, timestamp: 9999, source: 'direct_task_transcript_reconciliation', finalSummary: 'done' },
        });
        expect(buildPendingEventFingerprint(nativeCompletion))
            .toBe(buildPendingEventFingerprint(reconciledCompletion));
    });

    it('reads the taskId from a nested payload when not on the top-level metadata', () => {
        const taskId = 'task-nested';
        const a = base({ metadataEvent: { sessionId: 's1', timestamp: 1, payload: { taskId } } });
        const b = base({ metadataEvent: { sessionId: 's1', timestamp: 2, payload: { taskId } } });
        expect(buildPendingEventFingerprint(a)).toBe(buildPendingEventFingerprint(b));
    });

    it('keeps a genuine completion distinct from an earlier weak/false-idle one for the same task', () => {
        const taskId = 'task-weak-then-genuine';
        const weak = base({
            metadataEvent: {
                sessionId: 's1', taskId, timestamp: 1,
                completionDiagnostic: { finalAssistantPresent: false, blockReason: 'missing_final_assistant' },
            },
        });
        const genuine = base({
            metadataEvent: { sessionId: 's1', taskId, timestamp: 2, finalSummary: 'really done' },
        });
        // Different fingerprints → the genuine completion is NOT swallowed by the weak one.
        expect(buildPendingEventFingerprint(weak)).not.toBe(buildPendingEventFingerprint(genuine));
    });

    it('treats reviewRecommended / insufficient evidence as weak', () => {
        const taskId = 'task-review';
        const reviewWeak = base({ metadataEvent: { sessionId: 's1', taskId, timestamp: 1, reviewRecommended: true } });
        const insufficientWeak = base({ metadataEvent: { sessionId: 's1', taskId, timestamp: 5, evidenceLevel: 'insufficient' } });
        const genuine = base({ metadataEvent: { sessionId: 's1', taskId, timestamp: 9, finalSummary: 'ok' } });
        expect(buildPendingEventFingerprint(reviewWeak)).toContain('weak');
        expect(buildPendingEventFingerprint(insufficientWeak)).toContain('weak');
        expect(buildPendingEventFingerprint(genuine)).toContain('genuine');
    });

    it('dedups a failed-task agent:stopped surfaced by both paths', () => {
        const taskId = 'task-failed';
        const native = base({ event: 'agent:stopped', metadataEvent: { sessionId: 's1', taskId, timestamp: 100 } });
        const reconciled = base({ event: 'agent:stopped', metadataEvent: { sessionId: 's1', taskId, timestamp: 200 } });
        expect(buildPendingEventFingerprint(native)).toBe(buildPendingEventFingerprint(reconciled));
    });

    it('does NOT collapse completions of DIFFERENT tasks on the same session', () => {
        const a = base({ metadataEvent: { sessionId: 's1', taskId: 'task-a', timestamp: 1 } });
        const b = base({ metadataEvent: { sessionId: 's1', taskId: 'task-b', timestamp: 1 } });
        expect(buildPendingEventFingerprint(a)).not.toBe(buildPendingEventFingerprint(b));
    });

    it('falls back to the timestamp-bearing fingerprint when no taskId is present', () => {
        // No taskId → legacy session+timestamp fingerprint (two timestamps stay distinct).
        const a = base({ metadataEvent: { sessionId: 's1', timestamp: 1 } });
        const b = base({ metadataEvent: { sessionId: 's1', timestamp: 2 } });
        expect(buildPendingEventFingerprint(a)).not.toBe(buildPendingEventFingerprint(b));
    });
});
