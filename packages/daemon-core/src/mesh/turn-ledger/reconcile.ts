// ---------------------------------------------------------------------------
// turn-ledger/reconcile — close plain attempts orphaned by a daemon restart
// ---------------------------------------------------------------------------
// Wiring-unification follow-up (design §5, §11 stamp "2026-09-25 (02:30…)":
// "a plain attempt orphaned by a daemon restart stays `generating`").
//
// R0a opens a plain attempt on `turn_started` with NO hold (mesh attempts get
// `hard_ceiling`/`await_*` holds, R1 — a plain turn has no dispatcher to
// reclaim it through, so it gets nothing). If the session dies without
// `process_exit`/`session_error` evidence — a hard restart, `kill -9` — the
// attempt never closes: `turn_attempts` grows a phantom `generating` row
// forever, and `openAttemptForSession`/status/`turn_query`/the scheduler's
// expired-hold sweep all see it.
//
// This module feeds ONE synthetic `session_error{reason:'daemon_restart'}`
// observation through `ledger.observe()` per orphan — the reducer (R21) is
// still the only thing that mutates the attempt; this is a producer, not a
// second writer. The commit is an honest `failed` (never a completion).
// Mesh attempts are left alone: they already carry a `hard_ceiling` hold from
// `dispatch_accepted` (R1, persisted, survives a restart) that the turn
// scheduler's `sweepExpiredHolds` closes on its own (H5); reconciling them
// here would race that machinery for no benefit.
//
// Two passes, both once per boot:
//
// 1. `closeInterruptedPlainAttempts` — BEFORE hosted-session restore. Every
//    open plain attempt whose `acceptedAt` (R0a: the `turn_started` time)
//    predates this ledger incarnation
//    (`ledger.incarnationStartedAt`, captured once per process at S7) was
//    opened by a PREVIOUS daemon process, so a restart interrupted it —
//    whether or not its session comes back. Measured live 2026-10-07
//    (assistant-layer design, appendix B item 2): a coordinator turn was
//    mid-flight, the hosted session survived the restart and was restored
//    live + idle (`registered{origin:'restore'}`), and the liveness-only sweep
//    below kept its `generating` attempt open. The session's NEXT human
//    `turn_started` then resolved to it (`findOpenAttemptForSession`) and R32
//    absorbed it as activity: two turns folded into one attempt, committed
//    much later under the old attemptId, the first turn's committed edge
//    lost. This pass needs no liveness, so it runs before restore — no
//    restored session can emit a `turn_started` that lands on a stale attempt
//    first. If a restored session is in fact still mid-turn, its next busy
//    edge opens a fresh plain attempt via R0a. Running before restore also
//    keeps the time test sound: no session of this process exists yet, so no
//    attempt this process opened (e.g. from a retro `turn_started`, whose
//    `at` is back-dated by the short-gen window) can be misread as predating.
//
// 2. `reconcileOrphanedPlainAttempts` — AFTER restore resolves. Closes every
//    open plain attempt whose session is not live on this daemon. TIMING: hosted-
//    session restore (`cliManager.restoreHostedSessions()`) runs in S8
//    `startLoops`, AFTER S7 wires the turn ledger; calling the liveness pass
//    before restore has resolved would read an empty/partial `SessionRegistry`
//    and misclassify every legitimately-restorable session as orphaned.
// ---------------------------------------------------------------------------

import type { TurnEvidence } from '@adhdev/mesh-shared';
import type { TurnLedger } from './ledger.js';
import type { TurnAttempt } from './types.js';

interface ReconcileLedgerDeps {
    ledger: TurnLedger;
    observedBy?: string;
    now?: () => number;
    log?: { info(message: string): void; warn(message: string): void };
}

interface CloseInterruptedPlainAttemptsDeps extends ReconcileLedgerDeps {
    /**
     * Ledger-clock start of this daemon incarnation; an open plain attempt
     * accepted strictly before it was opened by a previous process. Defaults to
     * `ledger.incarnationStartedAt`.
     */
    incarnationStartedAt?: number;
}

interface ReconcileOrphanedPlainAttemptsDeps extends ReconcileLedgerDeps {
    /** True when the attempt's session is still live on THIS daemon (registry OR instance store — mirrors `resolveProbeLocation`). */
    isSessionLive(sessionId: string): boolean;
}

export interface ReconcileOrphanedPlainAttemptsReport {
    checked: number;
    closed: number;
    /** attemptId of every attempt closed (small boot-time count; fine to return in full). */
    closedAttemptIds: string[];
}

const NOOP_LOG = { info: () => {}, warn: () => {} };

