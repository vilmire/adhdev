import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshStatus } from '../src/tools/mesh-tools.js';
import { awaitMeshStatusBackgroundWork } from '../src/tools/mesh-status-background.js';
import { answerTurnIpc, armTestTurnLedger, isTurnIpcCommand } from './helpers/turn-ledger-ipc.js';
import { heldMeshStatusResponse } from './helpers/held-node-state.js';

// COORDINATOR-HELD NODE RUNTIME (owner principle 2026-09-26): "nobody fetches fresh
// values from a remote machine on the request path — every node pushes to the
// coordinator daemon, which holds the latest values and answers from them". Git
// was moved to held state first; this pins the rest of mesh_status: remote nodes'
// sessions / daemon build / upgrade marker come from the daemon's `heldRuntime`
// (member push, content-free), and the idle-direct-dispatch transcript read runs
// in the background. Measured before: ~2.6 s per call, dominated by the slowest
// peer's get_status_metadata plus a sequential remote read_chat.

armTestTurnLedger('daemon-coord');

const SLOW_PEER_MS = 3_000;
const OBSERVED_AT = Date.parse('2026-09-27T09:00:00.000Z');

function buildMesh() {
    const layout: Array<[string, string]> = [
        ['node-0', 'daemon-coord'], ['node-1', 'daemon-peer-a'], ['node-2', 'daemon-peer-a'], ['node-3', 'daemon-peer-b'], ['node-4', 'daemon-peer-c'],
    ];
    return {
        id: `mesh-held-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: 'Held Runtime', repoIdentity: 'example/repo', defaultBranch: 'main', policy: {}, coordinator: {},
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        nodes: layout.map(([id, daemonId]) => ({
            id, daemonId, machineId: daemonId.replace('daemon', 'machine'), workspace: `/ws/${id}`, repoRoot: `/ws/${id}`,
            userOverrides: {}, policy: { providerPriority: ['claude-cli'] },
        })),
    };
}

function heldRuntimeFor(node: any): any {
    if (node.daemonId === 'daemon-peer-c') {
        // The coordinator holds nothing for this daemon yet (background refresh kicked).
        return { source: 'none', observedAt: null, refreshing: true, sessions: [] };
    }
    return {
        source: 'member_push',
        observedAt: OBSERVED_AT,
        refreshing: false,
        daemonId: node.daemonId,
        daemonBuild: { commit: 'feedface00112233', commitShort: 'feedfac', version: '1.0.60-rc.2', track: 'preview' },
        ...(node.daemonId === 'daemon-peer-b' ? { upgradeFailure: { recordedAt: '2026-09-27T08:00:00.000Z', targetVersion: '1.0.60-rc.3', noticePath: '/n', logPath: '/l' } } : {}),
        sessions: [{
            id: `sess-${node.daemonId}`, providerType: 'claude-cli', status: 'generating',
            activeChat: { status: 'generating' }, turn: { attemptId: `att-${node.daemonId}`, stage: 'delivered' },
            settings: { userHidden: false },
        }],
    };
}

function buildCtx(opts: { held: boolean; readChatDelayMs?: number; idleDirectDispatch?: boolean } = { held: true }) {
    const mesh = buildMesh();
    const directCommands: Array<{ command: string; args: any }> = [];
    const meshCommands: Array<{ daemonId: string; command: string; args: any }> = [];
    const transport: any = new IpcTransport();
    const idleSession = { id: 'sess-idle-direct', providerType: 'claude-cli', status: 'idle' };
    transport.command = async (command: string, args: any = {}) => {
        if (isTurnIpcCommand(command) && command !== 'turn_observe') return answerTurnIpc(command, args);
        directCommands.push({ command, args });
        if (command === 'get_mesh') return { success: true, mesh };
        if (command === 'get_pending_mesh_events') return { events: [] };
        if (command === 'turn_observe') return { success: true, verdict: 'noop' };
        if (command === 'mesh_status') {
            return heldMeshStatusResponse(mesh, () => ({ isGitRepo: true, branch: 'main', upstream: 'origin/main', upstreamStatus: 'fresh', ahead: 0, behind: 0 }), {
                localDaemonId: 'daemon-coord',
                observedAt: OBSERVED_AT,
                ...(opts.held ? {
                    runtimeFor: (node: any) => opts.idleDirectDispatch && node.daemonId === 'daemon-peer-b'
                        ? { source: 'member_push', observedAt: OBSERVED_AT, refreshing: false, sessions: [idleSession] }
                        : heldRuntimeFor(node),
                } : {}),
            });
        }
        if (command === 'get_status_metadata') {
            return { success: true, status: { sessions: [{ id: 'sess-coord', providerType: 'claude-cli', status: 'idle' }] }, daemonBuild: { commit: 'c0c0c0c0', version: '1.0.60-rc.2', track: 'preview' } };
        }
        return { success: true };
    };
    transport.meshCommand = async (daemonId: string, command: string, args: any = {}) => {
        meshCommands.push({ daemonId, command, args });
        if (command === 'get_status_metadata') {
            await new Promise((resolve) => setTimeout(resolve, SLOW_PEER_MS));
            return { success: true, status: { sessions: [{ id: `live-${daemonId}`, providerType: 'claude-cli', status: 'idle', lastMessagePreview: 'CHAT TEXT' }] } };
        }
        if (command === 'read_chat') {
            await new Promise((resolve) => setTimeout(resolve, opts.readChatDelayMs ?? 0));
            return { success: true, messages: [{ role: 'assistant', content: 'done', timestamp: new Date().toISOString() }] };
        }
        return { success: true };
    };
    const ctx = { mesh, transport, localDaemonId: 'daemon-coord', localMachineId: 'machine-coord', coordinatorHostname: 'coord' };
    return { ctx, mesh, directCommands, meshCommands };
}

test('mesh_status answers remote sessions / build / upgrade marker from the coordinator-held runtime — no per-daemon live call, fast with slow peers', async () => {
    const { ctx, directCommands, meshCommands } = buildCtx({ held: true });
    const startedAt = Date.now();
    const result = JSON.parse(await meshStatus(ctx as any, { verbose: true }));
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs < 2_000, `mesh_status must not wait on slow peers (took ${elapsedMs} ms)`);
    assert.deepEqual(meshCommands, [], 'no remote command of any kind on the request path');
    assert.equal(directCommands.filter((c) => c.command === 'mesh_status').length, 1, 'one held-state read');
    assert.equal(directCommands.filter((c) => c.command === 'get_status_metadata').length, 1, 'the coordinator reads ITSELF directly, once');

    const byId = new Map(result.nodes.map((n: any) => [n.nodeId, n]));
    const self = byId.get('node-0') as any;
    const peerA1 = byId.get('node-1') as any;
    const peerA2 = byId.get('node-2') as any;
    const peerB = byId.get('node-3') as any;
    const peerC = byId.get('node-4') as any;

    assert.equal(self.sessions[0].id, 'sess-coord');
    assert.equal(self.runtimeObservation.source, 'local_read');

    assert.deepEqual(peerA1.runtimeObservation, { source: 'member_push', observedAt: OBSERVED_AT, refreshing: false });
    assert.equal(peerA1.sessions.length, 1);
    assert.deepEqual(
        { id: peerA1.sessions[0].id, status: peerA1.sessions[0].status, chatStatus: peerA1.sessions[0].chatStatus, attemptId: peerA1.sessions[0].attemptId, turnStage: peerA1.sessions[0].turnStage },
        { id: 'sess-daemon-peer-a', status: 'generating', chatStatus: 'generating', attemptId: 'att-daemon-peer-a', turnStage: 'delivered' },
    );
    assert.equal(peerA1.sessions[0].lastMessagePreview, undefined, 'held runtime is content-free');
    assert.equal(peerA1.daemonBuild.commitShort, 'feedfac');
    assert.equal(peerA1.daemonBuild.track, 'preview');
    assert.equal(peerA2.sessions[0].id, 'sess-daemon-peer-a');

    assert.equal(peerB.upgradeFailure.targetVersion, '1.0.60-rc.3');
    assert.match(peerB.upgradeFailure.summary, /upgrade to 1\.0\.60-rc\.3 failed/);

    // Nothing held yet → sessions UNKNOWN (not zero), and still no live call.
    assert.deepEqual(peerC.runtimeObservation, { source: 'none', observedAt: null, refreshing: true });
    assert.equal(peerC.sessions, undefined);
});

test('mesh_status does not wait on an idle direct dispatch transcript read — it runs in the background', async () => {
    const { ctx, meshCommands } = buildCtx({ held: true, readChatDelayMs: SLOW_PEER_MS, idleDirectDispatch: true });
    const taskId = `bg-reconcile-${Date.now()}`;
    const opened = await answerTurnIpc('turn_observe', { v: 1, evidence: {
        eventId: taskId, at: Date.now() - 600_000, source: 'dispatch', sessionId: 'sess-idle-direct', taskId, observedBy: 'daemon-coord',
        kind: 'dispatch_accepted', scope: 'mesh_direct', messageId: taskId, meshId: ctx.mesh.id, nodeId: 'node-3', providerType: 'claude-cli',
    } });
    await answerTurnIpc('turn_observe', { v: 1, evidence: {
        eventId: `${taskId}:d`, at: Date.now() - 599_000, source: 'dispatch', sessionId: 'sess-idle-direct', attemptRef: opened.attemptRef,
        observedBy: 'daemon-coord', kind: 'delivered', messageId: taskId, outcome: 'delivered', via: 'p2p',
    } });

    const startedAt = Date.now();
    const result = JSON.parse(await meshStatus(ctx as any, { verbose: true }));
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 2_000, `mesh_status must not wait on the transcript read (took ${elapsedMs} ms)`);
    assert.ok(result.activeWork.some((row: any) => row.taskId === taskId), 'the open direct dispatch is reported');

    await awaitMeshStatusBackgroundWork(ctx as any);
    assert.equal(meshCommands.filter((c) => c.command === 'read_chat').length, 1, 'the transcript read still happens, after the response');
    assert.equal(meshCommands.filter((c) => c.command === 'get_status_metadata').length, 0);
});

test('a coordinator daemon that does not hold runtime (older build) keeps the legacy per-daemon session probe', async () => {
    const { ctx, meshCommands } = buildCtx({ held: false });
    const result = JSON.parse(await meshStatus(ctx as any, { verbose: true }));
    const probed = new Set(meshCommands.filter((c) => c.command === 'get_status_metadata').map((c) => c.daemonId));
    assert.deepEqual([...probed].sort(), ['daemon-peer-a', 'daemon-peer-b', 'daemon-peer-c']);
    const peer = result.nodes.find((n: any) => n.nodeId === 'node-1');
    assert.equal(peer.sessions[0].id, 'live-daemon-peer-a');
    assert.equal(peer.runtimeObservation, undefined);
});
