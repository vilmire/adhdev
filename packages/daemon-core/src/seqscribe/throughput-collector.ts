/**
 * seqscribe interval-throughput collector (library proposals-v3.5 P24,
 * drain ownership revised by SPEC v3.7 P31).
 *
 * ── Why this file exists: one owner for the interval drain ─────────────────
 * The library's P24 interval counters accumulate until someone drains them.
 * Before v3.7 the drain was a side effect of `node.stats()`, which made the
 * NUMBER OF CALLERS part of the semantics — every extra reader stole a
 * fragment of someone else's interval, silently. Since v3.7 (P31) `stats()`
 * is a pure read and the drain lives behind `node.drainSyncInterval()`, so
 * the safety hazard is gone from the library.
 *
 * This collector remains the process's SINGLE drain owner — as hygiene, not
 * as a correctness requirement. One owner ticking on its own cadence keeps
 * the interval windows disjoint and meaningful ("traffic in the last tick");
 * several independent drainers would each see arbitrary sub-windows. Every
 * other consumer reads the snapshot it publishes. `snapshot()` is a pure
 * getter — reading it does not consume an interval, so any number of readers
 * at any cadence is safe.
 *
 * Point-in-time gauges (`logRows`, `pending`, `quarantined`, `archived`,
 * `consumers[].lagRows`, `peers`, `finalityGeneration`) come from `stats()`
 * and may now be read by anyone directly; only the interval counters
 * (`topics`, `syncHotspots`) come from `drainSyncInterval()`.
 *
 * ★ If you add a new consumer of seqscribe stats, wire it to `snapshot()`.
 *   Calling `drainSyncInterval()` directly fragments the interval windows
 *   this file owns, and the regression test in
 *   `test/seqscribe/throughput-collector.test.ts` asserts the single-drain
 *   property.
 *
 * ── Content boundary ───────────────────────────────────────────────────────
 * `syncHotspots` pairs a TOPIC NAME with a PEER ID, and ADHDev topic names
 * embed session and mesh identifiers (`session.<id>.transcript`,
 * `mesh.<meshId>.events`). It is therefore a LOCAL-ONLY diagnostic: it may
 * reach the daemon log and `get_status_metadata`, and it must never reach the
 * server. The cloud projection (`buildCloudSeqscribeSummary` in
 * status/reporter.ts) is a fixed-key allow-list that re-lists every field it
 * forwards, so fields added here cannot reach the server by accident — see
 * `test/status/cloud-status-content-boundary.test.ts`.
 */

import type { NodeStats, TopicSyncCounters } from 'seqscribe';
import { LOG } from '../logging/logger.js';

/** Default collector cadence. Also the effective resolution of every counter. */
export const DEFAULT_COLLECT_INTERVAL_MS = 60_000;

/** Top hotspots retained in the snapshot. The library already caps its own list at 5. */
const SNAPSHOT_HOTSPOT_LIMIT = 5;

/**
 * Fleet-wide interval throughput, summed across topics.
 *
 * These are per-interval values (not cumulative): they describe the traffic in
 * the last collector tick, so an idle fleet reports zeros rather than an
 * ever-growing total.
 */
export interface SeqscribeThroughputTotals {
    servedEntries: number;
    servedBytes: number;
    appliedEntries: number;
    appliedBytes: number;
    wantRoundsRequested: number;
    wantRoundsServed: number;
}

/**
 * One (topic, peer) byte hotspot. LOCAL-ONLY — carries identifiers, see the
 * content-boundary note in the file header.
 */
export interface SeqscribeHotspot {
    topic: string;
    peerId: string;
    bytes: number;
}

/** A published, non-consuming view of the most recent collector tick. */
export interface SeqscribeThroughputSnapshot {
    /** Collector clock at the tick that produced this snapshot. */
    at: number;
    /** Milliseconds covered by this interval — the gap since the previous tick. */
    intervalMs: number;
    /** Interval throughput, summed across topics. */
    totals: SeqscribeThroughputTotals;
    /** Top (topic, peer) pairs by bytes this interval. LOCAL-ONLY. */
    hotspots: SeqscribeHotspot[];
    /**
     * CUMULATIVE non-applied wire-apply outcomes, summed across topics
     * (library P22). Unlike the throughput counters above, the library keeps
     * these cumulative, so this grows monotonically for the process lifetime.
     */
    applyRejects: number;
    /** Peer streams currently suspended for non-progress (library P22). */
    stalledStreams: number;
    /** The full stats read, for consumers that need the aggregate fields. */
    stats: NodeStats;
}

const ZERO_TOTALS: SeqscribeThroughputTotals = {
    servedEntries: 0,
    servedBytes: 0,
    appliedEntries: 0,
    appliedBytes: 0,
    wantRoundsRequested: 0,
    wantRoundsServed: 0,
};

/**
 * The drained P24 interval counters, as returned by `node.drainSyncInterval()`
 * (SPEC v3.7 P31) — same shape `stats()` reports them in.
 */
export interface SyncIntervalDrain {
    topics: Record<string, TopicSyncCounters>;
    syncHotspots: NodeStats['syncHotspots'];
}

export interface ThroughputCollectorOptions {
    /**
     * Reads `node.stats()` for the point-in-time gauges. A pure read since
     * SPEC v3.7, so any number of callers is safe.
     */
    readStats: () => NodeStats;
    /**
     * Drains the P24 interval counters via `node.drainSyncInterval()`. This
     * must be the process's ONLY caller — see the file header.
     */
    drainInterval: () => SyncIntervalDrain;
    /** Tick cadence. Tests pass a short value. */
    intervalMs?: number;
    /** Injectable clock — tests drive this deterministically. */
    clock?: () => number;
    /** Injectable log sink. Defaults to the shared daemon logger. */
    log?: (level: 'info' | 'warn', message: string) => void;
}

