// COORDINATOR-ONLY READS (owner principle 2026-09-26): the coordinator agent's
// MCP tools talk to the coordinator daemon, which holds every node's latest
// state (member pushes). These tests pin ZERO member calls
// (`transport.meshCommand`, the P2P relay) on the normal path of:
//   1. node resolution (findNodeWithRefresh / findOptionalNodeWithRefresh) —
//      coordinator-only, member daemons are never asked;
//   2. remote dispatch session pick/verify (ipcDispatchToRemoteAgent) — answered
//      from the coordinator-held runtime; only `agent_command` itself goes live;
//   3. mesh_review_inbox — the coordinator's own ledger;
//   4. refine / change-impact config schema reads and default validate/suggest.
import test from 'node:test';
import assert from 'node:assert/strict';

import { IpcTransport } from '../src/transports/ipc.js';
import {
    findNodeWithRefresh,
    findOptionalNodeWithRefresh,
    ipcDispatchToRemoteAgent,
} from '../src/tools/mesh-tools-internal.js';
import {
    meshChangeImpactConfigSchema,
    meshRefineConfig,
    meshReviewInbox,
    meshValidateRefineConfig,
} from '../src/tools/mesh-tools.js';

type Call = { kind: 'command' | 'meshCommand'; verb: string; daemonId?: string; args: any };

const MESH_ID = 'mesh-coord-only';
const COORD = 'daemon-coord';
const REMOTE = 'daemon-remote';

function baseNodes(): any[] {
    return [
        { id: 'node-coord', daemonId: COORD, workspace: '/coord/repo', isLocalWorktree: false },
        { id: 'node-remote', daemonId: REMOTE, workspace: '/remote/repo', isLocalWorktree: false, policy: { providerPriority: ['claude-cli'] } },
    ];
}

function heldSession(overrides: Record<string, any> = {}): any {
    return {
        id: 'sess-remote-1',
        instanceId: 'sess-remote-1',
        providerType: 'claude-cli',
        status: 'idle',
        settings: { meshNodeFor: MESH_ID, meshNodeId: 'node-remote', launchedByCoordinator: true },
        ...overrides,
    };
}

function makeCtx(opts: {
    nodes?: any[];
    /** Coordinator get_mesh nodes; `null` = the membership read fails. */
    coordinatorMeshNodes?: any[] | null;
    /** Held runtime sessions for node-remote; undefined = daemon holds no runtime. */
    heldSessions?: any[];
    /** Routing-stamp version the held summary carries (absent = an older member). */
    heldStampVersion?: number;
    /** Live get_status_metadata sessions on the member. */
    liveSessions?: any[];
    memberMeshNodes?: any[];
    calls: Call[];
}) {
    const nodes = opts.nodes ?? baseNodes();
    const transport: any = Object.create(IpcTransport.prototype);
    transport.command = async (verb: string, args: any) => {
        opts.calls.push({ kind: 'command', verb, args });
        if (verb === 'get_mesh') {
            if (opts.coordinatorMeshNodes === null) return { success: false, error: 'boom' };
            return { success: true, mesh: { nodes: opts.coordinatorMeshNodes ?? nodes, updatedAt: '2026-09-27T00:00:00.000Z' } };
        }
        if (verb === 'mesh_status') {
            return {
                success: true,
                meshId: MESH_ID,
                ...(opts.heldSessions ? { nodeRuntimeHeld: true } : {}),
                nodes: nodes.map((node: any) => ({
                    nodeId: node.id,
                    ...(opts.heldSessions && node.daemonId !== COORD
                        ? { heldRuntime: {
                            source: 'member_push',
                            observedAt: Date.now(),
                            sessions: opts.heldSessions,
                            ...(opts.heldStampVersion ? { sessionStampVersion: opts.heldStampVersion } : {}),
                        } }
                        : {}),
                })),
            };
        }
        return { success: true, verb };
    };
    transport.meshCommand = async (daemonId: string, verb: string, args: any) => {
        opts.calls.push({ kind: 'meshCommand', verb, daemonId, args });
        if (verb === 'get_status_metadata') return { success: true, status: { sessions: opts.liveSessions ?? [] } };
        if (verb === 'get_mesh') return { success: true, mesh: { nodes: opts.memberMeshNodes ?? [] } };
        if (verb === 'agent_command') return { success: true };
        return { success: true, verb };
    };
    return {
        mesh: { id: MESH_ID, name: 'Coordinator Only', policy: {}, coordinator: {}, nodes: nodes.map(n => ({ ...n })) },
        transport,
        localDaemonId: COORD,
    } as any;
}

const memberCalls = (calls: Call[]) => calls.filter(c => c.kind === 'meshCommand');
const memberReads = (calls: Call[]) => memberCalls(calls).filter(c => c.verb !== 'agent_command');

// ─── 1. node resolution ─────────────────────────────────────────────────────

