import { describe, expect, it } from 'vitest';
import type { MeshTurnAttemptRow } from '../../src/mesh/mesh-runtime-store.js';
import {
    authoritativeEvidenceOutranksLivePending,
    completionEligibleForLiveStateRetry,
    evaluateAuthoritativeTranscriptCompletion,
} from '../../src/mesh/mesh-completion-live-gate.js';

const NOW = 1_800_000_000_000;

function attempt(overrides: Partial<MeshTurnAttemptRow> = {}): MeshTurnAttemptRow {
    return {
        attemptId: 'attempt-1',
        meshId: 'mesh-1',
        taskId: 'task-1',
        attemptSeq: 7,
        nodeId: 'node-1',
        sessionId: 'session-1',
        providerType: 'provider-under-test',
        coordinatorDaemonId: null,
        coordinatorSessionId: null,
        dispatchNonce: 7,
        stage: 'waiting_approval',
        redriveCount: 0,
        leaseDeadlineMs: null,
        acceptedAt: new Date(NOW - 10_000).toISOString(),
        deliveredAt: new Date(NOW - 9_000).toISOString(),
        consumedAt: new Date(NOW - 8_000).toISOString(),
        terminalOutcome: null,
        terminalReason: null,
        terminalAt: null,
        createdAt: new Date(NOW - 10_000).toISOString(),
        updatedAt: new Date(NOW - 6_000).toISOString(),
        ...overrides,
    };
}

function strongEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        event: 'agent:generating_completed',
        targetSessionId: 'session-1',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        dispatchNonce: 7,
        timestamp: NOW - 5_000,
        finalSummary: 'Proven final answer',
        evidenceLevel: 'transcript',
        completionDiagnostic: {
            source: 'clean_final_assistant',
            cleanPath: true,
            evidenceWeak: false,
            finalAssistantPresent: true,
            finalAssistantEvidenceSource: 'external-native',
            transcriptEvidence: {
                version: 1,
                kind: 'final_assistant',
                cleanPath: true,
                weak: false,
                authorityClass: 'native-source',
                timing: 'floor',
                observedAt: NOW - 5_000,
                turnStartedAt: NOW - 9_000,
                finalContentLength: 19,
                taskId: 'task-1',
                attemptId: 'attempt-1',
                dispatchNonce: 7,
                sessionId: 'session-1',
            },
        },
        ...overrides,
    };
}

