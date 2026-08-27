/**
 * seqscribe health summary for the status report (design §1.5).
 *
 * Projects `node.stats()` — which is per-topic and per-peer, and grows with the
 * fleet — down to a handful of fleet-wide numbers.
 *
 * ── Content boundary (CLAUDE.md "Server content boundary") ─────────────────
 * The status path is a four-layer ALLOW-LIST and this is the daemon-side layer
 * for seqscribe. Every field below is a counter, a boolean, or a bucketed
 * integer. Deliberately absent:
 *
 *   - topic NAMES — `session.<id>.transcript` and `mesh.<meshId>.events` embed
 *     session and mesh identifiers, so a per-topic map would leak the fleet's
 *     shape to the server. Only aggregates cross.
 *   - peer ids and writer ids — peer identity is not routing metadata here.
 *   - anything derived from an entry payload.
 *
 * Adding a field means asserting it is non-content. Never widen this to a
 * pass-through of `NodeStats`, and never rewrite it as a deny-list.
 *
 * ── Why the values are coarse ──────────────────────────────────────────────
 * `sendUnifiedStatusReport` dedups server frames by hashing the whole payload
 * minus `timestamp`, suppressing up to SERVER_DEDUP_KEEPALIVE_REPORTS identical
 * reports. A raw monotonic counter here would change on every tick and defeat
 * that dedup, turning a mostly-idle daemon into a constant 30s transmitter.
 *
 * So the fields that would otherwise tick constantly are BUCKETED: an idle-ish
 * daemon reports the same bucket for long stretches and the dedup keeps
 * working, while a real problem still crosses a boundary and shows up.
 */

import type { NodeStats } from 'seqscribe';

/**
 * Finality staleness buckets, in hours. With a 1h issuance cadence, "fresh" is
 * under 2h (the design's alert threshold is 2× the cadence); beyond that the
 * exact age matters less than the order of magnitude.
 */
const FGEN_AGE_BUCKETS_H = [2, 6, 24, 72] as const;

/** Backlog buckets. Zero is distinct from "a few" — a stuck queue is the signal. */
const BACKLOG_BUCKETS = [1, 10, 100, 1000] as const;

/**
 * Map a value to the index of the first bucket it does NOT exceed, so the
 * reported number is a small ordinal rather than a live counter. `0` always
 * means "none"; the top index means "at or above the last threshold".
 */
function bucket(value: number, thresholds: readonly number[]): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    for (let i = 0; i < thresholds.length; i++) {
        if (value < thresholds[i]!) return i + 1;
    }
    return thresholds.length + 1;
}

/**
 * Fleet-wide seqscribe health. Counters and buckets only — see the content
 * boundary note above.
 */
export interface SeqscribeStatusSummary {
    /** Topics defined on this node. */
    topics: number;
    /** Peers currently attached (any state). */
    peers: number;
    /** Peers in the `ready` state — i.e. actually syncing. */
    peersReady: number;
    /** Bucketed max pending rows across topics (unapplied, awaiting causal deps). */
    pendingBucket: number;
    /** Bucketed max consumer lag across topics, in rows. */
    consumerLagBucket: number;
    /** Bucketed max peer send-queue depth. */
    queueBucket: number;
    /** Bucketed oldest finality certificate age. 0 = fresh or nothing certified. */
    fgenAgeBucket: number;
    /** True when any topic has quarantined entries — always worth surfacing. */
    quarantined: boolean;
    /** True when a fleet secret is configured and certificates can be verified. */
    authority: boolean;

