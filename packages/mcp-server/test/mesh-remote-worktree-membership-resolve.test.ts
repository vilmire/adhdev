// REMOTE-WORKTREE-MEMBERSHIP-RESOLVE — findNodeWithRefresh() must not lose a
// worktree node that lives on a REMOTE daemon.
//
// Live symptom (2026-08-08): for a remote worktree node,
//   mesh_list_nodes  -> node present
//   mesh_git_status  -> "Node '<id>' is not a member of mesh"
//   mesh_remove_node -> same
// while local worktrees and remote BASE nodes both worked. Net effect: the
// coordinator forgets the node exists while the worktree stays on disk, so
// orphaned worktrees accumulate.
//
// Root cause: `isLocalWorktree` is stamped by the daemon that OWNS the
// worktree, describing locality relative to THAT daemon. On the coordinator the
// flag is still true, so the refresh-skip guard (`hit && !hit.isLocalWorktree`)
// falls through to refreshMeshFromDaemon(), which SPLICES ctx.mesh.nodes with
// whatever the *local* daemon's get_mesh returns. The local daemon never owned
// the remote clone, so the node is erased from the coordinator's own snapshot
// and the subsequent .find() throws.
//
// Fix: refreshMeshFromDaemon() union-merges (never drops locally-known nodes
// the local daemon simply doesn't own), and findNodeWithRefresh() falls back to
// asking the OWNING daemon via the existing mesh_relay_command path before
// declaring a non-membership — distinguishing "not a member" from "owner
// unreachable".
import test from 'node:test';
import assert from 'node:assert/strict';

import { findNodeWithRefresh, findOptionalNodeWithRefresh, refreshMeshFromDaemon } from '../src/tools/mesh-tools-internal.js';

type Call = { verb: string; daemonId?: string; args: any };

/**
 * Harness mirroring the live topology:
 *  - node-base       : remote BASE node owned by daemon-remote
 *  - node-remote-wt  : worktree cloned ON daemon-remote (isLocalWorktree:true,
 *                      because daemon-remote sees it as local to itself)
 *  - node-local-wt   : worktree owned by the coordinator's own daemon
 *
 * The LOCAL daemon's get_mesh only knows the nodes it owns — exactly the
 * condition that made the wholesale splice destructive.
 */
function makeCtx(opts: {
    localGetMeshNodes: any[];
    remoteGetMeshNodes?: any[];
    remoteThrows?: Error;
    calls: Call[];
}) {
    const transport: any = {
        command: async (verb: string, args: any) => {
            opts.calls.push({ verb, args });
            if (verb === 'get_mesh') {
                return { success: true, mesh: { nodes: opts.localGetMeshNodes, updatedAt: '2026-08-08T00:00:00.000Z' } };
            }
            return { success: true };
        },
        meshCommand: async (daemonId: string, verb: string, args: any) => {
            opts.calls.push({ verb, daemonId, args });
            if (opts.remoteThrows) throw opts.remoteThrows;
            if (verb === 'get_mesh') {
                return { success: true, mesh: { nodes: opts.remoteGetMeshNodes ?? [], updatedAt: '2026-08-08T00:01:00.000Z' } };
            }
            return { success: true };
        },
    };
    return {
        mesh: {
            id: 'mesh-test',
            name: 'Test Mesh',
            updatedAt: '2026-08-08T00:00:00.000Z',
            nodes: [
                { id: 'node-base', daemonId: 'daemon-remote', workspace: '/remote/repo', isLocalWorktree: false },
                { id: 'node-remote-wt', daemonId: 'daemon-remote', workspace: '/remote/wt', isLocalWorktree: true, worktreeBranch: 'feat/remote' },
                { id: 'node-local-wt', daemonId: 'daemon-local', workspace: '/local/wt', isLocalWorktree: true, worktreeBranch: 'feat/local' },
            ],
        },
        transport,
        localDaemonId: 'daemon-local',
    } as any;
}

// The local daemon owns only its own nodes — it never learned about the clone
// that daemon-remote created.
const LOCAL_ONLY_NODES = [
    { id: 'node-base', daemonId: 'daemon-remote', workspace: '/remote/repo', isLocalWorktree: false },
    { id: 'node-local-wt', daemonId: 'daemon-local', workspace: '/local/wt', isLocalWorktree: true, worktreeBranch: 'feat/local' },
];

test('resolves a REMOTE worktree node instead of throwing "is not a member of mesh"', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({ localGetMeshNodes: LOCAL_ONLY_NODES, calls });

    const node = await findNodeWithRefresh(ctx, 'node-remote-wt');

    assert.equal(node.id, 'node-remote-wt');
    assert.equal((node as any).daemonId, 'daemon-remote');
});

