// Native viewport / cursor / cell-read API (API level 2).
//
// The central assertion throughout is that the row a snapshot returns at
// `cursorRow` is the physical row the cursor sits on: writing a marker at the
// cursor must show up in that same row. Row numbers found by searching
// formatter output are never treated as cursor coordinates.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LEGACY_CASES, codexCapture, runLegacyCase } from './fixtures/legacy-cases.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const binding = createRequire(import.meta.url)(join(testDir, '..', 'index.js'));

function withTerminal(options, fn) {
    const terminal = binding.createTerminal(options);
    try {
        return fn(terminal);
    } finally {
        terminal.dispose();
    }
}

function replayCodex(terminal) {
    const capture = codexCapture();
    for (const phase of ['phase1_trust', 'phase2_after_approve']) {
        for (const chunk of capture[phase]) terminal.write(chunk.data);
    }
}

const cursorLine = (terminal) => terminal.getViewport({ includeRows: 'cursor', cells: true });

describe('binding surface', () => {
    it('reports API level 2 with an embedded source digest and the pinned ghostty revision', () => {
        assert.equal(binding.capabilities.viewport, true);
        assert.equal(binding.bindingInfo.apiLevel, 2);
        assert.match(binding.bindingInfo.sourceDigest, /^[0-9a-f]{64}$/);
        assert.equal(binding.bindingInfo.ghosttyRevision, 'd4a38c8661453026bd1b1bb022ba2c37b347adce');
    });
});

describe('real Codex 80x32 capture', () => {
    it('fixture is the capture the design replayed, de-identified at equal width', () => {
        // The original capture (sha256 42b8e949…) differs only in the home
        // directory in the trust modal, replaced by a same-length placeholder
        // so every ANSI position is unchanged.
        const bytes = readFileSync(join(testDir, 'fixtures', 'codex-trust-modal-2026-09-19.json'));
        assert.equal(createHash('sha256').update(bytes).digest('hex'), '5a3f822fd8af288e70adb8ad536b4f917c01bdf44d9399daded45e23302f2690');
    });

    it('cursor row 25 is the composer row in ACTIVE space; scrollbar is 33/1/32', () => {
        withTerminal({ cols: 80, rows: 32, scrollback: 2000 }, (terminal) => {
            replayCodex(terminal);
            const view = cursorLine(terminal);
            assert.equal(view.coordinateSpace, 'active');
            assert.equal(view.cursorRow, 25);
            assert.equal(view.cursorCol, 2);
            assert.equal(view.activeScreen, 'primary');
            assert.deepEqual(view.scrollbar, { total: 33, offset: 1, len: 32 });
            assert.equal(view.scrollbackRows, 1);
            assert.equal(view.activeOriginRow, 1);
            assert.equal(view.viewportScrollbackOffset, 0);
            assert.equal(view.cursorViewportRow, 25);
            assert.equal(view.lines.length, 1);
            assert.equal(view.lines[0].row, 25);
            assert.equal(view.lines[0].text, '› Ask Codex to do anything');
            assert.equal(view.lines[0].cells.length, 80);
            assert.equal(view.lines[0].cells[2].text, 'A');
            // The same row from the full snapshot and from readRow agrees.
            const all = terminal.getViewport({ includeRows: 'all' });
            assert.equal(all.lines.length, 32);
            assert.equal(all.lines[25].text, view.lines[0].text);
            assert.equal(terminal.readRow(25, { expectedRevision: view.revision }).text, view.lines[0].text);
        });
    });

    it('a marker written at the cursor lands in the row the snapshot returned', () => {
        withTerminal({ cols: 80, rows: 32, scrollback: 2000 }, (terminal) => {
            replayCodex(terminal);
            const before = cursorLine(terminal);
            terminal.write('Z');
            const after = cursorLine(terminal);
            assert.equal(after.cursorRow, before.cursorRow);
            assert.equal(after.cursorCol, 3);
            assert.equal(after.lines[0].text, '› Zsk Codex to do anything');
            assert.equal(after.lines[0].cells[2].text, 'Z');
            assert.ok(after.revision > before.revision);
            // The legacy full-screen formatter is SCREEN-origin: the same
            // physical row sits at activeOriginRow + cursorRow there.
            const legacy = terminal.formatPlainText({ trim: false }).split('\n');
            assert.equal(legacy[after.activeOriginRow + after.cursorRow], '› Zsk Codex to do anything');
            assert.notEqual(legacy[after.cursorRow], '› Zsk Codex to do anything');
        });
    });

    it('combined DEC reset (?1049;2004l) returns to primary with an exact, readable cursor row', () => {
        // Supersedes the round5 contract (exact read revoked -> null): with the
        // native active-screen getter the primary row is readable again.
        withTerminal({ cols: 80, rows: 32, scrollback: 2000 }, (terminal) => {
            replayCodex(terminal);
            const before = terminal.getCursorPosition();
            terminal.write('\x1b[?1049hALT');
            const alt = cursorLine(terminal);
            assert.equal(alt.activeScreen, 'alternate');
            assert.deepEqual(alt.scrollbar, { total: 32, offset: 0, len: 32 });
            // 1049 saves the cursor and keeps its position, so ALT prints at col 2.
            assert.equal(alt.cursorRow, 25);
            assert.equal(alt.lines[0].text, '  ALT');
            assert.equal(alt.lines[0].cells[2].text, 'A');
            terminal.write('\x1b[?1049;2004l');
            const back = cursorLine(terminal);
            assert.equal(back.activeScreen, 'primary');
            assert.deepEqual(terminal.getCursorPosition(), before);
            assert.equal(back.lines[0].text, '› Ask Codex to do anything');
            terminal.write('Z');
            assert.equal(cursorLine(terminal).lines[0].text, '› Zsk Codex to do anything');
        });
    });
});

