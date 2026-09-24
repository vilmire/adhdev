import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshSendTask } from '../src/tools/mesh-tools.js';
import {
    getLedgerDir,
    getQueue,
    readLocalRecords,
    createMeshRuntimeTurnLedger,
    setActiveTurnLedgerForIpc,
    formatSessionBusyWithTaskToken,
} from '@adhdev/daemon-core';
import { __clearMeshQueueForTests } from '../../daemon-core/src/mesh/mesh-work-queue.js';
import { __clearLocalRecordsForTests } from '@adhdev/daemon-core';
import { __clearMeshPendingEventsForTests } from './helpers/pending-notices.js';
import { answerTurnIpc, isTurnIpcCommand, closeOpenTestAttempts } from './helpers/turn-ledger-ipc.js';

// preview rc.37 GAP 1 — `mesh_send_task --session_id` to a REMOTE node must pass the SAME
// busy-session admission gate the local branch applies. Before the fix the remote (P2P)
// branch only used the explicit session for relay-safety and sent
// `agent_command send_chat policy:queue` straight into a GENERATING worker: the body queued
// behind the running turn, executed as turn 2, and the worker's mesh stamp was overwritten.
//
// The node here carries a DISTINCT daemonId ('daemon-remote' vs the coordinator's
// 'daemon-coordinator'), so isLocalControlPlaneNode is false and meshSendTask takes the
// remote branch — every command to the node goes through transport.meshCommand.

const COORDINATOR = 'daemon-coordinator';
const REMOTE = 'daemon-remote';
const NODE = 'node-remote';
const SESSION = 'sess-remote';

function cleanupMesh(meshId: string): void {
    __clearMeshQueueForTests(meshId);
    __clearLocalRecordsForTests(meshId);
    __clearMeshPendingEventsForTests(meshId);
    const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
    for (const suffix of ['.jsonl', '.queue.json', '.queue.lock', '.pending-events.jsonl']) {
        const path = join(getLedgerDir(), `${safe}${suffix}`);
        if (existsSync(path)) unlinkSync(path);
    }
}

function createRemoteCtx(meshId: string, opts: {
    status: string;
    interruptSupported?: boolean;
    interruptSucceeds?: boolean;
    sendChatThrows?: string;
}) {
    const session = {
        id: SESSION,
        providerType: 'claude-cli',
        status: opts.status,
        settings: { meshNodeFor: meshId, meshNodeId: NODE, meshCoordinatorDaemonId: COORDINATOR, launchedByCoordinator: true },
    };
    const mesh = {
        id: meshId, name: 'Remote Busy Gate', repoIdentity: 'example/repo', policy: {}, coordinator: {},
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        nodes: [{
            id: NODE, workspace: '/tmp/remote-repo', repoRoot: '/tmp/remote-repo',
            daemonId: REMOTE, machineId: 'machine-remote', userOverrides: {},
            policy: { providerPriority: ['claude-cli'] }, sessions: [session],
        }],
    };
    const transport = new IpcTransport() as any;
    const turnCommands: Array<{ command: string; args: Record<string, unknown> }> = [];
    const remoteCommands: Array<{ command: string; args: Record<string, unknown> }> = [];
    transport.command = async (command: string, args: Record<string, unknown> = {}) => {
        if (isTurnIpcCommand(command)) {
            turnCommands.push({ command, args });
            return answerTurnIpc(command, args);
        }
        if (command === 'get_mesh') return { success: true, mesh };
        if (command === 'get_pending_mesh_events') return { events: [] };
        if (command === 'trigger_mesh_queue') return { success: true };
        throw new Error(`unexpected LOCAL command on a remote-node dispatch: ${command}`);
    };
    transport.meshCommand = async (daemonId: string, command: string, args: Record<string, unknown> = {}) => {
        assert.equal(daemonId, REMOTE);
        remoteCommands.push({ command, args });
        if (command === 'get_status_metadata') return { success: true, status: { sessions: [session] } };
        if (command === 'agent_command') {
            if (args.action === 'interrupt_capability') return { success: true, supported: opts.interruptSupported === true, confidence: 'declared' };
            if (args.action === 'interrupt_turn') return opts.interruptSucceeds === false
                ? { success: false, interrupted: false, reason: 'no_stop_key' }
                : { success: true, interrupted: true, keyName: 'Escape', confidence: 'declared' };
            if (args.action === 'send_chat') {
                if (opts.sendChatThrows) throw new Error(opts.sendChatThrows);
                return { success: true };
            }
        }
        throw new Error(`unexpected remote command: ${command}`);
    };
    const ctx = { mesh, transport, localDaemonId: COORDINATOR, localMachineId: 'machine-coordinator', coordinatorSessionId: 'sess-coord' } as any;
    const sendChats = () => remoteCommands.filter(c => c.command === 'agent_command' && c.args.action === 'send_chat');
    const dispatchAccepted = () => turnCommands.filter(c => c.command === 'turn_observe' && (c.args as any)?.evidence?.kind === 'dispatch_accepted'
        || c.command === 'turn_observe' && (c.args as any)?.kind === 'dispatch_accepted');
    return { ctx, remoteCommands, turnCommands, sendChats, dispatchAccepted };
}

