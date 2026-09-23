// ---------------------------------------------------------------------------
// turn-ledger/effects — reducer effects → (in-txn rows + host writes) and
// (post-commit executors)
// ---------------------------------------------------------------------------
// Wiring-unification C2 write path (C-W2). The reducer (reducer.ts) only
// DECIDES; this module turns its `TurnEffect[]` into:
//
//   1. `turn_events` rows written inside the ledger txn — the audit trail and,
//      for mesh scopes, the durable PUBLISH QUEUE (`publish_state='pending'`
//      rows carrying a content-free `MeshTopicEntry` in `payload_json.entry`);
//   2. `mesh_queue` / graph writes through a `TurnTxnHost` inside the SAME txn
//      (`queue_status`, `graph_advance`);
//   3. post-commit executors (`TurnLedgerPorts`) for everything that cannot be
//      transactional: bus emit, dispatch cancel + worker-bind revoke, attempt
//      ref release, redeliver, probe, and the graph's post-commit drain.
//
// Effect → store mapping (brief §4):
//   commit              → `committed` row (UNIQUE per attempt+generation: a
//                         second commit aborts the txn) + turn.committed entry
//   notify_coordinator  → `notify` row + turn.notify entry (+ append ref)
//   hold / release_hold → turn_holds (ledger.ts syncs the reducer's hold set)
//   reclaim             → `reclaim` row (audit)
//   cancel_dispatch     → `cancel_dispatch` row — THE in-txn record of the
//                         g−1 cut and its worker-bind revoke; executor post-commit
//   redeliver           → `redeliver` row; executor post-commit
//   record              → notes on the evidence row (no extra row)
//   release_attempt_ref → executor only
//   queue_status        → host: 'pending' = reclaim requeue; terminal = carried
//                         by graph_advance's step 3 (one runner call per commit)
//   graph_advance       → host: runner steps 2–8 in-txn, drain post-commit
//   bus                 → executor only
//   probe / reevaluate  → executor (probe port) / ledger re-observe
//
// Plain scope never publishes (C10-4): local-only rows, publish_state 'none'.
// ---------------------------------------------------------------------------

import {
    MESH_TOPIC_PROTOCOL_VERSION,
    projectTurnEvidenceEntry,
    type MeshTopicEntry,
    type NotifyKind,
    type SummaryRef,
    type TurnEvidence,
} from '@adhdev/mesh-shared';
import type { TurnEventInsert } from './store.js';
import type { TurnAttempt, TurnBusEvent, TurnEffect, TurnState } from './types.js';

export type CommitEffect = Extract<TurnEffect, { kind: 'commit' }>;
export type NotifyEffect = Extract<TurnEffect, { kind: 'notify_coordinator' }>;
export type CancelDispatchEffect = Extract<TurnEffect, { kind: 'cancel_dispatch' }>;
export type RedeliverEffect = Extract<TurnEffect, { kind: 'redeliver' }>;
export type QueueStatusEffect = Extract<TurnEffect, { kind: 'queue_status' }>;
export type GraphAdvanceEffect = Extract<TurnEffect, { kind: 'graph_advance' }>;

/** Local-only completion envelope a producer may attach (never published). */
export interface TurnCompletionEnvelope {
    workerResult?: unknown;
    finalSummary?: string;
    artifacts?: unknown;
    evidence?: unknown;
    nodeId?: string;
    providerType?: string;
    completedAt?: string;
}

/** In-txn writes outside the turn tables (mesh_queue, graph). */
export interface TurnTxnHost {
    /** `queue_status: 'pending'` (reclaim requeue). Terminal statuses arrive via graphAdvance. */
    requeue(e: QueueStatusEffect & { status: 'pending' }, ctx: TxnEffectContext): void;
    /** Runner steps 2–8 (output version, row flip, graph advance). Returns whether the row transitioned. */
    graphAdvance(e: GraphAdvanceEffect, ctx: TxnEffectContext): { transitioned: boolean };
}

export interface TxnEffectContext {
    attempt: TurnAttempt;
    evidence: TurnEvidence;
    nowMs: number;
    envelope?: TurnCompletionEnvelope;
}

/** A cancel the executor must carry out (local withdraw/stop or remote stop_cli). */
export interface CancelDispatchRequest {
    attemptId: string;
    generation: number;
    sessionId: string;
    messageId: string | null;
    meshId: string | null;
    taskId: string | null;
    nodeId: string | null;
    revokeBind: boolean;
}

