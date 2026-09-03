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
 * These mock the node's read methods to cover argument shaping and the
 * never-throws contract cheaply.
 *
 * ★ A fake node is NOT sufficient on its own here, and this file used to be the
 * proof: its `headOrder` fake returned `{seq: 3}` unconditionally, which the
 * real library never does for this topic (`session.*.transcript` is a ring, and
 * ring entries never reach the `sq_log` table `headOrder` queries — it returns
 * `null` every time). The suite stayed green while live parity was a structural
 * 100% mismatch. Behaviour that depends on real retention/storage semantics
 * belongs in `transcript-parity-actual-real-node.test.ts`, which drives an
 * actual seqscribe node; keep these two in step when changing the read path.
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
    vectors?: () => Record<string, { writers: Record<string, { contig: number; chain: string }> }>;
    scanEntries?: (topic: string, o: unknown) => { entries: unknown[] };
} = {}): SeqscribeNodeHandle {
    const node = {
        // ★ NOT `headOrder`. The reader deliberately does not call it — on this
        // ring topic the real library always answers `null` there (see the
        // real-node suite). It reads the writer's `contig` head via `vectors()`
        // instead, so that is what this fake must model.
        vectors:
            opts.vectors ??
            (() => ({
                'session.sess-1.transcript': {
                    writers: { [IDENTITY.producerWriterId]: { contig: 3, chain: 'c' } },
                },
            })),
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
    it('missing when the writer has no entries on the topic yet', () => {
        const node = fakeNode({ vectors: () => ({}) });
        expect(readLocalTranscriptParityActual(node, IDENTITY.sessionId, IDENTITY.producerWriterId)).toEqual({ status: 'missing' });
    });

    it('missing when reading the writer head throws', () => {
        const node = fakeNode({ vectors: () => { throw new Error('boom'); } });
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

    it('anchors the scan window to the writer head, not to seq 1', () => {
        let calledWith: unknown = null;
        const node = fakeNode({
            vectors: () => ({
                'session.sess-1.transcript': {
                    writers: { [IDENTITY.producerWriterId]: { contig: 900, chain: 'c' } },
                },
            }),
            scanEntries: (topic, o) => {
                calledWith = { topic, o };
                return { entries: [], complete: true, truncatedBelow: false };
            },
        });
        readLocalTranscriptParityActual(node, IDENTITY.sessionId, IDENTITY.producerWriterId);
        // head 900, 500-wide window → 401..900. A `fromSeq` of 1 here would
        // read 1..500 and miss every row the ring actually still holds.
        expect(calledWith).toEqual({
            topic: 'session.sess-1.transcript',
            o: { writer: IDENTITY.producerWriterId, fromSeq: 401, limit: 500 },
        });
    });

    it('starts at seq 1 while the writer head is still below the window width', () => {
        let calledWith: unknown = null;
        const node = fakeNode({
            scanEntries: (topic, o) => {
                calledWith = { topic, o };
                return { entries: [], complete: true, truncatedBelow: false };
            },
        });
        readLocalTranscriptParityActual(node, IDENTITY.sessionId, IDENTITY.producerWriterId);
        expect(calledWith).toEqual({
            topic: 'session.sess-1.transcript',
            o: { writer: IDENTITY.producerWriterId, fromSeq: 1, limit: 500 },
        });
    });
});
