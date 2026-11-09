// A sessionless remote direct dispatch lets the worker daemon pick the session;
// the worker's agent_command answer names it. The coordinator must record THAT
// session (attempt delivery + task row) — otherwise the owner cannot authorise the
// worker's forwarded report_completion (live bug, rc.117: no_live_task).
import test from 'node:test';
import assert from 'node:assert/strict';

import { IpcTransport } from '../src/transports/ipc.js';
import { dispatchToRemoteNode } from './helpers/remote-dispatch.js';

const COORD = 'daemon-coord';
const REMOTE = 'daemon-remote';
const MESH_ID = 'mesh-sessionless-bind';

function makeCtx(answer: Record<string, unknown>, heldSessions: any[] = []): any {
    const nodes = [
        { id: 'node-coord', daemonId: COORD, workspace: '/coord/repo', isLocalWorktree: false },
        { id: 'node-remote', daemonId: REMOTE, workspace: '/remote/repo', isLocalWorktree: false, policy: { providerPriority: ['claude-cli'] } },
    ];
    const transport: any = Object.create(IpcTransport.prototype);
    transport.command = async (verb: string) => {
        if (verb === 'mesh_status') {
            return { success: true, meshId: MESH_ID, nodes: nodes.map(n => ({
                nodeId: n.id,
                ...(n.daemonId !== COORD ? { heldRuntime: { source: 'member_push', observedAt: Date.now(), sessions: heldSessions } } : {}),
            })) };
        }
        return { success: true, verb };
    };
    transport.meshCommand = async (_daemonId: string, verb: string) => (verb === 'agent_command' ? answer : { success: true, verb });
    return { mesh: { id: MESH_ID, name: 'x', policy: {}, coordinator: {}, nodes }, transport, localDaemonId: COORD };
}

const sticky = {
    id: 'sess-picked-by-worker', instanceId: 'sess-picked-by-worker', providerType: 'claude-cli', status: 'idle',
    settings: { launchedByCoordinator: true, meshCoordinatorDaemonId: COORD, meshLastNodeId: 'node-base-other' },
};
const send = { message: 'do the work', providerType: 'claude-cli', meshContext: { meshId: MESH_ID, nodeId: 'node-remote', coordinatorDaemonId: COORD } };

test('sessionless dispatch adopts the session the worker names in its answer', async () => {
    const ctx = makeCtx({ success: true, sessionId: 'sess-worker-chose' }, [sticky]);
    const result: any = await dispatchToRemoteNode(ctx, ctx.mesh.nodes[1], send);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.sessionId, 'sess-worker-chose');
});

test('an older worker that names no session leaves the result sessionless (no poisoned id)', async () => {
    const ctx = makeCtx({ success: true }, [sticky]);
    const result: any = await dispatchToRemoteNode(ctx, ctx.mesh.nodes[1], send);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.sessionId, '');
});

test('an explicit session_id is never re-pointed by the worker answer', async () => {
    const held = { ...sticky, id: 'sess-named', instanceId: 'sess-named', settings: { launchedByCoordinator: true, meshNodeFor: MESH_ID, meshNodeId: 'node-remote' } };
    const ctx = makeCtx({ success: true, sessionId: 'sess-other' }, [held]);
    const result: any = await dispatchToRemoteNode(ctx, ctx.mesh.nodes[1], { ...send, session_id: 'sess-named' });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.sessionId, 'sess-named');
});
