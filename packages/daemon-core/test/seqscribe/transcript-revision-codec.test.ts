import { describe, expect, it } from 'vitest';
import { encodeTranscriptSnapshot, type TranscriptSnapshotCandidate } from '../../src/seqscribe/transcript-projection.js';
import {
    MAX_TRANSCRIPT_REVISION_CHUNKS,
    MAX_TRANSCRIPT_REVISION_ROWS,
    TRANSCRIPT_REVISION_BEGIN_KIND,
    TRANSCRIPT_REVISION_CHUNK_BYTES,
    TRANSCRIPT_REVISION_CHUNK_KIND,
    TRANSCRIPT_REVISION_COMMIT_KIND,
    TranscriptRevisionAssembler,
    encodeTranscriptRevision,
    type TranscriptRevisionChunkV1,
    type TranscriptRevisionIdentity,
    type TranscriptRevisionRow,
} from '../../src/seqscribe/transcript-revision-codec.js';
import { SESSION_TRANSCRIPT_RING } from '../../src/seqscribe/topics.js';

const IDENTITY: TranscriptRevisionIdentity = {
    sessionId: 'sess-raw-1',
    producerDaemonId: 'daemon-a',
    producerWriterId: 'adhdev-writer-1',
    producerEpoch: 'epoch-1',
    revision: 1,
};

function candidateWithContentBytes(byteLength: number): TranscriptSnapshotCandidate {
    return {
        sessionId: IDENTITY.sessionId,
        providerType: 'claude-code',
        producerDaemonId: IDENTITY.producerDaemonId,
        producerWriterId: IDENTITY.producerWriterId,
        producerEpoch: IDENTITY.producerEpoch,
        revision: IDENTITY.revision,
        observedAt: '2026-08-29T00:00:00.000Z',
        status: 'generating',
        messages: [{ role: 'assistant', kind: 'standard', content: 'x'.repeat(byteLength) }],
        coverage: { mode: 'tail', totalMessageCount: 1, returnedMessageCount: 1, omittedBefore: false },
    };
}

function rowsOf(result: {
    ok: true;
    begin: unknown;
    chunks: readonly unknown[];
    commit: unknown;
}): TranscriptRevisionRow[] {
    const rows: TranscriptRevisionRow[] = [
        { writer: IDENTITY.producerWriterId, seq: 1, kind: TRANSCRIPT_REVISION_BEGIN_KIND, payload: result.begin },
    ];
    result.chunks.forEach((chunk, i) => {
        rows.push({ writer: IDENTITY.producerWriterId, seq: 2 + i, kind: TRANSCRIPT_REVISION_CHUNK_KIND, payload: chunk });
    });
    rows.push({
        writer: IDENTITY.producerWriterId,
        seq: 2 + result.chunks.length,
        kind: TRANSCRIPT_REVISION_COMMIT_KIND,
        payload: result.commit,
    });
    return rows;
}