test('1: a node the coordinator knows (absent from the MCP snapshot) resolves with zero member calls', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({
        calls,
        coordinatorMeshNodes: [...baseNodes(), { id: 'node-remote-wt', daemonId: REMOTE, workspace: '/remote/wt', isLocalWorktree: true }],
    });
    const node = await findNodeWithRefresh(ctx, 'node-remote-wt');
    assert.equal(node.id, 'node-remote-wt');
    assert.deepEqual(memberCalls(calls), []);
    assert.equal(calls.filter(c => c.verb === 'get_mesh').length, 1, 'exactly one coordinator get_mesh');
});

test('1: a remote worktree in the snapshot resolves via the coordinator refresh only', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({
        calls,
        nodes: [...baseNodes(), { id: 'node-remote-wt', daemonId: REMOTE, workspace: '/remote/wt', isLocalWorktree: true }],
        coordinatorMeshNodes: baseNodes(),
    });
    const node = await findOptionalNodeWithRefresh(ctx, 'node-remote-wt');
    assert.equal(node?.id, 'node-remote-wt');
    assert.deepEqual(memberCalls(calls), []);
});

test('1: a failed coordinator membership read never fans out to members', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({ calls, coordinatorMeshNodes: null });
    await assert.rejects(() => findNodeWithRefresh(ctx, 'node-unknown'), (e: any) => {
        assert.equal(e.code, 'mesh_coordinator_membership_unavailable');
        assert.doesNotMatch(e.message, /is not a member of mesh/);
        return true;
    });
    assert.equal(await findOptionalNodeWithRefresh(ctx, 'node-unknown'), null);
    assert.deepEqual(memberCalls(calls), []);
});

test('1: a node the coordinator does not hold is a membership verdict — no member fan-out', async () => {
    // The member fan-out (mesh-node-membership-fallback.ts) is gone: the coordinator
    // daemon persists remote clones and adopts member-reported worktree nodes
    // (daemon-core MEMBER-WORKTREE-RECONCILE), so its roster is authoritative.
    const calls: Call[] = [];
    const ctx = makeCtx({
        calls,
        nodes: [...baseNodes(), { id: 'node-other', daemonId: 'daemon-other', workspace: '/other/repo' }],
        memberMeshNodes: [{ id: 'node-lost-wt', daemonId: REMOTE, workspace: '/remote/lost', isLocalWorktree: true }],
    });
    await assert.rejects(() => findNodeWithRefresh(ctx, 'node-lost-wt'), /is not a member of mesh/);
    assert.equal(await findOptionalNodeWithRefresh(ctx, 'node-lost-wt'), null);
    assert.deepEqual(memberCalls(calls), [], 'no member daemon is ever asked');
    assert.equal(calls.filter(c => c.verb === 'get_mesh').length, 2, 'one coordinator get_mesh per lookup');
});

// ─── 2. remote dispatch session pick ────────────────────────────────────────

const dispatchArgs = { message: 'do the thing', meshContext: { meshId: MESH_ID, coordinatorDaemonId: COORD } };

test('2: sessionless dispatch auto-picks from the held runtime with zero member reads', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({ calls, heldSessions: [heldSession()] });
    const result = await ipcDispatchToRemoteAgent(ctx, ctx.mesh.nodes[1], dispatchArgs);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(memberReads(calls), [], 'no get_status_metadata relay');
    const send = memberCalls(calls).filter(c => c.verb === 'agent_command');
    assert.equal(send.length, 1, 'the dispatch itself stays live');
    assert.equal(send[0].args.targetSessionId, 'sess-remote-1');
});

test('2: an explicit session_id is verified from the held runtime with zero member reads', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({ calls, heldSessions: [heldSession()] });
    const result = await ipcDispatchToRemoteAgent(ctx, ctx.mesh.nodes[1], { ...dispatchArgs, session_id: 'sess-remote-1' });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(memberReads(calls), []);
    assert.equal(memberCalls(calls).filter(c => c.verb === 'agent_command')[0].args.targetSessionId, 'sess-remote-1');
});

test('2: an explicit session missing from the held list is confirmed by ONE live read', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({ calls, heldSessions: [], liveSessions: [heldSession({ id: 'sess-new', instanceId: 'sess-new' })] });
    const result = await ipcDispatchToRemoteAgent(ctx, ctx.mesh.nodes[1], { ...dispatchArgs, session_id: 'sess-new' });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(memberReads(calls).length, 1);
    assert.equal(memberReads(calls)[0].verb, 'get_status_metadata');
});

test('2: a detached held pick (no meshNodeFor — sticky marker not held) is confirmed live', async () => {
    const detached = heldSession({ settings: { launchedByCoordinator: true } });
    const calls: Call[] = [];
    const ctx = makeCtx({
        calls,
        heldSessions: [detached],
        liveSessions: [{ ...detached, settings: { launchedByCoordinator: true, meshCoordinatorDaemonId: COORD, meshLastNodeId: 'node-base-other' } }],
    });
    const result = await ipcDispatchToRemoteAgent(ctx, ctx.mesh.nodes[1], dispatchArgs);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(memberReads(calls).length, 1, 'held fidelity is insufficient → one live read');
    const send = memberCalls(calls).find(c => c.verb === 'agent_command')!;
    assert.equal(send.args.targetSessionId, undefined, 'live sticky marker names another node → sessionless dispatch');
});

