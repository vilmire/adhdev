/**
 * Turn-outbox DRAIN TRIGGER POLICY — Stage 5b-2 (periodic + boot pumps disarmed).
 *
 * Design: docs/design/2026-08-29-seqscribe-outbox-migration.md §7 "5b — 전환", 2:
 *
 *   "`mesh_turn_outbox` 잔여 pending 0 확인 후 drain 트리거 ②③ 비활성."
 *
 * ── The three triggers, and why this file disarms exactly two ────────────────
 * §5 of the design enumerates them (rows 4/5/6):
 *
 *   ① commit-time  — `scheduleTurnOutboxDrain()` (mesh-event-suppression.ts),
 *                     a coalesced `setImmediate` fired from the reducer's
 *                     committed-terminal branch, immediately after the
 *                     `enqueueTerminalOutbox` call it exists to flush.
 *   ② reconcile tick — `drainMeshTurnOutbox()` in the reconcile loop's PHASE 0.1
 *                     (mesh-reconcile-loop.ts), every ~4s. The design calls this
 *                     "their retry pump".
 *   ③ boot recovery — one `drainMeshTurnOutbox()` inside `setupMeshReconcileLoop`
 *                     (mesh-reconcile-loop.ts), replaying rows committed before a
 *                     crash.
 *
 * ★ The design names ②③ and NOT ①, and that asymmetry is deliberate rather than
 * an oversight — §5 row 4 assigns trigger ① its own removal step in **5c**, not
 * 5b-2. The reason is structural: ① is fired from inside the very `try` block
 * that calls `enqueueTerminalOutbox`, so once 5b-1 blocks enqueue, ① is reached
 * only on a terminal whose row was just suppressed. It therefore drains nothing
 * new by construction. ②③ are different in kind — they are unconditional pumps
 * that sweep the table on a timer and at boot regardless of whether anything
 * produced a row, and those are the two that keep the legacy machine running
 * after its producer is gone.
 *
 * ★ Keeping ① through 5b is also the deliberate SAFETY margin. If a stray row
 * somehow appears while ②③ are disarmed (a bypassed producer, a hand-inserted
 * row, a rollback of 5b-1 without a rollback of 5b-2), ① is the one remaining
 * path that still flushes it. Disarming all three would strand it until 5c drops
 * the table — silently, since nothing else reads `mesh_turn_outbox`.
 *
 * ── ★ THE PRECONDITION — this is not a plain flag either ─────────────────────
 * §7 does not say "disable ②③". It says "잔여 pending 0 **확인 후**" — disable
 * them AFTER confirming the residue is zero. That ordering is the whole safety
 * property: ②③ are what drains the residue, so disarming them while rows are
 * still pending strands exactly those rows. They stop being delivered and nothing
 * reports it, because the coordinator's view of a completion that never arrives
 * is indistinguishable from a worker still working.
 *
 * So, exactly as 5b-1 made its block conditional on the redrive leg, this module
 * makes the disarm conditional on TWO things, and REFUSES rather than warns:
 *
 *   1. **5b-1 must be in force.** If new rows are still being enqueued,
 *      disarming the pumps means the backlog grows monotonically with only
 *      trigger ① to flush it. Reason: `enqueue_active`.
 *   2. **Residue pending must be observed at 0 on `REQUIRED_CLEAN_SWEEPS`
 *      CONSECUTIVE sweeps.** Reason: `residue_pending`.
 *
 * ── ★ Why CONSECUTIVE sweeps rather than one look ────────────────────────────
 * The 5b→5c gate in §7 asks for "잔여 행 0이 스윕 연속 충족" — consecutive, not
 * once. A single observation of `pending === 0` is genuinely ambiguous, and the
 * ambiguity is not theoretical:
 *
 *   · `listDueTurnOutbox` selects `status='pending' AND next_attempt_at_ms<=now`.
 *     A row that failed delivery is rescheduled with backoff up to 60s while
 *     KEEPING `status='pending'`. It is invisible to a due-query in the gap but
 *     very much still there.
 *   · `countTurnOutboxByStatus` does count it (it filters on status, not on
 *     due-ness), which is why this module counts by STATUS and never by due-ness.
 *     But a fresh terminal can still land between two reads.
 *
 * Requiring N consecutive clean sweeps, where the sweep cadence is the reconcile
 * tick that also drives trigger ②, means the window observed spans several
 * backoff-and-retry opportunities rather than one instant. Any pending row —
 * due now, or sleeping off a backoff — resets the streak to zero.
 *
 * ★ The 5b-1 worker explicitly left this rule out of its scope, noting it was a
 * precondition of 5b-2 rather than of 5b-1. This module is where it lands.
 *
 * ── Sweep bookkeeping is process-local, and that is the safe direction ───────
 * The streak lives in memory and starts at zero every boot. A restart therefore
 * costs `REQUIRED_CLEAN_SWEEPS` ticks (~20s at the default 4s cadence) before the
 * disarm re-engages, during which ②③ keep running — i.e. a restart fails toward
 * DRAINING, which is the pre-5b-2 behaviour and cannot lose anything. A durable
 * streak would do the opposite: it would let a freshly booted daemon skip its
 * boot drain (③) on the strength of an observation made by a previous process,
 * before this one has looked at the table even once. That is precisely the case
 * ③ exists for.
 *
 * ── Default ──────────────────────────────────────────────────────────────────
 * OFF (= both pumps keep running). `ADHDEV_MESH_OUTBOX_DRAIN` absent means Stage
 * 5b-1 behaviour, unchanged. Rollback is dropping the flag ("롤백 = 플래그 복귀").
 *
 * ★ Spelled as a DISABLE (`=off`) matching 5b-1's `ADHDEV_MESH_OUTBOX_ENQUEUE`,
 * so a typo (`OFF`, `false`, `0`) fails toward KEEPING the drain pumps rather
 * than dropping them.
 *
 * ── Content boundary ─────────────────────────────────────────────────────────
 * Everything exported is a boolean, an integer, or a fixed enum reason string.
 * No mesh/task/session identifiers, no free text. Local surfaces only
 * (`get_status_metadata` / daemon log), never `status_report`.
 */

