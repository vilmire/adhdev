import assert from 'node:assert/strict';
import test from 'node:test';

import { composeMeshStatusView } from '@adhdev/daemon-core';
import { IpcTransport } from '../src/transports/ipc.js';
import { meshStatus } from '../src/tools/mesh-tools.js';
import { answerTurnIpc, armTestTurnLedger, isTurnIpcCommand } from './helpers/turn-ledger-ipc.js';
import { heldMeshStatusResponse } from './helpers/held-node-state.js';

// Data-path audit 2026-09-29 P1-6: the MCP `mesh_status` tool asks the
// coordinator daemon ONE question (`mesh_status_view`) and renders the answer.
// The daemon composes every input in-process; the tool never reads a member —
// there is no live-probe fallback for a remote node the coordinator holds
// nothing for.

armTestTurnLedger('daemon-coord');

function buildMesh() {
    return {
        id: `mesh-one-call-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: 'One Call', repoIdentity: 'example/repo', defaultBranch: 'main', policy: {}, coordinator: {},
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        nodes: [
            { id: 'node-0', daemonId: 'daemon-coord', machineId: 'machine-coord', workspace: '/ws/0', repoRoot: '/ws/0', userOverrides: {}, policy: { providerPriority: ['claude-cli'] } },
            { id: 'node-1', daemonId: 'daemon-peer', machineId: 'machine-peer', workspace: '/ws/1', repoRoot: '/ws/1', userOverrides: {}, policy: { providerPriority: ['claude-cli'] } },
            { id: 'node-2', daemonId: 'daemon-new', machineId: 'machine-new', workspace: '/ws/2', repoRoot: '/ws/2', userOverrides: {}, policy: { providerPriority: ['claude-cli'] } },
        ],
    };
}

/** The coordinator daemon: answers ONLY mesh_status_view (composed with the real composer). */
function coordinator(mesh: ReturnType<typeof buildMesh>) {
    const outer: Array<{ command: string; args: any }> = [];
    const inner = async (command: string, args: any = {}): Promise<any> => {
        if (isTurnIpcCommand(command)) return answerTurnIpc(command, args);
        if (command === 'get_mesh') return { success: true, mesh };
        if (command === 'get_status_metadata') {
            return { success: true, status: { instanceId: 'daemon-coord', sessions: [{ id: 'sess-local', providerType: 'claude-cli', status: 'idle' }] }, daemonBuild: { commit: 'c0ffee00c0ffee00', commitShort: 'c0ffee0', version: '1.0.60', track: 'preview' } };
        }
        if (command === 'get_pending_mesh_events') return { events: [] };
        if (command === 'mesh_status') {
            return heldMeshStatusResponse(mesh, () => ({ isGitRepo: true, branch: 'main', upstream: 'origin/main', upstreamStatus: 'fresh', ahead: 0, behind: 0 }), {
                localDaemonId: 'daemon-coord',
                runtimeFor: (node) => node.daemonId === 'daemon-peer'
                    ? { source: 'member_push', observedAt: Date.now(), refreshing: false, daemonId: 'daemon-peer', sessions: [{ id: 'sess-peer', providerType: 'claude-cli', status: 'generating' }] }
                    : { source: 'none', observedAt: null, refreshing: true, sessions: [] },
            });
        }
        return { success: false, error: `the daemon composes nothing else: ${command}` };
    };
    const transport = Object.create(IpcTransport.prototype);
    // An own property: bypasses the suite's fake-answer wrapper, so every call is counted here.
    Object.defineProperty(transport, 'command', {
        value: async (command: string, args: any = {}) => {
            outer.push({ command, args });
            if (command !== 'mesh_status_view') throw new Error(`mesh_status must not call ${command}`);
            return { success: true, ...(await composeMeshStatusView(inner as any, args)) };
        },
    });
    Object.defineProperty(transport, 'meshCommand', {
        value: async () => { throw new Error('mesh_status must never read a member'); },
    });
    return { transport, outer };
}

test('mesh_status makes exactly ONE daemon call (mesh_status_view) — compact and verbose, with refresh', async () => {
    for (const args of [{}, { verbose: true }, { refresh: true }]) {
        const mesh = buildMesh();
        const { transport, outer } = coordinator(mesh);
        const ctx: any = { mesh, transport, localDaemonId: 'daemon-coord', localMachineId: 'machine-coord', coordinatorSessionId: 'sess-coord' };
        const out = JSON.parse(await meshStatus(ctx, args));
        assert.equal(outer.length, 1, `${JSON.stringify(args)} → ${outer.map((c) => c.command).join(',')}`);
        assert.equal(outer[0]!.command, 'mesh_status_view');
        assert.equal(outer[0]!.args.meshId, mesh.id);
        assert.equal(outer[0]!.args.compact, (args as any).verbose !== true);
        assert.deepEqual(outer[0]!.args.toolCall, { tool: 'mesh_status', sessionId: 'sess-coord', callerRole: 'coordinator' });
        assert.equal(outer[0]!.args.pendingEvents.sessionId, 'sess-coord');
        assert.equal(Boolean(outer[0]!.args.refresh), (args as any).refresh === true);
        assert.ok(Array.isArray(out.nodes) && out.nodes.length === 3, 'every node rendered');
    }
});

test('a remote node is rendered ONLY from held state — nothing held is reported as none, never probed', async () => {
    const mesh = buildMesh();
    const { transport } = coordinator(mesh);
    const ctx: any = { mesh, transport, localDaemonId: 'daemon-coord', localMachineId: 'machine-coord' };
    const out = JSON.parse(await meshStatus(ctx, { verbose: true, includeSessions: true }));
    const byId = new Map(out.nodes.map((n: any) => [n.nodeId, n]));
    assert.equal((byId.get('node-1') as any).runtimeObservation.source, 'member_push');
    assert.deepEqual((byId.get('node-1') as any).sessions.map((s: any) => s.id), ['sess-peer']);
    assert.equal((byId.get('node-2') as any).runtimeObservation.source, 'none');
    assert.equal((byId.get('node-2') as any).sessions, undefined);
    assert.deepEqual((byId.get('node-0') as any).sessions.map((s: any) => s.id), ['sess-local']);
});

test('the coordinator unable to answer is reported, not worked around', async () => {
    const mesh = buildMesh();
    const transport = Object.create(IpcTransport.prototype);
    let calls = 0;
    Object.defineProperty(transport, 'command', { value: async () => { calls += 1; throw new Error('Cannot connect to daemon IPC'); } });
    const out = JSON.parse(await meshStatus({ mesh, transport } as any, {}));
    assert.equal(calls, 1);
    assert.equal(out.success, false);
    assert.equal(out.code, 'mesh_coordinator_unavailable');
});
