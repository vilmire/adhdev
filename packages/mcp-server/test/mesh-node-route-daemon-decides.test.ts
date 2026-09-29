import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { commandForNode, isLocalControlPlaneNode } from '../src/tools/mesh-tools-internal.js';
import { ensureMeshNodeRoutes, MESH_NODE_ROUTES_TTL_MS } from '../src/tools/mesh-node-routes.js';
import { applyMeshStatusViewRoutes, sealMeshStatusViewTransport } from '../src/tools/mesh-status-view.js';

// Data-path audit 2026-09-29 (owner principle ④): a tool never decides node
// locality itself — the coordinator daemon answers `mesh_node_route` for every
// node the tool reasons over (read_chat's replica hop, launch, related-repo git,
// refine config reads …), and the tool follows that answer even where its own
// identity guess would have said otherwise.

function mesh() {
    return {
        id: 'mesh-route', name: 'Route', repoIdentity: 'example/repo', policy: {}, coordinator: { preferredNodeId: 'node-self' },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        nodes: [
            // Names THIS daemon — but the daemon says it moved to another daemon.
            { id: 'node-self', daemonId: 'daemon-self', workspace: '/ws/self', repoRoot: '/ws/self', userOverrides: {}, policy: {} },
            // Names ANOTHER daemon — but its checkout is on this machine (the daemon serves it).
            { id: 'node-peer-here', daemonId: 'daemon-peer', workspace: '/ws/peer-here', repoRoot: '/ws/peer-here', userOverrides: {}, policy: {} },
        ],
    } as any;
}

function daemon(routes: Record<string, any>) {
    const calls: Array<{ command: string; args: any }> = [];
    const relays: Array<{ daemonId: string; command: string }> = [];
    const transport = Object.create(IpcTransport.prototype);
    // Own properties: bypass the suite's fake-answer wrapper so every call is counted here.
    Object.defineProperty(transport, 'command', {
        value: async (command: string, args: any = {}) => {
            calls.push({ command, args });
            if (command === 'mesh_node_route') return { success: true, meshId: args.meshId, routes };
            return { success: true, answeredBy: 'coordinator', command };
        },
    });
    Object.defineProperty(transport, 'meshCommand', {
        value: async (daemonId: string, command: string) => {
            relays.push({ daemonId, command });
            return { success: true, answeredBy: daemonId, command };
        },
    });
    return { transport, calls, relays };
}

test('one mesh_node_route call describes every node and names the daemon the tool believes it talks to', async () => {
    const { transport, calls } = daemon({ 'node-self': { route: 'local', reason: 'served_by_this_daemon' } });
    const ctx: any = { mesh: mesh(), transport, localDaemonId: 'daemon-self' };
    await ensureMeshNodeRoutes(ctx, { now: 1_000 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.command, 'mesh_node_route');
    assert.equal(calls[0]!.args.callerDaemonId, 'daemon-self');
    assert.deepEqual(calls[0]!.args.nodes.map((n: any) => [n.id, n.daemonId, n.workspace]), [
        ['node-self', 'daemon-self', '/ws/self'],
        ['node-peer-here', 'daemon-peer', '/ws/peer-here'],
    ]);
    // Held within the TTL for the same node set …
    await ensureMeshNodeRoutes(ctx, { now: 1_000 + MESH_NODE_ROUTES_TTL_MS - 1 });
    assert.equal(calls.length, 1);
    // … re-asked when the node set changes, and after the TTL.
    ctx.mesh.nodes.push({ id: 'node-new', daemonId: 'daemon-x', workspace: '/ws/new', userOverrides: {}, policy: {} });
    await ensureMeshNodeRoutes(ctx, { now: 1_001 });
    assert.equal(calls.length, 2);
    await ensureMeshNodeRoutes(ctx, { now: 1_001 + MESH_NODE_ROUTES_TTL_MS });
    assert.equal(calls.length, 3);
});

test('locality follows the daemon answer, not the tool’s identity guess', async () => {
    const { transport, calls, relays } = daemon({
        'node-self': { route: 'remote', ownerDaemonId: 'daemon-moved', reason: 'owned_by_another_daemon' },
        'node-peer-here': { route: 'local', ownerDaemonId: 'daemon-peer', reason: 'checkout_on_this_machine' },
    });
    const ctx: any = { mesh: mesh(), transport, localDaemonId: 'daemon-self' };
    const [self, peerHere] = ctx.mesh.nodes;

    // Before the daemon answered, only identity decides.
    assert.equal(isLocalControlPlaneNode(ctx, self), true);
    assert.equal(isLocalControlPlaneNode(ctx, peerHere), false);

    // commandForNode asks the daemon first, then routes by its answer.
    const onPeerHere = await commandForNode(ctx, peerHere, 'git_status', { workspace: '/ws/peer-here' });
    assert.equal(onPeerHere.answeredBy, 'coordinator', 'the daemon serves this checkout in-process — no relay');
    assert.equal(calls.filter((c) => c.command === 'mesh_node_route').length, 1);
    assert.equal(isLocalControlPlaneNode(ctx, self), false);
    assert.equal(isLocalControlPlaneNode(ctx, peerHere), true);

    await commandForNode(ctx, self, 'git_status', { workspace: '/ws/self' });
    assert.deepEqual(relays, [{ daemonId: 'daemon-self', command: 'git_status' }], 'relayed over the mesh channel, as the daemon decided');
});

test('mesh_status takes every route from the ONE view it already fetched (no second call)', async () => {
    const view = { meshId: 'mesh-route', routes: { 'node-self': { route: 'local', reason: 'served_by_this_daemon' }, 'node-peer-here': { route: 'remote', ownerDaemonId: 'daemon-peer', reason: 'owned_by_another_daemon' } } };
    const { transport, calls } = daemon({});
    // mesh_status holds the view's routes on a context whose transport is sealed:
    // even a forced re-ask reaches no daemon and keeps the held answer.
    const ctx: any = { mesh: mesh(), transport: sealMeshStatusViewTransport(transport), localDaemonId: 'daemon-self' };
    applyMeshStatusViewRoutes(ctx, view);
    await ensureMeshNodeRoutes(ctx, { force: true });
    assert.equal(calls.length, 0);
    assert.equal(isLocalControlPlaneNode(ctx, ctx.mesh.nodes[0]), true);
    assert.equal(isLocalControlPlaneNode(ctx, ctx.mesh.nodes[1]), false);
});

test('a daemon that cannot answer leaves no route (identity-only), and never throws', async () => {
    const transport = Object.create(IpcTransport.prototype);
    Object.defineProperty(transport, 'command', { value: async () => { throw new Error('daemon down'); } });
    const ctx: any = { mesh: mesh(), transport, localDaemonId: 'daemon-self' };
    await ensureMeshNodeRoutes(ctx);
    assert.equal(ctx.nodeRoutes, undefined);
    assert.equal(isLocalControlPlaneNode(ctx, ctx.mesh.nodes[1]), false);
});
