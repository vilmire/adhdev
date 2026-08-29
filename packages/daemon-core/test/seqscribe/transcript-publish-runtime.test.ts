import { describe, expect, it, vi } from 'vitest';
import type { SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import { sessionTranscriptTopic } from '../../src/seqscribe/topics.js';
import { __resetTranscriptParityForTests, transcriptParityCounters } from '../../src/seqscribe/transcript-parity.js';
import { createLiveTranscriptPublisher } from '../../src/seqscribe/transcript-publish-runtime.js';
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
        headOrder: () => ({ seq: appended.length }),
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