describe('MID-TURN-LIVE-STATE-GATE transcript authority contract', () => {
    it('accepts codex/native-source-shaped clean evidence newer than a stale waiting_approval snapshot', () => {
        const authority = evaluateAuthoritativeTranscriptCompletion({
            metadataEvent: strongEvent(),
            eventSessionId: 'session-1',
            attempt: attempt(),
            nowMs: NOW,
        });
        expect(authority).toMatchObject({ authoritative: true, evidenceObservedAt: NOW - 5_000 });
        expect(authoritativeEvidenceOutranksLivePending(authority, {
            pending: true,
            kind: 'modal',
            observedAt: NOW - 4_000,
        })).toBe(true);
    });

    it('uses the generic authority profile rather than a provider-name branch', () => {
        const event = strongEvent();
        (event.completionDiagnostic as any).transcriptEvidence.authorityClass = 'native-source';
        (event.completionDiagnostic as any).transcriptEvidence.timing = 'floor';
        expect(evaluateAuthoritativeTranscriptCompletion({
            metadataEvent: event,
            eventSessionId: 'session-1',
            attempt: attempt({ providerType: 'generic-floor-provider' }),
            nowMs: NOW,
        }).authoritative).toBe(true);
    });

    it.each(['fba0b9d9', 'dcf89b89'])(
        'reproduces restart/rebind session %s: the older waiting_approval frame loses to the fresh native final',
        (sessionId) => {
            const baseDiagnostic = strongEvent().completionDiagnostic as any;
            const event = strongEvent({
                targetSessionId: sessionId,
                completionDiagnostic: {
                    ...baseDiagnostic,
                    transcriptEvidence: {
                        ...baseDiagnostic.transcriptEvidence,
                        sessionId,
                    },
                },
            });
            const authority = evaluateAuthoritativeTranscriptCompletion({
                metadataEvent: event,
                eventSessionId: sessionId,
                attempt: attempt({ sessionId }),
                nowMs: NOW,
            });
            expect(authoritativeEvidenceOutranksLivePending(authority, {
                pending: true,
                kind: 'modal',
                observedAt: NOW - 7_000,
            })).toBe(true);
        },
    );

    it.each([
        ['weak evidence', { evidenceLevel: 'weak' }],
        ['finalAssistantPresent=false', { completionDiagnostic: {
            ...(strongEvent().completionDiagnostic as any),
            finalAssistantPresent: false,
        } }],
        ['empty final transcript', { finalSummary: '', completionDiagnostic: {
            ...(strongEvent().completionDiagnostic as any),
            transcriptEvidence: {
                ...(strongEvent().completionDiagnostic as any).transcriptEvidence,
                finalContentLength: 0,
            },
        } }],
        ['stale timestamp', { timestamp: NOW - 61_000, completionDiagnostic: {
            ...(strongEvent().completionDiagnostic as any),
            transcriptEvidence: {
                ...(strongEvent().completionDiagnostic as any).transcriptEvidence,
                observedAt: NOW - 61_000,
            },
        } }],
        ['attempt mismatch', { attemptId: 'attempt-old' }],
        ['session mismatch', { completionDiagnostic: {
            ...(strongEvent().completionDiagnostic as any),
            transcriptEvidence: {
                ...(strongEvent().completionDiagnostic as any).transcriptEvidence,
                sessionId: 'session-old',
            },
        } }],
        ['nonce mismatch', { dispatchNonce: 6 }],
        ['synthetic evidence', { completionDiagnostic: {
            ...(strongEvent().completionDiagnostic as any),
            cleanPath: false,
        } }],
        ['pre-dispatch evidence', { timestamp: NOW - 13_000, completionDiagnostic: {
            ...(strongEvent().completionDiagnostic as any),
            transcriptEvidence: {
                ...(strongEvent().completionDiagnostic as any).transcriptEvidence,
                observedAt: NOW - 13_000,
                turnStartedAt: NOW - 14_000,
            },
        } }],
    ])('rejects %s', (_name, override) => {
        expect(evaluateAuthoritativeTranscriptCompletion({
            metadataEvent: strongEvent(override),
            eventSessionId: 'session-1',
            attempt: attempt({ updatedAt: new Date(NOW - 4_000).toISOString() }),
            nowMs: NOW,
        }).authoritative).toBe(false);
    });

    it('keeps a newer genuine approval/choice or trailing-tool observation as a veto', () => {
        const authority = evaluateAuthoritativeTranscriptCompletion({
            metadataEvent: strongEvent(),
            eventSessionId: 'session-1',
            attempt: attempt({ updatedAt: new Date(NOW - 4_000).toISOString() }),
            nowMs: NOW,
        });
        expect(authoritativeEvidenceOutranksLivePending(authority, {
            pending: true,
            kind: 'modal',
            observedAt: NOW - 4_000,
        })).toBe(false);
        expect(authoritativeEvidenceOutranksLivePending(authority, {
            pending: true,
            kind: 'transcript_tool',
            observedAt: NOW - 4_000,
        })).toBe(false);
    });

    it('never arms the content-free retry for weak, empty, stale, or mismatched events', () => {
        const current = attempt();
        expect(completionEligibleForLiveStateRetry({
            metadataEvent: strongEvent(),
            eventSessionId: 'session-1',
            attempt: current,
            nowMs: NOW,
        })).toBe(true);
        for (const event of [
            strongEvent({ evidenceLevel: 'weak' }),
            strongEvent({ finalSummary: '' }),
            strongEvent({ timestamp: NOW - 61_000 }),
            strongEvent({ attemptId: 'attempt-old' }),
            strongEvent({ dispatchNonce: 6 }),
        ]) {
            expect(completionEligibleForLiveStateRetry({
                metadataEvent: event,
                eventSessionId: 'session-1',
                attempt: current,
                nowMs: NOW,
            })).toBe(false);
        }
    });
});
