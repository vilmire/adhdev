import { randomUUID } from 'crypto';
import { MeshRuntimeStore, type MeshTurnAttemptRow, type MeshTurnHeldSuspensionRow } from './mesh-runtime-store.js';
import { LOG } from '../logging/logger.js';
import { sessionIdsEquivalent } from '@adhdev/mesh-shared';

/**
 * TURN-LEDGER (Stage 5) — the authoritative causal turn ledger/reducer for prompt
 * delivery ACKs and exactly-once logical completion.
 *
 * WHY THIS EXISTS (verified failures this module eliminates):
 *  - Prompt delivery previously relied on overlapping redrive/reconcile safety nets
 *    plus the monotonic `dispatchNonce`, with no durable attempt identity and no
 *    explicit accepted → delivered → consumed transaction. A reclaim could bump the
 *    nonce and re-dispatch to the SAME session; the resumed worker echoed the old
 *    nonce and the stale-nonce guard killed the CURRENT legitimate assignee.
 *  - Completion was inferred independently by PTY, transcript, status/idle, stall
 *    probes and provider events — several terminal writers racing one task, causing
 *    both early false completion and missed completion.
 *  - In-memory pending outbound/redrive state was lost on daemon restart.
 *  - A transcript evidence read raced a destructive stop (the 6ms stop/read race);
 *    teardown destroyed the only evidence source before the read completed.
 *
 * THE CONTRACT:
 *  - Every dispatch/redrive/provider event/completion proposal correlates to
 *    (meshId, taskId, attemptId, coordinator identity, worker session). `attemptId`
 *    is an opaque UUID, DISTINCT from taskId and the monotonic dispatchNonce; the
 *    attempt's `attemptSeq` carries the nonce ordering.
 *  - The SQLite MeshRuntimeStore tables (mesh_turn_attempts / mesh_turn_events /
 *    mesh_turn_outbox) are the ONE mutable source of truth for turn state. The JSONL
 *    / mesh_event_ledger writes elsewhere remain audit/export only — when they
 *    disagree with this ledger, this ledger wins.
 *  - Causal stages with monotonic, idempotent transitions:
 *      accepted → delivered → consumed → generating
 *      generating ⇄ waiting_approval / waiting_choice   (nonterminal suspension)
 *      consumed|generating|waiting_* → finalizing → completed|failed|cancelled
 *  - Evidence semantics:
 *      accepted  — the dispatch envelope was durably recorded for the target
 *                  daemon/session (attempt row committed at claim/dispatch time).
 *      delivered — the prompt/input submission reached the provider/PTY boundary
 *                  AND the durable delivery record was committed (transport confirm).
 *      consumed  — provider turn start (agent:generating_started) or unambiguous
 *                  transcript/native evidence proves the prompt belongs to the
 *                  ACTIVE attempt. After `consumed`, NO prompt reinjection is
 *                  permitted for the attempt, ever.
 *  - Transport stays at-least-once; LOGICAL prompt consumption and LOGICAL
 *    completion are exactly-once per attempt, enforced by durable idempotency keys
 *    (UNIQUE constraints) and conditional terminal-commit transactions. No network
 *    exactly-once claim is made.
 *  - All terminal outcomes flow through {@link proposeTurnCompletion}
 *    (CompletionProposal). The reducer validates attempt/session/epoch causality and
 *    commits AT MOST ONE terminal outcome per attempt. Late/duplicate proposals are
 *    recorded and rejected with a typed reason — they never re-complete, and a
 *    rejected proposal never re-injects a prompt.
 *  - `waiting_approval` / `waiting_choice` are nonterminal suspended states. `idle`
 *    is presentation evidence and never by itself a completion write. `finalizing`
 *    means terminal evidence is being reconciled/committed; it is exposed for the
 *    Stage 6 projection.
 *  - HELD SUSPENSIONS (ordering tolerance): a `waiting_approval`/`waiting_choice`
 *    edge may legitimately arrive BEFORE the consumed ACK (a fast picker fires
 *    ahead of the generating_started processing, whose attempt-resolution preamble
 *    defers the consumed write). The FSM rightly refuses accepted/delivered →
 *    waiting_*; instead of dropping the edge, the reducer persists a content-free
 *    hold row (mesh_turn_held_suspensions, keyed `<attemptId>:<stage>`) and the
 *    consumed commit applies it through the SAME FSM in the SAME transaction, so
 *    the projection exposes the full causal chain (… → consumed → generating →
 *    waiting_*) instead of skipping consumed. Holds are durable across restart
 *    (the reconcile drain re-applies eligible rows), idempotent under duplicate
 *    arrivals, and inert for stale/reassigned/terminal attempts (a terminal commit
 *    resolves held rows as dropped — a held picker never resurrects an attempt).
 *    A reordered `generating` echo that PREDATES an applied hold never regresses
 *    the suspension (event-time guard in recordTurnStage).
 *  - HELD-SUSPENSION RESTART CONTRACT: an unresolved hold scoped to the CURRENT
 *    attempt/session/dispatchNonce is durable causal evidence the prompt reached
 *    (was consumed by) the authoritative worker session, even when the weaker
 *    generating_started consumed ACK was lost to a crash. Across a daemon
 *    restart it BLOCKS delivered-not-consumed redrive/reclaim
 *    ({@link gateRedriveForHeldSuspension}): once the surviving session is
 *    confirmed rebound, the gate synthesizes the consumed link (audit source
 *    `held_suspension_recovery`) and atomically applies the hold through the
 *    same FSM — same attempt, no reinjection, and a later real consumed ACK is
 *    idempotent. A demonstrably dead session (the existing bounded liveness
 *    path) drops the hold (`session_dead`) so the reclaim can open a NEW
 *    attempt; stale/session-mismatch/nonce-mismatch/terminal holds never block
 *    and never resurrect.
 *
 * ROLLOUT (no flag day): tasks dispatched BEFORE this stage have no attempt row.
 * For those, {@link resolveAttemptForTask} lazily opens a deterministic legacy
 * attempt (id `legacy-<taskId>-<nonce>`, stage 'accepted') on first reducer touch —
 * it NEVER fabricates delivered/consumed/completed evidence, and the legacy writers
 * keep their prior behavior for such rows (shadow/compat mode). New dispatches are
 * reducer-authoritative from `accepted` on.
 */

// ─── Stages ─────────────────────────────────────────────────────────────────

export type TurnStage =
    | 'accepted'
    | 'delivered'
    | 'consumed'
    | 'generating'
    | 'waiting_approval'
    | 'waiting_choice'
    | 'finalizing'
    | 'completed'
    | 'failed'
    | 'cancelled';

export type TurnTerminalOutcome = Extract<TurnStage, 'completed' | 'failed' | 'cancelled'>;

export const TURN_TERMINAL_OUTCOMES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

/** Nonterminal ACK stages — the explicit delivery transaction. */
export type TurnAckKind = 'accepted' | 'delivered' | 'consumed';

/** Nonterminal lifecycle stages beyond the ACK chain. */
export type TurnProgressStage = 'generating' | 'waiting_approval' | 'waiting_choice' | 'finalizing';

const STAGE_RANK: Record<TurnStage, number> = {
    accepted: 10,
    delivered: 20,
    consumed: 30,
    generating: 40,
    waiting_approval: 45,
    waiting_choice: 45,
    finalizing: 50,
    completed: 60,
    failed: 60,
    cancelled: 60,
};

const SUSPENDED_STAGES: ReadonlySet<string> = new Set(['waiting_approval', 'waiting_choice']);

export function isTerminalTurnStage(stage: string): boolean {
    return TURN_TERMINAL_OUTCOMES.has(stage);
}

/**
 * The transition rules — the single place the causal FSM is defined. The store's
 * advanceTurnAttemptStage enforces the resulting `allowedFrom` whitelist inside the
 * SQL write, so no concurrent writer can regress the stage.
 */
function allowedFromStages(toStage: TurnStage): string[] {
    switch (toStage) {
        case 'accepted':
            return []; // 'accepted' is the insert state, never a transition target
        case 'delivered':
            return ['accepted', 'delivered'];
        case 'consumed':
            return ['accepted', 'delivered', 'consumed'];
        case 'generating':
            // consumed → generating, plus resume from a suspended state, and
            // idempotent re-arrival. NOT from accepted/delivered: a turn cannot
            // start before the prompt was consumed.
            return ['consumed', 'generating', 'waiting_approval', 'waiting_choice'];
        case 'waiting_approval':
        case 'waiting_choice':
            // Suspension only makes sense once the prompt is in the provider.
            return ['consumed', 'generating', 'waiting_approval', 'waiting_choice'];
        case 'finalizing':
            return ['consumed', 'generating', 'waiting_approval', 'waiting_choice', 'finalizing'];
        case 'completed':
        case 'failed':
        case 'cancelled':
            // Terminal commits go through commitTurnAttemptTerminal (exactly-once
            // conditional write), not this whitelist.
            return [];
    }
}

export function canTransitionTurnStage(from: TurnStage, to: TurnStage): boolean {
    if (from === to) return true; // idempotent
    if (isTerminalTurnStage(from)) return false;
    if (isTerminalTurnStage(to)) return true; // validated separately by the proposal path
    return allowedFromStages(to).includes(from);
}

