import assert from 'node:assert/strict';
import test from 'node:test';

import { meshStatus, meshViewQueue } from '../src/tools/mesh-tools.js';
import { refreshMeshFromDaemon } from '../src/tools/mesh-tools-internal.js';
import { __writeTaskStatusForTests, enqueueTask, turnLedgerIpcHandlers, upsertMeshMission } from '@adhdev/daemon-core';
import { heldMeshStatusResponse } from './helpers/held-node-state.js';
import { fakeCoordinatorTransport } from './helpers/fake-coordinator-tool-answers.js';

// MCP read-latency pass (2026-09-27). The coordinator's read tools must ask the
// daemon for exactly what they read, in as few IPC calls as possible, and must
// never open the daemon's store in-process. Measured before on the preview
// daemon: mesh_status 570–680 ms / 5.2 MB IPC in; mesh_view_queue 10.5 MB in +
// 5.3 MB out. Each test here fails on the pre-change MCP code.

type Call = { command: string; args: any };

function buildHarness(opts: { oldDaemon?: boolean; missionSentinel?: boolean; quotaRanking?: boolean } = {}) {
    const meshId = `mesh-read-latency-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const mesh = {
        id: meshId, name: 'Latency Mesh', repoIdentity: 'example/repo', defaultBranch: 'main', policy: {}, coordinator: {},
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        nodes: [
            { id: 'node-a', workspace: '/ws/a', repoRoot: '/ws/a', daemonId: 'daemon-coord', userOverrides: {}, policy: { providerPriority: ['claude-cli'] }, nodeFacts: { big: 'x'.repeat(4000) } },
            { id: 'node-b', workspace: '/ws/b', repoRoot: '/ws/b', daemonId: 'daemon-peer', userOverrides: {}, policy: { providerPriority: ['codex-cli'] } },
        ],
    };
    const calls: Call[] = [];
    const lowCtx = {
        deps: { statusInstanceId: 'daemon-coord' },
        getMeshForCommand: async () => ({ mesh, inline: true, source: 'inline_cache' }),
    };
    // An older daemon's strict decoders reject every request key this pass added.
    const rejectsNewShape = (command: string, args: any) => opts.oldDaemon && (
        (command === 'mission_list_query' && args.meshStatusView !== undefined)
        || (command === 'recovery_context_query' && args.nodeIds !== undefined)
        || (command === 'task_stats_query' && args.missionIds !== undefined)
        || (command === 'queue_query' && (args.withCounts !== undefined || args.withDependencyHeads !== undefined))
        || (command === 'active_work_query' && args.includeSchedulingRuntime === true && !args.mesh)
    );
    const transport: any = fakeCoordinatorTransport({
        async command(command: string, args: any = {}) {
            const wire = JSON.parse(JSON.stringify(args ?? {}));
            calls.push({ command, args: wire });
            if (rejectsNewShape(command, wire)) return { success: false, error: `${command}: request failed decode (bad shape)` };
            if (command === 'mission_list_query' && opts.missionSentinel && wire.meshStatusView === 'compact') {
                return {
                    success: true, truncated: false, matched: 1, historyFold: null,
                    missions: [{
                        id: 'mission-sentinel', meshId, title: 'SENTINEL-FROM-DAEMON', goalPreview: 'g', goalTruncated: false, status: 'active',
                        tasks: { total: 0, pending: 0, assigned: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0, lastActivityAt: null },
                    }],
                };
            }
            const handler = (turnLedgerIpcHandlers as Record<string, (ctx: unknown, a: unknown) => Promise<any>>)[command];
            if (handler) {
                const res = await handler(lowCtx, wire);
                if (command === 'active_work_query' && opts.quotaRanking && res?.schedulingRuntime) {
                    res.schedulingRuntime.nodes = res.schedulingRuntime.nodes.map((n: any) => n.nodeId === 'node-a'
                        ? { ...n, lastQuotaRanking: { decidedAt: 1, winner: 'claude-cli', adopted: true } }
                        : n);
                }
                return res;
            }
            if (command === 'get_mesh') return { success: true, mesh };
            if (command === 'mesh_status') {
                return heldMeshStatusResponse(mesh, () => ({ isGitRepo: true, branch: 'main', ahead: 0, behind: 0 }), { localDaemonId: 'daemon-coord' });
            }
            if (command === 'get_pending_mesh_events') return { success: true, events: [] };
            if (command === 'get_status_metadata') return { success: true, status: { sessions: [] } };
            return { success: true };
        },
        async meshCommand(_daemonId: string, command: string, args: any) { return transport.command(command, args); },
        async ping() { return true; },
    });
    const ctx: any = { mesh: JSON.parse(JSON.stringify(mesh)), transport, localDaemonId: 'daemon-coord', localMachineId: 'machine-coord', coordinatorHostname: 'h' };
    const of = (command: string) => calls.filter(c => c.command === command);
    return { meshId, ctx, calls, of };
}

test('refreshMeshFromDaemon asks get_mesh for membership only (no per-call git hydration)', async () => {
    const h = buildHarness();
    await refreshMeshFromDaemon(h.ctx);
    assert.equal(h.of('get_mesh')[0]?.args.membershipOnly, true);
});

test('mesh_status: one active_work_query (no mesh/queue shipped), batched recovery, nodes-only held read, no duplicate ledger read', async () => {
    const h = buildHarness();
    const res = JSON.parse(await meshStatus(h.ctx));
    assert.ok(Array.isArray(res.nodes) && res.nodes.length === 2);
    assert.deepEqual(h.of('mesh_status').map(c => c.args.sections), [['nodes']]);
    const activeWork = h.of('active_work_query');
    assert.equal(activeWork.length, 1, 'ONE active_work_query');
    assert.equal(activeWork[0].args.mesh, undefined, 'the mesh is not shipped over IPC');
    assert.equal(activeWork[0].args.queue, undefined, 'the queue is not shipped over IPC');
    assert.equal(activeWork[0].args.includeSchedulingRuntime, true);
    for (const node of activeWork[0].args.nodes) {
        assert.equal(node.nodeFacts, undefined, 'nodes are slimmed to their session lists');
        assert.equal(node.policy, undefined);
    }
    assert.equal(h.of('ledger_query').length, 0, 'launch failures read the active_work record tail');
    const recovery = h.of('recovery_context_query');
    assert.equal(recovery.length, 1, 'ONE batched recovery_context_query');
    assert.deepEqual(recovery[0].args.nodeIds, ['node-a', 'node-b']);
    // Per-node scheduling still comes back (from the single call).
    assert.ok(res.nodes.every((n: any) => n.scheduling && typeof n.scheduling.load === 'number'));
});

test('mesh_status missions come from the daemon (mission_list_query), never an in-process store read', async () => {
    const h = buildHarness({ missionSentinel: true });
    const res = JSON.parse(await meshStatus(h.ctx));
    assert.deepEqual(h.of('mission_list_query').map(c => c.args.meshStatusView), ['compact']);
    assert.equal(res.missions?.[0]?.title, 'SENTINEL-FROM-DAEMON');
});

test('mesh_status verbose: every mission stats rollup in ONE task_stats_query', async () => {
    const h = buildHarness();
    for (let i = 0; i < 3; i += 1) upsertMeshMission(h.meshId, { title: `mission ${i}`, goal: 'g', status: 'active' });
    const res = JSON.parse(await meshStatus(h.ctx, { verbose: true }));
    const stats = h.of('task_stats_query');
    assert.equal(stats.length, 1);
    assert.equal(stats[0].args.missionIds.length, 3);
    assert.equal(res.missions.length, 3);
    assert.ok(res.missions.every((m: any) => m.stats && m.stats.taskCount === 0 && m.briefJson === undefined));
});

test('mesh_status surfaces the DAEMON\'s lastQuotaRanking (the MCP-process map is always empty)', async () => {
    const h = buildHarness({ quotaRanking: true });
    const res = JSON.parse(await meshStatus(h.ctx));
    const nodeA = res.nodes.find((n: any) => n.nodeId === 'node-a');
    assert.deepEqual(nodeA.scheduling.lastQuotaRanking, { decidedAt: 1, winner: 'claude-cli', adopted: true });
});

test('mesh_view_queue compact: active rows + daemon counts only; the queue never travels back', async () => {
    const h = buildHarness();
    enqueueTask(h.meshId, 'still pending', { difficulty: 'medium' } as any);
    for (let i = 0; i < 3; i += 1) {
        const t = enqueueTask(h.meshId, `done ${i} ${'x'.repeat(2000)}`, { difficulty: 'medium' } as any);
        __writeTaskStatusForTests(h.meshId, t.id, 'completed');
    }
    const compact = JSON.parse(await meshViewQueue(h.ctx, {}));
    for (const call of h.of('queue_query')) {
        assert.deepEqual(call.args.statuses, ['pending', 'assigned'], 'compact never reads historical rows');
        assert.equal(call.args.withCounts, true);
    }
    for (const call of h.of('active_work_query')) assert.equal(call.args.queue, undefined, 'the queue is not sent back');
    assert.equal(compact.summary.totalCount, 4);
    assert.equal(compact.historicalCount, 3);
    assert.equal(compact.activeCount, 1);
    assert.equal(compact.queue.length, 1);
    // One copy of each alias in compact.
    assert.equal(compact.cleanupDryRun, undefined);
    assert.equal(compact.staleAssignments, undefined);
    assert.equal(compact.visibleSummary, undefined, 'unfiltered visibleSummary equals summary');
    assert.equal(compact.queueMaintenance.historicalRecordCount, 3);

    // Same counts as the full (verbose) read.
    const verbose = JSON.parse(await meshViewQueue(h.ctx, { verbose: true }));
    assert.deepEqual(compact.summary, verbose.summary);
    // A filtered compact view still gets its visible counts.
    const filtered = JSON.parse(await meshViewQueue(h.ctx, { status: ['completed'] }));
    assert.equal(filtered.visibleSummary.totalCount, 3);
    assert.equal(filtered.visibleHistoricalCount, 3);
});

test('an older daemon (rejects the new request keys) still gets complete mesh_view_queue answers', async () => {
    // mesh_status is ONE mesh_status_view the coordinator composes itself (P1-6) —
    // no MCP-side request-shape fallbacks remain for it.
    const h = buildHarness({ oldDaemon: true });
    enqueueTask(h.meshId, 'pending task', { difficulty: 'medium' } as any);
    const t = enqueueTask(h.meshId, 'done', { difficulty: 'medium' } as any);
    __writeTaskStatusForTests(h.meshId, t.id, 'completed');

    const queue = JSON.parse(await meshViewQueue(h.ctx, {}));
    assert.equal(queue.success, true);
    assert.equal(queue.summary.totalCount, 2);
    assert.equal(queue.historicalCount, 1);
});
