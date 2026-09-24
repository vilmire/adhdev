import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { getActiveTurnLedger } from '@adhdev/daemon-core';
import type { TurnEvidence } from '@adhdev/mesh-shared';
import { IpcTransport } from '../src/transports/ipc.js';
import { meshSendTask } from '../src/tools/mesh-tools.js';
import { armTestTurnLedger, answerTurnIpc, isTurnIpcCommand } from './helpers/turn-ledger-ipc.js';

/**
 * Capture every evidence submitted to the armed ledger during the test, by
 * wrapping `observe` — more direct than re-deriving the mesh_direct attempt id
 * after the fact (a `mesh_direct` scope's `dispatch_failed` COMMITS the attempt
 * terminal rather than reclaiming it — see transitions.ts's R24 special-case at
 * `attempt.scope === 'mesh_direct'` — so it is not "open" for `listOpenAttempts`
 * once the dispatch has failed).
 */
function captureObservedEvidence(): { evidence: TurnEvidence[]; dispose(): void } {
    const ledger = getActiveTurnLedger()!;
    const evidence: TurnEvidence[] = [];
    const original = ledger.observe.bind(ledger);
    (ledger as any).observe = (ev: TurnEvidence, opts?: unknown) => {
        evidence.push(ev);
        return original(ev, opts as any);
    };
    return { evidence, dispose: () => { (ledger as any).observe = original; } };
}

/**
 * Live-gap fix (2026-09-25, preview rc.45 run 14): a direct dispatch refused by
 * the worker daemon used to record `dispatch_failed` evidence carrying ONLY
 * `{workerAbsent:false, reason:'rejected_by_worker'}` — the worker's actual
 * refusal code (session_busy_with_task / mesh_sender_not_on_roster / …) and
 * message were dropped entirely, so the coordinator could see THAT the worker
 * refused but never WHY.
 *
 * Fix (mesh-tools-session.ts observeDirectDispatchOutcome + its call site):
 *   1. the worker's `{success:false, code, error}` answer (already spread onto
 *      RemoteAgentDispatchResult by ipcDispatchToRemoteAgent, mesh-tools-internal.ts)
 *      is read at the call site and threaded into observeDirectDispatchOutcome.
 *   2. `dispatch_failed` evidence gets an optional `refusalCode` — sanitized to
 *      `[a-z_]{1,64}` (sanitizeRefusalCode, @adhdev/mesh-shared) — NEVER a free-text
 *      detail: evidence replicates cross-machine over `mesh.<id>.events` and must
 *      stay content-free by construction (turn-evidence.ts).
 *   3. the human-readable detail stays LOCAL: one `process.stderr.write` WARN line
 *      naming `<node>`, the code, and the (200-char-capped) detail — never sent as
 *      evidence.
 *   4. a genuine transport failure (thrown error, no structured worker answer)
 *      keeps today's behavior: reason stays classified from the message text,
 *      no refusalCode is attached.
 */

const NODE_REMOTE = 'node-remote';
const COORDINATOR_DAEMON = 'daemon-coordinator';
const WORKER_DAEMON = 'daemon-remote-worker';

function remoteIdleSessionMesh(meshId: string) {
    const idleSession = {
        id: 'sess-remote-idle',
        providerType: 'claude-cli',
        status: 'idle',
        settings: {
            meshNodeFor: meshId,
            meshNodeId: NODE_REMOTE,
            // Relay-safe: carries a coordinator daemon anchor already (hasRemoteRelayMetadata).
            meshCoordinatorDaemonId: COORDINATOR_DAEMON,
        },
    };
    const mesh = {
        id: meshId,
        name: 'Direct Dispatch Refusal Evidence',
        repoIdentity: 'example/repo',
        policy: {},
        coordinator: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        nodes: [{
            id: NODE_REMOTE,
            workspace: '/tmp/remote-repo',
            repoRoot: '/tmp/remote-repo',
            // A daemonId distinct from the coordinator's own → isLocalControlPlaneNode
            // is false, routing meshSendTask down the remote (`p2p_direct`) branch.
            daemonId: WORKER_DAEMON,
            machineId: 'machine-remote-worker',
            userOverrides: {},
            policy: { providerPriority: ['claude-cli'] },
            sessions: [idleSession],
        }],
    };
    return { mesh, idleSession };
}