// ─── Observability ──────────────────────────────────────────────────────────

/**
 * Structured, content-free counters. No prompt/transcript text and no secrets are
 * ever recorded — ids, stages, reasons and durations only.
 */
export interface TurnLedgerMetrics {
    /** A prompt (re)injection was refused because the attempt was already consumed. */
    duplicatePromptPrevented: number;
    /** ACK latency samples (accepted→delivered / delivered→consumed), count + total ms. */
    ackLatencyCount: number;
    ackLatencyTotalMs: number;
    /** Completion proposals rejected, keyed by typed reason. */
    completionProposalsRejected: Record<string, number>;
    /** Completion proposals committed (terminal transactions). */
    completionProposalsCommitted: number;
    /** Events that arrived against a non-current (old) attempt. */
    staleAttemptEvents: number;
    /** Terminal-commit races lost (the exactly-once guard doing its job). */
    transactionConflicts: number;
    /** Same-session echo of a pre-reclaim nonce accepted (NOT stopped). */
    sameSessionStaleNonceCompatAccepted: number;
    /** Duplicate causal events swallowed by the idempotency keys. */
    duplicateTurnEvents: number;
    /** Suspension edges (waiting_*) that arrived pre-consumed and were durably held. */
    suspensionsHeld: number;
    /** Held suspensions applied through the FSM once consumed became durable. */
    suspensionsApplied: number;
    /** Held suspensions dropped, keyed by typed reason (never an error by itself). */
    suspensionsDropped: Record<string, number>;
    /** Reordered generating echoes suppressed because they predate an applied hold. */
    reorderedGeneratingSuppressed: number;
    /**
     * Redrive/reclaim decisions suppressed because an unresolved CURRENT
     * attempt/session/epoch hold is durable evidence the prompt was consumed
     * (the session's liveness was not yet confirmed after a restart).
     */
    redriveBlockedBySuspension: number;
    /**
     * Consumed evidence synthesized from a valid held suspension at restart
     * (audit source `held_suspension_recovery`) once the surviving worker
     * session was confirmed rebound — the hold then applied through the FSM.
     */
    suspensionConsumedRecovered: number;
}

const metrics: TurnLedgerMetrics = {
    duplicatePromptPrevented: 0,
    ackLatencyCount: 0,
    ackLatencyTotalMs: 0,
    completionProposalsRejected: {},
    completionProposalsCommitted: 0,
    staleAttemptEvents: 0,
    transactionConflicts: 0,
    sameSessionStaleNonceCompatAccepted: 0,
    duplicateTurnEvents: 0,
    suspensionsHeld: 0,
    suspensionsApplied: 0,
    suspensionsDropped: {},
    reorderedGeneratingSuppressed: 0,
    redriveBlockedBySuspension: 0,
    suspensionConsumedRecovered: 0,
};

export function getTurnLedgerMetrics(nowMs: number = Date.now()): TurnLedgerMetrics & { outboxOldestPendingAgeMs: number | null; outboxByStatus: Record<string, number> } {
    let outboxOldestPendingAgeMs: number | null = null;
    let outboxByStatus: Record<string, number> = {};
    try {
        const store = MeshRuntimeStore.getInstance();
        outboxOldestPendingAgeMs = store.oldestPendingTurnOutboxAgeMs(nowMs);
        outboxByStatus = store.countTurnOutboxByStatus();
    } catch { /* store unavailable — report counters only */ }
    return {
        ...metrics,
        completionProposalsRejected: { ...metrics.completionProposalsRejected },
        suspensionsDropped: { ...metrics.suspensionsDropped },
        outboxOldestPendingAgeMs,
        outboxByStatus,
    };
}

export function __resetTurnLedgerMetricsForTests(): void {
    metrics.duplicatePromptPrevented = 0;
    metrics.ackLatencyCount = 0;
    metrics.ackLatencyTotalMs = 0;
    metrics.completionProposalsRejected = {};
    metrics.completionProposalsCommitted = 0;
    metrics.staleAttemptEvents = 0;
    metrics.transactionConflicts = 0;
    metrics.sameSessionStaleNonceCompatAccepted = 0;
    metrics.duplicateTurnEvents = 0;
    metrics.suspensionsHeld = 0;
    metrics.suspensionsApplied = 0;
    metrics.suspensionsDropped = {};
    metrics.reorderedGeneratingSuppressed = 0;
    metrics.redriveBlockedBySuspension = 0;
    metrics.suspensionConsumedRecovered = 0;
    suspensionLogKeys.clear();
}

function noteRejectedProposal(reason: CompletionRejectionReason): void {
    metrics.completionProposalsRejected[reason] = (metrics.completionProposalsRejected[reason] ?? 0) + 1;
}

function noteDroppedSuspension(reason: HeldSuspensionDropReason): void {
    metrics.suspensionsDropped[reason] = (metrics.suspensionsDropped[reason] ?? 0) + 1;
}

/**
 * Bounded first-occurrence logging for suspension hold/apply/drop/reorder events.
 * Expected defers are INFO (not errors); impossible causal rejections surface via
 * the typed counters above and the first-occurrence WARN sites. The key set is
 * capped so a pathological event storm cannot grow memory unboundedly — beyond the
 * cap the counters remain the observability channel.
 */
const MAX_SUSPENSION_LOG_KEYS = 200;
const suspensionLogKeys = new Set<string>();

function logSuspensionOnce(level: 'info' | 'warn', key: string, message: string): void {
    if (suspensionLogKeys.has(key)) return;
    if (suspensionLogKeys.size < MAX_SUSPENSION_LOG_KEYS) suspensionLogKeys.add(key);
    LOG[level]('TurnLedger', message);
}

function noteAckLatency(fromIso: string | null, nowMs: number): void {
    if (!fromIso) return;
    const parsed = Date.parse(fromIso);
    if (Number.isNaN(parsed) || nowMs < parsed) return;
    metrics.ackLatencyCount += 1;
    metrics.ackLatencyTotalMs += nowMs - parsed;
}

// ─── Attempt identity ───────────────────────────────────────────────────────

export interface OpenTurnAttemptArgs {
    meshId: string;
    taskId: string;
    /**
     * The dispatch nonce this attempt is opened under (the row's CURRENT
     * dispatchNonce AFTER the claim/reclaim bump). Used as attempt_seq so
     * reassignment (nonce bump) deterministically yields a new attempt and a
     * crash-retried open of the SAME dispatch is idempotent.
     */
    dispatchNonce: number;
    nodeId?: string;
    sessionId?: string;
    providerType?: string;
    coordinatorDaemonId?: string;
    coordinatorSessionId?: string;
    nowMs?: number;
}

export interface OpenTurnAttemptResult {
    attempt: MeshTurnAttemptRow;
    /** false when the attempt for this (task, nonce) already existed (idempotent re-open). */
    opened: boolean;
}

/**
 * Open a new attempt at stage `accepted` — the dispatch envelope is durably
 * recorded. attemptId is an opaque UUID distinct from taskId and the nonce; the
 * UNIQUE(mesh_id, task_id, attempt_seq) constraint dedupes a crash-retried open.
 *
 * If the queue entry is available the caller stamps `entry.attemptId` from the
 * returned attempt so events can correlate by id.
 */
export function openTurnAttempt(args: OpenTurnAttemptArgs): OpenTurnAttemptResult {
    const store = MeshRuntimeStore.getInstance();
    const nowMs = args.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const attemptId = randomUUID();
    const inserted = store.insertTurnAttempt({
        attemptId,
        meshId: args.meshId,
        taskId: args.taskId,
        attemptSeq: args.dispatchNonce,
        nodeId: args.nodeId,
        sessionId: args.sessionId,
        providerType: args.providerType,
        coordinatorDaemonId: args.coordinatorDaemonId,
        coordinatorSessionId: args.coordinatorSessionId,
        dispatchNonce: args.dispatchNonce,
        stage: 'accepted',
        acceptedAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
    });
    const attempt = inserted
        ? store.getTurnAttempt(attemptId)
        : store.getTurnAttemptBySeq(args.meshId, args.taskId, args.dispatchNonce);
    if (!attempt) {
        throw new Error(`openTurnAttempt: attempt row missing after insert (task ${args.taskId} seq ${args.dispatchNonce})`);
    }
    if (inserted) {
        store.insertTurnEvent({
            eventId: randomUUID(),
            meshId: args.meshId,
            attemptId: attempt.attemptId,
            taskId: args.taskId,
            kind: 'accepted',
            dedupeKey: '',
            occurredAtMs: nowMs,
            recordedAt: nowIso,
        });
    }
    return { attempt, opened: inserted };
}

/**
 * Legacy migration path: a task row that predates this stage has no attempt. Open a
 * DETERMINISTIC legacy attempt (stable id per (task, nonce)) at stage 'accepted' so
 * the reducer can correlate its late events — WITHOUT fabricating any
 * delivered/consumed/completed evidence. INSERT OR IGNORE makes the backfill
 * idempotent; every later call resolves the same row.
 */
