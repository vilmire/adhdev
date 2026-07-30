import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';

// RC32 (Part B): remote Refinery terminal-event return path.
//
// RCA: remote refine EXECUTION is healthy, but the MCP relay (meshRefineNode /
// meshRefineBatch) reaches the executing daemon without a coordinatorDaemonId, so
// the job handle carries no targetCoordinatorDaemonId; queueRefineJobEvent /
// queueRefineBatchJobEvent then omitted the target from the handleMeshForwardEvent
// payload, and the sessionless injection path (no live worker session) had no
// relayed anchor to read — the queued accepted/completed/failed event minted under
// the EXECUTING (worker) daemon's self-fallback id, so the real coordinator's drain
// excluded it and it eventually trimmed to held.
//
// These tests pin the three-layer fix:
//   (2) the router emission passes handle.targetCoordinatorDaemonId through both
//       single and batch handleMeshForwardEvent payloads;
//   (3) the forwarding/injection resolution honors the relayed
//       targetCoordinatorDaemonId when no live worker session exists;
//   (4) a correctly-targeted event stays coordinator-recoverable at the queue layer
//       (the exact drain filter the remote pull uses), while the legacy
//       self-fallback (mis-targeted) shape stays excluded — the held/trim bug shape.

const testTmpDir = join(tmpdir(), `adhdev-refine-return-path-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

// The EXECUTING (worker) daemon's own machine id — the wrong inbox.
const WORKER_MACH = 'mach_1111aaaa1111aaaa1111aaaa1111aaaa';
// The originating COORDINATOR's machine id; events are stamped with its full form.
const COORD_MACH = 'mach_2222bbbb2222bbbb2222bbbb2222bbbb';
const COORD_FULL = `daemon_${COORD_MACH}`;

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: WORKER_MACH }),
}));

vi.mock('../../src/config/mesh-config.js', () => ({
    getMesh: vi.fn(() => undefined),
    getMeshByRepo: vi.fn(() => undefined),
    listMeshes: vi.fn(() => [] as any[]),
}));

import { queueRefineJobEvent, queueRefineBatchJobEvent } from '../../src/commands/router-refine.js';
import { handleMeshForwardEvent, buildRelayMetadataEvent } from '../../src/mesh/mesh-event-forwarding.js';
import { buildForwardPayloadFromPending } from '../../src/mesh/mesh-remote-event-pull.js';
import {
    getPendingMeshCoordinatorEvents,
    drainPendingMeshCoordinatorEvents,
    __clearMeshPendingEventsForTests,
} from '../../src/mesh/mesh-events-pending.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

// Minimal router facade: queueRefine*JobEvent only reads deps.instanceManager.
function makeSelf() {
    return {
        deps: {
            instanceManager: {
                getByCategory: vi.fn(() => []),
                getInstance: vi.fn(() => undefined),
            },
        },
    } as any;
}

function makeSingleHandle(meshId: string, jobId: string, targetCoordinatorDaemonId?: string): any {
    return {
        jobId,
        interactionId: `int_${jobId}`,
        meshId,
        targetNodeId: 'node_wt_remote',
        targetDaemonId: `daemon_${WORKER_MACH}`,
        workspace: '/remote/worktree-a',
        status: 'completed',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        ...(targetCoordinatorDaemonId ? { targetCoordinatorDaemonId } : {}),
    };
}

function makeBatchHandle(meshId: string, jobId: string, targetCoordinatorDaemonId?: string): any {
    return {
        jobId,
        interactionId: `int_${jobId}`,
        meshId,
        batchLabel: 'batch:2 nodes',
        nodeIds: ['node_wt_a', 'node_wt_b'],
        status: 'completed',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        ...(targetCoordinatorDaemonId ? { targetCoordinatorDaemonId } : {}),
    };
}

function pendingRefineEvents(meshId: string, daemonId: string) {
    return getPendingMeshCoordinatorEvents(meshId, daemonId)
        .filter(e => typeof e.event === 'string' && e.event.startsWith('refine:'));
}

describe('RC32 Part B — refine terminal-event return path', () => {
    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
        try { MeshRuntimeStore.resetForTests(); } catch { /* best-effort */ }
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('single: queued refine:completed stays targeted at the originating coordinator', () => {
        const meshId = `mesh-rc32-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);

        queueRefineJobEvent(makeSelf(), 'refine:completed', makeSingleHandle(meshId, `job_${randomUUID().slice(0, 8)}`, COORD_FULL), { success: true });

        // The queued event carries the coordinator return address (not the worker's
        // self-fallback id) and a v2 unicast envelope addressing that coordinator.
        const visible = pendingRefineEvents(meshId, COORD_MACH);
        expect(visible.map(e => e.event)).toContain('refine:completed');
        const event = visible.find(e => e.event === 'refine:completed')!;
        expect(event.targetCoordinatorDaemonId).toBe(COORD_FULL);
        expect(event.protocolVersion).toBe('2.0');
        expect(daemonIdsEquivalent(event.intendedFor?.daemonId, COORD_MACH)).toBe(true);

        // The executing (worker) daemon's own drain must NOT see it — that exclusion
        // is the whole point of the unicast return path.
        expect(pendingRefineEvents(meshId, WORKER_MACH)).toHaveLength(0);
    });

    it('batch: queued refine:completed stays targeted at the originating coordinator', () => {
        const meshId = `mesh-rc32-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);

        queueRefineBatchJobEvent(makeSelf(), 'refine:completed', makeBatchHandle(meshId, `job_${randomUUID().slice(0, 8)}`, COORD_FULL), { success: true, batch: true });

        const visible = pendingRefineEvents(meshId, COORD_MACH);
        expect(visible.map(e => e.event)).toContain('refine:completed');
        const event = visible.find(e => e.event === 'refine:completed')!;
        expect(event.targetCoordinatorDaemonId).toBe(COORD_FULL);
        expect(daemonIdsEquivalent(event.intendedFor?.daemonId, COORD_MACH)).toBe(true);
        expect(pendingRefineEvents(meshId, WORKER_MACH)).toHaveLength(0);
    });

    it('sessionless remote route: handleMeshForwardEvent honors the relayed targetCoordinatorDaemonId', () => {
        const meshId = `mesh-rc32-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);

        // No sourceInstanceId → no live worker session on this daemon; the ONLY
        // coordinator anchor is the relayed top-level targetCoordinatorDaemonId.
        const result = handleMeshForwardEvent({ instanceManager: makeSelf().deps.instanceManager } as any, {
            event: 'refine:failed',
            meshId,
            nodeId: 'node_wt_remote',
            jobId: `job_${randomUUID().slice(0, 8)}`,
            status: 'failed',
            targetCoordinatorDaemonId: COORD_FULL,
            result: { success: false, error: 'merge conflict' },
        });
        expect(result.success).toBe(true);

        const visible = pendingRefineEvents(meshId, COORD_MACH);
        expect(visible.map(e => e.event)).toContain('refine:failed');
        const event = visible.find(e => e.event === 'refine:failed')!;
        expect(event.targetCoordinatorDaemonId).toBe(COORD_FULL);
        expect(daemonIdsEquivalent(event.intendedFor?.daemonId, COORD_MACH)).toBe(true);
        expect(pendingRefineEvents(meshId, WORKER_MACH)).toHaveLength(0);
    });

    it('relay whitelist mirrors the daemon anchor (buildRelayMetadataEvent / buildForwardPayloadFromPending)', () => {
        // The flat relay payload → rebuilt metadataEvent mirror the receive side reads.
        const metadata = buildRelayMetadataEvent({ targetCoordinatorDaemonId: COORD_FULL });
        expect(metadata.targetCoordinatorDaemonId).toBe(COORD_FULL);

        // The remote-pull flatten passes the pending event's top-level anchor through
        // (it lives outside metadataEvent, so the metadata spread alone loses it).
        const wire = buildForwardPayloadFromPending({
            event: 'refine:completed',
            meshId: 'mesh_rc32',
            targetCoordinatorDaemonId: COORD_FULL,
            metadataEvent: { jobId: 'job_x' },
        });
        expect(wire.targetCoordinatorDaemonId).toBe(COORD_FULL);
    });

    it('trim/held path: the correctly-targeted event is drained by its coordinator; the legacy self-fallback shape is not', () => {
        const meshId = `mesh-rc32-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);

        // Fixed shape: handle carries the coordinator return address.
        queueRefineJobEvent(makeSelf(), 'refine:completed', makeSingleHandle(meshId, `job_fixed_${randomUUID().slice(0, 6)}`, COORD_FULL), { success: true });
        // Legacy bug shape: no return address → stampPendingEventV2 self-fallback
        // stamps the EXECUTING daemon's own id (the pre-RC32 mis-target).
        queueRefineJobEvent(makeSelf(), 'refine:failed', makeSingleHandle(meshId, `job_legacy_${randomUUID().slice(0, 6)}`), { success: false });

        // Coordinator drain recovers ONLY the correctly-targeted event — proving it
        // never strands into the held/trim path the mis-targeted one falls into.
        const drained = drainPendingMeshCoordinatorEvents(meshId, COORD_MACH);
        expect(drained.map(e => e.event)).toContain('refine:completed');
        expect(drained.map(e => e.event)).not.toContain('refine:failed');

        // The mis-targeted legacy event is exactly what the worker's own drain sees
        // (and what used to trim to held on the wrong daemon).
        const legacy = pendingRefineEvents(meshId, WORKER_MACH);
        expect(legacy.map(e => e.event)).toContain('refine:failed');
        expect(daemonIdsEquivalent(legacy[0]?.targetCoordinatorDaemonId, WORKER_MACH)).toBe(true);
    });
});
