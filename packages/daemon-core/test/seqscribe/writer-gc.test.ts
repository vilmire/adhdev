/**
 * writer-gc.ts — design 2026-09-28 §6.2 (v1 `.transcript` row removal) and
 * §4.8 (the `.chat` compaction safety net), on REAL nodes.
 *
 * "Previous process" topics are written by a node that is then closed, so the
 * sweeping node has never defined them — the exact shape of a daemon booting
 * onto a DB full of the removed v1 lane's rows.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TopicPolicy } from 'seqscribe';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ADHDEV_AUTHORITY_ID } from '../../src/seqscribe/authority-id.js';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import { ASSISTANT_JOURNAL_TOPIC, sessionChatPolicy, sessionChatTopic } from '../../src/seqscribe/topics.js';
import { CHAT_COMMIT_KEY } from '../../src/seqscribe/transcript-keyed-codec.js';
import { readPersistedChatTopic } from '../../src/seqscribe/transcript-keyed-publish-runtime.js';
import {
    __resetTranscriptWriterGcForTests,
    configureTranscriptWriterGc,
    isLegacyTranscriptTopic,
    runTranscriptWriterGcSweep,
    transcriptWriterGcCounters,
} from '../../src/seqscribe/writer-gc.js';
import { FrameDriver, SESSION, observation, ordOf } from './keyed-chat-fixtures.js';

const ENV = { ADHDEV_SEQSCRIBE_FLEET_SECRET: 'test-fleet-secret' };
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
    const dir = mkdtempSync(join(tmpdir(), `adhdev-writer-gc-${name}-`));
    tmpDirs.push(dir);
    return join(dir, 'seq.db');
}

function openAt(dbPath: string): SeqscribeNodeHandle {
    const handle = openSeqscribeNode({ dbPath, env: ENV, storedFleetSecret: null, meshIds: [] });
    handles.push(handle);
    return handle;
}

async function withPreviousProcess(dbPath: string, build: (h: SeqscribeNodeHandle) => Promise<void>): Promise<void> {
    const prev = openSeqscribeNode({ dbPath, env: ENV, storedFleetSecret: null, meshIds: [] });
    try {
        await build(prev);
    } finally {
        await prev.close();
    }
}

/** The retired v1 policy, as the old daemon defined it. */
function legacyPolicy(): TopicPolicy {
    return { kind: 'append', retention: { mode: 'full' }, replication: 'subscribe-only', access: 'content', finalityAuthority: ADHDEV_AUTHORITY_ID };
}

async function appendMany(handle: SeqscribeNodeHandle, topic: string, count: number): Promise<void> {
    const log = handle.node.log(topic);
    await Promise.all(Array.from({ length: count }, (_, i) => log.append('transcript.revision.chunk.v1', { i } as never)));
}

/** Append every frame of a driver (no runtime compaction) to a real chat topic. */
async function appendFrames(handle: SeqscribeNodeHandle, driver: FrameDriver): Promise<void> {
    const log = handle.node.log(sessionChatTopic(SESSION));
    for (const frame of driver.frames) {
        await Promise.all(frame.rows.map((row) => log.append(row.kind, row.payload, { key: row.key })));
    }
}

function streamingDriver(ticks: number, writer: string): FrameDriver {
    const driver = new FrameDriver(writer);
    const base = Array.from({ length: 5 }, (_, i) => ({ id: `d.gc.${i + 1}`, ord: ordOf(i), text: `b${i}` }));
    for (let t = 0; t < ticks; t += 1) {
        driver.step(observation([...base, { id: 'd.gc.stream', ord: ordOf(9), text: `stream ${'x'.repeat(t)}` }]));
    }
    return driver;
}

describe('writer-gc — v1 `.transcript` rows are removed (§6.2)', () => {
    it('recognizes exactly `session.<segment>.transcript`', () => {
        expect(isLegacyTranscriptTopic('session.abc_1.transcript')).toBe(true);
        expect(isLegacyTranscriptTopic('session.abc.chat')).toBe(false);
        expect(isLegacyTranscriptTopic('session.a.b.transcript')).toBe(false);
    });

    it('a previous process left v1 rows: the first sweep discovers the topic and deletes EVERY row, in bounded steps', async () => {
        const dbPath = freshDbPath('legacy');
        const legacy = 'session.old_sess.transcript';
        await withPreviousProcess(dbPath, async (prev) => {
            prev.node.defineTopic(legacy, legacyPolicy());
            await appendMany(prev, legacy, 1_200);
        });
        const handle = openAt(dbPath);
        const result = await runTranscriptWriterGcSweep(handle, { stepRows: 250 });
        expect(result.discovered).toContain(legacy);
        expect(result.legacyCleared).toEqual([legacy]);
        expect(handle.node.stats().topics[legacy]!.logRows).toBe(0);
        expect(transcriptWriterGcCounters()).toMatchObject({ legacyRowsPruned: 1_200, legacyTopicsCleared: 1 });
        // Not granted to anyone: a housekeeping define never enters `node.topics`.
        expect(handle.topics.some((d) => d.topic === legacy)).toBe(false);
    });

    it('a sweep stops at its row budget and reports the continuation', async () => {
        const dbPath = freshDbPath('legacy-budget');
        const legacy = 'session.big_sess.transcript';
        await withPreviousProcess(dbPath, async (prev) => {
            prev.node.defineTopic(legacy, legacyPolicy());
            await appendMany(prev, legacy, 600);
        });
        const handle = openAt(dbPath);
        const first = await runTranscriptWriterGcSweep(handle, { stepRows: 100, sweepRowBudget: 250 });
        expect(first.budgetExhausted).toBe(true);
        expect(handle.node.stats().topics[legacy]!.logRows).toBe(350);
        await runTranscriptWriterGcSweep(handle, { stepRows: 100 });
        expect(handle.node.stats().topics[legacy]!.logRows).toBe(0);
    });

    it('never touches other topics', async () => {
        const dbPath = freshDbPath('legacy-other');
        const handle = openAt(dbPath);
        await appendMany(handle, ASSISTANT_JOURNAL_TOPIC, 10);
        await runTranscriptWriterGcSweep(handle);
        expect(handle.node.stats().topics[ASSISTANT_JOURNAL_TOPIC]!.logRows).toBe(10);
    });
});