export function ensureLegacyTurnAttempt(args: {
    meshId: string; taskId: string; dispatchNonce?: number;
    nodeId?: string; sessionId?: string; providerType?: string; nowMs?: number;
}): MeshTurnAttemptRow {
    const store = MeshRuntimeStore.getInstance();
    const seq = typeof args.dispatchNonce === 'number' ? args.dispatchNonce : 0;
    const existing = store.getTurnAttemptBySeq(args.meshId, args.taskId, seq)
        ?? store.getCurrentTurnAttempt(args.meshId, args.taskId);
    if (existing) return existing;
    const nowIso = new Date(args.nowMs ?? Date.now()).toISOString();
    const attemptId = `legacy-${args.taskId}-${seq}`;
    store.insertTurnAttempt({
        attemptId,
        meshId: args.meshId,
        taskId: args.taskId,
        attemptSeq: seq,
        nodeId: args.nodeId,
        sessionId: args.sessionId,
        providerType: args.providerType,
        dispatchNonce: typeof args.dispatchNonce === 'number' ? args.dispatchNonce : undefined,
        stage: 'accepted',
        acceptedAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
    });
    const row = store.getTurnAttempt(attemptId) ?? store.getCurrentTurnAttempt(args.meshId, args.taskId);
    if (!row) throw new Error(`ensureLegacyTurnAttempt: legacy attempt missing (task ${args.taskId})`);
    return row;
}

/**
 * Resolve the attempt an incoming event belongs to. Correlation order:
 *   1. explicit attemptId echoed by the worker (authoritative when present);
 *   2. the task's CURRENT attempt (max seq).
 * Returns null when the task has no attempt at all (pre-Stage-5 row never touched
 * by the reducer — caller falls back to legacy handling).
 */
export function resolveAttemptForTask(
    meshId: string,
    taskId: string,
    opts?: { attemptId?: string; legacy?: { dispatchNonce?: number; nodeId?: string; sessionId?: string; providerType?: string } },
): MeshTurnAttemptRow | null {
    const store = MeshRuntimeStore.getInstance();
    if (opts?.attemptId) {
        const byId = store.getTurnAttempt(opts.attemptId);
        if (byId && byId.meshId === meshId && byId.taskId === taskId) return byId;
        if (byId) return null; // id belongs to another task/mesh — never cross-correlate
    }
    const current = store.getCurrentTurnAttempt(meshId, taskId);
    if (current) return current;
    if (opts?.legacy) {
        return ensureLegacyTurnAttempt({
            meshId, taskId,
            dispatchNonce: opts.legacy.dispatchNonce,
            nodeId: opts.legacy.nodeId,
            sessionId: opts.legacy.sessionId,
            providerType: opts.legacy.providerType,
        });
    }
    return null;
}

// ─── ACK transaction (accepted → delivered → consumed) ─────────────────────

export interface TurnAckResult {
    attemptId: string;
    stage: string;
    /** true when this call advanced the stage; false on an idempotent/reordered arrival. */
    applied: boolean;
    /** true when the ACK named a non-current (old) attempt and was recorded-but-rejected. */
    staleAttempt: boolean;
    /**
     * true when a waiting_* suspension arrived pre-consumed and was durably HELD
     * (mesh_turn_held_suspensions) for application once consumed lands — an expected
     * ordering race, not an error.
     */
    deferred?: boolean;
}

/**
 * Record a delivery ACK against an attempt. Idempotent and monotonic: a repeated
 * ACK of the same kind, or a reordered lower-rank ACK, is recorded in the event log
 * (insert-once via the idempotency key) but never regresses the stage.
 *
 * `consumed` is the point of no return: once recorded, no prompt reinjection is
 * permitted for the attempt ({@link assertPromptInjectionAllowed}).
 */
export function recordTurnAck(args: {
    meshId: string;
    taskId: string;
    kind: TurnAckKind;
    attemptId?: string;
    sessionId?: string;
    occurredAtMs?: number;
    nowMs?: number;
    /** Content-free evidence metadata (ids/stages only — never prompt/transcript text). */
    evidence?: Record<string, unknown>;
    legacy?: { dispatchNonce?: number; nodeId?: string; providerType?: string };
}): TurnAckResult | null {
    const store = MeshRuntimeStore.getInstance();
    const nowMs = args.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const attempt = resolveAttemptForTask(args.meshId, args.taskId, {
        attemptId: args.attemptId,
        legacy: args.legacy ?? (args.sessionId ? { sessionId: args.sessionId } : undefined),
    });
    if (!attempt) return null;
    const current = store.getCurrentTurnAttempt(args.meshId, args.taskId);
    const staleAttempt = !!current && current.attemptId !== attempt.attemptId;
    if (staleAttempt) {
        // An ACK for an old attempt is recorded (audit) but must never mutate state.
        metrics.staleAttemptEvents += 1;
        const inserted = store.insertTurnEvent({
            eventId: randomUUID(),
            meshId: args.meshId,
            attemptId: attempt.attemptId,
            taskId: args.taskId,
            kind: `stale_${args.kind}`,
            dedupeKey: args.sessionId ?? '',
            occurredAtMs: args.occurredAtMs ?? nowMs,
            recordedAt: nowIso,
        });
        if (!inserted) metrics.duplicateTurnEvents += 1;
        LOG.info('TurnLedger', `Recorded stale ${args.kind} ACK for old attempt ${attempt.attemptId} (task ${args.taskId}); current attempt is ${current.attemptId} — no state change`);
        return { attemptId: attempt.attemptId, stage: attempt.stage, applied: false, staleAttempt: true };
    }
    if (isTerminalTurnStage(attempt.stage)) {
        return { attemptId: attempt.attemptId, stage: attempt.stage, applied: false, staleAttempt: false };
    }
    // Event first (insert-once idempotency), then the monotonic stage advance.
    const inserted = store.insertTurnEvent({
        eventId: randomUUID(),
        meshId: args.meshId,
        attemptId: attempt.attemptId,
        taskId: args.taskId,
        kind: args.kind,
        dedupeKey: '',
        payload: args.evidence ? safeEvidenceJson(args.evidence) : '{}',
        occurredAtMs: args.occurredAtMs ?? nowMs,
        recordedAt: nowIso,
    });
    if (!inserted) {
        metrics.duplicateTurnEvents += 1;
        return { attemptId: attempt.attemptId, stage: store.getTurnAttempt(attempt.attemptId)?.stage ?? attempt.stage, applied: false, staleAttempt: false };
    }
    const fromIso = args.kind === 'delivered' ? attempt.acceptedAt
        : args.kind === 'consumed' ? attempt.deliveredAt ?? attempt.acceptedAt
        : null;
    if (args.kind === 'accepted') {
        // 'accepted' is the insert state; a re-arrival is pure idempotency.
        return { attemptId: attempt.attemptId, stage: attempt.stage, applied: false, staleAttempt: false };
    }
    // HELD SUSPENSIONS: the consumed commit and the drain of any suspension held
    // pre-consumed are ONE transaction — a crash between them cannot strand a held
    // picker, and the projection can never skip the consumed link of the chain.
    const stageAfter = args.kind === 'consumed'
        ? store.transaction(() => {
            const after = store.advanceTurnAttemptStage(attempt.attemptId, args.kind, allowedFromStages(args.kind).join(','), {
                updatedAt: nowIso,
                consumedAt: nowIso,
            });
            drainHeldSuspensionsForAttempt(store, attempt.attemptId, nowMs, nowIso);
            return after;
        })
        : store.advanceTurnAttemptStage(attempt.attemptId, args.kind, allowedFromStages(args.kind).join(','), {
            updatedAt: nowIso,
            deliveredAt: args.kind === 'delivered' ? nowIso : undefined,
        });
    const applied = stageAfter === args.kind && attempt.stage !== args.kind;
    if (applied) noteAckLatency(fromIso, nowMs);
    return { attemptId: attempt.attemptId, stage: stageAfter ?? attempt.stage, applied, staleAttempt: false };
}

/** No prompt (re)injection is allowed once the attempt reached `consumed`. */
export function isPromptInjectionAllowed(attempt: MeshTurnAttemptRow | null): boolean {
    if (!attempt) return true; // no attempt → nothing consumed yet
    if (attempt.terminalOutcome) return false;
    return STAGE_RANK[attempt.stage as TurnStage] < STAGE_RANK.consumed;
}

/**
 * Guard called before any prompt (re)injection into a session for an attempt.
 * Returns true when the injection may proceed; when it returns false the caller
 * MUST NOT inject — the attempt already consumed a prompt and a duplicate would
 * double-execute the task. Counted as duplicatePromptPrevented.
 */
export function assertPromptInjectionAllowed(attempt: MeshTurnAttemptRow | null, context: string): boolean {
    const allowed = isPromptInjectionAllowed(attempt);
    if (!allowed) {
        metrics.duplicatePromptPrevented += 1;
        LOG.warn('TurnLedger', `Refused prompt (re)injection for attempt ${attempt?.attemptId} (task ${attempt?.taskId}): stage=${attempt?.stage} terminal=${attempt?.terminalOutcome ?? 'no'} — ${context}`);
    }
    return allowed;
}

// ─── Nonterminal progress stages ────────────────────────────────────────────

