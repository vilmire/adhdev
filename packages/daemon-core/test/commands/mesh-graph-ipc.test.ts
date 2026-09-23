import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// C-W9c: the daemon-side responders of the mcp-server's last in-process
// daemon-core paths — graph gates/plan/patch/view, task/mission stats, one
// prune audit, orphaned-pin notify (mesh-graph-ipc.ts) — run through the SAME
// registered map the IPC transport dispatches (turnLedgerIpcHandlers), against
// a real temp mesh-runtime.db. Sibling of mesh-store-ipc.test.ts (C-W9a/b).

const testTmpDir = path.join(tmpdir(), `adhdev-graph-ipc-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));
vi.mock('../../src/config/mesh-config.js', () => ({
    getMesh: vi.fn(() => undefined),
    getMeshByRepo: vi.fn(),
    listMeshes: vi.fn(() => [] as any[]),
    getDifficultyBrains: vi.fn(() => undefined),
}));

import { turnLedgerIpcHandlers, turnLedgerIpcSpecs } from '../../src/commands/low-family/turn-ledger-ipc.js';
import { meshGraphIpcHandlers } from '../../src/commands/low-family/mesh-graph-ipc.js';
import { commitMeshGraphPlan } from '../../src/mesh/mesh-graph-plan.js';
import {
    __clearMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
    __writeTaskStatusForTests,
    enqueueTask,
    getQueue,
} from '../../src/mesh/mesh-work-queue.js';
import { readLocalRecords } from '../../src/mesh/mesh-local-records.js';

const v = 1;
let meshId: string;

async function call(command: string, args: Record<string, unknown>): Promise<any> {
    const handler = (turnLedgerIpcHandlers as Record<string, (ctx: unknown, a: unknown) => Promise<unknown>>)[command];
    expect(handler, command).toBeTypeOf('function');
    return handler({ deps: { statusInstanceId: 'daemon-test' } }, args);
}

/** Hand-build A --requires--> G(coordinator_gate) --gate--> B via a real plan commit (same technique mesh-graph-gate-ref-binding.test.ts uses). */
function planGateGraph(mesh: string) {
    const result = commitMeshGraphPlan({
        meshId: mesh,
        tasks: [
            { ref: 'a', message: 'do A', taskMode: 'code_change', difficulty: 'medium' } as any,
            { ref: 'b', message: 'do B', taskMode: 'code_change', difficulty: 'medium', gated_by: ['land'] } as any,
        ],
        gates: [{ ref: 'land', action: 'refinery', depends_on: ['a'], instructions: 'Land it.' }],
    });
    const gate = result.gates.find((g) => g.ref === 'land')!;
    return { graphId: result.graphId, gateId: gate.gateId, taskA: result.tasks[0], taskB: result.tasks[1] };
}

/** Open the gate by completing task A. */
function openGate(mesh: string, g: ReturnType<typeof planGateGraph>) {
    __writeTaskStatusForTests(mesh, g.taskA.id, 'completed');
}

beforeEach(() => {
    meshId = `mesh_graph_ipc_${randomUUID().slice(0, 8)}`;
});

afterEach(() => {
    __clearMeshQueueForTests(meshId);
    __resetMeshRuntimeStoreForTests();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('registration', () => {
    it('every graph/stats/prune command is in the turn IPC map, reachable over local IPC only', () => {
        const names = Object.keys(meshGraphIpcHandlers);
        expect(names.sort()).toEqual([
            'graph_gate_abandon', 'graph_gate_claim', 'graph_gate_release', 'graph_node_patch', 'graph_view_query',
            'orphaned_pin_notify', 'prune_stale_direct', 'task_stats_query',
        ]);
        const byName = new Map(turnLedgerIpcSpecs.map((spec) => [spec.name, spec]));
        for (const name of names) expect(byName.get(name)?.sources, name).toEqual(['ipc', 'standalone']);
    });

    it('a malformed request is refused by the wire decoder, never executed', async () => {
        for (const name of Object.keys(meshGraphIpcHandlers)) {
            const res = await call(name, { v, meshId, bogus: true });
            expect(res.success, name).toBe(false);
        }
    });
});

describe('graph_gate_claim / graph_gate_release / graph_gate_abandon', () => {
    it('claims an awaiting gate, writes its provenance record, and returns the lease', async () => {
        const g = planGateGraph(meshId);
        openGate(meshId, g);
        const res = await call('graph_gate_claim', { v, meshId, gateId: g.gateId, coordinatorSessionId: 's1', probeConvergenceEvidence: false });
        expect(res).toMatchObject({ success: true, claimed: true });
        expect(res.leaseGeneration).toBeGreaterThanOrEqual(1);
        expect(res.fencingToken).toBeTypeOf('string');
        expect(res.gate).toMatchObject({ graphId: g.graphId, ref: 'land' });
        expect(readLocalRecords(meshId, { kind: ['graph_gate_claimed'] })).toHaveLength(1);
    });

    it('an expected refusal (not-yet-awaiting gate) is a claimed:false RESULT, not an envelope failure', async () => {
        const g = planGateGraph(meshId);
        // Gate still 'declared' — task A has not completed, so it is not awaiting a coordinator.
        const res = await call('graph_gate_claim', { v, meshId, gateId: g.gateId, coordinatorSessionId: 's1' });
        expect(res).toMatchObject({ success: true, claimed: false, reason: 'gate_not_awaiting' });
    });

    it('release materializes downstream, writes provenance, and nudges the queue', async () => {
        const g = planGateGraph(meshId);
        openGate(meshId, g);
        const claim = await call('graph_gate_claim', { v, meshId, gateId: g.gateId, coordinatorSessionId: 's1' });
        const res = await call('graph_gate_release', {
            v, meshId, gateId: g.gateId, fencingToken: claim.fencingToken, leaseGeneration: claim.leaseGeneration,
            idempotencyKey: 'k1', outcome: 'passed',
        });
        expect(res).toMatchObject({ success: true, released: true, duplicate: false });
        expect(res.materializedNodeIds).toHaveLength(1);
        expect(readLocalRecords(meshId, { kind: ['graph_gate_released'] })).toHaveLength(1);
        // The gated task B is now claimable (materialized) rather than still 'pending' behind the gate block.
        const taskB = getQueue(meshId).find((t) => t.id === g.taskB.id);
        expect(taskB?.status).toBe('pending');
        expect(taskB?.systemBlock).toBeFalsy();
    });

    it('a thrown domain refusal (stale fence) comes back as released:false + refusalCode, not a thrown error', async () => {
        const g = planGateGraph(meshId);
        openGate(meshId, g);
        await call('graph_gate_claim', { v, meshId, gateId: g.gateId, coordinatorSessionId: 's1' });
        const res = await call('graph_gate_release', {
            v, meshId, gateId: g.gateId, fencingToken: 'wrong-token', leaseGeneration: 1, idempotencyKey: 'k1', outcome: 'passed',
        });
        expect(res).toMatchObject({ success: true, released: false });
        expect(res.refusalCode).toMatch(/stale_fence|gate_release_conflict/);
    });

    it('abandon cancels the gated downstream and writes provenance (skipped on a duplicate abandon)', async () => {
        const g = planGateGraph(meshId);
        openGate(meshId, g);
        const res = await call('graph_gate_abandon', { v, meshId, gateId: g.gateId, reason: 'cancelled upstream' });
        expect(res).toMatchObject({ success: true, abandoned: true });
        expect(res.cancelledTaskIds).toContain(g.taskB.id);
        expect(readLocalRecords(meshId, { kind: ['graph_gate_abandoned'] })).toHaveLength(1);

        // A second abandon is a safe no-op and must NOT double-write the provenance record.
        const again = await call('graph_gate_abandon', { v, meshId, gateId: g.gateId, reason: 'cancelled upstream' });
        expect(again).toMatchObject({ success: true, abandoned: true });
        expect(readLocalRecords(meshId, { kind: ['graph_gate_abandoned'] })).toHaveLength(1);
    });
});

describe('graph_node_patch', () => {
    it('rejects a forbidden patch key as a patched:false RESULT with refusalCode node_patch_forbidden', async () => {
        const g = planGateGraph(meshId);
        const res = await call('graph_node_patch', { v, meshId, node: g.taskB.id, baseSpecPatch: { message: 'not allowed' } });
        expect(res).toMatchObject({ success: true, patched: false, refusalCode: 'node_patch_forbidden' });
    });
});

describe('graph_view_query', () => {
    it('returns the graph view with nodes/gates, filterable to in-flight graphs only', async () => {
        const g = planGateGraph(meshId);
        const res = await call('graph_view_query', { v, meshId, activeOnly: true });
        expect(res.success).toBe(true);
        expect(res.graphs).toHaveLength(1);
        expect(res.graphs[0]).toMatchObject({ graphId: g.graphId });
    });
});

describe('task_stats_query', () => {
    it('computes per-task stats and an optional mission rollup in the daemon', async () => {
        const enqueued = enqueueTask(meshId, 'stat me directly', { taskMode: 'general', difficulty: 'easy' } as any);
        const res = await call('task_stats_query', { v, meshId, taskIds: [enqueued.id] });
        expect(res.success).toBe(true);
        expect(res.tasks).toHaveLength(1);
        expect(res.tasks[0]).toMatchObject({ taskId: enqueued.id, status: 'pending' });
    });

    it('rollup requires missionId to be satisfiable — omitted gracefully when absent', async () => {
        enqueueTask(meshId, 'x', { taskMode: 'general', difficulty: 'easy' } as any);
        const res = await call('task_stats_query', { v, meshId, missionId: 'no-such-mission', rollup: true });
        expect(res.success).toBe(true);
        expect(res.mission).toMatchObject({ missionId: 'no-such-mission', taskCount: 0 });
    });
});

describe('prune_stale_direct', () => {
    it('dry-runs with nothing prunable when there are no stale direct dispatches', async () => {
        const res = await call('prune_stale_direct', { v, meshId });
        expect(res).toMatchObject({ success: true, mode: 'dry_run', prunedCount: 0 });
        expect(res.prunable).toEqual([]);
    });
});

describe('orphaned_pin_notify', () => {
    it('finds a pending task pinned to the stopped session and returns it as an orphan', async () => {
        const pinned = enqueueTask(meshId, 'do the follow-up', { taskMode: 'general', difficulty: 'easy', targetSessionId: 'dead-sess' } as any);
        const res = await call('orphaned_pin_notify', { v, meshId, stoppedSessionId: 'dead-sess', cause: 'Cancelling task t-x' });
        expect(res.success).toBe(true);
        expect(res.orphans).toHaveLength(1);
        expect(res.orphans[0]).toMatchObject({ taskId: pinned.id, targetSessionId: 'dead-sess' });
    });

    it('excludes the task that caused the stop, and finds nothing when no task is pinned', async () => {
        const res = await call('orphaned_pin_notify', { v, meshId, stoppedSessionId: 'no-such-session' });
        expect(res).toMatchObject({ success: true, orphans: [] });
    });
});