function withLedger<T>(fn: () => Promise<T>): Promise<T> {
    const ledger = createMeshRuntimeTurnLedger({ selfDaemonId: COORDINATOR, publisher: null });
    setActiveTurnLedgerForIpc(ledger);
    return fn().finally(() => { closeOpenTestAttempts(); setActiveTurnLedgerForIpc(null); });
}

async function send(ctx: any, extra: Record<string, unknown> = {}) {
    return JSON.parse(await meshSendTask(ctx, {
        node_id: NODE, session_id: SESSION, message: 'second task body', difficulty: 'medium', ...extra,
    } as any));
}

test('remote BUSY session (when_idle) → queued_delivery; body NOT sent over P2P; no dispatch_accepted attempt; decision recorded', async () => {
    const meshId = `mesh-remote-busy-${randomUUID().slice(0, 8)}`;
    cleanupMesh(meshId);
    const h = createRemoteCtx(meshId, { status: 'generating' });
    try {
        await withLedger(async () => {
            const res = await send(h.ctx, { orchestration_decision: { decision: 'direct', direct_reason: 'same_subject_continuation' } });
            assert.equal(res.success, true, JSON.stringify(res));
            assert.equal(res.dispatched, false);
            assert.equal(res.decision, 'queued_delivery', 'same typed outcome the LOCAL branch returns');
            assert.equal(res.sessionStatus, 'generating');
            assert.equal(h.sendChats().length, 0, 'the body must never be sent into a generating remote session');
            assert.equal(h.dispatchAccepted().length, 0, 'no direct-dispatch attempt is opened for a queued delivery');
            const row = getQueue(meshId).find(t => t.id === res.taskId);
            assert.ok(row, 'the pinned queue row exists');
            assert.equal(row.status, 'pending');
            assert.equal(row.targetSessionId, SESSION);
            assert.equal(row.targetNodeId, NODE);
            // (B) the caller's orchestration decision survives the queue exit.
            const decisions = readLocalRecords(meshId, { kind: ['single_enqueue_decision'] } as any);
            assert.equal(decisions.length, 1, 'the queued exit records the caller decision');
            assert.equal((decisions[0] as any).payload?.taskId ?? (decisions[0] as any).taskId, res.taskId);
        });
    } finally {
        cleanupMesh(meshId);
    }
});

test('remote BUSY session + delivery_mode interrupt on a provider that cannot → interrupt_unsupported (no silent queue, no send)', async () => {
    const meshId = `mesh-remote-busy-int-${randomUUID().slice(0, 8)}`;
    cleanupMesh(meshId);
    const h = createRemoteCtx(meshId, { status: 'generating', interruptSupported: false });
    try {
        await withLedger(async () => {
            const res = await send(h.ctx, { delivery_mode: 'interrupt' });
            assert.equal(res.success, false, JSON.stringify(res));
            assert.equal(res.decision, 'interrupt_unsupported');
            assert.equal(h.sendChats().length, 0);
            assert.equal(h.remoteCommands.filter(c => c.args.action === 'interrupt_turn').length, 0);
            assert.equal(h.dispatchAccepted().length, 0);
            assert.equal(getQueue(meshId).length, 0, 'a rejected interrupt enqueues nothing');
        });
    } finally {
        cleanupMesh(meshId);
    }
});

test('remote BUSY session + delivery_mode interrupt on a capable provider → interrupt sent over P2P, task interrupted_and_queued', async () => {
    const meshId = `mesh-remote-busy-intok-${randomUUID().slice(0, 8)}`;
    cleanupMesh(meshId);
    const h = createRemoteCtx(meshId, { status: 'generating', interruptSupported: true });
    try {
        await withLedger(async () => {
            const res = await send(h.ctx, { delivery_mode: 'interrupt' });
            assert.equal(res.success, true, JSON.stringify(res));
            assert.equal(res.decision, 'interrupted_and_queued');
            assert.equal(h.remoteCommands.filter(c => c.args.action === 'interrupt_turn').length, 1);
            assert.equal(h.sendChats().length, 0, 'the body is delivered by the queue claim, not injected now');
            assert.equal(h.dispatchAccepted().length, 0);
        });
    } finally {
        cleanupMesh(meshId);
    }
});

