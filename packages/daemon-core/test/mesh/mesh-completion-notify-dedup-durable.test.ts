import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// DUPNOTIF-DURABLE — regression suite for the duplicate [System] completion defect.
//
// Measured live: session 3845d986 emitted the SAME final summary three times (1st
// evidence_level=reported, 2nd/3rd weak). Two independent defects combined:
//
//   gap_b (this file's main subject) — the pending-queue dedup was drain-gated.
//     hasPendingEventFingerprint queries `WHERE drained = 0`, so once the coordinator
//     consumed the first completion the SAME fingerprint no longer read as a duplicate
//     and a second producer queued a second identical [System] completion. The
//     TURN-LEDGER outbox crash-recovery redelivery rested its exactly-once guarantee on
//     that one drain-gated check, so it was structurally unable to hold.
//
//   gap_a (mesh-events-stale) — the synth idempotency backstop compared finalSummary by
//     STRING EQUALITY, while two producers scrape the transcript independently.
//
// The self-contradiction that dates the regression: mesh-reconcile-stranded-dispatch.ts
// documents "It is idempotent... at most one [System] completion surfaces" — an
// invariant its own author wrote down and the live run violated three times over.

const testTmpDir = join(tmpdir(), `adhdev-dupnotif-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'mach_1b46842a15d3409d96ad33e767a916dd' }),
}));

import {
    queuePendingMeshCoordinatorEvent,
    drainPendingMeshCoordinatorEvents,
    type PendingMeshCoordinatorEvent,
} from '../../src/mesh/mesh-events-pending.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

const CORE = 'mach_1b46842a15d3409d96ad33e767a916dd';
const TASK = '3845d986-1f0e-4c22-9a1b-2c7d9e4f5a60';

function completion(meshId: string, over: Partial<PendingMeshCoordinatorEvent> = {}): PendingMeshCoordinatorEvent {
    return {
        event: 'agent:generating_completed',
        meshId,
        nodeLabel: "Node 'node_worker'",
        nodeId: 'node_worker',
        targetCoordinatorDaemonId: CORE,
        metadataEvent: {
            nodeId: 'node_worker',
            sessionId: 'worker-session-1',
            taskId: TASK,
            timestamp: 1785432141368,
            finalSummary: 'read-only task complete',
        },
        coordinatorMessage: 'Worker completed the task',
        queuedAt: Date.now(),
        ...over,
    };
}

describe('DUPNOTIF-DURABLE gap_b — pending-event dedup survives the drain', () => {
    beforeEach(() => {
        MeshRuntimeStore.resetForTests();
    });

    afterEach(() => {
        MeshRuntimeStore.resetForTests();
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    // NOTE ON WHAT ACTUALLY LEAKS. The drain alone does NOT re-open the gate: a drained
    // row is soft-marked and RETAINED, and `idx_mesh_pending_events_fingerprint` is
    // UNIQUE on (mesh_id, fingerprint) with no `drained` qualifier, so INSERT OR IGNORE
    // silently absorbs a byte-identical re-queue even though the drain-gated
    // hasPendingEventFingerprint reported "not a duplicate".
    //
    // The leak is that this last line of defence is a ROW, and rows get deleted. Two
    // production paths free the fingerprint slot while the same completion can still be
    // re-produced — `prunePendingEvents` (retention) and `deletePendingEventsById`
    // (unresolved-delegate outbox expiry). Once the slot is free the duplicate lands.
    // These tests drive those paths; a dedup record that is not tied to row lifetime is
    // what closes them.

    it('REGRESSION: retention pruning the drained row does not let a second producer re-surface the completion', () => {
        const meshId = `mesh-prune-${randomUUID().slice(0, 8)}`;
        const store = MeshRuntimeStore.getInstance();

        // 1. mesh-completion-synthesis queues the completion; the coordinator drains it.
        expect(queuePendingMeshCoordinatorEvent(completion(meshId))).toBe(true);
        expect(drainPendingMeshCoordinatorEvents(meshId, CORE)).toHaveLength(1);

        // 2. Retention sweeps the long-drained row, FREEING the unique fingerprint slot
        //    that was doing the real dedup work.
        store.prunePendingEvents({ drainedOlderThanMs: 0, undrainedOlderThanMs: 0 });

        // 3. mesh-reconcile-stranded-dispatch fires for the same stalled task. Nothing is
        //    left to stop it: the row is gone and the drain-gated check never matched
        //    anyway → a second identical [System] completion (the 2nd utterance).
        queuePendingMeshCoordinatorEvent(completion(meshId));
        expect(drainPendingMeshCoordinatorEvents(meshId, CORE)).toHaveLength(0);

        // 4. And a third (the 3rd utterance).
        store.prunePendingEvents({ drainedOlderThanMs: 0, undrainedOlderThanMs: 0 });
        queuePendingMeshCoordinatorEvent(completion(meshId));
        expect(drainPendingMeshCoordinatorEvents(meshId, CORE)).toHaveLength(0);
    });

    it('REGRESSION: TURN-LEDGER outbox redelivery after its row was expired does not double-surface', () => {
        const meshId = `mesh-outbox-${randomUUID().slice(0, 8)}`;
        const store = MeshRuntimeStore.getInstance();

        expect(queuePendingMeshCoordinatorEvent(completion(meshId))).toBe(true);
        const drained = drainPendingMeshCoordinatorEvents(meshId, CORE);
        expect(drained).toHaveLength(1);

        // The unresolved-delegate outbox hard-deletes rows by id to free the fingerprint
        // (mesh-unresolved-forward-outbox — a DIFFERENT machine from the turn outbox,
        // and one that stays: its writers are mesh non-members, so seqscribe cannot
        // take it over). The terminal notification is then replayed after a restart —
        // by the seqscribe redrive consumer since Stage 5c-1, by drainMeshTurnOutbox
        // before it. Either way the exactly-once guarantee is documented as resting on
        // "the pending-events fingerprint dedup", which is exactly what the delete just
        // removed — hence this durable record (gap_b), the third dedup layer.
        const rows = store.recentDrainedPendingEvents(meshId, 10);
        expect(store.deletePendingEventsById(rows.map(r => r.id))).toBeGreaterThan(0);
        MeshRuntimeStore.resetForTests();

        queuePendingMeshCoordinatorEvent(completion(meshId, {
            metadataEvent: {
                nodeId: 'node_worker',
                sessionId: 'worker-session-1',
                taskId: TASK,
                timestamp: 1785432199999, // outbox re-stamps its own time
                finalSummary: 'read-only task complete',
                source: 'turn_outbox_redelivery',
            },
        }));
        expect(drainPendingMeshCoordinatorEvents(meshId, CORE)).toHaveLength(0);
    });

    it('a genuine completion still supersedes an earlier WEAK one for the same task', () => {
        const meshId = `mesh-weak-${randomUUID().slice(0, 8)}`;

        // Weak (false-idle) completion queued and drained.
        queuePendingMeshCoordinatorEvent(completion(meshId, {
            metadataEvent: {
                nodeId: 'node_worker',
                sessionId: 'worker-session-1',
                taskId: TASK,
                timestamp: 1,
                completionDiagnostic: { finalAssistantPresent: false, blockReason: 'missing_final_assistant' },
            },
        }));
        expect(drainPendingMeshCoordinatorEvents(meshId, CORE)).toHaveLength(1);
        // Free the row so this asserts the DURABLE record's behaviour, not the row's.
        MeshRuntimeStore.getInstance().prunePendingEvents({ drainedOlderThanMs: 0, undrainedOlderThanMs: 0 });

        // The REAL completion arrives afterwards. It carries a different weakness marker
        // in the fingerprint, so the durable record must NOT swallow it — this is the
        // Fix C weak-supersede design the task brief forbids breaking.
        queuePendingMeshCoordinatorEvent(completion(meshId));
        expect(drainPendingMeshCoordinatorEvents(meshId, CORE)).toHaveLength(1);
    });

    it('a DIFFERENT task on the same session still surfaces after the first drained', () => {
        const meshId = `mesh-two-tasks-${randomUUID().slice(0, 8)}`;

        // The live scenario: one session ran two read-only tasks back to back.
        queuePendingMeshCoordinatorEvent(completion(meshId));
        expect(drainPendingMeshCoordinatorEvents(meshId, CORE)).toHaveLength(1);
        MeshRuntimeStore.getInstance().prunePendingEvents({ drainedOlderThanMs: 0, undrainedOlderThanMs: 0 });

        queuePendingMeshCoordinatorEvent(completion(meshId, {
            metadataEvent: {
                nodeId: 'node_worker',
                sessionId: 'worker-session-1',
                taskId: 'a-second-distinct-task',
                timestamp: 1785432141999,
                finalSummary: 'second read-only task complete',
            },
        }));
        expect(drainPendingMeshCoordinatorEvents(meshId, CORE)).toHaveLength(1);
    });

    it('does NOT durably dedup a coordinator ALERT — mesh:dispatch_blocked must page again after a drain', () => {
        const meshId = `mesh-alert-${randomUUID().slice(0, 8)}`;
        const alert = (reason: string): PendingMeshCoordinatorEvent => ({
            event: 'mesh:dispatch_blocked',
            meshId,
            nodeLabel: "Node 'node_worker'",
            nodeId: 'node_worker',
            targetCoordinatorDaemonId: CORE,
            metadataEvent: { nodeId: 'node_worker', taskId: TASK, reason },
            coordinatorMessage: `blocked: ${reason}`,
            queuedAt: Date.now(),
        });

        // This is the OPPOSITE defect class (too FEW notifications, fixed by adding
        // `reason` to the fingerprint). Making the durable dedup apply here would
        // silently regress it, so terminal-completion scoping is load-bearing.
        queuePendingMeshCoordinatorEvent(alert('target_session_pin_expired'));
        expect(drainPendingMeshCoordinatorEvents(meshId, CORE)).toHaveLength(1);
        MeshRuntimeStore.getInstance().prunePendingEvents({ drainedOlderThanMs: 0, undrainedOlderThanMs: 0 });

        queuePendingMeshCoordinatorEvent(alert('no_eligible_node'));
        expect(drainPendingMeshCoordinatorEvents(meshId, CORE)).toHaveLength(1);
    });

    it('a terminal completion with NO taskId is not durably deduped (unstable identity)', () => {
        const meshId = `mesh-no-task-${randomUUID().slice(0, 8)}`;
        const noTask = (timestamp: number): PendingMeshCoordinatorEvent => completion(meshId, {
            metadataEvent: {
                nodeId: 'node_worker',
                sessionId: 'worker-session-1',
                timestamp,
                finalSummary: 'ad-hoc completion',
            },
        });

        // Without a taskId the fingerprint falls back to session+timestamp, which is not
        // a stable identity for one completion across producers — durably suppressing on
        // it could silence an unrelated later completion of the same session.
        queuePendingMeshCoordinatorEvent(noTask(1));
        expect(drainPendingMeshCoordinatorEvents(meshId, CORE)).toHaveLength(1);
        MeshRuntimeStore.getInstance().prunePendingEvents({ drainedOlderThanMs: 0, undrainedOlderThanMs: 0 });

        queuePendingMeshCoordinatorEvent(noTask(2));
        expect(drainPendingMeshCoordinatorEvents(meshId, CORE)).toHaveLength(1);
    });
});
