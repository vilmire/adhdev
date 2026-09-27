/**
 * db-maintenance.ts — bounded incremental vacuum on the live connection and
 * the one-time shutdown compaction (auto_vacuum NONE → INCREMENTAL + VACUUM).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
    compactSeqscribeDbAtShutdown,
    seqscribeFreelistOverThreshold,
} from '../../src/seqscribe/db-maintenance.js';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import { meshEventsTopic, sessionTranscriptPolicy, sessionTranscriptTopic } from '../../src/seqscribe/topics.js';
import {
    __resetTranscriptWriterGcForTests,
    runTranscriptWriterGcSweep,
    transcriptWriterGcCounters,
} from '../../src/seqscribe/writer-gc.js';
import { loadBetterSqlite3 } from '../../src/system/load-better-sqlite3.js';

const ENV = { ADHDEV_SEQSCRIBE_FLEET_SECRET: 'test-fleet-secret' };
const MESH_ID = 'mesh_fedcba9876543210fedcba9876543210';
const BIG = 'x'.repeat(16 * 1024);

const tmpDirs: string[] = [];
const handles: SeqscribeNodeHandle[] = [];

afterAll(async () => {
    for (const h of handles) await h.close().catch(() => {});
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

afterEach(() => {
    __resetTranscriptWriterGcForTests();
});

function freshDbPath(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), `adhdev-seq-maint-${name}-`));
    tmpDirs.push(dir);
    return join(dir, 'seq.db');
}

/** Pre-create the file in auto_vacuum=NONE — the shape of every DB created before 2026-09-27. */
function precreateLegacyDb(dbPath: string): void {
    const Database = loadBetterSqlite3();
    const db = new Database(dbPath);
    db.pragma('auto_vacuum = NONE');
    db.exec('CREATE TABLE legacy_marker (x INTEGER)');
    db.close();
}

function open(dbPath: string, meshIds: string[] = []): SeqscribeNodeHandle {
    const handle = openSeqscribeNode({ dbPath, env: ENV, storedFleetSecret: null, meshIds });
    handles.push(handle);
    return handle;
}

async function appendBig(handle: SeqscribeNodeHandle, topic: string, count: number): Promise<void> {
    const log = handle.node.log(topic);
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < count; i++) pending.push(log.append('adhdev.test.entry', { i, pad: BIG }));
    await Promise.all(pending);
}

function readPragmas(dbPath: string): { autoVacuum: number; freelist: number; pageCount: number } {
    const Database = loadBetterSqlite3();
    const db = new Database(dbPath, { readonly: true });
    try {
        return {
            autoVacuum: Number(db.pragma('auto_vacuum', { simple: true })),
            freelist: Number(db.pragma('freelist_count', { simple: true })),
            pageCount: Number(db.pragma('page_count', { simple: true })),
        };
    } finally {
        db.close();
    }
}

function logRows(dbPath: string, topic: string): number {
    const Database = loadBetterSqlite3();
    const db = new Database(dbPath, { readonly: true });
    try {
        return Number((db.prepare('SELECT count(*) AS n FROM sq_log WHERE topic = ?').get(topic) as { n: number }).n);
    } finally {
        db.close();
    }
}

/** A legacy (auto_vacuum=NONE) DB whose transcript topic was pruned, leaving a large freelist. */
async function legacyDbWithFreelist(name: string): Promise<{ dbPath: string; transcript: string; mesh: string }> {
    const dbPath = freshDbPath(name);
    precreateLegacyDb(dbPath);
    const transcript = sessionTranscriptTopic(`${name}-session`);
    const mesh = meshEventsTopic(MESH_ID);
    const handle = openSeqscribeNode({ dbPath, env: ENV, storedFleetSecret: null, meshIds: [MESH_ID] });
    handle.node.defineTopic(transcript, sessionTranscriptPolicy());
    await appendBig(handle, transcript, 200);
    await appendBig(handle, mesh, 20);
    await handle.node.pruneTopic(transcript, { keepNewest: 10 });
    await handle.close();
    return { dbPath, transcript, mesh };
}

describe('incremental vacuum on the live connection', () => {
    it('new DBs are created incremental-vacuum capable', () => {
        const handle = open(freshDbPath('new'));
        expect(handle.maintenance?.freelistStats()?.autoVacuum).toBe('incremental');
    });

    it('★ a step frees at most maxPages, and the post-sweep reclaim is bounded by steps × pages', async () => {
        const dbPath = freshDbPath('incr');
        const handle = open(dbPath);
        const topic = sessionTranscriptTopic('incr-session');
        handle.node.defineTopic(topic, sessionTranscriptPolicy());
        await appendBig(handle, topic, 120);
        await handle.node.pruneTopic(topic, { keepNewest: 5 });
        const free0 = handle.maintenance!.freelistStats()!.freelistCount;
        expect(free0).toBeGreaterThan(40);

        const step = handle.maintenance!.incrementalVacuumStep(8);
        expect(step).not.toBeNull();
        expect(step!.freedPages).toBeGreaterThan(0);
        expect(step!.freedPages).toBeLessThanOrEqual(8);
        expect(step!.remainingFreePages).toBe(free0 - step!.freedPages);

        const result = await runTranscriptWriterGcSweep(handle, { vacuumPagesPerStep: 4, vacuumMaxSteps: 3 });
        expect(result.vacuumedPages).toBeGreaterThan(0);
        expect(result.vacuumedPages).toBeLessThanOrEqual(12);
        expect(transcriptWriterGcCounters().vacuumedPages).toBe(result.vacuumedPages);
        expect(handle.maintenance!.freelistStats()!.freelistCount).toBe(free0 - step!.freedPages - result.vacuumedPages);
    });

    it('is a no-op (null) on a legacy auto_vacuum=NONE DB', async () => {
        const dbPath = freshDbPath('legacy-incr');
        precreateLegacyDb(dbPath);
        const handle = open(dbPath);
        expect(handle.maintenance!.freelistStats()!.autoVacuum).toBe('none');
        expect(handle.maintenance!.incrementalVacuumStep(8)).toBeNull();
    });
});

