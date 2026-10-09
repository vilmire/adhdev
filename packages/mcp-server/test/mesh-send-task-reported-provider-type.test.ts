import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshSendTask } from '../src/tools/mesh-tools.js';
import { armTestTurnLedger, answerTurnIpc, isTurnIpcCommand } from './helpers/turn-ledger-ipc.js';

/**
 * Live (2026-10-09 / 2026-10-10, MainPC win32): `mesh_send_task(session_id: <agy
 * session>)` delivered correctly to the antigravity-cli session, but the result
 * reported `"providerType":"claude-cli"` — the node's providerPriority[0]. On the
 * remote route the provider was resolved from the priority list BEFORE the named
 * session was looked at, and the session's own provider was adopted only when
 * nothing had resolved yet. An explicitly named session's provider is the truth.
 */

const NODE_REMOTE = 'node-mainpc';
const COORDINATOR_DAEMON = 'daemon-coordinator';
const WORKER_DAEMON = 'daemon-mainpc';
const AGY_SESSION = 'sess-agy';

function makeCtx(meshId: string) {
    const agySession = {
        id: AGY_SESSION,
        providerType: 'antigravity-cli',
        status: 'idle',
        settings: { meshNodeFor: meshId, meshNodeId: NODE_REMOTE, meshCoordinatorDaemonId: COORDINATOR_DAEMON },
    };
    const mesh = {
        id: meshId,
        name: 'Reported providerType',
        repoIdentity: 'example/repo',
        policy: {},
        coordinator: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        nodes: [{
            id: NODE_REMOTE,
            workspace: '/tmp/mainpc-repo',
            repoRoot: '/tmp/mainpc-repo',
            daemonId: WORKER_DAEMON,
            machineId: 'machine-mainpc',
            userOverrides: {},
            // claude-cli FIRST: priority[0] is the wrong answer for the agy session.
            policy: { providerPriority: ['claude-cli', 'antigravity-cli'] },
            sessions: [agySession],
        }],
    };
    const agentCommands: Array<Record<string, unknown>> = [];
    const transport = new IpcTransport() as IpcTransport & {
        command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
        meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
    transport.command = async (command, args = {}) => {
        if (command === 'get_mesh') return { success: true, mesh };
        if (command === 'get_pending_mesh_events') return { events: [] };
        // The worker's session state is what it pushed to the coordinator (held runtime).
        if (command === 'mesh_status') {
            return { success: true, nodes: [{ nodeId: NODE_REMOTE, heldRuntime: { source: 'member_push', observedAt: Date.now(), refreshing: false, sessions: [agySession] } }] };
        }
        if (isTurnIpcCommand(command)) return answerTurnIpc(command, args);
        throw new Error(`unexpected local command: ${command}`);
    };
    transport.meshCommand = async (_daemonId, command, args = {}) => {
        if (command === 'agent_command') {
            agentCommands.push(args);
            return { success: true, sessionId: AGY_SESSION };
        }
        throw new Error(`unexpected mesh command: ${command}`);
    };
    return {
        agentCommands,
        ctx: { mesh, transport, localDaemonId: COORDINATOR_DAEMON, localMachineId: 'machine-coordinator', coordinatorSessionId: 'sess-coord' } as any,
    };
}

test('direct dispatch to a named antigravity-cli session reports providerType antigravity-cli, not providerPriority[0]', async () => {
    const meshId = `mesh-reported-provider-${randomUUID().slice(0, 8)}`;
    const ledger = armTestTurnLedger(COORDINATOR_DAEMON);
    try {
        const { ctx, agentCommands } = makeCtx(meshId);
        const res = JSON.parse(await meshSendTask(ctx, {
            node_id: NODE_REMOTE,
            session_id: AGY_SESSION,
            message: 'task for the agy session',
            difficulty: 'easy',
        } as any));
        assert.equal(res.success, true, JSON.stringify(res));
        assert.equal(res.sessionId, AGY_SESSION);
        assert.equal(res.providerType, 'antigravity-cli');
        assert.equal(agentCommands.length, 1);
        assert.equal(agentCommands[0].targetSessionId, AGY_SESSION);
        assert.equal(agentCommands[0].agentType, 'antigravity-cli', 'the command names the session\'s real provider too');
    } finally {
        ledger.dispose();
    }
});
