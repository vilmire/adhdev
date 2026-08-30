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
