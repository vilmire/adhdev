import { describe, expect, it } from 'vitest';
import { createTurnEvidencePort, emitTurnEnd } from '../../src/providers/turn-evidence-port.js';
import { attachMeshAssignment, currentMeshAttemptRef, releaseMeshAttemptRef, detachMeshAssignment, PERSISTED_ATTEMPT_REF_META_KEY } from '../../src/providers/cli-provider-mesh-assignment.js';
import { readPersistedAttemptRef } from '../../src/session-host/runtime-support.js';
import { createTurnIngestHandler } from '../../src/mesh/turn-ledger/deliver.js';
import { SUMMARY, dispatch, evd, fakePublisher, ledgerOn, memDb } from './ledger-harness.js';

// Live 2026-10-09 (preview): a claude-cli worker on Jupiter ran a task the Mac
// owned (attempt mesh_direct:<task> g0). Jupiter's daemon restarted mid-turn; the
// session survived in the session host and was restored with its membership and
// owner id (oss 6dd2103ba) but NO attempt ref. The worker's report reached the
// Mac (R17g: "awaiting the idle edge"), but the session's busy→idle at 02:28:43
// became an untagged turn_end: the worker ledger owns no such attempt, so it
// refused to forward (forward_without_attempt_ref) and the Mac committed from
// the report 60 s later (R13t "no idle edge within 60s of the worker report").
//
// The fix persists the attempt ref to the session-host record meta at dispatch
// (cleared on release/detach) and restores it, so the restored session's idle
// edge names the attempt again and the owner commits on it (R9t).

const OWNER = { daemonId: 'dc', meshId: 'm1' };

/** The worker daemon (dw): a ledger that owns nothing, behind the real evidence port. */
function workerDaemon() {
    const publisher = fakePublisher('w-dw');
    const ledger = ledgerOn(memDb(), { selfDaemonId: 'dw', publisher });
    const port = createTurnEvidencePort({
        observe: (evidence, opts) => { ledger.observe(evidence, opts); },
        ownerFor: () => OWNER, // membership + owner id restored (6dd2103ba)
        selfDaemonId: 'dw',
        attemptRefFor: (sessionId) => {
            const attempt = ledger.openAttemptForSession(sessionId);
            return attempt ? { attemptId: attempt.attemptId, generation: attempt.generation } : null;
        },
    });
    return { ledger, publisher, port };
}

/** The owner daemon (dc): attempt a1 dispatched onto s1, running, with the worker's report recorded (R17g). */
function ownerAwaitingIdleEdge() {
    const ledger = ledgerOn(memDb(), { publisher: fakePublisher() });
    ledger.observe(dispatch({ scope: 'mesh_direct' }));
    ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'local' }, { source: 'input_service' }));
    ledger.observe(evd('turn_started', { retro: false }));
    const report = ledger.observe(evd('worker_report', { outcome: 'completed', summary: SUMMARY, hasHandoffNotes: false }, { source: 'worker_tool' }));
    expect(report.rule).toBe('R17g');
    const ingest = createTurnIngestHandler({ ledger, selfDaemonIds: () => ['dc'] });
    return { ledger, ingest };
}

/** The worker session's pre-restart dispatch stamp, capturing what it persisted to the session-host record. */
function stampedWorkerSession() {
    const meta: Record<string, unknown> = {};
    const host = {
        instanceId: 's1',
        settings: { meshNodeFor: 'm1', launchedByCoordinator: true } as Record<string, any>,
        meshTaskInjectedAt: 0,
        meshTaskAttachmentHistory: [],
        adapter: { updateRuntimeSettings() {}, updateRuntimeMeta(m: Record<string, unknown>) { Object.assign(meta, m); } },
    };
    attachMeshAssignment(host, { meshId: 'm1', nodeId: 'n1', taskId: 't1', attemptId: 'a1', attemptGeneration: 0, coordinatorDaemonId: 'dc' });
    return { host, meta };
}

