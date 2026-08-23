/**
 * Equivalence guard for the ANSI-stripping fast paths.
 *
 * The three `stripAnsi` helpers (cli-adapters/provider-cli-shared.ts,
 * providers/spec/cli-adapter.ts, providers/sdk/v1/builders/cli/parse-session.ts)
 * were restructured for speed: the non-`ESC[` escape families were fused into a
 * single delete-only pass, and cheap indexOf guards skip the regex engine for
 * plain text. The rewrite is required to be BYTE-FOR-BYTE identical to the
 * original pass chains, so this file pins the original implementations as
 * reference oracles and diffs them against the shipping code.
 *
 * The reference bodies below are verbatim copies of the pre-optimization
 * source. They are intentionally duplicated here rather than imported: their
 * whole job is to be a frozen record of the old behavior, so they must NOT
 * track future edits to the real helpers.
 *
 * The implementations UNDER TEST, by contrast, are imported from src -- never
 * mirrored. An earlier draft of this file copied them too, and injecting a
 * defect into the real `stripAnsi` left the suite green: the copies were being
 * tested, not the shipping code. The `stripAnsi` / `splitRawLines` exports
 * exist for this reason.
 *
 * WHY THE STRUCTURE IS WHAT IT IS -- three fusions were attempted, measured,
 * and REVERTED because this corpus proved them non-equivalent. Each is a case
 * of sequential passes restarting their scan while a fused alternation cannot:
 *
 *   1. CSI vs the rest. Deleting an `ESC[<n>D` can leave an earlier dangling
 *      `ESC[` adjacent to new text that a later fresh scan then consumes.
 *        "x<ESC>[<ESC>[2Db" -> sequential "x", fused "x<ESC>[b"
 *   2. control-strip vs trailing-trim (splitRawLines). Deleting a trailing
 *      control char EXPOSES whitespace the trim must then take.
 *        "incomplete <ESC>" -> "incomplete", fused "incomplete "
 *   3. stripTerminalNoise's four stages. Deleting a control char can make two
 *      separated \r runs adjacent (collapsing to ONE \n), and stripping
 *      "[ \t]+\n" can join two \n runs that the \n{4,} cap then sees as one.
 *      That helper is therefore deliberately left at four passes.
 *
 * Items 1 and 2 are ENFORCED here -- fuse either and this file goes red.
 * Item 3 is NOT enforced and cannot be from this level: stripTerminalNoise
 * runs only downstream of the terminal accumulator, which already consumes
 * every \r and control char, making that fusion unobservable through the
 * exported API (verified by injecting it -- the suite stayed green). It is
 * kept unfused on correctness grounds, guarded only by the comment at its
 * definition. Treat that as a known coverage gap, not a covered case.
 */
import { describe, it, expect } from 'vitest';
import {
    sanitizeTerminalText,
    stripAnsi as currentSharedStripAnsi,
} from '../../src/cli-adapters/provider-cli-shared.js';
import {
    stripAnsi as currentParseStripAnsi,
    splitRawLines as currentSplitRawLines,
} from '../../src/providers/sdk/v1/builders/cli/parse-session.js';

// ─── Reference oracles: verbatim pre-optimization implementations ──────────