describe('cells: width, spacers, graphemes', () => {
    it('CJK lead is wide with a spacer tail; combining marks stay in their base cell', () => {
        withTerminal({ cols: 20, rows: 2, scrollback: 0 }, (terminal) => {
            terminal.write('A한éx');
            const row = terminal.readRow(0, { cells: true });
            assert.equal(row.text, 'A한éx');
            assert.deepEqual(row.cells.slice(0, 5), [
                { col: 0, text: 'A', width: 1, wideKind: 'narrow' },
                { col: 1, text: '한', width: 2, wideKind: 'wide' },
                { col: 2, text: '', width: 0, wideKind: 'spacer-tail' },
                { col: 3, text: 'é', width: 1, wideKind: 'narrow' },
                { col: 4, text: 'x', width: 1, wideKind: 'narrow' },
            ]);
            assert.equal(row.cells.length, 20);
            assert.equal(terminal.getViewport().cursorCol, 5);
        });
    });

    it('mode 2027 off: a ZWJ sequence occupies two wide cells as stored natively', () => {
        withTerminal({ cols: 20, rows: 2, scrollback: 0 }, (terminal) => {
            terminal.write('👩‍💻');
            const row = terminal.readRow(0, { cells: true });
            assert.equal(row.text, '👩‍💻');
            assert.deepEqual(row.cells.slice(0, 4), [
                { col: 0, text: '👩‍', width: 2, wideKind: 'wide' },
                { col: 1, text: '', width: 0, wideKind: 'spacer-tail' },
                { col: 2, text: '💻', width: 2, wideKind: 'wide' },
                { col: 3, text: '', width: 0, wideKind: 'spacer-tail' },
            ]);
            assert.equal(terminal.getViewport().cursorCol, 4);
        });
    });

    it('mode 2027 on: the same ZWJ sequence is one wide grapheme cell', () => {
        withTerminal({ cols: 20, rows: 2, scrollback: 0 }, (terminal) => {
            terminal.write('\x1b[?2027h👩‍💻');
            const row = terminal.readRow(0, { cells: true });
            assert.equal(row.text, '👩‍💻');
            assert.deepEqual(row.cells.slice(0, 3), [
                { col: 0, text: '👩‍💻', width: 2, wideKind: 'wide' },
                { col: 1, text: '', width: 0, wideKind: 'spacer-tail' },
                { col: 2, text: '', width: 1, wideKind: 'narrow' },
            ]);
            assert.equal(terminal.getViewport().cursorCol, 2);
        });
    });

    it('a wide char that does not fit at the right margin leaves a spacer head and wraps', () => {
        withTerminal({ cols: 4, rows: 3, scrollback: 0 }, (terminal) => {
            terminal.write('abc한');
            const view = terminal.getViewport({ includeRows: 'all', cells: true });
            assert.equal(view.lines[0].text, 'abc');
            assert.equal(view.lines[0].cells[3].wideKind, 'spacer-head');
            assert.equal(view.lines[0].wrapped, true);
            assert.equal(view.lines[1].text, '한');
            assert.equal(view.lines[1].wrapContinuation, true);
        });
    });

    it('cursor-forward gaps read as spaces; only the trailing empty run is dropped', () => {
        withTerminal({ cols: 16, rows: 2, scrollback: 0 }, (terminal) => {
            terminal.write('a\x1b[3Cb  ');
            const row = terminal.readRow(0, { cells: true });
            // Explicitly printed trailing spaces are content and are kept.
            assert.equal(row.text, 'a   b  ');
            assert.equal(row.cells[1].text, '');
            assert.equal(row.cells[5].text, ' ');
            assert.equal(terminal.readRow(1).text, '');
        });
    });
});

