// SETTLED-REMOVAL-OWNERSHIP — refreshMeshFromDaemon's lineage-based settled
// verdict (clonedFrom source still reported ⇒ worktree's omission means
// removal) must only fire for nodes the LOCAL daemon is authoritative about.
//
// Defect: a base node is effectively always present in the daemon payload, so
// the lineage check alone made EVERY omitted worktree with a live source a
// "settled removal" — including worktrees owned by a REMOTE daemon that the
// local daemon simply never tracked. The settled verdict then short-circuited
// the owner-daemon fallback in findNodeWithRefresh and hard-failed membership
// ("is not a member of mesh") for a live node.
//
// Fix: the lineage verdict is skipped for nodes carrying definitively non-local
// daemon/machine identity (hasDefinitivelyRemoteIdentity). Nodes with no
// explicit identity keep the old behavior — the local daemon's omission remains
// the best removal evidence — so genuinely removed local worktrees still drop
// out (over-correction guard, pinned by the CONTROL test below).
import test from 'node:test';
import assert from 'node:assert/strict';

import { findNodeWithRefresh, refreshMeshFromDaemon } from '../src/tools/mesh-tools-internal.js';

type Call = { verb: string; daemonId?: string; args: any };

const LOCAL_BASE = { id: 'node-local-base', daemonId: 'daemon-local', workspace: '/local/repo', isLocalWorktree: false };
// Remote-OWNED worktree cloned FROM the local base: the local daemon reports
// the source (always) but never tracked the clone.
const REMOTE_WT = {
    id: 'node-remote-wt',
    daemonId: 'daemon-remote',
    workspace: '/remote/wt',
    isLocalWorktree: true,
    worktreeBranch: 'feat/remote',
    clonedFromNodeId: 'node-local-base',
};
// Identity-less worktree with a live local source: nothing disproves local
// ownership, so omission by the local daemon IS removal evidence.
const ANON_WT = {
    id: 'node-anon-wt',
    workspace: '/local/wt-anon',
    clonedFromNodeId: 'node-local-base',
};

function makeCtx(opts: { localGetMeshNodes: any[]; remoteGetMeshNodes?: any[]; calls: Call[] }) {
    const transport: any = {
        command: async (verb: string, args: any) => {
            opts.calls.push({ verb, args });
            if (verb === 'get_mesh') {
                return { success: true, mesh: { nodes: opts.localGetMeshNodes, updatedAt: '2026-08-22T00:00:00.000Z' } };
            }
            return { success: true };
        },
        meshCommand: async (daemonId: string, verb: string, args: any) => {
            opts.calls.push({ verb, daemonId, args });
            if (verb === 'get_mesh') {
                return { success: true, mesh: { nodes: opts.remoteGetMeshNodes ?? [], updatedAt: '2026-08-22T00:01:00.000Z' } };
            }
            return { success: true };
        },
    };
    return {
        mesh: {
            id: 'mesh-test',
            name: 'Test Mesh',
            updatedAt: '2026-08-22T00:00:00.000Z',
            nodes: [
                { ...LOCAL_BASE },
                { ...REMOTE_WT },
                { ...ANON_WT },
            ],
        },
        transport,
        localDaemonId: 'daemon-local',
    } as any;
}

// The local daemon reports only its own base — both worktrees are omitted.
const LOCAL_ONLY_PAYLOAD = [{ ...LOCAL_BASE }];

test('a REMOTE-owned worktree omitted by the local daemon is NOT a settled removal', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({ localGetMeshNodes: LOCAL_ONLY_PAYLOAD, remoteGetMeshNodes: [{ ...REMOTE_WT }], calls });

    const { settledNodeIds } = await refreshMeshFromDaemon(ctx);

    const ids = ctx.mesh.nodes.map((n: any) => n.id);
    assert.ok(ids.includes('node-remote-wt'), `remote-owned worktree erased by refresh: ${ids.join(',')}`);
    assert.ok(!settledNodeIds.has('node-remote-wt'), 'remote-owned worktree must not be marked settled');
});

test('findNodeWithRefresh still resolves the remote-owned worktree (no hard non-membership)', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({ localGetMeshNodes: LOCAL_ONLY_PAYLOAD, remoteGetMeshNodes: [{ ...REMOTE_WT }], calls });

    const node = await findNodeWithRefresh(ctx, 'node-remote-wt');

    assert.equal(node.id, 'node-remote-wt');
});

test('CONTROL (over-correction guard): an identity-less worktree omitted while its source lives IS settled', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({ localGetMeshNodes: LOCAL_ONLY_PAYLOAD, calls });

    const { settledNodeIds } = await refreshMeshFromDaemon(ctx);

    const ids = ctx.mesh.nodes.map((n: any) => n.id);
    assert.ok(!ids.includes('node-anon-wt'), 'genuinely removed local worktree must drop out of the snapshot');
    assert.ok(settledNodeIds.has('node-anon-wt'), 'identity-less omission must remain a settled removal');

    // And membership lookup for it still fails loudly (not silently kept).
    await assert.rejects(
        () => findNodeWithRefresh(ctx, 'node-anon-wt'),
        /is not a member of mesh/,
    );
});
