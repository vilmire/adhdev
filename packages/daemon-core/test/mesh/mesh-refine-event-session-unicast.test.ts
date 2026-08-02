import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// REFINE-EVENT-SESSION-SCOPED-UNICAST
//
// A refine terminal event (refine:accepted / refine:completed / refine:failed) is
// emitted by the EXECUTING daemon and recovered by the REQUESTING coordinator's drain.
// It used to carry only a coordinator DAEMON id — no session — so `intendedFor` was
// session-less. identityDeliversTo compares sessions only when BOTH sides name one, so a
// session-less intendedFor matched ANY drainer on that machine: unicast degraded to
// daemon-scoped first-come-first-served, and a sibling coordinator session polling first
// consumed another coordinator's refine result.
//
// These tests pin the emit-side contract (the session must ride on the event) and the
// two regressions that must NOT be introduced while fixing it:
//   - a session-less DRAINER (the reconcile loop's daemon-level drain) must still receive
//     session-stamped unicast events — identityDeliversTo's session-less-drainer branch is
//     intentional and load-bearing.
//   - a refine event with no requester session at all must stay deliverable (never stuck).

const testTmpDir = join(tmpdir(), `adhdev-refine-unicast-${randomUUID().slice(0, 8)}`);
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
    getMeshV2DrainCounters,
    __resetMeshV2DrainCountersForTests,
    __resetMeshV2WarnDedupForTests,
    __clearMeshPendingEventsForTests,
    type PendingMeshCoordinatorEvent,
} from '../../src/mesh/mesh-events-pending.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import type { CoordinatorIdentity } from '../../src/mesh/contracts.js';
import { queueRefineJobEvent } from '../../src/commands/router-refine.js';
import type { MeshRefineJobHandle } from '../../src/mesh/mesh-refine-gates.js';

const CORE = 'mach_1b46842a15d3409d96ad33e767a916dd';
const CLOUD = `daemon_${CORE}`;

function ident(daemonId: string, over: Partial<CoordinatorIdentity> = {}): CoordinatorIdentity {
    return { daemonId, coordinatorRunId: daemonId, ...over };
}

/** A refine job handle as startMeshRefineJob builds it, addressed to one coordinator. */
function makeHandle(meshId: string, over: Partial<MeshRefineJobHandle> = {}): MeshRefineJobHandle {
    return {
        success: true,
        async: true,
        status: 'completed',
        jobId: `refine_${randomUUID().slice(0, 8)}`,
        interactionId: randomUUID(),
        meshId,
        nodeId: 'node_bf91',
        targetNodeId: 'node_bf91',
        targetDaemonId: CLOUD,
        workspace: '/tmp/worktree',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        targetCoordinatorDaemonId: CLOUD,
        eventDelivery: { pendingEvents: true, ledger: true },
        evidence: {
            pendingEventsCommand: 'get_pending_mesh_events',
            ledgerCommand: 'get_mesh_ledger_slice',
            taskHistoryKind: 'task_completed',
        },
        ...over,
    } as MeshRefineJobHandle;
}

/** A router stub with no instanceManager, so queueRefineJobEvent takes the queue path
 *  (the local/sessionless emit the coordinator drains) rather than the forward path. */
function makeRouterStub(): any {
    return { deps: {} };
}

