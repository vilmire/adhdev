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
            // §8 unit 2: transcript single-observation publisher —
            // report inactive/zero, never omit. (The mesh `dualWrite*` /
            // `parity*` fields are gone — see the dedicated test below.)
            transcriptPublish: false,
            transcriptPublishedBucket: 0,
            transcriptPublishFailedBucket: 0,
            transcriptDedupedBucket: 0,
            transcriptOversizedBucket: 0,
            transcriptDroppedBucket: 0,
        });
    });

    it('carries no mesh dual-write / parity fields any more (C-W3: one write path; audit P1-4)', () => {
        const summary = summarizeSeqscribeStats({ topics: { t: topic() }, peers: [] }, { authorityEnabled: true, includeLocalDiagnostics: true });
        for (const key of Object.keys(summary)) {
            expect(key.startsWith('dualWrite')).toBe(false);
            expect(key.startsWith('parity')).toBe(false);
            expect(key.startsWith('transcriptParity')).toBe(false);
        }
        expect(summary).not.toHaveProperty('readRouting');
        expect(summary).not.toHaveProperty('terminalRedrive');
    });

    it('emits no topic names, peer ids or other identifiers', () => {
        const summary = summarizeSeqscribeStats(
            {
                topics: {
                    'session.sess-abc123.chat': topic({ pending: 2 }),
                    'mesh.mesh_deadbeef.events': topic({ logRows: 900 }),
                },
                peers: [
                    { peerId: 'peer-secret-1', state: 'ready', dirtyStreams: 0, queuedData: 0 },
                ],
            },
            { authorityEnabled: true },
        );

        const serialized = JSON.stringify(summary);
        // Full topic names, not the bare word "transcript" — §8 unit 2 adds
        // legitimate `transcript*`-prefixed FIELD NAMES (transcriptPublish,
        // transcriptPublishedBucket, ...) to this same summary object, so a bare
        // substring check on the word itself would flag its own field names as
        // a false-positive leak. What must never appear is the session/mesh id
        // EMBEDDED IN a topic name.
        for (const identifier of ['sess-abc123', 'mesh_deadbeef', 'peer-secret-1', 'session.sess-abc123.chat', 'mesh.mesh_deadbeef.events']) {
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

    /**
     * Coordinator-notice delivery (C7-4) on the LOCAL surface: the turn cursors'
     * raw counters ride only when local diagnostics are requested (they would
     * defeat the status-frame dedup), and are copied, never aliased.
     */
    describe('mesh delivery counters (C7-4)', () => {
        const counters = { delivered: 5, deferred: 2, escalated: 1, suppressed: 0 };

        it('surfaces the counters under includeLocalDiagnostics', () => {
            const summary = summarizeSeqscribeStats({ topics: { t: topic() }, peers: [] }, { authorityEnabled: true, includeLocalDiagnostics: true, meshDelivery: counters });
            expect(summary.meshDelivery).toEqual(counters);
        });

        it('omits the counters unless local diagnostics are requested', () => {
            const summary = summarizeSeqscribeStats({ topics: { t: topic() }, peers: [] }, { authorityEnabled: true, meshDelivery: counters });
            expect(summary).not.toHaveProperty('meshDelivery');
        });

        it('copies the counters so a later read cannot mutate a held snapshot', () => {
            const live = { delivered: 1 };
            const summary = summarizeSeqscribeStats({ topics: { t: topic() }, peers: [] }, { authorityEnabled: true, includeLocalDiagnostics: true, meshDelivery: live });
            live.delivered = 99;
            expect(summary.meshDelivery?.delivered).toBe(1);
        });
    });

    /**
     * G2 handshake RCA (design §7e, `scratchpad/transcript-handshake-rca.md`
     * finding #5): before this field there was no daemon-side counter for how
     * often a dashboard peer's seqscribe connection was judged zombie and
     * recovered — see `packages/daemon-cloud/src/daemon-p2p/
     * data-channel-router.ts` `getZombiePeerRecoveryCount`. Same
     * local-only/dedup-safe discipline as `readRouting` above: this test file
     * pins that this field follows the identical opt-in and copy-on-read
     * contract as every other local-only counter here.
     */
    describe('transcript-lane zombie-recovery counter', () => {
        const selection = {
            zombieRecovered: 1,
        };

        it('surfaces the counters when local diagnostics are requested', () => {
            const summary = summarizeSeqscribeStats(
                { topics: { t: topic() }, peers: [] },
                { authorityEnabled: true, includeLocalDiagnostics: true, transcriptLane: selection },
            );

            expect(summary.transcriptLane).toEqual(selection);
            expect(summary.transcriptLane?.zombieRecovered).toBe(1);
        });

        it('omits the counters unless local diagnostics are requested', () => {
            // These are RAW monotonic counters (like readRouting/terminalRedrive
            // above them in stats.ts) — if they rode the deduped status frame,
            // every heartbeat would hash differently and an idle daemon would
            // transmit forever. `buildCloudSeqscribeSummary` (status/reporter.ts)
            // is a fixed-key allow-list that does not name this key either way.
            const summary = summarizeSeqscribeStats(
                { topics: { t: topic() }, peers: [] },
                { authorityEnabled: true, transcriptLane: selection },
            );
            expect(summary).not.toHaveProperty('transcriptLane');
        });

        it('copies the counters so a later read cannot mutate a held snapshot', () => {
            const live = { zombieRecovered: 0 };
            const summary = summarizeSeqscribeStats(
                { topics: { t: topic() }, peers: [] },
                { authorityEnabled: true, includeLocalDiagnostics: true, transcriptLane: live },
            );

            live.zombieRecovered = 99;

            expect(summary.transcriptLane?.zombieRecovered).toBe(0);
        });
    });
});