describe('writer-gc — `.chat` safety net (§4.8)', () => {
    it('compacts superseded rows of a chat topic whose producer is gone, keeping the committed state whole', async () => {
        const dbPath = freshDbPath('chat');
        const topic = sessionChatTopic(SESSION);
        let writer = '';
        await withPreviousProcess(dbPath, async (prev) => {
            writer = prev.writerId;
            prev.node.defineTopic(topic, sessionChatPolicy());
            await appendFrames(prev, streamingDriver(120, prev.writerId));
        });
        const handle = openAt(dbPath);
        const result = await runTranscriptWriterGcSweep(handle, { stepRows: 50 });
        expect(result.discovered).toContain(topic);
        const rows = handle.node.stats().topics[topic]!.logRows;
        // 6 heads + meta + commit are live; 120 frames wrote ~250 rows.
        expect(rows).toBe(8);
        expect(transcriptWriterGcCounters().rowsPruned).toBeGreaterThan(200);
        const persisted = readPersistedChatTopic(handle, topic);
        expect(persisted.committed.filter((r) => r.kind === 'chat.msg.v2')).toHaveLength(6);
        expect(persisted.committed.every((r) => r.writer === writer)).toBe(true);
        expect(persisted.torn).toEqual([]);
    });

    it('never compacts above the last commit — a frame in flight keeps the version it supersedes', async () => {
        const dbPath = freshDbPath('chat-inflight');
        const topic = sessionChatTopic(SESSION);
        const handle = openAt(dbPath);
        handle.node.defineTopic(topic, sessionChatPolicy());
        const driver = streamingDriver(10, handle.writerId);
        await appendFrames(handle, driver);
        // A torn frame: rows without their commit.
        const torn = driver.state.build(observation([{ id: 'd.gc.stream', ord: ordOf(9), text: 'torn' }]), {
            writerId: handle.writerId, producerDaemonId: 'd', observedAt: 't', nowMs: 0,
        });
        if (torn.status !== 'frame') throw new Error('expected a frame');
        const log = handle.node.log(topic);
        await Promise.all(torn.frame.rows.slice(0, -1).map((row) => log.append(row.kind, row.payload, { key: row.key })));
        const commitRowid = handle.node.keyHead(topic, CHAT_COMMIT_KEY)!.rowid;
        await runTranscriptWriterGcSweep(handle);
        const persisted = readPersistedChatTopic(handle, topic);
        // The committed stream head survives even though a newer (uncommitted) row supersedes it.
        const committedStream = persisted.committed.find((r) => r.key === 'm:d.gc.stream');
        expect(committedStream).toBeDefined();
        expect(persisted.torn.length).toBeGreaterThan(0);
        expect(handle.node.keyHead(topic, CHAT_COMMIT_KEY)!.rowid).toBe(commitRowid);
    });

    it('a dead chat topic (newest commit past the age cap, unwatched) is removed whole', async () => {
        const dbPath = freshDbPath('chat-dead');
        const topic = sessionChatTopic(SESSION);
        const handle = openAt(dbPath);
        handle.node.defineTopic(topic, sessionChatPolicy());
        await appendFrames(handle, streamingDriver(3, handle.writerId));
        const future = Date.now() + 8 * 24 * 60 * 60 * 1000;
        // Not dead yet under today's clock: only superseded rows go.
        await runTranscriptWriterGcSweep(handle);
        expect(handle.node.stats().topics[topic]!.logRows).toBe(8);
        await runTranscriptWriterGcSweep(handle, { now: () => future, maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
        expect(handle.node.stats().topics[topic]!.logRows).toBe(0);
        expect(transcriptWriterGcCounters()).toMatchObject({ deadTopicsRemoved: 1, errors: 0 });
    });

    it('arm/disarm: `once` runs nothing on a timer and `null` disarms', async () => {
        const handle = openAt(freshDbPath('arm'));
        const gc = configureTranscriptWriterGc(handle, { once: true });
        expect(gc).not.toBeNull();
        await gc!.runOnce();
        expect(transcriptWriterGcCounters().runs).toBe(1);
        configureTranscriptWriterGc(null);
        expect(await gc!.runOnce()).toEqual({ legacyCleared: [], discovered: [], budgetExhausted: false, vacuumedPages: 0 });
    });
});
