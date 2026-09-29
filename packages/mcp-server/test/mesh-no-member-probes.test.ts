// Owner principle ④ (data-path audit 2026-09-29 P1-1): members push, tools ask
// only the coordinator daemon. No MCP tool reads a member's status — a node's
// runtime is the coordinator's own status (its nodes) or the runtime a member
// pushed to it (held), and "nothing held yet" is reported as such, never probed.
//
// Two layers: a source scan over every tool (no member status read can be
// regrown anywhere), and an end-to-end run of the status-reading tools against a
// fake whose members throw on a status read.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshListPendingApprovals, meshStatus, meshViewQueue } from '../src/tools/mesh-tools.js';
import { meshNodeSlotsPropose } from '../src/tools/mesh-tools-slot-autodetect.js';
import { dispatchToRemoteNode } from './helpers/remote-dispatch.js';
import { answerTurnIpc, isTurnIpcCommand } from './helpers/turn-ledger-ipc.js';

const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'tools');

test('source scan: no tool sends a status read to a member (commandForNode / meshCommand)', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts'))) {
        const text = readFileSync(join(TOOLS_DIR, file), 'utf8');
        for (const pattern of [
            /commandForNode\([^)]*['"]get_status_metadata['"]/g,
            /meshCommand\([^)]*['"]get_status_metadata['"]/g,
        ]) {
            for (const match of text.matchAll(pattern)) offenders.push(`${file}: ${match[0].slice(0, 80)}`);
        }
    }
    assert.deepEqual(offenders, []);
    // The coordinator's OWN status is the one status read left, in one place.
    const statusReads = readdirSync(TOOLS_DIR)
        .filter((f) => f.endsWith('.ts'))
        .filter((f) => /\.command\(\s*['"]get_status_metadata['"]/.test(readFileSync(join(TOOLS_DIR, f), 'utf8')));
    assert.deepEqual(statusReads, ['mesh-held-node-state.ts']);
});

const MESH_ID = 'mesh-no-member-probes';
const COORD = 'daemon_mach_coordinator';

function buildCtx() {
    const mesh = {
        id: MESH_ID, name: 'No member probes', repoIdentity: 'vilmire/adhdev', defaultBranch: 'main', policy: {}, coordinator: {},
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        nodes: [
            { id: 'node-coord', workspace: '/coord', repoRoot: '/coord', daemonId: COORD, machineId: 'machine-coord', userOverrides: {}, policy: { providerPriority: ['claude-cli'] } },
            { id: 'node-a', workspace: '/a', repoRoot: '/a', daemonId: 'daemon_mach_a', machineId: 'machine-a', userOverrides: {}, policy: { providerPriority: ['claude-cli'] } },
            { id: 'node-b', workspace: '/b', repoRoot: '/b', daemonId: 'daemon_mach_b', machineId: 'machine-b', userOverrides: {}, policy: { providerPriority: ['claude-cli'] } },
        ],
    };
    const memberSession = { id: 'sess-a', providerType: 'claude-cli', status: 'idle', settings: { meshNodeFor: MESH_ID, meshNodeId: 'node-a', meshCoordinatorDaemonId: COORD, launchedByCoordinator: true } };
    const memberReads: string[] = [];
    let localStatusReads = 0;
    const transport: any = new IpcTransport();
    transport.command = async (command: string, args: any = {}) => {
        if (isTurnIpcCommand(command)) return answerTurnIpc(command, args);
        if (command === 'get_mesh') return { success: true, mesh };
        if (command === 'get_pending_mesh_events') return { events: [] };
        if (command === 'get_status_metadata') {
            localStatusReads += 1;
            return { success: true, status: { instanceId: COORD, sessions: [], availableProviders: [{ type: 'claude-cli', category: 'cli', installed: true }] } };
        }
        if (command === 'mesh_status') {
            // node-a's member pushed its runtime; node-b has pushed nothing yet.
            return {
                success: true, meshId: MESH_ID,
                nodes: [
                    { nodeId: 'node-coord', gitObservation: { source: 'self', observedAt: 1, refreshing: false, unreachableSince: null } },
                    { nodeId: 'node-a', heldRuntime: { source: 'member_push', observedAt: 1, refreshing: false, sessions: [memberSession], providers: [{ type: 'codex-cli', category: 'cli', installed: true }] } },
                    { nodeId: 'node-b', heldRuntime: { source: 'none', observedAt: null, refreshing: true, sessions: [] } },
                ],
            };
        }
        return { success: true };
    };
    transport.meshCommand = async (daemonId: string, command: string) => {
        if (command === 'get_status_metadata') {
            memberReads.push(daemonId);
            throw new Error(`member ${daemonId} status read`);
        }
        return { success: true };
    };
    const ctx: any = { mesh, transport, localDaemonId: COORD, localMachineId: 'machine-coord' };
    return { ctx, memberReads, localStatusReads: () => localStatusReads };
}

test('mesh_status / mesh_view_queue / mesh_list_pending_approvals / slots propose / remote dispatch make zero member status reads', async () => {
    const { ctx, memberReads } = buildCtx();

    const status = JSON.parse(await meshStatus(ctx));
    const byId = new Map(status.nodes.map((n: any) => [n.nodeId, n]));
    assert.equal((byId.get('node-a') as any).runtimeObservation.source, 'member_push');
    assert.equal((byId.get('node-b') as any).runtimeObservation.source, 'none', 'nothing held = unknown, not probed');
    await meshStatus(ctx, { refresh: true } as any);

    await meshViewQueue(ctx, { view: 'active' });
    await meshViewQueue(ctx, { view: 'active', refresh: true });
    await meshListPendingApprovals(ctx, {});

    const proposal = JSON.parse(await meshNodeSlotsPropose(ctx, { node_id: 'node-a' }));
    assert.deepEqual(proposal.detectedCliProviders.map((p: any) => p.type), ['codex-cli'], 'the catalog node-a pushed');
    const unknown = JSON.parse(await meshNodeSlotsPropose(ctx, { node_id: 'node-b' }));
    assert.equal(unknown.code, 'detection_unavailable');

    const picked = await dispatchToRemoteNode(ctx, ctx.mesh.nodes[1], { message: 'x', meshContext: { meshId: MESH_ID, coordinatorDaemonId: COORD } } as any);
    assert.equal(picked.success, true, JSON.stringify(picked));

    assert.deepEqual(memberReads, [], 'no member status read, in any tool');
});

test('mesh_status: remote nodes are never probed — one local status read per call, refresh included', async () => {
    const { ctx, memberReads, localStatusReads } = buildCtx();
    await meshStatus(ctx);
    assert.equal(localStatusReads(), 1, 'the coordinator reads its own status once per call');
    await meshStatus(ctx, { refresh: true } as any);
    assert.equal(localStatusReads(), 2);
    assert.deepEqual(memberReads, []);
});
