/**
 * Turn-outbox ENQUEUE POLICY — Stage 5b-1 (new rows blocked, drain keeps going).
 *
 * Design: docs/design/2026-08-29-seqscribe-outbox-migration.md §7 "5b — 전환", 1:
 *
 *   "`enqueueTerminalOutbox` 호출을 플래그로 중단(신규 행 0). drain은 잔여
 *    pending 행 한정으로 유지해 백로그를 0으로 소진."
 *
 * ── The scope of 5b-1, precisely ──────────────────────────────────────────────
 * This file blocks ONE thing: the reducer's committed-terminal `enqueueTerminalOutbox`
 * call (mesh-event-forwarding.ts, the sole production producer — verified by grep,
 * the design doc's "생산자(유일)" claim holds). It does NOT touch:
 *
 *   · `drainTurnOutbox` / `drainMeshTurnOutbox`      — must keep draining the
 *   · the commit-time drain trigger (①)                residue to zero. Disabling
 *   · the reconcile-tick drain pump (②)                the triggers is 5b-2, and
 *   · the boot recovery drain (③)                      doing it here would strand
 *                                                      whatever is already queued.
 *
 * A blocked enqueue is a no-op that returns `false`, i.e. exactly what the
 * existing `INSERT OR IGNORE` duplicate path already returns. Every caller
 * already tolerates that value, so blocking cannot change control flow.
 *
 * ── ★ THE INTERLOCK — why this is not a plain independent flag ────────────────
 * The turn outbox and the 5a-2 redrive consumer are the TWO independent paths that
 * re-arm a terminal completion notification. During 5a both run (the pending-queue
 * fingerprint dedup collapses whichever arrives second). 5b-1 removes one of them.
 *
 * ★ So the combination "enqueue blocked AND redrive off" has NO redelivery path at
 * all: a terminal committed but not reaching the coordinator's pending queue — a
 * crash between the reducer commit and the queue write, exactly the window the
 * outbox exists for — is then lost permanently and silently. That is strictly
 * worse than either pre-5a state, and it is reachable by a single env typo
 * (`ADHDEV_SEQSCRIBE_TERMINAL_REDRIVE=ON` is not `on`; the redrive flag is a
 * strict `=== 'on'` match, so a near-miss silently reads as OFF while the operator
 * believes redrive is running).
 *
 * ★ This module therefore makes the block CONDITIONAL rather than independent:
 * `ADHDEV_MESH_OUTBOX_ENQUEUE=off` alone does nothing unless redrive is also
 * enabled. The unsafe combination is not merely warned about — it is REFUSED,
 * and the outbox keeps enqueueing. The rationale for refusing rather than warning
 * is the same one §11-3 used to choose an auto-resolving quarantine over a WARN:
 * a warning does not stop the loss it describes, and the loss here (a completion
 * notification that never arrives) is invisible at the moment it happens — the
 * coordinator simply waits forever for a worker that already finished.
 *
 * The refusal is not silent: `resolveOutboxEnqueuePolicy` reports the
 * `redrive_disabled` reason, the boot log states it once, and the reason is
 * exposed on `get_status_metadata` (5a-1 / 5a-3 pattern) so "I set the flag but
 * rows keep appearing" is answerable without reading the source.
 *
 * ── Default ────────────────────────────────────────────────────────────────
 * OFF (= enqueue continues). Both flags absent means Stage 5a behaviour,
 * unchanged. Rollback from 5b-1 is dropping `ADHDEV_MESH_OUTBOX_ENQUEUE`, exactly
 * as §7 requires ("롤백 = 플래그 복귀").
 *
 * ── Content boundary ───────────────────────────────────────────────────────
 * Everything exported is a boolean, an integer, or a fixed enum reason string.
 * No mesh/task/session identifiers, no free text. Local surfaces only
 * (`get_status_metadata` / daemon log), never `status_report`.
 */

import { isTerminalRedriveEnabled, REDRIVE_ENV } from './mesh-terminal-redrive.js';

/**
 * Env flag requesting the 5b-1 enqueue block.
 *
 * ★ Spelled as a DISABLE of an existing behaviour (`=off`) rather than an enable
 * of a new one, because the thing being flagged is the removal of a safety
 * backstop. `ADHDEV_MESH_OUTBOX_ENQUEUE` absent = enqueue on = today's behaviour;
 * anything other than the exact string `off` also means on, so a typo fails
 * toward keeping the backstop rather than dropping it.
 */
export const OUTBOX_ENQUEUE_ENV = 'ADHDEV_MESH_OUTBOX_ENQUEUE';

