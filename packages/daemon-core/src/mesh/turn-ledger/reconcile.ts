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
// second writer. Mesh attempts are left alone: they already carry a
// `hard_ceiling` hold from `dispatch_accepted` (R1, persisted, survives a
// restart) that the turn scheduler's `sweepExpiredHolds` closes on its own
// (H5); reconciling them here would race that machinery for no benefit.
//
// TIMING (why this cannot run at `wireTurnLedger`/S7): hosted-session restore
// (`cliManager.restoreHostedSessions()`) runs in S8 `startLoops`, AFTER S7
// wires the turn ledger — `boot/stages/mesh-runtime.ts`'s own file header
// says so ("no session can spawn before S8 ... restore runs in startLoops").
// Calling this before restore has resolved would read an empty/partial
// `SessionRegistry` and misclassify every legitimately-restorable session as
// orphaned. The caller (`startLoops`) MUST invoke this only after
// `restoreHostedSessions()` has resolved, exactly once per boot.
// ---------------------------------------------------------------------------

import type { TurnEvidence } from '@adhdev/mesh-shared';
import type { TurnLedger } from './ledger.js';
import type { TurnAttempt } from './types.js';

export interface ReconcileOrphanedPlainAttemptsDeps {
    ledger: TurnLedger;
    /** True when the attempt's session is still live on THIS daemon (registry OR instance store — mirrors `resolveProbeLocation`). */
    isSessionLive(sessionId: string): boolean;
    observedBy?: string;
    now?: () => number;
    log?: { info(message: string): void; warn(message: string): void };
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
 * One-shot boot sweep: every OPEN plain attempt whose session is not live on
 * this daemon gets a synthetic `session_error{reason:'daemon_restart'}`
 * observation, closing it via the reducer's R21 (`nonterminal` → `failed`).
 * Idempotent — an already-terminal attempt is never open, so a second call
 * (or a call with nothing to close) is a no-op read.
 */
export function reconcileOrphanedPlainAttempts(deps: ReconcileOrphanedPlainAttemptsDeps): ReconcileOrphanedPlainAttemptsReport {
    const log = deps.log ?? NOOP_LOG;
    const now = deps.now ?? (() => Date.now());
    const observedBy = deps.observedBy ?? deps.ledger.selfDaemonId;
    const report: ReconcileOrphanedPlainAttemptsReport = { checked: 0, closed: 0, closedAttemptIds: [] };

    let candidates: TurnAttempt[];
    try {
        candidates = deps.ledger.store.listOpenAttempts({ ownerDaemonId: observedBy }).filter(isOrphanCandidate);
    } catch (error) {
        log.warn(`turn-ledger: orphaned-plain-attempt reconciliation could not list open attempts: ${error instanceof Error ? error.message : String(error)}`);
        return report;
    }

    for (const attempt of candidates) {
        report.checked++;
        let live: boolean;
        try {
            live = deps.isSessionLive(attempt.sessionId);
        } catch {
            // A liveness-check failure must never close a session we could not
            // verify as gone — skip it, the next boot (or a later probe) retries.
            continue;
        }
        if (live) continue;

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
                log.warn(`turn-ledger: orphaned-plain-attempt reconciliation observed ${attempt.attemptId} with unexpected verdict ${result.verdict}${result.rejection ? `/${result.rejection}` : ''}`);
            }
        } catch (error) {
            log.warn(`turn-ledger: orphaned-plain-attempt reconciliation failed for ${attempt.attemptId}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    if (report.closed > 0) {
        log.info(`turn-ledger: closed ${report.closed} orphaned plain attempt(s) after restart`);
    }
    return report;
}