import { resolveOutboxEnqueuePolicy } from './mesh-turn-outbox-enqueue-policy.js';

/**
 * Env flag requesting the 5b-2 trigger disarm. See the spelling note in the
 * module header: absent, or anything other than the exact string `off`, means
 * the pumps keep running.
 */
export const OUTBOX_DRAIN_ENV = 'ADHDEV_MESH_OUTBOX_DRAIN';

/**
 * Consecutive clean sweeps required before the disarm engages.
 *
 * At the default reconcile cadence (~4s) this is ~20s of continuously-empty
 * backlog. Chosen to comfortably exceed a single retry-backoff step so a row
 * sleeping between attempts cannot hide inside the streak — the backoff ladder
 * starts at 1s and the first several steps all fall inside this window.
 */
export const REQUIRED_CLEAN_SWEEPS = 5;

/** Why the drain triggers are (or are not) disarmed. Fixed vocabulary — safe to log. */
export type OutboxDrainDisableReason =
    /** No disarm requested — `ADHDEV_MESH_OUTBOX_DRAIN` is absent or not `off`. */
    | 'not_requested'
    /**
     * ★ Disarm REFUSED: Stage 5b-1's enqueue block is not in force, so rows are
     * still being produced. Disarming the pumps would let the backlog grow.
     */
    | 'enqueue_active'
    /**
     * ★ Disarm REFUSED: the residue has not yet been observed empty on
     * `REQUIRED_CLEAN_SWEEPS` consecutive sweeps. This covers both "rows are
     * pending right now" and "the streak has not accumulated yet".
     */
    | 'residue_pending'
    /** Disarm requested, precondition met, triggers ②③ are off. */
    | 'disabled';