describe('refine terminal events — session-scoped unicast', () => {
    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        __resetMeshV2DrainCountersForTests();
        __resetMeshV2WarnDedupForTests();
    });

    afterEach(() => {
        try { MeshRuntimeStore.resetForTests(); } catch { /* best-effort */ }
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    // ── (1) THE DEFECT: a session-less refine unicast is consumed by a sibling ─────
    it('does not let a sibling coordinator session consume the requesting session\'s refine result', () => {
        const meshId = `mesh-refine-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);

        const requester = `sess_${randomUUID().slice(0, 8)}`;
        const sibling = `sess_${randomUUID().slice(0, 8)}`;

        // Coordinator `requester` asked for the refine; the job handle carries its session.
        queueRefineJobEvent(
            makeRouterStub(),
            'refine:completed',
            makeHandle(meshId, { targetCoordinatorSessionId: requester } as any),
            { success: true },
        );

        // The SIBLING coordinator session on the SAME daemon polls first.
        const drainedBySibling = drainPendingMeshCoordinatorEvents(meshId, CLOUD, {
            drainerIdentity: ident(CLOUD, { sessionId: sibling }),
        }) as PendingMeshCoordinatorEvent[];

        // It must get nothing — the event belongs to `requester`. This is the defect:
        // before the fix the sibling received (and surfaced) refine:completed.
        expect(drainedBySibling.map(e => e.event)).toEqual([]);
        expect(getMeshV2DrainCounters().v2RoutedAway).toBe(1);
        // Routing away is a NON-consuming outcome for the sibling: the event stays
        // addressed to the requester (the drain-side requeue is the caller's job — see
        // the reconcile loop's strict-route hold), never re-addressed to the sibling.
        expect(getMeshV2DrainCounters().v2Delivered).toBe(0);
    });

    // ── (1b) the requesting coordinator DOES receive its own refine result ────────
    it('delivers the refine result to the requesting coordinator session', () => {
        const meshId = `mesh-refine-ok-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);

        const requester = `sess_${randomUUID().slice(0, 8)}`;
        queueRefineJobEvent(
            makeRouterStub(),
            'refine:completed',
            makeHandle(meshId, { targetCoordinatorSessionId: requester } as any),
            { success: true },
        );

        const drainedByRequester = drainPendingMeshCoordinatorEvents(meshId, CLOUD, {
            drainerIdentity: ident(CLOUD, { sessionId: requester }),
        }) as PendingMeshCoordinatorEvent[];
        expect(drainedByRequester).toHaveLength(1);
        expect(drainedByRequester[0].event).toBe('refine:completed');
        expect(drainedByRequester[0].intendedFor?.sessionId).toBe(requester);
    });

    // ── (2) the emit-side contract: the session rides on the queued event ─────────
    it('stamps the requesting coordinator session onto refine accepted/completed/failed', () => {
        for (const eventName of ['refine:accepted', 'refine:completed', 'refine:failed'] as const) {
            const meshId = `mesh-stamp-${randomUUID().slice(0, 8)}`;
            __clearMeshPendingEventsForTests(meshId);
            const requester = `sess_${randomUUID().slice(0, 8)}`;

            queueRefineJobEvent(
                makeRouterStub(),
                eventName,
                makeHandle(meshId, { targetCoordinatorSessionId: requester } as any),
            );

            const drained = drainPendingMeshCoordinatorEvents(meshId, CLOUD, {
                drainerIdentity: ident(CLOUD, { sessionId: requester }),
            }) as PendingMeshCoordinatorEvent[];

            expect(drained).toHaveLength(1);
            expect(drained[0].event).toBe(eventName);
            // The session must ride BOTH on the v1 anchor field (PHASE-2 inject key) and
            // inside the v2 unicast envelope (the drain-side routing key).
            expect(drained[0].targetCoordinatorSessionId).toBe(requester);
            expect(drained[0].intendedFor?.sessionId).toBe(requester);
        }
    });

    // ── (3) REGRESSION GUARD: session-less drainer (reconcile loop) still drains ──
    it('still delivers a session-stamped refine event to a session-less daemon-level drainer', () => {
        const meshId = `mesh-daemonlevel-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        const requester = `sess_${randomUUID().slice(0, 8)}`;

        queueRefineJobEvent(
            makeRouterStub(),
            'refine:completed',
            makeHandle(meshId, { targetCoordinatorSessionId: requester } as any),
            { success: true },
        );

        // The reconcile loop drains at DAEMON level — no sessionId in its identity.
        // identityDeliversTo's session-less-drainer branch must still deliver.
        const drained = drainPendingMeshCoordinatorEvents(meshId, CLOUD) as PendingMeshCoordinatorEvent[];
        expect(drained).toHaveLength(1);
        expect(drained[0].event).toBe('refine:completed');
    });

    // ── (4) NEVER STUCK: no requester session → still deliverable to any drainer ──
    it('keeps a session-less refine event deliverable to any coordinator on the daemon', () => {
        const meshId = `mesh-nosess-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);

        // Legacy / version-skewed requester: daemon anchor only, no session.
        queueRefineJobEvent(
            makeRouterStub(),
            'refine:completed',
            makeHandle(meshId),
            { success: true },
        );

        const drained = drainPendingMeshCoordinatorEvents(meshId, CLOUD, {
            drainerIdentity: ident(CLOUD, { sessionId: `sess_${randomUUID().slice(0, 8)}` }),
        }) as PendingMeshCoordinatorEvent[];
        expect(drained).toHaveLength(1);
        expect(drained[0].event).toBe('refine:completed');
    });
});