    // ── Phase 2 Stage 2+3: mesh dual-write shadow + parity ──────────────────
    // Same discipline as the fields above: booleans and bucket ordinals, never
    // live counters, so an idle daemon's status frame stays byte-identical and
    // the server-side dedup keeps working.
    /** True when the mesh dual-write shadow leg is armed. */
    dualWrite: boolean;
    /** Bucketed count of shadow appends that failed. 0 = none. */
    dualWriteFailedBucket: number;
    /** Bucketed count of shadow records dropped by load-shedding. 0 = none. */
    dualWriteDroppedBucket: number;
    /**
     * Bucketed count of records mirrored LATE by the parity backfill.
     *
     * ★ Nonzero is EXPECTED and healthy on a machine that runs mesh MCP tools:
     * the mcp-server process appends to the shared ledger with no armed shadow
     * leg of its own, so the daemon repairs those entries on its parity sweep
     * (see the process-boundary note in mesh-dual-write.ts). Read it together
     * with `parityMismatchBucket` — backfill nonzero + mismatch settling is the
     * repair working; mismatch persisting while this stays 0 is the repair
     * itself being broken.
     */
    dualWriteBackfilledBucket: number;
    /**
     * Bucketed count of parity mismatches observed since boot.
     *
     * ★ This is the number Stage 4 needs at 0 before the read-path cutover.
     * Bucketed rather than raw for the dedup reason above — a nonzero bucket is
     * the signal; the exact count lives in the daemon log and `get_status_metadata`.
     */
    parityMismatchBucket: number;
    /** True once at least one parity comparison has run. */
    parityRan: boolean;
    /**
     * Bucketed breakdown of `parityMismatchBucket` by mismatch class.
     *
     * The combined bucket answers "is Stage 4 blocked"; these three answer
     * "blocked by what" without adding a live counter — same bucket discipline
     * as everything else in this summary.
     */
    parityMissingInShadowBucket: number;
    parityExtraInShadowBucket: number;
    parityFieldMismatchBucket: number;
}

export interface SummarizeOptions {
    authorityEnabled: boolean;
    /** Stage 2 shadow counters. Omitted → reported as inactive/zero. */
    dualWrite?: {
        active: boolean;
        failed: number;
        dropped: number;
        /** Records mirrored late by the parity backfill. Omitted → 0. */
        backfilled?: number;
    };
    /** Stage 3 parity counters. Omitted → reported as never-run. */
    parity?: {
        runs: number;
        mismatches: number;
        /** Per-class breakdown. Omitted → each axis reported as 0. */
        missingInShadow?: number;
        extraInShadow?: number;
        fieldMismatch?: number;
    };
}

export function summarizeSeqscribeStats(
    stats: NodeStats,
    opts: SummarizeOptions,
): SeqscribeStatusSummary {
    let maxPending = 0;
    let maxLag = 0;
    let maxCertAgeMs = 0;
    let quarantined = false;
    let topics = 0;

    for (const topic of Object.values(stats.topics)) {
        topics++;
        if (topic.pending > maxPending) maxPending = topic.pending;
        if (topic.quarantined > 0) quarantined = true;
        if (topic.certOrderAgeMs !== null && topic.certOrderAgeMs > maxCertAgeMs) {
            maxCertAgeMs = topic.certOrderAgeMs;
        }
        for (const consumer of Object.values(topic.consumers)) {
            if (consumer.lagRows > maxLag) maxLag = consumer.lagRows;
        }
    }

    let maxQueued = 0;
    let peersReady = 0;
    for (const peer of stats.peers) {
        if (peer.queuedData > maxQueued) maxQueued = peer.queuedData;
        if (peer.state === 'ready') peersReady++;
    }

    return {
        topics,
        peers: stats.peers.length,
        peersReady,
        pendingBucket: bucket(maxPending, BACKLOG_BUCKETS),
        consumerLagBucket: bucket(maxLag, BACKLOG_BUCKETS),
        queueBucket: bucket(maxQueued, BACKLOG_BUCKETS),
        fgenAgeBucket: bucket(maxCertAgeMs / (60 * 60 * 1000), FGEN_AGE_BUCKETS_H),
        quarantined,
        authority: opts.authorityEnabled,
        dualWrite: opts.dualWrite?.active ?? false,
        dualWriteFailedBucket: bucket(opts.dualWrite?.failed ?? 0, BACKLOG_BUCKETS),
        dualWriteDroppedBucket: bucket(opts.dualWrite?.dropped ?? 0, BACKLOG_BUCKETS),
        dualWriteBackfilledBucket: bucket(opts.dualWrite?.backfilled ?? 0, BACKLOG_BUCKETS),
        parityMismatchBucket: bucket(opts.parity?.mismatches ?? 0, BACKLOG_BUCKETS),
        parityRan: (opts.parity?.runs ?? 0) > 0,
        parityMissingInShadowBucket: bucket(opts.parity?.missingInShadow ?? 0, BACKLOG_BUCKETS),
        parityExtraInShadowBucket: bucket(opts.parity?.extraInShadow ?? 0, BACKLOG_BUCKETS),
        parityFieldMismatchBucket: bucket(opts.parity?.fieldMismatch ?? 0, BACKLOG_BUCKETS),
    };
}
