/**
 * Turn outbox diagnostics — the missing read (Stage 5, 5a-1).
 *
 * `getTurnLedgerMetrics` (mesh-turn-ledger.ts) already computes the outbox
 * backlog age and per-status counts — `MeshRuntimeStore.oldestPendingTurnOutboxAgeMs`
 * / `countTurnOutboxByStatus` round-trip live in production on every call — but
 * NOTHING reads the two fields it returns. A `mesh_turn_outbox` backlog or a row
 * that exhausts its retry budget and parks as `failed` (mesh-turn-ledger.ts
 * `drainTurnOutbox`) is therefore invisible to any log, dashboard, or `mesh_status`
 * call today (2026-08-29 design doc §7-5a-1, verified by an exhaustive grep: the
 * only non-test callers of `getTurnLedgerMetrics` are inside this package's own
 * `test/mesh/*.test.ts`). This file is that missing read.
 *
 * ── Why a summary wrapper instead of exposing `getTurnLedgerMetrics` raw ──────
 * `getTurnLedgerMetrics` returns every turn-ledger counter (redrive suppression,
 * ACK latency, staleness, …), most of which is unrelated to the outbox. A
 * diagnostics consumer asking "is the outbox backlog healthy" should not have to
 * know the other dozen fields exist. `readTurnOutboxDiagnostics` narrows to the
 * two outbox fields and adds one derived read (`backlogPending`) so a caller does
 * not have to sum `outboxByStatus` itself.
 *
 * ── Content boundary ───────────────────────────────────────────────────────
 * Everything here is LOCAL-ONLY diagnostics: ages, counts, and outbox row
 * statuses (`pending` / `delivered` / `failed`). No task/session content, no
 * meshId/attemptId enumeration. This must never be added to a server-bound
 * status payload — see CLAUDE.md's server content boundary. It is intended for
 * the same local surfaces as `seqscribe/beacon-diagnostics.ts`: `mesh_status` /
 * `get_status_metadata` and the daemon log, never `status_report`.
 */

import { getTurnLedgerMetrics } from './mesh-turn-ledger.js';
import {
    resolveOutboxEnqueuePolicy,
    getOutboxEnqueueBlockedCount,
    type OutboxEnqueueBlockReason,
} from './mesh-turn-outbox-enqueue-policy.js';
import {
    resolveOutboxDrainPolicy,
    getOutboxDrainTriggersSuppressed,
    getOutboxResidueObservations,
    REQUIRED_CLEAN_SWEEPS,
    type OutboxDrainDisableReason,
} from './mesh-turn-outbox-drain-policy.js';

/** Local-only snapshot of the turn outbox's redrive-backstop health. */
export interface TurnOutboxDiagnostics {
    /** Age of the oldest still-`pending` outbox row, in ms. `null` = no pending rows. */
    oldestPendingAgeMs: number | null;
    /** Outbox row counts keyed by status (`pending` / `delivered` / `failed`). */
    byStatus: Record<string, number>;
    /**
     * Sum of `byStatus.pending` — the number of rows still awaiting a redrive
     * delivery. Derived here so a caller does not need to know the outbox's
     * status vocabulary just to answer "is anything stuck".
     */
    backlogPending: number;
    /**
     * Stage 5b-1: whether new rows are currently suppressed.
     *
     * ★ Read together with `backlogPending`, this is the whole 5b-1 picture:
     * `enqueueBlocked: true` with `backlogPending` draining toward 0 is the
     * intended transition state. `enqueueBlocked: false` with
     * `enqueueBlockReason: 'redrive_disabled'` is the REFUSED-unsafe case — the
     * operator asked for the block and the interlock declined it — which is the
     * single most likely "I set the flag and nothing happened" support question.
     */
    enqueueBlocked: boolean;
    /** Fixed-vocabulary reason for the enqueue state. Never carries identifiers. */
    enqueueBlockReason: OutboxEnqueueBlockReason;
    /**
     * Terminals whose outbox row this process suppressed. Distinguishes a working
     * block (>0 and rising) from an idle daemon (0) — a zero backlog alone cannot.
     */
    enqueueSuppressed: number;
    /**
     * Stage 5b-2: whether drain triggers ②(reconcile tick) and ③(boot) are
     * currently disarmed. Trigger ①(commit-time) is deliberately NOT covered —
     * it stays armed until 5c as the residual flush path
     * (mesh-turn-outbox-drain-policy.ts).
     */
    drainTriggersDisabled: boolean;
    /**
     * Fixed-vocabulary reason for the drain-trigger state. Never carries
     * identifiers.
     *
     * ★ The two refusal reasons answer different operator questions, which is why
     * they are not collapsed: `enqueue_active` means 5b-1 was skipped (action:
     * apply the enqueue block), `residue_pending` means the block is on but the
     * backlog has not been observed empty long enough yet (action: wait).
     */
    drainDisableReason: OutboxDrainDisableReason;
    /**
     * Consecutive sweeps that observed an empty backlog, capped at the
     * requirement. Read alongside `drainRequiredCleanSweeps`, this is the
     * progress bar for a `residue_pending` refusal.
     */
    drainCleanSweeps: number;
    /** Consecutive clean sweeps required before the disarm engages. */
    drainRequiredCleanSweeps: number;
    /**
     * Sweeps that found residue and reset the streak. A rising value while the
     * flag is set means rows keep appearing — i.e. something is still producing,
     * which is the state `enqueue_active` exists to catch.
     */
    drainResidueObservations: number;
    /**
     * Drain triggers this process suppressed. Makes "②③ fired 0 times"
     * observable rather than merely asserted — a zero delivered-count also
     * describes pumps that ran and found nothing.
     */
    drainTriggersSuppressed: number;
}

/**
 * Read the current turn outbox diagnostics. Delegates the arithmetic entirely to
 * `getTurnLedgerMetrics` (MeshRuntimeStore-backed, degrades to `null`/`{}` when
 * the store is unavailable — see that function's try/catch) and does no I/O of
 * its own, so a diagnostics read never adds new store contention.
 */
export function readTurnOutboxDiagnostics(nowMs: number = Date.now()): TurnOutboxDiagnostics {
    const metrics = getTurnLedgerMetrics(nowMs);
    // Live env read, matching the producer's own check — a value cached at module
    // load would report a stale policy after a flag flip, which is precisely when
    // someone is reading this surface.
    const policy = resolveOutboxEnqueuePolicy(process.env);
    const drainPolicy = resolveOutboxDrainPolicy(process.env);
    return {
        oldestPendingAgeMs: metrics.outboxOldestPendingAgeMs,
        byStatus: metrics.outboxByStatus,
        backlogPending: metrics.outboxByStatus.pending ?? 0,
        enqueueBlocked: policy.blocked,
        enqueueBlockReason: policy.reason,
        enqueueSuppressed: getOutboxEnqueueBlockedCount(),
        drainTriggersDisabled: drainPolicy.disabled,
        drainDisableReason: drainPolicy.reason,
        drainCleanSweeps: drainPolicy.cleanSweeps,
        drainRequiredCleanSweeps: REQUIRED_CLEAN_SWEEPS,
        drainResidueObservations: getOutboxResidueObservations(),
        drainTriggersSuppressed: getOutboxDrainTriggersSuppressed(),
    };
}