/**
 * Record a nonterminal lifecycle stage (generating / waiting_approval /
 * waiting_choice / finalizing). Idempotent; suspended states oscillate with
 * `generating` per the transition whitelist. `waiting_approval`/`waiting_choice`
 * NEVER imply completion; `finalizing` marks that terminal evidence is being
 * reconciled/committed and is exposed for the Stage 6 projection.
 */
export function recordTurnStage(args: {
    meshId: string;
    taskId: string;
    stage: TurnProgressStage;
    attemptId?: string;
    sessionId?: string;
    occurredAtMs?: number;
    nowMs?: number;
    evidence?: Record<string, unknown>;
    legacy?: { dispatchNonce?: number; nodeId?: string; providerType?: string };
}): TurnAckResult | null {
    const store = MeshRuntimeStore.getInstance();
    const nowMs = args.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const attempt = resolveAttemptForTask(args.meshId, args.taskId, {
        attemptId: args.attemptId,
        legacy: args.legacy ?? (args.sessionId ? { sessionId: args.sessionId } : undefined),
    });
    if (!attempt) return null;
    const current = store.getCurrentTurnAttempt(args.meshId, args.taskId);
    if (current && current.attemptId !== attempt.attemptId) {
        metrics.staleAttemptEvents += 1;
        store.insertTurnEvent({
            eventId: randomUUID(),
            meshId: args.meshId,
            attemptId: attempt.attemptId,
            taskId: args.taskId,
            kind: `stale_${args.stage}`,
            dedupeKey: args.sessionId ?? '',
            occurredAtMs: args.occurredAtMs ?? nowMs,
            recordedAt: nowIso,
        });
        // A suspension naming a non-current attempt is inert by construction; resolve
        // any rows still held for the old attempt so they can never apply later and
        // never leak onto the new assignee.
        if (SUSPENDED_STAGES.has(args.stage)) {
            dropHeldSuspensionsForAttempt(store, attempt.attemptId, 'stale_attempt', nowIso);
        }
        return { attemptId: attempt.attemptId, stage: attempt.stage, applied: false, staleAttempt: true };
    }
    if (isTerminalTurnStage(attempt.stage)) {
        if (SUSPENDED_STAGES.has(args.stage)) {
            dropHeldSuspensionsForAttempt(store, attempt.attemptId, 'attempt_terminal', nowIso);
        }
        return { attemptId: attempt.attemptId, stage: attempt.stage, applied: false, staleAttempt: false };
    }
    // Nonterminal stages dedupe on (kind, stage-entry) — oscillation entries are
    // keyed by occurrence time so a genuine re-suspension is still logged once.
    const inserted = store.insertTurnEvent({
        eventId: randomUUID(),
        meshId: args.meshId,
        attemptId: attempt.attemptId,
        taskId: args.taskId,
        kind: args.stage,
        dedupeKey: String(args.occurredAtMs ?? nowMs),
        payload: args.evidence ? safeEvidenceJson(args.evidence) : '{}',
        occurredAtMs: args.occurredAtMs ?? nowMs,
        recordedAt: nowIso,
    });
    if (!inserted) metrics.duplicateTurnEvents += 1;
    // HELD SUSPENSIONS (reordered-generating guard): a generating echo that PREDATES
    // a held-then-applied suspension is stale evidence (typically the generating_started
    // whose paired consumed commit just drained the hold). It must NOT regress the
    // parked picker back to generating. Genuine resumes carry a LATER occurrence time
    // and pass; events without timestamps keep the legacy behavior.
    if (args.stage === 'generating' && SUSPENDED_STAGES.has(attempt.stage) && typeof args.occurredAtMs === 'number') {
        const appliedHold = store.getHeldTurnSuspension(attempt.attemptId, attempt.stage);
        if (appliedHold && appliedHold.status === 'applied'
            && typeof appliedHold.occurredAtMs === 'number'
            && args.occurredAtMs < appliedHold.occurredAtMs) {
            metrics.reorderedGeneratingSuppressed += 1;
            logSuspensionOnce('info', `reordered:${attempt.attemptId}`,
                `Suppressed reordered generating for task ${args.taskId} attempt ${attempt.attemptId}: event occurred ${args.occurredAtMs} < applied ${attempt.stage} suspension at ${appliedHold.occurredAtMs} — the suspension stage stands`);
            return { attemptId: attempt.attemptId, stage: attempt.stage, applied: false, staleAttempt: false };
        }
    }
    const stageAfter = store.advanceTurnAttemptStage(attempt.attemptId, args.stage, allowedFromStages(args.stage).join(','), {
        updatedAt: nowIso,
    });
    // HELD SUSPENSIONS (defer): a waiting_* edge rejected solely because the attempt
    // is still pre-consumed (accepted/delivered) is the fast-picker ordering race —
    // hold it durably instead of dropping it. The consumed commit (same transaction)
    // or the restart reconcile drain applies it through the FSM.
    if (
        SUSPENDED_STAGES.has(args.stage)
        && stageAfter !== null
        && stageAfter !== args.stage
        && STAGE_RANK[stageAfter as TurnStage] < STAGE_RANK.consumed
    ) {
        const held = store.insertHeldTurnSuspension({
            holdId: `${attempt.attemptId}:${args.stage}`,
            meshId: args.meshId,
            attemptId: attempt.attemptId,
            taskId: args.taskId,
            stage: args.stage,
            sessionId: args.sessionId,
            dispatchNonce: attempt.dispatchNonce,
            occurredAtMs: args.occurredAtMs ?? nowMs,
            recordedAt: nowIso,
        });
        if (held) {
            metrics.suspensionsHeld += 1;
            logSuspensionOnce('info', `held:${attempt.attemptId}:${args.stage}`,
                `Held ${args.stage} suspension for task ${args.taskId} attempt ${attempt.attemptId} (stage ${stageAfter} — consumed not yet durable); applying after the consumed ACK`);
        } else {
            metrics.duplicateTurnEvents += 1;
        }
        return { attemptId: attempt.attemptId, stage: stageAfter, applied: false, staleAttempt: false, deferred: true };
    }
    return {
        attemptId: attempt.attemptId,
        stage: stageAfter ?? attempt.stage,
        applied: stageAfter === args.stage && attempt.stage !== args.stage,
        staleAttempt: false,
    };
}

// ─── Held suspensions (pre-consumed waiting_* ordering tolerance) ───────────

/** Typed, content-free drop reasons for held suspensions (metrics keys). */
export type HeldSuspensionDropReason =
    | 'attempt_terminal'   // the attempt committed a terminal outcome while held
    | 'stale_attempt'      // the attempt became non-current (reassignment)
    | 'attempt_missing'    // the attempt row vanished (retention/manual surgery)
    | 'finalizing'         // terminal evidence superseded the held suspension
    | 'stage_advanced'     // the FSM refused the drain (stage moved past waiting_*)
    | 'session_dead';      // the worker session is demonstrably dead — redrive opens a new attempt

/**
 * Resolve every row still held for an attempt as dropped with a typed reason.
 * Exactly-once per row (the store's status guard), counted, first-occurrence
 * logged. Never resurrects or mutates the attempt stage.
 */
function dropHeldSuspensionsForAttempt(
    store: MeshRuntimeStore,
    attemptId: string,
    reason: HeldSuspensionDropReason,
    nowIso: string,
): number {
    const held = store.listHeldTurnSuspensionsForAttempt(attemptId, 'held');
    let dropped = 0;
    for (const hold of held) {
        if (store.resolveHeldTurnSuspension(hold.holdId, 'dropped', reason, nowIso)) {
            noteDroppedSuspension(reason);
            logSuspensionOnce('info', `dropped:${reason}:${attemptId}:${hold.stage}`,
                `Dropped held ${hold.stage} suspension for task ${hold.taskId} attempt ${attemptId}: ${reason}`);
            dropped += 1;
        }
    }
    return dropped;
}

/**
 * Drain the suspensions held for ONE attempt: rows whose attempt has reached
 * ≥ consumed (nonterminal, non-finalizing) are applied through the SAME FSM
 * whitelist as a live waiting_* event, oldest occurrence first; rows whose
 * attempt went terminal/finalizing/missing are dropped with a typed reason.
 * Ineligible (still pre-consumed) rows stay held for a later drain. Idempotent:
 * the FSM advance and the resolve-held write are both guarded, so a duplicate
 * drain is a no-op. Emits a `held_<stage>_applied` audit event per applied hold
 * so the causal chain shows the deferred application.
 */