describe('soft wrap and pending wrap', () => {
    it('distinguishes the wrapping row from its continuation', () => {
        withTerminal({ cols: 4, rows: 4, scrollback: 0 }, (terminal) => {
            terminal.write('abcde');
            const view = terminal.getViewport({ includeRows: 'all' });
            assert.deepEqual(view.lines.slice(0, 2).map(({ text, wrapped, wrapContinuation }) => ({ text, wrapped, wrapContinuation })), [
                { text: 'abcd', wrapped: true, wrapContinuation: false },
                { text: 'e', wrapped: false, wrapContinuation: true },
            ]);
            assert.equal(view.cursorRow, 1);
            assert.equal(view.cursorCol, 1);
        });
    });

    it('reports pending wrap at the last column without advancing the cursor', () => {
        withTerminal({ cols: 4, rows: 4, scrollback: 0 }, (terminal) => {
            terminal.write('abcd');
            const view = terminal.getViewport();
            assert.equal(view.cursorPendingWrap, true);
            assert.equal(view.cursorRow, 0);
            assert.equal(view.cursorCol, 3);
            assert.equal(terminal.readRow(0).wrapped, false);
        });
    });
});

describe('scrollback vs scrolled VIEWPORT', () => {
    it('ACTIVE rows do not move when the viewport scrolls into history', () => {
        withTerminal({ cols: 12, rows: 4, scrollback: 100000 }, (terminal) => {
            terminal.write('old\r\n'.repeat(40) + '> FINAL');
            const bottom = terminal.getViewport({ includeRows: 'all' });
            assert.deepEqual(bottom.scrollbar, { total: 41, offset: 37, len: 4 });
            assert.equal(bottom.scrollbackRows, 37);
            assert.equal(bottom.cursorRow, 3);
            assert.equal(bottom.cursorViewportRow, 3);
            assert.equal(bottom.lines[3].text, '> FINAL');

            terminal.scrollViewport('top');
            const top = terminal.getViewport({ includeRows: 'all' });
            assert.deepEqual(top.scrollbar, { total: 41, offset: 0, len: 4 });
            assert.equal(top.viewportOriginRow, 0);
            assert.equal(top.viewportScrollbackOffset, 37);
            assert.equal(top.cursorRow, 3);
            assert.equal(top.cursorViewportRow, null);
            assert.equal(top.lines[3].text, '> FINAL');
            assert.equal(terminal.readRow(3).text, '> FINAL');
            const viewportRow = terminal.readRow(3, { space: 'viewport' });
            assert.equal(viewportRow.coordinateSpace, 'viewport');
            assert.equal(viewportRow.text, 'old');

            terminal.scrollViewport('bottom');
            assert.equal(terminal.getViewport().cursorViewportRow, 3);
            // One row up: the cursor's row leaves the viewport, ACTIVE is unchanged.
            terminal.scrollViewport(-1);
            const oneUp = terminal.getViewport({ includeRows: 'cursor' });
            assert.equal(oneUp.viewportScrollbackOffset, 1);
            assert.equal(oneUp.cursorViewportRow, null);
            assert.equal(oneUp.lines[0].text, '> FINAL');
            assert.equal(terminal.readRow(3, { space: 'viewport' }).text, 'old');
        });
    });

    it('max_scrollback 0 keeps no history', () => {
        withTerminal({ cols: 12, rows: 4, scrollback: 0 }, (terminal) => {
            terminal.write('old\r\n'.repeat(40) + '> FINAL');
            const view = terminal.getViewport({ includeRows: 'cursor' });
            assert.deepEqual(view.scrollbar, { total: 4, offset: 0, len: 4 });
            assert.equal(view.scrollbackRows, 0);
            assert.equal(view.lines[0].text, '> FINAL');
        });
    });
});

