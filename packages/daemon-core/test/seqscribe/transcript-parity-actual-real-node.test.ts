import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import { readLocalTranscriptParityActual } from '../../src/seqscribe/transcript-parity-actual.js';
import {
    encodeTranscriptSnapshot,
    type TranscriptSnapshotCandidate,
} from '../../src/seqscribe/transcript-projection.js';
import {
    TRANSCRIPT_REVISION_BEGIN_KIND,
    TRANSCRIPT_REVISION_CHUNK_KIND,
    TRANSCRIPT_REVISION_COMMIT_KIND,
    encodeTranscriptRevision,
    type TranscriptRevisionIdentity,
} from '../../src/seqscribe/transcript-revision-codec.js';
import {
    SESSION_TRANSCRIPT_RING,
    sessionTranscriptPolicy,
    sessionTranscriptTopic,
} from '../../src/seqscribe/topics.js';

/**
 * ★ The regression this file exists for — a REAL seqscribe node, not a mock.
 *
 * `transcript-parity-actual.test.ts` covers the same module against a fake node
 * whose `headOrder` returns `{seq: 3}` unconditionally. That mock encoded an
 * assumption the real library never satisfies for THIS topic: `session.*.
 * transcript` is `ring(500)`, ring entries are never written to `sq_log`, and
 * `headOrder` is a `sq_log` query — so on a real node it returns `null` every
 * time and the reader answered `{status:'missing'}` on every single call. The
 * mock was green throughout; live parity was structurally 100% mismatch.
 *
 * So the rule these tests encode: the parity `actual` reader must be exercised
 * against a node that ACTUALLY applies ring retention. Anything that stubs
 * `headOrder`/`scanEntries` cannot observe the SQLite-vs-in-memory split that
 * caused the defect.
 */

const SESSION_ID = 'sess-real-1';
const RING_TOPIC = sessionTranscriptTopic(SESSION_ID);

const tmpDirs: string[] = [];
const handles: SeqscribeNodeHandle[] = [];

