import assert from 'node:assert/strict';
import test from 'node:test';

import { meshRefineBatch, meshRefineNode, resolveCoordinatorDaemonId } from '../src/tools/mesh-tools.js';

// RC32 (Part B): remote Refinery terminal-event return path — MCP stamp.
//
// meshRefineNode / meshRefineBatch relay refine_mesh_node / batch_refine_mesh_nodes
// to the EXECUTING daemon. For a remote worktree node, commandForNode relays straight
// to that daemon (transport.meshCommand), bypassing the coordinator daemon's own
// forward-stamp — so the calling coordinator's canonical daemon/status id MUST ride
// in the args, mirroring the med-family dispatch return-address contract
// (meshContext.coordinatorDaemonId via resolveCoordinatorDaemonId). Without it the
// executing daemon self-fallbacks to its OWN statusInstanceId and the terminal
// refine:accepted/completed/failed event is scoped to an inbox the real coordinator
// never drains (it eventually trims to held).

const COORDINATOR_NODE_DAEMON_ID = 'daemon_mach_aaaa1111aaaa1111aaaa1111aaaa1111';
const LOCAL_DAEMON_ID = 'mach_bbbb2222bbbb2222bbbb2222bbbb2222';
const CANON_LOCAL_DAEMON_ID = `daemon_${LOCAL_DAEMON_ID}`;

function makeCtx(over: Record<string, unknown> = {}): { ctx: any; calls: Array<{ command: string; args: any }> } {
    const calls: Array<{ command: string; args: any }> = [];
    const ctx: any = {
        mesh: {
            id: 'mesh_remote',
            name: 'Remote Mesh',
            coordinator: {},
            policy: {},
            nodes: [
                {
                    id: 'node_wt_remote',
                    isLocalWorktree: true,
                    workspace: '/remote/worktree-a',
                    daemonId: 'daemon_mach_9999ffff9999ffff9999ffff9999ffff',
                },
            ],
        },
        localDaemonId: LOCAL_DAEMON_ID,
        transport: {
            // Not an IpcTransport: commandForNode falls through to transport.command,
            // which is exactly what these tests record.
            command: async (command: string, args: any) => {
                calls.push({ command, args });
                if (command === 'get_mesh') return { success: false }; // refresh: keep ctx.mesh.nodes
                if (command === 'refine_mesh_node') return { success: true, async: true, status: 'accepted' };
                if (command === 'batch_refine_mesh_nodes') return { success: true, async: true, status: 'accepted', batch: true };
                return { success: true };
            },
        },
        ...over,
    };
    return { ctx, calls };
}

test('meshRefineNode stamps the canonical coordinator daemon id into refine_mesh_node args', async () => {
    const { ctx, calls } = makeCtx();
    await meshRefineNode(ctx, { node_id: 'node_wt_remote', execute: true });

    const refine = calls.find(c => c.command === 'refine_mesh_node');
    assert.ok(refine, 'refine_mesh_node was dispatched');
    assert.equal(refine.args.coordinatorDaemonId, CANON_LOCAL_DAEMON_ID);
    assert.equal(refine.args.coordinatorDaemonId, resolveCoordinatorDaemonId(ctx));
});

test('meshRefineNode prefers the coordinator mesh node daemonId when one resolves', async () => {
    const { ctx, calls } = makeCtx({
        mesh: {
            id: 'mesh_remote',
            name: 'Remote Mesh',
            coordinator: { preferredNodeId: 'node_coordinator' },
            policy: {},
            nodes: [
                { id: 'node_coordinator', daemonId: COORDINATOR_NODE_DAEMON_ID, workspace: '/repo/main' },
                {
                    id: 'node_wt_remote',
                    isLocalWorktree: true,
                    workspace: '/remote/worktree-a',
                    daemonId: 'daemon_mach_9999ffff9999ffff9999ffff9999ffff',
                },
            ],
        },
    });
    await meshRefineNode(ctx, { node_id: 'node_wt_remote', execute: true });

    const refine = calls.find(c => c.command === 'refine_mesh_node');
    assert.ok(refine, 'refine_mesh_node was dispatched');
    assert.equal(refine.args.coordinatorDaemonId, COORDINATOR_NODE_DAEMON_ID);
});

test('meshRefineBatch stamps the canonical coordinator daemon id into batch_refine_mesh_nodes args', async () => {
    const { ctx, calls } = makeCtx();
    await meshRefineBatch(ctx, { node_ids: ['node_wt_remote'], execute: true });

    const batch = calls.find(c => c.command === 'batch_refine_mesh_nodes');
    assert.ok(batch, 'batch_refine_mesh_nodes was dispatched');
    assert.equal(batch.args.coordinatorDaemonId, CANON_LOCAL_DAEMON_ID);
    assert.equal(batch.args.coordinatorDaemonId, resolveCoordinatorDaemonId(ctx));
});

test('omits coordinatorDaemonId only when no local identity exists at all (version-skew safe)', async () => {
    const { ctx, calls } = makeCtx({ localDaemonId: undefined, localMachineId: undefined });
    await meshRefineNode(ctx, { node_id: 'node_wt_remote', execute: true });

    const refine = calls.find(c => c.command === 'refine_mesh_node');
    assert.ok(refine, 'refine_mesh_node was dispatched');
    assert.equal('coordinatorDaemonId' in refine.args, false);
});