describe('screen modes and resets', () => {
    it('alternate screen is reported natively and has no history', () => {
        withTerminal({ cols: 12, rows: 4, scrollback: 1000 }, (terminal) => {
            terminal.write('primary\r\n'.repeat(6));
            terminal.write('\x1b[?1049h\x1b[2;3HALT');
            const alt = cursorLine(terminal);
            assert.equal(alt.activeScreen, 'alternate');
            assert.deepEqual(alt.scrollbar, { total: 4, offset: 0, len: 4 });
            assert.equal(alt.cursorRow, 1);
            assert.equal(alt.lines[0].text, '  ALT');
            terminal.write('\x1b[?1049l');
            const primary = terminal.getViewport();
            assert.equal(primary.activeScreen, 'primary');
            assert.ok(primary.scrollbackRows > 0);
        });
    });

    it('RIS (ESC c) clears the screen, homes the cursor and bumps the revision', () => {
        withTerminal({ cols: 12, rows: 4, scrollback: 1000 }, (terminal) => {
            terminal.write('\x1b[?1049hbefore\r\nmore');
            const before = terminal.getViewport();
            terminal.write('\x1bc');
            const reset = terminal.getViewport({ includeRows: 'all' });
            assert.ok(reset.revision > before.revision);
            assert.equal(reset.activeScreen, 'primary');
            assert.equal(reset.cursorRow, 0);
            assert.equal(reset.cursorCol, 0);
            assert.deepEqual(reset.lines.map((line) => line.text), ['', '', '', '']);
            terminal.write('after');
            assert.equal(cursorLine(terminal).lines[0].text, 'after');
        });
    });

    it('scroll region + DECOM: cursor row is absolute ACTIVE, region content scrolls inside its margins', () => {
        withTerminal({ cols: 8, rows: 6, scrollback: 0 }, (terminal) => {
            // Margins rows 2..5 (1-based), origin mode on, CUP(3,1) is region-relative.
            terminal.write('\x1b[1;1HTOP\x1b[6;1HBOTTOM\x1b[2;5r\x1b[?6h\x1b[3;1HY');
            const placed = terminal.getViewport({ includeRows: 'all' });
            assert.equal(placed.cursorRow, 3);
            assert.equal(placed.lines[3].text, 'Y');
            terminal.write('\r\n\r\n\r\nW');
            const scrolled = terminal.getViewport({ includeRows: 'all' });
            assert.equal(scrolled.cursorRow, 4);
            assert.equal(scrolled.lines[scrolled.cursorRow].text, 'W');
            assert.equal(scrolled.lines[0].text, 'TOP');
            assert.equal(scrolled.lines[5].text, 'BOTTOM');
            // Three line feeds from row 3: one reaches the region bottom (row 4),
            // two scroll the region, so Y moved up from row 3 to row 1.
            assert.equal(scrolled.lines[1].text, 'Y');
        });
    });

    it('resize is reflected in the same snapshot as the cursor', () => {
        withTerminal({ cols: 10, rows: 4, scrollback: 1000 }, (terminal) => {
            terminal.write('0123456789');
            const before = terminal.getViewport();
            terminal.resize(5, 6);
            const after = terminal.getViewport({ includeRows: 'all' });
            assert.ok(after.revision > before.revision);
            assert.equal(after.cols, 5);
            assert.equal(after.rows, 6);
            assert.equal(after.lines.length, 6);
            assert.ok(after.cursorRow < after.rows && after.cursorCol < after.cols);
        });
    });
});

describe('errors are explicit, never an empty success', () => {
    it('rejects out-of-range, fractional and non-numeric rows', () => {
        withTerminal({ cols: 8, rows: 3, scrollback: 0 }, (terminal) => {
            for (const row of [3, -1, 1.5, Number.NaN, 70000]) {
                assert.throws(() => terminal.readRow(row), (error) => error instanceof RangeError && error.code === 'ERR_GHOSTTY_ROW_OUT_OF_RANGE', String(row));
            }
            assert.throws(() => terminal.readRow('1'), TypeError);
            assert.throws(() => terminal.readRow(0, { space: 'screen' }), TypeError);
            assert.throws(() => terminal.getViewport({ includeRows: 'some' }), TypeError);
            assert.throws(() => terminal.getViewport({ cells: 1 }), TypeError);
            assert.throws(() => terminal.scrollViewport('middle'), TypeError);
        });
    });

    it('rejects a stale expectedRevision', () => {
        withTerminal({ cols: 8, rows: 3, scrollback: 0 }, (terminal) => {
            const { revision } = terminal.getViewport();
            terminal.write('x');
            assert.throws(() => terminal.readRow(0, { expectedRevision: revision }), { code: 'ERR_GHOSTTY_STALE_REVISION' });
            assert.equal(terminal.readRow(0, { expectedRevision: revision + 1 }).text, 'x');
        });
    });

    it('throws after dispose', () => {
        const terminal = binding.createTerminal({ cols: 8, rows: 3, scrollback: 0 });
        terminal.dispose();
        assert.throws(() => terminal.getViewport(), /disposed/);
        assert.throws(() => terminal.readRow(0), /disposed/);
    });
});

describe('legacy formatter outputs stay byte-identical', () => {
    const golden = JSON.parse(readFileSync(join(testDir, 'fixtures', 'legacy-golden.json'), 'utf8'));

    it('golden covers every case and was produced by the pre-viewport binary', () => {
        assert.match(golden.generatedBy, /^api level 1,/);
        assert.deepEqual(Object.keys(golden.cases).sort(), LEGACY_CASES.map((testCase) => testCase.name).sort());
    });

    for (const testCase of LEGACY_CASES) {
        it(testCase.name, () => {
            assert.deepEqual(runLegacyCase(binding, testCase), golden.cases[testCase.name]);
        });
    }
});
