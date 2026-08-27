/**
 * seqscribe interval-throughput collector (library proposals-v3.5 P24).
 *
 * ── Why this file exists: stats() is DESTRUCTIVE ───────────────────────────
 * As of P24, `node.stats()` is not a pure read. Every call drains
 * `SyncEngine.drainIntervalStats()`, which returns the counters accumulated
 * since the PREVIOUS call and then CLEARS them. The interval is literally
 * "[previous stats() call, this one]".
 *
 * That makes the number of stats() callers part of the semantics. With three
 * independent callers — the status reporter, `get_status_metadata`, and the
 * mesh read-readiness probe — each one steals whatever accumulated since
 * whichever caller happened to run last. Nobody sees a whole interval, the
 * values shrink as unrelated traffic increases, and the throughput readout
 * silently becomes noise. The failure is invisible: no error, no zero, just
 * numbers that are wrong by an unknowable factor.
 *
 * So this module makes stats() single-reader by construction. The collector
 * ticks on its own cadence, is the ONLY thing in the daemon that calls
 * `node.stats()`, and every other consumer reads the snapshot it publishes.
 * `snapshot()` is a pure getter — reading it does not consume an interval, so
 * any number of readers at any cadence is safe.
 *
 * ★ If you add a new consumer of seqscribe stats, wire it to `snapshot()`.
 *   Calling `node.stats()` directly re-introduces the bug this file exists to
 *   prevent, and the regression test in
 *   `test/seqscribe/throughput-collector.test.ts` asserts the single-reader
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

import type { NodeStats } from 'seqscribe';
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

export interface ThroughputCollectorOptions {
    /** Reads `node.stats()`. This must be the process's ONLY caller. */
    readStats: () => NodeStats;
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

function sumTotals(stats: NodeStats): SeqscribeThroughputTotals {
    const totals: SeqscribeThroughputTotals = { ...ZERO_TOTALS };
    for (const topic of Object.values(stats.topics ?? {})) {
        const sync = topic?.sync;
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
        try {
            // ★ The single stats() call in the daemon. See the file header.
            stats = opts.readStats();
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
        const totals = sumTotals(stats);
        const snapshot: SeqscribeThroughputSnapshot = {
            at,
            intervalMs: lastAt === null ? intervalMs : Math.max(0, at - lastAt),
            totals,
            hotspots: (stats.syncHotspots ?? [])
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
