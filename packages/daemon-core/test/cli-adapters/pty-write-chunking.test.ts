/**
 * Unit coverage for the shared win32 PTY paced-write helper.
 *
 * This module is the single source of truth for the chunk size / gap / surrogate-
 * safe split shared by the spec FsmDriver (writeWin32Body) and the legacy
 * ProviderCliAdapter (writeToPty). The previous duplication is the reason "one
 * branch was patched, the other not" and long messages truncated on win32.
 */
import { describe, it, expect, vi } from 'vitest';
import {
    WIN32_PTY_WRITE_CHUNK_CHARS,
    chunkPreservingSurrogates,
    shouldChunkWin32Write,
    writeWin32Paced,
} from '../../src/cli-adapters/pty-write-chunking.js';

describe('chunkPreservingSurrogates (shared)', () => {
    it('reassembles to the original and never exceeds the size', () => {
        const text = 'a'.repeat(2500) + 'b'.repeat(700);
        const chunks = chunkPreservingSurrogates(text, 1024);
        expect(chunks.join('')).toBe(text);
        for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1024);
        expect(chunks.length).toBeGreaterThan(1);
    });

    it('never splits a UTF-16 surrogate pair', () => {
        const text = '😀'.repeat(100); // 2 UTF-16 units each
        const chunks = chunkPreservingSurrogates(text, 5); // odd size straddles a pair
        expect(chunks.join('')).toBe(text);
        for (const c of chunks) {
            const last = c.charCodeAt(c.length - 1);
            expect(last >= 0xd800 && last <= 0xdbff).toBe(false); // no trailing high surrogate
            expect([...c].every(cp => cp.codePointAt(0) !== 0xfffd)).toBe(true);
        }
    });

    it('passes short text through as a single chunk', () => {
        expect(chunkPreservingSurrogates('hi', 1024)).toEqual(['hi']);
    });
});

describe('shouldChunkWin32Write', () => {
    it('is false at or below the chunk threshold and true above it', () => {
        expect(shouldChunkWin32Write(WIN32_PTY_WRITE_CHUNK_CHARS)).toBe(false);
        expect(shouldChunkWin32Write(WIN32_PTY_WRITE_CHUNK_CHARS - 1)).toBe(false);
        expect(shouldChunkWin32Write(WIN32_PTY_WRITE_CHUNK_CHARS + 1)).toBe(true);
    });
});

describe('writeWin32Paced', () => {
    it('writes a small body in a single write with no timer', () => {
        const writes: string[] = [];
        let timerSet = false;
        writeWin32Paced('short body', {
            write: c => writes.push(c),
            setTimer: () => { timerSet = true; return 0 as any; },
        });
        expect(writes).toEqual(['short body']);
        expect(timerSet).toBe(false);
    });

    it('paces a large body into multiple chunks that reassemble exactly (no front loss)', () => {
        const text = 'x'.repeat(WIN32_PTY_WRITE_CHUNK_CHARS * 3 + 17);
        const writes: string[] = [];
        // Synchronous fake timer so the whole sequence drains in-line.
        const pending: Array<() => void> = [];
        writeWin32Paced(text, {
            write: c => writes.push(c),
            setTimer: (fn) => { pending.push(fn); return pending.length as any; },
        });
        // Drain the queued chunk writes.
        while (pending.length) pending.shift()!();
        expect(writes.length).toBeGreaterThanOrEqual(4);
        expect(writes.join('')).toBe(text);
        for (const c of writes) expect(c.length).toBeLessThanOrEqual(WIN32_PTY_WRITE_CHUNK_CHARS);
    });

    it('calls onChunkWritten per chunk and onDone once after the final chunk', () => {
        const text = 'y'.repeat(WIN32_PTY_WRITE_CHUNK_CHARS * 2 + 5);
        const order: string[] = [];
        const pending: Array<() => void> = [];
        writeWin32Paced(text, {
            write: () => order.push('write'),
            onChunkWritten: () => order.push('chunk'),
            onDone: () => order.push('done'),
            setTimer: (fn) => { pending.push(fn); return pending.length as any; },
        });
        while (pending.length) pending.shift()!();
        // 3 chunks → 3 write/chunk pairs, exactly one done at the end.
        expect(order.filter(o => o === 'write').length).toBe(3);
        expect(order.filter(o => o === 'chunk').length).toBe(3);
        expect(order.filter(o => o === 'done').length).toBe(1);
        expect(order[order.length - 1]).toBe('done');
    });
});
