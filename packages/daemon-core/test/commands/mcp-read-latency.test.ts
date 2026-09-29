import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// MCP read-latency pass (2026-09-27): the daemon side of the coordinator's read
// tools must answer from ONE pass over its own store and never ship data the
// reader does not use. Each block pins one of those contracts; each fails with
// the pre-change daemon code:
//   1. get_mesh membershipOnly — no local git hydration, no lastGit blobs, fresh local facts
//   2. mission summaries — one slim queue read for any number of missions (no full getQueue parse)
//   3. mesh_status sections:['nodes'] + the aggregate cache sharing (not cloning) the queue
//   4. active_work_query without a queue argument — no whole-queue payload parse;
//      queue_query counts + dependency heads
//   5. task_stats_query missionIds — one pass for every mission
//   6. recovery_context_query nodeIds — one call, one record read
//   7. the scheduling runtime carries the daemon's lastQuotaRanking

const testTmpDir = path.join(tmpdir(), `adhdev-read-latency-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
    getMachineId: () => 'test-machine',
    getMachineNickname: () => 'nick',
}));
vi.mock('../../src/config/mesh-config.js', () => ({
    getMesh: vi.fn(() => undefined),
    getMeshByRepo: vi.fn(),
    listMeshes: vi.fn(() => [] as any[]),
}));
vi.mock('../../src/config/mesh-config-routing.js', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  getDifficultyBrains: vi.fn(() => undefined),
}))

import { turnLedgerIpcHandlers } from '../../src/commands/low-family/turn-ledger-ipc.js';
import { meshCrudHandlers } from '../../src/commands/med-family/mesh-crud.js';
import { getCachedAggregateMeshStatus } from '../../src/commands/router-aggregate-status.js';
import { projectMeshStatusNodesSection } from '../../src/commands/high-family/mesh-status.js';
import { __resetMeshRuntimeStoreForTests, __writeTaskStatusForTests, enqueueTask, getMeshQueueRevision } from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { getMeshStatusMissionSummaries, getMeshStatusMissionsCompact, summarizeMissionTasks, upsertMeshMission } from '../../src/mesh/mesh-missions.js';
import { computeMeshMissionStats } from '../../src/mesh/mesh-task-stats.js';
import { getSessionRecoveryContext } from '../../src/mesh/mesh-local-records.js';
import { recordLastQuotaRanking } from '../../src/mesh/mesh-quota-ranking-records.js';
import { seedLocalRecord } from '../helpers/local-records.js';

const v = 1;
let meshId: string;

async function call(command: string, args: Record<string, unknown>, ctx: Record<string, unknown> = {}): Promise<any> {
    const handler = (turnLedgerIpcHandlers as Record<string, (ctx: unknown, a: unknown) => Promise<unknown>>)[command];
    return handler({ deps: { statusInstanceId: 'daemon-test' }, ...ctx }, args);
}

function seedMissionsWithTasks(missionCount: number, tasksPerMission: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < missionCount; i += 1) {
        const m = upsertMeshMission(meshId, { title: `M${i}`, goal: 'g'.repeat(200), status: i % 2 ? 'paused' : 'active', brief: { goal: 'brief goal', constraints: ['c'] } });
        ids.push(m.id);
        for (let t = 0; t < tasksPerMission; t += 1) {
            const task = enqueueTask(meshId, `task ${t} of ${i} ${'x'.repeat(500)}`, { missionId: m.id, difficulty: 'medium' } as any);
            if (t % 3 === 0) __writeTaskStatusForTests(meshId, task.id, 'completed');
        }
    }
    return ids;
}

beforeEach(() => {
    meshId = `mesh_read_latency_${randomUUID().slice(0, 8)}`;
});

afterEach(() => {
    vi.restoreAllMocks();
    __resetMeshRuntimeStoreForTests();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('1. get_mesh membershipOnly', () => {
    it('skips the local git hydration, drops lastGit/last_git, and stamps fresh local facts', async () => {
        const workspace = fs.mkdtempSync(path.join(tmpdir(), 'adhdev-membership-ws-'));
        const heldGit = { source: 'member_push', checkedAt: 1, status: { isGitRepo: true, branch: 'main' } };
        const mesh = {
            id: meshId, name: 'M', nodes: [
                { id: 'node-local', workspace, daemonId: 'test-machine', lastGit: heldGit, last_git: heldGit, policy: {} },
                { id: 'node-remote', workspace: '/nowhere/remote', daemonId: 'daemon-remote', lastGit: heldGit, last_git: heldGit, nodeFacts: { reportedAt: 5 } },
            ],
        };
        const probeLocal = vi.fn(async () => ({ isGitRepo: true, branch: 'main' }));
        const ctx: any = {
            deps: { statusInstanceId: 'daemon-test' },
            getMeshForCommand: async () => ({ mesh, inline: true, source: 'inline_cache' }),
            meshGitProbeCache: { probeLocal },
        };
        const res: any = await meshCrudHandlers.get_mesh(ctx, { meshId, membershipOnly: true });
        expect(res.success).toBe(true);
        expect(probeLocal).not.toHaveBeenCalled();
        for (const node of res.mesh.nodes) {
            expect(node.lastGit).toBeUndefined();
            expect(node.last_git).toBeUndefined();
        }
        const local = res.mesh.nodes.find((n: any) => n.id === 'node-local');
        expect(local.nodeFacts).toBeTypeOf('object');
        expect(local.nodeFacts.machineNickname).toBe('nick');
        // A remote node keeps what the coordinator holds for it.
        expect(res.mesh.nodes.find((n: any) => n.id === 'node-remote').nodeFacts).toEqual({ reportedAt: 5 });
        // The record itself (possibly the shared inline cache) is not mutated.
        expect(mesh.nodes[0].lastGit).toBe(heldGit);
        // Without the flag the full hydration path still runs.
        await meshCrudHandlers.get_mesh(ctx, { meshId });
        expect(probeLocal).toHaveBeenCalled();
        fs.rmSync(workspace, { recursive: true, force: true });
    });
});

describe('2. mission summaries read the queue once', () => {
    it('mesh_status compact/verbose projections never parse whole queue payloads, whatever the mission count', async () => {
        const ids = seedMissionsWithTasks(6, 4);
        const fullParse = vi.spyOn(MeshRuntimeStore.prototype, 'getQueueEntries');
        const facts = vi.spyOn(MeshRuntimeStore.prototype, 'getQueueFacts');
        const compact = getMeshStatusMissionsCompact(meshId);
        expect(compact.live).toHaveLength(6);
        expect(fullParse).not.toHaveBeenCalled();
        expect(facts).toHaveBeenCalledTimes(1);
        facts.mockClear();
        getMeshStatusMissionSummaries(meshId, { verbose: true, withStats: true });
        expect(fullParse).not.toHaveBeenCalled();
        // one read for the aggregates + one for the batched stats — not 2 per mission
        expect(facts).toHaveBeenCalledTimes(2);
        // Batched aggregates equal the single-mission path.
        const byId = new Map((compact.live as any[]).map(m => [m.id, m.tasks]));
        for (const id of ids) expect(byId.get(id)).toEqual(summarizeMissionTasks(meshId, id));
        expect(byId.get(ids[0])).toMatchObject({ total: 4, completed: 2, pending: 2 });
    });

    it('mission_list_query meshStatusView answers the mesh_status projection (parsed brief only, record timestamps kept)', async () => {
        seedMissionsWithTasks(2, 2);
        const compact = await call('mission_list_query', { v, meshId, meshStatusView: 'compact' });
        expect(compact.success).toBe(true);
        expect(compact.missions).toHaveLength(2);
        for (const m of compact.missions) {
            expect(m.goalPreview.length).toBeLessThanOrEqual(80);
            expect(m.brief).toMatchObject({ goal: 'brief goal' });
            expect(m.briefJson).toBeUndefined();
            expect(typeof m.createdAt).toBe('string');
            expect(typeof m.updatedAt).toBe('string');
        }
        const verbose = await call('mission_list_query', { v, meshId, meshStatusView: 'verbose' });
        expect(verbose.missions.every((m: any) => typeof m.goal === 'string' && m.stats === undefined)).toBe(true);
    });
});

describe('3. mesh_status nodes section + aggregate cache', () => {
    it('sections:["nodes"] answers the node section only; a cache hit does not clone the queue', () => {
        const queue = { tasks: [{ id: 't1', status: 'completed', message: 'x'.repeat(1000) }], summary: { total: 1 } };
        const snapshot = {
            success: true, meshId, refreshedAt: 'now', sourceOfTruth: {}, branchConvergenceSummary: {},
            nodes: [{ nodeId: 'n1', git: { branch: 'main' } }], queue, ledger: { entries: [] }, missions: [],
        };
        const self: any = { aggregateMeshStatusCache: new Map([[meshId, { builtAt: Date.now(), snapshot, queueRevision: getMeshQueueRevision(meshId) }]]) };
        const nodesOnly = getCachedAggregateMeshStatus(self, meshId, undefined, { nodesOnly: true });
        expect(nodesOnly.nodes).toEqual(snapshot.nodes);
        expect(nodesOnly.nodes).not.toBe(snapshot.nodes); // still a private copy of what it returns
        expect(nodesOnly.queue).toBeUndefined();
        expect(nodesOnly.ledger).toBeUndefined();
        const full = getCachedAggregateMeshStatus(self, meshId, undefined, {});
        expect(full.queue).toBe(queue); // shared, not deep-cloned per hit
        expect(full.nodes).not.toBe(snapshot.nodes);

        const projected = projectMeshStatusNodesSection({ ...snapshot, nodeRuntimeHeld: true, pendingCoordinatorEvents: [{}] });
        expect(Object.keys(projected).sort()).toEqual(['meshId', 'nodeRuntimeHeld', 'nodes', 'refreshedAt', 'sections', 'success']);
        expect(projectMeshStatusNodesSection({ success: false, error: 'x' })).toEqual({ success: false, error: 'x' });
    });
});

describe('4. active work / queue view read only what they use', () => {
    it('active_work_query without a queue argument parses only the active rows', async () => {
        seedMissionsWithTasks(2, 6);
        const fullParse = vi.spyOn(MeshRuntimeStore.prototype, 'getQueueEntries');
        const res = await call('active_work_query', { v, meshId, recordTail: 50, includeInputs: true });
        expect(res.success).toBe(true);
        expect(res.activeWork.activeWork.length).toBe(8); // 12 tasks, 4 completed
        for (const [, statuses] of fullParse.mock.calls) {
            expect(statuses).toEqual(['pending', 'assigned']);
        }
    });

    it('queue_query withCounts / withDependencyHeads report the whole queue from columns', async () => {
        const done = enqueueTask(meshId, 'upstream', { difficulty: 'medium' } as any);
        __writeTaskStatusForTests(meshId, done.id, 'failed');
        const dependent = enqueueTask(meshId, 'downstream', { difficulty: 'medium', dependsOn: [done.id] } as any);
        await new Promise(r => setTimeout(r, 5)); // the terminal row is now strictly older than "0 ms ago"
        const res = await call('queue_query', { v, meshId, statuses: ['pending', 'assigned'], withCounts: true, historicalOlderThanMs: 0, withDependencyHeads: true });
        const recent = await call('queue_query', { v, meshId, withCounts: true, historicalOlderThanMs: 60_000 });
        expect(recent.oldHistoricalCount).toBe(0);
        expect(res.entries.map((e: any) => e.id)).toEqual([dependent.id]);
        expect(res.counts).toEqual({ failed: 1, pending: 1 });
        expect(res.oldHistoricalCount).toBe(1);
        expect(res.dependencyHeads).toEqual([{ id: done.id, status: 'failed' }]);
    });
});

describe('5. task_stats_query missionIds', () => {
    it('computes every mission rollup in one pass, equal to the per-mission rollups', async () => {
        const ids = seedMissionsWithTasks(5, 3);
        const expected = Object.fromEntries(ids.map(id => [id, computeMeshMissionStats(meshId, id)]));
        const facts = vi.spyOn(MeshRuntimeStore.prototype, 'getQueueFacts');
        const fullParse = vi.spyOn(MeshRuntimeStore.prototype, 'getQueueEntries');
        const res = await call('task_stats_query', { v, meshId, missionIds: ids });
        expect(res.success).toBe(true);
        expect(res.missions).toEqual(expected);
        expect(facts).toHaveBeenCalledTimes(1);
        expect(fullParse).not.toHaveBeenCalled();
    });
});

describe('6. recovery_context_query nodeIds', () => {
    it('answers every node in one call, equal to the single-node contexts', async () => {
        seedLocalRecord(meshId, { kind: 'task_failed', nodeId: 'node-a', payload: { error: 'boom' } } as any);
        const res = await call('recovery_context_query', { v, meshId, nodeIds: ['node-a', 'node-b'] });
        expect(res.success).toBe(true);
        expect(res.contexts['node-a'].consecutiveNodeFailures).toBe(1);
        expect(res.contexts['node-a']).toEqual(getSessionRecoveryContext(meshId, { nodeId: 'node-a' }));
        expect(res.contexts['node-b'].consecutiveNodeFailures).toBe(0);
    });
});

describe('7. scheduling runtime from the daemon', () => {
    it('active_work_query resolves the mesh itself and stamps lastQuotaRanking', async () => {
        const mesh = { id: meshId, name: 'M', policy: {}, nodes: [{ id: 'node-q', workspace: '/w', policy: {} }] };
        recordLastQuotaRanking('node-q', { decidedAt: 1, winner: 'claude-cli', adopted: true } as any);
        const res = await call('active_work_query', { v, meshId, compute: false, includeSchedulingRuntime: true }, {
            getMeshForCommand: async () => ({ mesh, inline: true, source: 'inline_cache' }),
        });
        expect(res.success).toBe(true);
        const node = res.schedulingRuntime.nodes.find((n: any) => n.nodeId === 'node-q');
        expect(node.lastQuotaRanking).toMatchObject({ winner: 'claude-cli', adopted: true });
    });
});