test('remote IDLE session still dispatches directly (gate is a no-op), and an unrecognised delivery_mode is reported', async () => {
    const meshId = `mesh-remote-idle-${randomUUID().slice(0, 8)}`;
    cleanupMesh(meshId);
    const h = createRemoteCtx(meshId, { status: 'idle' });
    try {
        await withLedger(async () => {
            const res = await send(h.ctx, { delivery_mode: 'imediate' });
            assert.equal(res.success, true, JSON.stringify(res));
            assert.equal(res.dispatched, true);
            assert.equal(h.sendChats().length, 1);
            assert.equal(h.dispatchAccepted().length, 1, 'the idle direct dispatch opens its attempt (proves the probe sees dispatch_accepted)');
            assert.match(String(res.deliveryModeWarning || ''), /Unrecognized delivery_mode 'imediate'/);
        });
    } finally {
        cleanupMesh(meshId);
    }
});

test('worker-side session_busy_with_task refusal surfaces as a typed dispatch failure (not a relay outage)', async () => {
    const meshId = `mesh-remote-refused-${randomUUID().slice(0, 8)}`;
    cleanupMesh(meshId);
    // Status looked idle to the coordinator (stale snapshot) but the worker's stamp guard
    // saw it busy with another task and refused.
    const token = formatSessionBusyWithTaskToken({ currentTaskId: 'task-A', currentAttemptId: 'att-A' });
    const h = createRemoteCtx(meshId, { status: 'idle', sendChatThrows: `Refusing mesh dispatch: session ${SESSION} is busy running task task-A (${token}).` });
    try {
        await withLedger(async () => {
            const res = await send(h.ctx);
            assert.equal(res.success, false, JSON.stringify(res));
            assert.equal(res.dispatched, false);
            assert.equal(res.code, 'session_busy_with_task');
            assert.equal(res.currentTaskId, 'task-A');
            assert.equal(res.currentAttemptId, 'att-A');
            assert.equal(res.retryRecommended, false);
        });
    } finally {
        cleanupMesh(meshId);
    }
});

test('(B) untargeted mesh_send_task (queue pull) records the caller orchestration decision on the enqueue', async () => {
    const meshId = `mesh-untargeted-decision-${randomUUID().slice(0, 8)}`;
    cleanupMesh(meshId);
    const mesh = {
        id: meshId, name: 'Untargeted Decision', repoIdentity: 'example/repo', policy: {}, coordinator: {},
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        nodes: [{
            id: 'node-local', workspace: '/tmp/local-repo', repoRoot: '/tmp/local-repo',
            daemonId: COORDINATOR, machineId: 'machine-coordinator', userOverrides: {},
            policy: { providerPriority: ['claude-cli'] }, sessions: [],
        }],
    };
    const transport = new IpcTransport() as any;
    transport.command = async (command: string, args: Record<string, unknown> = {}) => {
        if (isTurnIpcCommand(command)) return answerTurnIpc(command, args);
        if (command === 'get_mesh') return { success: true, mesh };
        if (command === 'get_pending_mesh_events') return { events: [] };
        if (command === 'trigger_mesh_queue') return { success: true };
        if (command === 'get_status_metadata') return { success: true, status: { sessions: [] } };
        throw new Error(`unexpected local command: ${command}`);
    };
    transport.meshCommand = async (_d: string, command: string) => { throw new Error(`unexpected mesh command: ${command}`); };
    const ctx = { mesh, transport, localDaemonId: COORDINATOR, localMachineId: 'machine-coordinator', coordinatorSessionId: 'sess-coord' } as any;
    try {
        const res = JSON.parse(await meshSendTask(ctx, {
            node_id: 'node-local', message: 'untargeted work', difficulty: 'easy',
        } as any));
        assert.equal(res.success, true, JSON.stringify(res));
        assert.equal(res.source, 'queue');
        assert.equal(res.orchestrationDecisionMissing, true, 'an omitted decision is reported, not silently dropped');
        const decisions = readLocalRecords(meshId, { kind: ['single_enqueue_decision'] } as any);
        assert.equal(decisions.length, 1, 'the untargeted queue exit records the decision');
    } finally {
        cleanupMesh(meshId);
    }
});