function drainHeldSuspensionsForAttempt(
    store: MeshRuntimeStore,
    attemptId: string,
    nowMs: number,
    nowIso: string,
): { applied: number; dropped: number } {
    const held = store.listHeldTurnSuspensionsForAttempt(attemptId, 'held');
    if (held.length === 0) return { applied: 0, dropped: 0 };
    let attempt = store.getTurnAttempt(attemptId);
    let applied = 0;
    let dropped = 0;
    for (const hold of held) {
        if (!attempt) {
            if (store.resolveHeldTurnSuspension(hold.holdId, 'dropped', 'attempt_missing', nowIso)) {
                noteDroppedSuspension('attempt_missing');
                dropped += 1;
            }
            continue;
        }
        if (attempt.terminalOutcome || isTerminalTurnStage(attempt.stage)) {
            if (store.resolveHeldTurnSuspension(hold.holdId, 'dropped', 'attempt_terminal', nowIso)) {
                noteDroppedSuspension('attempt_terminal');
                logSuspensionOnce('info', `dropped:attempt_terminal:${attemptId}:${hold.stage}`,
                    `Dropped held ${hold.stage} suspension for task ${hold.taskId} attempt ${attemptId}: attempt terminal (${attempt.terminalOutcome ?? attempt.stage})`);
                dropped += 1;
            }
            continue;
        }
        if (attempt.stage === 'finalizing') {
            if (store.resolveHeldTurnSuspension(hold.holdId, 'dropped', 'finalizing', nowIso)) {
                noteDroppedSuspension('finalizing');
                dropped += 1;
            }
            continue;
        }
        if (STAGE_RANK[attempt.stage as TurnStage] < STAGE_RANK.consumed) {
            continue; // consumed not durable yet — stay held
        }
        const stageAfter = store.advanceTurnAttemptStage(attemptId, hold.stage, allowedFromStages(hold.stage as TurnStage).join(','), {
            updatedAt: nowIso,
        });
        if (stageAfter === hold.stage) {
            if (store.resolveHeldTurnSuspension(hold.holdId, 'applied', 'applied', nowIso)) {
                store.insertTurnEvent({
                    eventId: randomUUID(),
                    meshId: hold.meshId,
                    attemptId,
                    taskId: hold.taskId,
                    kind: `held_${hold.stage}_applied`,
                    dedupeKey: hold.holdId,
                    occurredAtMs: hold.occurredAtMs ?? nowMs,
                    recordedAt: nowIso,
                });
                metrics.suspensionsApplied += 1;
                logSuspensionOnce('info', `applied:${attemptId}:${hold.stage}`,
                    `Applied held ${hold.stage} suspension for task ${hold.taskId} attempt ${attemptId} after consumed became durable`);
                applied += 1;
            }
            attempt = { ...attempt, stage: stageAfter };
        } else {
            // The stage moved past waiting_* under us — resolve safely, never force it.
            const reason: HeldSuspensionDropReason = stageAfter === 'finalizing' ? 'finalizing' : 'stage_advanced';
            if (store.resolveHeldTurnSuspension(hold.holdId, 'dropped', reason, nowIso)) {
                noteDroppedSuspension(reason);
                logSuspensionOnce('warn', `dropped:${reason}:${attemptId}:${hold.stage}`,
                    `Held ${hold.stage} suspension for task ${hold.taskId} attempt ${attemptId} could not apply (stage now ${stageAfter ?? 'missing'}) — dropped:${reason}`);
                dropped += 1;
            }
        }
    }
    return { applied, dropped };
}

/**
 * Restart-reconcile drain: after a daemon restart, re-apply every held suspension
 * whose attempt's consumed state is already durable (and drop rows whose attempt
 * went terminal/missing while down). This NEVER re-injects a prompt and never
 * re-drives an event — it only advances the attempt stage through the FSM, the
 * same write a live waiting_* event would have made. Rows still pre-consumed stay
 * held for the live consumed ACK.
 */
export function drainHeldTurnSuspensionsForMesh(
    meshId: string,
    nowMs: number = Date.now(),
): { applied: number; dropped: number; stillHeld: number } {
    try {
        const store = MeshRuntimeStore.getInstance();
        const nowIso = new Date(nowMs).toISOString();
        const held = store.listHeldTurnSuspensionsForMesh(meshId, 'held');
        let applied = 0;
        let dropped = 0;
        for (const attemptId of new Set(held.map(h => h.attemptId))) {
            const res = drainHeldSuspensionsForAttempt(store, attemptId, nowMs, nowIso);
            applied += res.applied;
            dropped += res.dropped;
        }
        const stillHeld = store.listHeldTurnSuspensionsForMesh(meshId, 'held').length;
        if (applied + dropped > 0 || held.length > 0) {
            LOG.info('TurnLedger', `Held-suspension drain for mesh ${meshId}: applied=${applied} dropped=${dropped} stillHeld=${stillHeld}`);
        }
        return { applied, dropped, stillHeld };
    } catch (e: any) {
        LOG.warn('TurnLedger', `Held-suspension drain failed for mesh ${meshId} (rows stay held; retried on next boot/consumed): ${e?.message || e}`);
        return { applied: 0, dropped: 0, stillHeld: 0 };
    }
}

// ─── Held-suspension restart contract (redrive gate) ───────────────────────

/**
 * The outcome of {@link gateRedriveForHeldSuspension}:
 *  - `none`      — no valid blocking hold; the caller's normal redrive rules apply.
 *  - `blocked`   — a valid hold is unresolved and the session is not yet confirmed
 *                  alive or dead: redrive/reclaim MUST NOT fire. The hold stays.
 *  - `recovered` — the surviving session is confirmed alive: the consumed link was
 *                  synthesized from the suspension (audit source
 *                  `held_suspension_recovery`) and the hold applied through the FSM,
 *                  atomically. The SAME attempt continues; no redrive, no reinjection.
 *  - `released`  — the session is demonstrably dead: the hold was dropped
 *                  (`session_dead`) so the caller's redrive/reclaim can open a NEW
 *                  attempt. The old attempt is never resurrected.
 */
export type HeldSuspensionRedriveGate =
    | { kind: 'none' }
    | { kind: 'blocked'; attemptId: string; stages: string[] }
    | { kind: 'recovered'; attemptId: string; stage: string }
    | { kind: 'released'; attemptId: string; dropped: number };

/**
 * VALIDITY: a hold blocks (and can recover) redrive only when it is unresolved
 * causal evidence for the CURRENT attempt of the task — same attemptId, the
 * attempt's bound worker session, and the attempt's current dispatch nonce —
 * and the attempt is still pre-consumed and nonterminal. Stale / session-
 * mismatch / nonce-mismatch / terminal / already-consumed holds are inert:
 * they never block and never resurrect.
 */
function heldSuspensionBlocksAttempt(hold: MeshTurnHeldSuspensionRow, attempt: MeshTurnAttemptRow): boolean {
    if (hold.attemptId !== attempt.attemptId) return false;
    if (attempt.terminalOutcome || isTerminalTurnStage(attempt.stage)) return false;
    if (STAGE_RANK[attempt.stage as TurnStage] >= STAGE_RANK.consumed) return false;
    // CURRENT-SESSION: the suspension must have been emitted BY the attempt's
    // bound worker session (a different session's picker proves nothing here).
    if (!hold.sessionId || !attempt.sessionId || !sessionIdsEquivalent(hold.sessionId, attempt.sessionId)) return false;
    // CURRENT-EPOCH: the suspension must belong to the attempt's current nonce.
    if (typeof hold.dispatchNonce !== 'number' || typeof attempt.dispatchNonce !== 'number'
        || hold.dispatchNonce !== attempt.dispatchNonce) return false;
    return true;
}

/**
 * THE durable, typed restart/redrive rule. A current-attempt waiting_* hold is
 * positive causal evidence the prompt reached the worker session — stronger
 * than the ABSENCE of the generating_started consumed ACK the redrive paths
 * infer "never consumed" from. The caller supplies the authoritative liveness
 * verdict for the attempt's bound session:
 *  - 'alive'                    → the session survived and is rebound: promote the
 *                                 consumed link from the suspension (one transaction:
 *                                 synthesized `consumed` evidence with audit source
 *                                 `held_suspension_recovery` + monotonic stage advance
 *                                 + the same drain a live consumed ACK runs). A later
 *                                 real consumed ACK is insert-once idempotent.
 *  - 'unknown' + !provenDead    → keep blocking (the session may still be
 *                                 rebounding); the caller's bounded liveness grace
 *                                 decides when `provenDead` becomes true.
 *  - 'unknown' + provenDead     → the existing authoritative liveness path has
 *                                 demonstrably failed: drop the hold (`session_dead`)
 *                                 and let the redrive/reclaim open a new attempt.
 * Never injects a prompt, never re-drives an event, never mutates a terminal
 * attempt. Idempotent: a second call after recovery finds no `held` rows.
 */
