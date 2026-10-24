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

// 2026-10-08: mesh_refine_node's default dry-run is the only plan surface (mesh_refine_plan
// was removed). A dry-run removes nothing, so the node must stay in the cached mesh — it
// used to be spliced out because {success:true, dryRun:true} has no async/removeResult.
test('meshRefineNode dry-run keeps the node in the cached mesh', async () => {
    const { ctx } = makeCtx({
        transport: {
            command: async (command: string) => {
                if (command === 'get_mesh') return { success: false };
                if (command === 'refine_mesh_node') return { success: true, dryRun: true, mergeWillRun: false, cleanupWillRun: false };
                return { success: true };
            },
        },
    });
    const result = JSON.parse(await meshRefineNode(ctx, { node_id: 'node_wt_remote' }));
    assert.equal(result.dryRun, true);
    assert.ok(ctx.mesh.nodes.some((n: any) => n.id === 'node_wt_remote'), 'dry-run must not drop the node');
});

test('approved_publish_shas is forwarded as approvedPublishShas by both refine tools and declared in both schemas', async () => {
    const { ALL_MESH_TOOLS } = await import('../src/tools/mesh-tool-schemas.js');
    for (const name of ['mesh_refine_node', 'mesh_refine_batch']) {
        const tool: any = (ALL_MESH_TOOLS as any[]).find(t => t.name === name);
        assert.ok(tool.inputSchema.properties.approved_publish_shas, `${name} schema declares approved_publish_shas`);
        assert.match(tool.inputSchema.properties.approved_publish_shas.description, /publish_approval_required/);
    }
    const { ctx, calls } = makeCtx();
    await meshRefineNode(ctx, { node_id: 'node_wt_remote', execute: true, approved_publish_shas: ['abc1234', 7 as any] });
    await meshRefineBatch(ctx, { execute: true, approved_publish_shas: ['abc1234'] });
    assert.deepEqual(calls.find(c => c.command === 'refine_mesh_node')!.args.approvedPublishShas, ['abc1234', 7]);
    assert.deepEqual(calls.find(c => c.command === 'batch_refine_mesh_nodes')!.args.approvedPublishShas, ['abc1234']);
});

test('round4 P2-B: per-repo approval maps survive both MCP refine calls', async () => {
    const { ctx, calls } = makeCtx();
    const approvals = { oss: ['abcdef0'], 'adhdev-providers': ['1234567'], root: ['7654321'] };
    await meshRefineNode(ctx, { node_id: 'node_wt_remote', execute: true, approved_publish_shas: approvals });
    await meshRefineBatch(ctx, { execute: true, approved_publish_shas: approvals });
    assert.deepEqual(calls.find(c => c.command === 'refine_mesh_node')!.args.approvedPublishShas, approvals);
    assert.deepEqual(calls.find(c => c.command === 'batch_refine_mesh_nodes')!.args.approvedPublishShas, approvals);
});

test('rc28 FF-only mode and exact per-node target pins survive both MCP refine calls', async () => {
    const { ALL_MESH_TOOLS } = await import('../src/tools/mesh-tool-schemas.js');
    const { ctx, calls } = makeCtx();
    const targets = { node_wt_remote: 'a'.repeat(40) };
    await meshRefineNode(ctx, { node_id: 'node_wt_remote', execute: true, merge_mode: 'ff-only', approved_target_shas: targets });
    const perNode = { node_wt_remote: { root: [targets.node_wt_remote] } };
    await meshRefineBatch(ctx, { execute: true, merge_mode: 'ff-only', approved_target_shas: targets, approved_publish_shas_by_node: perNode });
    assert.deepEqual(calls.find(c => c.command === 'batch_refine_mesh_nodes')!.args.approvedPublishShasByNode, perNode);
    for (const command of ['refine_mesh_node', 'batch_refine_mesh_nodes']) {
        assert.equal(calls.find(c => c.command === command)!.args.mergeMode, 'ff-only');
        assert.deepEqual(calls.find(c => c.command === command)!.args.approvedTargetShas, targets);
    }
    for (const name of ['mesh_refine_node', 'mesh_refine_batch']) {
        const tool: any = ALL_MESH_TOOLS.find(t => t.name === name);
        assert.deepEqual(tool.inputSchema.properties.merge_mode.enum, ['merge', 'ff-only']);
        assert.ok(tool.inputSchema.properties.approved_target_shas);
    }
});

for (const value of [undefined, null, {}, { root: 'invalid' }, ['a'.repeat(40), 7]]) {
    test(`R2 MCP retains explicit invalid authority ${JSON.stringify(value)} without filtering or legacy downgrade`, async () => {
        const { ctx, calls } = makeCtx();
        await meshRefineNode(ctx, { node_id: 'node_wt_remote', execute: true, approved_publish_shas: value as any });
        await meshRefineBatch(ctx, { execute: true, approved_publish_shas_by_node: value as any });
        const single = JSON.parse(JSON.stringify(calls.find(c => c.command === 'refine_mesh_node')!.args));
        const batch = JSON.parse(JSON.stringify(calls.find(c => c.command === 'batch_refine_mesh_nodes')!.args));
        assert.deepEqual(single.approvedPublishShas, value === undefined ? null : value);
        assert.deepEqual(batch.approvedPublishShasByNode, value === undefined ? null : value);
    });
}
