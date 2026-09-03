/**
 * Redrive coverage + quarantine diagnostics — the 5a→5b gate's evidence
 * (Stage 5, 5a-3) plus the 5a-4 quarantine health surface.
 *
 * Design: docs/design/2026-08-29-seqscribe-outbox-migration.md §7 5a-3, §11-3.
 * "지표 신설: redrive 주입 수, 커서 lag, outbox drain delivered 수의 대응
 * 관계 계측(같은 터미널에 대해 양쪽이 발동한 비율 = 커버리지)."
 *
 * ── What "coverage" means here ──────────────────────────────────────────────
 * In 5a's dual drive, both the legacy outbox drain and the new redrive
 * consumer independently attempt to inject the SAME terminal notification
 * into the pending-events queue; the queue's fingerprint dedup collapses
 * whichever arrives second (mesh-terminal-redrive.ts `consumeRedriveEntry`,
 * mesh-event-suppression.ts `drainMeshTurnOutbox`). Both counters are
 * therefore cumulative counts of "this path attempted/completed an
 * injection for a terminal", on the same underlying set of terminals — so
 * comparing the two RUNNING TOTALS answers the design's question without a
 * per-entry join: if redrive is keeping up, every terminal the outbox
 * delivered was also independently reached by redrive, so
 * `redriveInjected >= outboxDelivered` and coverage saturates at 100%.
 *
 * A per-entry join (matching outbox row N to redrive injection N by taskId)
 * would be more precise but the outbox exposes only status COUNTS
 * (`countTurnOutboxByStatus`), not row enumeration — see
 * mesh-turn-outbox-diagnostics.ts. Adding row enumeration only to support a
 * diagnostics read is exactly the disproportionate-surface-area 5a-1 warns
 * against for a local-only signal; the running-total ratio is the same
 * signal the 5a→5b gate needs ("did coverage reach 100%") at a fraction of
 * the surface.
 *
 * ── Content boundary ───────────────────────────────────────────────────────
 * Every field here is an integer count or a derived percentage. No
 * meshId/taskId/attemptId, no enumeration. Same local-only contract as
 * mesh-turn-outbox-diagnostics.ts: `mesh_status` / `get_status_metadata` and
 * the daemon log, never `status_report`.
 */

import { getTurnLedgerMetrics } from './mesh-turn-ledger.js';
import {
    getTotalRedriveInjected,
    getQuarantinedMeshCount,
    getTotalQuarantineSkips,
} from './mesh-terminal-redrive.js';

/** Local-only snapshot comparing redrive injections against outbox deliveries. */
export interface RedriveCoverageDiagnostics {
    /** Cumulative entries redrive has handed to the pending queue, across all meshes. */
    redriveInjected: number;
    /** Cumulative outbox rows the legacy drain has marked `delivered`. */
    outboxDelivered: number;
    /**
     * `redriveInjected / outboxDelivered`, clamped to [0, 1], as a percentage
     * (0-100). `null` when `outboxDelivered` is 0 — there is nothing yet to
     * cover, which is not the same as 0% coverage (that would read as a
     * regression on a fresh/idle daemon).
     */
    coveragePercent: number | null;
    /**
     * Meshes CURRENTLY quarantined (5a-4) — past the consecutive-failure
     * threshold and still inside the cooldown window. An aggregate count only:
     * no meshId, so this stays within the same local-only content boundary as
     * the rest of this file. A non-zero value on a healthy fleet is worth an
     * operator's attention (the dual-drive outbox leg is still covering the
     * notification, but the redrive leg for that mesh is not).
     */
    quarantinedMeshCount: number;
    /**
     * Cumulative entries skip-and-advanced across every mesh because their
     * mesh was quarantined at the time. Grows only while at least one mesh is
     * quarantined; a steady climb alongside a persistent `quarantinedMeshCount`
     * indicates an ongoing coordinator-unreachable condition rather than a
     * one-off blip the half-open probe already recovered from.
     */
    quarantineSkipsTotal: number;
}

/**
 * Read the current redrive-vs-outbox coverage plus quarantine health.
 * Delegates all arithmetic to counters that already exist
 * (`getTurnLedgerMetrics` for the outbox, `getTotalRedriveInjected` /
 * `getQuarantinedMeshCount` / `getTotalQuarantineSkips` for redrive) and does
 * no I/O of its own.
 */
export function readRedriveCoverageDiagnostics(nowMs: number = Date.now()): RedriveCoverageDiagnostics {
    const metrics = getTurnLedgerMetrics(nowMs);
    const outboxDelivered = metrics.outboxByStatus.delivered ?? 0;
    const redriveInjected = getTotalRedriveInjected();
    const coveragePercent = outboxDelivered > 0
        ? Math.min(100, (redriveInjected / outboxDelivered) * 100)
        : null;
    return {
        redriveInjected,
        outboxDelivered,
        coveragePercent,
        quarantinedMeshCount: getQuarantinedMeshCount(nowMs),
        quarantineSkipsTotal: getTotalQuarantineSkips(),
    };
}