/* eslint-disable no-control-regex */
function referenceSharedStripAnsi(str: string): string {
    return str
        .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
        .replace(/\x1B[P^_X][\s\S]*?(?:\x07|\x1B\\)/g, '')
        .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

const REF_ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const REF_OSC_RE = /\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\|(?=\n|$))/g;
function referenceParseStripAnsi(text: string): string {
    return String(text || '')
        .replace(/\x1b\[(\d*)C/g, (_m, n) => ' '.repeat(Math.max(1, Number(n) || 1)))
        .replace(/\x1b\[\d*D/g, '')
        .replace(REF_ANSI_RE, '')
        .replace(REF_OSC_RE, '')
        .replace(/\x1b[P^_X][\s\S]*?(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b(?:[@-Z\\-_])/g, '');
}

function referenceSplitRawLines(text: string): Array<{ raw: string; text: string }> {
    return String(text || '')
        .split(/\r?\n/)
        .map(rawLine => ({
            raw: rawLine,
            text: referenceParseStripAnsi(rawLine).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\s+$/, ''),
        }));
}
/* eslint-enable no-control-regex */

// ─── Corpus ───────────────────────────────────────────────────────────────

const ESC = '\x1B';

const HAND_CASES: string[] = [
    '',
    'plain text with no escapes at all',
    // SGR
    `${ESC}[31mred${ESC}[0m`,
    `${ESC}[1;32;44mbold green on blue${ESC}[m`,
    `${ESC}[38;5;196m256-color${ESC}[0m`,
    `${ESC}[38;2;255;0;0mtruecolor${ESC}[0m`,
    // OSC
    `${ESC}]0;window title\x07after`,
    `${ESC}]8;;http://example.com${ESC}\\link${ESC}]8;;${ESC}\\`,
    // DCS / SOS / PM / APC
    `${ESC}Pdcs data${ESC}\\tail`,
    `${ESC}Xsos\x07x`,
    `${ESC}^pm\x07y`,
    `${ESC}_apc${ESC}\\z`,
    // cursor motion
    `a${ESC}[3Cb`,
    `a${ESC}[Cb`,
    `a${ESC}[0Cb`,
    `a${ESC}[5Db`,
    `a${ESC}[Db`,
    `${ESC}[2J${ESC}[H cleared`,
    `${ESC}7saved${ESC}8restored`,
    `${ESC}[?25l hidden ${ESC}[?25h`,
    // ── the ordering counterexamples these fusions must not break ──
    `x${ESC}[${ESC}[2Db`,
    `x${ESC}[${ESC}[3Cb`,
    `incomplete ${ESC}`,
    // incomplete / malformed — routine at PTY chunk boundaries
    `incomplete ${ESC}[`,
    `incomplete ${ESC}[31`,
    `unterminated ${ESC}]0;no-bel`,
    `unterminated ${ESC}Pdcs-forever`,
    // nesting + non-ASCII
    `${ESC}[31m${ESC}[1m${ESC}[4mnested${ESC}[0m`,
    `한글 ${ESC}[31m빨강${ESC}[0m 텍스트`,
    `emoji 🎉 ${ESC}[32m✅${ESC}[0m 🚀`,
    `combining é ${ESC}[1mx${ESC}[0m`,
    // whitespace / control chars
    `trailing spaces   ${ESC}[0m   `,
    `tab\there\tand ${ESC}[33mcolor${ESC}[0m`,
    'line1\r\nline2\rline3\nline4',
    '\x00\x01\x07bell\x7Fdel',
    '\n\n\n\n\n\nmany blanks\n\n\n\n',
    `${ESC}]0;t\x07${ESC}[31m${ESC}Pd${ESC}\\mix${ESC}[0m`,
    '⏺ assistant message line',
];

/** Deterministic fuzz: escape-dense strings that concentrate on boundaries. */
function fuzzCase(i: number): string {
    const bits = [
        'a', 'b', '한', '🎉',
        `${ESC}[31m`, `${ESC}[0m`, `${ESC}]0;t\x07`,
        `${ESC}[3C`, `${ESC}[2D`,
        ESC, `${ESC}[`, `${ESC}\\`,
        '\r', '\n', ' ', '\t', '\x07',
    ];
    let seed = (i * 2654435761) % 4294967296;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    let s = '';
    const len = 5 + (next() % 40);
    for (let k = 0; k < len; k += 1) s += bits[next() % bits.length];
    return s;
}

const CASES: string[] = [...HAND_CASES];
for (let i = 0; i < 4000; i += 1) CASES.push(fuzzCase(i));

// ─── Tests ────────────────────────────────────────────────────────────────

describe('stripAnsi optimization equivalence', () => {
    it('shared (cli-adapters) fast path matches the original three-pass chain', () => {
        const diffs = CASES.filter(c => currentSharedStripAnsi(c) !== referenceSharedStripAnsi(c));
        expect(diffs.map(d => JSON.stringify(d))).toEqual([]);
    });

    it('parse-session fast path matches the original six-pass chain', () => {
        const diffs = CASES.filter(c => currentParseStripAnsi(c) !== referenceParseStripAnsi(c));
        expect(diffs.map(d => JSON.stringify(d))).toEqual([]);
    });

    it('splitRawLines fast path matches the original per-line chain', () => {
        const diffs = CASES.filter(
            c => JSON.stringify(currentSplitRawLines(c)) !== JSON.stringify(referenceSplitRawLines(c)),
        );
        expect(diffs.map(d => JSON.stringify(d))).toEqual([]);
    });

    // Pin the specific counterexamples, so a regression names the reason it
    // broke instead of surfacing as one anonymous fuzz diff.
    it('keeps CSI stripping in a separate pass (dangling ESC[ is re-scanned)', () => {
        // parse-session has a dedicated ESC[<n>D pass ahead of the generic CSI
        // pass. It removes the "2D", after which the generic pass -- scanning
        // afresh -- matches the now-adjacent "ESC[" + "b". Fusing loses the "b".
        expect(currentParseStripAnsi(`x${ESC}[${ESC}[2Db`)).toBe('x');
        // The shared helper has no separate D pass, so its generic CSI pass
        // consumes "ESC[2D" directly and the dangling "ESC[" survives. Pinned
        // here to keep the two helpers' differing contracts explicit.
        expect(currentSharedStripAnsi(`x${ESC}[${ESC}[2Db`)).toBe(`x${ESC}[b`);
    });

    it('keeps control-strip and trailing-trim as ordered passes', () => {
        expect(currentSplitRawLines(`incomplete ${ESC}`)[0].text).toBe('incomplete');
    });

    it('renders cursor-forward as spaces, including the empty-parameter form', () => {
        expect(currentParseStripAnsi(`a${ESC}[3Cb`)).toBe('a   b');
        expect(currentParseStripAnsi(`a${ESC}[Cb`)).toBe('a b');
        expect(currentParseStripAnsi(`a${ESC}[0Cb`)).toBe('a b');
    });

    it('leaves escape-free text byte-identical (indexOf fast path)', () => {
        const plain = 'no escapes here, just text 한글 🎉\twith\ttabs';
        expect(currentSharedStripAnsi(plain)).toBe(plain);
        expect(currentParseStripAnsi(plain)).toBe(plain);
    });
});

describe('sanitizeTerminalText (exported, exercises the shared strip in situ)', () => {
    // Anchors the mirrored copies above to real shipping behavior: these run
    // through the actual module, not the test-local reimplementation.
    it('strips SGR while preserving visible text', () => {
        expect(sanitizeTerminalText(`${ESC}[31mhello${ESC}[0m world`)).toBe('hello world');
    });

    it('strips OSC title sequences', () => {
        expect(sanitizeTerminalText(`${ESC}]0;title\x07body`)).toBe('body');
    });

    it('preserves non-ASCII content', () => {
        expect(sanitizeTerminalText(`${ESC}[1m한글${ESC}[0m 🎉`)).toBe('한글 🎉');
    });

    it('collapses runs of blank lines', () => {
        // stripTerminalNoise's \n{4,} cap, reached through the real pipeline.
        //
        // NOTE this does NOT guard the pass-chaining inside stripTerminalNoise.
        // That helper's \r and control-char stages are unreachable from here:
        // the accumulator runs first and consumes every \r as cursor motion and
        // drops control chars, so it never emits either. Fusing those stages
        // was measured to be UNOBSERVABLE through this, the helper's only
        // caller. They are kept unfused on correctness grounds (documented at
        // the definition), not because this test would catch it -- claiming
        // otherwise would be a false guarantee.
        expect(sanitizeTerminalText('a\n\n \n\nb')).toBe('a\n\n\nb');
        expect(sanitizeTerminalText('x\n\n\n\n\n\ny')).toBe('x\n\n\ny');
    });

    it('applies carriage-return overwrite before any noise stripping', () => {
        // sanitizeTerminalText runs the terminal accumulator FIRST, so \r is a
        // real cursor-to-column-0 -- "b" overwrites "a" rather than landing on
        // a second line. (stripTerminalNoise's own \r handling only sees CRs
        // the accumulator left behind.)
        expect(sanitizeTerminalText('a\r\x00\rb')).toBe('b');
        expect(sanitizeTerminalText('progress 1%\rprogress 100%')).toBe('progress 100%');
    });
});