export interface OutboxDrainPolicy {
    /** True only when triggers ②③ are actually suppressed. */
    disabled: boolean;
    /** True when the operator asked for the disarm, regardless of whether it was honoured. */
    requested: boolean;
    /** True when Stage 5b-1's enqueue block is in force (precondition 1). */
    enqueueBlocked: boolean;
    /** Consecutive sweeps observing an empty backlog (capped at the requirement). */
    cleanSweeps: number;
    /** True when `cleanSweeps` has reached `REQUIRED_CLEAN_SWEEPS` (precondition 2). */
    residueClear: boolean;
    /** Fixed-vocabulary explanation. Both refusal reasons are distinguishable. */
    reason: OutboxDrainDisableReason;
}

/**
 * Consecutive sweeps that observed `pending === 0`.
 *
 * Process-local by design — see the module header on why a durable streak would
 * be the unsafe direction (it would let a fresh process skip its boot drain).
 */
let cleanSweepStreak = 0;

/** Sweeps that reset the streak because residue was still present. Diagnostics only. */
let residueObservations = 0;

/**
 * Record one residue observation. Called from the sweep site (the reconcile tick),
 * which is also the cadence the streak is denominated in.
 *
 * ★ Takes the pending COUNT, not a due-row count: a row sleeping off its retry
 * backoff is still `status='pending'` and must reset the streak even though a
 * due-query would not see it (module header).
 *
 * Returns the streak after the update, so the caller can log a transition without
 * a second read.
 */
export function recordOutboxResidueSweep(pendingCount: number): number {
    if (pendingCount > 0) {
        cleanSweepStreak = 0;
        residueObservations++;
        return 0;
    }
    if (cleanSweepStreak < REQUIRED_CLEAN_SWEEPS) cleanSweepStreak++;
    return cleanSweepStreak;
}

/** Consecutive clean sweeps observed so far (capped at `REQUIRED_CLEAN_SWEEPS`). */
export function getOutboxCleanSweepStreak(): number {
    return cleanSweepStreak;
}

/** Sweeps that found residue and reset the streak, since boot. Diagnostics only. */
export function getOutboxResidueObservations(): number {
    return residueObservations;
}

/** Reset the sweep bookkeeping. TESTS ONLY. */
export function __resetOutboxDrainPolicyForTests(): void {
    cleanSweepStreak = 0;
    residueObservations = 0;
}

/**
 * Resolve the drain-trigger policy from an env snapshot.
 *
 * Pure with respect to env (the sweep streak is module state by construction) and
 * env-injected rather than reading `process.env` itself, so the boot wiring, the
 * trigger sites, and the gates all evaluate the SAME function. A duplicated
 * derivation is how "the check exists but the hot path skips it" happens.
 */
export function resolveOutboxDrainPolicy(
    env: Record<string, string | undefined>,
): OutboxDrainPolicy {
    const requested = env[OUTBOX_DRAIN_ENV] === 'off';
    const enqueueBlocked = resolveOutboxEnqueuePolicy(env).blocked;
    const residueClear = cleanSweepStreak >= REQUIRED_CLEAN_SWEEPS;
    if (!requested) {
        return {
            disabled: false,
            requested: false,
            enqueueBlocked,
            cleanSweeps: cleanSweepStreak,
            residueClear,
            reason: 'not_requested',
        };
    }
    // ★ Precondition 1 is checked FIRST and reported distinctly: "you skipped
    // 5b-1" and "the residue has not cleared yet" are different operator actions
    // (enable the enqueue block vs. wait), and collapsing them into one reason
    // would make the first look like the second and invite waiting forever.
    if (!enqueueBlocked) {
        return {
            disabled: false,
            requested: true,
            enqueueBlocked: false,
            cleanSweeps: cleanSweepStreak,
            residueClear,
            reason: 'enqueue_active',
        };
    }
    if (!residueClear) {
        return {
            disabled: false,
            requested: true,
            enqueueBlocked: true,
            cleanSweeps: cleanSweepStreak,
            residueClear: false,
            reason: 'residue_pending',
        };
    }
    return {
        disabled: true,
        requested: true,
        enqueueBlocked: true,
        cleanSweeps: cleanSweepStreak,
        residueClear: true,
        reason: 'disabled',
    };
}

