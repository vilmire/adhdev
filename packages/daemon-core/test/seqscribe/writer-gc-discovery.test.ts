/**
 * writer-gc.ts — on-disk-only transcript discovery, bounded steps, and the
 * tail-window-derived row cap (2026-09-27 seqscribe.db growth fix).
 *
 * "Stale" topics here are written by a PREVIOUS node on the same DB file and
 * are therefore not defined in the node the sweep runs on — the exact shape
 * of the preview DB where every transcript topic holding the 318 MB belonged
 * to a session no running process had touched.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { Channel, Row } from 'seqscribe';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import {
    ASSISTANT_JOURNAL_TOPIC,
    meshEventsTopic,
    sessionTranscriptPolicy,
    sessionTranscriptTopic,
} from '../../src/seqscribe/topics.js';
import { ensureSessionTranscriptTopic } from '../../src/seqscribe/transcript-activation.js';
import { TranscriptTopicClaimRegistry } from '../../src/seqscribe/transcript-topic-claim.js';
import { encodeTranscriptSnapshot, type TranscriptSnapshotCandidate } from '../../src/seqscribe/transcript-projection.js';
import {
    MAX_TRANSCRIPT_REVISION_ROWS,
    TRANSCRIPT_REVISION_BEGIN_KIND,
    TRANSCRIPT_REVISION_CHUNK_KIND,
    TRANSCRIPT_REVISION_COMMIT_KIND,
    TranscriptRevisionAssembler,
    encodeTranscriptRevision,
    type TranscriptRevisionIdentity,
} from '../../src/seqscribe/transcript-revision-codec.js';
import {
    __resetTranscriptWriterGcForTests,
    configureTranscriptWriterGc,
    runTranscriptWriterGcSweep,
    transcriptWriterGcCounters,
    TRANSCRIPT_PRUNE_MARGIN_ROWS,
    TRANSCRIPT_PRUNE_MAX_ENTRIES,
    TRANSCRIPT_TAIL_WINDOW_ROWS,
} from '../../src/seqscribe/writer-gc.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR_SUBS_SRC = resolve(HERE, '../../../../vendor/seqscribe/src/subs.ts');
const ENV = { ADHDEV_SEQSCRIBE_FLEET_SECRET: 'test-fleet-secret' };
const MESH_ID = 'mesh_0123456789abcdef0123456789abcdef';

const tmpDirs: string[] = [];
const handles: SeqscribeNodeHandle[] = [];

afterAll(async () => {
    for (const h of handles) await h.close().catch(() => {});
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

afterEach(() => {
    __resetTranscriptWriterGcForTests();
    configureTranscriptWriterGc(null);
});

function freshDbPath(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), `adhdev-writer-gc-disc-${name}-`));
    tmpDirs.push(dir);
    return join(dir, 'seq.db');
}

function openAt(dbPath: string, meshIds: string[] = []): SeqscribeNodeHandle {
    const handle = openSeqscribeNode({ dbPath, env: ENV, storedFleetSecret: null, meshIds });
    handles.push(handle);
    return handle;
}

async function appendMany(handle: SeqscribeNodeHandle, topic: string, count: number, payload: (i: number) => unknown = (i) => ({ i })): Promise<void> {
    const log = handle.node.log(topic);
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < count; i++) pending.push(log.append('adhdev.test.entry', payload(i) as never));
    await Promise.all(pending);
}

/** Write rows through a node that is then closed — the topics are "stale" for the next opener. */
async function withPreviousProcess(dbPath: string, build: (h: SeqscribeNodeHandle) => Promise<void>, meshIds: string[] = []): Promise<void> {
    const prev = openSeqscribeNode({ dbPath, env: ENV, storedFleetSecret: null, meshIds });
    try {
        await build(prev);
    } finally {
        await prev.close();
    }
}

function identity(sessionId: string, writerId: string, revision: number): TranscriptRevisionIdentity {
    return { sessionId, producerDaemonId: 'daemon_mach_owner', producerWriterId: writerId, producerEpoch: 'epoch-1', revision };
}

function candidate(id: TranscriptRevisionIdentity): TranscriptSnapshotCandidate {
    return {
        sessionId: id.sessionId,
        providerType: 'claude-code',
        producerDaemonId: id.producerDaemonId,
        producerWriterId: id.producerWriterId,
        producerEpoch: id.producerEpoch,
        revision: id.revision,
        observedAt: '2026-09-27T00:00:00.000Z',
        status: 'generating',
        messages: [{ role: 'assistant', kind: 'standard', content: `revision ${id.revision}` }],
        coverage: { mode: 'tail', totalMessageCount: 1, returnedMessageCount: 1, omittedBefore: false },
    };
}

