/**
 * Regression coverage for win32 submit surrogate-safe chunking, lossless
 * non-ASCII body writes, and win32_input_mode_non_ascii encoding
 * (split from driver-win32-submit.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { chunkPreservingSurrogates } from '../../../src/providers/spec/submit-policy.js';
import { decodeWin32InputMode } from '../../../src/providers/spec/win32-input-mode.js';
import {
    BP_OPEN, BP_CLOSE, SOFT_NL,
    setPlatform, registerWin32SubmitHooks, sendAndCollectPty,
} from './driver-win32-submit-harness.js';

registerWin32SubmitHooks();

describe('chunkPreservingSurrogates', () => {
    it('reassembles to the original and never exceeds the size', () => {
        const text = 'a'.repeat(2500) + 'b'.repeat(700);
        const chunks = chunkPreservingSurrogates(text, 1024);
        expect(chunks.join('')).toBe(text);
        for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1024);
        expect(chunks.length).toBeGreaterThan(1);
    });

    it('never splits a UTF-16 surrogate pair', () => {
        // Astral chars (😀 = 2 UTF-16 units) packed so a naive boundary would land
        // mid-pair. Every chunk must contain only whole code points.
        const text = '😀'.repeat(100);
        const chunks = chunkPreservingSurrogates(text, 5); // 5 units = 2.5 emoji
        expect(chunks.join('')).toBe(text);
        for (const c of chunks) {
            // A well-formed string round-trips through code-point iteration with no
            // lone surrogate (which would appear as  on re-encode).
            expect([...c].every(cp => cp.codePointAt(0) !== 0xfffd)).toBe(true);
            const last = c.charCodeAt(c.length - 1);
            expect(last >= 0xd800 && last <= 0xdbff).toBe(false); // no trailing high surrogate
        }
    });

    it('passes short text through as a single chunk', () => {
        expect(chunkPreservingSurrogates('hi', 1024)).toEqual(['hi']);
    });
});

describe('FsmDriver -- win32 body write is lossless for non-ASCII text', () => {
    // A delegated agy worker on a win32 node recorded its task prompt with every
    // em-dash removed ("the authoritative record of this task  your terminal is
    // not scraped"), while the same prompt on darwin kept them (preview fleet,
    // 2026-10-09). This pins the daemon's own share of the path: the body the
    // driver hands the PTY must carry every non-ASCII character unchanged,
    // across chunk boundaries and inside the bracketed-paste wrapper, so a loss
    // observed downstream is not ours.
    const PARA = 'Its summary is recorded verbatim — your terminal is not scraped — café 한글 😀.';
    const BODY = Array.from({ length: 40 }, (_, i) => `${i}: ${PARA}`).join('\n');

    for (const mode of ['paste', 'soft_newline'] as const) {
        it(`${mode}: every non-ASCII character reaches the PTY`, async () => {
            setPlatform('win32');
            expect(BODY.length).toBeGreaterThan(1024 * 2); // spans several write chunks
            const { writes } = await sendAndCollectPty({ text: BODY, submitMode: mode, submitAfterMs: 900, totalWaitMs: 1500 });
            const written = writes
                .filter(w => w !== '\r')
                .join('')
                .replace(/\x1b\[20[01]~/g, '')
                .split('\x1b[27;2;13~').join('\n');
            expect(written).toBe(BODY);
            expect(written.split('—').length - 1).toBe(80);
        });
    }
});

describe('FsmDriver -- win32_input_mode_non_ascii (agy drops non-letter non-ASCII from plain UTF-8)', () => {
    // Live (win32, agy, 2026-10-09): plain UTF-8 lost `— – “ ” … € → ✓ · ×` and emoji
    // in BOTH write shapes (bracketed paste and plain single-line); the same characters
    // written as win32-input-mode key records arrived intact. The spec opt-in makes the
    // driver encode every non-ASCII code point that way; ASCII and the paste / submit
    // framing are unchanged.
    const PARA = 'a — b – “q” … € → ✓ · × café 한글 中 🙂😀 end';
    const OPT_IN = { win32_input_mode_non_ascii: true };
    const hasRawNonAscii = (s: string) => /[^\x00-\x7f]/.test(s);

    it('single-line: no raw non-ASCII reaches the PTY, no paste wrap, decodes to the body, one submit', async () => {
        setPlatform('win32');
        const { writes, submits, firstSubmittedText } = await sendAndCollectPty({ text: PARA, sendMessage: OPT_IN, submitAfterMs: 900, totalWaitMs: 1500 });
        const body = writes.filter(w => w !== '\r');
        expect(body.some(hasRawNonAscii)).toBe(false);
        expect(body.join('')).not.toContain(BP_OPEN);
        expect(decodeWin32InputMode(body.join(''))).toBe(PARA);
        // The whole encoded body was standing in the composer when the CR fired.
        expect(submits).toBeGreaterThanOrEqual(1);
        expect(decodeWin32InputMode(firstSubmittedText ?? '')).toBe(PARA);
    });

    for (const mode of ['paste', 'soft_newline'] as const) {
        it(`${mode}: a long multi-line body is encoded, chunk-safe, framed as before, and decodes losslessly`, async () => {
            setPlatform('win32');
            const BODY = Array.from({ length: 30 }, (_, i) => `${i}: ${PARA}`).join('\n');
            const { writes, submits } = await sendAndCollectPty({ text: BODY, submitMode: mode, sendMessage: OPT_IN, submitAfterMs: 900, totalWaitMs: 1500 });
            const body = writes.filter(w => w !== '\r');
            expect(body.length).toBeGreaterThan(3); // paced into several writes
            expect(body.some(hasRawNonAscii)).toBe(false);
            // No write ends inside a key record: every write's records are complete.
            for (const w of body) expect(w).not.toMatch(/\x1b\[[0-9;]*$/);
            for (const w of body) expect(w.length).toBeLessThanOrEqual(1024);
            const joined = body.join('');
            if (mode === 'paste') {
                expect(joined.startsWith(BP_OPEN)).toBe(true);
                expect(joined.endsWith(BP_CLOSE)).toBe(true);
            }
            const decoded = decodeWin32InputMode(joined.replace(/\x1b\[20[01]~/g, '')).split(SOFT_NL).join('\n');
            expect(decoded).toBe(BODY);
            expect(submits).toBe(1);
        });
    }

    it('flag off: win32 bytes are the raw UTF-8 body (unchanged behaviour)', async () => {
        setPlatform('win32');
        const { writes } = await sendAndCollectPty({ text: PARA, submitAfterMs: 400, totalWaitMs: 900 });
        expect(writes.filter(w => w !== '\r').join('')).toBe(PARA);
    });

    it('non-win32 ignores the flag (raw UTF-8)', async () => {
        setPlatform('darwin');
        const { writes } = await sendAndCollectPty({ text: PARA, sendMessage: OPT_IN, submitAfterMs: 400, totalWaitMs: 900 });
        expect(writes.filter(w => w !== '\r').join('')).toBe(PARA);
    });
});