/** Why enqueue is (or is not) blocked. Fixed vocabulary — safe to log and surface. */
export type OutboxEnqueueBlockReason =
    /** No block requested — `ADHDEV_MESH_OUTBOX_ENQUEUE` is absent or not `off`. */
    | 'not_requested'
    /**
     * ★ A block WAS requested but is REFUSED: the 5a-2 redrive consumer is not
     * enabled, so honouring it would leave no redelivery path at all.
     */
    | 'redrive_disabled'
    /** Block requested and honoured — the redrive leg is the redelivery path. */
    | 'blocked';

export interface OutboxEnqueuePolicy {
    /** True only when new rows are actually suppressed. */
    blocked: boolean;
    /** True when the operator asked for the block, regardless of whether it was honoured. */
    requested: boolean;
    /** True when the redrive leg (the replacement path) is enabled. */
    redriveEnabled: boolean;
    /** Fixed-vocabulary explanation. `redrive_disabled` is the refused-unsafe case. */
    reason: OutboxEnqueueBlockReason;
}

/**
 * Resolve the enqueue policy from an env snapshot.
 *
 * Pure and env-injected (not reading `process.env` itself) so both the boot
 * wiring and the gates evaluate the SAME function rather than re-deriving the
 * interlock — a duplicated derivation is how "the check exists but the hot path
 * skips it" happens.
 */
export function resolveOutboxEnqueuePolicy(
    env: Record<string, string | undefined>,
): OutboxEnqueuePolicy {
    const requested = env[OUTBOX_ENQUEUE_ENV] === 'off';
    const redriveEnabled = isTerminalRedriveEnabled(env);
    if (!requested) {
        return { blocked: false, requested: false, redriveEnabled, reason: 'not_requested' };
    }
    if (!redriveEnabled) {
        // ★ Refuse. See the interlock note in the module header.
        return { blocked: false, requested: true, redriveEnabled: false, reason: 'redrive_disabled' };
    }
    return { blocked: true, requested: true, redriveEnabled: true, reason: 'blocked' };
}

/**
 * The one question the producer asks. Reads live `process.env` so a flag flip
 * takes effect on the next terminal without a restart — the rollback story in §7
 * is "플래그 복귀", and a value frozen at boot would make that a restart.
 */
export function isTurnOutboxEnqueueBlocked(
    env: Record<string, string | undefined> = process.env,
): boolean {
    return resolveOutboxEnqueuePolicy(env).blocked;
}

/**
 * Terminals whose outbox row this process suppressed because the block was in
 * force. Process-local, same scope as the redrive counters it is read beside —
 * and for the same reason: the whole machine is deleted in 5c, so a durable
 * store here would exist only to be removed.
 *
 * ★ This is the number that makes "new rows 0" OBSERVABLE rather than merely
 * asserted. A zero backlog on its own is ambiguous — it also describes an idle
 * daemon that produced no terminals at all. `suppressed > 0` with `backlogPending`
 * falling is the actual 5b-1 signature.
 */
let enqueueBlockedCount = 0;

/** Count one suppressed enqueue. Called from the producer's block branch. */
export function recordOutboxEnqueueBlocked(): void {
    enqueueBlockedCount++;
}

/** Terminals suppressed by the block since boot (or the last test reset). */
export function getOutboxEnqueueBlockedCount(): number {
    return enqueueBlockedCount;
}

/** Reset the suppression counter. TESTS ONLY. */
export function __resetOutboxEnqueuePolicyForTests(): void {
    enqueueBlockedCount = 0;
}

/**
 * One-line boot statement of the policy, or null when nothing was requested.
 *
 * Returned rather than logged here so the caller owns the log channel (and so
 * this module stays free of a logger import, keeping it trivially testable).
 */
export function describeOutboxEnqueuePolicy(
    env: Record<string, string | undefined> = process.env,
): string | null {
    const policy = resolveOutboxEnqueuePolicy(env);
    if (!policy.requested) return null;
    if (policy.reason === 'redrive_disabled') {
        return `${OUTBOX_ENQUEUE_ENV}=off REFUSED — ${REDRIVE_ENV} is not 'on', so blocking turn-outbox `
            + 'enqueue would leave NO terminal-notification redelivery path (Stage 5b-1 interlock). '
            + 'The outbox keeps enqueueing. Enable the redrive leg first, then re-apply the block.';
    }
    return `${OUTBOX_ENQUEUE_ENV}=off honoured — turn-outbox enqueue blocked (Stage 5b-1); `
        + 'the seqscribe redrive leg is the redelivery path and existing rows keep draining to zero.';
}
