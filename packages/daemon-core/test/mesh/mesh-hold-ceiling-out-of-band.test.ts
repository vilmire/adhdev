import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// HOLD-CEILING (F1). A unicast terminal completion could be held indefinitely under
// `generating_no_idle_coordinator`.
//
// The mechanism: the age-escape re-fires every 4s tick once the held event passes the
// 12s escalate threshold, but every attempt is gated on
// reconfirmGenuinelyIdleCoordinators() reading the coordinator's RAW PTY as idle. A
// coordinator parked waiting on an owner answer is conversationally idle while its PTY
// turn stays OPEN — getDrainStatus() reads 'generating' — so the gate refuses on every
// tick and nothing bounds the hold. Measured worst case: 873s (14m33s).
//
// The fix is NOT to loosen that gate: raw-writing into a generating PTY is the
// data-loss force-inject path that was deliberately removed and stays removed. Instead,
// past a hard ceiling the loop stops treating PTY injection as the only delivery route
// and records the event to the out-of-band surface (an event_held ledger entry, which
// mesh_status projects via pendingCoordinatorEvents on the coordinator's next tool
// call — PTY state irrelevant). The event stays queued and still delivers normally when
// the PTY genuinely idles; the surface is ADDITIVE.
//
// These tests drive time with fake timers and assert: below the ceiling nothing is
// surfaced; past it the terminal event is recorded out-of-band exactly once (the 4s
// tick must not spam the ledger); lifecycle events are never surfaced; and the event is
// never drained/marked delivered by the surfacing.

