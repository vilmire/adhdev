import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// G2 — mesh_requeue_held_events: restore recoverable `event_held` ledger entries back
// to the pending coordinator queue.
//
// T6 quarantine (v2 enforce) and the pending-events trim mirror a destructively-drained-
// but-undelivered event into the ledger as a recoverable `event_held` entry. Until this
// gap was closed the recovery channel was audit-only ("an operator can requeue it") with
// no code path. requeueHeldMeshCoordinatorEvents implements that path with two invariants:
//   • no loss   — the full original event is restored (drainable again),
//   • no double — dedup on the queue side (still-live duplicate) AND on the held-entry
//                 side (a second requeue pass skips already-recovered entries).

const testTmpDir = join(tmpdir(), `adhdev-mesh-requeue-held-${randomUUID().slice(0, 8)}`);
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
    getPendingMeshCoordinatorEvents,
    requeueHeldMeshCoordinatorEvents,
    __resetMeshV2DrainCountersForTests,
    __resetMeshV2WarnDedupForTests,
    __clearMeshPendingEventsForTests,
    type PendingMeshCoordinatorEvent,
} from '../../src/mesh/mesh-events-pending.js';
import { readLedgerEntries, appendLedgerEntry, __clearMeshLedgerForTests } from '../../src/mesh/mesh-ledger.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import type { CoordinatorIdentity } from '../../src/mesh/contracts.js';

const BARE = 'mach_1b46842a15d3409d96ad33e767a916dd';

function makeTerminal(meshId: string, over: Partial<PendingMeshCoordinatorEvent> = {}): PendingMeshCoordinatorEvent {
    return {
        event: 'agent:generating_completed',
        meshId,
        nodeLabel: "Node 'node_bf91'",
        nodeId: 'node_bf91',
        metadataEvent: { nodeId: 'node_bf91', sessionId: randomUUID(), taskId: 'task_hold_1', timestamp: Date.now(), finalSummary: 'worker done' },
        coordinatorMessage: 'done',
        queuedAt: Date.now(),
        targetCoordinatorDaemonId: BARE,
        ...over,
    };
}

function ident(daemonId: string, over: Partial<CoordinatorIdentity> = {}): CoordinatorIdentity {
    return { daemonId, coordinatorRunId: daemonId, ...over };
}

/** Produce a recoverable `event_held` ledger entry carrying the full original event
 *  (the shape the enforce-quarantine / pending-trim sites now write). */
function seedHeldEvent(meshId: string, event: PendingMeshCoordinatorEvent, reason: string): void {
    appendLedgerEntry(meshId, {
        kind: 'event_held',
        ...(event.nodeId ? { nodeId: event.nodeId } : {}),
        payload: {
            event: event.event,
            reason,
            recoverable: true,
            nodeLabel: event.nodeLabel,
            targetCoordinatorDaemonId: event.targetCoordinatorDaemonId ?? null,
            queuedAt: event.queuedAt,
            finalSummary: 'worker done',
            heldEvent: event,
        },
    });
}