// Routing-stamp v2 (daemon-core MESH_NODE_RUNTIME_SESSION_STAMP_VERSION): the held
// summary carries meshLastNodeId / meshCoordinatorDaemonId, so the held pick is the
// decision a live read would make — decisive, zero member reads.
test('2: v2 stamps — a detached held session whose sticky marker names another node is decided with zero member reads', async () => {
    const detached = heldSession({ settings: { launchedByCoordinator: true, meshCoordinatorDaemonId: COORD, meshLastNodeId: 'node-base-other' } });
    const calls: Call[] = [];
    const ctx = makeCtx({ calls, heldSessions: [detached], heldStampVersion: 2, liveSessions: [detached] });
    const result = await ipcDispatchToRemoteAgent(ctx, ctx.mesh.nodes[1], dispatchArgs);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(memberReads(calls), [], 'held stamps are complete → no get_status_metadata relay');
    const send = memberCalls(calls).find(c => c.verb === 'agent_command')!;
    assert.equal(send.args.targetSessionId, undefined, 'held sticky marker names another node → sessionless dispatch');
});

test('2: v2 stamps — a detached held session sticky to THIS node is picked with zero member reads', async () => {
    const detached = heldSession({ settings: { launchedByCoordinator: true, meshCoordinatorDaemonId: COORD, meshLastNodeId: 'node-remote' } });
    const calls: Call[] = [];
    const ctx = makeCtx({ calls, heldSessions: [detached], heldStampVersion: 2 });
    const result = await ipcDispatchToRemoteAgent(ctx, ctx.mesh.nodes[1], dispatchArgs);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(memberReads(calls), []);
    assert.equal(memberCalls(calls).find(c => c.verb === 'agent_command')!.args.targetSessionId, 'sess-remote-1');
});

test('2: v2 stamps — an explicit session missing from the held list is still confirmed by ONE live read', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({ calls, heldSessions: [], heldStampVersion: 2, liveSessions: [heldSession({ id: 'sess-new', instanceId: 'sess-new' })] });
    const result = await ipcDispatchToRemoteAgent(ctx, ctx.mesh.nodes[1], { ...dispatchArgs, session_id: 'sess-new' });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(memberReads(calls).length, 1);
    assert.equal(memberReads(calls)[0].verb, 'get_status_metadata');
});

test('2: a coordinator without held runtime keeps the legacy live read', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({ calls, liveSessions: [heldSession()] });
    const result = await ipcDispatchToRemoteAgent(ctx, ctx.mesh.nodes[1], dispatchArgs);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(memberReads(calls).length, 1);
});

// ─── 3. mesh_review_inbox ───────────────────────────────────────────────────

test('3: mesh_review_inbox reads the local coordinator even when nodes[0] is a remote member', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({ calls, nodes: [baseNodes()[1], baseNodes()[0]] });
    await meshReviewInbox(ctx);
    assert.deepEqual(memberCalls(calls), []);
    const inbox = calls.filter(c => c.kind === 'command' && c.verb === 'get_mesh_review_inbox');
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].args.meshId, MESH_ID);
});

// ─── 4. refine / change-impact config ───────────────────────────────────────

test('4: config schema reads go to the local coordinator daemon', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({ calls, nodes: [baseNodes()[1], baseNodes()[0]] });
    await meshRefineConfig(ctx, { mode: 'schema' });
    await meshChangeImpactConfigSchema(ctx);
    assert.deepEqual(memberCalls(calls), []);
    assert.deepEqual(calls.map(c => c.verb), ['get_mesh_refine_config_schema', 'get_mesh_change_impact_config_schema']);
});

test('4: validate without node_id uses the coordinator\'s own node, not the first (remote) node', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({ calls, nodes: [baseNodes()[1], baseNodes()[0]] });
    await meshValidateRefineConfig(ctx, {});
    await meshRefineConfig(ctx, { mode: 'suggest' });
    assert.deepEqual(memberCalls(calls), []);
    assert.deepEqual(calls.map(c => c.args.workspace), ['/coord/repo', '/coord/repo']);
});

test('4: validate with an explicit remote node_id still targets that node', async () => {
    const calls: Call[] = [];
    const ctx = makeCtx({ calls });
    await meshValidateRefineConfig(ctx, { node_id: 'node-remote' });
    const member = memberCalls(calls);
    assert.equal(member.length, 1);
    assert.equal(member[0].daemonId, REMOTE);
    assert.equal(member[0].verb, 'validate_mesh_refine_config');
});
