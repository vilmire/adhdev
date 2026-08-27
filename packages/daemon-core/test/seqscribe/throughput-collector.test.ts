import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeStats } from 'seqscribe';
import {
    startSeqscribeThroughputCollector,
    type SeqscribeThroughputCollector,
} from '../../src/seqscribe/throughput-collector.js';
import { summarizeSeqscribeStats } from '../../src/seqscribe/stats.js';

/**
 * The collector exists for ONE reason: since library proposals-v3.5 P24,
 * `node.stats()` is destructive. Every call drains the interval throughput
 * counters and resets them, so the interval is "[previous stats() call, this
 * one]".
 *
 * That makes the NUMBER OF CALLERS part of the semantics. With the three
 * pre-existing callers (status reporter, `get_status_metadata`, mesh
 * read-readiness) each one steals whatever accumulated since whoever ran last.
 * The failure mode is silent — no throw, no zero, just numbers wrong by a
 * factor nobody can reconstruct.
 *
 * These tests pin the property that prevents it: the collector is the only
 * caller, and `snapshot()` is a pure read that consumes nothing.
 */

/** A fake node whose `stats()` drains an interval exactly as the library's does. */
function fakeNode() {
    let pending = {
        servedEntries: 0,
        servedBytes: 0,
        appliedEntries: 0,
        appliedBytes: 0,
        wantRoundsRequested: 0,
        wantRoundsServed: 0,
    };
    let hotspots: { topic: string; peerId: string; bytes: number }[] = [];
    let applyRejects: Record<string, number> = {};
    let stalledStreams = 0;
    let statsCalls = 0;

    return {
        get statsCalls() {
            return statsCalls;
        },
        /** Simulate sync traffic accumulating between drains. */
        accrue(over: Partial<typeof pending> & { hotspot?: { topic: string; peerId: string; bytes: number } }) {
            pending = {
                servedEntries: pending.servedEntries + (over.servedEntries ?? 0),
                servedBytes: pending.servedBytes + (over.servedBytes ?? 0),
                appliedEntries: pending.appliedEntries + (over.appliedEntries ?? 0),
                appliedBytes: pending.appliedBytes + (over.appliedBytes ?? 0),
                wantRoundsRequested: pending.wantRoundsRequested + (over.wantRoundsRequested ?? 0),
                wantRoundsServed: pending.wantRoundsServed + (over.wantRoundsServed ?? 0),
            };
            if (over.hotspot) hotspots = [over.hotspot];
        },
        setRejects(r: Record<string, number>) {
            applyRejects = r;
        },
        setStalled(n: number) {
            stalledStreams = n;
        },
        /** The destructive read. Drains `pending`, exactly like the library. */
        stats(): NodeStats {
            statsCalls++;
            const drained = pending;
            pending = {
                servedEntries: 0,
                servedBytes: 0,
                appliedEntries: 0,
                appliedBytes: 0,
                wantRoundsRequested: 0,
                wantRoundsServed: 0,
            };
            const drainedHotspots = hotspots;
            hotspots = [];
            return {
                topics: {
                    'mesh.mesh_abc.events': {
                        writers: 1,
                        logRows: 10,
                        pending: 0,
                        quarantined: 0,
                        archived: 0,
                        finalityGeneration: null,
                        certOrderAgeMs: null,
                        consumers: {},
                        applyRejects,
                        sync: drained,
                    },
                },
                peers: [
                    {
                        peerId: 'peer-a',
                        state: 'ready',
                        lastActivityMs: 0,
                        queuedData: 0,
                        stalledStreams,
                    },
                ],
                syncHotspots: drainedHotspots,
            } as unknown as NodeStats;
        },
    };
}