const testTmpDir = join(tmpdir(), `adhdev-hold-ceiling-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'mach_1b46842a15d3409d96ad33e767a916dd' }),
}));

import {
    surfaceCeilingExceededHeldEvents,
    HOLD_CEILING_EXCEEDED_HOLD_REASON,
    __resetHoldCeilingDedupForTests,
} from '../../src/mesh/mesh-reconcile-coordinator-drain.js';
import {
    __clearMeshPendingEventsForTests,
    type PendingMeshCoordinatorEvent,
} from '../../src/mesh/mesh-events-pending.js';
import { readLedgerEntries, __clearMeshLedgerForTests } from '../../src/mesh/mesh-ledger.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { resolvePendingHeldCeilingMs, DEFAULT_PENDING_HELD_CEILING_MS } from '../../src/mesh/mesh-reconcile-config.js';

const CEILING = DEFAULT_PENDING_HELD_CEILING_MS; // 120s

function seedHeldEvent(meshId: string, eventName: string, taskId: string): PendingMeshCoordinatorEvent {
    const queuedAt = Date.now();
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
        fingerprint: `fp::${taskId}`,
        queuedAt,
    });
    return event;
}

describe('hold ceiling — out-of-band surfacing of an unboundedly-held completion', () => {
    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        __resetHoldCeilingDedupForTests();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        try { MeshRuntimeStore.resetForTests(); } catch { /* best-effort */ }
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        vi.restoreAllMocks();
    });

    it('does not surface a completion still under the ceiling', () => {
        const meshId = `mesh-ceiling-under-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        __clearMeshLedgerForTests(meshId);

        seedHeldEvent(meshId, 'agent:generating_completed', 'task_under');

        // 119s — one second short of the 120s bound. A normal mid-turn hold or a brief
        // owner round-trip must never be escalated.
        vi.advanceTimersByTime(CEILING - 1_000);
        const surfaced = surfaceCeilingExceededHeldEvents(meshId, [], CEILING, 1);

        expect(surfaced).toBe(0);
        expect(readLedgerEntries(meshId, { kind: ['event_held'] })).toHaveLength(0);
    });

    it('surfaces the completion out-of-band once the hold passes the ceiling — carrying the full event and the hold duration', () => {
        const meshId = `mesh-ceiling-over-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        __clearMeshLedgerForTests(meshId);

        seedHeldEvent(meshId, 'agent:generating_completed', 'task_over');

        // The real-world shape: the coordinator is parked on an owner question, its PTY
        // turn never closes, and the age-escape is refused every tick. Wall-clock well
        // past the ceiling (the observed defect ran to 873s).
        vi.advanceTimersByTime(900_000);
        const surfaced = surfaceCeilingExceededHeldEvents(meshId, [], CEILING, 1);

        expect(surfaced).toBe(1);

        const held = readLedgerEntries(meshId, { kind: ['event_held'] });
        expect(held).toHaveLength(1);
        const payload = held[0].payload as any;

        // Stamped with its OWN reason, distinct from the ordinary hold audit — that is
        // what lets an operator tell "held, normal" from "held past the bound".
        expect(payload.reason).toBe(HOLD_CEILING_EXCEEDED_HOLD_REASON);
        expect(payload.reason).not.toBe('generating_no_idle_coordinator');
        expect(payload.surfacedOutOfBand).toBe(true);
        expect(payload.recoverable).toBe(true);
        expect(payload.event).toBe('agent:generating_completed');

        // The two numbers an operator needs to distinguish a one-off settle from a
        // structurally-parked coordinator.
        expect(payload.ceilingMs).toBe(CEILING);
        expect(payload.heldMs).toBeGreaterThanOrEqual(900_000);

        // The full event rides along, so mesh_requeue_held_events can restore it and the
        // worker's output is readable from the surface itself.
        expect(payload.heldEvent?.metadataEvent?.taskId).toBe('task_over');
        expect(payload.finalSummary).toBe('worker output for task_over');

        // CRITICAL: surfacing is ADDITIVE. The event must remain queued and undrained so
        // normal PTY delivery still happens when the coordinator genuinely idles. If
        // surfacing consumed the event, this fix would replace an unbounded hold with a
        // silent drop for any coordinator that does not read mesh_status.
        expect(MeshRuntimeStore.getInstance().pendingEventCount(meshId)).toBe(1);
    });

    it('surfaces once, not every tick — a 4s reconcile cadence must not spam the ledger', () => {
        const meshId = `mesh-ceiling-dedup-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        __clearMeshLedgerForTests(meshId);

        seedHeldEvent(meshId, 'agent:generating_completed', 'task_dedup');
        vi.advanceTimersByTime(CEILING + 1_000);

        // Ten consecutive reconcile ticks with the coordinator still parked.
        let total = 0;
        for (let i = 0; i < 10; i++) {
            total += surfaceCeilingExceededHeldEvents(meshId, [], CEILING, 1);
            vi.advanceTimersByTime(4_000);
        }

        expect(total).toBe(1);
        expect(readLedgerEntries(meshId, { kind: ['event_held'] })).toHaveLength(1);
    });

    it('never surfaces a lifecycle event — only terminal events carry irreplaceable output', () => {
        const meshId = `mesh-ceiling-lifecycle-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        __clearMeshLedgerForTests(meshId);

        // agent:ready / generating_started re-drain harmlessly and carry no worker
        // output, so escalating them would be pure noise on the coordinator's surface.
        seedHeldEvent(meshId, 'agent:ready', 'task_ready');
        seedHeldEvent(meshId, 'agent:generating_started', 'task_started');

        vi.advanceTimersByTime(900_000);
        const surfaced = surfaceCeilingExceededHeldEvents(meshId, [], CEILING, 1);

        expect(surfaced).toBe(0);
        expect(readLedgerEntries(meshId, { kind: ['event_held'] })).toHaveLength(0);
    });

    it('resolves a ceiling that cannot be tuned back into an unbounded hold', () => {
        // The bound exists to eliminate the unbounded hold, so env tuning must not be
        // able to reintroduce it — and must not undercut the ordinary 12s escape either.
        expect(resolvePendingHeldCeilingMs()).toBe(DEFAULT_PENDING_HELD_CEILING_MS);

        const prev = process.env.MESH_PENDING_HELD_CEILING_MS;
        try {
            process.env.MESH_PENDING_HELD_CEILING_MS = '999999999';
            expect(resolvePendingHeldCeilingMs()).toBeLessThanOrEqual(30 * 60_000);
            process.env.MESH_PENDING_HELD_CEILING_MS = '1';
            expect(resolvePendingHeldCeilingMs()).toBeGreaterThanOrEqual(12_000);
        } finally {
            if (prev === undefined) delete process.env.MESH_PENDING_HELD_CEILING_MS;
            else process.env.MESH_PENDING_HELD_CEILING_MS = prev;
        }
    });
});