/** Post-commit executors. Every port is optional: an absent port is a no-op + counter. */
export interface TurnLedgerPorts {
    /** B1 bus emit of a turn phase (C-W5 projects `committed` onto the wire). */
    bus?(event: TurnBusEvent, at: number): void;
    /** Local `SessionInputService.withdraw(messageId)` / `stop_cli`, or remote `dispatchMeshCommand(..., 'stop_cli')`. */
    cancelDispatch?(request: CancelDispatchRequest): void | Promise<void>;
    /** Worker-bind + task-token revoke for a cut session (default: worker-mcp-isolation). */
    revokeWorkerBind?(request: CancelDispatchRequest): void;
    /** The instance drops its `attemptRef` (C-W5). */
    releaseAttemptRef?(e: { attemptId: string; sessionId: string }): void;
    /** Same-generation resubmit of the dispatch messageId (D's SessionInputPort). */
    redeliver?(e: RedeliverEffect & { meshId: string | null; taskId: string | null; nodeId: string | null }): void | Promise<void>;
    /** Scheduler probe now (C-W4 probeDue). */
    probe?(e: { attemptId: string; sessionId: string; meshId: string | null; taskId: string | null }): void;
    /** Graph post-commit: token expiry, mailbox discard, outbox drain. */
    afterTaskTerminal?(meshId: string, taskId: string): void;
}

// ─── row + entry construction ─────────────────────────────────────────────

export function isPublishableAttempt(attempt: TurnAttempt | null): attempt is TurnAttempt & { meshId: string } {
    return !!attempt && attempt.scope !== 'plain' && typeof attempt.meshId === 'string' && attempt.meshId.length > 0;
}

const TERMINAL_NOTIFY: ReadonlySet<NotifyKind> = new Set<NotifyKind>(['completed', 'failed', 'cancelled', 'stopped']);

export function commitEventId(evidenceEventId: string): string {
    return `${evidenceEventId}#committed`;
}

export function notifyEventId(evidenceEventId: string, notify: NotifyKind): string {
    return `${evidenceEventId}#notify:${notify}`;
}

export function buildCommittedEntry(effect: CommitEffect, attempt: TurnAttempt, eventId: string, at: number): Extract<MeshTopicEntry, { k: 'turn.committed' }> {
    return {
        v: MESH_TOPIC_PROTOCOL_VERSION,
        eventId,
        at,
        k: 'turn.committed',
        attemptId: effect.attemptId,
        generation: effect.generation,
        ...(attempt.taskId ? { taskId: attempt.taskId } : {}),
        outcome: effect.outcome,
        strength: effect.strength,
        reason: effect.reason,
    };
}

export function buildNotifyEntry(effect: NotifyEffect, attempt: TurnAttempt, eventId: string, at: number): Extract<MeshTopicEntry, { k: 'turn.notify' }> {
    return {
        v: MESH_TOPIC_PROTOCOL_VERSION,
        eventId,
        at,
        k: 'turn.notify',
        attemptId: effect.attemptId,
        notify: effect.notify,
        targetDaemonId: effect.coordinatorDaemonId ?? attempt.ownerDaemonId,
        ...(effect.coordinatorSessionId ? { targetSessionId: effect.coordinatorSessionId } : {}),
        ...(effect.taskId ? { taskId: effect.taskId } : {}),
    };
}

/** Worker side: evidence for an attempt another daemon owns (verdict `forwarded`). */
export function buildForwardedEvidenceEntry(
    evidence: TurnEvidence,
    target: { attemptId: string; generation: number; ownerDaemonId: string },
): Extract<MeshTopicEntry, { k: 'turn.evidence' }> {
    return projectTurnEvidenceEntry(evidence, target);
}

function refOf(summary: SummaryRef | undefined): { ref: SummaryRef } | Record<string, never> {
    return summary ? { ref: summary } : {};
}

export interface EffectRowsInput {
    evidence: TurnEvidence;
    /** Attempt AFTER the reduce step (null only for lane-none records). */
    attempt: TurnAttempt | null;
    effects: readonly TurnEffect[];
    nowMs: number;
    observedBy: string;
}

/**
 * The derived `turn_events` rows of one reduce step (the evidence row itself is
 * written by ledger.ts). Deterministic ids from the evidence eventId, so a
 * replayed observe collapses on the PK.
 */
