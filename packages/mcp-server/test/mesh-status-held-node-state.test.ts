import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshGitStatus, meshStatus } from '../src/tools/mesh-tools.js';
import { deriveDataFreshnessFromObservation } from '../src/tools/mesh-status-held-git.js';
import { answerTurnIpc, isTurnIpcCommand } from './helpers/turn-ledger-ipc.js';
import { heldMeshStatusResponse } from './helpers/held-node-state.js';

// COORDINATOR-HELD NODE GIT (owner principle 2026-09-26): "nothing fetches fresh
// values from remote nodes on demand — everything goes through the coordinator
// daemon, which always holds the latest values". The MCP mesh_status tool used to
// probe every node's git_status (refreshUpstream) over P2P on each call, so the
// response waited on the slowest peer and could disagree with the dashboard. It now
// does ONE local `mesh_status` read of the daemon's held node state.

const SLOW_PEER_MS = 3_000;
const OBSERVED_AT = Date.parse('2026-09-26T12:00:00.000Z');

function buildSixNodeMesh() {
    const nodes = [];
    for (let i = 0; i < 6; i += 1) {
        nodes.push({
            id: `node-${i}`,
            workspace: `/ws/node-${i}`,
            repoRoot: `/ws/node-${i}`,
            daemonId: i === 0 ? 'daemon-coord' : `daemon-peer-${i}`,
            machineId: i === 0 ? 'machine-coord' : `machine-peer-${i}`,
            userOverrides: {},
            policy: { providerPriority: ['claude-code'] },
            ...(i === 3 ? { relatedRepos: [{ label: 'docs', workspace: `/ws/node-${i}-docs` }] } : {}),
        });
    }
    return {
        id: `mesh-held-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: 'Held Mesh', repoIdentity: 'example/repo', defaultBranch: 'main', policy: {}, coordinator: {},
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), nodes,
    };
}

function buildCtx(opts: { refreshingNodeIds?: string[]; daemonMeshStatus?: 'ok' | 'fail' } = {}) {
    const mesh = buildSixNodeMesh();
    const directCommands: Array<{ command: string; args: any }> = [];
    const meshCommands: Array<{ daemonId: string; command: string; args: any }> = [];
    const heldGit = (node: any) => {
        if (node.id === 'node-5') throw new Error('peer daemon-peer-5 unreachable');
        return {
            status: {
                isGitRepo: true, branch: 'main', upstream: 'origin/main', upstreamStatus: 'fresh',
                ahead: 0, behind: 0, modified: node.id === 'node-2' ? 2 : 0,
                submodules: node.id === 'node-4' ? [{ path: 'oss', commit: 'abc', outOfSync: true }] : [],
            },
            ...(node.id === 'node-1' ? { reporterNodeFacts: { quota: { 'claude-code': { status: 'ok', session: { usedPercent: 10 } } } } } : {}),
        };
    };
    // A real IpcTransport instance so remote nodes route through meshCommand (P2P relay).
    const transport: any = new IpcTransport();
    transport.command = async (command: string, args: any = {}) => {
        if (isTurnIpcCommand(command)) return answerTurnIpc(command, args);
        directCommands.push({ command, args });
        if (command === 'get_mesh') return { success: true, mesh };
        if (command === 'get_pending_mesh_events') return { events: [] };
        if (command === 'mesh_status') {
            if (opts.daemonMeshStatus === 'fail') throw new Error('IPC to coordinator daemon failed');
            return heldMeshStatusResponse(mesh, heldGit, {
                localDaemonId: 'daemon-coord',
                observedAt: OBSERVED_AT,
                refreshingNodeIds: args?.refresh === true ? (opts.refreshingNodeIds ?? []) : [],
            });
        }
        if (command === 'get_status_metadata') return { success: true, status: { sessions: [] } };
        if (command === 'git_status') {
            // A LOCAL git_status is a live read too — mesh_status must not issue it for node git.
            return { success: true, status: { isGitRepo: true, branch: 'live-local' } };
        }
        return { success: true };
    };
    transport.meshCommand = async (daemonId: string, command: string, args: any = {}) => {
        meshCommands.push({ daemonId, command, args });
        if (command === 'get_status_metadata') return { success: true, status: { sessions: [] } };
        if (command === 'git_status' || command === 'git_diff_summary') {
            // A slow (TURN-relayed) peer: the old request path waited on this.
            await new Promise((resolve) => setTimeout(resolve, SLOW_PEER_MS));
            return command === 'git_status'
                ? { success: true, status: { isGitRepo: true, branch: 'live-remote', upstreamStatus: 'fresh' } }
                : { success: true, diffSummary: { files: [] } };
        }
        throw new Error(`unexpected mesh command: ${command}`);
    };
    const ctx = { mesh, transport, localDaemonId: 'daemon-coord', localMachineId: 'machine-coord', coordinatorHostname: 'coord' };
    return { ctx, mesh, directCommands, meshCommands };
}

test('mesh_status answers from the coordinator-held node state: no live git probe, fast with slow peers', async () => {
    const { ctx, directCommands, meshCommands } = buildCtx();
    const startedAt = Date.now();
    const result = JSON.parse(await meshStatus(ctx as any, { verbose: true }));
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs < 2_000, `mesh_status must not wait on slow peers (took ${elapsedMs} ms)`);
    assert.deepEqual(meshCommands.filter((c) => c.command === 'git_status'), [], 'no remote git_status on the request path');
    assert.deepEqual(directCommands.filter((c) => c.command === 'git_status'), [], 'no local git_status for node git either');
    const heldReads = directCommands.filter((c) => c.command === 'mesh_status');
    assert.equal(heldReads.length, 1, 'exactly one held-state read of the coordinator daemon');
    assert.equal(heldReads[0].args.awaitLiveProbes, undefined, 'never asks the daemon to block on peers');
    assert.equal(heldReads[0].args.refresh, undefined);

    const byId = new Map(result.nodes.map((n: any) => [n.nodeId, n]));
    const self = byId.get('node-0') as any;
    const peer = byId.get('node-1') as any;
    const dirty = byId.get('node-2') as any;
    const outOfSync = byId.get('node-4') as any;
    const dead = byId.get('node-5') as any;

    assert.deepEqual(self.gitObservation, { source: 'self', observedAt: OBSERVED_AT, refreshing: false, unreachableSince: null });
    assert.equal(self.dataFreshness.dataSource, 'self');
    assert.equal(peer.gitObservation.source, 'member_push');
    assert.equal(peer.dataFreshness.dataSource, 'cached');
    assert.equal(peer.dataFreshness.lastProbeAt, new Date(OBSERVED_AT).toISOString());
    assert.equal(peer.branch, 'main', 'held git, not the live-remote answer');
    assert.equal(peer.health, 'online');
    assert.deepEqual(peer.quota?.['claude-code']?.status, 'ok', 'quota from the held node facts');
    assert.equal(dirty.health, 'dirty');
    assert.deepEqual(outOfSync.outOfSyncSubmodules, ['oss']);
    assert.equal(dead.health, 'degraded');
    assert.equal(dead.degradedReason, 'node_unreachable');
    assert.equal(dead.dataFreshness.dataSource, 'unreachable');
    assert.equal(dead.dataFreshness.reachable, false);
    assert.deepEqual(result.nodeGitState, { source: 'coordinator_held', refreshing: false });

    // Related repos of a REMOTE node are listed without a live probe.
    const withRelated = byId.get('node-3') as any;
    assert.equal(withRelated.relatedRepos?.[0]?.statusHeld, false);
});

test('mesh_status refresh:true kicks the daemon background refresh and returns immediately with refreshing', async () => {
    const { ctx, directCommands, meshCommands } = buildCtx({ refreshingNodeIds: ['node-1', 'node-2'] });
    const startedAt = Date.now();
    const result = JSON.parse(await meshStatus(ctx as any, { refresh: true, verbose: true }));
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs < 2_000, `refresh must not block (took ${elapsedMs} ms)`);
    assert.deepEqual(meshCommands.filter((c) => c.command === 'git_status'), []);
    const heldReads = directCommands.filter((c) => c.command === 'mesh_status');
    assert.equal(heldReads.length, 1);
    assert.equal(heldReads[0].args.refresh, true, 'refresh is forwarded to the coordinator daemon');
    assert.equal(heldReads[0].args.awaitLiveProbes, undefined);

    assert.deepEqual(result.nodeGitState, {
        source: 'coordinator_held', refreshRequested: true, refreshing: true, refreshingNodeIds: ['node-1', 'node-2'],
    });
    const node1 = result.nodes.find((n: any) => n.nodeId === 'node-1');
    assert.equal(node1.gitObservation.refreshing, true);
    assert.equal(node1.branch, 'main', 'returns the held value now; the refreshed one lands on a later call');
});

test('mesh_status degrades to unknown (never to a live probe) when the coordinator daemon cannot answer', async () => {
    const { ctx, meshCommands, directCommands } = buildCtx({ daemonMeshStatus: 'fail' });
    const result = JSON.parse(await meshStatus(ctx as any, { verbose: true }));
    assert.deepEqual(meshCommands.filter((c) => c.command === 'git_status'), []);
    assert.deepEqual(directCommands.filter((c) => c.command === 'git_status'), []);
    const peer = result.nodes.find((n: any) => n.nodeId === 'node-1');
    assert.equal(peer.health, 'unknown');
    assert.equal(peer.degradedReason, 'coordinator_state_unavailable');
    assert.match(result.nodeGitState.error, /IPC to coordinator daemon failed/);
});

test('mesh_git_status (explicit single-node detail read) still probes the node live', async () => {
    const { ctx, meshCommands } = buildCtx();
    const out = JSON.parse(await meshGitStatus(ctx as any, { node_id: 'node-3' }));
    const gitCalls = meshCommands.filter((c) => c.command === 'git_status');
    assert.ok(gitCalls.length >= 1, 'live git_status to the node');
    assert.equal(gitCalls[0].args.refreshUpstream, true);
    assert.equal(out.status.branch, 'live-remote');
    assert.ok(gitCalls.some((c) => c.args.workspace === '/ws/node-3-docs'), 'related repos probed live on the detail read');
});

test('deriveDataFreshnessFromObservation keeps the dataFreshness contract and forces unreachable', () => {
    const now = OBSERVED_AT + 90_000;
    const cached = deriveDataFreshnessFromObservation({
        observation: { source: 'member_push', observedAt: OBSERVED_AT, refreshing: false, unreachableSince: null },
        daemonFreshness: { reachable: true },
        hasGit: true, isSelfNode: false, daemonId: 'd', now,
    });
    assert.deepEqual(cached, {
        dataSource: 'cached', probeOk: false, reachable: true, directPeerTruthSatisfied: false, projection: 'cached',
        lastProbeAt: new Date(OBSERVED_AT).toISOString(), ageMs: 90_000, staleness: 'recent',
    });
    const heldButFailing = deriveDataFreshnessFromObservation({
        observation: { source: 'coordinator_probe', observedAt: OBSERVED_AT, refreshing: false, unreachableSince: OBSERVED_AT + 1 },
        daemonFreshness: { reachable: true },
        hasGit: true, isSelfNode: false, daemonId: 'd', now,
    });
    assert.equal(heldButFailing.dataSource, 'cached');
    assert.equal(heldButFailing.reachable, false, 'unreachableSince wins over a stale daemon connection claim');
    const pending = deriveDataFreshnessFromObservation({
        observation: { source: 'none', observedAt: null, refreshing: true, unreachableSince: null },
        hasGit: false, isSelfNode: false, daemonId: 'd', now,
    });
    assert.equal(pending.dataSource, 'pending');
    assert.equal(pending.staleness, 'unknown');
    const unconfigured = deriveDataFreshnessFromObservation({
        observation: { source: 'none', observedAt: null, refreshing: false, unreachableSince: null },
        hasGit: false, isSelfNode: false, now,
    });
    assert.equal(unconfigured.dataSource, 'unconfigured');
    const local = deriveDataFreshnessFromObservation({
        observation: { source: 'local', observedAt: OBSERVED_AT, refreshing: false, unreachableSince: null },
        hasGit: true, isSelfNode: false, daemonId: 'd', now,
    });
    assert.equal(local.dataSource, 'live');
    assert.equal(local.staleness, 'fresh');
});
