import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// B3a — mesh protocol v2 drain-side receive path (accept-and-warn). The drain applies:
//   (1) unicast routing — a v2 unicast event addressed to a DIFFERENT coordinator on the
//       same daemon is NOT surfaced to this drainer (no cross-surface).
//   (2) v1 events → broadcast (rollout policy, pass-through).
//   (3) heterogeneous daemon-id forms (mach_ / daemon_mach_ / standalone_mach_) resolve to
//       the SAME coordinator identity so a completion stamped in any form is delivered.
//   (4) eventId idempotency — a v2 event whose eventId was already drained is skipped.
//   (5) accept-and-warn — a malformed/misversioned v2 envelope is PASSED THROUGH, not
//       dropped, with a counter bump (no v1 regression before enforce mode / T6).
//   (6) re-attribution — a unicast event orphaned by a coordinatorRunId restart is
//       re-attributed to the current coordinator on the same machine (never dropped).

const testTmpDir = join(tmpdir(), `adhdev-mesh-v2-drain-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    // The self-daemon fallback in stampPendingEventV2 reads loadConfig().machineId.
    loadConfig: () => ({ machineId: 'mach_1b46842a15d3409d96ad33e767a916dd' }),
}));

import {
    queuePendingMeshCoordinatorEvent,
    stampPendingEventV2,
    getPendingMeshCoordinatorEvents,
    drainPendingMeshCoordinatorEvents,
    getMeshV2DrainCounters,
    __resetMeshV2DrainCountersForTests,
    __resetMeshV2WarnDedupForTests,
    __clearMeshPendingEventsForTests,
    __persistUnstampedPendingEventForTests,
    type PendingMeshCoordinatorEvent,
} from '../../src/mesh/mesh-events-pending.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import type { CoordinatorIdentity } from '../../src/mesh/contracts.js';

// Same machine core, three interchangeable daemon-id forms.
const CORE = 'mach_1b46842a15d3409d96ad33e767a916dd';
const BARE = CORE;                              // mach_…
const CLOUD = `daemon_${CORE}`;                 // daemon_mach_…
const STANDALONE = `standalone_${CORE}`;        // standalone_mach_…
const OTHER_CORE = 'mach_ffffffffffffffffffffffffffffffff';

function makeTerminal(meshId: string, over: Partial<PendingMeshCoordinatorEvent> = {}): PendingMeshCoordinatorEvent {
    return {
        event: 'agent:generating_completed',
        meshId,
        nodeLabel: "Node 'node_bf91'",
        nodeId: 'node_bf91',
        metadataEvent: { nodeId: 'node_bf91', sessionId: randomUUID(), taskId: randomUUID(), timestamp: Date.now() },
        coordinatorMessage: 'done',
        queuedAt: Date.now(),
        targetCoordinatorDaemonId: BARE,
        ...over,
    };
}

function ident(daemonId: string, over: Partial<CoordinatorIdentity> = {}): CoordinatorIdentity {
    return { daemonId, coordinatorRunId: daemonId, ...over };
}

describe('mesh pending-event — v2 drain routing (B3a accept-and-warn)', () => {
    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        __resetMeshV2DrainCountersForTests();
        __resetMeshV2WarnDedupForTests();
        // This suite exercises the ACCEPT-AND-WARN drain path (v1 broadcast fallback,
        // malformed-v2 pass-through). Enforce now defaults ON, so pin it OFF here — the
        // enforce/quarantine behaviour has its own dedicated suite.
        process.env.MESH_PROTOCOL_V2_ENFORCE = '0';
    });

    afterEach(() => {
        delete process.env.MESH_PROTOCOL_V2_ENFORCE;
        try { MeshRuntimeStore.resetForTests(); } catch { /* best-effort */ }
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    // ── (a) unicast mis-delivery block — two coordinators, only one receives ──────
    it('does NOT surface a v2 unicast event to a sibling coordinator on the same daemon', () => {
        const meshId = `mesh-uni-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);

        const sessA = `sess_${randomUUID().slice(0, 8)}`;
        const sessB = `sess_${randomUUID().slice(0, 8)}`;
        // Two terminal events, both daemon-scoped to BARE (so the daemon filter passes
        // both to any coordinator on this daemon) but addressed (via session) to two
        // DIFFERENT coordinator sessions.
        queuePendingMeshCoordinatorEvent(makeTerminal(meshId, { targetCoordinatorSessionId: sessA, coordinatorMessage: 'for A' }));
        queuePendingMeshCoordinatorEvent(makeTerminal(meshId, { targetCoordinatorSessionId: sessB, coordinatorMessage: 'for B' }));

        // Coordinator A drains with its full identity (sessionId = sessA).
        const drainedForA = drainPendingMeshCoordinatorEvents(meshId, BARE, {
            drainerIdentity: ident(BARE, { sessionId: sessA }),
        }) as PendingMeshCoordinatorEvent[];

        expect(drainedForA).toHaveLength(1);
        expect(drainedForA[0].coordinatorMessage).toBe('for A');
        expect(drainedForA[0].intendedFor?.sessionId).toBe(sessA);
        // The event for B was routed away (still queued for B's own drain).
        expect(getMeshV2DrainCounters().v2RoutedAway).toBe(1);
        expect(getMeshV2DrainCounters().v2Delivered).toBe(1);
    });

    // ── (b) v1 event is treated as broadcast (delivered to any coordinator) ───────
    it('treats a v1 (unversioned) event as broadcast — delivered regardless of drainer', () => {
        const meshId = `mesh-v1b-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);

        // A genuinely-unversioned (v1) row — the shape a pre-v2 daemon persisted or a
        // version-skewed remote relay delivers. The local emit path no longer produces
        // one (self-daemon fallback stamps every emit), so inject it directly to exercise
        // the drain-side v1 broadcast handling.
        const v1 = makeTerminal(meshId, { coordinatorMessage: 'v1 broadcast' });
        delete (v1 as any).targetCoordinatorDaemonId;
        __persistUnstampedPendingEventForTests(v1);

        const drained = drainPendingMeshCoordinatorEvents(meshId, BARE, {
            drainerIdentity: ident(BARE, { sessionId: 'any_session' }),
        }) as PendingMeshCoordinatorEvent[];

        expect(drained).toHaveLength(1);
        expect(drained[0].protocolVersion).toBeUndefined();
        expect(drained[0].coordinatorMessage).toBe('v1 broadcast');
        expect(getMeshV2DrainCounters().v1BroadcastAccepted).toBe(1);
    });

    // ── (c) heterogeneous daemon-id forms resolve to the SAME coordinator ─────────
    it('matches a unicast event stamped daemon_mach_ to a drainer that knows itself as bare mach_', () => {
        const meshId = `mesh-form-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);

        // Event addressed via the CLOUD form (daemon_mach_…) — an unscoped daemon so the
        // SQLite/JSONL filter (NULL branch) passes it, then v2 identity match must accept
        // it for a BARE-form drainer.
        const stamped = stampPendingEventV2(makeTerminal(meshId, { coordinatorMessage: 'cross-form' }), {
            dispatchedBy: ident(CLOUD),
            intendedFor: ident(CLOUD),
        });
        // Persist WITHOUT a daemon scope so the daemon filter is a no-op and v2 identity
        // does the work.
        delete (stamped as any).targetCoordinatorDaemonId;
        queuePendingMeshCoordinatorEvent(stamped);

        // Drainer knows itself only as bare mach_ (and its standalone form).
        const drained = drainPendingMeshCoordinatorEvents(meshId, [BARE, STANDALONE], {
            drainerIdentity: ident(BARE),
        }) as PendingMeshCoordinatorEvent[];

        expect(drained).toHaveLength(1);
        expect(drained[0].coordinatorMessage).toBe('cross-form');
        expect(getMeshV2DrainCounters().v2Delivered).toBe(1);
        expect(getMeshV2DrainCounters().v2RoutedAway).toBe(0);
    });

    // ── (d) eventId idempotency — a re-delivered event is skipped ─────────────────
    it('skips a v2 event whose eventId was already drained (idempotency)', () => {
        const meshId = `mesh-dedup-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);

        const evt = makeTerminal(meshId, { coordinatorMessage: 'once' });
        queuePendingMeshCoordinatorEvent(evt);

        // First drain consumes it.
        const first = drainPendingMeshCoordinatorEvents(meshId, BARE, { drainerIdentity: ident(BARE) });
        expect(first).toHaveLength(1);
        const eventId = (first[0] as PendingMeshCoordinatorEvent).eventId;
        expect(eventId).toBeTruthy();

        // Re-queue the SAME event (same eventId — stampPendingEventV2 preserves it).
        // A distinct fingerprint would otherwise let it through; the eventId dedup must
        // still skip it because that eventId was already drained.
        __resetMeshV2DrainCountersForTests();
        const requeue = { ...first[0], queuedAt: Date.now() + 1 } as PendingMeshCoordinatorEvent;
        // The fingerprint dedup on queue would suppress an identical event; mutate the
        // metadata timestamp so the fingerprint differs and only eventId dedup can catch it.
        requeue.metadataEvent = { ...requeue.metadataEvent, timestamp: Date.now() + 999 };
        queuePendingMeshCoordinatorEvent(requeue);

        const second = drainPendingMeshCoordinatorEvents(meshId, BARE, { drainerIdentity: ident(BARE) });
        expect(second).toHaveLength(0);
        expect(getMeshV2DrainCounters().v2DedupSkipped).toBe(1);
    });

    // ── (e) accept-and-warn — malformed v2 envelope passes through (no drop) ──────
    it('passes a malformed v2 envelope THROUGH (accept mode) and counts the violation', () => {
        const meshId = `mesh-warn-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);

        // Forge a v2-versioned but invalid envelope: protocolVersion set, but scope
        // 'unicast' WITHOUT intendedFor (violates assertPendingMeshCoordinatorEventV2).
        const broken = makeTerminal(meshId, { coordinatorMessage: 'broken' });
        (broken as any).protocolVersion = '2.0';
        (broken as any).eventId = randomUUID();
        (broken as any).scope = 'unicast';
        (broken as any).dispatchedBy = ident(BARE);
        // no intendedFor → invalid unicast
        // Bypass the emit stamp path (which would auto-fix) by inserting via the queue —
        // queue re-stamps only when NOT already v2, so a v2-versioned event is stored as-is.
        queuePendingMeshCoordinatorEvent(broken);

        const drained = drainPendingMeshCoordinatorEvents(meshId, BARE, { drainerIdentity: ident(BARE) });
        // Accept mode: NOT dropped.
        expect(drained).toHaveLength(1);
        expect((drained[0] as PendingMeshCoordinatorEvent).coordinatorMessage).toBe('broken');
        expect(getMeshV2DrainCounters().v2ValidationFailedAccepted).toBe(1);
    });

    // ── (f) re-attribution — orphaned-by-restart unicast lands on current coordinator ─
    it('re-attributes a unicast event to the current coordinator when the originating runId is gone', () => {
        const meshId = `mesh-reattr-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);

        // Event addressed to a coordinatorRunId that no longer exists (a prior process),
        // but the SAME machine. Unscoped so the daemon filter passes it.
        const stamped = stampPendingEventV2(makeTerminal(meshId, { coordinatorMessage: 'orphan' }), {
            dispatchedBy: { daemonId: BARE, coordinatorRunId: 'run_OLD' },
            intendedFor: { daemonId: BARE, coordinatorRunId: 'run_OLD' },
        });
        delete (stamped as any).targetCoordinatorDaemonId;
        queuePendingMeshCoordinatorEvent(stamped);

        // Current coordinator has a FRESH runId on the same machine.
        const drained = drainPendingMeshCoordinatorEvents(meshId, BARE, {
            drainerIdentity: { daemonId: BARE, coordinatorRunId: 'run_NEW' },
        }) as PendingMeshCoordinatorEvent[];

        expect(drained).toHaveLength(1);
        expect(drained[0].coordinatorMessage).toBe('orphan');
        expect(getMeshV2DrainCounters().v2ReattributedToDrainer).toBe(1);
        expect(getMeshV2DrainCounters().v2RoutedAway).toBe(0);
    });

    // ── re-attribution does NOT leak across machines ──────────────────────────────
    it('does NOT re-attribute a unicast event addressed to a DIFFERENT machine', () => {
        const meshId = `mesh-noleak-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);

        const stamped = stampPendingEventV2(makeTerminal(meshId, { coordinatorMessage: 'other-machine' }), {
            dispatchedBy: ident(OTHER_CORE),
            intendedFor: ident(OTHER_CORE),
        });
        delete (stamped as any).targetCoordinatorDaemonId;
        queuePendingMeshCoordinatorEvent(stamped);

        const drained = drainPendingMeshCoordinatorEvents(meshId, BARE, { drainerIdentity: ident(BARE) });
        expect(drained).toHaveLength(0);
        expect(getMeshV2DrainCounters().v2RoutedAway).toBe(1);
        expect(getMeshV2DrainCounters().v2ReattributedToDrainer).toBe(0);
    });

    // ── peek mirrors drain routing (mesh_status count parity) ─────────────────────
    it('peek surfaces the same v2-routed set as the drain would deliver', () => {
        const meshId = `mesh-peek-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);

        const sessA = `sess_${randomUUID().slice(0, 8)}`;
        queuePendingMeshCoordinatorEvent(makeTerminal(meshId, { targetCoordinatorSessionId: sessA, coordinatorMessage: 'for A' }));
        queuePendingMeshCoordinatorEvent(makeTerminal(meshId, { targetCoordinatorSessionId: `sess_${randomUUID().slice(0, 8)}`, coordinatorMessage: 'for B' }));

        const peekedForA = getPendingMeshCoordinatorEvents(meshId, BARE, {
            drainerIdentity: ident(BARE, { sessionId: sessA }),
        });
        expect(peekedForA).toHaveLength(1);
        expect(peekedForA[0].coordinatorMessage).toBe('for A');
        // Peek is non-destructive: it must NOT inflate the delivery counters.
        expect(getMeshV2DrainCounters().v2Delivered).toBe(0);
    });
});