/** The idle edge of the restored session, as completion-flush emits it (attemptRef from the restored settings). */
function restoredIdleEdge(port: ReturnType<typeof workerDaemon>['port'], restoredSettings: Record<string, any>) {
    emitTurnEnd(port, {
        sessionId: 's1',
        observedBy: 'cli_completion_flush',
        source: 'completion_flush_genuine',
        strength: 'genuine',
        attemptRef: currentMeshAttemptRef(restoredSettings) ?? undefined,
    });
}

async function deliverForwarded(worker: ReturnType<typeof workerDaemon>, owner: ReturnType<typeof ownerAwaitingIdleEdge>) {
    await worker.ledger.flushPublish();
    for (const { meshId, entry, writer, seq } of worker.publisher.entries) {
        owner.ingest({ meshId, writer, seq, kind: entry.k, payload: entry, own: false });
    }
}

describe('worker-daemon restart mid-turn: the restored session still delivers its idle edge to the owner', () => {
    it('without a restored attempt ref the idle edge never leaves the worker (the 2026-10-09 failure)', async () => {
        const worker = workerDaemon();
        const owner = ownerAwaitingIdleEdge();
        restoredIdleEdge(worker.port, { meshNodeFor: 'm1', meshCoordinatorDaemonId: 'dc' });
        await deliverForwarded(worker, owner);
        expect(worker.publisher.entries).toHaveLength(0);
        expect(owner.ledger.getAttempt('a1')?.terminal ?? null).toBeNull();
    });

    it('★the attempt ref persisted at dispatch is restored, so the idle edge is forwarded and the owner commits on it (R9t)', async () => {
        const { meta } = stampedWorkerSession();
        // Daemon restart: settings are rebuilt from the session-host record.
        const restoredRef = readPersistedAttemptRef(meta[PERSISTED_ATTEMPT_REF_META_KEY]);
        expect(restoredRef).toEqual({ attemptId: 'a1', generation: 0 });
        const restoredSettings = {
            meshNodeFor: 'm1', meshCoordinatorDaemonId: meta.meshCoordinatorDaemonId,
            meshActiveAttemptId: restoredRef!.attemptId, meshActiveAttemptGeneration: restoredRef!.generation,
        };

        const worker = workerDaemon();
        const owner = ownerAwaitingIdleEdge();
        restoredIdleEdge(worker.port, restoredSettings);
        await deliverForwarded(worker, owner);

        expect(worker.publisher.entries.map((e) => e.entry)).toEqual([
            expect.objectContaining({ k: 'turn.evidence', attemptId: 'a1', generation: 0, ownerDaemonId: 'dc', ev: 'turn_end' }),
        ]);
        expect(owner.ledger.getAttempt('a1')?.terminal).toMatchObject({ reason: 'worker_reported', strength: 'tool_report' });
        const edge = owner.ledger.store.listEvents('a1').find((row) => row.kind === 'turn_end');
        expect(edge).toMatchObject({ rule: 'R9t', verdict: 'applied', srcWriter: 'w-dw' });
    });

    it('a released or detached ref is cleared in the record, so a later restart restores nothing stale', () => {
        const { host, meta } = stampedWorkerSession();
        expect(releaseMeshAttemptRef(host, 'a1')).toBe(true);
        expect(readPersistedAttemptRef(meta[PERSISTED_ATTEMPT_REF_META_KEY])).toBeUndefined();

        const again = stampedWorkerSession();
        detachMeshAssignment(again.host);
        expect(readPersistedAttemptRef(again.meta[PERSISTED_ATTEMPT_REF_META_KEY])).toBeUndefined();
    });

    it('a stale restored ref (the owner already committed the attempt) is recorded by the owner, never applied', async () => {
        const worker = workerDaemon();
        const owner = ownerAwaitingIdleEdge();
        owner.ledger.observe(evd('turn_end', { strength: 'genuine' })); // owner commits a1 (R9t) before the worker comes back
        const terminal = owner.ledger.getAttempt('a1')?.terminal;
        expect(terminal).toBeTruthy();

        restoredIdleEdge(worker.port, { meshNodeFor: 'm1', meshCoordinatorDaemonId: 'dc', meshActiveAttemptId: 'a1', meshActiveAttemptGeneration: 0 });
        await deliverForwarded(worker, owner);
        expect(owner.ledger.getAttempt('a1')?.terminal).toEqual(terminal);
    });
});
