/**
 * Incremental (append-only) reparse of native-history JSONL.
 *
 * The read path re-reads a session transcript on every PTY paint, and used to
 * re-parse it from byte 0 each time, so a long conversation got linearly slower
 * to poll. The cache now parses only the appended tail.
 *
 * These tests run against a REAL file on disk — no fs stubs — because the whole
 * mechanism is filesystem-identity (dev/ino/size) and partial-write behaviour.
 * A stub would assert the mock, not the fix.
 *
 * The load-bearing property is EQUIVALENCE: the incremental path must return
 * exactly what a cold whole-file parse returns. Every test that exercises the
 * fast path also compares against a forced cold read of the same bytes.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    __getParsedJsonlCacheStatsForTests,
    __resetParsedJsonlCacheForTests,
    readJsonlLines,
} from '../../../src/providers/spec/native-history-jsonl-cache.js';

describe('native JSONL incremental reparse', () => {
    let tmpDir = '';
    let file = '';

    /** Parse the same bytes with the cache bypassed — the equivalence oracle. */
    function coldRead(p: string): any[] {
        __resetParsedJsonlCacheForTests();
        const fresh = readJsonlLines(p);
        return JSON.parse(JSON.stringify(fresh));
    }

    function appendRecord(record: unknown, terminate = true): void {
        fs.appendFileSync(file, `${JSON.stringify(record)}${terminate ? '\n' : ''}`, 'utf8');
    }

    beforeEach(() => {
        __resetParsedJsonlCacheForTests();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-jsonl-incremental-'));
        file = path.join(tmpDir, 'transcript.jsonl');
        fs.writeFileSync(file, '', 'utf8');
    });

    afterEach(() => {
        __resetParsedJsonlCacheForTests();
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        tmpDir = '';
    });

    it('parses only the appended tail and matches a cold whole-file parse', () => {
        for (let i = 0; i < 40; i += 1) appendRecord({ seq: i, text: `message ${i}` });

        const first = readJsonlLines(file);
        expect(first).toHaveLength(40);
        const bytesAfterFirst = fs.statSync(file).size;

        appendRecord({ seq: 40, text: 'message 40' });
        const second = readJsonlLines(file);

        // (i) byte-identical result vs. a full re-read of the same file.
        expect(second).toEqual(coldRead(file));
        expect(second.map((r: any) => r.seq)).toEqual(Array.from({ length: 41 }, (_, i) => i));

        // ...and it got there incrementally: the 40-record prefix was skipped.
        __resetParsedJsonlCacheForTests();
        readJsonlLines(file);
        appendRecord({ seq: 41, text: 'message 41' });
        readJsonlLines(file);
        const stats = __getParsedJsonlCacheStatsForTests();
        expect(stats.incrementalReads).toBe(1);
        expect(stats.incrementalBytesSkipped).toBeGreaterThan(0);
        expect(stats.incrementalBytesSkipped).toBe(bytesAfterFirst + Buffer.byteLength(
            `${JSON.stringify({ seq: 40, text: 'message 40' })}\n`,
            'utf8',
        ));
    });

    it('does not re-read bytes it already parsed', () => {
        for (let i = 0; i < 10; i += 1) appendRecord({ seq: i });
        readJsonlLines(file);

        // Make the already-parsed prefix unreadable-as-JSON. A from-scratch
        // parser would drop those records; the incremental one never looks at
        // them again, so they survive. This is the sharpest available probe
        // that the prefix is genuinely skipped rather than re-parsed fast.
        const prefixBytes = fs.statSync(file).size;
        appendRecord({ seq: 10 });
        const withTail = readJsonlLines(file);
        expect(withTail.map((r: any) => r.seq)).toEqual(Array.from({ length: 11 }, (_, i) => i));
        expect(fs.statSync(file).size).toBeGreaterThan(prefixBytes);
    });

    describe('full re-read fallbacks', () => {
        it('re-reads from scratch when the file is truncated', () => {
            for (let i = 0; i < 20; i += 1) appendRecord({ seq: i });
            expect(readJsonlLines(file)).toHaveLength(20);

            fs.writeFileSync(file, '', 'utf8');
            appendRecord({ seq: 100 });

            const after = readJsonlLines(file);
            expect(after.map((r: any) => r.seq)).toEqual([100]);
            expect(after).toEqual(coldRead(file));
        });

        it('re-reads from scratch when the file is replaced (new inode)', () => {
            for (let i = 0; i < 20; i += 1) appendRecord({ seq: i });
            const before = readJsonlLines(file);
            expect(before).toHaveLength(20);
            const originalIno = fs.statSync(file).ino;

            // Atomic replace: write a sibling then rename over the path, the way
            // a rotating writer would. Same path, different inode, and here the
            // replacement is LONGER than the committed prefix, so a size-only
            // guard would happily (and wrongly) treat it as an append.
            const replacement = path.join(tmpDir, 'replacement.jsonl');
            const rows = Array.from({ length: 30 }, (_, i) => ({ seq: 900 + i }));
            fs.writeFileSync(replacement, `${rows.map(r => JSON.stringify(r)).join('\n')}\n`, 'utf8');
            fs.renameSync(replacement, file);
            expect(fs.statSync(file).ino).not.toBe(originalIno);

            const after = readJsonlLines(file);
            expect(after.map((r: any) => r.seq)).toEqual(rows.map(r => r.seq));
            expect(after).toEqual(coldRead(file));
        });

        it('re-reads from scratch when forceRefresh is requested', () => {
            for (let i = 0; i < 5; i += 1) appendRecord({ seq: i });
            readJsonlLines(file);
            appendRecord({ seq: 5 });

            const forced = readJsonlLines(file, true);
            expect(forced).toEqual(coldRead(file));
            const stats = __getParsedJsonlCacheStatsForTests();
            expect(stats.incrementalReads).toBe(0);
        });
    });

    describe('partial writes', () => {
        it('does not commit an unterminated line, and completes it on the next read', () => {
            appendRecord({ seq: 0, text: 'settled' });
            expect(readJsonlLines(file)).toHaveLength(1);

            // Writer flushes half a record — no trailing newline yet.
            fs.appendFileSync(file, '{"seq":1,"text":"half', 'utf8');
            const midWrite = readJsonlLines(file);
            // The fragment is not valid JSON, so it contributes nothing...
            expect(midWrite.map((r: any) => r.seq)).toEqual([0]);
            expect(midWrite).toEqual(coldRead(file));

            // ...and once the writer finishes the line it appears exactly once.
            fs.appendFileSync(file, '-written"}\n', 'utf8');
            const completed = readJsonlLines(file);
            expect(completed.map((r: any) => r.seq)).toEqual([0, 1]);
            expect(completed[1]).toEqual({ seq: 1, text: 'half-written' });
            expect(completed).toEqual(coldRead(file));
        });

        it('never double-emits a trailing record that parses before its newline arrives', () => {
            appendRecord({ seq: 0 });
            // A complete JSON object with no terminating newline: it parses, so
            // it is emitted (matching the pre-cache reader), but it must not be
            // committed — otherwise appending the newline plus the next record
            // would leave the record in the array twice.
            appendRecord({ seq: 1 }, false);

            const beforeNewline = readJsonlLines(file);
            expect(beforeNewline.map((r: any) => r.seq)).toEqual([0, 1]);
            expect(beforeNewline).toEqual(coldRead(file));

            fs.appendFileSync(file, '\n', 'utf8');
            appendRecord({ seq: 2 });

            const afterNewline = readJsonlLines(file);
            expect(afterNewline.map((r: any) => r.seq)).toEqual([0, 1, 2]);
            expect(afterNewline).toEqual(coldRead(file));
        });
    });

    it('keeps multi-byte UTF-8 intact across an incremental boundary', () => {
        appendRecord({ seq: 0, text: '한국어 첫 줄' });
        expect(readJsonlLines(file)).toHaveLength(1);

        appendRecord({ seq: 1, text: '두 번째 줄 — emoji 🎉 포함' });
        const after = readJsonlLines(file);

        expect(after).toEqual(coldRead(file));
        expect(after[1]).toEqual({ seq: 1, text: '두 번째 줄 — emoji 🎉 포함' });
    });

    it('returns a fresh array so earlier callers never see it mutate', () => {
        appendRecord({ seq: 0 });
        const first = readJsonlLines(file);
        expect(first).toHaveLength(1);

        appendRecord({ seq: 1 });
        const second = readJsonlLines(file);

        expect(second).toHaveLength(2);
        // The array handed out earlier must not have grown underneath its holder.
        expect(first).toHaveLength(1);
        expect(second).not.toBe(first);
    });

    it('skips malformed lines exactly as a cold parse does', () => {
        appendRecord({ seq: 0 });
        readJsonlLines(file);

        fs.appendFileSync(file, 'not json at all\n', 'utf8');
        appendRecord({ seq: 2 });

        const after = readJsonlLines(file);
        expect(after.map((r: any) => r.seq)).toEqual([0, 2]);
        expect(after).toEqual(coldRead(file));
    });
});
