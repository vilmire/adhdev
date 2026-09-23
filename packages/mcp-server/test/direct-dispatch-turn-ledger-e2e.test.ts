import assert from 'node:assert/strict';
import test from 'node:test';

import { randomUUID } from 'node:crypto';

import { createMeshRuntimeTurnLedger } from '@adhdev/daemon-core';
import { MeshRuntimeStore } from '../../daemon-core/src/mesh/mesh-runtime-store.js';
import { setActiveTurnLedgerForIpc } from '../../daemon-core/src/commands/low-family/turn-ledger-ipc.js';
import { turnLedgerIpcHandlers } from '../../daemon-core/src/commands/low-family/turn-ledger-ipc.js';
import type { LowFamilyContext } from '../../daemon-core/src/commands/low-family/types.js';
import { makeFakeTurnIpcTransport } from './fake-turn-ipc-transport.js';
import { turnCancel, turnObserve, turnQuery } from '../src/ipc/turn-commands.js';
import { IpcTransport } from '../src/transports/ipc.js';
import { meshSendTask } from '../src/tools/mesh-tools.js';

/**
 * C-W6c: proves the direct-dispatch bug the C-W6b integration report flagged
 * ("mesh_send_task direct dispatch never opens an attempt in the new turn
 * ledger... a remote worker's forwarded evidence is rejected because it
 * carries no attempt reference") is fixed end to end at the IPC/ledger layer:
 *
 *   1. A dispatch opens a `mesh_direct` attempt via `turn_observe(dispatch_accepted)`
 *      — exactly what `openDirectDispatchAttempt` in mesh-tools-session.ts now
 *      calls BEFORE the transport send, so its attemptRef can be embedded in
 *      meshContext (see MeshCommandContext.attemptId/attemptGeneration,
 *      daemon-core's command-args.ts).
 *   2. The attemptRef returned is a REAL, resolvable attempt in the ledger
 *      (turn_query proves it — this is the exact object cli-manager.ts reads
 *      off meshContext and echoes onto the worker's own evidence).
 *   3. A "remote worker" submitting `worker_report` evidence STAMPED WITH
 *      THAT attemptRef (simulating what a forwarded completion now carries,
 *      per the meshContext threading) is ACCEPTED and commits the attempt —
 *      proving the "rejected because it carries no attempt reference" failure
 *      mode this fix addresses is gone.
 *   4. Evidence submitted WITHOUT an attemptRef (the pre-fix shape) still
 *      resolves via the taskId fallback (`resolveAttempt` in ledger.ts), so
 *      this fix is additive/never a regression for any caller that hasn't
 *      adopted the attemptRef yet.
 *
 * This is the real daemon-side ledger (`createMeshRuntimeTurnLedger`, the
 * exact factory boot calls), not a stub — `makeFakeTurnIpcTransport`'s
 * `turnLedgerIpcHandlers` read it through the same `setActiveTurnLedgerForIpc`
 * late-binding slot a live daemon uses (see turn-ledger-ipc.ts's file header).
 * `publisher: null` keeps `mesh.<id>.events` writes local/pending — no real
 * seqscribe node needed for this test to prove the reducer's own behavior.
 */

function cleanupMesh(meshId: string): void {
    try { MeshRuntimeStore.getInstance().clearMissionsForMesh(meshId); } catch { /* fresh store */ }
}

