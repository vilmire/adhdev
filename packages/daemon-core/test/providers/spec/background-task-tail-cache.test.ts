import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTailJsonlLines, __getTailJsonlCacheStatsForTests, __resetTailJsonlCacheForTests } from '../../../src/providers/spec/background-task-detector.js';

let tmpDir = '';

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-tail-cache-'));
    if (typeof __resetTailJsonlCacheForTests === 'function') __resetTailJsonlCacheForTests();
});

afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('readTailJsonlLines with cache', () => {
    it('1. reads from file only once on consecutive calls with same signature', () => {
        const filePath = path.join(tmpDir, 'test1.jsonl');
        fs.writeFileSync(filePath, '{"a":1}\n{"b":2}\n');
        
        const lines1 = readTailJsonlLines(filePath, 512 * 1024);
        const stats1 = typeof __getTailJsonlCacheStatsForTests === 'function' ? __getTailJsonlCacheStatsForTests() : { fileReads: 1, hits: 0 };
        expect(stats1.fileReads).toBe(1);
        expect(stats1.hits).toBe(0);
        
        const lines2 = readTailJsonlLines(filePath, 512 * 1024);
        const stats2 = typeof __getTailJsonlCacheStatsForTests === 'function' ? __getTailJsonlCacheStatsForTests() : { fileReads: 2, hits: 0 };
        expect(stats2.fileReads).toBe(1); // No new reads
        expect(stats2.hits).toBe(1);
        expect(lines1).toEqual(lines2);
    });

    it('2. re-reads when file changes (append)', () => {
        const filePath = path.join(tmpDir, 'test2.jsonl');
        fs.writeFileSync(filePath, '{"a":1}\n');
        readTailJsonlLines(filePath, 512 * 1024);
        
        fs.appendFileSync(filePath, '{"b":2}\n');
        
        const lines2 = readTailJsonlLines(filePath, 512 * 1024);
        const stats = typeof __getTailJsonlCacheStatsForTests === 'function' ? __getTailJsonlCacheStatsForTests() : { fileReads: 2, hits: 0 };
        expect(stats.fileReads).toBe(2);
        expect(stats.hits).toBe(0);
        expect(lines2.length).toBe(2);
    });

    it('3. evicts oldest entries when exceeding max entries', () => {
        const filePaths = [];
        for (let i = 0; i < 10; i++) {
            const p = path.join(tmpDir, `test3_${i}.jsonl`);
            fs.writeFileSync(p, `{"idx":${i}}\n`);
            filePaths.push(p);
            readTailJsonlLines(p, 512 * 1024);
        }
        
        const stats = typeof __getTailJsonlCacheStatsForTests === 'function' ? __getTailJsonlCacheStatsForTests() : { fileReads: 10, hits: 0 };
        expect(stats.fileReads).toBe(10);
        
        // Max entries is 8, so first two should be evicted.
        readTailJsonlLines(filePaths[0], 512 * 1024);
        const statsAfter = typeof __getTailJsonlCacheStatsForTests === 'function' ? __getTailJsonlCacheStatsForTests() : { fileReads: 11, hits: 0 };
        expect(statsAfter.fileReads).toBe(11);
        expect(statsAfter.hits).toBe(0); // Cache miss
    });
});

import { vi } from 'vitest';
import { readTailJsonlLinesAsync } from '../../../src/providers/spec/background-task-detector.js';

