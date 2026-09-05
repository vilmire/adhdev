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
            dualWriteBackfilledBucket: 0,
            parityMismatchBucket: 0,
            parityPersistentMismatchBucket: 0,
            parityRan: false,
            parityMissingInShadowBucket: 0,
            parityExtraInShadowBucket: 0,
            parityFieldMismatchBucket: 0,
            // §8 unit 2: transcript single-observation publisher + parity —
            // same "report inactive/zero, never omit" discipline as the
            // dualWrite/parity block above.
            transcriptPublish: false,
            transcriptPublishedBucket: 0,
            transcriptPublishFailedBucket: 0,
            transcriptDedupedBucket: 0,
            transcriptOversizedBucket: 0,
            transcriptDroppedBucket: 0,
            transcriptParityRan: false,
            transcriptParityMismatchBucket: 0,
            transcriptParityPersistentMismatchBucket: 0,
        });
    });

    it('buckets the dual-write and parity counters instead of passing them through', () => {
        const summary = summarizeSeqscribeStats(
            { topics: { 'assistant.journal': topic() }, peers: [] },
            {
                authorityEnabled: true,
                dualWrite: { active: true, failed: 4, dropped: 250, backfilled: 40 },
                parity: {
                    runs: 3,
                    mismatches: 24,
                    persistentMismatches: 2,
                    missingInShadow: 9,
                    extraInShadow: 15,
                    fieldMismatch: 0,
                },
            },
        );

        expect(summary.dualWrite).toBe(true);
        expect(summary.parityRan).toBe(true);
        // BACKLOG_BUCKETS = [1, 10, 100, 1000] → ordinals, never the raw count.
        // This is what keeps the status frame byte-identical while a counter
        // creeps, so the server-side dedup keeps suppressing idle frames.
        expect(summary.dualWriteFailedBucket).toBe(2);
        expect(summary.dualWriteDroppedBucket).toBe(4);
        expect(summary.parityMismatchBucket).toBe(3); // 24 → [10,100)
        expect(summary.dualWriteFailedBucket).not.toBe(4);
        expect(summary.parityMismatchBucket).not.toBe(24);
        // The backfill counter follows the SAME bucket discipline. It has to:
        // on a machine running mesh MCP tools it is the counter that ticks most,
        // since every mcp-server append is repaired here — passing it through
        // raw would defeat the status-frame dedup single-handedly.
        // 40 → under the 100 threshold → ordinal 3 (distinct from dropped's 250,
        // which lands at 4), so this pins the bucketing rather than a constant.
        expect(summary.dualWriteBackfilledBucket).toBe(3);
        expect(summary.dualWriteBackfilledBucket).not.toBe(40);
        // ★ `parityPersistentMismatchBucket` answers "is the read cutover
        // blocked"; the combined `parityMismatchBucket` answers only "was
        // anything ever detected", which is EXPECTED to be nonzero in normal
        // operation (mcp-server appends, repaired by the backfill). The two are
        // bucketed independently from their own raw counts, so a healthy daemon
        // reads as mismatch-nonzero + persistent-zero.
        expect(summary.parityPersistentMismatchBucket).toBe(2); // 2 → [1,10)
        expect(summary.parityPersistentMismatchBucket).not.toBe(
            summary.parityMismatchBucket,
        );
        // The per-class axes answer "blocked by what" — each bucketed
        // independently against its OWN raw count, not derived from the
        // combined total, so they need not sum to it.
        expect(summary.parityMissingInShadowBucket).toBe(2); // 9 → [1,10)
        expect(summary.parityExtraInShadowBucket).toBe(3); // 15 → [10,100)
        expect(summary.parityFieldMismatchBucket).toBe(0); // 0 → none
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
        // Full topic names, not the bare word "transcript" — §8 unit 2 adds
        // legitimate `transcript*`-prefixed FIELD NAMES (transcriptPublish,
        // transcriptParityRan, ...) to this same summary object, so a bare
        // substring check on the word itself would flag its own field names as
        // a false-positive leak. What must never appear is the session/mesh id
        // EMBEDDED IN a topic name.
        for (const identifier of ['sess-abc123', 'mesh_deadbeef', 'peer-secret-1', 'session.sess-abc123.transcript', 'mesh.mesh_deadbeef.events']) {
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
     * Stage 4A read-path routing on the LOCAL surface.
     *
     * The point of the field is diagnosing WHICH readiness condition is holding
     * a mesh on the ledger. Before it, a live daemon could report a perfectly
     * healthy replication picture (dualWrite armed, parity clean) while every
     * read still fell back, and there was no way to tell that apart from the
     * gate never being consulted at all — which is precisely the misdiagnosis
     * that motivated this field.
     */
    describe('read-path routing counters (Stage 4A)', () => {
        const routing = {
            fromReplica: 412,
            fromLedger: 9,
            fallbacks: { consumer_lag: 7, parity_mismatch: 2 },
        };

        it('surfaces the counters and the per-reason fallback breakdown', () => {
            const summary = summarizeSeqscribeStats(
                { topics: { t: topic() }, peers: [] },
                { authorityEnabled: true, includeLocalDiagnostics: true, readRouting: routing },
            );

            expect(summary.readRouting).toEqual(routing);
            // The reason is the whole value of the field: it names the condition
            // rather than only saying that *a* fallback happened.
            expect(summary.readRouting?.fallbacks.consumer_lag).toBe(7);
        });

        it('omits the counters unless local diagnostics are requested', () => {
            // The status reporter shares this projection with
            // `get_status_metadata`. These are RAW monotonic counters, so if
            // they rode the deduped status frame every heartbeat would hash
            // differently and an idle daemon would transmit forever.
            const summary = summarizeSeqscribeStats(
                { topics: { t: topic() }, peers: [] },
                { authorityEnabled: true, readRouting: routing },
            );
            expect(summary).not.toHaveProperty('readRouting');
        });

        it('copies the counters so a later read cannot mutate a held snapshot', () => {
            const live = { fromReplica: 1, fromLedger: 0, fallbacks: { consumer_lag: 1 } };
            const summary = summarizeSeqscribeStats(
                { topics: { t: topic() }, peers: [] },
                { authorityEnabled: true, includeLocalDiagnostics: true, readRouting: live },
            );

            live.fallbacks.consumer_lag = 99;
            live.fromReplica = 99;

            expect(summary.readRouting?.fallbacks.consumer_lag).toBe(1);
            expect(summary.readRouting?.fromReplica).toBe(1);
        });
    });

    /**
     * ★ §8 unit 2 transcript parity, RAW — the numbers §5.6's last open gate
     * condition (`persistent mismatch 0`) needs in order to be DECIDABLE at all.
     *
     * The bucketed `transcriptParity*Bucket` fields cannot decide it. Promotion
     * to persistent for `missing_complete_revision` requires a session key's
     * SECOND comparison, and the only non-test caller is a per-append self-check
     * — so a daemon can report `transcriptParityRan: true` with
     * `transcriptParityPersistentMismatchBucket: 0` having never once evaluated
     * the recurrence rule. `sessionsRepeated`/`pendingMissingRevisits` are what
     * make "clean" separable from "undecided", and `since`/`uptimeMs` keep a
     * restart-reset 0 from being read as clean.
     */
    describe('★transcript parity raw detail (§5.6 gate decidability)', () => {
        const counters = {
            runs: 9,
            compared: 9,
            mismatches: 3,
            persistentMismatches: 1,
            missingCompleteRevision: 2,
            fieldMismatch: 1,
            extraMessage: 0,
            wrongSession: 0,
            wrongOwner: 0,
            digestMismatch: 0,
            sessionsObserved: 4,
            sessionsRepeated: 3,
            pendingMissingRevisits: 2,
            pendingMissingOpen: 1,
            since: 1_700_000_000_000,
        };

        it('surfaces the raw counters, the six-class split and the recurrence axes', () => {
            const summary = summarizeSeqscribeStats(
                { topics: { t: topic() }, peers: [] },
                { authorityEnabled: true, includeLocalDiagnostics: true, transcriptParity: counters },
            );

            const detail = summary.transcriptParityDetail;
            expect(detail).toBeDefined();
            expect(detail?.compared).toBe(9);
            expect(detail?.missingCompleteRevision).toBe(2);
            expect(detail?.fieldMismatch).toBe(1);
            expect(detail?.digestMismatch).toBe(0);
            // The decidability pair — without these, persistentMismatches: 1 (or
            // 0) is a number with no interpretation.
            expect(detail?.sessionsRepeated).toBe(3);
            expect(detail?.pendingMissingRevisits).toBe(2);
            expect(detail?.pendingMissingOpen).toBe(1);
        });

        it('★dates the counters so a restart-reset zero is distinguishable', () => {
            const summary = summarizeSeqscribeStats(
                { topics: { t: topic() }, peers: [] },
                { authorityEnabled: true, includeLocalDiagnostics: true, transcriptParity: counters },
            );
            expect(summary.transcriptParityDetail?.since).toBe(1_700_000_000_000);
            expect(summary.transcriptParityDetail?.uptimeMs).toBeGreaterThan(0);
        });

        it('defaults `since` to now rather than 0 when a caller passes only the bucket fields', () => {
            // A 0 stamp renders as 1970 and would read as "counting for 56
            // years" — the opposite of the honesty this field exists for.
            const before = Date.now();
            const summary = summarizeSeqscribeStats(
                { topics: { t: topic() }, peers: [] },
                {
                    authorityEnabled: true,
                    includeLocalDiagnostics: true,
                    transcriptParity: { runs: 1, mismatches: 0 },
                },
            );
            expect(summary.transcriptParityDetail?.since).toBeGreaterThanOrEqual(before);
            expect(summary.transcriptParityDetail?.uptimeMs).toBe(0);
        });

        it('omits the detail unless local diagnostics are requested', () => {
            // The status reporter shares this projection. These are RAW
            // monotonic counters — on the deduped status frame they would make
            // every heartbeat unique and turn an idle daemon into a constant
            // transmitter, the same reason readRouting is gated above.
            const summary = summarizeSeqscribeStats(
                { topics: { t: topic() }, peers: [] },
                { authorityEnabled: true, transcriptParity: counters },
            );
            expect(summary).not.toHaveProperty('transcriptParityDetail');
            // The bucketed fields still come through — the gate withholds the
            // raw detail only, not the existing cloud-facing evidence.
            expect(summary.transcriptParityRan).toBe(true);
            expect(summary.transcriptParityPersistentMismatchBucket).toBeGreaterThan(0);
        });
    });
});
