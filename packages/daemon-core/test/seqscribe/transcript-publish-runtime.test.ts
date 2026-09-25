import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import { sessionTranscriptTopic } from '../../src/seqscribe/topics.js';
import { __resetTranscriptParityForTests, transcriptParityCounters } from '../../src/seqscribe/transcript-parity.js';
import {
    TRANSCRIPT_PARITY_SAMPLE_EVERY_N,
    TRANSCRIPT_PARITY_SAMPLE_INTERVAL_MS,
    createLiveTranscriptPublisher,
} from '../../src/seqscribe/transcript-publish-runtime.js';
import { encodeTranscriptSnapshot, type TranscriptSnapshotCandidate } from '../../src/seqscribe/transcript-projection.js';
import {
    TRANSCRIPT_REVISION_BEGIN_KIND,
    TRANSCRIPT_REVISION_CHUNK_KIND,
    TRANSCRIPT_REVISION_COMMIT_KIND,
    encodeTranscriptRevision,
    type TranscriptRevisionIdentity,
} from '../../src/seqscribe/transcript-revision-codec.js';
import { TranscriptTopicClaimRegistry } from '../../src/seqscribe/transcript-topic-claim.js';

/**
 * §8 unit 3 — `createLiveTranscriptPublisher` arms `TranscriptProjectionService`
 * against a real node (this unit's headline job, per transcript-publisher.ts's
 * header) AND wires the parity comparator's `actual` side via a self-check
 * (transcript-parity-actual.ts) — the second deferral this unit inherits from
 * transcript-parity.ts's header.
 */

const IDENTITY: TranscriptRevisionIdentity = {
    sessionId: 'sess-1',
    producerDaemonId: 'daemon-a',
    producerWriterId: 'adhdev-writer-1',
    producerEpoch: 'epoch-1',
    revision: 1,
};

function candidate(): TranscriptSnapshotCandidate {
    return {
        sessionId: IDENTITY.sessionId,
        providerType: 'claude-code',
        producerDaemonId: IDENTITY.producerDaemonId,
        producerWriterId: IDENTITY.producerWriterId,
        producerEpoch: IDENTITY.producerEpoch,
        revision: IDENTITY.revision,
        observedAt: '2026-08-29T00:00:00.000Z',
        status: 'generating',
        messages: [{ role: 'assistant', kind: 'standard', content: 'hi' }],
        coverage: { mode: 'tail', totalMessageCount: 1, returnedMessageCount: 1, omittedBefore: false },
    };
}

function envelope() {
    const snapshot = encodeTranscriptSnapshot(candidate());
    const encoded = encodeTranscriptRevision(snapshot, IDENTITY);
    if (!encoded.ok) throw new Error('fixture encode failed');
    return { begin: encoded.begin, chunks: encoded.chunks, commit: encoded.commit };
}

function fakeNode(opts: {
    onAppend?: (kind: string, payload: unknown) => void;
    scanEntries?: () => { entries: unknown[] };
} = {}): SeqscribeNodeHandle {
    const appended: { kind: string; payload: unknown }[] = [];
    const node = {
        defineTopic: () => {},
        log: (_topic: string) => ({
            append: async (kind: string, payload: unknown) => {
                appended.push({ kind, payload });
                opts.onAppend?.(kind, payload);
                return ['topic', IDENTITY.producerWriterId, appended.length] as const;
            },
        }),
        // The parity reader anchors its scan window to this writer's `contig`
        // head via `vectors()` — it deliberately does NOT use `headOrder`,
        // which on a real ring topic always answers null (see
        // transcript-parity-actual-real-node.test.ts). Model the head the same
        // way a real node would: one seq per appended row.
        vectors: () => ({
            [sessionTranscriptTopic(IDENTITY.sessionId)]: {
                writers: { [IDENTITY.producerWriterId]: { contig: appended.length, chain: 'c' } },
            },
        }),
        scanEntries: opts.scanEntries ?? (() => ({
            entries: appended.map((e, i) => ({ writer: IDENTITY.producerWriterId, seq: i + 1, kind: e.kind, payload: e.payload })),
            complete: true,
            truncatedBelow: false,
        })),
    };
    return {
        node: node as unknown as SeqscribeNodeHandle['node'],
        writerId: IDENTITY.producerWriterId,
        daemonId: IDENTITY.producerDaemonId,
        dbPath: ':memory:',
        topics: [] as unknown as SeqscribeNodeHandle['topics'],
        authorityEnabled: true,
        finalityLoop: null,
        onClose: () => {},
        close: async () => {},
    };
}

describe('createLiveTranscriptPublisher — appends begin/chunks/commit in order', () => {
    it('appends begin, each chunk, then commit — in that order, to the session topic', async () => {
        const appendOrder: string[] = [];
        const node = fakeNode({ onAppend: (kind) => appendOrder.push(kind) });
        const publish = createLiveTranscriptPublisher(
            node,
            new TranscriptTopicClaimRegistry(),
            IDENTITY.producerDaemonId,
        );
        const env = envelope();
        const logSpy = vi.spyOn(node.node, 'log');

        await publish(IDENTITY.sessionId, env);

        expect(logSpy).toHaveBeenCalledWith(sessionTranscriptTopic(IDENTITY.sessionId));
        expect(appendOrder).toEqual([
            TRANSCRIPT_REVISION_BEGIN_KIND,
            ...env.chunks.map(() => TRANSCRIPT_REVISION_CHUNK_KIND),
            TRANSCRIPT_REVISION_COMMIT_KIND,
        ]);
    });

    it('throws (does not append) when topic activation is rejected — e.g. a raw-id claim conflict', async () => {
        const node = fakeNode();
        const claims = new TranscriptTopicClaimRegistry();
        claims.claim({ topic: sessionTranscriptTopic(IDENTITY.sessionId), rawSessionId: 'a-different-raw-id', ownerDaemonId: IDENTITY.producerDaemonId });
        const publish = createLiveTranscriptPublisher(node, claims, IDENTITY.producerDaemonId);

        await expect(publish(IDENTITY.sessionId, envelope())).rejects.toThrow(/raw_session_id_conflict/);
    });
});

