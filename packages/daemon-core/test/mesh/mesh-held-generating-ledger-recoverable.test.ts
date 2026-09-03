import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// NOTIF-LOSS (A1), second half. recordHeldTerminalEventsToLedger mirrors every held
// terminal event into the mesh ledger as `event_held` with `recoverable: true` — the C1
// data-safety guarantee that a held completion is never silently lost.
//
// That guarantee was only half-true for the `generating_no_idle_coordinator` reason: the
// writer emitted the human-readable fields but omitted `heldEvent`, the machine recovery
// copy that requeueHeldMeshCoordinatorEvents reconstructs from. Both other event_held
// feeders (v2 quarantine, retention trim) embed it. So the one reason code responsible
// for ~98% of production holds was the one mesh_requeue_held_events could not recover —
// it reported `unrecoverable` on an entry that claimed to be recoverable.
//
// This test drives the REAL writer, then the REAL requeue path, and asserts the round
// trip restores a drainable event. Dropping `heldEvent` from the writer turns it red.

const testTmpDir = join(tmpdir(), `adhdev-held-generating-ledger-${randomUUID().slice(0, 8)}`);
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
    getPendingMeshCoordinatorEvents,
    requeueHeldMeshCoordinatorEvents,
    __clearMeshPendingEventsForTests,
} from '../../src/mesh/mesh-events-pending.js';
import { recordHeldTerminalEventsToLedger } from '../../src/mesh/mesh-reconcile-coordinator-drain.js';
import { readLedgerEntries, __clearMeshLedgerForTests } from '../../src/mesh/mesh-ledger.js';

const BARE = 'mach_1b46842a15d3409d96ad33e767a916dd';
const HELD_REASON = 'generating_no_idle_coordinator';

function queueCompletion(meshId: string, taskId: string): void {
    queuePendingMeshCoordinatorEvent({
        event: 'agent:generating_completed',
        meshId,
        nodeLabel: "Node 'node_bf91'",
        nodeId: 'node_bf91',
        metadataEvent: {
            nodeId: 'node_bf91',
            sessionId: randomUUID(),
            taskId,
            timestamp: Date.now(),
            finalSummary: 'worker done',
        },
        coordinatorMessage: '[System] worker completed',
        queuedAt: Date.now(),
        targetCoordinatorDaemonId: BARE,
    });
}

describe('held `generating_no_idle_coordinator` events are ledger-recoverable (A1/notif-loss)', () => {
    let meshId: string;

    beforeEach(() => {
        meshId = `mesh-held-gen-${randomUUID().slice(0, 8)}`;
        try { __clearMeshPendingEventsForTests(meshId); } catch { /* best-effort */ }
        try { __clearMeshLedgerForTests(meshId); } catch { /* best-effort */ }
    });

    afterAll(() => {
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('embeds the full original event so mesh_requeue_held_events can restore it', () => {
        queueCompletion(meshId, 'task_hold_1');

        // The reconcile loop holds the completion: coordinator is generating, no idle target.
        recordHeldTerminalEventsToLedger(meshId, [BARE], HELD_REASON, 1);

        const held = readLedgerEntries(meshId).filter(e => e.kind === 'event_held');
        expect(held).toHaveLength(1);
        const payload = held[0].payload as Record<string, unknown>;
        expect(payload.reason).toBe(HELD_REASON);
        expect(payload.recoverable).toBe(true);
        // THE FIX: the machine recovery copy must be present, matching the other feeders.
        expect(payload.heldEvent).toBeTruthy();
        expect((payload.heldEvent as Record<string, unknown>).event).toBe('agent:generating_completed');

        // Simulate the coordinator session being lost before re-drain: the pending row is
        // gone, so the ledger is the only surviving copy.
        __clearMeshPendingEventsForTests(meshId);
        expect(getPendingMeshCoordinatorEvents(meshId, BARE)).toHaveLength(0);

        const result = requeueHeldMeshCoordinatorEvents(meshId, { reason: HELD_REASON });
        expect(result.matched).toBe(1);
        expect(result.unrecoverable).toBe(0);
        expect(result.requeued).toBe(1);

        // Restored losslessly and drainable again.
        const restored = getPendingMeshCoordinatorEvents(meshId, BARE);
        expect(restored).toHaveLength(1);
        expect(restored[0].event).toBe('agent:generating_completed');
        expect(restored[0].nodeId).toBe('node_bf91');
        expect(restored[0].coordinatorMessage).toBe('[System] worker completed');
        expect((restored[0].metadataEvent as Record<string, unknown>).taskId).toBe('task_hold_1');
        expect((restored[0].metadataEvent as Record<string, unknown>).finalSummary).toBe('worker done');
    });

    it('does not double-restore when the pending copy is still live', () => {
        queueCompletion(meshId, 'task_hold_2');
        recordHeldTerminalEventsToLedger(meshId, [BARE], HELD_REASON, 1);

        // The normal case: the row was never destroyed, it simply re-drains on the next
        // idle tick. The recovery is still counted as attempted (`requeued` dedups on the
        // attempt, not on delivery — see requeueHeldMeshCoordinatorEvents), but the queue
        // side must collapse it so the coordinator is never told twice.
        const result = requeueHeldMeshCoordinatorEvents(meshId, { reason: HELD_REASON });
        expect(result.unrecoverable).toBe(0);
        expect(result.dedupSuppressed).toBe(1);
        expect(getPendingMeshCoordinatorEvents(meshId, BARE)).toHaveLength(1);
    });
});