export function gateRedriveForHeldSuspension(args: {
    meshId: string;
    taskId: string;
    /** Authoritative liveness for the attempt's bound worker session. */
    sessionLiveness: 'alive' | 'unknown';
    /**
     * True only when the caller's bounded dead-detection (e.g. the consecutive-
     * UNKNOWN-tick grace) has exhausted — the existing demonstrably-dead
     * determination. Only then may a hold be released for redrive.
     */
    sessionProvenDead?: boolean;
    nowMs?: number;
}): HeldSuspensionRedriveGate {
    const store = MeshRuntimeStore.getInstance();
    const nowMs = args.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const attempt = store.getCurrentTurnAttempt(args.meshId, args.taskId);
    if (!attempt) return { kind: 'none' };
    const holds = store.listHeldTurnSuspensionsForAttempt(attempt.attemptId, 'held')
        .filter(h => heldSuspensionBlocksAttempt(h, attempt));
    if (holds.length === 0) return { kind: 'none' };
    if (args.sessionLiveness === 'alive') {
        // Promote: the surviving session vouches for the suspension, so the
        // prompt WAS consumed. Write the consumed link and apply the hold in
        // ONE transaction — the same atomic shape as the live consumed commit.
        let promoted = false;
        store.transaction(() => {
            if (STAGE_RANK[attempt.stage as TurnStage] < STAGE_RANK.consumed) {
                store.insertTurnEvent({
                    eventId: randomUUID(),
                    meshId: args.meshId,
                    attemptId: attempt.attemptId,
                    taskId: args.taskId,
                    kind: 'consumed',
                    dedupeKey: '',
                    payload: safeEvidenceJson({ source: 'held_suspension_recovery' }),
                    occurredAtMs: holds[0].occurredAtMs ?? nowMs,
                    recordedAt: nowIso,
                });
                store.advanceTurnAttemptStage(attempt.attemptId, 'consumed', allowedFromStages('consumed').join(','), {
                    updatedAt: nowIso,
                    consumedAt: nowIso,
                });
                promoted = true;
            }
            drainHeldSuspensionsForAttempt(store, attempt.attemptId, nowMs, nowIso);
        });
        const stage = store.getTurnAttempt(attempt.attemptId)?.stage ?? attempt.stage;
        if (promoted) {
            metrics.suspensionConsumedRecovered += 1;
            logSuspensionOnce('info', `recovered:${attempt.attemptId}`,
                `Recovered consumed evidence for task ${args.taskId} attempt ${attempt.attemptId} from held ${holds.map(h => h.stage).join('/')} suspension(s): surviving session confirmed rebound (audit source held_suspension_recovery) — the SAME attempt continues`);
        }
        return { kind: 'recovered', attemptId: attempt.attemptId, stage };
    }
    if (args.sessionProvenDead) {
        // Demonstrably dead worker: release the block so the caller's redrive /
        // reclaim can close this attempt and open a new one. The old hold can
        // never apply afterwards (the attempt close drops anything left).
        const dropped = dropHeldSuspensionsForAttempt(store, attempt.attemptId, 'session_dead', nowIso);
        if (dropped > 0) {
            logSuspensionOnce('info', `released:${attempt.attemptId}`,
                `Released ${dropped} held suspension(s) for task ${args.taskId} attempt ${attempt.attemptId}: worker session demonstrably dead — redrive/reassign may proceed to a NEW attempt`);
        }
        return { kind: 'released', attemptId: attempt.attemptId, dropped };
    }
    metrics.redriveBlockedBySuspension += 1;
    logSuspensionOnce('info', `blocked:${attempt.attemptId}`,
        `Redrive blocked by unresolved held ${holds.map(h => h.stage).join('/')} suspension(s) for task ${args.taskId} attempt ${attempt.attemptId}: the prompt reached the worker (session liveness unconfirmed — awaiting rebind or the dead-detection grace)`);
    return { kind: 'blocked', attemptId: attempt.attemptId, stages: holds.map(h => h.stage) };
}

// ─── Completion proposals (exactly-once terminal) ──────────────────────────

/** The terminal-writer classes that feed the reducer. */
export type CompletionProposalSource =
    | 'provider_event'    // native/PTY provider completion event (agent:generating_completed / agent:stopped / agent:ready)
    | 'pty_hook'          // PTY-observed terminal signal
    | 'transcript'        // transcript/native-history terminal evidence
    | 'idle_status'       // status/idle-driven inference
    | 'stall_reconcile'   // stall watchdog / no-progress reconciliation
    | 'cancellation'      // operator/system cancellation
    | 'reassignment';     // reclaim/reassign closing the attempt (task continues)

export interface CompletionProposal {
    meshId: string;
    taskId: string;
    attemptId?: string;
    sessionId?: string;
    /** Dispatcher epoch (the dispatchNonce the proposing party observed). */
    epoch?: number;
    outcome: TurnTerminalOutcome;
    source: CompletionProposalSource;
    reason?: string;
    occurredAtMs?: number;
    nowMs?: number;
    /** Content-free evidence metadata only (ids/stages/levels — never prompt/transcript text). */
    evidence?: Record<string, unknown>;
    legacy?: { dispatchNonce?: number; nodeId?: string; providerType?: string };
}

export type CompletionRejectionReason =
    | 'unknown_attempt'     // no attempt row could be resolved for the task
    | 'stale_attempt'       // proposal targets a non-current attempt (a reassignment happened)
    | 'session_mismatch'    // proposing session is not the attempt's worker session
    | 'epoch_mismatch'      // proposal's dispatcher epoch is older than the attempt's nonce
    | 'already_terminal';   // attempt already committed a DIFFERENT terminal outcome

export type CompletionDecision =
    | { committed: true; attemptId: string; outcome: TurnTerminalOutcome; duplicate: boolean }
    | { committed: false; reason: CompletionRejectionReason; attemptId?: string; existingOutcome?: string };

/**
 * THE single terminal writer. Validates (meshId, taskId, attemptId, session, epoch)
 * causality and commits AT MOST ONE terminal outcome per attempt via the store's
 * conditional UPDATE. Late/duplicate proposals are recorded in the event log and
 * rejected with a typed reason; a rejection NEVER re-completes and NEVER re-injects.
 *
 * A repeated proposal carrying the SAME outcome as the committed terminal is an
 * idempotent duplicate (committed:true, duplicate:true) — safe for at-least-once
 * transports and crash replays.
 */
export function proposeTurnCompletion(proposal: CompletionProposal): CompletionDecision {
    const store = MeshRuntimeStore.getInstance();
    const nowMs = proposal.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const attempt = resolveAttemptForTask(proposal.meshId, proposal.taskId, {
        attemptId: proposal.attemptId,
        legacy: proposal.legacy ?? (proposal.sessionId ? { sessionId: proposal.sessionId } : undefined),
    });
    if (!attempt) {
        noteRejectedProposal('unknown_attempt');
        return { committed: false, reason: 'unknown_attempt' };
    }
    const current = store.getCurrentTurnAttempt(proposal.meshId, proposal.taskId);
    if (current && current.attemptId !== attempt.attemptId) {
        metrics.staleAttemptEvents += 1;
        noteRejectedProposal('stale_attempt');
        recordProposalEvent(store, proposal, attempt, nowMs, nowIso, 'rejected_stale_attempt');
        LOG.info('TurnLedger', `Rejected completion proposal (${proposal.outcome}/${proposal.source}) for task ${proposal.taskId}: attempt ${attempt.attemptId} is stale (current ${current.attemptId})`);
        return { committed: false, reason: 'stale_attempt', attemptId: attempt.attemptId, existingOutcome: current.terminalOutcome ?? undefined };
    }
    // Session causality: when the attempt names a worker session, a proposal from a
    // DIFFERENT session cannot terminate it (an old worker's late completion).
    if (
        proposal.sessionId
        && attempt.sessionId
        && !sessionIdsEquivalent(proposal.sessionId, attempt.sessionId)
        && proposal.source !== 'cancellation'
        && proposal.source !== 'reassignment'
    ) {
        noteRejectedProposal('session_mismatch');
        recordProposalEvent(store, proposal, attempt, nowMs, nowIso, 'rejected_session_mismatch');
        LOG.info('TurnLedger', `Rejected completion proposal (${proposal.outcome}/${proposal.source}) for task ${proposal.taskId}: session ${proposal.sessionId} ≠ attempt session ${attempt.sessionId}`);
        return { committed: false, reason: 'session_mismatch', attemptId: attempt.attemptId };
    }
    // Epoch causality: a proposal carrying an older dispatcher epoch than the
    // attempt's nonce belongs to a superseded dispatch. EXCEPTION (same-session
    // resumption): when the proposing session IS the attempt's worker session, the
    // (taskId, attemptId, session) authority vouches — a resumed worker legitimately
    // echoes its pre-reclaim nonce and must not be rejected for it.
    const sessionVouches = !!(
        proposal.sessionId
        && attempt.sessionId
        && sessionIdsEquivalent(proposal.sessionId, attempt.sessionId)
    );
    if (
        typeof proposal.epoch === 'number'
        && typeof attempt.dispatchNonce === 'number'
        && proposal.epoch < attempt.dispatchNonce
        && !sessionVouches
        && proposal.source !== 'cancellation'
        && proposal.source !== 'reassignment'
    ) {
        noteRejectedProposal('epoch_mismatch');
        recordProposalEvent(store, proposal, attempt, nowMs, nowIso, 'rejected_epoch_mismatch');
        return { committed: false, reason: 'epoch_mismatch', attemptId: attempt.attemptId };
    }
    if (attempt.terminalOutcome) {
        // A terminal attempt must never hold a live suspension: resolve any rows
        // still held (defensive — the commit path below already drops them).
        dropHeldSuspensionsForAttempt(store, attempt.attemptId, 'attempt_terminal', nowIso);
        if (attempt.terminalOutcome === proposal.outcome) {
            // Idempotent replay of the SAME terminal — safe under at-least-once delivery.
            metrics.duplicateTurnEvents += 1;
            return { committed: true, attemptId: attempt.attemptId, outcome: proposal.outcome, duplicate: true };
        }
        noteRejectedProposal('already_terminal');
        recordProposalEvent(store, proposal, attempt, nowMs, nowIso, 'rejected_already_terminal');
        LOG.info('TurnLedger', `Rejected completion proposal (${proposal.outcome}/${proposal.source}) for task ${proposal.taskId}: attempt ${attempt.attemptId} already terminal (${attempt.terminalOutcome})`);
        return { committed: false, reason: 'already_terminal', attemptId: attempt.attemptId, existingOutcome: attempt.terminalOutcome };
    }
    recordProposalEvent(store, proposal, attempt, nowMs, nowIso, undefined);
    const { committed, row } = store.commitTurnAttemptTerminal(
        attempt.attemptId,
        proposal.outcome,
        proposal.reason ?? proposal.source,
        new Date(proposal.occurredAtMs ?? nowMs).toISOString(),
    );
    if (!committed) {
        // Lost the exactly-once race — another proposal committed first.
        metrics.transactionConflicts += 1;
        const winner = row?.terminalOutcome ?? 'unknown';
        if (winner === proposal.outcome) {
            return { committed: true, attemptId: attempt.attemptId, outcome: proposal.outcome, duplicate: true };
        }
        noteRejectedProposal('already_terminal');
        return { committed: false, reason: 'already_terminal', attemptId: attempt.attemptId, existingOutcome: winner };
    }
    metrics.completionProposalsCommitted += 1;
    // A held suspension must never resurrect a terminated attempt: resolve any rows
    // still held in the same decision (they can no longer legitimately apply).
    dropHeldSuspensionsForAttempt(store, attempt.attemptId, 'attempt_terminal', nowIso);
    LOG.info('TurnLedger', `Committed terminal ${proposal.outcome} for task ${proposal.taskId} attempt ${attempt.attemptId} (source=${proposal.source}, stage was ${attempt.stage})`);
    return { committed: true, attemptId: attempt.attemptId, outcome: proposal.outcome, duplicate: false };
}