describe('G2: mesh_requeue_held_events (event_held → pending)', () => {
    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        __resetMeshV2DrainCountersForTests();
        __resetMeshV2WarnDedupForTests();
    });

    afterEach(() => {
        try { MeshRuntimeStore.resetForTests(); } catch { /* best-effort */ }
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('restores a held event to the pending queue so it drains again', () => {
        const meshId = `mesh-requeue-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        __clearMeshLedgerForTests(meshId);

        const original = makeTerminal(meshId);
        seedHeldEvent(meshId, original, 'v2_enforce_validation_failed_quarantined');

        // Nothing pending yet (the event was destructively drained before being held).
        expect(getPendingMeshCoordinatorEvents(meshId, BARE)).toHaveLength(0);

        const result = requeueHeldMeshCoordinatorEvents(meshId);
        expect(result.matched).toBe(1);
        expect(result.requeued).toBe(1);
        expect(result.dedupSuppressed).toBe(0);
        expect(result.unrecoverable).toBe(0);

        // It is now drainable again — same event name + summary restored losslessly.
        const drained = drainPendingMeshCoordinatorEvents(meshId, BARE, {
            drainerIdentity: ident(BARE, { sessionId: 'any_session' }),
        }) as PendingMeshCoordinatorEvent[];
        expect(drained).toHaveLength(1);
        expect(drained[0].event).toBe('agent:generating_completed');
        expect(drained[0].metadataEvent?.taskId).toBe('task_hold_1');

        // An audit marker keyed by the source held-entry id was written.
        const markers = readLedgerEntries(meshId, { kind: ['event_held_requeued'] });
        expect(markers).toHaveLength(1);
        expect((markers[0].payload as any).requeued).toBe(true);
    });

    it('does not requeue the same held entry twice across two passes (no double-requeue)', () => {
        const meshId = `mesh-requeue-dbl-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        __clearMeshLedgerForTests(meshId);

        seedHeldEvent(meshId, makeTerminal(meshId), 'pending_trim_dropped');

        const first = requeueHeldMeshCoordinatorEvents(meshId);
        expect(first.requeued).toBe(1);

        // Drain the restored event so the queue is empty again.
        drainPendingMeshCoordinatorEvents(meshId, BARE, { drainerIdentity: ident(BARE, { sessionId: 's' }) });

        // Second pass: the held entry is already marked recovered → skipped, NOT re-added.
        const second = requeueHeldMeshCoordinatorEvents(meshId);
        expect(second.matched).toBe(1);
        expect(second.alreadyRequeued).toBe(1);
        expect(second.requeued).toBe(0);

        // No new pending event was created by the second pass.
        expect(getPendingMeshCoordinatorEvents(meshId, BARE)).toHaveLength(0);
    });

    it('dedups against a still-live pending duplicate rather than double-delivering', () => {
        const meshId = `mesh-requeue-live-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        __clearMeshLedgerForTests(meshId);

        // The same event is BOTH live in the queue and recorded as held (e.g. it was
        // re-emitted after the hold). Requeue must not create a second copy.
        const original = makeTerminal(meshId);
        queuePendingMeshCoordinatorEvent({ ...original });
        seedHeldEvent(meshId, original, 'pending_trim_dropped');

        const before = getPendingMeshCoordinatorEvents(meshId, BARE).length;
        const result = requeueHeldMeshCoordinatorEvents(meshId);
        expect(result.matched).toBe(1);
        expect(result.dedupSuppressed).toBe(1);

        // Still exactly one pending copy — the queue dedup collapsed the requeue.
        expect(getPendingMeshCoordinatorEvents(meshId, BARE).length).toBe(before);
    });

    it('honors the filter (event / node / reason) within the mesh scope', () => {
        const meshId = `mesh-requeue-filter-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        __clearMeshLedgerForTests(meshId);

        seedHeldEvent(meshId, makeTerminal(meshId, { event: 'agent:generating_completed', nodeId: 'node_a' }), 'pending_trim_dropped');
        seedHeldEvent(meshId, makeTerminal(meshId, { event: 'refine:completed', nodeId: 'node_b' }), 'v2_enforce_validation_failed_quarantined');

        // Filter by node — only node_b's held event is considered.
        const byNode = requeueHeldMeshCoordinatorEvents(meshId, { nodeId: 'node_b' });
        expect(byNode.matched).toBe(1);
        expect(byNode.requeued).toBe(1);
        expect(byNode.entries[0].event).toBe('refine:completed');

        // Filter by reason — only the trim-dropped one remains un-recovered.
        const byReason = requeueHeldMeshCoordinatorEvents(meshId, { reason: 'pending_trim_dropped' });
        expect(byReason.matched).toBe(1);
        expect(byReason.entries[0].event).toBe('agent:generating_completed');
    });

    it('reports an un-restorable held entry (no embedded original) as unrecoverable, not requeued', () => {
        const meshId = `mesh-requeue-unrec-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        __clearMeshLedgerForTests(meshId);

        // A legacy held entry written before `heldEvent` was embedded — flat fields only.
        appendLedgerEntry(meshId, {
            kind: 'event_held',
            payload: { event: 'agent:generating_completed', reason: 'pending_trim_dropped', recoverable: true, nodeLabel: 'x', queuedAt: Date.now() },
        });

        const result = requeueHeldMeshCoordinatorEvents(meshId);
        expect(result.matched).toBe(1);
        expect(result.unrecoverable).toBe(1);
        expect(result.requeued).toBe(0);
        expect(getPendingMeshCoordinatorEvents(meshId, BARE)).toHaveLength(0);
    });
});
