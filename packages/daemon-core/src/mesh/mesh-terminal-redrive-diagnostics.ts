/**
 * Terminal-redrive health surface — injection volume plus the 5a-4 quarantine
 * counters.
 *
 * ── Provenance: what this file is, and what it deliberately is not ──────────
 * This is the surviving half of `mesh-turn-outbox-coverage-diagnostics.ts`,
 * split out in Stage 5c-1. That file answered ONE question — "is the redrive leg
 * keeping up with the turn outbox it is meant to replace?" — and computed it as
 * a subset relation over task-id sets:
 *
 *     outboxDelivered(set) ⊆ redriveInjected(set)
 *
 * ★ That question died with its denominator. `outboxDelivered` was read from
 * `mesh_turn_outbox`, and 5c-1 drops the table. A coverage ratio whose
 * denominator is structurally zero is not a metric reading 100%; it is a metric
 * that has stopped being about anything, and leaving it in place would report a
 * permanent `null`/vacuous-true that an operator could easily read as evidence.
 * So the coverage fields (`outboxDelivered`, `coveredTerminals`,
 * `uncoveredTerminals`, `coveragePercent`, `fullyCovered`, `joinTruncated`) are
 * GONE rather than carried forward as constants.
 *
 * What survives is the half that was never about the outbox: the quarantine
 * counters (5a-4) and the cumulative injection total. Those describe the redrive
 * leg's own health, and after 5c-1 that leg is the SOLE path by which a
 * coordinator-bound terminal notification is re-armed — so this surface matters
 * more than it did, not less.
 *
 * ── How to read it ─────────────────────────────────────────────────────────
 * `quarantinedMeshCount > 0` is the successor to the legacy outbox's `failed`
 * park, and it is the signal to act on. A quarantined mesh is not merely
 * notifying late: its cursor is held, and a held cursor pins the seqscribe
 * archive floor open (§7.6), so the cost accrues in retained storage for as long
 * as it persists. Unlike the legacy park it auto-resolves after the cooldown —
 * see mesh-terminal-redrive.ts — so a count that keeps returning to zero is the
 * system working, while one that stays lit is not.
 *
 * ── Content boundary ───────────────────────────────────────────────────────
 * Every exported field is an integer count. No meshId, no taskId, no payload.
 * Same local-only contract the file it came from carried: `mesh_status` /
 * `get_status_metadata` and the daemon log, never `status_report`.
 */

import {
    getTotalRedriveInjected,
    getQuarantinedMeshCount,
    getTotalQuarantineSkips,
} from './mesh-terminal-redrive.js';

/** Local-only snapshot of the redrive leg's own health. */
export interface TerminalRedriveDiagnostics {
    /** Cumulative entries redrive has handed to the pending queue, across all meshes. */
    redriveInjected: number;
    /**
     * Meshes CURRENTLY quarantined (5a-4) — past the consecutive-failure
     * threshold and still inside the cooldown window. An aggregate count only:
     * no meshId, so this stays within the local-only content boundary above.
     */
    quarantinedMeshCount: number;
    /**
     * Cumulative entries skip-and-advanced across every mesh because their mesh
     * was quarantined at the time.
     *
     * ★ Read this WITH `quarantinedMeshCount`. A rising total against a zero
     * current count is history — quarantines that already resolved. A rising
     * total against a non-zero count is a leg actively shedding terminals.
     */
    quarantineSkipsTotal: number;
}

/**
 * Read the redrive leg's health counters.
 *
 * Pure in-memory reads — unlike its predecessor this touches no store at all,
 * because the one SQL read it used to perform was the outbox join.
 */
export function readTerminalRedriveDiagnostics(nowMs: number = Date.now()): TerminalRedriveDiagnostics {
    return {
        redriveInjected: getTotalRedriveInjected(),
        quarantinedMeshCount: getQuarantinedMeshCount(nowMs),
        quarantineSkipsTotal: getTotalQuarantineSkips(),
    };
}