function recordProposalEvent(
    store: MeshRuntimeStore,
    proposal: CompletionProposal,
    attempt: MeshTurnAttemptRow,
    nowMs: number,
    nowIso: string,
    rejection: string | undefined,
): void {
    store.insertTurnEvent({
        eventId: randomUUID(),
        meshId: proposal.meshId,
        attemptId: attempt.attemptId,
        taskId: proposal.taskId,
        kind: rejection ?? `proposal_${proposal.outcome}`,
        // Dedupe per (outcome, source): a retried proposal of the same class is insert-once.
        dedupeKey: `${proposal.source}:${proposal.outcome}`,
        payload: safeEvidenceJson({
            ...(proposal.evidence ?? {}),
            source: proposal.source,
            ...(proposal.reason ? { reason: proposal.reason } : {}),
            ...(rejection ? { rejection } : {}),
        }),
        occurredAtMs: proposal.occurredAtMs ?? nowMs,
        recordedAt: nowIso,
    });
}

// ─── Reassignment / reclaim ────────────────────────────────────────────────

/**
 * Close the CURRENT attempt when the task is reclaimed/reassigned. The ATTEMPT goes
 * terminal ('cancelled', reason `reassigned:<why>`) — the TASK continues and its
 * re-dispatch opens a NEW attempt (new nonce → new seq). From this point every late
 * event naming the old attempt is rejected as stale and cannot mutate the new one.
 * Exactly-once: a second close of the same attempt is an idempotent duplicate.
 */
export function closeAttemptForReassignment(args: {
    meshId: string;
    taskId: string;
    reason: string;
    nowMs?: number;
}): CompletionDecision {
    return proposeTurnCompletion({
        meshId: args.meshId,
        taskId: args.taskId,
        outcome: 'cancelled',
        source: 'reassignment',
        reason: `reassigned:${args.reason}`,
        nowMs: args.nowMs,
    });
}

// ─── Redrive rules (durable lease) ─────────────────────────────────────────

/** Max same-attempt prompt re-drives. One re-drive per attempt, ever. */
export const MAX_REDRIVES_PER_ATTEMPT = 1;

export type RedriveEvaluation =
    | { allowed: true; attemptId: string }
    | { allowed: false; reason: 'no_attempt' | 'attempt_terminal' | 'already_consumed' | 'lease_active' | 'redrive_budget_exhausted'; attemptId?: string };

/**
 * The durable redrive gate: a delivered-but-NOT-consumed attempt may be re-driven
 * only while its evidence says the prompt was never consumed, only within its lease
 * deadline, and only within its redrive budget. A CONSUMED attempt never re-drives —
 * that is the "no duplicate provider prompt" rule, made durable (it survives the
 * daemon restart that used to reset the in-memory streaks).
 */
export function evaluateRedrive(
    meshId: string,
    taskId: string,
    nowMs: number = Date.now(),
): RedriveEvaluation {
    const store = MeshRuntimeStore.getInstance();
    const attempt = store.getCurrentTurnAttempt(meshId, taskId);
    if (!attempt) return { allowed: false, reason: 'no_attempt' };
    if (attempt.terminalOutcome) return { allowed: false, reason: 'attempt_terminal', attemptId: attempt.attemptId };
    if (STAGE_RANK[attempt.stage as TurnStage] >= STAGE_RANK.consumed) {
        return { allowed: false, reason: 'already_consumed', attemptId: attempt.attemptId };
    }
    if (attempt.redriveCount >= MAX_REDRIVES_PER_ATTEMPT) {
        return { allowed: false, reason: 'redrive_budget_exhausted', attemptId: attempt.attemptId };
    }
    if (typeof attempt.leaseDeadlineMs === 'number' && nowMs < attempt.leaseDeadlineMs) {
        return { allowed: false, reason: 'lease_active', attemptId: attempt.attemptId };
    }
    return { allowed: true, attemptId: attempt.attemptId };
}

/**
 * Record a redrive against the attempt: bump the durable redrive counter and set the
 * next lease deadline. Callers must have passed {@link evaluateRedrive} first.
 */
export function markAttemptRedriven(args: {
    meshId: string;
    taskId: string;
    leaseDurationMs: number;
    nowMs?: number;
}): void {
    const store = MeshRuntimeStore.getInstance();
    const nowMs = args.nowMs ?? Date.now();
    const attempt = store.getCurrentTurnAttempt(args.meshId, args.taskId);
    if (!attempt) return;
    store.markTurnAttemptRedriven(attempt.attemptId, nowMs + args.leaseDurationMs, new Date(nowMs).toISOString());
}

// ─── Same-session stale-nonce compatibility ────────────────────────────────

export type NonceEchoClassification =
    | 'current'              // nonce ≥ row nonce (or absent) — normal path
    | 'same_session_compat'  // pre-reclaim nonce echoed by the CURRENT assignee session — accept, never stop
    | 'stale';               // old nonce echoed by a DIFFERENT session — reject + stop

/**
 * Classify a generating_started nonce echo. The original REDRIVE-DUP guard treated
 * EVERY nonce below the row's current value as stale and stopped the worker — which
 * killed the CURRENT legitimate assignee when a reclaim had bumped the nonce and
 * re-dispatched to the SAME session (the resumed worker echoed its pre-reclaim
 * nonce). The (taskId, attemptId, session) authority now wins: when the echo comes
 * FROM the session the current attempt is bound to, the old nonce is a resumption
 * artifact, not a stale dispatch — accept it (counted) and never stop that worker.
 * Only an echo from a DIFFERENT session is a genuinely stale dispatch.
 */
export function classifyNonceEcho(args: {
    meshId: string;
    taskId: string;
    sessionId?: string;
    nonce?: number;
    currentNonce?: number;
}): NonceEchoClassification {
    if (typeof args.nonce !== 'number' || typeof args.currentNonce !== 'number') return 'current';
    if (args.nonce >= args.currentNonce) return 'current';
    if (args.sessionId) {
        try {
            const attempt = MeshRuntimeStore.getInstance().getCurrentTurnAttempt(args.meshId, args.taskId);
            if (attempt?.sessionId && sessionIdsEquivalent(attempt.sessionId, args.sessionId)) {
                metrics.sameSessionStaleNonceCompatAccepted += 1;
                LOG.info('TurnLedger', `Same-session stale-nonce compatibility: task ${args.taskId} session ${args.sessionId} echoed pre-reclaim nonce ${args.nonce} < ${args.currentNonce} — the echo comes from the CURRENT assignee (attempt ${attempt.attemptId}); accepting, NOT stopping`);
                return 'same_session_compat';
            }
        } catch { /* store unavailable — fall through to the conservative stale verdict */ }
    }
    return 'stale';
}

// ─── Restart recovery ──────────────────────────────────────────────────────

export interface RecoveredAttempt {
    attemptId: string;
    taskId: string;
    stage: string;
    sessionId: string | null;
    nodeId: string | null;
    dispatchNonce: number | null;
    leaseDeadlineMs: number | null;
    redriveCount: number;
}

/**
 * Reconstruct the active attempt set after a daemon restart. Every nonterminal
 * attempt row is returned so the reconcile loop can resume delivery tracking and
 * redrive/deadline reconciliation from DURABLE state — without re-injecting a prompt
 * (a recovered attempt at ≥ consumed is injection-ineligible by construction) and
 * without duplicating a coordinator completion (the terminal commit + outbox row
 * are one transaction; the outbox drain below resumes delivery).
 */