describe('compactSeqscribeDbAtShutdown', () => {
    it('threshold: absolute bytes OR ratio above a small floor', () => {
        expect(seqscribeFreelistOverThreshold({ fileBytes: 500e6, freeBytes: 64 * 1024 * 1024 })).toBe(true);
        expect(seqscribeFreelistOverThreshold({ fileBytes: 500e6, freeBytes: 10e6 })).toBe(false);
        expect(seqscribeFreelistOverThreshold({ fileBytes: 20e6, freeBytes: 6e6 })).toBe(true);
        expect(seqscribeFreelistOverThreshold({ fileBytes: 400_000, freeBytes: 200_000 })).toBe(false);
        expect(seqscribeFreelistOverThreshold({ fileBytes: 100e6, freeBytes: 0 })).toBe(false);
    });

    it('★ above threshold: converts auto_vacuum to INCREMENTAL, shrinks the file, keeps every row', async () => {
        const { dbPath, transcript, mesh } = await legacyDbWithFreelist('convert');
        const before = readPragmas(dbPath);
        expect(before.autoVacuum).toBe(0);
        expect(before.freelist).toBeGreaterThan(100);

        const report = compactSeqscribeDbAtShutdown(dbPath, { minFreeBytes: 1, ratioFloorBytes: 1 });

        expect(report.action).toBe('converted');
        const after = readPragmas(dbPath);
        expect(after.autoVacuum).toBe(2);
        expect(after.freelist).toBe(0);
        expect(after.pageCount).toBeLessThan(before.pageCount);
        expect(report.afterBytes!).toBeLessThan(report.beforeBytes!);
        expect(logRows(dbPath, transcript)).toBe(10);
        expect(logRows(dbPath, mesh)).toBe(20);

        // The converted DB reopens cleanly as a node.
        const reopened = open(dbPath, [MESH_ID]);
        expect(reopened.node.stats().topics[mesh]?.logRows).toBe(20);
    });

    it('below threshold: skips and leaves auto_vacuum unchanged', async () => {
        const { dbPath } = await legacyDbWithFreelist('below');
        const report = compactSeqscribeDbAtShutdown(dbPath); // defaults: 64 MB / 25% of file
        expect(report.action).toBe('skipped');
        expect(report.reason).toMatch(/below threshold/);
        expect(readPragmas(dbPath).autoVacuum).toBe(0);
    });

    it('already INCREMENTAL: runs a plain incremental vacuum instead of VACUUM', async () => {
        const dbPath = freshDbPath('already');
        const handle = openSeqscribeNode({ dbPath, env: ENV, storedFleetSecret: null, meshIds: [] });
        const topic = sessionTranscriptTopic('already-session');
        handle.node.defineTopic(topic, sessionTranscriptPolicy());
        await appendBig(handle, topic, 100);
        await handle.node.pruneTopic(topic, { keepNewest: 5 });
        await handle.close();
        expect(readPragmas(dbPath).freelist).toBeGreaterThan(0);

        const report = compactSeqscribeDbAtShutdown(dbPath, { minFreeBytes: 1, ratioFloorBytes: 1 });
        expect(report.action).toBe('incremental');
        expect(readPragmas(dbPath).freelist).toBe(0);
    });

    it('skips while another process-level owner holds the lock (a live node)', async () => {
        const { dbPath } = await legacyDbWithFreelist('locked');
        const live = open(dbPath, [MESH_ID]);
        const report = compactSeqscribeDbAtShutdown(dbPath, { minFreeBytes: 1, ratioFloorBytes: 1 });
        expect(report.action).toBe('skipped');
        expect(report.reason).toMatch(/owner lock/);
        await live.close();
        expect(readPragmas(dbPath).autoVacuum).toBe(0);
    });

    it('skips without enough free disk, and above the size cap', async () => {
        const { dbPath } = await legacyDbWithFreelist('disk');
        const noDisk = compactSeqscribeDbAtShutdown(dbPath, { minFreeBytes: 1, ratioFloorBytes: 1, freeDiskBytes: () => 1024 });
        expect(noDisk.action).toBe('skipped');
        expect(noDisk.reason).toMatch(/insufficient free disk/);
        const tooBig = compactSeqscribeDbAtShutdown(dbPath, { minFreeBytes: 1, ratioFloorBytes: 1, maxDbBytes: 1024 });
        expect(tooBig.action).toBe('skipped');
        expect(tooBig.reason).toMatch(/exceeds the shutdown VACUUM cap/);
        expect(readPragmas(dbPath).autoVacuum).toBe(0);
    });

    it('a missing file is a skip, never a throw', () => {
        expect(compactSeqscribeDbAtShutdown(join(freshDbPath('missing'), 'nope.db')).action).toBe('skipped');
    });
});
