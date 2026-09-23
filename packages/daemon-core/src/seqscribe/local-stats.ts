/**
 * buildLocalSeqscribeStats — the LOCAL replication-health read surface
 * (`get_status_metadata` + the status reporter's `getSeqscribeStats`).
 *
 * Moved verbatim out of the old `daemon-lifecycle.ts` router closure
 * (wiring-unification B4). Aggregate-only by construction: summarizeSeqscribeStats
 * is the same allow-list projection the status report uses, and every
 * local-only block below is dropped again by buildCloudSeqscribeSummary (a
 * fixed-key allow-list) before anything leaves for the server.
 */

import { LOG } from '../logging/logger.js';
import type { SeqscribeStatusSummary } from '../shared-types.js';
import type { SeqscribeRuntime } from './runtime.js';
import { summarizeSeqscribeStats } from './stats.js';
import { transcriptParityCounters } from './transcript-parity.js';
import { transcriptTransportSelectionCounters } from './transcript-transport-selection.js';

export interface LocalSeqscribeStatsInputs {
    /**
     * Coordinator-notice delivery counters (wiring-unification C7-4): the
     * turn cursors' outcome counters merged with the deliver handler's
     * (`meshNoticeRuntime.current()?.counters()`). They replace the retired
     * Stage 5a `terminalRedrive` block — the `turn.deliver` cursor IS
     * redelivery. Injected because the counters live in `mesh/` and this
     * module may not value-import it. Null/absent → no turn ledger booted.
     */
    meshDelivery?: () => Record<string, number> | null;
    /**
     * G2 transcript-transport `zombieRecovered` count — sourced from
     * `packages/daemon-cloud/src/daemon-p2p/data-channel-router.ts`
     * `getZombiePeerRecoveryCount()`. Injected for the same reason
     * `meshDelivery` is: the dial/redial loop it counts is daemon-cloud's,
     * outside daemon-core, and this module may not value-import it
     * (Key Conventions, CLAUDE.md: "Core never imports cloud/standalone").
     * Null/absent (e.g. standalone, which has no P2P dial loop to zombie) →
     * reported as 0, matching `replicaSelected`/`legacySelected`'s own
     * zero-when-nothing-reported default rather than omitting the block.
     */
    zombieRecovered?: () => number | null;
}

export function buildLocalSeqscribeStats(
    rt: SeqscribeRuntime | null,
    inputs: LocalSeqscribeStatsInputs,
): SeqscribeStatusSummary | null {
    if (!rt) return null;
    try {
        // §8 unit 2: the publisher runs a parity self-check on every append, and
        // the allow-listed `transcript*` fields already exist through reporter.ts
        // and the server sanitizer — so passing them fills existing fields
        // rather than widening either allow-list. Omitting them made
        // `transcriptParityRan` a permanent false NEGATIVE.
        const transcriptService = rt.projections()?.transcript ?? null;
        const transcriptCounters = transcriptService?.getCounters() ?? null;
        const transcriptParity = transcriptParityCounters();
        // ★ Read the collector's PUBLISHED snapshot — never `node.stats()`, and
        // never `collect()` either (the type does not even expose it). This is
        // called by the status reporter (~30s) AND on demand; forcing a collect
        // would cut the interval at those arbitrary moments. The numbers are up
        // to one tick stale — a coherent interval a minute old is useful, a
        // fragmented one is not.
        const snapshot = rt.collector?.snapshot() ?? null;
        if (!snapshot) return null;
        return summarizeSeqscribeStats(snapshot.stats, {
            authorityEnabled: rt.node.authorityEnabled,
            // Local surface: the cloud projection drops every field below;
            // syncHotspots carries topic names and peer ids and is local-only.
            includeLocalDiagnostics: true,
            throughput: snapshot,
            meshDelivery: inputs.meshDelivery?.() ?? null,
            // Transcript trigger attribution + stage latencies. Local-only: raw
            // distributions would defeat the status-frame dedup. The cloud
            // status-report supplier deliberately does NOT pass this.
            transcriptLatency: transcriptService?.getLatencyDetail() ?? null,
            // `active` follows the SERVICE, not the mode: mode `shadow` still
            // publishes, so keying off the mode would read `false` on a daemon
            // that is actively appending.
            ...(transcriptCounters
                ? {
                      transcript: {
                          active: true,
                          published: transcriptCounters.published,
                          publishFailed: transcriptCounters.publishFailed,
                          deduped: transcriptCounters.deduped,
                          oversized: transcriptCounters.oversized,
                          dropped: transcriptCounters.dropped,
                          // Local diagnostic detail (transcriptCounterDetail,
                          // gated behind includeLocalDiagnostics; never on the
                          // cloud allow-list). ptyDirtyCoalesced is the only
                          // evidence the per-session PTY throttle collapses bursts.
                          ptyDirtyCoalesced: transcriptCounters.ptyDirtyCoalesced,
                          emptyGuarded: transcriptCounters.emptyGuarded,
                          collectorUnavailable: transcriptCounters.collectorUnavailable,
                          sourcePending: transcriptCounters.sourcePending,
                          collectFailed: transcriptCounters.collectFailed,
                      },
                  }
                : {}),
            // ★ The WHOLE parity counter object, never a narrowed slice: §5.6's
            // `persistent mismatch 0` condition is undecidable from
            // {runs, mismatches, persistentMismatches} alone (a missing revision
            // is promoted to persistent only on a session key's SECOND
            // comparison). Only three bucketed fields survive into the cloud
            // frame; the rest land on the local-only transcriptParityDetail.
            transcriptParity,
            // G2 transport-selection + zombie-recovery — local-only, see
            // `stats.ts`'s doc comment on `transcriptTransportSelection` for
            // why. `replicaSelected`/`legacySelected` are this process's own
            // counters (transcript-transport-selection.ts, fed by the
            // `report_transcript_transport` low-family command);
            // `zombieRecovered` is injected from daemon-cloud, see above.
            transcriptTransportSelection: {
                ...transcriptTransportSelectionCounters(),
                zombieRecovered: inputs.zombieRecovered?.() ?? 0,
            },
        });
    } catch (error) {
        LOG.warn(
            'Seqscribe',
            `stats unavailable for get_status_metadata: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
    }
}
