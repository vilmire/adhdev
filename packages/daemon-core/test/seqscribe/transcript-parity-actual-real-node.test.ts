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
 * whose `headOrder` returns `{seq: 3}` unconditionally. That mock originally
 * encoded an assumption the real library did NOT satisfy back when `session.*.
 * transcript` was `ring(500)`: ring entries were never written to `sq_log`,
 * and `headOrder` is a `sq_log` query, so on a real node it returned `null`
 * every time and the reader answered `{status:'missing'}` on every single
 * call. The mock was green throughout; live parity was structurally 100%
 * mismatch.
 *
 * G2b (landed 2026-09-24) switched the real topic to `full` retention, which
 * DOES write durable `sq_log` rows — see "headOrder is non-null" below,
 * which now pins the OPPOSITE fact from before. `transcript-parity-actual.ts`
 * still does not pin to `headOrder` (a second, retention-independent reason
 * — see that file's comment), so this suite's real job is unchanged: prove
 * the reader works against what the library ACTUALLY does for this topic,
 * not a mock's assumption about it. Anything that stubs `headOrder`/
 * `scanEntries` cannot observe the real SQLite-backed behavior this file
 * exists to catch drift in.
 */

const SESSION_ID = 'sess-real-1';
const RING_TOPIC = sessionTranscriptTopic(SESSION_ID); // name kept for diff minimality; topic is now full-retention (G2b)

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

    it('★ G2b: headOrder is now NON-NULL (full retention persists sq_log rows) — and the reader still works', async () => {
        const handle = openNode('headorder-nonnull');
        await publishRevision(handle, 1, 'full retention persists durable rows now');

        // This is the OPPOSITE of the pre-G2b fact this test used to pin (see
        // the file header): under `ring` retention this was unconditionally
        // `null`; under `full` retention (current policy) a real durable row
        // exists and `headOrder` finds it. `transcript-parity-actual.ts`
        // still does not pin its scan to this value — for the OTHER,
        // retention-independent reason documented there (a topic-wide head
        // is not necessarily this writer's own seq) — so this assertion only
        // documents the retention-mode fact, it does not imply the reader
        // should start using it.
        expect(handle.node.headOrder(RING_TOPIC)).not.toBeNull();

        // The writer-form scan (which merges `core.ringTail()` — a no-op for
        // a non-ring topic — alongside the durable sources) still sees them.
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

    it('★ unanchored-scan window: a stale default window cannot corrupt the newest intact revision', async () => {
        const handle = openNode('overflow');

        // Each revision here is 3 rows (begin + 1 chunk + commit). Under the
        // PRE-G2b `ring(500)` policy, publishing well past
        // SESSION_TRANSCRIPT_RING physically evicted the oldest rows from the
        // ring. Under the CURRENT `full` retention policy nothing is evicted
        // (writer-gc.ts's prune sweep is not running in this test) — every
        // row published below still exists durably. What this test actually
        // exercises is retention-mode-independent: `scanEntries`'s WRITER
        // FORM bounds its page as a fixed-width SEQ WINDOW
        // (`[fromSeq, fromSeq+limit-1]`), not "the last `limit` rows" — so an
        // UNANCHORED call (default `fromSeq: 1`) still returns only seqs
        // 1..500 regardless of how many more rows exist beyond that window,
        // durable or not. `readLocalTranscriptParityActual` anchors `fromSeq`
        // to the writer's head specifically so it does NOT hit this stale
        // window — see the long note at its `scanEntries` call.
        const revisions = Math.ceil(SESSION_TRANSCRIPT_RING / 3) + 20;
        for (let r = 1; r <= revisions; r++) await publishRevision(handle, r, `rev-${r}`);

        // ★ The unanchored form — `scanEntries({writer})` with its default
        // `fromSeq: 1` — reads the seq window 1..500, missing every row
        // published beyond it. Pinned here so nobody "simplifies" the
        // anchored call in the implementation back to this.
        const unanchored = handle.node.scanEntries(RING_TOPIC, { writer: handle.writerId }).entries;
        const newestSeqUnanchored = unanchored[unanchored.length - 1]?.seq ?? 0;
        expect(newestSeqUnanchored).toBe(SESSION_TRANSCRIPT_RING); // capped at 500 by the default window, not the true head
        expect(newestSeqUnanchored).toBeLessThan(revisions * 3); // ...which is behind the real head

        const result = readLocalTranscriptParityActual(handle, SESSION_ID, handle.writerId);
        expect(result.status).toBe('found');
        if (result.status === 'found') {
            expect(result.snapshot.revision).toBe(revisions);
            expect(result.snapshot.messages[0]?.content).toBe(`rev-${revisions}`);
        }
    });
});