function makeCtx(
    meshId: string,
    buildMeshCommandImpl: (idleSession: Record<string, unknown>) => (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>,
) {
    const { mesh, idleSession } = remoteIdleSessionMesh(meshId);
    const transport = new IpcTransport() as IpcTransport & {
        command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
        meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
    transport.command = async (command, args = {}) => {
        if (command === 'get_mesh') return { success: true, mesh };
        if (command === 'get_pending_mesh_events') return { events: [] };
        if (command === 'get_status_metadata') return { success: true, status: { sessions: [idleSession] } };
        if (isTurnIpcCommand(command)) return answerTurnIpc(command, args);
        throw new Error(`unexpected local command: ${command}`);
    };
    transport.meshCommand = buildMeshCommandImpl(idleSession);
    return {
        mesh, idleSession,
        ctx: {
            mesh, transport, localDaemonId: COORDINATOR_DAEMON, localMachineId: 'machine-coordinator',
            coordinatorSessionId: 'sess-coord',
        } as any,
    };
}

async function sendUntargetedTask(ctx: any) {
    return JSON.parse(await meshSendTask(ctx, {
        node_id: NODE_REMOTE,
        message: 'do the thing on MainPC',
        difficulty: 'medium',
    } as any));
}

test('a worker refusal ({success:false, code, error}) records refusalCode evidence and a local WARN, never workerAbsent', async () => {
    const meshId = `mesh-direct-refusal-${randomUUID().slice(0, 8)}`;
    const ledger = armTestTurnLedger(COORDINATOR_DAEMON);
    const capture = captureObservedEvidence();
    const warnLines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as any) = (chunk: any, ...rest: any[]) => {
        warnLines.push(String(chunk));
        return originalWrite(chunk, ...rest);
    };
    try {
        const { ctx } = makeCtx(meshId, (idleSession) => async (_daemonId, command) => {
            // Sessionless auto-pick (chooseDispatchableSession) calls get_status_metadata
            // on the remote node BEFORE the send to find an idle delegate.
            if (command === 'get_status_metadata') return { success: true, status: { sessions: [idleSession] } };
            if (command === 'agent_command') {
                // The worker daemon reached the session but refused the injection —
                // an application-level answer, never a throw (mirrors cli-manager.ts /
                // mesh-sender.ts's real refusal shape).
                return {
                    success: false,
                    code: 'session_busy_with_task',
                    error: 'Session sess-remote-idle is still running task t-999',
                };
            }
            throw new Error(`unexpected mesh command: ${command}`);
        });

        const res = await sendUntargetedTask(ctx);
        assert.equal(res.success, false);
        assert.equal(res.code, 'session_busy_with_task', 'the worker refusal code surfaces verbatim in the tool result (already-existing behavior)');

        // ★ THE FIX: dispatch_failed evidence carries the refusal code, not just
        // {workerAbsent:false, reason:'rejected_by_worker'} with nothing else.
        const evidence = capture.evidence.find((e) => e.kind === 'dispatch_failed');
        assert.ok(evidence, 'a dispatch_failed evidence was submitted to the ledger');
        assert.equal(evidence!.workerAbsent, false, 'the worker WAS reached and answered — never workerAbsent');
        assert.equal(evidence!.reason, 'rejected_by_worker');
        assert.equal((evidence as any).refusalCode, 'session_busy_with_task', 'the worker refusal code is preserved (sanitized) on the evidence');
        // Content boundary: the free-text detail must NEVER appear on evidence.
        assert.equal(JSON.stringify(evidence).includes('still running task'), false, 'no free text on the replicated evidence');

        // (4) one local WARN line naming the node + code + detail — never sent as evidence.
        const warnLine = warnLines.find(l => l.includes('refused by worker'));
        assert.ok(warnLine, 'a WARN line was emitted for the refusal');
        assert.match(warnLine!, /node-remote/);
        assert.match(warnLine!, /session_busy_with_task/);
        assert.match(warnLine!, /still running task t-999/);
    } finally {
        process.stderr.write = originalWrite;
        capture.dispose();
        ledger.dispose();
    }
});

test('a thrown transport error keeps today\'s classification: no refusalCode, reason stays transport-classified', async () => {
    const meshId = `mesh-direct-transport-fail-${randomUUID().slice(0, 8)}`;
    const ledger = armTestTurnLedger(COORDINATOR_DAEMON);
    const capture = captureObservedEvidence();
    try {
        const { ctx } = makeCtx(meshId, (idleSession) => async (_daemonId, command) => {
            if (command === 'get_status_metadata') return { success: true, status: { sessions: [idleSession] } };
            if (command === 'agent_command') {
                // A genuine transport failure: the peer was never reached at all — no
                // structured application answer, just a thrown error.
                throw new Error('daemon_mesh_p2p_transport_unavailable: no open datachannel to daemon-remote-worker');
            }
            throw new Error(`unexpected mesh command: ${command}`);
        });

        const res = await sendUntargetedTask(ctx);
        assert.equal(res.success, false);

        const evidence = capture.evidence.find((e) => e.kind === 'dispatch_failed');
        assert.ok(evidence, 'a dispatch_failed evidence was submitted to the ledger');
        assert.equal(evidence!.reason, 'rejected_by_worker', 'observeDirectDispatchOutcome always books a direct-dispatch failure as rejected_by_worker (its call site does not classify transport-vs-application)');
        assert.equal((evidence as any).refusalCode, undefined, 'no worker answer ⇒ no refusalCode — a thrown transport error must not synthesize one');
    } finally {
        capture.dispose();
        ledger.dispose();
    }
});
