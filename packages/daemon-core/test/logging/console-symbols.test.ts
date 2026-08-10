import { describe, it, expect } from 'vitest';
import {
    resolveConsoleSymbols,
    supportsUnicodeSymbols,
} from '../../src/logging/console-symbols.js';

// Reproduced from a real stable-Windows machine (Korean locale, CP949 console).
// `adhdev doctor` printed:
//
//   ?㈉ ADHDev Doctor
//     ??Build track: stable (build)
//     Warning: 2 optional check failed.
//     ??Doctor checks passed.
//
// Both the passing checks and the failing marker rendered as "??" — the user
// could not tell which check failed. That is the defect.
//
// These tests run on ANY host OS: the platform is injected into the probe and
// the corruption is reproduced by decoding real UTF-8 bytes through a CP949
// decoder, never by depending on the host console. (Same platform-agnostic
// discipline as packages/daemon-cloud/test/legacy-install-boundary.test.ts.)

const WIN32_LEGACY_CONSOLE = { platform: 'win32', env: {} as Record<string, string | undefined> };

/** Decode a UTF-8 string's bytes the way a CP949 console would. */
function asReadByCp949(text: string): string {
    return new TextDecoder('euc-kr').decode(Buffer.from(text, 'utf8'));
}

describe('the CP949 corruption mechanism (why the fallback exists)', () => {
    it('★ ✓ and ✗ both collapse to the SAME character under CP949 — success is indistinguishable from failure', () => {
        const ok = asReadByCp949('✓');
        const fail = asReadByCp949('✗');

        // This equality IS the bug: two opposite meanings, one rendering.
        // Neither retains any printable character that distinguishes them —
        // both start with the replacement char and carry only C1 controls,
        // which a console renders as '?'.
        expect(ok).toContain('�');
        expect(fail).toContain('�');
        // Strip the C1 controls and the replacement char itself: what is left
        // is the only thing a user could actually use to tell the two apart.
        const distinguishing = (s: string) =>
            [...s].filter((c) => {
                const cp = c.codePointAt(0)!;
                return cp > 0xa0 && cp !== 0xfffd;
            }).join('');
        expect(distinguishing(ok)).toBe(distinguishing(fail));
        expect(distinguishing(ok)).toBe('');
    });

    it('★ the ASCII fallback markers stay distinguishable even through a CP949 decode', () => {
        // The property the Unicode set loses, the fallback must keep. If this
        // ever fails, the fallback is not actually solving the problem.
        expect(asReadByCp949('[OK]')).not.toBe(asReadByCp949('[X]'));
        expect(asReadByCp949('[OK]')).toBe('[OK]');
        expect(asReadByCp949('[X]')).toBe('[X]');
    });

    it('the "?㈉" and "??" corruptions share ONE root cause (byte length, not two separate bugs)', () => {
        // Asserted on CODEPOINTS, not on a source literal: the CP949 decode
        // emits raw C1 control characters (U+009C, U+009F) that are invisible
        // in an editor, so a literal comparison here would be unreadable and
        // fragile — two visually identical strings that are not equal.
        const codepoints = (s: string) => [...s].map((c) => c.codePointAt(0)!);

        // 4-byte emoji: the trailing byte pair forms a printable CP949
        // character, so it degrades to "?<glyph>" — this is the '?㈉' the
        // owner saw for the 🩺 in the Doctor header. U+3209 is that glyph.
        expect(codepoints(asReadByCp949('🩺'))).toEqual([0xfffd, 0x9f, 0x3209]);

        // 3-byte glyph: no printable trailing pair, so it degrades to a
        // replacement char plus controls — rendered as the bare '??' seen
        // for ✓/✗. No printable glyph survives.
        expect(codepoints(asReadByCp949('✓'))).toEqual([0xfffd, 0x9c, 0x93]);

        // Same transformation, different byte lengths. ONE cause, two shapes:
        // both begin with U+FFFD, and differ only in what the leftover bytes
        // happen to decode to.
        expect(codepoints(asReadByCp949('🩺'))[0]).toBe(0xfffd);
        expect(codepoints(asReadByCp949('✓'))[0]).toBe(0xfffd);
    });
});

describe('supportsUnicodeSymbols', () => {
    it('★ legacy win32 console (no WT_SESSION / TERM_PROGRAM) falls back to ASCII', () => {
        expect(supportsUnicodeSymbols(WIN32_LEGACY_CONSOLE)).toBe(false);
    });

    it('never downgrades non-win32 platforms', () => {
        expect(supportsUnicodeSymbols({ platform: 'darwin', env: {} })).toBe(true);
        expect(supportsUnicodeSymbols({ platform: 'linux', env: {} })).toBe(true);
    });

    it('keeps Unicode on modern Windows hosts that can render it', () => {
        expect(supportsUnicodeSymbols({ platform: 'win32', env: { WT_SESSION: '1' } })).toBe(true);
        expect(supportsUnicodeSymbols({ platform: 'win32', env: { TERM_PROGRAM: 'vscode' } })).toBe(true);
    });

    it('treats an explicit UTF-8 code page / locale as opt-in', () => {
        expect(supportsUnicodeSymbols({ platform: 'win32', env: { ADHDEV_CONSOLE_CODEPAGE: '65001' } })).toBe(true);
        expect(supportsUnicodeSymbols({ platform: 'win32', env: { LANG: 'ko_KR.UTF-8' } })).toBe(true);
        // ...but the locale that actually breaks stays on the fallback.
        expect(supportsUnicodeSymbols({ platform: 'win32', env: { LANG: 'ko_KR.CP949' } })).toBe(false);
    });

    it('ADHDEV_ASCII_SYMBOLS overrides the detection in both directions', () => {
        expect(supportsUnicodeSymbols({ platform: 'darwin', env: { ADHDEV_ASCII_SYMBOLS: '1' } })).toBe(false);
        expect(supportsUnicodeSymbols({ platform: 'win32', env: { ADHDEV_ASCII_SYMBOLS: '0' } })).toBe(true);
    });
});

describe('resolveConsoleSymbols', () => {
    it('★ win32 legacy console gets ASCII markers that survive CP949', () => {
        const sym = resolveConsoleSymbols(WIN32_LEGACY_CONSOLE);
        expect(sym.ok).toBe('[OK]');
        expect(sym.fail).toBe('[X]');
        // The invariant that matters: ok and fail must never be equal after a
        // CP949 round-trip, whatever the chosen glyphs are.
        expect(asReadByCp949(sym.ok)).not.toBe(asReadByCp949(sym.fail));
    });

    it('posix keeps the Unicode glyphs', () => {
        const sym = resolveConsoleSymbols({ platform: 'darwin', env: {} });
        expect(sym.ok).toBe('✓');
        expect(sym.fail).toBe('✗');
    });
});
