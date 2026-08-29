import { describe, expect, it } from 'vitest';
import type { SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import { readLocalTranscriptParityActual } from '../../src/seqscribe/transcript-parity-actual.js';
import { encodeTranscriptSnapshot, type TranscriptSnapshotCandidate } from '../../src/seqscribe/transcript-projection.js';
import {
    TRANSCRIPT_REVISION_BEGIN_KIND,
    TRANSCRIPT_REVISION_CHUNK_KIND,
    TRANSCRIPT_REVISION_COMMIT_KIND,
    encodeTranscriptRevision,
    type TranscriptRevisionIdentity,
} from '../../src/seqscribe/transcript-revision-codec.js';

/**
 * §8 unit 3 — the parity comparator's `actual` reader (design §3.3/§5.3).
 *
 * Mocks `node.node.headOrder`/`scanEntries` directly (the same level
 * `mesh-consumer-lifecycle.test.ts` exercises against a REAL node for the
 * mesh events topic; this module is exercised against a fake one since it
 * only calls two node methods and the interesting behavior is entirely in
 * how it interprets their results).
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

function entriesFor(identity: TranscriptRevisionIdentity) {
    const snapshot = encodeTranscriptSnapshot(candidate());
    const encoded = encodeTranscriptRevision(snapshot, identity);
    if (!encoded.ok) throw new Error('fixture encode failed');
    const entries: { writer: string; seq: number; kind: string; payload: unknown }[] = [
        { writer: identity.producerWriterId, seq: 1, kind: TRANSCRIPT_REVISION_BEGIN_KIND, payload: encoded.begin },
    ];
    encoded.chunks.forEach((chunk, i) => {
        entries.push({ writer: identity.producerWriterId, seq: 2 + i, kind: TRANSCRIPT_REVISION_CHUNK_KIND, payload: chunk });
    });
    entries.push({ writer: identity.producerWriterId, seq: 2 + encoded.chunks.length, kind: TRANSCRIPT_REVISION_COMMIT_KIND, payload: encoded.commit });
    return entries;
}

function fakeNode(opts: {
    headOrder?: () => { seq: number } | null;
    scanEntries?: (topic: string, o: unknown) => { entries: unknown[] };
} = {}): SeqscribeNodeHandle {
    const node = {
        headOrder: opts.headOrder ?? (() => ({ seq: 3 })),
        scanEntries: opts.scanEntries ?? (() => ({ entries: [], complete: true, truncatedBelow: false })),
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

describe('readLocalTranscriptParityActual', () => {
    it('missing when headOrder returns null (no entries on the topic yet)', () => {
        const node = fakeNode({ headOrder: () => null });
        expect(readLocalTranscriptParityActual(node, IDENTITY.sessionId, IDENTITY.producerWriterId)).toEqual({ status: 'missing' });
    });

    it('missing when headOrder throws', () => {
        const node = fakeNode({ headOrder: () => { throw new Error('boom'); } });
        expect(readLocalTranscriptParityActual(node, IDENTITY.sessionId, IDENTITY.producerWriterId)).toEqual({ status: 'missing' });
    });

    it('missing when scanEntries throws', () => {
        const node = fakeNode({ scanEntries: () => { throw new Error('boom'); } });
        expect(readLocalTranscriptParityActual(node, IDENTITY.sessionId, IDENTITY.producerWriterId)).toEqual({ status: 'missing' });
    });

    it('missing when the scanned rows never assemble a complete revision (e.g. commit missing)', () => {
        const rows = entriesFor(IDENTITY).slice(0, -1); // drop the commit row
        const node = fakeNode({ scanEntries: () => ({ entries: rows, complete: true, truncatedBelow: false }) });
        expect(readLocalTranscriptParityActual(node, IDENTITY.sessionId, IDENTITY.producerWriterId)).toEqual({ status: 'missing' });
    });

    it('found: a complete begin/chunk/commit set assembles into the snapshot', () => {
        const rows = entriesFor(IDENTITY);
        const node = fakeNode({ scanEntries: () => ({ entries: rows, complete: true, truncatedBelow: false }) });
        const result = readLocalTranscriptParityActual(node, IDENTITY.sessionId, IDENTITY.producerWriterId);
        expect(result.status).toBe('found');
        if (result.status === 'found') {
            expect(result.snapshot.sessionId).toBe(IDENTITY.sessionId);
            expect(result.snapshot.messages).toHaveLength(1);
        }
    });

    it('passes the pinned headOrder.seq as toSeq and the expected writer to scanEntries', () => {
        let calledWith: unknown = null;
        const node = fakeNode({
            headOrder: () => ({ seq: 42 }),
            scanEntries: (topic, o) => {
                calledWith = { topic, o };
                return { entries: [], complete: true, truncatedBelow: false };
            },
        });
        readLocalTranscriptParityActual(node, IDENTITY.sessionId, IDENTITY.producerWriterId);
        expect(calledWith).toEqual({
            topic: 'session.sess-1.transcript',
            o: { writer: IDENTITY.producerWriterId, toSeq: 42 },
        });
    });
});
