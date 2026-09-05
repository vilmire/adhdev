import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Pending-event retention sweep observability.
//
// The JSONL pending-event trim (50-entry cap) used to mirror every event it dropped
// into the ledger as a recoverable `event_held` (reason: pending_trim_dropped), so an
// operator running mesh_requeue_held_events could recover it. That trim — and its
// mirror — was retired in favor of a single SQLite store with a time-based retention
// sweep (prunePendingMeshCoordinatorEventsRetention: drained rows >7d, undrained rows
// >30d). The sweep kept the bound but dropped the mirror: an undrained-expired row
// (queued for a coordinator that never drained it) was deleted with NO ledger trace
// and NO log line naming the drop — the exact silent-loss shape the JSONL mirror used
// to prevent, just triggered by age instead of count.
//
// This file pins the fix: the sweep must mirror every undrained-expired row to
// event_held (reason: pending_retention_expired) BEFORE deleting it, bump an
// observable counter, and log at WARN — all at the moment of the drop, not only
// discoverable later by running mesh_requeue_held_events.

const testTmpDir = join(tmpdir(), `adhdev-mesh-retention-obs-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'mach_1b46842a15d3409d96ad33e767a916dd' }),
}));

import {
    prunePendingMeshCoordinatorEventsRetention,
    getPendingRetentionCounters,
    __resetPendingRetentionCountersForTests,
    __clearMeshPendingEventsForTests,
    requeueHeldMeshCoordinatorEvents,
    PENDING_RETENTION_EXPIRED_HOLD_REASON,
    type PendingMeshCoordinatorEvent,
} from '../../src/mesh/mesh-events-pending.js';
import { readLedgerEntries, __clearMeshLedgerForTests } from '../../src/mesh/mesh-ledger.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { LOG } from '../../src/logging/logger.js';

const DAY = 24 * 60 * 60 * 1000;

function seedUndrainedEvent(meshId: string, ageMs: number, over: Partial<PendingMeshCoordinatorEvent> = {}): PendingMeshCoordinatorEvent {
    const queuedAt = Date.now() - ageMs;
    const event: PendingMeshCoordinatorEvent = {
        // A LIFECYCLE event: the retention window's actual subject. Terminal events
        // (agent:generating_completed & co.) are exempt from expiry entirely — see
        // the TERMINAL-NEVER-EXPIRES suite in
        // mesh-events-pending-terminal-never-expires.test.ts — so seeding one here
        // would test a path that no longer exists.
        event: 'refine:accepted',
        meshId,
        nodeLabel: "Node 'node_bf91'",
        nodeId: 'node_bf91',
        metadataEvent: { nodeId: 'node_bf91', sessionId: randomUUID(), taskId: 'task_retention_1', timestamp: queuedAt, finalSummary: 'worker done' },
        coordinatorMessage: 'done',
        queuedAt,
        ...over,
    };
    MeshRuntimeStore.getInstance().insertPendingEvent({
        id: randomUUID(),
        meshId,
        coordinatorDaemonId: event.targetCoordinatorDaemonId ?? null,
        event: event.event,
        payload: event,
        fingerprint: `fp::${randomUUID()}`,
        queuedAt,
    });
    return event;
}

describe('pending-event retention sweep — drop observability', () => {
    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        __resetPendingRetentionCountersForTests();
    });

    afterEach(() => {
        try { MeshRuntimeStore.resetForTests(); } catch { /* best-effort */ }
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        vi.restoreAllMocks();
    });

    it('mirrors an undrained-expired row to event_held BEFORE deleting it, and bumps the counter', () => {
        const meshId = `mesh-retention-drop-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        __clearMeshLedgerForTests(meshId);

        // Never drained, queued 31 days ago — past the 30-day undrained window. This is
        // the exact shape of the real-world drop: a coordinator that never came back to
        // drain its inbox before the sweep expired the row.
        seedUndrainedEvent(meshId, 31 * DAY);
        // A fresh undrained row — must survive, and must NOT be mirrored.
        seedUndrainedEvent(meshId, 1 * DAY, { metadataEvent: { taskId: 'task_fresh' } });

        expect(MeshRuntimeStore.getInstance().pendingEventCount(meshId)).toBe(2);

        const removed = prunePendingMeshCoordinatorEventsRetention();
        expect(removed).toBe(1);

        // The expired row is gone from the live queue...
        expect(MeshRuntimeStore.getInstance().pendingEventCount(meshId)).toBe(1);

        // ...but it did NOT vanish: it is recorded as a recoverable event_held entry,
        // stamped with a reason distinct from the retired JSONL trim's
        // pending_trim_dropped (the trigger is genuinely different — age, not count).
        const held = readLedgerEntries(meshId, { kind: ['event_held'] });
        expect(held).toHaveLength(1);
        const payload = held[0].payload as any;
        expect(payload.reason).toBe(PENDING_RETENTION_EXPIRED_HOLD_REASON);
        expect(payload.reason).not.toBe('pending_trim_dropped');
        expect(payload.recoverable).toBe(true);
        expect(payload.event).toBe('refine:accepted');
        expect(payload.heldEvent?.metadataEvent?.taskId).toBe('task_retention_1');

        // The ledger entry's own timestamp is the drop time — set by appendLedgerEntry
        // at write time, independent of whenever an operator later runs
        // mesh_requeue_held_events. This is what prevents the recovery-time /
        // drop-time confusion the task flagged.
        const droppedAt = new Date(held[0].timestamp).getTime();
        expect(Math.abs(Date.now() - droppedAt)).toBeLessThan(5000);

        // Observable counters reflect exactly one genuine drop.
        const counters = getPendingRetentionCounters();
        expect(counters.undrainedExpired).toBe(1);
        expect(counters.undrainedExpiredMirrorFailed).toBe(0);

        // And it is recoverable through the existing, untouched requeue path.
        const requeueResult = requeueHeldMeshCoordinatorEvents(meshId, { reason: PENDING_RETENTION_EXPIRED_HOLD_REASON });
        expect(requeueResult.requeued).toBe(1);
        expect(requeueResult.unrecoverable).toBe(0);
    });

    it('logs a WARN at the moment of the drop, naming the count and mesh', () => {
        const meshId = `mesh-retention-warn-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        __clearMeshLedgerForTests(meshId);

        seedUndrainedEvent(meshId, 40 * DAY);
        seedUndrainedEvent(meshId, 35 * DAY, { metadataEvent: { taskId: 'task_retention_2' } });

        const warnSpy = vi.spyOn(LOG, 'warn');
        prunePendingMeshCoordinatorEventsRetention();

        const dropWarnCall = warnSpy.mock.calls.find(call =>
            typeof call[1] === 'string' && call[1].includes('DROPPED') && call[1].includes('never-delivered'),
        );
        expect(dropWarnCall).toBeDefined();
        expect(dropWarnCall?.[1]).toContain('2 never-delivered event(s)');
        expect(dropWarnCall?.[1]).toContain(meshId);
        expect(dropWarnCall?.[1]).toContain('mesh_requeue_held_events');
    });

    it('does NOT mirror or warn for drained-expired rows — they already reached a coordinator', () => {
        const meshId = `mesh-retention-drained-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        __clearMeshLedgerForTests(meshId);

        const db = MeshRuntimeStore.getInstance();
        const id = randomUUID();
        const queuedAt = Date.now() - 10 * DAY;
        db.insertPendingEvent({ id, meshId, event: 'agent:ready', payload: { event: 'agent:ready', meshId, nodeLabel: 'x', metadataEvent: {}, queuedAt }, fingerprint: `fp::${randomUUID()}`, queuedAt });
        db.markPendingEventsDrainedById([id]);

        const warnSpy = vi.spyOn(LOG, 'warn');
        const removed = prunePendingMeshCoordinatorEventsRetention();
        expect(removed).toBe(1);

        // No event_held entry — a drained row already reached its coordinator, so
        // deleting it later is retention hygiene, not a drop.
        const held = readLedgerEntries(meshId, { kind: ['event_held'] });
        expect(held).toHaveLength(0);

        const dropWarnCall = warnSpy.mock.calls.find(call =>
            typeof call[1] === 'string' && call[1].includes('DROPPED'),
        );
        expect(dropWarnCall).toBeUndefined();

        const counters = getPendingRetentionCounters();
        expect(counters.drainedExpired).toBe(1);
        expect(counters.undrainedExpired).toBe(0);
    });

    it('is a no-op with a clean counter snapshot when nothing is stale', () => {
        const meshId = `mesh-retention-noop-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        __clearMeshLedgerForTests(meshId);

        seedUndrainedEvent(meshId, 1 * DAY);

        const removed = prunePendingMeshCoordinatorEventsRetention();
        expect(removed).toBe(0);

        const counters = getPendingRetentionCounters();
        expect(counters.undrainedExpired).toBe(0);
        expect(counters.drainedExpired).toBe(0);
        expect(counters.sweepsNoop).toBe(1);

        const held = readLedgerEntries(meshId, { kind: ['event_held'] });
        expect(held).toHaveLength(0);
    });
});