test('direct dispatch opens a resolvable mesh_direct attempt, and a worker completion carrying its attemptRef commits it', async () => {
    const meshId = `mesh-direct-dispatch-e2e-${randomUUID()}`;
    const selfDaemonId = 'daemon-coord-e2e';
    const ledger = createMeshRuntimeTurnLedger({ selfDaemonId, publisher: null });
    setActiveTurnLedgerForIpc(ledger);
    try {
        const transport = makeFakeTurnIpcTransport();
        const taskId = randomUUID();
        const sessionId = `session-${taskId}`;

        // Step 1: the coordinator's dispatch write path (mesh-tools-session.ts
        // openDirectDispatchAttempt) opens the attempt BEFORE the send.
        const accepted = await turnObserve(transport, {
            evidence: {
                eventId: taskId,
                at: Date.now(),
                source: 'dispatch',
                sessionId,
                taskId,
                observedBy: selfDaemonId,
                kind: 'dispatch_accepted',
                scope: 'mesh_direct',
                messageId: taskId,
                meshId,
                nodeId: 'node-worker',
                providerType: 'claude-code',
            },
        });
        assert.equal(accepted.verdict, 'applied');
        assert.ok(accepted.attemptRef.attemptId, 'a real attemptId was minted');
        assert.equal(accepted.attemptRef.generation, 0);

        // Step 2: the attemptRef is genuinely resolvable in the ledger — this is
        // what meshContext.attemptId/attemptGeneration carries to the worker.
        const afterAccept = await turnQuery(transport, { meshId, attemptId: accepted.attemptRef.attemptId });
        assert.equal(afterAccept.attempts.length, 1);
        assert.equal(afterAccept.attempts[0]!.state, 'accepted');
        assert.equal(afterAccept.attempts[0]!.taskId, taskId);

        // Step 3: record the delivery (openDirectDispatchAttempt's sibling call,
        // observeDirectDispatchOutcome, after the transport confirmed the send).
        const delivered = await turnObserve(transport, {
            evidence: {
                eventId: `${taskId}:delivered`,
                at: Date.now(),
                source: 'dispatch',
                sessionId,
                attemptRef: accepted.attemptRef,
                observedBy: selfDaemonId,
                kind: 'delivered',
                messageId: taskId,
                outcome: 'delivered',
                via: 'p2p',
            },
        });
        assert.equal(delivered.verdict, 'applied');

        const afterDelivered = await turnQuery(transport, { meshId, attemptId: accepted.attemptRef.attemptId });
        assert.equal(afterDelivered.attempts[0]!.state, 'delivered');

        // Step 4: THE BUG THIS FIXES — a remote worker's forwarded completion
        // evidence, carrying the attemptRef meshContext threaded onto it, is
        // ACCEPTED and commits the attempt (worker_report / R17, tool_report
        // strength). Before this fix, mesh_send_task never opened this attempt
        // at all, so a real worker's evidence had nothing to resolve to.
        const workerReport = await turnObserve(transport, {
            evidence: {
                eventId: `${taskId}:worker_report`,
                at: Date.now(),
                source: 'worker_tool',
                sessionId,
                attemptRef: accepted.attemptRef,
                observedBy: 'daemon-worker-e2e',
                kind: 'worker_report',
                outcome: 'completed',
                summary: { topic: `mesh.${meshId}.handoff`, writer: 'daemon-worker-e2e', seq: 1 },
                hasHandoffNotes: false,
            },
        });
        assert.equal(workerReport.verdict, 'applied');
        assert.equal(workerReport.outcome, 'completed');

        const afterCommit = await turnQuery(transport, { meshId, attemptId: accepted.attemptRef.attemptId });
        assert.equal(afterCommit.attempts[0]!.state, 'completed');
        assert.equal(afterCommit.attempts[0]!.terminalOutcome, 'completed');
        assert.equal(afterCommit.attempts[0]!.terminalReason, 'worker_reported');

        // Step 5 (non-regression): evidence with NO attemptRef, only taskId, still
        // resolves via the ledger's own taskId fallback (resolveAttempt in
        // ledger.ts) for a SEPARATE fresh attempt — callers that have not yet
        // adopted attemptRef threading are not broken by this change.
        const taskId2 = randomUUID();
        const sessionId2 = `session-${taskId2}`;
        const accepted2 = await turnObserve(transport, {
            evidence: {
                eventId: taskId2, at: Date.now(), source: 'dispatch', sessionId: sessionId2, taskId: taskId2,
                observedBy: selfDaemonId, kind: 'dispatch_accepted', scope: 'mesh_direct', messageId: taskId2, meshId,
            },
        });
        const cancelled = await turnCancel(transport, { taskId: taskId2, reason: 'operator_cancel' });
        assert.equal(cancelled.attemptRef.attemptId, accepted2.attemptRef.attemptId, 'taskId-only evidence resolved the SAME attempt dispatch_accepted opened');
    } finally {
        setActiveTurnLedgerForIpc(null);
        cleanupMesh(meshId);
    }
});