test('refreshMeshFromDaemon does not drop nodes the local daemon does not own', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({ localGetMeshNodes: LOCAL_ONLY_NODES, calls });

    await refreshMeshFromDaemon(ctx);

    const ids = ctx.mesh.nodes.map((n: any) => n.id);
    // The remote worktree must survive a refresh whose payload omits it.
    assert.ok(ids.includes('node-remote-wt'), `remote worktree erased by refresh: ${ids.join(',')}`);
    // Nodes the local daemon DOES report must still be present.
    assert.ok(ids.includes('node-base'));
    assert.ok(ids.includes('node-local-wt'));
});

test('refreshMeshFromDaemon still adopts nodes newly discovered by the local daemon', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({
        localGetMeshNodes: [
            ...LOCAL_ONLY_NODES,
            { id: 'node-brand-new', daemonId: 'daemon-local', workspace: '/local/new', isLocalWorktree: false },
        ],
        calls,
    });

    await refreshMeshFromDaemon(ctx);

    const ids = ctx.mesh.nodes.map((n: any) => n.id);
    assert.ok(ids.includes('node-brand-new'), 'newly discovered node must merge in');
    assert.ok(ids.includes('node-remote-wt'), 'remote worktree must still survive');
});

test('refreshMeshFromDaemon prefers the daemon payload for nodes it does report', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({
        localGetMeshNodes: [
            { id: 'node-base', daemonId: 'daemon-remote', workspace: '/remote/repo-MOVED', isLocalWorktree: false },
            ...LOCAL_ONLY_NODES.slice(1),
        ],
        calls,
    });

    await refreshMeshFromDaemon(ctx);

    const base = ctx.mesh.nodes.find((n: any) => n.id === 'node-base');
    assert.equal(base.workspace, '/remote/repo-MOVED', 'daemon truth must win for reported nodes');
});

test('REGRESSION: a LOCAL worktree node still resolves through the refresh path', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({ localGetMeshNodes: LOCAL_ONLY_NODES, calls });

    const node = await findNodeWithRefresh(ctx, 'node-local-wt');

    assert.equal(node.id, 'node-local-wt');
    // Local worktrees must keep taking the refresh (that is why the guard exists).
    assert.ok(calls.some(c => c.verb === 'get_mesh' && !c.daemonId), 'local worktree must still refresh from the local daemon');
});

test('REGRESSION: a remote BASE node short-circuits without any refresh', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({ localGetMeshNodes: LOCAL_ONLY_NODES, calls });

    const node = await findNodeWithRefresh(ctx, 'node-base');

    assert.equal(node.id, 'node-base');
    assert.equal(calls.length, 0, 'cached non-worktree node must not trigger any daemon call');
});

test('a genuinely unknown node still reports non-membership', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({ localGetMeshNodes: LOCAL_ONLY_NODES, calls });

    await assert.rejects(
        () => findNodeWithRefresh(ctx, 'node-does-not-exist'),
        /is not a member of mesh/,
    );
});

test('an unreachable owning daemon is reported as unreachable, NOT as non-membership', async () => {
    const calls: Call[] = [];
    // The node is absent from the coordinator snapshot entirely (e.g. a fresh MCP
    // process), so resolution must go ask the owning daemon — which is offline.
    const ctx = makeCtx({ localGetMeshNodes: LOCAL_ONLY_NODES, calls });
    ctx.mesh.nodes = ctx.mesh.nodes.filter((n: any) => n.id !== 'node-remote-wt');
    ctx.transport.meshCommand = async () => {
        throw new Error('Target daemon is offline or not connected to signaling.');
    };

    await assert.rejects(
        () => findNodeWithRefresh(ctx, 'node-remote-wt'),
        (e: any) => {
            assert.equal(e.code, 'mesh_node_owner_unreachable');
            assert.match(e.message, /unreachable/);
            assert.doesNotMatch(e.message, /is not a member of mesh/);
            return true;
        },
    );
});

test('findOptionalNodeWithRefresh returns the remote worktree rather than null', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({ localGetMeshNodes: LOCAL_ONLY_NODES, calls });

    const node = await findOptionalNodeWithRefresh(ctx, 'node-remote-wt');

    assert.ok(node, 'remote worktree must not resolve to null');
    assert.equal(node!.id, 'node-remote-wt');
});

test('cache-hit resolution issues no repeat remote call (no per-lookup fan-out)', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({ localGetMeshNodes: LOCAL_ONLY_NODES, calls });

    await findNodeWithRefresh(ctx, 'node-remote-wt');
    const afterFirst = calls.length;
    await findNodeWithRefresh(ctx, 'node-remote-wt');

    assert.ok(
        calls.length - afterFirst <= afterFirst,
        'repeat lookups must not grow remote traffic per call',
    );
});