export function reconstructActiveAttempts(meshId: string): RecoveredAttempt[] {
    try {
        return MeshRuntimeStore.getInstance().listActiveTurnAttempts(meshId).map(a => ({
            attemptId: a.attemptId,
            taskId: a.taskId,
            stage: a.stage,
            sessionId: a.sessionId,
            nodeId: a.nodeId,
            dispatchNonce: a.dispatchNonce,
            leaseDeadlineMs: a.leaseDeadlineMs,
            redriveCount: a.redriveCount,
        }));
    } catch {
        return [];
    }
}

// ─── Durable outbox (outbound ACK/completion delivery) ─────────────────────

export type TurnOutboxKind = 'coordinator_completion' | 'coordinator_ack';

/**
 * Enqueue a coordinator-bound terminal notification in the SAME commit window as
 * the reducer's terminal decision. The row id is the attempt's terminal event id
 * (`<attemptId>:terminal`), so re-enqueue after a crash/replay is INSERT OR IGNORE
 * — exactly one logical completion notification per attempt, even though the
 * transport underneath remains at-least-once.
 */
export function enqueueTerminalOutbox(args: {
    meshId: string;
    taskId: string;
    attemptId: string;
    outcome: TurnTerminalOutcome;
    /** The PendingMeshCoordinatorEvent-shaped payload (content per the v2 envelope). */
    payload: Record<string, unknown>;
    nowMs?: number;
}): boolean {
    const nowMs = args.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    return MeshRuntimeStore.getInstance().enqueueTurnOutbox({
        id: `${args.attemptId}:terminal`,
        meshId: args.meshId,
        attemptId: args.attemptId,
        taskId: args.taskId,
        kind: 'coordinator_completion',
        payload: JSON.stringify({ outcome: args.outcome, ...args.payload }),
        createdAt: nowIso,
        updatedAt: nowIso,
    });
}

/**
 * Drain due outbox rows through `deliver`. A row is marked delivered ONLY after the
 * handler resolves; a failure reschedules with backoff and survives restarts
 * (status stays 'pending'). Returns delivery counts for observability/tests.
 */
export async function drainTurnOutbox(
    deliver: (row: { id: string; meshId: string; taskId: string | null; attemptId: string | null; kind: string; payload: Record<string, unknown> }) => Promise<void>,
    opts?: { meshId?: string; nowMs?: number; maxAttempts?: number; backoffMs?: (attemptCount: number) => number },
): Promise<{ delivered: number; failed: number; rescheduled: number }> {
    const store = MeshRuntimeStore.getInstance();
    const nowMs = opts?.nowMs ?? Date.now();
    const maxAttempts = opts?.maxAttempts ?? 8;
    const backoffMs = opts?.backoffMs ?? ((n: number) => Math.min(60_000, 1000 * 2 ** Math.max(0, n - 1)));
    const due = store.listDueTurnOutbox(nowMs, opts?.meshId);
    let delivered = 0;
    let failed = 0;
    let rescheduled = 0;
    for (const row of due) {
        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse(row.payload) as Record<string, unknown>; } catch { /* deliver empty */ }
        try {
            await deliver({
                id: row.id,
                meshId: row.meshId,
                taskId: row.taskId,
                attemptId: row.attemptId,
                kind: row.kind,
                payload,
            });
            store.markTurnOutboxDelivered(row.id, new Date(nowMs).toISOString());
            delivered += 1;
        } catch (err: any) {
            const nextAttemptCount = row.attemptCount + 1;
            const terminal = nextAttemptCount >= maxAttempts;
            store.markTurnOutboxAttemptFailed(row.id, {
                updatedAt: new Date(nowMs).toISOString(),
                nextAttemptAtMs: terminal ? null : nowMs + backoffMs(nextAttemptCount),
                terminal,
            });
            if (terminal) {
                failed += 1;
                LOG.warn('TurnLedger', `Outbox row ${row.id} (${row.kind}, task ${row.taskId ?? '?'}) exhausted ${maxAttempts} delivery attempts: ${err?.message || err}`);
            } else {
                rescheduled += 1;
            }
        }
    }
    return { delivered, failed, rescheduled };
}

// ─── Evidence-collection / destructive-stop ordering ───────────────────────

/**
 * Per-session serialization chain for evidence reads and destructive actions
 * (stop/kill/teardown). The historical 6ms race: a transcript evidence read ran
 * CONCURRENTLY with a destructive stop against the same session, and teardown
 * destroyed the only evidence source before the read completed. Chaining BOTH onto
 * one per-key promise makes the ordering structural: a stop requested while an
 * evidence read is in flight executes strictly AFTER the read (and the reducer
 * decision built on it) resolves — never concurrently.
 *
 * In-memory by design: the race window is a single-process scheduling artifact.
 * Cross-restart evidence is durable in the turn tables themselves.
 */
const sessionOrderChains = new Map<string, Promise<unknown>>();

function enqueueSessionOrdered<T>(sessionKey: string, fn: () => Promise<T> | T): Promise<T> {
    const prior = sessionOrderChains.get(sessionKey) ?? Promise.resolve();
    const next = prior.then(fn, fn) as Promise<T>;
    // Keep the chain settled-proof: a rejection must not poison later actions.
    sessionOrderChains.set(sessionKey, next.catch(() => undefined));
    return next;
}

/**
 * Run an evidence collection (transcript read / native-history probe / status read)
 * for a session, strictly ordered against any queued destructive action for the
 * same session.
 */
export function runSessionEvidenceCollection<T>(sessionKey: string, collect: () => Promise<T> | T): Promise<T> {
    return enqueueSessionOrdered(sessionKey, collect);
}

/**
 * Run a destructive action (stop/kill/teardown) for a session, strictly AFTER every
 * evidence collection already queued for that session has resolved and its reducer
 * decision has been made.
 */
export function runSessionDestructiveAction<T>(sessionKey: string, act: () => Promise<T> | T): Promise<T> {
    return enqueueSessionOrdered(sessionKey, act);
}

export function __resetSessionOrderChainsForTests(): void {
    sessionOrderChains.clear();
}

// ─── Stage 6 projection boundary ───────────────────────────────────────────

export interface TurnAttemptProjection {
    attemptId: string;
    meshId: string;
    taskId: string;
    attemptSeq: number;
    stage: TurnStage;
    terminalOutcome: TurnTerminalOutcome | null;
    terminalReason: string | null;
    sessionId: string | null;
    nodeId: string | null;
    providerType: string | null;
    coordinatorDaemonId: string | null;
    coordinatorSessionId: string | null;
    dispatchNonce: number | null;
    redriveCount: number;
    acceptedAt: string | null;
    deliveredAt: string | null;
    consumedAt: string | null;
    terminalAt: string | null;
    updatedAt: string;
}

/**
 * The read-only projection Stage 6 consumes. Deliberately small and stable: Stage 6
 * maps these onto the dashboard/read_chat/mesh_status presentation surfaces WITHOUT
 * this stage refactoring those surfaces.
 */
export function projectTurnAttempt(meshId: string, taskId: string): TurnAttemptProjection | null {
    try {
        const row = MeshRuntimeStore.getInstance().getCurrentTurnAttempt(meshId, taskId);
        return row ? toProjection(row) : null;
    } catch {
        return null;
    }
}

export function projectTurnAttemptsForMesh(meshId: string, opts?: { activeOnly?: boolean }): TurnAttemptProjection[] {
    try {
        const store = MeshRuntimeStore.getInstance();
        const rows = opts?.activeOnly ? store.listActiveTurnAttempts(meshId) : [];
        return rows.map(toProjection);
    } catch {
        return [];
    }
}

function toProjection(row: MeshTurnAttemptRow): TurnAttemptProjection {
    return {
        attemptId: row.attemptId,
        meshId: row.meshId,
        taskId: row.taskId,
        attemptSeq: row.attemptSeq,
        stage: row.stage as TurnStage,
        terminalOutcome: (row.terminalOutcome as TurnTerminalOutcome | null) ?? null,
        terminalReason: row.terminalReason,
        sessionId: row.sessionId,
        nodeId: row.nodeId,
        providerType: row.providerType,
        coordinatorDaemonId: row.coordinatorDaemonId,
        coordinatorSessionId: row.coordinatorSessionId,
        dispatchNonce: row.dispatchNonce,
        redriveCount: row.redriveCount,
        acceptedAt: row.acceptedAt,
        deliveredAt: row.deliveredAt,
        consumedAt: row.consumedAt,
        terminalAt: row.terminalAt,
        updatedAt: row.updatedAt,
    };
}

// ─── Internals ──────────────────────────────────────────────────────────────

/**
 * Serialize content-free evidence metadata. Defense-in-depth: never persist prompt
 * or transcript bodies through the turn ledger — truncate any accidental long
 * string so a caller mistake cannot leak content into the durable log.
 */
function safeEvidenceJson(evidence: Record<string, unknown>): string {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(evidence)) {
        if (typeof value === 'string') {
            sanitized[key] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
        } else if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
            sanitized[key] = value ?? null;
        } else {
            sanitized[key] = '[object]';
        }
    }
    try {
        return JSON.stringify(sanitized);
    } catch {
        return '{}';
    }
}
