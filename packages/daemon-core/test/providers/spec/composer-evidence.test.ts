/**
 * composer-evidence — the four-state read of a CLI's input row, driven through
 * the real VT and its native exact cursor-row read (TerminalScreen.getCursorRow
 * → ghostty getViewport). Reviews d75636d6 F2/F3, 9719d681 R3-2, f8c79690 R4-3:
 * no formatter output, scrollback offset or bottom-rows guess is ever used.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TerminalScreen } from '../../../src/cli-adapters/terminal-screen.js';
import { classifyRender, isStrictPrefixOf, readComposer, sameVisibleRow, type ComposerScreen } from '../../../src/providers/spec/composer-evidence.js';
import { SubmitVerdictMachine, UNSUBMITTED_HOLD_MS, CLEAR_STEP_MS, CLEAR_SETTLE_MS } from '../../../src/providers/spec/submit-verdict.js';

const ALT = '\x1b[?1049h';

function vtScreen(rows = 40, cols = 120): { vt: TerminalScreen; screen: ComposerScreen } {
    const vt = new TerminalScreen(rows, cols);
    return { vt, screen: { getCursorRow: () => vt.getCursorRow() } };
}

const fixtures = path.resolve('test/providers/spec/fixtures');

describe('getCursorRow — the native cursor row, on either screen', () => {
    it('recorded Codex frame (normal screen, scrollback + dropped blank rows — the formatter could not be indexed, review 9719d681 R3-2): the native row is the cursor\'s own; the placeholder right of the cursor makes it unknown', () => {
        // The sanitized live capture ghostty-vt-node's viewport tests replay.
        const cap = JSON.parse(fs.readFileSync(path.resolve('../ghostty-vt-node/test/fixtures/codex-trust-modal-2026-09-19.json'), 'utf8'));
        const { vt, screen } = vtScreen(cap.rows, cap.cols);
        try {
            for (const phase of ['phase1_trust', 'phase2_after_approve']) for (const chunk of cap[phase]) vt.write(chunk.data);
            const row = vt.getCursorRow();
            expect(row).not.toBeNull();
            expect(row!.row).toBe(vt.getCursorPosition().row);
            expect(row!.right).toContain('Ask Codex to do anything');
            // Unknown, never `empty`: a dispatch never owns a composer it cannot read cleanly.
            expect(readComposer(screen)).toEqual({ kind: 'unknown' });
        } finally { vt.dispose(); }
    });

    it('normal screen with scrollback: the row is exact (a char written at the cursor lands on the row read)', () => {
        const { vt } = vtScreen(10, 60);
        try {
            vt.write('history\r\n'.repeat(40) + '> ab');
            const before = vt.getCursorRow()!;
            expect(before.left).toBe('> ab');
            vt.write('Z');
            const after = vt.getCursorRow()!;
            expect(after.row).toBe(before.row);
            expect(after.left).toBe('> abZ');
        } finally { vt.dispose(); }
    });

    it('review f8c79690 R4_COMBINED_MODE: CSI ?1049h then the compound CSI ?1049;2004l — the read follows the primary screen', () => {
        const { vt, screen } = vtScreen(10, 60);
        try {
            vt.write('\x1b[3;1H> primary draft');
            vt.write(`${ALT}\x1b[5;1H> [Pasted text #1 +4 lines]`);
            expect(readComposer(screen)).toMatchObject({ kind: 'chip', row: 4 });
            vt.write('\x1b[?1049;2004l');
            expect(readComposer(screen)).toMatchObject({ kind: 'text', text: 'primary draft' });
        } finally { vt.dispose(); }
    });

    it('wide characters: the cursor column splits the cells, not the UTF-16 string', () => {
        const { vt, screen } = vtScreen(10, 60);
        try {
            vt.write(`${ALT}\x1b[5;1H> 한글 초안`);
            expect(readComposer(screen)).toMatchObject({ kind: 'text', row: 4, text: '한글 초안' });
        } finally { vt.dispose(); }
    });

    it('a soft-wrapped row (a line wider than the screen) is not one we can attribute — null', () => {
        const { vt, screen } = vtScreen(10, 20);
        try {
            vt.write(`${ALT}\x1b[5;1H> ` + 'x'.repeat(30));
            expect(vt.getCursorRow()).toBeNull();
            expect(readComposer(screen)).toEqual({ kind: 'unknown' });
        } finally { vt.dispose(); }
    });
});

describe('readComposer — four states, never a boolean read both ways', () => {
    it('a chip-only input row with the cursor at its end is `chip`; an image chip too', () => {
        const { vt, screen } = vtScreen();
        try {
            vt.write(`${ALT}\x1b[39;1H│ > [Pasted text #1 +40 lines]\x1b[s                 │\x1b[u`);
            expect(readComposer(screen)).toMatchObject({ kind: 'chip', row: 38, text: '[Pasted text #1 +40 lines]' });
            vt.write('\x1b[2K\r> [Image #2]');
            expect(readComposer(screen)).toMatchObject({ kind: 'chip', text: '[Image #2]' });
        } finally { vt.dispose(); }
    });

    it('F2 (reviewer ROW_FALSE_OWNERSHIP): a draft ending in the body\'s tail is text, and not the body', () => {
        const { vt, screen } = vtScreen();
        try {
            vt.write(`${ALT}\x1b[39;1H> my own note, carefully.`);
            const read = readComposer(screen);
            expect(read).toMatchObject({ kind: 'text' });
            expect(classifyRender(read, 'do the thing, carefully.')).toBe('foreign');
            expect(classifyRender(read, 'my own note, carefully.')).toBe('own_literal');
        } finally { vt.dispose(); }
    });

    it('F2 (reviewer WINDOW_FALSE_OWNERSHIP): a chip in a transcript row above an empty prompt is not the input row', () => {
        const { vt, screen } = vtScreen();
        try {
            vt.write(`${ALT}\x1b[10;1H> [Pasted text #3 +12 lines]\x1b[39;1H> `);
            expect(readComposer(screen)).toMatchObject({ kind: 'empty', row: 38 });
        } finally { vt.dispose(); }
    });

    it('a cursor that does not sit at the end of the row\'s content is `unknown` (mid-edit)', () => {
        const { vt, screen } = vtScreen();
        try {
            vt.write(`${ALT}\x1b[39;1H> [Pasted text #1 +40 lines]\x1b[39;5H`);
            expect(readComposer(screen)).toEqual({ kind: 'unknown' });
        } finally { vt.dispose(); }
    });

    it('a row without a prompt glyph is `unknown`, not empty', () => {
        const { vt, screen } = vtScreen();
        try {
            vt.write(`${ALT}\x1b[39;1H   `);
            expect(readComposer(screen)).toEqual({ kind: 'unknown' });
            vt.write('\x1b[2K\r? for shortcuts');
            expect(readComposer(screen)).toEqual({ kind: 'unknown' });
        } finally { vt.dispose(); }
    });

    it('trailing blanks left of the cursor are part of the read (a DEL of a space is a visible change)', () => {
        const { vt, screen } = vtScreen();
        try {
            vt.write(`${ALT}\x1b[39;1H> [Pasted text #1 +40 `);
            const a = readComposer(screen);
            vt.write('\x08\x1b[K');
            const b = readComposer(screen);
            expect(a).toMatchObject({ kind: 'text', text: '[Pasted text #1 +40 ' });
            expect(b).toMatchObject({ kind: 'text', text: '[Pasted text #1 +40' });
            expect(isStrictPrefixOf((b as { text: string }).text, (a as { text: string }).text)).toBe(true);
        } finally { vt.dispose(); }
    });

    it('F3: any read failure is `unknown`', () => {
        expect(readComposer({ getCursorRow: () => { throw new Error('gone'); } })).toEqual({ kind: 'unknown' });
        expect(readComposer({ getCursorRow: () => null })).toEqual({ kind: 'unknown' });
        expect(readComposer({})).toEqual({ kind: 'unknown' });
    });

    it('isStrictPrefixOf: only characters removed from the end', () => {
        expect(isStrictPrefixOf('abc', 'abcd')).toBe(true);
        expect(isStrictPrefixOf('abcd', 'abcd')).toBe(false);
        expect(isStrictPrefixOf('abX', 'abcd')).toBe(false);
        expect(isStrictPrefixOf('', 'a')).toBe(true);
    });

    for (const [provider, file] of [
        ['claude', 'claude-background-shell-finished-2026-10-18.txt'],
        ['antigravity', 'antigravity-background-task-finished-2026-10-18.txt'],
    ] as const) {
        it(`${provider} captured idle screen: the prompt row reads empty; a chip written there reads as a chip on the same row`, () => {
            const lines = fs.readFileSync(path.join(fixtures, file), 'utf8').trimEnd().split('\n');
            const prompt = lines.findLastIndex((x) => /^\s*[❯›>]\s*$/.test(x));
            expect(prompt).toBeGreaterThanOrEqual(0);
            const { vt, screen } = vtScreen(60, 120);
            try {
                vt.write(`${ALT}\x1b[2J\x1b[H` + lines.join('\r\n') + `\x1b[${prompt + 1};3H`);
                expect(readComposer(screen)).toMatchObject({ kind: 'empty', row: prompt });
                vt.write(`\x1b[${prompt + 1};1H\x1b[2K> [Pasted text #42 +40 lines]`);
                expect(readComposer(screen)).toMatchObject({ kind: 'chip', row: prompt });
            } finally { vt.dispose(); }
        });
    }
});

afterEach(() => vi.useRealTimers());

const draw = (vt: TerminalScreen, content: string) => vt.write('\x1b[?1049h\x1b[5;1H\x1b[2K> ' + content);

describe('review R6 ownership probes (independent Codex review, ported)', () => {
    it('R6-2: does not re-paste over a literal pipe remaining after DEL', async () => {
        vi.useFakeTimers();
        const vt = new TerminalScreen(10, 80);
        let composer = '';
        let composerAtRewrite: string | null = null;
        let writes = 0;
        const listeners = new Set<() => void>();
        const render = () => { draw(vt, composer); for (const l of listeners) l(); };
        // The TerminalAdapter surface the machine needs: counted writes, every
        // frame, no other writable client, and the host's input account.
        const adapter = {
            getCursorRow: () => vt.getCursorRow(),
            getWriteCount: () => writes,
            onScreenWrite: (l: () => void) => { listeners.add(l); return () => listeners.delete(l); },
            otherWritersPossible: () => false,
            // The session host's input account: no other client's input since begin().
            inputProvenanceKey: () => '0:0:0',
        };
        const machine = new SubmitVerdictMachine({
            specTag: () => 'r6', currentStatus: () => 'idle', adapter,
            writeOwnKeysGuarded: async (keys) => { writes += 1; machine.noteOwnWrite(); expect(keys).toBe('\x7f'); composer = composer.slice(0, -1); render(); return true; },
            rewrite: () => { composerAtRewrite = composer; },
            confirmConsumption: async () => 'not_consumed',
            slotTaken: () => true, releaseSlot: () => {},
        });
        try {
            render(); machine.observe('task:t:n0', () => true);
            const send = machine.begin('task:t:n0', '|x', false);
            writes += 1; machine.noteOwnWrite(); composer = '|x'; render();
            expect(machine.noteRendered(send)).toBe(true);
            machine.awaitVerdict(send); machine.judge(send);
            await vi.advanceTimersByTimeAsync(UNSUBMITTED_HOLD_MS + 3 * (CLEAR_STEP_MS + CLEAR_SETTLE_MS) + 1);
            expect(composerAtRewrite).toBe('');
        } finally { machine.cancel(); vt.dispose(); }
    });

    it('the same machine without the write count / frame / client surface never owns the row — nothing is ever deleted', async () => {
        vi.useFakeTimers();
        const vt = new TerminalScreen(10, 80);
        const deleted: string[] = [];
        const machine = new SubmitVerdictMachine({
            specTag: () => 'r6', currentStatus: () => 'idle', adapter: vt,
            writeOwnKeysGuarded: async (keys) => { deleted.push(keys); return true; }, rewrite: () => {}, slotTaken: () => true, releaseSlot: () => {},
        });
        try {
            draw(vt, ''); machine.observe('task:t:n0', () => true);
            const send = machine.begin('task:t:n0', '|x', false);
            draw(vt, '|x');
            expect(machine.noteRendered(send)).toBe(false);
            machine.awaitVerdict(send); machine.judge(send);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(deleted).toEqual([]);
        } finally { machine.cancel(); vt.dispose(); }
    });

    it('R6-3: does not attribute a different literal row merely because whitespace normalises away', () => {
        const vt = new TerminalScreen(10, 80);
        try {
            draw(vt, 'Please preserve "ab"');
            const read = readComposer(vt);
            expect(read).toMatchObject({ kind: 'text', text: 'Please preserve "ab"' });
            expect(classifyRender(read, 'Please preserve "a b"')).toBe('foreign');
            expect(classifyRender(read, 'Please preserve "ab"')).toBe('own_literal');
            expect(classifyRender(read, 'Please preserve "ab" ')).toBe('rendering'); // a strict prefix still painting
        } finally { vt.dispose(); }
    });

    it('R6-2: does not consider an editable pipe to the right of the cursor empty', () => {
        const vt = new TerminalScreen(10, 80);
        try {
            draw(vt, '|'); vt.write('\x1b[5;3H');
            expect(vt.getCursorRow()).toMatchObject({ left: '> ' });
            expect(readComposer(vt).kind).toBe('unknown');
        } finally { vt.dispose(); }
    });

    it('R6-2: ASCII pipes and other box characters left of the cursor are content, never chrome', () => {
        const vt = new TerminalScreen(10, 80);
        try {
            for (const residue of ['|', '─', '╰', '│']) {
                draw(vt, residue);
                expect(readComposer(vt)).toMatchObject({ kind: 'text', text: residue });
            }
            // A real frame: `│ > ` on the left, `│` at the box edge on the right.
            vt.write('\x1b[5;1H\x1b[2K│ > \x1b[s          │\x1b[u');
            expect(readComposer(vt).kind).toBe('empty');
        } finally { vt.dispose(); }
    });

    it('R6-1: two chips, or a chip with anything beside it, is never this send\'s own render', () => {
        const vt = new TerminalScreen(10, 80);
        try {
            draw(vt, '[Pasted text #1 +40 lines][Pasted text #99 +3 lines]');
            expect(classifyRender(readComposer(vt), 'body')).toBe('foreign');
            draw(vt, '[Pasted text #1 +40 lines] note');
            expect(classifyRender(readComposer(vt), 'body')).toBe('foreign');
            draw(vt, '[Pasted text #1 +40 lines]');
            expect(classifyRender(readComposer(vt), 'body')).toBe('own_chip');
            draw(vt, '[Pasted te');
            expect(classifyRender(readComposer(vt), 'body')).toBe('rendering');
        } finally { vt.dispose(); }
    });

    it('baseline comparison: any residue, left or right of the cursor, differs; blanks do not', () => {
        const vt = new TerminalScreen(10, 80);
        try {
            draw(vt, '');
            const base = readComposer(vt);
            expect(base.kind).toBe('empty');
            const cells = (base as { cells: { row: number; col: number; left: string; right: string } }).cells;
            vt.write('\x1b[5;20H'); // cursor further along the blank row
            expect(sameVisibleRow(readComposer(vt), cells)).toBe(true);
            draw(vt, '|'); vt.write('\x1b[5;3H');
            expect(sameVisibleRow(readComposer(vt), cells)).toBe(false);
        } finally { vt.dispose(); }
    });
});
