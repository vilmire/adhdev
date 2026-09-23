/**
 * mesh-stall-watchdog.ts's no_progress evidence emission (wiring-unification
 * C5/C-W5, brief §1 row `mesh-stall-watchdog.ts:328`). Pins: the watchdog's
 * fire also submits `no_progress` evidence with `finalAssistantPresent:false`
 * (a fired stall already means tryReconcileTranscriptCompletionForStall did
 * NOT reconcile it to a completion), `observedStatus` narrows an unrecognized
 * raw status to 'unknown' rather than leaking it, and a null port is a no-op.
 *
 * Built on the same Object.create(CliProviderInstance.prototype) pattern as
 * cli-provider-mesh-stall-watchdog.test.ts — `currentAttemptRef` is a
 * PROTOTYPE method (survives Object.create); `turnEvidencePort` is a field
 * (does not survive it, so this suite sets it explicitly on the instance).
 */
import { describe, expect, it } from 'vitest';
import { CliProviderInstance } from '../../../src/providers/cli-provider-instance.js';
import { createTurnEvidencePort } from '../../../src/providers/turn-evidence-port.js';
import type { TurnEvidence } from '@adhdev/mesh-shared';

const STALL_MS = 180_000;

function makeInstance(opts: { turnEvidencePort?: ReturnType<typeof createTurnEvidencePort> | null }) {
    const emitted: any[] = [];
    const instance = Object.create(CliProviderInstance.prototype) as any;
    instance.instanceId = 'sess-instance-1';
    instance.type = 'claude-code';
    instance.workingDir = '/work/repo';
    instance.providerSessionId = 'provider-sess-1';
    instance.settings = { meshNodeFor: 'mesh-abc', meshNodeId: 'node-1', meshActiveTaskId: 'task-1' };
    instance.events = [];
    instance.startedAt = 1_000;
    instance.meshStallAnchorAt = -1;
    instance.meshStallEmittedForAnchor = false;
    instance.meshStallTurnActiveLast = undefined;
    instance.meshStallLastFiredAt = -1;
    instance.turnEvidencePort = opts.turnEvidencePort;
    const adapter = {
        currentTurnTaskId: undefined as string | undefined,
        _lastOutputAt: 10_000,
        _status: 'idle',
        _alive: true,
        currentTurnScope: undefined,
        isAlive() { return this._alive; },
        getStatus() { return { lastOutputAt: this._lastOutputAt, status: this._status }; },
    };
    instance.adapter = adapter;
    instance.context = { emitProviderEvent: (e: any) => emitted.push(e) };
    return { instance, emitted };
}

describe('checkMeshWorkerStall — turn-evidence emission', () => {
    it('a fired stall also submits no_progress evidence with finalAssistantPresent:false', () => {
        const observed: TurnEvidence[] = [];
        const port = createTurnEvidencePort({ observe: (e) => { observed.push(e); } });
        const { instance, emitted } = makeInstance({ turnEvidencePort: port });
        const outputAt = 10_000;

        instance.checkMeshWorkerStall(outputAt);
        instance.checkMeshWorkerStall(outputAt + STALL_MS);

        expect(emitted).toHaveLength(1);
        const ev = observed.find((e) => e.kind === 'no_progress') as Extract<TurnEvidence, { kind: 'no_progress' }> | undefined;
        expect(ev).toBeDefined();
        expect(ev!.finalAssistantPresent).toBe(false);
        expect(ev!.observedStatus).toBe('idle');
        expect(ev!.stalledMs).toBe(STALL_MS);
        expect(ev!.sessionId).toBe('sess-instance-1');
        expect(ev!.source).toBe('mesh_stall_watchdog');
    });

    it('narrows an unrecognized observedStatus to "unknown" rather than leaking the raw string', () => {
        const observed: TurnEvidence[] = [];
        const port = createTurnEvidencePort({ observe: (e) => { observed.push(e); } });
        const { instance } = makeInstance({ turnEvidencePort: port });
        instance.adapter._status = 'some_future_status_not_in_SessionStatus';
        const outputAt = 10_000;

        instance.checkMeshWorkerStall(outputAt);
        instance.checkMeshWorkerStall(outputAt + STALL_MS);

        const ev = observed.find((e) => e.kind === 'no_progress') as Extract<TurnEvidence, { kind: 'no_progress' }> | undefined;
        expect(ev!.observedStatus).toBe('unknown');
    });

    it('a null turnEvidencePort is a no-op for the evidence path — the provider event still fires', () => {
        const { instance, emitted } = makeInstance({ turnEvidencePort: null });
        const outputAt = 10_000;
        expect(() => {
            instance.checkMeshWorkerStall(outputAt);
            instance.checkMeshWorkerStall(outputAt + STALL_MS);
        }).not.toThrow();
        expect(emitted).toHaveLength(1);
    });
});
