/**
 * Redrive coverage + quarantine diagnostics — the 5a→5b gate's evidence
 * (Stage 5, 5a-3) plus the 5a-4 quarantine health surface.
 *
 * Design: docs/design/2026-08-29-seqscribe-outbox-migration.md §7 5a-3, §11-3.
 * "지표 신설: redrive 주입 수, 커서 lag, outbox drain delivered 수의 대응
 * 관계 계측(같은 터미널에 대해 양쪽이 발동한 비율 = 커버리지)."
 *
 * ── What "coverage" means here ──────────────────────────────────────────────
 * The gate's proposition is a SUBSET claim, not a ratio one:
 *
 *     every terminal the outbox delivered was ALSO independently re-armed by
 *     redrive          ⟺   outboxDelivered(set) ⊆ redriveInjected(set)
 *
 * So this file computes that subset relation over TASK ID SETS. `coveragePercent`
 * is `|delivered ∩ injected| / |delivered|`, and `fullyCovered` is the boolean
 * the gate actually reads.
 *
 * ★ THIS REPLACES A RUNNING-TOTAL RATIO, WHICH COULD NOT EXPRESS THE CLAIM.
 * The previous implementation divided two cumulative counters. That was wrong in
 * both directions and neither is hypothetical:
 *
 *   · FALSE NEGATIVE (epoch mismatch) — `countTurnOutboxByStatus` counts rows
 *     over the whole table, and `delivered` rows are never pruned (there is no
 *     `DELETE FROM mesh_turn_outbox` anywhere in the tree). The redrive counter
 *     is in-memory and resets at boot. So the denominator spanned all daemon
 *     generations while the numerator spanned one, and any restarted daemon
 *     reported <100% forever — the older the DB, the closer to 0%.
 *   · FALSE POSITIVE (no join) — comparing totals cannot tell whether the two
 *     paths covered the SAME terminals. Redrive re-arming 10 tasks the outbox
 *     never delivered read as 100% (the ratio even clamped up to it), which is
 *     precisely the migration risk the gate exists to rule out.
 *
 * ── Epoch alignment ────────────────────────────────────────────────────────
 * The two sides are pinned to one window: the outbox side enumerates only rows
 * marked delivered at or after this process started
 * (`getRedriveEpochStartMs`), via `updated_at`, which
 * `markTurnOutboxDelivered` stamps at delivery time.
 *
 * ★ Why window the outbox rather than persist the redrive set: redrive state is
 * deliberately process-local (the 5a-4 quarantine is auto-resolving on restart
 * for the same reason), and the whole outbox machine is deleted in 5c. Making
 * the redrive set durable would add a store that exists only to be removed,
 * whereas windowing needs no new state at all. The cost is that coverage is a
 * statement about THIS process's lifetime — which is exactly the scope in which
 * "did redrive keep up with the outbox" is a meaningful question.
 *
 * ── Content boundary ───────────────────────────────────────────────────────
 * Every EXPORTED field is an integer count, a derived percentage, or a boolean.
 * Task ids are read internally for the join and never leave this function. Same
 * local-only contract as mesh-turn-outbox-diagnostics.ts: `mesh_status` /
 * `get_status_metadata` and the daemon log, never `status_report`.
 */

import { LOG } from '../logging/logger.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import {
    getTotalRedriveInjected,
    getQuarantinedMeshCount,
    getTotalQuarantineSkips,
    getRedriveInjectedTaskIds,
    getRedriveEpochStartMs,
} from './mesh-terminal-redrive.js';

/**
 * Upper bound on outbox rows pulled into the join.
 *
 * Bounds the query the same way `REDRIVE_TASK_ID_CAP` bounds the redrive set.
 * Hitting it means the window holds more delivered rows than we are willing to
 * enumerate, so the join would be over a truncated denominator — `coveragePercent`
 * goes `null` rather than reporting a number derived from part of the set.
 */
export const COVERAGE_JOIN_LIMIT = 10_000;