describe('seqscribe throughput collector — single-reader property', () => {
    let collector: SeqscribeThroughputCollector | null = null;
    afterEach(() => {
        collector?.stop();
        collector = null;
    });

    it('is the only caller of stats(): repeated snapshot() reads consume no interval', () => {
        const node = fakeNode();
        collector = startSeqscribeThroughputCollector({
            readStats: () => node.stats(),
            intervalMs: 60_000,
            log: () => {},
        });

        // ── Interval 1 ──
        node.accrue({ servedEntries: 10, servedBytes: 1000 });
        collector.collect();
        expect(node.statsCalls).toBe(1);

        // ★ THE ASSERTION. Other consumers read the snapshot between ticks.
        // Under the bug this test guards, each of these would have been a
        // `node.stats()` call that drained the next interval out from under the
        // collector. Here they must not touch stats() at all...
        const readerA = collector.snapshot();
        const readerB = collector.snapshot();
        const readerC = collector.snapshot();
        expect(node.statsCalls).toBe(1);

        // ...and every reader must see the SAME whole interval, not a fragment.
        expect(readerA?.totals.servedEntries).toBe(10);
        expect(readerB?.totals.servedEntries).toBe(10);
        expect(readerC?.totals.servedEntries).toBe(10);

        // ── Interval 2 ── traffic accrued while those readers were reading is
        // still intact, because none of them consumed it.
        node.accrue({ servedEntries: 7, servedBytes: 700 });
        collector.collect();
        expect(node.statsCalls).toBe(2);
        expect(collector.snapshot()?.totals.servedEntries).toBe(7);
    });

    it('demonstrates the bug it prevents: a second direct reader halves the interval', () => {
        // Not a test of our code — a test of the PREMISE. If this ever stops
        // failing to preserve the full interval, the library's reset semantics
        // changed and the single-reader constraint can be revisited.
        const node = fakeNode();
        node.accrue({ servedEntries: 10 });

        const rogue = node.stats(); // a second consumer calling stats() directly
        expect(rogue.topics['mesh.mesh_abc.events']!.sync.servedEntries).toBe(10);

        // The collector now sees nothing: the rogue reader took the interval.
        collector = startSeqscribeThroughputCollector({
            readStats: () => node.stats(),
            intervalMs: 60_000,
            log: () => {},
        });
        collector.collect();
        expect(collector.snapshot()?.totals.servedEntries).toBe(0);
    });

    it('sums interval throughput across topics and surfaces P22 counters', () => {
        const node = fakeNode();
        node.setRejects({ rejected_finality: 2, sealed: 1 });
        node.setStalled(3);
        node.accrue({
            servedEntries: 4,
            servedBytes: 400,
            appliedEntries: 6,
            appliedBytes: 600,
            wantRoundsRequested: 2,
            wantRoundsServed: 1,
        });

        collector = startSeqscribeThroughputCollector({
            readStats: () => node.stats(),
            intervalMs: 60_000,
            log: () => {},
        });
        const snap = collector.collect();

        expect(snap?.totals).toEqual({
            servedEntries: 4,
            servedBytes: 400,
            appliedEntries: 6,
            appliedBytes: 600,
            wantRoundsRequested: 2,
            wantRoundsServed: 1,
        });
        // applyRejects is CUMULATIVE in the library — summed across classes.
        expect(snap?.applyRejects).toBe(3);
        expect(snap?.stalledStreams).toBe(3);
    });

    it('logs at most one summary per tick, and nothing at all when idle', () => {
        const node = fakeNode();
        const log = vi.fn();
        collector = startSeqscribeThroughputCollector({
            readStats: () => node.stats(),
            intervalMs: 60_000,
            log,
        });

        // Idle tick — an idle daemon must not emit a heartbeat line.
        collector.collect();
        expect(log).not.toHaveBeenCalled();

        // Active tick — exactly one line.
        node.accrue({
            servedEntries: 5,
            servedBytes: 5 * 1024 * 1024,
            hotspot: { topic: 'mesh.mesh_abc.events', peerId: 'peer-a', bytes: 5 * 1024 * 1024 },
        });
        collector.collect();
        expect(log).toHaveBeenCalledTimes(1);
        const [level, message] = log.mock.calls[0]!;
        expect(level).toBe('info');
        expect(message).toContain('served=5e/5.0MiB');
        expect(message).toContain('hot=mesh.mesh_abc.events@peer-a');

        // Back to idle — still just the one line from before.
        collector.collect();
        expect(log).toHaveBeenCalledTimes(1);
    });

    it('keeps the last good snapshot when a stats() read throws', () => {
        let fail = false;
        const node = fakeNode();
        const log = vi.fn();
        collector = startSeqscribeThroughputCollector({
            readStats: () => {
                if (fail) throw new Error('db closed');
                return node.stats();
            },
            intervalMs: 60_000,
            log,
        });

        node.accrue({ servedEntries: 9 });
        collector.collect();
        expect(collector.snapshot()?.totals.servedEntries).toBe(9);

        // A failing read must degrade to STALE, never to null — a consumer that
        // suddenly sees `null` would report the node as absent.
        fail = true;
        collector.collect();
        expect(collector.snapshot()?.totals.servedEntries).toBe(9);
        expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('db closed'));
    });

    it('stops cleanly and reports no further ticks', () => {
        const node = fakeNode();
        collector = startSeqscribeThroughputCollector({
            readStats: () => node.stats(),
            intervalMs: 60_000,
            log: () => {},
        });
        collector.collect();
        const calls = node.statsCalls;
        collector.stop();
        collector.collect();
        expect(node.statsCalls).toBe(calls);
    });
});

describe('summarizeSeqscribeStats — local diagnostics are opt-in', () => {
    const node = fakeNode();
    node.setRejects({ sealed: 4 });
    node.setStalled(2);
    node.accrue({
        servedEntries: 1,
        servedBytes: 100,
        hotspot: { topic: 'session.sess-1.transcript', peerId: 'peer-a', bytes: 100 },
    });
    const collector = startSeqscribeThroughputCollector({
        readStats: () => node.stats(),
        intervalMs: 60_000,
        log: () => {},
    });
    const snapshot = collector.collect()!;
    collector.stop();

    it('omits every local-only field by default — the status-reporter path', () => {
        const summary = summarizeSeqscribeStats(snapshot.stats, { authorityEnabled: true });
        // ★ The status reporter feeds the SERVER frame. None of these may appear.
        expect(summary).not.toHaveProperty('applyRejects');
        expect(summary).not.toHaveProperty('stalledStreams');
        expect(summary).not.toHaveProperty('throughput');
        expect(summary).not.toHaveProperty('syncHotspots');
    });

    it('includes them when explicitly opted in — the get_status_metadata path', () => {
        const summary = summarizeSeqscribeStats(snapshot.stats, {
            authorityEnabled: true,
            includeLocalDiagnostics: true,
            throughput: snapshot,
        });
        expect(summary.applyRejects).toBe(4);
        expect(summary.stalledStreams).toBe(2);
        expect(summary.throughput?.servedEntries).toBe(1);
        expect(summary.syncHotspots).toEqual([
            { topic: 'session.sess-1.transcript', peerId: 'peer-a', bytes: 100 },
        ]);
    });

    it('reports the P22 counters without a snapshot, since they are not interval data', () => {
        // applyRejects/stalledStreams come off the stats object itself, so they
        // are available even before the collector has published an interval.
        const summary = summarizeSeqscribeStats(snapshot.stats, {
            authorityEnabled: true,
            includeLocalDiagnostics: true,
            throughput: null,
        });
        expect(summary.applyRejects).toBe(4);
        expect(summary.stalledStreams).toBe(2);
        expect(summary).not.toHaveProperty('throughput');
        expect(summary).not.toHaveProperty('syncHotspots');
    });
});
