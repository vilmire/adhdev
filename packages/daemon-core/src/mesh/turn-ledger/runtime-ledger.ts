// ---------------------------------------------------------------------------
// turn-ledger/runtime-ledger — the production wiring of createTurnLedger
// ---------------------------------------------------------------------------
// Binds the pure ledger (ledger.ts) to this daemon's MeshRuntimeStore handle,
// the queue/graph effect host (mesh-work-queue + the graph transition runner),
// the mesh publisher, and the default post-commit executors that live in
// mesh/ (worker-bind revoke, graph drain). The session-side executors
// (cancel/withdraw, attempt-ref release, redeliver, bus, probe) are host-owned
// and passed in by the boot stage that constructs the ledger (C-W3/C-W5).
//
// Kept out of ledger.ts so the reducer/store/effects unit tests do not load the
// whole mesh runtime graph.
// ---------------------------------------------------------------------------

import { MeshRuntimeStore } from '../mesh-runtime-store.js';
import { applyTaskTerminalInTxn, afterTaskTerminalCommitted } from '../mesh-graph-transition-runner.js';
import { propagateLedgerDependencyFailure, requeueTaskForLedgerReclaim } from '../mesh-work-queue.js';
import {
    findWorkerTaskTokenForSession,
    revokeWorkerSessionBindsForSession,
    revokeWorkerTaskToken,
} from '../worker-mcp-isolation.js';
import { publishMeshTopicEntry } from '../../seqscribe/mesh-publisher.js';
import { LOG } from '../../logging/logger.js';
import { resolveTurnPolicy, type TurnPolicy } from './policy.js';
import { createTurnLedger, type TurnLedger, type TurnPublisherPort } from './ledger.js';
import type { CancelDispatchRequest, TurnLedgerPorts, TurnTxnHost } from './effects.js';

/** mesh_queue / graph writes inside the ledger txn (C2: queue status is an effect of a commit). */
export const meshRuntimeTxnHost: TurnTxnHost = {
    requeue(effect, ctx) {
        requeueTaskForLedgerReclaim(effect.meshId, effect.taskId, effect.reason, new Date(ctx.nowMs).toISOString());
    },
    graphAdvance(effect, ctx) {
        const result = applyTaskTerminalInTxn({
            meshId: effect.meshId,
            taskId: effect.taskId,
            status: effect.outcome,
            sessionId: ctx.attempt.sessionId,
            attemptId: ctx.attempt.attemptId,
            attemptNo: ctx.attempt.attemptNo,
            occurredAtMs: ctx.attempt.terminal?.at ?? ctx.nowMs,
            ...(ctx.attempt.terminal ? { reason: ctx.attempt.terminal.reason } : {}),
            ...(ctx.envelope ? { envelope: ctx.envelope } : {}),
        });
        if (result.transitioned) propagateLedgerDependencyFailure(effect.meshId, effect.taskId, effect.outcome);
        return { transitioned: result.transitioned };
    },
};

/**
 * Worker-bind revoke for a cut generation: every session bind naming the cut
 * session, plus the task tokens minted for (task, session). Bounded loop: a
 * token without a session binding is never revoked here (the task's other
 * generations may still hold it).
 */
export function revokeCutSessionWorkerBind(request: CancelDispatchRequest): void {
    revokeWorkerSessionBindsForSession(request.sessionId);
    if (!request.meshId || !request.taskId) return;
    for (let guard = 0; guard < 16; guard++) {
        const token = findWorkerTaskTokenForSession(request.meshId, request.taskId, request.sessionId);
        if (!token || token.sessionId !== request.sessionId) return;
        revokeWorkerTaskToken(token.token);
    }
}

export const meshRuntimePublisher: TurnPublisherPort = {
    async publish(meshId, entry, opts) {
        const [, writer, seq] = await publishMeshTopicEntry(meshId, entry, opts ?? {});
        return { writer, seq };
    },
};

export interface MeshRuntimeTurnLedgerOptions {
    selfDaemonId: string;
    policy?: TurnPolicy;
    /** Host-owned executors (cancel/withdraw, release, redeliver, bus, probe). */
    ports?: TurnLedgerPorts;
    publisher?: TurnPublisherPort | null;
    now?: () => number;
}

/** The daemon's ledger over mesh-runtime.db. Boot constructs ONE and passes it by value (no module slot). */
export function createMeshRuntimeTurnLedger(options: MeshRuntimeTurnLedgerOptions): TurnLedger {
    const store = MeshRuntimeStore.getInstance();
    return createTurnLedger({
        db: store.db,
        store: store.turnStore(),
        selfDaemonId: options.selfDaemonId,
        policy: options.policy ?? resolveTurnPolicy(process.env),
        host: meshRuntimeTxnHost,
        publisher: options.publisher === undefined ? meshRuntimePublisher : options.publisher,
        ports: {
            revokeWorkerBind: revokeCutSessionWorkerBind,
            afterTaskTerminal: afterTaskTerminalCommitted,
            ...options.ports,
        },
        ...(options.now ? { now: options.now } : {}),
        log: {
            info: (m) => LOG.info('TurnLedger', m),
            warn: (m) => LOG.warn('TurnLedger', m),
            error: (m) => LOG.error('TurnLedger', m),
        },
    });
}
