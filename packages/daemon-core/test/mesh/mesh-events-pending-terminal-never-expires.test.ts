import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// TERMINAL-NEVER-EXPIRES (F3-③).
//
// The pending-event retention sweep bounds table growth by deleting undrained rows
// past a 30-day window. That is correct for a LIFECYCLE event (refine:accepted,
// agent:ready, agent:generating_started): its information is re-derivable from level
// state or simply obsolete, and an orphaned one for a coordinator identity that never
// returned is pure garbage.
//
// It is NOT correct for a TERMINAL event. A completion's finalSummary / worker result
// exists ONLY in that pending row — that is precisely why the reconcile loop holds it
// at the idle edge rather than drain-without-inject. Expiring it destroys the single
// copy of a worker's output. Before this fix the sweep applied the age predicate
// uniformly, so a held completion was deleted exactly like a stale lifecycle marker;
// mirroring it to event_held made it *recoverable*, but recovery is a manual operator
// step and is not a substitute for never destroying it.
//
// This file pins the exemption: terminal events are excluded from the undrained
// window outright — not deleted, not mirrored, just left queued and deliverable —
// while lifecycle events keep expiring exactly as before. Without this, fixing the
// loss of held events would have created a LARGER loss than the one it fixed.

const testTmpDir = join(tmpdir(), `adhdev-mesh-terminal-exempt-${randomUUID().slice(0, 8)}`);
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
    PENDING_RETENTION_NEVER_EXPIRE_EVENTS,
    type PendingMeshCoordinatorEvent,
} from '../../src/mesh/mesh-events-pending.js';
import { MESH_FORCE_INJECT_EVENTS } from '../../src/mesh/mesh-event-classify.js';
import { readLedgerEntries, __clearMeshLedgerForTests } from '../../src/mesh/mesh-ledger.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

const DAY = 24 * 60 * 60 * 1000;

function seedUndrained(meshId: string, eventName: string, ageMs: number, taskId: string): PendingMeshCoordinatorEvent {
    const queuedAt = Date.now() - ageMs;
    const event: PendingMeshCoordinatorEvent = {
        event: eventName,
        meshId,
        nodeLabel: "Node 'node_bf91'",
        nodeId: 'node_bf91',
        metadataEvent: {
            nodeId: 'node_bf91',
            sessionId: randomUUID(),
            taskId,
            timestamp: queuedAt,
            finalSummary: `worker output for ${taskId}`,
        },
        coordinatorMessage: 'done',
        queuedAt,
    };
    MeshRuntimeStore.getInstance().insertPendingEvent({
        id: randomUUID(),
        meshId,
        coordinatorDaemonId: null,
        event: eventName,
        payload: event,
        fingerprint: `fp::${randomUUID()}`,
        queuedAt,
    });
    return event;
}

describe('pending-event retention — terminal events never expire', () => {
    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        __resetPendingRetentionCountersForTests();
    });

    afterEach(() => {
        try { MeshRuntimeStore.resetForTests(); } catch { /* best-effort */ }
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        vi.restoreAllMocks();
    });

    it('keeps a terminal completion queued past the undrained window while expiring a lifecycle event of the same age', () => {
        const meshId = `mesh-terminal-exempt-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        __clearMeshLedgerForTests(meshId);

        // Same age (well past the 30-day undrained window), same mesh, same everything
        // except the event NAME — so the only variable is the terminal classification.
        seedUndrained(meshId, 'agent:generating_completed', 45 * DAY, 'task_terminal');
        seedUndrained(meshId, 'refine:accepted', 45 * DAY, 'task_lifecycle');

        expect(MeshRuntimeStore.getInstance().pendingEventCount(meshId)).toBe(2);

        const removed = prunePendingMeshCoordinatorEventsRetention();

        // Exactly one row expired — the lifecycle one. The terminal row survives.
        expect(removed).toBe(1);
        expect(MeshRuntimeStore.getInstance().pendingEventCount(meshId)).toBe(1);

        const survivors = MeshRuntimeStore.getInstance().peekPendingEvents(meshId);
        expect(survivors.map((r: any) => r.event)).toEqual(['agent:generating_completed']);

        const counters = getPendingRetentionCounters();
        expect(counters.undrainedExpired).toBe(1);
        expect(counters.terminalExempt).toBe(1);

        // The lifecycle drop is still mirrored (that behaviour is unchanged)...
        const held = readLedgerEntries(meshId, { kind: ['event_held'] });
        expect(held).toHaveLength(1);
        expect((held[0].payload as any).event).toBe('refine:accepted');
        // ...and the terminal event is NOT mirrored, because it was never dropped.
        // A mirror here would be actively misleading: it would advertise a manual
        // recovery step for an event that is still queued and delivering normally.
        expect(held.some(e => (e.payload as any)?.event === 'agent:generating_completed')).toBe(false);
    });

    it('exempts every event in the force-inject terminal class, at any age', () => {
        const meshId = `mesh-terminal-all-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        __clearMeshLedgerForTests(meshId);

        // The exemption is defined as the whole force-inject class, not a hand-listed
        // subset — pin that so a terminal event added to MESH_FORCE_INJECT_EVENTS
        // later cannot quietly fall outside the protection.
        expect(PENDING_RETENTION_NEVER_EXPIRE_EVENTS).toBe(MESH_FORCE_INJECT_EVENTS);
        expect(PENDING_RETENTION_NEVER_EXPIRE_EVENTS.size).toBeGreaterThan(0);

        const terminalNames = [...PENDING_RETENTION_NEVER_EXPIRE_EVENTS];
        for (const [i, name] of terminalNames.entries()) {
            // 400 days — an age no plausible window would ever tolerate.
            seedUndrained(meshId, name, 400 * DAY, `task_${i}`);
        }

        const removed = prunePendingMeshCoordinatorEventsRetention();

        expect(removed).toBe(0);
        expect(MeshRuntimeStore.getInstance().pendingEventCount(meshId)).toBe(terminalNames.length);
        expect(getPendingRetentionCounters().undrainedExpired).toBe(0);
        expect(getPendingRetentionCounters().terminalExempt).toBe(terminalNames.length);
        expect(readLedgerEntries(meshId, { kind: ['event_held'] })).toHaveLength(0);
    });

    it('still expires a DRAINED terminal row — the exemption protects undelivered output, not table hygiene', () => {
        const meshId = `mesh-terminal-drained-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        __clearMeshLedgerForTests(meshId);

        // A terminal event the coordinator ALREADY consumed. Its output is no longer
        // exclusive to this row, so the 7-day drained window applies normally. Scoping
        // the exemption to undrained rows is what keeps it from becoming an unbounded
        // table leak in the name of safety.
        const db = MeshRuntimeStore.getInstance();
        const id = randomUUID();
        const queuedAt = Date.now() - 10 * DAY;
        db.insertPendingEvent({
            id,
            meshId,
            event: 'agent:generating_completed',
            payload: { event: 'agent:generating_completed', meshId, nodeLabel: 'x', metadataEvent: {}, queuedAt },
            fingerprint: `fp::${randomUUID()}`,
            queuedAt,
        });
        db.markPendingEventsDrainedById([id]);

        const removed = prunePendingMeshCoordinatorEventsRetention();

        expect(removed).toBe(1);
        expect(db.pendingEventCount(meshId)).toBe(0);
        const counters = getPendingRetentionCounters();
        expect(counters.drainedExpired).toBe(1);
        expect(counters.undrainedExpired).toBe(0);
        expect(counters.terminalExempt).toBe(0);
    });
});
