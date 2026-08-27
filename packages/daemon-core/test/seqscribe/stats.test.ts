import { describe, expect, it } from 'vitest';
import { summarizeSeqscribeStats } from '../../src/seqscribe/stats.js';
import type { NodeStats } from 'seqscribe';

/**
 * `summarizeSeqscribeStats` is the daemon-side projection of seqscribe's
 * per-topic `stats()` into the handful of fleet aggregates the status frame
 * carries (design §1.5).
 *
 * Two properties matter and are easy to break:
 *
 *  1. NO IDENTIFIERS. `stats().topics` is keyed by topic name and ADHDev topic
 *     names embed session and mesh ids. Only aggregates may leave.
 *  2. DEDUP-SAFE VALUES. `sendUnifiedStatusReport` hashes the whole payload
 *     minus `timestamp` and suppresses identical frames. A raw monotonic
 *     counter here would change every tick and turn an idle daemon into a
 *     constant 30s transmitter — so growth is reported as a coarse bucket.
 */

function topic(over: Partial<NodeStats['topics'][string]> = {}): NodeStats['topics'][string] {
    return {
        writers: 1,
        logRows: 0,
        pending: 0,
        quarantined: 0,
        archived: 0,
        finalityGeneration: null,
        certOrderAgeMs: null,
        consumers: {},
        ...over,
    };
}

const HOUR = 60 * 60 * 1000;

describe('summarizeSeqscribeStats', () => {
    it('reports an idle node as all-zero', () => {
        const summary = summarizeSeqscribeStats(
            { topics: { 'assistant.journal': topic() }, peers: [] },
            { authorityEnabled: false },
        );

        expect(summary).toEqual({
            topics: 1,
            peers: 0,
            peersReady: 0,
            pendingBucket: 0,
            consumerLagBucket: 0,
            queueBucket: 0,
            fgenAgeBucket: 0,
            quarantined: false,
            authority: false,
            // Stage 2+3 fields with neither `dualWrite` nor `parity` supplied:
            // a daemon whose shadow leg never armed reports it as inactive and
            // its buckets as zero, rather than omitting the keys — a reader
            // must be able to tell "shadow off" from "older daemon".
            dualWrite: false,
            dualWriteFailedBucket: 0,
            dualWriteDroppedBucket: 0,
            parityMismatchBucket: 0,
            parityRan: false,
        });
    });

    it('buckets the dual-write and parity counters instead of passing them through', () => {
        const summary = summarizeSeqscribeStats(
            { topics: { 'assistant.journal': topic() }, peers: [] },
            {
                authorityEnabled: true,
                dualWrite: { active: true, failed: 4, dropped: 250 },
                parity: { runs: 3, mismatches: 12 },
            },
        );

        expect(summary.dualWrite).toBe(true);
        expect(summary.parityRan).toBe(true);
        // BACKLOG_BUCKETS = [1, 10, 100, 1000] → ordinals, never the raw count.
        // This is what keeps the status frame byte-identical while a counter
        // creeps, so the server-side dedup keeps suppressing idle frames.
        expect(summary.dualWriteFailedBucket).toBe(2);
        expect(summary.dualWriteDroppedBucket).toBe(4);
        expect(summary.parityMismatchBucket).toBe(3);
        expect(summary.dualWriteFailedBucket).not.toBe(4);
        expect(summary.parityMismatchBucket).not.toBe(12);
    });

    it('emits no topic names, peer ids or other identifiers', () => {
        const summary = summarizeSeqscribeStats(
            {
                topics: {
                    'session.sess-abc123.transcript': topic({ pending: 2 }),
                    'mesh.mesh_deadbeef.events': topic({ logRows: 900 }),
                },
                peers: [
                    { peerId: 'peer-secret-1', state: 'ready', dirtyStreams: 0, queuedData: 0 },
                ],
            },
            { authorityEnabled: true },
        );

        const serialized = JSON.stringify(summary);
        for (const identifier of ['sess-abc123', 'mesh_deadbeef', 'peer-secret-1', 'transcript']) {
            expect(serialized).not.toContain(identifier);
        }
        for (const value of Object.values(summary)) {
            expect(['number', 'boolean']).toContain(typeof value);
        }
    });

    it('takes the worst value across topics, not the first or an average', () => {
        const summary = summarizeSeqscribeStats(
            {
                topics: {
                    quiet: topic({ pending: 0, consumers: { a: { lastRowid: 5, lagRows: 0 } } }),
                    busy: topic({ pending: 40, consumers: { b: { lastRowid: 1, lagRows: 500 } } }),
                },
                peers: [
                    { peerId: 'p1', state: 'ready', dirtyStreams: 0, queuedData: 0 },
                    { peerId: 'p2', state: 'attached', dirtyStreams: 3, queuedData: 250 },
                ],
            },
            { authorityEnabled: true },
        );

        expect(summary.topics).toBe(2);
        expect(summary.peers).toBe(2);
        expect(summary.peersReady).toBe(1); // only `ready` peers are actually syncing
        expect(summary.pendingBucket).toBe(3); // 40 → [10,100)
        expect(summary.consumerLagBucket).toBe(4); // 500 → [100,1000)
        expect(summary.queueBucket).toBe(4); // 250 → [100,1000)
    });

    it('keeps buckets stable across small changes so the status dedup still collapses', () => {
        const at = (pending: number) =>
            summarizeSeqscribeStats(
                { topics: { t: topic({ pending }) }, peers: [] },
                { authorityEnabled: true },
            );

        // A counter drifting inside one bucket must produce an IDENTICAL summary,
        // or every heartbeat defeats the dedup hash.
        expect(at(11)).toEqual(at(99));
        // ...but crossing a boundary must still be visible.
        expect(at(99)).not.toEqual(at(101));
    });

    it('buckets finality staleness in hours and surfaces quarantine as a flag', () => {
        const summary = summarizeSeqscribeStats(
            {
                topics: {
                    fresh: topic({ certOrderAgeMs: 30 * 60 * 1000 }),
                    stale: topic({ certOrderAgeMs: 30 * HOUR, quarantined: 4 }),
                },
                peers: [],
            },
            { authorityEnabled: true },
        );

        expect(summary.fgenAgeBucket).toBe(4); // 30h → [24,72)
        expect(summary.quarantined).toBe(true);
    });

    it('treats a never-certified topic as age zero rather than infinitely stale', () => {
        // `certOrderAgeMs: null` means "nothing certified yet" — with no
        // authority configured that is the normal steady state, not an alarm.
        const summary = summarizeSeqscribeStats(
            { topics: { t: topic({ certOrderAgeMs: null }) }, peers: [] },
            { authorityEnabled: false },
        );
        expect(summary.fgenAgeBucket).toBe(0);
    });
});
