/**
 * Regression coverage for alternate-screen viewport collapse.
 *
 * Root cause this locks down: the alternate screen buffer accumulates no
 * scrollback, and ghostty drops trailing blank rows when formatting it. So a
 * frame sampled mid-repaint — after an erase-display but before the TUI has
 * repainted the rest — came back as only the rows that happened to be painted.
 * trimBlankEnds() then stripped the blank margin too, collapsing a 32-row
 * viewport to a few bytes (observed live: 3 bytes for a lone spinner, 10 bytes
 * for a partial word).
 *
 * Why it mattered beyond rendering: agy's spec declares `anchor_miss: "empty"`
 * on its modal section, and its busy->idle edge is written as
 * `not(modal matches ...)`. A collapsed capture drops the anchor line, the
 * modal section resolves to empty, and the negated edge reads that emptiness as
 * "no modal" — so an on-screen approval prompt was reported idle and
 * mesh_approve answered `already_resolved`.
 *
 * The second describe block is the guard rail for the other six CLI providers:
 * none of them enter the alternate screen, so their capture bytes must be
 * IDENTICAL before and after this fix. Those assertions are deliberately
 * byte-exact rather than shape-based — a loosened assertion here would let a
 * future change to the alt-screen path silently reshape every other provider's
 * input.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { GhosttyVtTerminalBackend } from '../../src/cli-adapters/terminal-backends/ghostty-vt-backend.js';

const ROWS = 32;
const COLS = 80;

function makeBackend(rows = ROWS) {
    return new GhosttyVtTerminalBackend({ rows, cols: COLS, scrollback: 1000 });
}

let bindingAvailable = true;

beforeAll(() => {
    try {
        makeBackend().dispose();
    } catch {
        // A platform-arch with no committed prebuilt (e.g. darwin-x64) falls
        // through to a source compile. Skip rather than fail: this suite is
        // about viewport framing, not binding availability, which
        // ghostty-vt-backend-load-retry.test.ts already covers.
        bindingAvailable = false;
    }
});

const ENTER_ALT = '\x1b[?1049h';
const LEAVE_ALT = '\x1b[?1049l';
const ERASE_DISPLAY_HOME = '\x1b[2J\x1b[H';

describe('alternate screen partial frames', () => {
    it('does not collapse a mid-repaint spinner frame to a few bytes', () => {
        if (!bindingAvailable) return;
        const backend = makeBackend();
        try {
            backend.write(ENTER_ALT);
            for (let i = 0; i < 20; i += 1) backend.write(`frame content line ${i}\r\n`);
            // The TUI erases and has only painted the spinner so far.
            backend.write(ERASE_DISPLAY_HOME);
            backend.write('⣿');

            const text = backend.getText();
            // Pre-fix this was exactly 3 bytes ("⣿" alone).
            expect(Buffer.byteLength(text)).toBeGreaterThan(3);
            expect(text.split('\n')).toHaveLength(ROWS);
            expect(text).toContain('⣿');
        } finally {
            backend.dispose();
        }
    });

    it('preserves the row offset a modal was drawn at', () => {
        if (!bindingAvailable) return;
        const backend = makeBackend();
        try {
            backend.write(ENTER_ALT + ERASE_DISPLAY_HOME);
            // agy draws its approval box partway down the screen; the leading
            // blank rows are what trimBlankEnds used to discard.
            backend.write('\x1b[10;1HDo you want to proceed?');
            backend.write('\x1b[12;1H> 1. Yes');
            backend.write('\x1b[13;1H  2. No');

            const lines = backend.getText().split('\n');
            expect(lines).toHaveLength(ROWS);
            // Row indices are 1-based in the escape sequence, 0-based here.
            expect(lines[9]).toContain('Do you want to proceed?');
            expect(lines[11]).toContain('> 1. Yes');
            expect(lines[12]).toContain('  2. No');
        } finally {
            backend.dispose();
        }
    });

    it('keeps the modal anchor visible so a negated busy->idle edge cannot misfire', () => {
        if (!bindingAvailable) return;
        const backend = makeBackend();
        try {
            backend.write(ENTER_ALT + ERASE_DISPLAY_HOME);
            backend.write('\x1b[14;1HDo you want to proceed?');

            // The exact shape agy's spec negates. Pre-fix the capture still
            // contained this string, but a spinner-only sample did not — and
            // that sample is what the 80ms debounce lands on.
            expect(backend.getText()).toContain('Do you want to proceed?');
            expect(backend.getTextWithScrollback()).toContain('Do you want to proceed?');
        } finally {
            backend.dispose();
        }
    });

    it('applies the same framing to getTextWithScrollback (alt screen has no scrollback)', () => {
        if (!bindingAvailable) return;
        const backend = makeBackend();
        try {
            backend.write(ENTER_ALT + ERASE_DISPLAY_HOME);
            backend.write('⣿');

            const text = backend.getTextWithScrollback();
            expect(Buffer.byteLength(text)).toBeGreaterThan(3);
            expect(text.split('\n')).toHaveLength(ROWS);
        } finally {
            backend.dispose();
        }
    });

    it('tracks the mode change when the escape sequence is split across writes', () => {
        if (!bindingAvailable) return;
        const backend = makeBackend();
        try {
            // PTY reads chunk at arbitrary offsets; scanning each chunk alone
            // would miss this and leave the viewport collapsing.
            backend.write('\x1b[?10');
            backend.write('49h');
            backend.write(ERASE_DISPLAY_HOME);
            backend.write('⣿');

            expect(backend.getText().split('\n')).toHaveLength(ROWS);
        } finally {
            backend.dispose();
        }
    });

    it('reverts to normal-screen framing after leaving the alternate screen', () => {
        if (!bindingAvailable) return;
        const backend = makeBackend();
        try {
            backend.write('normal line a\r\nnormal line b\r\n');
            backend.write(ENTER_ALT + ERASE_DISPLAY_HOME + 'alt content');
            expect(backend.getText().split('\n')).toHaveLength(ROWS);

            backend.write(LEAVE_ALT);
            // Back on the normal screen the blank margin is collapsed again.
            expect(backend.getText()).toBe('normal line a\nnormal line b');
        } finally {
            backend.dispose();
        }
    });

    it('honours a resize when framing a partial alternate-screen frame', () => {
        if (!bindingAvailable) return;
        const backend = makeBackend();
        try {
            backend.write(ENTER_ALT + ERASE_DISPLAY_HOME + '⣿');
            backend.resize(24, COLS);
            expect(backend.getText().split('\n')).toHaveLength(24);
        } finally {
            backend.dispose();
        }
    });
});

describe('normal screen output is byte-identical (guard for non-alt-screen providers)', () => {
    // claude, codex, cursor, grok, kimi and opencode never enter the alternate
    // screen. These are the exact bytes they matched against before the fix.
    const cases: Array<{ name: string; script: (b: GhosttyVtTerminalBackend) => void; expected: string }> = [
        {
            name: 'short output',
            script: b => {
                for (let i = 0; i < 5; i += 1) b.write(`line ${i}\r\n`);
            },
            expected: ['line 0', 'line 1', 'line 2', 'line 3', 'line 4'].join('\n'),
        },
        {
            name: 'leading blank rows are still collapsed',
            script: b => b.write('\r\n\r\n\r\nhello\r\n'),
            expected: 'hello',
        },
        {
            name: 'output taller than the viewport is sliced to the last rows',
            script: b => {
                for (let i = 0; i < 40; i += 1) b.write(`line ${i}\r\n`);
            },
            // 40 lines written, viewport is 32 -> lines 8..39.
            expected: Array.from({ length: ROWS }, (_, i) => `line ${i + 8}`).join('\n'),
        },
        {
            name: 'a bare spinner is left untouched on the normal screen',
            script: b => b.write('⣿'),
            expected: '⣿',
        },
    ];

    for (const { name, script, expected } of cases) {
        it(name, () => {
            if (!bindingAvailable) return;
            const backend = makeBackend();
            try {
                script(backend);
                expect(backend.getText()).toBe(expected);
            } finally {
                backend.dispose();
            }
        });
    }

    it('getTextWithScrollback still returns history above the viewport', () => {
        if (!bindingAvailable) return;
        const backend = makeBackend();
        try {
            for (let i = 0; i < 40; i += 1) backend.write(`line ${i}\r\n`);
            const withScrollback = backend.getTextWithScrollback();
            expect(withScrollback.split('\n')).toHaveLength(40);
            expect(withScrollback).toContain('line 0');
            expect(backend.getText()).not.toContain('line 0');
        } finally {
            backend.dispose();
        }
    });
});