describe('encodeTranscriptRevision — chunking + budget (design §3.3)', () => {
    it('encodes a small snapshot into exactly one chunk', () => {
        const snapshot = encodeTranscriptSnapshot(candidateWithContentBytes(10));
        const result = encodeTranscriptRevision(snapshot, IDENTITY, () => '2026-08-29T00:00:00.000Z');
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('unreachable');
        expect(result.chunks.length).toBe(1);
        expect(result.begin.chunks).toBe(1);
        expect(result.commit.snapshotSha256).toBe(result.begin.snapshotSha256);
    });

    it('splits a snapshot larger than one chunk into multiple ordered chunks', () => {
        // Comfortably larger than TRANSCRIPT_REVISION_CHUNK_BYTES once JSON overhead is included.
        const snapshot = encodeTranscriptSnapshot(candidateWithContentBytes(TRANSCRIPT_REVISION_CHUNK_BYTES * 3));
        const result = encodeTranscriptRevision(snapshot, IDENTITY, () => '2026-08-29T00:00:00.000Z');
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('unreachable');
        expect(result.chunks.length).toBeGreaterThan(1);
        result.chunks.forEach((chunk, i) => expect(chunk.index).toBe(i));
        // Every chunk but the last is exactly a full chunk of bytes.
        for (let i = 0; i < result.chunks.length - 1; i++) {
            expect(Buffer.from(result.chunks[i]!.dataBase64, 'base64').length).toBe(TRANSCRIPT_REVISION_CHUNK_BYTES);
        }
    });

    it('MAX_TRANSCRIPT_REVISION_ROWS leaves room for two generations in the 500-entry ring', () => {
        // design §3.3: "500-entry 링에 직전 complete revision 240행과 다음 in-flight
        // revision 240행이 동시에 남고도 20행 여유가 생긴다" — pin that arithmetic so a
        // change to either constant is a deliberate, reviewed decision.
        expect(MAX_TRANSCRIPT_REVISION_ROWS).toBe(240);
        expect(MAX_TRANSCRIPT_REVISION_CHUNKS).toBe(238);
        expect(2 * MAX_TRANSCRIPT_REVISION_ROWS).toBeLessThan(SESSION_TRANSCRIPT_RING);
        expect(SESSION_TRANSCRIPT_RING - 2 * MAX_TRANSCRIPT_REVISION_ROWS).toBe(20);
    });

    it('at the 238-chunk boundary the revision still encodes', () => {
        const bytesForExactBoundary = TRANSCRIPT_REVISION_CHUNK_BYTES * MAX_TRANSCRIPT_REVISION_CHUNKS - 2000; // headroom for JSON overhead (keys, other fields)
        const snapshot = encodeTranscriptSnapshot(candidateWithContentBytes(bytesForExactBoundary));
        const result = encodeTranscriptRevision(snapshot, IDENTITY, () => '2026-08-29T00:00:00.000Z');
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.chunks.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_REVISION_CHUNKS);
    });

    it('past 238 chunks: oversize is refused, not silently truncated (owner decision §9 item 3)', () => {
        const snapshot = encodeTranscriptSnapshot(
            candidateWithContentBytes(TRANSCRIPT_REVISION_CHUNK_BYTES * (MAX_TRANSCRIPT_REVISION_CHUNKS + 5)),
        );
        const result = encodeTranscriptRevision(snapshot, IDENTITY, () => '2026-08-29T00:00:00.000Z');
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe('projection_oversize');
            expect(result.chunkCount).toBeGreaterThan(MAX_TRANSCRIPT_REVISION_CHUNKS);
        }
    });
});