/**
 * C-W6c: proves the meshContext THREADING itself — that mesh_send_task's
 * local-direct arm actually embeds the attemptRef opened by
 * openDirectDispatchAttempt into the `agent_command` call's `meshContext`,
 * which is the field cli-manager.ts reads to bind a worker's own turn
 * evidence (MeshCommandContext.attemptId/attemptGeneration, command-args.ts).
 * The other e2e test above proves the LEDGER mechanism works in isolation;
 * this one proves mesh-tools-session.ts actually wires it through the real
 * tool call, against a REAL armed ledger (not the "unavailable" fixture the
 * pre-existing mesh-worktree-flow.test.ts call-count test uses).
 */
test('mesh_send_task (local direct) embeds the new-ledger attemptRef in agent_command meshContext', async () => {
    const meshId = `mesh-direct-attempt-thread-${randomUUID()}`;
    const selfDaemonId = 'daemon-coord-thread';
    const ledger = createMeshRuntimeTurnLedger({ selfDaemonId, publisher: null });
    setActiveTurnLedgerForIpc(ledger);
    try {
        const emptyLowFamilyCtx: LowFamilyContext = { deps: {} as LowFamilyContext['deps'] };
        const idleSession: any = {
            id: 'sess-idle', providerType: 'claude-cli', status: 'idle',
            settings: { meshNodeFor: meshId, meshNodeId: 'node-local', meshCoordinatorDaemonId: selfDaemonId },
        };
        const mesh: any = {
            id: meshId, name: 'Attempt Thread', repoIdentity: 'example/repo', policy: {}, coordinator: {},
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            nodes: [{
                id: 'node-local', workspace: '/tmp/local-repo', repoRoot: '/tmp/local-repo',
                daemonId: selfDaemonId, machineId: 'machine-coordinator', userOverrides: {},
                policy: { providerPriority: ['claude-cli'] }, sessions: [idleSession],
            }],
        };
        const transport: any = new IpcTransport();
        const agentCommandCalls: Array<{ args: Record<string, unknown> }> = [];
        transport.command = async (command: string, args: Record<string, unknown> = {}) => {
            // Route turn-ipc commands through the REAL daemon-side handlers against
            // the REAL armed ledger (same pattern as makeFakeTurnIpcTransport, but
            // inlined here so this fixture can also answer get_mesh/agent_command).
            const turnHandler = turnLedgerIpcHandlers[command];
            if (turnHandler) return turnHandler(emptyLowFamilyCtx, args);
            if (command === 'get_mesh') return { success: true, mesh };
            if (command === 'get_pending_mesh_events') return { events: [] };
            if (command === 'get_status_metadata') return { success: true, status: { sessions: [idleSession] } };
            if (command === 'agent_command') {
                agentCommandCalls.push({ args });
                return { success: true };
            }
            throw new Error(`unexpected local command: ${command}`);
        };
        transport.meshCommand = async (_daemonId: string, command: string) => {
            throw new Error(`unexpected mesh command on local node: ${command}`);
        };
        const ctx: any = { mesh, transport, localDaemonId: selfDaemonId, coordinatorSessionId: 'sess-coord' };

        const res = JSON.parse(await meshSendTask(ctx, {
            node_id: 'node-local', session_id: 'sess-idle', message: 'thread the attempt ref', difficulty: 'medium',
        } as any));
        assert.equal(res.success, true);
        assert.equal(res.dispatched, true);

        assert.equal(agentCommandCalls.length, 1);
        const meshContext = agentCommandCalls[0]!.args.meshContext as Record<string, unknown>;
        assert.equal(typeof meshContext.attemptId, 'string', 'attemptId was threaded into meshContext from the pre-send turn_observe');
        assert.equal(meshContext.attemptGeneration, 0);
        assert.equal(meshContext.taskId, res.taskId);

        // And the attempt really is 'delivered' in the ledger by the time the tool
        // call returns (observeDirectDispatchOutcome ran after agent_command succeeded).
        const query = await turnQuery(transport, { meshId, attemptId: meshContext.attemptId as string });
        assert.equal(query.attempts.length, 1);
        assert.equal(query.attempts[0]!.state, 'delivered');
    } finally {
        setActiveTurnLedgerForIpc(null);
        cleanupMesh(meshId);
    }
});