describe('createLiveTranscriptPublisher — parity self-check (design §3.3/§5.3)', () => {
    it('records a clean comparison when the node round-trips the just-written revision', async () => {
        __resetTranscriptParityForTests();
        const node = fakeNode();
        const publish = createLiveTranscriptPublisher(node, new TranscriptTopicClaimRegistry(), IDENTITY.producerDaemonId);

        await publish(IDENTITY.sessionId, envelope());

        const counters = transcriptParityCounters();
        expect(counters.compared).toBe(1);
        expect(counters.mismatches).toBe(0);
    });

    it('a self-check failure (node storage returns something different) is recorded as a parity mismatch, not a publish failure', async () => {
        __resetTranscriptParityForTests();
        // scanEntries returns NOTHING — simulates the append succeeding but the
        // read-back finding no rows (a storage-layer bug the self-check exists
        // to catch).
        const node = fakeNode({ scanEntries: () => ({ entries: [], complete: true, truncatedBelow: false }) });
        const publish = createLiveTranscriptPublisher(node, new TranscriptTopicClaimRegistry(), IDENTITY.producerDaemonId);

        // The publish itself must NOT throw — parity is diagnostics only.
        await expect(publish(IDENTITY.sessionId, envelope())).resolves.toBeUndefined();

        const counters = transcriptParityCounters();
        expect(counters.missingCompleteRevision).toBe(1);
    });
});

/**
 * CPU fix (2026-09-25): the storage read-back half of the self-check is
 * SAMPLED — first publish per session, then once per
 * TRANSCRIPT_PARITY_SAMPLE_INTERVAL_MS or every TRANSCRIPT_PARITY_SAMPLE_EVERY_N
 * publishes. `ADHDEV_TRANSCRIPT_PARITY_SAMPLE_MS=0` restores every-publish.
 */
describe('createLiveTranscriptPublisher — parity read-back sampling', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
    });

    function setup() {
        __resetTranscriptParityForTests();
        const node = fakeNode();
        const scanSpy = vi.spyOn(node.node, 'scanEntries');
        const publish = createLiveTranscriptPublisher(node, new TranscriptTopicClaimRegistry(), IDENTITY.producerDaemonId);
        return { publish, scanSpy };
    }

    it('reads back on the first publish, then not again within the interval', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-25T00:00:00.000Z'));
        const { publish, scanSpy } = setup();

        for (let i = 0; i < 10; i += 1) {
            await publish(IDENTITY.sessionId, envelope());
            vi.advanceTimersByTime(500); // 10 publishes over 5 s < 10 s interval
        }

        expect(scanSpy).toHaveBeenCalledTimes(1);
        expect(transcriptParityCounters().compared).toBe(1);
    });

    it('reads back again once the interval has elapsed', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-25T00:00:00.000Z'));
        const { publish, scanSpy } = setup();

        await publish(IDENTITY.sessionId, envelope());
        vi.advanceTimersByTime(TRANSCRIPT_PARITY_SAMPLE_INTERVAL_MS - 1);
        await publish(IDENTITY.sessionId, envelope());
        expect(scanSpy).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(1);
        await publish(IDENTITY.sessionId, envelope());
        expect(scanSpy).toHaveBeenCalledTimes(2);
    });

    it('reads back every Nth publish even inside the interval', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-25T00:00:00.000Z'));
        const { publish, scanSpy } = setup();

        // publish #1 reads back; #2..#(N) are skipped; #(N+1) is the Nth since.
        for (let i = 0; i < TRANSCRIPT_PARITY_SAMPLE_EVERY_N; i += 1) {
            await publish(IDENTITY.sessionId, envelope());
        }
        expect(scanSpy).toHaveBeenCalledTimes(1);
        await publish(IDENTITY.sessionId, envelope());
        expect(scanSpy).toHaveBeenCalledTimes(2);
    });

    it('tracks sessions independently — a new session always reads back first', async () => {
        vi.useFakeTimers();
        const { publish, scanSpy } = setup();
        await publish(IDENTITY.sessionId, envelope());
        await publish('sess-2', envelope());
        expect(scanSpy).toHaveBeenCalledTimes(2);
    });

    it('ADHDEV_TRANSCRIPT_PARITY_SAMPLE_MS=0 reads back on every publish', async () => {
        vi.stubEnv('ADHDEV_TRANSCRIPT_PARITY_SAMPLE_MS', '0');
        vi.useFakeTimers();
        const { publish, scanSpy } = setup();
        for (let i = 0; i < 5; i += 1) await publish(IDENTITY.sessionId, envelope());
        expect(scanSpy).toHaveBeenCalledTimes(5);
        expect(transcriptParityCounters().compared).toBe(5);
    });

    it('passes the just-published row count as the narrow-window hint', async () => {
        const node = fakeNode();
        const scanSpy = vi.spyOn(node.node, 'scanEntries');
        const publish = createLiveTranscriptPublisher(node, new TranscriptTopicClaimRegistry(), IDENTITY.producerDaemonId);
        const env = envelope();
        await publish(IDENTITY.sessionId, env);
        // contig = rows appended = chunks + 2; width = that + 8 slack → fromSeq clamps to 1.
        expect(scanSpy.mock.calls[0]![1]).toEqual({
            writer: IDENTITY.producerWriterId,
            fromSeq: 1,
            limit: env.chunks.length + 2 + 8,
        });
    });
});
