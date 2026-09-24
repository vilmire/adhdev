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
// After wiring-unification C (C-W3) a refine terminal is a coordinator NOTICE
// (`turn.notify` → the turn.deliver cursor). These tests pin the emit-side
// contract — the requester session rides on the notice as `targetSessionId` —
// and the routing contract that replaced identityDeliversTo:
//   - a sibling coordinator session never takes it before the ceiling;
//   - the requesting session takes it;
//   - a notice with no requester session goes to any coordinator of the mesh.

const testTmpDir = join(tmpdir(), `adhdev-refine-unicast-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'mach_1b46842a15d3409d96ad33e767a916dd' }),
    getMachineId: () => (({ machineId: 'mach_1b46842a15d3409d96ad33e767a916dd' }) as any).machineId,
    getMachineNickname: () => (({ machineId: 'mach_1b46842a15d3409d96ad33e767a916dd' }) as any).machineNickname ?? null,
}));

import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { queueRefineJobEvent } from '../../src/commands/router-refine.js';
import type { MeshRefineJobHandle } from '../../src/mesh/mesh-refine-gates.js';
import { routeNotice } from '../../src/mesh/turn-ledger/routing.js';
import { drainPendingMeshCoordinatorEvents, __clearMeshPendingEventsForTests } from '../helpers/pending-notices.js';

const CORE = 'mach_1b46842a15d3409d96ad33e767a916dd';
const CLOUD = `daemon_${CORE}`;

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

// No attached components (the router's boot-window answer) → queueRefineJobEvent
// takes its notice-queue fallback, the path these cases pin.
function makeRouterStub(): any {
    return { deps: {}, attachedComponentsOrNull: () => null };
}

const idle = (sessionId: string) => ({ sessionId, idle: true, modalParked: false });

describe('refine terminal notices — session-scoped unicast', () => {
    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
        try { MeshRuntimeStore.resetForTests(); } catch { /* best-effort */ }
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('stamps the requesting coordinator session onto refine accepted/completed/failed', () => {
        for (const eventName of ['refine:accepted', 'refine:completed', 'refine:failed'] as const) {
            const meshId = `mesh-refine-${randomUUID().slice(0, 8)}`;
            __clearMeshPendingEventsForTests();
            const requester = `sess_${randomUUID().slice(0, 8)}`;
            queueRefineJobEvent(makeRouterStub(), eventName, makeHandle(meshId, { targetCoordinatorSessionId: requester } as any), { success: eventName !== 'refine:failed' });
            const drained = drainPendingMeshCoordinatorEvents(meshId, CLOUD);
            expect(drained).toHaveLength(1);
            expect(drained[0]!.event).toBe(eventName);
            expect(drained[0]!.targetCoordinatorSessionId).toBe(requester);
        }
    });

    it('does not let a sibling coordinator session take the requesting session\'s refine result', () => {
        const requester = 'sess_requester';
        // The sibling is idle, the requester is registered but busy: wait for the requester.
        expect(routeNotice({ targetSessionId: requester, coordinators: [idle('sess_sibling'), { sessionId: requester, idle: false, modalParked: false }], pastCeiling: false }))
            .toEqual({ kind: 'wait', sessionId: requester, waitFor: 'input_ready' });
        // The requester is not registered (restarting) and a sibling exists: wait for it to register.
        expect(routeNotice({ targetSessionId: requester, coordinators: [idle('sess_sibling')], pastCeiling: false }))
            .toEqual({ kind: 'wait', sessionId: requester, waitFor: 'registered' });
    });

    it('delivers the refine result to the requesting coordinator session', () => {
        expect(routeNotice({ targetSessionId: 'sess_requester', coordinators: [idle('sess_sibling'), idle('sess_requester')], pastCeiling: false }))
            .toEqual({ kind: 'deliver', sessionId: 'sess_requester', escalated: false });
    });

    it('keeps a session-less refine notice deliverable to any coordinator on the daemon', () => {
        const meshId = `mesh-refine-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests();
        queueRefineJobEvent(makeRouterStub(), 'refine:completed', makeHandle(meshId), { success: true });
        const drained = drainPendingMeshCoordinatorEvents(meshId, CLOUD);
        expect(drained).toHaveLength(1);
        expect(drained[0]!.targetCoordinatorSessionId).toBeUndefined();
        expect(routeNotice({ targetSessionId: null, coordinators: [idle('any')], pastCeiling: false }))
            .toEqual({ kind: 'deliver', sessionId: 'any', escalated: false });
    });
});