/** Local-only snapshot comparing redrive injections against outbox deliveries. */
export interface RedriveCoverageDiagnostics {
    /** Cumulative entries redrive has handed to the pending queue, across all meshes. */
    redriveInjected: number;
    /** Outbox rows marked `delivered` within the current coverage epoch. */
    outboxDelivered: number;
    /** Delivered tasks in the epoch that redrive also re-armed (`|∩|`). */
    coveredTerminals: number;
    /**
     * Delivered tasks in the epoch that redrive did NOT re-arm (`|delivered \ injected|`).
     * This is the number the 5a→5b gate needs at 0.
     */
    uncoveredTerminals: number;
    /**
     * `|delivered ∩ injected| / |delivered|` as a percentage (0-100).
     *
     * `null` means UNKNOWN, not 0 — either nothing has been delivered in this
     * epoch yet (a fresh/idle daemon, where 0% would read as a regression), or a
     * cap was hit and the join would be over a truncated set. A null is never
     * evidence of coverage; the gate must not treat it as a pass.
     */
    coveragePercent: number | null;
    /**
     * The gate's actual proposition: `outboxDelivered ⊆ redriveInjected` over the
     * epoch. False whenever any delivered task went un-re-armed, and false when
     * the answer is unknown (truncated join) — never optimistic.
     */
    fullyCovered: boolean;
    /** True when either side hit its cap, so the join is over a truncated set. */
    joinTruncated: boolean;
    /**
     * Meshes CURRENTLY quarantined (5a-4) — past the consecutive-failure
     * threshold and still inside the cooldown window. An aggregate count only:
     * no meshId, so this stays within the same local-only content boundary as
     * the rest of this file.
     */
    quarantinedMeshCount: number;
    /**
     * Cumulative entries skip-and-advanced across every mesh because their
     * mesh was quarantined at the time.
     */
    quarantineSkipsTotal: number;
}

/**
 * Read the current redrive-vs-outbox coverage plus quarantine health.
 *
 * Does one bounded SQL read (the epoch-windowed delivered task ids) and
 * otherwise only in-memory set arithmetic.
 */
export function readRedriveCoverageDiagnostics(_nowMs: number = Date.now()): RedriveCoverageDiagnostics {
    const { taskIds: injectedTaskIds, overflowed } = getRedriveInjectedTaskIds();
    const sinceIso = new Date(getRedriveEpochStartMs()).toISOString();

    let deliveredTaskIds: string[] = [];
    try {
        deliveredTaskIds = MeshRuntimeStore.getInstance()
            .listDeliveredTurnOutboxTaskIdsSince(sinceIso, COVERAGE_JOIN_LIMIT + 1);
    } catch {
        /* store unavailable (e.g. a daemon-less context) — report redrive counters only */
    }

    const deliveredTruncated = deliveredTaskIds.length > COVERAGE_JOIN_LIMIT;
    if (deliveredTruncated) deliveredTaskIds = deliveredTaskIds.slice(0, COVERAGE_JOIN_LIMIT);
    const joinTruncated = deliveredTruncated || overflowed;

    let coveredTerminals = 0;
    for (const taskId of deliveredTaskIds) {
        if (injectedTaskIds.has(taskId)) coveredTerminals++;
    }
    const outboxDelivered = deliveredTaskIds.length;
    const uncoveredTerminals = outboxDelivered - coveredTerminals;

    // null = unknown. Only a complete join over a non-empty denominator yields a
    // number, so neither an idle daemon nor a truncated read can masquerade as
    // coverage evidence.
    const coveragePercent = joinTruncated || outboxDelivered === 0
        ? null
        : (coveredTerminals / outboxDelivered) * 100;
    const fullyCovered = !joinTruncated && uncoveredTerminals === 0;

    if (joinTruncated) {
        LOG.warn(
            'MeshRedrive',
            `redrive coverage join truncated (deliveredRows=${outboxDelivered}`
            + `${deliveredTruncated ? '+' : ''}, redriveSetOverflowed=${overflowed}) — `
            + 'reporting coverage as unknown rather than a ratio over a partial set',
        );
    }

    return {
        redriveInjected: getTotalRedriveInjected(),
        outboxDelivered,
        coveredTerminals,
        uncoveredTerminals,
        coveragePercent,
        fullyCovered,
        joinTruncated,
        quarantinedMeshCount: getQuarantinedMeshCount(_nowMs),
        quarantineSkipsTotal: getTotalQuarantineSkips(),
    };
}
