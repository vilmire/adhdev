import { describe, expect, it } from 'vitest';
import type { NodeStats } from 'seqscribe';
import { createSubResyncWarner } from '../../src/seqscribe/sub-resync-log.js';
import { summarizeSeqscribeStats } from '../../src/seqscribe/stats.js';
import { startSeqscribeThroughputCollector } from '../../src/seqscribe/throughput-collector.js';

/**
 * Observability for the vendor SubHub's coalesced resync (2026-09-27 resync
 * storm: a backpressured subscriber was re-SNAPped once per applied write and
 * nothing on any local surface showed it).
 */

type Subs = NonNullable<NodeStats['subs']>;
const ZERO_SUBS: Subs = {
    subscribers: 0,
    resyncPending: 0,
    snapsInFlight: 0,
    snapsStarted: 0,
    snapsCompleted: 0,
    snapsAbandoned: 0,
    snapBytes: 0,
    snapChunksSent: 0,
    snapCacheHits: 0,
    resyncs: 0,
    resyncsBackpressure: 0,
    resyncsOversized: 0,
    resyncWritesCoalesced: 0,
    deltasSent: 0,
};

function statsWith(subs: Subs): NodeStats {
    return { topics: {}, peers: [], syncHotspots: [], subs };
}

describe('sub_resync WARN rate limit', () => {
    it('one line per (topic, peer) per window, carrying the suppressed count', () => {
        let now = 0;
        const lines: string[] = [];
        const warn = createSubResyncWarner((m) => lines.push(m), () => now, 60_000);
        const e = { topic: 'session.s1.transcript', peerId: 'dash-1', view: 'tail', reason: 'backpressure' };
        warn(e, 'w1');
        now = 1_000;
        warn(e, 'w1');
        warn(e, 'w1');
        warn({ ...e, peerId: 'dash-2' }, 'w1'); // a different subscriber is its own key
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain('topic=session.s1.transcript peer=dash-1 view=tail reason=backpressure');
        expect(lines[0]).not.toContain('more in the last');
        now = 61_000;
        warn(e, 'w1');
        expect(lines).toHaveLength(3);
        expect(lines[2]).toContain('(+2 more in the last 60s)');
    });
});

describe('subs counters in the collector log and local stats', () => {
    it('logs per-interval deltas only when SNAP/resync activity moved; resyncs warn', () => {
        let subs: Subs = { ...ZERO_SUBS, subscribers: 1, snapsStarted: 1, snapsCompleted: 1, snapBytes: 2048, snapChunksSent: 1 };
        const logs: { level: string; message: string }[] = [];
        const collector = startSeqscribeThroughputCollector({
            readStats: () => statsWith(subs),
            drainInterval: () => ({ topics: {}, syncHotspots: [] }),
            intervalMs: 60_000,
            clock: () => 0,
            log: (level, message) => logs.push({ level, message }),
        });
        try {
            collector.collect(); // first tick: baseline is zero, so the initial SNAP shows
            expect(logs.map((l) => l.level)).toEqual(['info']);
            expect(logs[0]!.message).toContain('subs 60s: snaps=1/2.0KiB chunks=1');

            collector.collect(); // nothing moved → silent
            expect(logs).toHaveLength(1);

            subs = {
                ...subs,
                resyncPending: 0,
                snapsStarted: 2,
                snapsCompleted: 2,
                snapBytes: 2048 + 5 * 1024 * 1024,
                snapChunksSent: 55,
                resyncs: 1,
                resyncsBackpressure: 1,
                resyncWritesCoalesced: 232,
                deltasSent: 68,
            };
            collector.collect();
            expect(logs).toHaveLength(2);
            expect(logs[1]!.level).toBe('warn');
            expect(logs[1]!.message).toBe(
                'subs 60s: snaps=1/5.0MiB chunks=54 deltas=68 resyncs=1 (backpressure=1 oversized=0) coalesced=232 pending=0 inFlight=0',
            );
        } finally {
            collector.stop();
        }
    });

    it('summarizeSeqscribeStats exposes subDelivery on the local surface only', () => {
        const subs: Subs = { ...ZERO_SUBS, resyncs: 3, resyncWritesCoalesced: 90 };
        const local = summarizeSeqscribeStats(statsWith(subs), { authorityEnabled: true, includeLocalDiagnostics: true });
        expect(local.subDelivery).toEqual(subs);
        const cloudShaped = summarizeSeqscribeStats(statsWith(subs), { authorityEnabled: true });
        expect(cloudShaped).not.toHaveProperty('subDelivery');
    });
});