export function effectEventRows(input: EffectRowsInput): TurnEventInsert[] {
    const { evidence, attempt, effects, nowMs, observedBy } = input;
    if (!attempt) return [];
    const publishable = isPublishableAttempt(attempt);
    const meshId = attempt.meshId;
    const base = {
        meshId,
        attemptId: attempt.attemptId,
        source: evidence.source,
        verdict: 'applied' as const,
        observedBy,
        atMs: evidence.at,
        recordedAt: nowMs,
    };
    const rows: TurnEventInsert[] = [];
    for (const effect of effects) {
        switch (effect.kind) {
            case 'commit': {
                const eventId = commitEventId(evidence.eventId);
                const entry = publishable ? buildCommittedEntry(effect, attempt, eventId, evidence.at) : undefined;
                rows.push({
                    ...base,
                    eventId,
                    generation: effect.generation,
                    sessionId: attempt.sessionId,
                    kind: 'committed',
                    dedupeKey: '',
                    toState: effect.outcome,
                    payload: { ...(meshId ? { meshId } : {}), outcome: effect.outcome, strength: effect.strength, reason: effect.reason, ...(entry ? { entry } : {}), ...refOf(effect.summary) },
                    publishState: publishable ? 'pending' : 'none',
                });
                break;
            }
            case 'notify_coordinator': {
                if (!publishable) break;
                const eventId = notifyEventId(evidence.eventId, effect.notify);
                const entry = buildNotifyEntry(effect, attempt, eventId, evidence.at);
                rows.push({
                    ...base,
                    eventId,
                    generation: effect.generation,
                    sessionId: attempt.sessionId,
                    kind: 'notify',
                    // One terminal notice per generation; repeatable notices are keyed by their cause.
                    dedupeKey: TERMINAL_NOTIFY.has(effect.notify) ? effect.notify : `${effect.notify}:${evidence.eventId}`,
                    payload: { meshId, notify: effect.notify, entry, ...refOf(effect.summary) },
                    publishState: 'pending',
                });
                break;
            }
            case 'reclaim':
                rows.push({
                    ...base,
                    eventId: `${evidence.eventId}#reclaim`,
                    generation: effect.toGeneration,
                    sessionId: attempt.sessionId,
                    kind: 'reclaim',
                    dedupeKey: `${effect.fromGeneration}->${effect.toGeneration}`,
                    payload: { ...(meshId ? { meshId } : {}), fromGeneration: effect.fromGeneration, toGeneration: effect.toGeneration, reason: effect.reason },
                    publishState: 'none',
                });
                break;
            case 'cancel_dispatch':
                rows.push({
                    ...base,
                    eventId: `${evidence.eventId}#cancel:${effect.generation}:${effect.sessionId}`,
                    generation: effect.generation,
                    sessionId: effect.sessionId,
                    kind: 'cancel_dispatch',
                    dedupeKey: `${effect.sessionId}:${evidence.eventId}`,
                    payload: {
                        ...(meshId ? { meshId } : {}),
                        messageId: effect.messageId ?? null,
                        revokeBind: effect.revokeBind === true,
                    },
                    publishState: 'none',
                });
                break;
            case 'redeliver':
                rows.push({
                    ...base,
                    eventId: `${evidence.eventId}#redeliver`,
                    generation: effect.generation,
                    sessionId: effect.sessionId,
                    kind: 'redeliver',
                    dedupeKey: evidence.eventId,
                    payload: { ...(meshId ? { meshId } : {}), messageId: effect.messageId },
                    publishState: 'none',
                });
                break;
            default:
                break;
        }
    }
    return rows;
}

/** Record notes carried by `record` effects (stored on the evidence row). */
export function recordNotes(effects: readonly TurnEffect[]): string[] {
    return effects.filter((e): e is Extract<TurnEffect, { kind: 'record' }> => e.kind === 'record').map((e) => e.note);
}

// ─── in-txn host effects ─────────────────────────────────────────────────

export interface TxnHostResult {
    /** Tasks whose queue row transitioned to terminal in this txn (post-commit drain targets). */
    terminalTasks: Array<{ meshId: string; taskId: string }>;
}