function isOrphanCandidate(attempt: TurnAttempt): boolean {
    // Only plain scope: a mesh attempt (queue/direct) always carries a
    // persisted hard_ceiling hold from dispatch_accepted, so the scheduler's
    // own hold-expiry sweep (H5) closes it without help.
    return attempt.scope === 'plain';
}

/**
 * Shared sweep: list this daemon's open plain attempts, close each one
 * `shouldClose` selects via a `session_error{daemon_restart}` observation
 * (R21). `shouldClose` returning `null` = could not decide → leave it open.
 */
function sweepPlainAttempts(
    deps: ReconcileLedgerDeps,
    shouldClose: (attempt: TurnAttempt) => boolean | null,
    label: string,
): ReconcileOrphanedPlainAttemptsReport {
    const log = deps.log ?? NOOP_LOG;
    const now = deps.now ?? (() => Date.now());
    const observedBy = deps.observedBy ?? deps.ledger.selfDaemonId;
    const report: ReconcileOrphanedPlainAttemptsReport = { checked: 0, closed: 0, closedAttemptIds: [] };

    let candidates: TurnAttempt[];
    try {
        candidates = deps.ledger.store.listOpenAttempts({ ownerDaemonId: observedBy }).filter(isOrphanCandidate);
    } catch (error) {
        log.warn(`turn-ledger: ${label} reconciliation could not list open attempts: ${error instanceof Error ? error.message : String(error)}`);
        return report;
    }

    for (const attempt of candidates) {
        report.checked++;
        if (shouldClose(attempt) !== true) continue;

        const evidence: TurnEvidence = {
            eventId: `daemon_restart:${attempt.attemptId}:g${attempt.generation}`,
            at: now(),
            source: 'session_registry',
            sessionId: attempt.sessionId,
            attemptRef: { attemptId: attempt.attemptId, generation: attempt.generation },
            observedBy,
            kind: 'session_error',
            reason: 'daemon_restart',
        };
        try {
            const result = deps.ledger.observe(evidence);
            if (result.verdict === 'applied') {
                report.closed++;
                report.closedAttemptIds.push(attempt.attemptId);
            } else if (result.verdict !== 'rejected' || result.rejection !== 'already_terminal') {
                log.warn(`turn-ledger: ${label} reconciliation observed ${attempt.attemptId} with unexpected verdict ${result.verdict}${result.rejection ? `/${result.rejection}` : ''}`);
            }
        } catch (error) {
            log.warn(`turn-ledger: ${label} reconciliation failed for ${attempt.attemptId}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return report;
}

function predatesIncarnationFn(deps: CloseInterruptedPlainAttemptsDeps): (attempt: TurnAttempt) => boolean {
    const startedAt = deps.incarnationStartedAt ?? deps.ledger.incarnationStartedAt;
    if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return () => false;
    return (attempt) => attempt.acceptedAt < startedAt;
}

/**
 * Pass 1 (boot, BEFORE hosted-session restore): every OPEN plain attempt a
 * previous daemon incarnation opened (acceptedAt < incarnationStartedAt) is
 * closed via R21 (`failed`, `session_error`, evidence reason
 * `daemon_restart`), live session or not — so a restored session's next turn
 * opens a fresh attempt instead of being absorbed into the stale one (R32).
 * Idempotent.
 */
export function closeInterruptedPlainAttempts(deps: CloseInterruptedPlainAttemptsDeps): ReconcileOrphanedPlainAttemptsReport {
    const predates = predatesIncarnationFn(deps);
    const report = sweepPlainAttempts(deps, predates, 'interrupted-plain-attempt');
    if (report.closed > 0) {
        (deps.log ?? NOOP_LOG).info(`turn-ledger: closed ${report.closed} plain attempt(s) interrupted by the daemon restart`);
    }
    return report;
}

/**
 * Pass 2 (boot, AFTER hosted-session restore): every OPEN plain attempt whose
 * session is not live on this daemon gets a synthetic
 * `session_error{reason:'daemon_restart'}` observation, closing it via the
 * reducer's R21 (`nonterminal` → `failed`). Idempotent — an already-terminal
 * attempt is never open, so a second call (or a call with nothing to close)
 * is a no-op read.
 */
export function reconcileOrphanedPlainAttempts(deps: ReconcileOrphanedPlainAttemptsDeps): ReconcileOrphanedPlainAttemptsReport {
    const report = sweepPlainAttempts(deps, (attempt) => {
        try {
            return !deps.isSessionLive(attempt.sessionId);
        } catch {
            // A liveness-check failure must never close a session we could not
            // verify as gone — skip it, the next boot (or a later probe) retries.
            return null;
        }
    }, 'orphaned-plain-attempt');
    if (report.closed > 0) {
        (deps.log ?? NOOP_LOG).info(`turn-ledger: closed ${report.closed} orphaned plain attempt(s) after restart`);
    }
    return report;
}
