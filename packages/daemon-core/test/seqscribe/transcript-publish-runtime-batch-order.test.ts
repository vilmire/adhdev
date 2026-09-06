import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import { sessionTranscriptPolicy, sessionTranscriptTopic } from '../../src/seqscribe/topics.js';
import {
    encodeTranscriptSnapshot,
    type TranscriptSnapshotCandidate,
} from '../../src/seqscribe/transcript-projection.js';
import { createLiveTranscriptPublisher } from '../../src/seqscribe/transcript-publish-runtime.js';
import {
    TRANSCRIPT_REVISION_BEGIN_KIND,
    TRANSCRIPT_REVISION_CHUNK_KIND,
    TRANSCRIPT_REVISION_COMMIT_KIND,
    encodeTranscriptRevision,
    type TranscriptRevisionIdentity,
} from '../../src/seqscribe/transcript-revision-codec.js';
import { TranscriptTopicClaimRegistry } from '../../src/seqscribe/transcript-topic-claim.js';

/**
 * ★ Locks the ORDERING INVARIANT that lets `createLiveTranscriptPublisher`
 * issue begin/chunks/commit as one batch instead of awaiting each append.
 *
 * The invariant is a property of seqscribe's group commit, not of this file:
 * `append` enqueues synchronously (log.ts `push`), `flush` drains the queue
 * FIFO (log.ts, `for (const item of batch)`), and `processAppend` assigns
 * `seq = head.contigSeq + 1` as it walks that batch. So ISSUE order fixes seq
 * order, and awaiting between appends buys nothing but N+2 `GROUP_COMMIT_MS`
 * timer waits.
 *
 * These tests run against a REAL node deliberately. The fake node in
 * transcript-publish-runtime.test.ts resolves `append` immediately, so its
 * append-order assertion passes under either implementation and cannot detect
 * a regression here. Same lesson transcript-parity-actual-real-node.test.ts's
 * header records: a mock that stubs the storage layer cannot observe the
 * property that actually broke.
 */

const SESSION_ID = 'sess-batch-order-1';
const DAEMON_ID = 'daemon-batch-a';

const tmpDirs: string[] = [];
const handles: SeqscribeNodeHandle[] = [];