describe('TranscriptRevisionAssembler — fail-closed reassembly (design §3.3/§3.4)', () => {
    function encode(byteLength = 10) {
        const snapshot = encodeTranscriptSnapshot(candidateWithContentBytes(byteLength));
        const result = encodeTranscriptRevision(snapshot, IDENTITY, () => '2026-08-29T00:00:00.000Z');
        if (!result.ok) throw new Error('test setup: expected ok encode');
        return result;
    }

    it('round-trips a single-chunk revision in order', () => {
        const encoded = encode();
        const assembler = new TranscriptRevisionAssembler(IDENTITY.producerWriterId);
        const rows = rowsOf(encoded);
        expect(assembler.ingestRow(rows[0]!)).toEqual({ status: 'begin_accepted' });
        expect(assembler.ingestRow(rows[1]!)).toEqual({ status: 'chunk_accepted' });
        const result = assembler.ingestRow(rows[2]!);
        expect(result.status).toBe('complete');
        expect(assembler.getLatestComplete()?.snapshot.messages[0]?.content.length).toBe(10);
    });

    it('round-trips a multi-chunk revision delivered IN SHUFFLED order', () => {
        const encoded = encodeTranscriptRevision(
            encodeTranscriptSnapshot(candidateWithContentBytes(TRANSCRIPT_REVISION_CHUNK_BYTES * 3)),
            IDENTITY,
            () => '2026-08-29T00:00:00.000Z',
        );
        if (!encoded.ok) throw new Error('setup');
        const assembler = new TranscriptRevisionAssembler(IDENTITY.producerWriterId);
        const [beginRow, ...rest] = rowsOf(encoded);
        const commitRow = rest.pop()!;
        const shuffledChunks = [...rest].reverse();

        assembler.ingestRow(beginRow!);
        for (const row of shuffledChunks) expect(assembler.ingestRow(row).status).toBe('chunk_accepted');
        expect(assembler.ingestRow(commitRow).status).toBe('complete');
    });

    it('rejects a MISSING chunk at commit time and keeps the previous complete snapshot', () => {
        const first = encode(10);
        const assembler = new TranscriptRevisionAssembler(IDENTITY.producerWriterId);
        rowsOf(first).forEach((row) => assembler.ingestRow(row));
        const goodSnapshot = assembler.getLatestComplete();
        expect(goodSnapshot).not.toBeNull();

        const second = encodeTranscriptRevision(
            encodeTranscriptSnapshot({ ...candidateWithContentBytes(TRANSCRIPT_REVISION_CHUNK_BYTES * 3), revision: 2 }),
            { ...IDENTITY, revision: 2 },
            () => '2026-08-29T00:00:00.000Z',
        );
        if (!second.ok) throw new Error('setup');
        const rows = rowsOf(second);
        const withoutOneChunk = rows.filter((_, i) => i !== 1); // drop the first chunk row
        let lastResult;
        for (const row of withoutOneChunk) lastResult = assembler.ingestRow(row);
        expect(lastResult).toEqual({ status: 'rejected', reason: 'missing_chunk' });
        // Previous complete snapshot must still be served.
        expect(assembler.getLatestComplete()).toEqual(goodSnapshot);
    });

    it('rejects a DUPLICATE chunk index', () => {
        const encoded = encodeTranscriptRevision(
            encodeTranscriptSnapshot(candidateWithContentBytes(TRANSCRIPT_REVISION_CHUNK_BYTES * 2)),
            IDENTITY,
            () => '2026-08-29T00:00:00.000Z',
        );
        if (!encoded.ok) throw new Error('setup');
        const assembler = new TranscriptRevisionAssembler(IDENTITY.producerWriterId);
        const rows = rowsOf(encoded);
        assembler.ingestRow(rows[0]!); // begin
        assembler.ingestRow(rows[1]!); // chunk 0
        const duplicate = assembler.ingestRow(rows[1]!); // chunk 0 again
        expect(duplicate).toEqual({ status: 'rejected', reason: 'duplicate_chunk_index' });
    });

    it('rejects WRONG chunk count declared mid-stream', () => {
        const encoded = encode();
        const assembler = new TranscriptRevisionAssembler(IDENTITY.producerWriterId);
        const rows = rowsOf(encoded);
        assembler.ingestRow(rows[0]!);
        const tamperedChunk: TranscriptRevisionChunkV1 = { ...(rows[1]!.payload as TranscriptRevisionChunkV1), chunks: 99 };
        const result = assembler.ingestRow({ ...rows[1]!, payload: tamperedChunk });
        expect(result).toEqual({ status: 'rejected', reason: 'chunk_count_mismatch' });
    });

    it('rejects a HASH mismatch (tampered/corrupted chunk bytes)', () => {
        const encoded = encode();
        const assembler = new TranscriptRevisionAssembler(IDENTITY.producerWriterId);
        const rows = rowsOf(encoded);
        assembler.ingestRow(rows[0]!);
        const tamperedChunk: TranscriptRevisionChunkV1 = {
            ...(rows[1]!.payload as TranscriptRevisionChunkV1),
            dataBase64: Buffer.from('completely different bytes!!').toString('base64'),
        };
        assembler.ingestRow({ ...rows[1]!, payload: tamperedChunk });
        const result = assembler.ingestRow(rows[2]!);
        // Byte length differs from begin.snapshotBytes before hash is even checked.
        expect(result.status).toBe('rejected');
        expect((result as { reason: string }).reason).toMatch(/byte_count_mismatch|hash_mismatch/);
    });

    it('rejects WRONG session id at commit', () => {
        const encoded = encode();
        const assembler = new TranscriptRevisionAssembler(IDENTITY.producerWriterId);
        const rows = rowsOf(encoded);
        assembler.ingestRow(rows[0]!);
        assembler.ingestRow(rows[1]!);
        const tamperedCommit = { ...(rows[2]!.payload as object), sessionId: 'some-other-session' };
        const result = assembler.ingestRow({ ...rows[2]!, payload: tamperedCommit });
        expect(result).toEqual({ status: 'rejected', reason: 'revision_identity_mismatch' });
    });

    it('rejects a DIFFERENT writer (owner gate) on any row, not just begin', () => {
        const encoded = encode();
        const assembler = new TranscriptRevisionAssembler(IDENTITY.producerWriterId);
        const rows = rowsOf(encoded);
        assembler.ingestRow(rows[0]!);
        const impostorChunk = { ...rows[1]!, writer: 'some-other-writer' };
        expect(assembler.ingestRow(impostorChunk)).toEqual({ status: 'rejected', reason: 'wrong_writer' });
    });

    it('rejects INVALID base64 in a chunk', () => {
        const encoded = encode();
        const assembler = new TranscriptRevisionAssembler(IDENTITY.producerWriterId);
        const rows = rowsOf(encoded);
        assembler.ingestRow(rows[0]!);
        const badChunk = { ...(rows[1]!.payload as TranscriptRevisionChunkV1), dataBase64: 'not base64!!! ###' };
        expect(assembler.ingestRow({ ...rows[1]!, payload: badChunk })).toEqual({
            status: 'rejected',
            reason: 'invalid_base64',
        });
    });

    it('rejects a chunk or commit with no preceding begin', () => {
        const encoded = encode();
        const assembler = new TranscriptRevisionAssembler(IDENTITY.producerWriterId);
        const rows = rowsOf(encoded);
        expect(assembler.ingestRow(rows[1]!)).toEqual({ status: 'rejected', reason: 'chunk_without_begin' });
        expect(assembler.ingestRow(rows[2]!)).toEqual({ status: 'rejected', reason: 'commit_without_begin' });
    });

    it('rejects an unsupported schema version', () => {
        const assembler = new TranscriptRevisionAssembler(IDENTITY.producerWriterId);
        const result = assembler.ingestRow({
            writer: IDENTITY.producerWriterId,
            seq: 1,
            kind: TRANSCRIPT_REVISION_BEGIN_KIND,
            payload: { v: 2 },
        });
        expect(result).toEqual({ status: 'rejected', reason: 'schema_version_unsupported' });
    });

    it('a new begin replaces a stale in-flight buffer without disturbing the last complete snapshot', () => {
        const first = encode(10);
        const assembler = new TranscriptRevisionAssembler(IDENTITY.producerWriterId);
        rowsOf(first).forEach((row) => assembler.ingestRow(row));
        const complete = assembler.getLatestComplete();

        // Producer starts revision 2 but crashes after begin — no chunks, no commit.
        const crashedBegin = encodeTranscriptRevision(
            encodeTranscriptSnapshot({ ...candidateWithContentBytes(10), revision: 2 }),
            { ...IDENTITY, revision: 2 },
            () => '2026-08-29T00:00:01.000Z',
        );
        if (!crashedBegin.ok) throw new Error('setup');
        assembler.ingestRow({
            writer: IDENTITY.producerWriterId,
            seq: 100,
            kind: TRANSCRIPT_REVISION_BEGIN_KIND,
            payload: crashedBegin.begin,
        });

        expect(assembler.getLatestComplete()).toEqual(complete);
    });
});
