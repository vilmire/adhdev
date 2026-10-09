import { describe, it, expect } from 'vitest';
import {
    WIN32_VK_PACKET,
    chunkWin32InputMode,
    decodeWin32InputMode,
    encodeWin32InputMode,
    win32InputModeRecordsForCodePoint,
} from '../../../src/providers/spec/win32-input-mode.js';

const rec = (u: number, down: 0 | 1) => `\x1b[${WIN32_VK_PACKET};0;${u};${down};0;1_`;

describe('win32-input-mode encoding', () => {
    it('BMP char: one key-down then one key-up record carrying the UTF-16 unit', () => {
        expect(win32InputModeRecordsForCodePoint('—')).toBe(rec(0x2014, 1) + rec(0x2014, 0));
    });

    it('astral char: both surrogate downs first, then ups reversed (interleaving doubled the emoji live)', () => {
        expect(win32InputModeRecordsForCodePoint('🙂')).toBe(
            rec(0xd83d, 1) + rec(0xde42, 1) + rec(0xde42, 0) + rec(0xd83d, 0),
        );
    });

    it('ASCII, control bytes and escape sequences pass through untouched', () => {
        const ascii = 'abc\r\n\x1b[200~x\x1b[201~\x1b[27;2;13~';
        expect(encodeWin32InputMode(ascii)).toBe(ascii);
    });

    it('round-trips mixed text, including letters and emoji', () => {
        const text = 'a — b, café, 한글, emoji 🙂 “q” → ✓ · × €\nnext';
        const enc = encodeWin32InputMode(text);
        expect(/[^\x00-\x7f]/.test(enc)).toBe(false);
        expect(decodeWin32InputMode(enc)).toBe(text);
    });

    it('chunking never splits a record group, bounds segment size, and reassembles exactly', () => {
        const text = Array.from({ length: 200 }, (_, i) => `${i} — 🙂 x`).join('\n');
        const size = 100;
        const segments = chunkWin32InputMode(text, size);
        expect(segments.join('')).toBe(encodeWin32InputMode(text));
        for (const s of segments) {
            expect(s.length).toBeLessThanOrEqual(size);
            // every segment decodes on its own → no record cut in half
            expect(/\x1b\[[0-9;]*$/.test(s)).toBe(false);
            expect(/^[0-9;]*_/.test(s)).toBe(false);
        }
        expect(decodeWin32InputMode(segments.join(''))).toBe(text);
    });

    it('a single record group larger than the budget still goes out whole', () => {
        const segments = chunkWin32InputMode('🙂', 10);
        expect(segments).toEqual([win32InputModeRecordsForCodePoint('🙂')]);
    });

    it('a CSI sequence already in the body (soft newline) is never split by a chunk boundary', () => {
        const SOFT_NL = '\x1b[27;2;13~';
        const text = Array.from({ length: 50 }, (_, i) => `${i}—`).join(SOFT_NL);
        for (const size of [7, 13, 29, 64]) {
            const segments = chunkWin32InputMode(text, size);
            expect(segments.join('')).toBe(encodeWin32InputMode(text));
            for (const s of segments) expect(/\x1b\[[0-9;]*$/.test(s)).toBe(false);
        }
    });

    it('pure ASCII chunks exactly like a plain split', () => {
        expect(chunkWin32InputMode('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    });
});