export interface SeqscribeThroughputCollector {
    /**
     * The published snapshot. A PURE GETTER — it does not consume an interval,
     * so every consumer must read this rather than calling `node.stats()`.
     * `null` before the first tick.
     */
    snapshot(): SeqscribeThroughputSnapshot | null;
    /** Run one tick immediately (the timer path calls this internally). */
    collect(): SeqscribeThroughputSnapshot | null;
    /** Stop the timer. Idempotent. */
    stop(): void;
}

function sumTotals(drain: SyncIntervalDrain): SeqscribeThroughputTotals {
    const totals: SeqscribeThroughputTotals = { ...ZERO_TOTALS };
    for (const sync of Object.values(drain.topics ?? {})) {
        if (!sync) continue;
        totals.servedEntries += num(sync.servedEntries);
        totals.servedBytes += num(sync.servedBytes);
        totals.appliedEntries += num(sync.appliedEntries);
        totals.appliedBytes += num(sync.appliedBytes);
        totals.wantRoundsRequested += num(sync.wantRoundsRequested);
        totals.wantRoundsServed += num(sync.wantRoundsServed);
    }
    return totals;
}

function num(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function sumApplyRejects(stats: NodeStats): number {
    let total = 0;
    for (const topic of Object.values(stats.topics ?? {})) {
        for (const count of Object.values(topic?.applyRejects ?? {})) {
            total += num(count);
        }
    }
    return total;
}

function sumStalledStreams(stats: NodeStats): number {
    let total = 0;
    for (const peer of stats.peers ?? []) {
        total += num(peer?.stalledStreams);
    }
    return total;
}

function hasActivity(totals: SeqscribeThroughputTotals): boolean {
    return (
        totals.servedEntries > 0 ||
        totals.appliedEntries > 0 ||
        totals.servedBytes > 0 ||
        totals.appliedBytes > 0 ||
        totals.wantRoundsRequested > 0 ||
        totals.wantRoundsServed > 0
    );
}

/** Compact byte rendering for the summary line — the log is read by humans. */
function fmtBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;
}

/**
 * Start the collector.
 *
 * The timer is `unref`'d: replication telemetry must never be the reason a
 * daemon process refuses to exit.
 */
export function startSeqscribeThroughputCollector(
    opts: ThroughputCollectorOptions,
): SeqscribeThroughputCollector {
    const intervalMs = opts.intervalMs ?? DEFAULT_COLLECT_INTERVAL_MS;
    const clock = opts.clock ?? (() => Date.now());
    const log =
        opts.log ??
        ((level: 'info' | 'warn', message: string) => {
            if (level === 'warn') LOG.warn('Seqscribe', message);
            else LOG.info('Seqscribe', message);
        });

    let current: SeqscribeThroughputSnapshot | null = null;
    let lastAt: number | null = null;
    let stopped = false;

    const collect = (): SeqscribeThroughputSnapshot | null => {
        if (stopped) return current;
        let stats: NodeStats;
        let interval: SyncIntervalDrain;
        try {
            // Gauges first (a pure read since v3.7), then the drain — the
            // process's single drainSyncInterval() call. See the file header.
            stats = opts.readStats();
            interval = opts.drainInterval();
        } catch (error) {
            // A failed read is not fatal and must not kill the timer: the node
            // may be mid-close, or the DB briefly unavailable. Keep the last
            // good snapshot so consumers degrade to stale rather than to null.
            log(
                'warn',
                `throughput collect failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return current;
        }

        const at = clock();
        const totals = sumTotals(interval);
        const snapshot: SeqscribeThroughputSnapshot = {
            at,
            intervalMs: lastAt === null ? intervalMs : Math.max(0, at - lastAt),
            totals,
            hotspots: (interval.syncHotspots ?? [])
                .slice(0, SNAPSHOT_HOTSPOT_LIMIT)
                .map((h) => ({ topic: h.topic, peerId: h.peerId, bytes: num(h.bytes) })),
            applyRejects: sumApplyRejects(stats),
            stalledStreams: sumStalledStreams(stats),
            stats,
        };
        lastAt = at;
        current = snapshot;

        // Summary line — at most one per tick, and ONLY when something moved.
        // An idle daemon logs nothing, so this cannot become heartbeat spam.
        if (hasActivity(totals)) {
            const top = snapshot.hotspots[0];
            log(
                'info',
                `sync ${intervalMs / 1000}s: served=${totals.servedEntries}e/${fmtBytes(totals.servedBytes)} ` +
                    `applied=${totals.appliedEntries}e/${fmtBytes(totals.appliedBytes)} ` +
                    `want=${totals.wantRoundsRequested}req/${totals.wantRoundsServed}served` +
                    (top ? ` hot=${top.topic}@${top.peerId}/${fmtBytes(top.bytes)}` : ''),
            );
        }

        return snapshot;
    };

    const timer = setInterval(collect, intervalMs);
    // Telemetry must not hold the event loop open.
    (timer as unknown as { unref?: () => void }).unref?.();

    return {
        snapshot: () => current,
        collect,
        stop: () => {
            if (stopped) return;
            stopped = true;
            clearInterval(timer);
        },
    };
}