/** Publish `count` one-chunk revisions (3 rows each) on `topic`, the way transcript-publisher does. */
async function publishRevisions(handle: SeqscribeNodeHandle, sessionId: string, topic: string, count: number): Promise<void> {
    const log = handle.node.log(topic);
    for (let revision = 1; revision <= count; revision++) {
        const id = identity(sessionId, handle.writerId, revision);
        const encoded = encodeTranscriptRevision(encodeTranscriptSnapshot(candidate(id)), id);
        if (!encoded.ok) throw new Error('fixture encode failed');
        const pending: Promise<unknown>[] = [log.append(TRANSCRIPT_REVISION_BEGIN_KIND, encoded.begin as never)];
        for (const chunk of encoded.chunks) pending.push(log.append(TRANSCRIPT_REVISION_CHUNK_KIND, chunk as never));
        pending.push(log.append(TRANSCRIPT_REVISION_COMMIT_KIND, encoded.commit as never));
        await Promise.all(pending);
    }
}

function channelPair(): [Channel, Channel] {
    const aMsg = { cb: null as ((m: string) => void) | null };
    const bMsg = { cb: null as ((m: string) => void) | null };
    const aClose = { cb: null as (() => void) | null };
    const bClose = { cb: null as (() => void) | null };
    const mk = (
        mine: { cb: ((m: string) => void) | null },
        peerIn: { cb: ((m: string) => void) | null },
        mineClose: { cb: (() => void) | null },
        peerClose: { cb: (() => void) | null },
    ): Channel => ({
        send(msg: string) { setTimeout(() => peerIn.cb?.(msg), 0); },
        onMessage(cb) { mine.cb = cb; },
        onClose(cb) { mineClose.cb = cb; },
        close() { peerClose.cb?.(); },
    });
    return [mk(aMsg, bMsg, aClose, bClose), mk(bMsg, aMsg, bClose, aClose)];
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (cond()) return;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${label}`);
}

describe('writer-gc row cap is derived from the tail window', () => {
    it('keeps the tail window plus margin, and room for one complete + one in-flight revision', () => {
        expect(TRANSCRIPT_PRUNE_MAX_ENTRIES).toBe(600);
        expect(TRANSCRIPT_PRUNE_MAX_ENTRIES).toBeGreaterThanOrEqual(TRANSCRIPT_TAIL_WINDOW_ROWS + TRANSCRIPT_PRUNE_MARGIN_ROWS);
        expect(TRANSCRIPT_PRUNE_MAX_ENTRIES).toBeGreaterThanOrEqual(2 * MAX_TRANSCRIPT_REVISION_ROWS);
    });

    it('TRANSCRIPT_TAIL_WINDOW_ROWS matches the vendor tail view (FULL_TAIL_DEFAULT in subs.ts)', () => {
        const src = readFileSync(VENDOR_SUBS_SRC, 'utf8');
        const match = /const FULL_TAIL_DEFAULT = (\d[\d_]*);/.exec(src);
        expect(match, 'FULL_TAIL_DEFAULT not found in vendor subs.ts').not.toBeNull();
        expect(Number(match![1]!.replace(/_/g, ''))).toBe(TRANSCRIPT_TAIL_WINDOW_ROWS);
    });
});

describe('writer-gc discovers transcript topics that exist only on disk', () => {
    it('★ a stale (undefined-in-this-process) transcript topic is pruned to the default bound', async () => {
        const dbPath = freshDbPath('stale');
        const staleTopic = sessionTranscriptTopic('stale-session-1');
        const smallTopic = sessionTranscriptTopic('stale-session-small');
        await withPreviousProcess(dbPath, async (prev) => {
            prev.node.defineTopic(staleTopic, sessionTranscriptPolicy());
            prev.node.defineTopic(smallTopic, sessionTranscriptPolicy());
            await appendMany(prev, staleTopic, TRANSCRIPT_PRUNE_MAX_ENTRIES + 150);
            await appendMany(prev, smallTopic, 5);
        });

        const handle = openAt(dbPath);
        expect(handle.node.stats().topics[staleTopic]).toBeUndefined();

        const result = await runTranscriptWriterGcSweep(handle);

        // Only the topic with prunable rows is defined; the small one is left alone.
        expect(result.discovered).toEqual([staleTopic]);
        expect(handle.node.stats().topics[staleTopic]?.logRows).toBe(TRANSCRIPT_PRUNE_MAX_ENTRIES);
        expect(handle.node.stats().topics[smallTopic]).toBeUndefined();
        const counters = transcriptWriterGcCounters();
        expect(counters.topicsDiscovered).toBe(1);
        expect(counters.rowsPruned).toBe(150);
        // Housekeeping define: not pushed to handle.topics, so no transport grants it.
        expect(handle.topics.some((d) => d.topic === staleTopic)).toBe(false);
    });

    it('★ the latest complete revision is still served by the tail SUB after the prune', async () => {
        const dbPath = freshDbPath('revision');
        const sessionId = 'stale-session-rev';
        const topic = sessionTranscriptTopic(sessionId);
        // 240 one-chunk revisions = 720 rows, over the 600 cap.
        const REVISIONS = 240;
        let producerWriterId = '';
        await withPreviousProcess(dbPath, async (prev) => {
            producerWriterId = prev.writerId;
            prev.node.defineTopic(topic, sessionTranscriptPolicy());
            await publishRevisions(prev, sessionId, topic, REVISIONS);
        });

        const server = openAt(dbPath);
        const result = await runTranscriptWriterGcSweep(server);
        expect(result.discovered).toEqual([topic]);
        expect(server.node.stats().topics[topic]?.logRows).toBe(TRANSCRIPT_PRUNE_MAX_ENTRIES);

        // A real subscriber reads the pruned topic through the vendor tail view.
        const client = openAt(freshDbPath('revision-client'));
        client.node.defineTopic(topic, sessionTranscriptPolicy());
        const [chS, chC] = channelPair();
        const peerS = server.node.attach(chS, { peerId: 'client', peerClass: 'content', grants: { [topic]: 'serve' } });
        const peerC = client.node.attach(chC, { peerId: 'server', peerClass: 'content', grants: { [topic]: 'none' } });
        await waitFor(() => peerS.state() === 'ready' && peerC.state() === 'ready', 'handshake');

        let snapshotRows: Row[] | null = null;
        const sub = client.node.subscribe(peerC, { view: 'tail', params: { topic } });
        const unsub = sub.onSnapshot((rows) => { snapshotRows = rows; });
        await waitFor(() => snapshotRows !== null, 'tail snapshot');
        unsub();

        const assembler = new TranscriptRevisionAssembler(producerWriterId);
        for (const row of snapshotRows!) {
            assembler.ingestRow({
                writer: String(row.writer),
                seq: Number(row.seq),
                kind: String(row.kind),
                payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
            });
        }
        const latest = assembler.getLatestComplete();
        // The daemon's transcript tail selector (transcript-tail-snapshot.ts)
        // trims the SNAP to the newest complete revision — begin + 1 chunk +
        // commit here — instead of the TRANSCRIPT_TAIL_WINDOW_ROWS window; the
        // prune must still leave that revision intact and reachable.
        expect(snapshotRows!.length).toBe(3);
        expect(latest?.identity.revision).toBe(REVISIONS);
    });

    it('full-sync / non-transcript topics on disk are never defined or pruned by discovery', async () => {
        const dbPath = freshDbPath('fullsync');
        const meshTopic = meshEventsTopic(MESH_ID);
        await withPreviousProcess(
            dbPath,
            async (prev) => {
                await appendMany(prev, meshTopic, 40);
                await appendMany(prev, ASSISTANT_JOURNAL_TOPIC, 40);
            },
            [MESH_ID],
        );

        const handle = openAt(dbPath); // meshIds [] — the mesh topic is on disk only
        const result = await runTranscriptWriterGcSweep(handle, { maxEntries: 1, maxAgeMs: 0 });

        expect(result.discovered).toEqual([]);
        expect(handle.node.stats().topics[meshTopic]).toBeUndefined();
        expect(handle.node.stats().topics[ASSISTANT_JOURNAL_TOPIC]?.logRows).toBe(40);
        expect(transcriptWriterGcCounters().rowsPruned).toBe(0);
        await handle.close();
        const reopened = openAt(dbPath, [MESH_ID]);
        expect(reopened.node.stats().topics[meshTopic]?.logRows).toBe(40);
    });

    it('discovery is capped per sweep; the next sweep picks up the rest', async () => {
        const dbPath = freshDbPath('cap');
        const topics = ['cap-a', 'cap-b', 'cap-c'].map(sessionTranscriptTopic);
        await withPreviousProcess(dbPath, async (prev) => {
            for (const t of topics) {
                prev.node.defineTopic(t, sessionTranscriptPolicy());
                await appendMany(prev, t, 12);
            }
        });
        const handle = openAt(dbPath);
        const first = await runTranscriptWriterGcSweep(handle, { maxEntries: 10, maxDiscoveredTopics: 1 });
        expect(first.discovered).toHaveLength(1);
        const second = await runTranscriptWriterGcSweep(handle, { maxEntries: 10, maxDiscoveredTopics: 1 });
        expect(second.discovered).toHaveLength(1);
        expect(second.discovered[0]).not.toBe(first.discovered[0]);
    });

    it('a housekeeping-defined topic still activates normally later (push + claim)', async () => {
        const dbPath = freshDbPath('activate');
        const sessionId = 'revived-session';
        const topic = sessionTranscriptTopic(sessionId);
        await withPreviousProcess(dbPath, async (prev) => {
            prev.node.defineTopic(topic, sessionTranscriptPolicy());
            await appendMany(prev, topic, 12);
        });
        const handle = openAt(dbPath);
        const result = await runTranscriptWriterGcSweep(handle, { maxEntries: 10 });
        expect(result.discovered).toEqual([topic]);
        expect(handle.topics.some((d) => d.topic === topic)).toBe(false);

        const activation = ensureSessionTranscriptTopic(handle, new TranscriptTopicClaimRegistry(), sessionId, 'daemon_mach_owner');
        expect(activation).toEqual({ ok: true, topic });
        expect(handle.topics.filter((d) => d.topic === topic)).toHaveLength(1);
    });
});

describe('writer-gc bounded work per sweep', () => {
    it('★ no pruneTopic call deletes more than stepRows, and the row budget defers the rest', async () => {
        const dbPath = freshDbPath('budget');
        const topic = sessionTranscriptTopic('budget-session');
        await withPreviousProcess(dbPath, async (prev) => {
            prev.node.defineTopic(topic, sessionTranscriptPolicy());
            await appendMany(prev, topic, 100);
        });
        const handle = openAt(dbPath);
        const perCall: number[] = [];
        const realPrune = handle.node.pruneTopic.bind(handle.node);
        const spied = {
            ...handle,
            node: {
                ...handle.node,
                pruneTopic: async (t: string, b: { olderThanMs?: number; keepNewest?: number }) => {
                    const r = await realPrune(t, b);
                    perCall.push(r.prunedRows);
                    return r;
                },
            },
        } as SeqscribeNodeHandle;

        const first = await runTranscriptWriterGcSweep(spied, { maxEntries: 10, stepRows: 7, sweepRowBudget: 30 });
        expect(first.budgetExhausted).toBe(true);
        expect(Math.max(...perCall)).toBeLessThanOrEqual(7);
        expect(handle.node.stats().topics[topic]?.logRows).toBe(70);
        expect(transcriptWriterGcCounters().budgetExhausted).toBe(1);

        const second = await runTranscriptWriterGcSweep(spied, { maxEntries: 10, stepRows: 7, sweepRowBudget: 1_000 });
        expect(second.budgetExhausted).toBe(false);
        expect(Math.max(...perCall)).toBeLessThanOrEqual(7);
        expect(handle.node.stats().topics[topic]?.logRows).toBe(10);
    });

    it('the age bound is stepped too (old rows removed in ≤ stepRows slices, young rows kept)', async () => {
        const dbPath = freshDbPath('age');
        const topic = sessionTranscriptTopic('age-session');
        await withPreviousProcess(dbPath, async (prev) => {
            prev.node.defineTopic(topic, sessionTranscriptPolicy());
            await appendMany(prev, topic, 25);
        });
        await new Promise((r) => setTimeout(r, 30));
        const handle = openAt(dbPath);
        const cutoffBase = Date.now();
        const result = await runTranscriptWriterGcSweep(handle, { maxEntries: 1_000, maxAgeMs: 10, stepRows: 4, now: () => cutoffBase });
        expect(result.discovered).toEqual([topic]);
        expect(handle.node.stats().topics[topic]?.logRows).toBe(0);
        expect(transcriptWriterGcCounters().rowsPruned).toBe(25);
    });

    it('disarming stops an in-flight sweep at its next step', async () => {
        const dbPath = freshDbPath('disarm');
        const topic = sessionTranscriptTopic('disarm-session');
        await withPreviousProcess(dbPath, async (prev) => {
            prev.node.defineTopic(topic, sessionTranscriptPolicy());
            await appendMany(prev, topic, 60);
        });
        const handle = openAt(dbPath);
        let calls = 0;
        const result = await runTranscriptWriterGcSweep(handle, {
            maxEntries: 10,
            stepRows: 5,
            shouldContinue: () => ++calls < 4,
        });
        expect(result.budgetExhausted).toBe(false);
        expect(handle.node.stats().topics[topic]!.logRows).toBeGreaterThan(10);
    });
});