/**
 * The one question triggers ②③ ask. Reads live `process.env` so a flag flip takes
 * effect on the next tick without a restart — the rollback story in §7 is "플래그
 * 복귀", and a value frozen at boot would make that a restart.
 */
export function areOutboxDrainTriggersDisabled(
    env: Record<string, string | undefined> = process.env,
): boolean {
    return resolveOutboxDrainPolicy(env).disabled;
}

/**
 * Drain sweeps this process suppressed because the disarm was in force.
 *
 * ★ This is the number that makes "triggers ②③ fired 0 times" OBSERVABLE rather
 * than merely asserted. A zero delivered-count on its own is ambiguous — it also
 * describes pumps that ran and found nothing due, which is the 5b-1 steady state.
 * `suppressed > 0` is the actual 5b-2 signature.
 */
let drainTriggersSuppressed = 0;

/** Count one suppressed drain trigger. Called from the ②③ short-circuits. */
export function recordOutboxDrainTriggerSuppressed(): void {
    drainTriggersSuppressed++;
}

/** Drain triggers suppressed since boot (or the last test reset). */
export function getOutboxDrainTriggersSuppressed(): number {
    return drainTriggersSuppressed;
}

/** Reset the suppression counter. TESTS ONLY. */
export function __resetOutboxDrainSuppressionForTests(): void {
    drainTriggersSuppressed = 0;
}

/**
 * One-line boot statement of the policy, or null when nothing was requested.
 *
 * Returned rather than logged here so the caller owns the log channel (and so
 * this module stays free of a logger import, keeping it trivially testable).
 *
 * ★ Note the boot-time reading of a requested-but-unmet disarm is ALWAYS one of
 * the refusal reasons, because the sweep streak is necessarily 0 at boot. That is
 * correct and not a bug to paper over: at boot the residue is genuinely unknown
 * to this process, so trigger ③ must run.
 */
export function describeOutboxDrainPolicy(
    env: Record<string, string | undefined> = process.env,
): string | null {
    const policy = resolveOutboxDrainPolicy(env);
    if (!policy.requested) return null;
    if (policy.reason === 'enqueue_active') {
        return `${OUTBOX_DRAIN_ENV}=off REFUSED — the Stage 5b-1 enqueue block is not in force, so new `
            + 'outbox rows are still being produced. Disarming the periodic and boot drains now would '
            + 'let that backlog grow with only the commit-time trigger to flush it. Apply the 5b-1 '
            + 'block first, let the residue drain to zero, then re-apply this.';
    }
    if (policy.reason === 'residue_pending') {
        return `${OUTBOX_DRAIN_ENV}=off pending — the enqueue block is in force, but the residue has not `
            + `yet been observed empty on ${REQUIRED_CLEAN_SWEEPS} consecutive sweeps `
            + `(streak ${policy.cleanSweeps}/${REQUIRED_CLEAN_SWEEPS}). The periodic and boot drains keep `
            + 'running until it has, which is what drains the residue in the first place. This is the '
            + 'expected state at boot — the streak always starts at zero.';
    }
    return `${OUTBOX_DRAIN_ENV}=off honoured — turn-outbox drain triggers ②(reconcile tick) and ③(boot) `
        + 'disarmed (Stage 5b-2); the residue was observed empty on '
        + `${REQUIRED_CLEAN_SWEEPS} consecutive sweeps and the seqscribe redrive leg is the delivery path. `
        + 'The commit-time trigger ① stays armed as the residual flush path until 5c.';
}