afterAll(async () => {
    for (const h of handles) await h.close().catch(() => {});
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function openNode(name: string): SeqscribeNodeHandle {
    const dir = mkdtempSync(join(tmpdir(), `adhdev-batch-order-${name}-`));
    tmpDirs.push(dir);
    const handle = openSeqscribeNode({
        dbPath: join(dir, 'seq.db'),
        // Content topic — needs a fleet secret. Supplied per-call via `env`,
        // never process.env: other workers share this machine.
        env: { ADHDEV_SEQSCRIBE_FLEET_SECRET: 'test-fleet-secret' },
        storedFleetSecret: null,
        meshIds: [],
    });
    handles.push(handle);
    handle.node.defineTopic(sessionTranscriptTopic(SESSION_ID), sessionTranscriptPolicy());
    return handle;
}

function candidate(content: string): TranscriptSnapshotCandidate {
    return {
        sessionId: SESSION_ID,
        providerType: 'claude-code',
        producerDaemonId: DAEMON_ID,
        producerWriterId: 'placeholder',
        producerEpoch: 'epoch-1',
        revision: 1,
        observedAt: '2026-09-06T00:00:00.000Z',
        status: 'generating',
        messages: [{ role: 'assistant', kind: 'standard', content }],
        coverage: { mode: 'tail', totalMessageCount: 1, returnedMessageCount: 1, omittedBefore: false },
    };
}

function envelopeFor(node: SeqscribeNodeHandle, content: string) {
    const identity: TranscriptRevisionIdentity = {
        sessionId: SESSION_ID,
        producerDaemonId: DAEMON_ID,
        producerWriterId: node.writerId,
        producerEpoch: 'epoch-1',
        revision: 1,
    };
    const encoded = encodeTranscriptRevision(encodeTranscriptSnapshot(candidate(content)), identity);
    if (!encoded.ok) throw new Error(`fixture encode failed: ${JSON.stringify(encoded)}`);
    return { begin: encoded.begin, chunks: encoded.chunks, commit: encoded.commit };
}

/**
 * Read every row this writer landed on the transcript topic, in seq order, as
 * `{seq, kind}` — the ground truth for both monotonicity and kind order.
 */
function landedRows(node: SeqscribeNodeHandle): { seq: number; kind: string }[] {
    const topic = sessionTranscriptTopic(SESSION_ID);
    const contig = node.node.vectors()[topic]?.writers?.[node.writerId]?.contig ?? 0;
    const scan = node.node.scanEntries(topic, {
        writer: node.writerId,
        fromSeq: 1,
        toSeq: contig,
    }) as { entries: { seq: number; kind: string; writer: string }[] };
    return scan.entries
        .filter((e) => e.writer === node.writerId)
        .map((e) => ({ seq: e.seq, kind: e.kind }))
        .sort((a, b) => a.seq - b.seq);
}

function expectMonotonicBeginChunksCommit(rows: { seq: number; kind: string }[], chunkCount: number): void {
    // 1. Every row landed: begin + N chunks + commit.
    expect(rows).toHaveLength(chunkCount + 2);

    // 2. seq is strictly monotonic increasing with NO gaps, starting at 1.
    //    This is the assertion that a partially-landed or reordered batch
    //    would break.
    expect(rows.map((r) => r.seq)).toEqual(
        Array.from({ length: chunkCount + 2 }, (_, i) => i + 1),
    );

    // 3. Reading in seq order yields begin → chunks → commit, in that order.
    expect(rows.map((r) => r.kind)).toEqual([
        TRANSCRIPT_REVISION_BEGIN_KIND,
        ...Array.from({ length: chunkCount }, () => TRANSCRIPT_REVISION_CHUNK_KIND),
        TRANSCRIPT_REVISION_COMMIT_KIND,
    ]);
}

describe('createLiveTranscriptPublisher — batched append preserves seq order (real node)', () => {
    it('lands begin/chunks/commit at strictly monotonic seqs in kind order', async () => {
        const node = openNode('small');
        const publish = createLiveTranscriptPublisher(node, new TranscriptTopicClaimRegistry(), DAEMON_ID);
        const env = envelopeFor(node, 'hello transcript');

        await publish(SESSION_ID, env);

        expectMonotonicBeginChunksCommit(landedRows(node), env.chunks.length);
    });

    /**
     * ★ The GROUP_COMMIT_N boundary. `push` force-flushes once the queue
     * reaches 64, so an envelope with more than 62 chunks (N+2 > 64) is split
     * across MULTIPLE commits. Order must survive the split: the second batch
     * continues from the first batch's `contigSeq`, so seqs stay gapless and
     * commit still lands last.
     *
     * Chunks are TRANSCRIPT_REVISION_CHUNK_BYTES (36 KiB) each, so >62 chunks
     * needs >2.2 MiB of JCS bytes.
     */
    it('preserves order and gaplessness when the batch exceeds GROUP_COMMIT_N (>62 chunks)', async () => {
        const node = openNode('boundary');
        const publish = createLiveTranscriptPublisher(node, new TranscriptTopicClaimRegistry(), DAEMON_ID);
        // 'x' repeated — JCS-encodes ~1 byte per char, so 3 MiB comfortably
        // clears the 62-chunk (2.2 MiB) boundary while staying under the
        // 238-chunk cap.
        const env = envelopeFor(node, 'x'.repeat(3 * 1024 * 1024));

        expect(env.chunks.length).toBeGreaterThan(62);

        await publish(SESSION_ID, env);

        expectMonotonicBeginChunksCommit(landedRows(node), env.chunks.length);
    });

    /**
     * Error semantics: `Promise.all` is first-rejection, and a seqscribe flush
     * rejects the WHOLE batch when its transaction aborts. So a failing publish
     * rejects — same as sequential awaits did — and the caller still sees an
     * Error, not an unhandled rejection from a sibling append.
     */
    it('rejects (does not swallow) when the underlying appends fail', async () => {
        const node = openNode('reject');
        const failing = {
            ...node,
            node: {
                ...node.node,
                defineTopic: node.node.defineTopic.bind(node.node),
                log: () => ({
                    append: () => Promise.reject(new Error('storage exploded')),
                }),
            } as unknown as SeqscribeNodeHandle['node'],
        };
        const publish = createLiveTranscriptPublisher(
            failing as SeqscribeNodeHandle,
            new TranscriptTopicClaimRegistry(),
            DAEMON_ID,
        );

        await expect(publish(SESSION_ID, envelopeFor(node, 'boom'))).rejects.toThrow(/storage exploded/);
    });
});
