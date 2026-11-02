// A remote owner's remove_mesh_node only drops its own copy. The coordinator daemon is the
// roster authority, so without a local removal the tool answered removed:true while the node
// stayed listed (live 2026-11-02, two remote nodes on a coordinator-hosted mesh).
import test from 'node:test';
import assert from 'node:assert/strict';

import { meshRemoveNode } from '../src/tools/mesh-tools-git.js';

function makeCtx(opts: { localRemove?: any; localThrows?: boolean; nodeDaemonId: string }) {
    const calls: Array<{ where: string; verb: string }> = [];
    const nodes = [{ id: 'node-x', daemonId: opts.nodeDaemonId, workspace: '/w', isLocalWorktree: false }];
    const ctx: any = {
        mesh: { id: 'mesh-test', name: 'Test', updatedAt: 't', nodes },
        localDaemonId: 'daemon-local',
        transport: {
            supportsMeshRelay: true,
            command: async (verb: string) => {
                if (verb === 'get_mesh') return { success: true, mesh: { nodes, updatedAt: 't' } };
                calls.push({ where: 'local', verb });
                if (opts.localThrows) throw new Error('boom');
                return opts.localRemove ?? { success: true, removed: true };
            },
            meshCommand: async (_daemonId: string, verb: string) => {
                calls.push({ where: 'remote', verb });
                return { success: true, removed: true };
            },
        },
    };
    return { ctx, calls };
}

test('a remote node is removed from its owner and from the coordinator roster', async () => {
    const { ctx, calls } = makeCtx({ nodeDaemonId: 'daemon-remote' });
    const out = JSON.parse(await meshRemoveNode(ctx, { node_id: 'node-x' }));
    assert.equal(out.success, true);
    assert.deepEqual(out.hostMembership, { removed: true });
    assert.deepEqual(calls.filter(c => c.verb === 'remove_mesh_node').map(c => c.where), ['remote', 'local']);
    assert.equal(ctx.mesh.nodes.length, 0);
});

test('a failed roster removal is not reported as removed', async () => {
    const { ctx } = makeCtx({ nodeDaemonId: 'daemon-remote', localThrows: true });
    const out = JSON.parse(await meshRemoveNode(ctx, { node_id: 'node-x' }));
    assert.equal(out.success, false);
    assert.equal(out.code, 'mesh_remove_node_host_membership_failed');
    assert.equal(ctx.mesh.nodes.length, 1);
});

test('a local node is removed once', async () => {
    const { ctx, calls } = makeCtx({ nodeDaemonId: 'daemon-local' });
    const out = JSON.parse(await meshRemoveNode(ctx, { node_id: 'node-x' }));
    assert.equal(out.success, true);
    assert.equal(out.hostMembership, undefined);
    assert.deepEqual(calls.filter(c => c.verb === 'remove_mesh_node').map(c => c.where), ['local']);
});