afterAll(async () => {
    for (const h of handles) await h.close().catch(() => {});
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function openNode(name: string): SeqscribeNodeHandle {
    const dir = mkdtempSync(join(tmpdir(), `adhdev-parity-real-${name}-`));
    tmpDirs.push(dir);
    const handle = openSeqscribeNode({
        dbPath: join(dir, 'seq.db'),
        // The transcript topic is a CONTENT topic (it names `finalityAuthority`),
        // so a node with no fleet secret refuses to define it at all. Supplied
        // per-call through `env` — never via process.env, since other workers
        // share this machine.
        env: { ADHDEV_SEQSCRIBE_FLEET_SECRET: 'test-fleet-secret' },
        storedFleetSecret: null,
        meshIds: [],
    });
    handles.push(handle);
    handle.node.defineTopic(RING_TOPIC, sessionTranscriptPolicy());
    return handle;
}

/**
 * A node opened without a cloud identity reports `daemonId: null`, while the
 * revision envelope requires a string (the live publisher always has one by the
 * time it publishes). Pin a literal so these tests exercise the READ path
 * rather than an unrelated identity gap.
 */
const PRODUCER_DAEMON_ID = 'daemon_mach_real_node_test';

function identityFor(handle: SeqscribeNodeHandle, revision: number): TranscriptRevisionIdentity {
    return {
        sessionId: SESSION_ID,
        producerDaemonId: PRODUCER_DAEMON_ID,
        producerWriterId: handle.writerId,
        producerEpoch: 'epoch-real-1',
        revision,
    };
}

function candidate(identity: TranscriptRevisionIdentity, text: string): TranscriptSnapshotCandidate {
    return {
        sessionId: identity.sessionId,
        providerType: 'claude-code',
        producerDaemonId: identity.producerDaemonId,
        producerWriterId: identity.producerWriterId,
        producerEpoch: identity.producerEpoch,
        revision: identity.revision,
        observedAt: '2026-09-03T00:00:00.000Z',
        status: 'generating',
        messages: [{ role: 'assistant', kind: 'standard', content: text }],
        coverage: { mode: 'tail', totalMessageCount: 1, returnedMessageCount: 1, omittedBefore: false },
    };
}

/** Append one complete begin/chunks/commit revision through the real node. */
async function publishRevision(
    handle: SeqscribeNodeHandle,
    revision: number,
    text: string,
): Promise<void> {
    const identity = identityFor(handle, revision);
    const encoded = encodeTranscriptRevision(encodeTranscriptSnapshot(candidate(identity, text)), identity);
    if (!encoded.ok) throw new Error('fixture encode failed');
    const log = handle.node.log(RING_TOPIC);
    await log.append(TRANSCRIPT_REVISION_BEGIN_KIND, encoded.begin as never);
    for (const chunk of encoded.chunks) await log.append(TRANSCRIPT_REVISION_CHUNK_KIND, chunk as never);
    await log.append(TRANSCRIPT_REVISION_COMMIT_KIND, encoded.commit as never);
}

describe('readLocalTranscriptParityActual against a real ring-retention node', () => {
    it('★ finds a revision the producer just wrote to the ring (was: always missing)', async () => {
        const handle = openNode('found');
        await publishRevision(handle, 1, 'hello from the ring');

        const result = readLocalTranscriptParityActual(handle, SESSION_ID, handle.writerId);

        expect(result.status).toBe('found');
        if (result.status === 'found') {
            expect(result.snapshot.sessionId).toBe(SESSION_ID);
            expect(result.snapshot.revision).toBe(1);
            expect(result.snapshot.messages[0]?.content).toBe('hello from the ring');
        }
    });

    it('pins the defect precisely: headOrder is null on a ring topic while the entries ARE readable', async () => {
        const handle = openNode('headorder-null');
        await publishRevision(handle, 1, 'ring entries are in-memory only');

        // This is the exact expression the old implementation gated on. If this
        // ever stops being null — e.g. seqscribe starts persisting ring rows —
        // the reasoning in transcript-parity-actual.ts should be revisited.
        expect(handle.node.headOrder(RING_TOPIC)).toBeNull();

        // ...yet the writer-form scan, which merges `core.ringTail()`, sees them.
        const scanned = handle.node.scanEntries(RING_TOPIC, { writer: handle.writerId });
        expect(scanned.entries.length).toBeGreaterThan(0);
        expect(readLocalTranscriptParityActual(handle, SESSION_ID, handle.writerId).status).toBe('found');
    });

    it('returns the LATEST revision when several have been published', async () => {
        const handle = openNode('latest');
        await publishRevision(handle, 1, 'first');
        await publishRevision(handle, 2, 'second');
        await publishRevision(handle, 3, 'third');

        const result = readLocalTranscriptParityActual(handle, SESSION_ID, handle.writerId);
        expect(result.status).toBe('found');
        if (result.status === 'found') {
            expect(result.snapshot.revision).toBe(3);
            expect(result.snapshot.messages[0]?.content).toBe('third');
        }
    });

    it('missing when the topic exists but nothing has been published yet', () => {
        const handle = openNode('empty');
        expect(readLocalTranscriptParityActual(handle, SESSION_ID, handle.writerId)).toEqual({
            status: 'missing',
        });
    });

    it('missing for a writer that never wrote (the writer gate really is applied)', async () => {
        const handle = openNode('other-writer');
        await publishRevision(handle, 1, 'written by the real writer');
        expect(
            readLocalTranscriptParityActual(handle, SESSION_ID, 'adhdev-writer-someone-else'),
        ).toEqual({ status: 'missing' });
    });

    it('missing when the ring holds a begin with no commit (producer crashed mid-revision)', async () => {
        const handle = openNode('no-commit');
        const identity = identityFor(handle, 1);
        const encoded = encodeTranscriptRevision(
            encodeTranscriptSnapshot(candidate(identity, 'never committed')),
            identity,
        );
        if (!encoded.ok) throw new Error('fixture encode failed');
        const log = handle.node.log(RING_TOPIC);
        await log.append(TRANSCRIPT_REVISION_BEGIN_KIND, encoded.begin as never);
        for (const chunk of encoded.chunks) await log.append(TRANSCRIPT_REVISION_CHUNK_KIND, chunk as never);
        // deliberately no commit

        expect(readLocalTranscriptParityActual(handle, SESSION_ID, handle.writerId)).toEqual({
            status: 'missing',
        });
    });

    it('★ ring overflow: an evicted older revision cannot corrupt the newest intact one', async () => {
        const handle = openNode('overflow');

        // Each revision here is 3 rows (begin + 1 chunk + commit), so publishing
        // well past SESSION_TRANSCRIPT_RING forces the oldest rows — including
        // whole `begin` rows — out of the ring. A chunk or commit whose `begin`
        // was evicted is rejected by the assembler (`chunk_without_begin` /
        // `commit_without_begin`) without disturbing in-flight state, so the
        // newest fully-resident revision still assembles. This is the arithmetic
        // MAX_TRANSCRIPT_REVISION_ROWS (240) vs. ring 500 is sized for.
        const revisions = Math.ceil(SESSION_TRANSCRIPT_RING / 3) + 20;
        for (let r = 1; r <= revisions; r++) await publishRevision(handle, r, `rev-${r}`);

        // ★ The unanchored form — `scanEntries({writer})` with its default
        // `fromSeq: 1` — reads the seq window 1..500 while the ring now holds
        // the newest 500 seqs. It therefore returns the OLDEST survivors and
        // misses the newest revision entirely. Pinned here so nobody
        // "simplifies" the anchored call in the implementation back to this.
        const unanchored = handle.node.scanEntries(RING_TOPIC, { writer: handle.writerId }).entries;
        const newestSeqUnanchored = unanchored[unanchored.length - 1]?.seq ?? 0;
        expect(newestSeqUnanchored).toBe(SESSION_TRANSCRIPT_RING); // capped at 500, not the true head
        expect(newestSeqUnanchored).toBeLessThan(revisions * 3); // ...which is behind the real head

        const result = readLocalTranscriptParityActual(handle, SESSION_ID, handle.writerId);
        expect(result.status).toBe('found');
        if (result.status === 'found') {
            expect(result.snapshot.revision).toBe(revisions);
            expect(result.snapshot.messages[0]?.content).toBe(`rev-${revisions}`);
        }
    });
});
