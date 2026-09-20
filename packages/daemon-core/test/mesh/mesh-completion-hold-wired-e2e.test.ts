// End-to-end through the REAL wired suppression path — not the hold unit alone.
// Drives evaluateMeshEventSuppression with the measured live shape and asserts a
// notification actually reaches the inject function.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { evaluateMeshEventSuppression } from '../../src/mesh/mesh-event-suppression.js';
import {
    __drainHeldLiveStateCompletionsForTests,
    __resetHeldLiveStateCompletionsForTests,
} from '../../src/mesh/mesh-completion-live-gate.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

const NOW = Date.now();
const MEASURED_BUBBLE_AGE_MS = 5_867;

describe('WIRED E2E: the 05:45:57 loss, through the real suppression pipeline', () => {
    let restore: (() => void) | null = null;
    beforeEach(() => {
        __resetHeldLiveStateCompletionsForTests();
        const store = MeshRuntimeStore.getInstance() as unknown as Record<string, unknown>;
        const orig = store.getCurrentTurnAttempt;
        store.getCurrentTurnAttempt = () => ({
            attemptId: 'attempt-1', taskId: 'task-1', sessionId: 'session-1',
            dispatchNonce: 7, terminalOutcome: null, stage: 'finalizing',
            acceptedAt: new Date(NOW - 30_000).toISOString(),
            createdAt: new Date(NOW - 30_000).toISOString(),
        });
        restore = () => { store.getCurrentTurnAttempt = orig; };
    });
    afterEach(() => { restore?.(); __resetHeldLiveStateCompletionsForTests(); });

    it('★declines while the tail moves, then DELIVERS once it goes quiet', () => {
        const delivered: Record<string, unknown>[] = [];
        // cursor-cli-shaped session: transcript still moving, nothing else pending.
        let newestActivityAtMs = NOW - MEASURED_BUBBLE_AGE_MS;
        const instance = {
            getLiveTurnPendingEvidence: () => ({ pending: false }),
            getDrainStatus: () => 'idle' as const,
            getTerminalAdmissionObservations: () => ({
                activeModalPresent: false,
                trailingActivityCount: 0,
                finalAssistantPresent: true,
                nativeMarkersFieldPresent: false,
                newestActivityAtMs,
            }),
        };
        const components = { instanceManager: { getInstance: () => instance } } as never;

        const args = {
            meshId: 'mesh-1',
            nodeLabel: 'node-1',
            event: 'agent:generating_completed',
            metadataEvent: {
                event: 'agent:generating_completed',
                targetSessionId: 'session-1',
                taskId: 'task-1',
                attemptId: 'attempt-1',
                dispatchNonce: 7,
                timestamp: NOW,
                providerType: 'cursor-cli',
                finalSummary: 'done',
            } as Record<string, unknown>,
        };

        const verdict = evaluateMeshEventSuppression(args, {
            traceCtx: {} as never,
            eventSessionId: 'session-1',
            eventNodeId: 'node-1',
            eventTimestamp: NOW,
            workerCoordinatorDaemonId: undefined,
            components,
            injectMeshSystemMessage: ((_c: unknown, a: { metadataEvent: Record<string, unknown> }) => {
                delivered.push(a.metadataEvent);
            }) as never,
        });

        // Step 1: suppressed, hold armed — the state that used to be terminal.
        expect(verdict?.kind).toBe('suppress');
        expect((verdict as { result: Record<string, unknown> }).result.terminalAdmissionDeclined).toBe(true);
        expect((verdict as { result: Record<string, unknown> }).result.completionRetryHeld).toBe(true);
        expect(delivered).toHaveLength(0);

        // Step 2: the tail stops moving and ages past the 8s quiet window.
        newestActivityAtMs = NOW - 9_000;
        __drainHeldLiveStateCompletionsForTests(NOW + 500);

        // ★The notification the coordinator never used to get.
        expect(delivered).toHaveLength(1);
        expect(delivered[0]).toMatchObject({
            event: 'agent:generating_completed',
            taskId: 'task-1',
            attemptId: 'attempt-1',
            targetSessionId: 'session-1',
        });
    });

    it('★a tail that NEVER settles still notifies when the bound expires, and is ADMITTED on re-entry', () => {
        const delivered: Record<string, unknown>[] = [];
        const instance = {
            getLiveTurnPendingEvidence: () => ({ pending: false }),
            getDrainStatus: () => 'idle' as const,
            // Perpetually fresh tail — the pathological case.
            getTerminalAdmissionObservations: (nowMs?: number) => ({
                activeModalPresent: false,
                trailingActivityCount: 0,
                finalAssistantPresent: true,
                nativeMarkersFieldPresent: false,
                newestActivityAtMs: nowMs ?? Date.now(),
            }),
        };
        const components = { instanceManager: { getInstance: () => instance } } as never;
        const ctx = {
            traceCtx: {} as never,
            eventSessionId: 'session-1',
            eventNodeId: 'node-1',
            eventTimestamp: NOW,
            workerCoordinatorDaemonId: undefined,
            components,
            injectMeshSystemMessage: ((_c: unknown, a: { metadataEvent: Record<string, unknown> }) => {
                delivered.push(a.metadataEvent);
            }) as never,
        };
        const base = {
            meshId: 'mesh-1',
            nodeLabel: 'node-1',
            event: 'agent:generating_completed',
            metadataEvent: {
                event: 'agent:generating_completed',
                targetSessionId: 'session-1',
                taskId: 'task-1',
                attemptId: 'attempt-1',
                dispatchNonce: 7,
                timestamp: NOW,
                providerType: 'cursor-cli',
                finalSummary: 'done',
            } as Record<string, unknown>,
        };

        expect(evaluateMeshEventSuppression(base, ctx)?.kind).toBe('suppress');
        for (let t = 250; t <= 13_000; t += 250) __drainHeldLiveStateCompletionsForTests(NOW + t);

        // Released despite the veto never clearing.
        expect(delivered).toHaveLength(1);
        expect((delivered[0].completionDiagnostic as Record<string, unknown>).holdExpired).toBe(true);

        // ★And when that release re-enters the pipeline it is ADMITTED, not
        // re-declined — otherwise the loss is merely relocated.
        const reentry = evaluateMeshEventSuppression(
            { ...base, metadataEvent: delivered[0] }, ctx);
        expect(reentry?.kind).not.toBe('suppress');
    });
});