export function applyHostEffects(host: TurnTxnHost | null, effects: readonly TurnEffect[], ctx: TxnEffectContext): TxnHostResult {
    const terminalTasks: TxnHostResult['terminalTasks'] = [];
    if (!host) return { terminalTasks };
    for (const effect of effects) {
        if (effect.kind === 'queue_status' && effect.status === 'pending') {
            host.requeue(effect as QueueStatusEffect & { status: 'pending' }, ctx);
        } else if (effect.kind === 'graph_advance') {
            const { transitioned } = host.graphAdvance(effect, ctx);
            if (transitioned) terminalTasks.push({ meshId: effect.meshId, taskId: effect.taskId });
        }
    }
    return { terminalTasks };
}

// ─── post-commit executors ───────────────────────────────────────────────

export interface PostCommitCounters {
    executed: number;
    missingPort: number;
    failed: number;
}

export interface PostCommitContext {
    attempt: TurnAttempt | null;
    nowMs: number;
    terminalTasks: TxnHostResult['terminalTasks'];
    onError(effect: TurnEffect['kind'], error: unknown): void;
}

function cancelRequest(effect: CancelDispatchEffect, attempt: TurnAttempt | null): CancelDispatchRequest {
    return {
        attemptId: effect.attemptId,
        generation: effect.generation,
        sessionId: effect.sessionId,
        messageId: effect.messageId ?? null,
        meshId: attempt?.meshId ?? null,
        taskId: attempt?.taskId ?? null,
        nodeId: attempt?.nodeId ?? null,
        revokeBind: effect.revokeBind === true,
    };
}

/**
 * Run the non-transactional half of a committed step. Never throws: a failing
 * executor is reported through `ctx.onError` and counted — the ledger state it
 * follows is already durable, and every executor is idempotent or bounded
 * (cancel/revoke/release/redeliver are keyed by messageId/session).
 */
export function runPostCommitEffects(ports: TurnLedgerPorts, effects: readonly TurnEffect[], ctx: PostCommitContext): PostCommitCounters {
    const counters: PostCommitCounters = { executed: 0, missingPort: 0, failed: 0 };
    const run = (kind: TurnEffect['kind'], fn: (() => unknown) | undefined): void => {
        if (!fn) { counters.missingPort++; return; }
        try {
            const result = fn();
            if (result && typeof (result as Promise<unknown>).then === 'function') {
                (result as Promise<unknown>).then(undefined, (error: unknown) => { counters.failed++; ctx.onError(kind, error); });
            }
            counters.executed++;
        } catch (error) {
            counters.failed++;
            ctx.onError(kind, error);
        }
    };
    const attempt = ctx.attempt;
    for (const effect of effects) {
        switch (effect.kind) {
            case 'bus':
                run('bus', ports.bus ? () => ports.bus!(effect.event, ctx.nowMs) : undefined);
                break;
            case 'cancel_dispatch': {
                const request = cancelRequest(effect, attempt);
                // Revoke first: the cut worker must not report through the MCP in the
                // window before its cancel lands.
                if (request.revokeBind) run('cancel_dispatch', ports.revokeWorkerBind ? () => ports.revokeWorkerBind!(request) : undefined);
                run('cancel_dispatch', ports.cancelDispatch ? () => ports.cancelDispatch!(request) : undefined);
                break;
            }
            case 'release_attempt_ref':
                run('release_attempt_ref', ports.releaseAttemptRef ? () => ports.releaseAttemptRef!({ attemptId: effect.attemptId, sessionId: effect.sessionId }) : undefined);
                break;
            case 'redeliver':
                run('redeliver', ports.redeliver ? () => ports.redeliver!({ ...effect, meshId: attempt?.meshId ?? null, taskId: attempt?.taskId ?? null, nodeId: attempt?.nodeId ?? null }) : undefined);
                break;
            case 'probe':
                run('probe', ports.probe ? () => ports.probe!({ attemptId: effect.attemptId, sessionId: effect.sessionId, meshId: attempt?.meshId ?? null, taskId: attempt?.taskId ?? null }) : undefined);
                break;
            default:
                break;
        }
    }
    for (const task of ctx.terminalTasks) {
        run('graph_advance', ports.afterTaskTerminal ? () => ports.afterTaskTerminal!(task.meshId, task.taskId) : undefined);
    }
    return counters;
}

/** States after which an attempt still owns a session (for the open-session constraint). */
export function isOpenState(state: TurnState): boolean {
    return state !== 'completed' && state !== 'failed' && state !== 'cancelled';
}