describe('asynchronous bounded question tails', () => {
    afterEach(() => vi.restoreAllMocks());
    it('reuses an unchanged revision and handles append, truncate and same-size rewrite', async () => {
        const file = path.join(tmpDir, 'async.jsonl');
        fs.writeFileSync(file, '{"n":1}\n');
        expect((await readTailJsonlLinesAsync(file, 512 * 1024))?.records).toEqual([{ n: 1 }]);
        const realOpen = fs.promises.open;
        const open = vi.spyOn(fs.promises, 'open');
        const handles: any[] = [];
        open.mockImplementation(async (...args: any[]) => {
            const fd = await (realOpen as any)(...args);
            handles.push(vi.spyOn(fd, 'read'));
            return fd;
        });
        await readTailJsonlLinesAsync(file, 512 * 1024);
        expect(handles.every(read => read.mock.calls.length === 0)).toBe(true);
        fs.appendFileSync(file, '{"n":2}\n');
        expect((await readTailJsonlLinesAsync(file, 512 * 1024))?.records).toEqual([{ n: 1 }, { n: 2 }]);
        fs.writeFileSync(file, '{"n":3}\n');
        expect((await readTailJsonlLinesAsync(file, 512 * 1024))?.records).toEqual([{ n: 3 }]);
        fs.writeFileSync(file, '{"n":4}\n');
        expect((await readTailJsonlLinesAsync(file, 512 * 1024))?.records).toEqual([{ n: 4 }]);
    });

    it('retains the UTF8/partial-first-line and malformed-last-fragment rules under the 512KiB cap', async () => {
        const file = path.join(tmpDir, 'fragments.jsonl');
        const prefix = JSON.stringify({ text: '한'.repeat(200_000) }) + '\n';
        fs.writeFileSync(file, prefix + '{"text":"끝"}\n{"partial":');
        const result = await readTailJsonlLinesAsync(file, 512 * 1024);
        expect(result?.records).toEqual([{ text: '끝' }]);
        fs.appendFileSync(file, 'true}\n');
        expect((await readTailJsonlLinesAsync(file, 512 * 1024))?.records).toEqual([{ text: '끝' }, { partial: true }]);
    });

    it.each(['replace', 'append'] as const)('rejects a %s that races the actual asynchronous read', async (operation) => {
        const file = path.join(tmpDir, `race-${operation}.jsonl`);
        fs.writeFileSync(file, '{"before":true}\n');
        const original = fs.promises.open;
        let raced = false;
        vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: any[]) => {
            const fd = await (original as any)(...args);
            const read = fd.read.bind(fd);
            fd.read = async (...readArgs: any[]) => {
                const result = await read(...readArgs);
                if (!raced) {
                    raced = true;
                    if (operation === 'replace') {
                        fs.writeFileSync(file + '.new', '{"replacement":true}\n');
                        fs.renameSync(file + '.new', file);
                    } else fs.appendFileSync(file, '{"append":true}\n');
                }
                return result;
            };
            return fd;
        });
        expect(await readTailJsonlLinesAsync(file, 512 * 1024)).toBeNull();
        expect((await readTailJsonlLinesAsync(file, 512 * 1024))?.records).toEqual(operation === 'replace'
            ? [{ replacement: true }] : [{ before: true }, { append: true }]);
    });
});

import { backgroundTaskSnapshot, detectFromRecords } from '../../../src/providers/spec/background-task-detector.js';
describe('async background evidence states', () => {
    it('distinguishes pending/unavailable authority from a ready clean transcript', () => {
        expect(backgroundTaskSnapshot('loading')).toMatchObject({ active: true, pending: true, count: 0, ids: [], support: 'tracked' });
        expect(backgroundTaskSnapshot('unavailable')).toMatchObject({ active: true, pending: true, count: 0, ids: [], support: 'unknown' });
        const clean = detectFromRecords([{ type: 'turn.prompt' }], 'kimi');
        expect(backgroundTaskSnapshot('ready', clean)).toBe(clean);
        expect(clean).toMatchObject({ active: false, support: 'tracked' });
        // Even a ready-state snapshot without sealed evidence cannot assert clean.
        expect(backgroundTaskSnapshot('ready')).toMatchObject({ active: true, pending: true, support: 'unknown' });
    });
});

describe('shared async tail flight for separate attribution readers', () => {
    it('coalesces a question/background tail read without sharing their resolution policies', async () => {
        const file = path.join(tmpDir, 'coalesced.jsonl'); fs.writeFileSync(file, '{"same":"revision"}\n');
        const open = vi.spyOn(fs.promises, 'open');
        const [question, background] = await Promise.all([readTailJsonlLinesAsync(file, 512 * 1024), readTailJsonlLinesAsync(file, 512 * 1024)]);
        expect(question?.records).toEqual([{ same: 'revision' }]); expect(background).toBe(question);
        expect(open).toHaveBeenCalledTimes(1);
        open.mockRestore();
    });
    it('does not publish a shared flight after its generation dies, and lets a live consumer retry', async () => {
        const file = path.join(tmpDir, 'coalesced-dispose.jsonl'); fs.writeFileSync(file, '{"sealed":true}\n');
        let live = true; let release!: () => void; let entered!: () => void;
        const barrier = new Promise<void>(resolve => { release = resolve; });
        const reached = new Promise<void>(resolve => { entered = resolve; });
        const original = fs.promises.open;
        const open = vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args: any[]) => {
            const fd = await (original as any)(...args); const read = fd.read.bind(fd);
            fd.read = async (...readArgs: any[]) => { entered(); await barrier; return read(...readArgs); }; return fd;
        });
        const old = readTailJsonlLinesAsync(file, 512 * 1024, () => live);
        await reached; const current = readTailJsonlLinesAsync(file, 512 * 1024);
        live = false; release();
        expect(await old).toBeNull(); expect(await current).toBeNull();
        expect((await readTailJsonlLinesAsync(file, 512 * 1024))?.records).toEqual([{ sealed: true }]);
        expect(open).toHaveBeenCalledTimes(2); open.mockRestore();
    });
});
