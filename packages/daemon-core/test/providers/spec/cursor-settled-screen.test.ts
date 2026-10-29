/**
 * cursor-cli settled-screen regression (live 2026-10 fleet member: worker showed
 * "generating…" forever after the terminal had visibly finished).
 *
 * Screens are REAL captures from cursor-agent 2026.10.22 (node-pty, 140 cols,
 * workspace path scrubbed): the spinner verb is now "Composing"/"Editing" (not
 * "Working"), the footer is `<model> · N% [· M files edited]` + path, and a
 * wide terminal puts the path after the percent on ONE line. Drives the real
 * specs/1.0.json FSM, the manifest tui parser and the settled-screen scrape.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import { evaluateFsm, type FsmClock } from '../../../src/providers/spec/fsm-evaluator.js';
import type { CliSpecV4 } from '../../../src/providers/spec/fsm-types.js';
import { TerminalScreen } from '../../../src/cli-adapters/terminal-screen.js';
import { buildParseSessionFromTui } from '../../../src/providers/sdk/v1/builders/cli/parse-session.js';
import { extractCursorScreenAssistantMessages } from '../../../src/providers/spec/cursor-screen-messages.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../../../..');
const CURSOR_DIR = path.join(REPO_ROOT, 'adhdev-providers/cli/cursor-cli');

const raw = JSON.parse(fs.readFileSync(path.join(CURSOR_DIR, 'specs/1.0.json'), 'utf8'));
const errs = validateFsmSpec(raw);
if (errs.length) throw new Error(errs.join('; '));
const spec = raw as CliSpecV4;
const manifest = JSON.parse(fs.readFileSync(path.join(CURSOR_DIR, 'provider.v1.json'), 'utf8'));

function fire(from: string, screen: string[], ageMs = 15_000): string | null {
    const now = 1_000_000;
    const clock: FsmClock = { now, stateEnteredAt: now - ageMs, regionLastChangedAt: new Map() };
    const res = evaluateFsm(spec, from, screen.join('\n'), { row: 0, col: 0 }, screen, clock);
    return (res.fired as { to?: string } | null)?.to ?? null;
}

const WS = '/Users/example/Work/project';
const FOOTER_TWO_LINE = ['  Composer 2.5 · 18.5% · 2 files edited' + ' '.repeat(60) + 'Run Everything', `  ${WS} · main`];
const FOOTER_ONE_LINE = [`  Composer 2.5 · 18.5% · 2 files edited · ${WS} · main`];

const ANSWER = ['  Created hello.txt and verified it contains hi.'];
const settled = (footer: string[]) => [
    '  Cursor Agent', '  v2026.10.22-27dcf5f', '', '  Do the task', '', '  Edited hello.txt +1', '', '  ▎+ hi', '',
    ...ANSWER, '', '', '  → Add a follow-up', '', ...footer,
];
const BUSY_COMPOSING = [
    '  Do the task', '', '', ' ⠘⠣ Composing  5 tokens', '    Tip: Use /plan to iterate on an implementation plan before code changes.', '',
    '  → Add a follow-up                                       ctrl+c to stop', '', '  Composer 2.5 · 6.4% · 1 file edited', `  ${WS} · main`,
];
const BUSY_EDITING_NO_HINT = [
    '  Do the task', '', ' ⠠⠜ Editing  52 tokens', '', '  → Add a follow-up', '', ...FOOTER_TWO_LINE,
];

describe('cursor-cli FSM — settled vs busy screens', () => {
    it.each([['two-line footer', FOOTER_TWO_LINE], ['one-line footer (wide terminal)', FOOTER_ONE_LINE]])(
        'finished answer + idle composer + %s → busy settles to idle', (_n, footer) => {
            expect(fire('busy', settled(footer))).toBe('idle');
        });

    it.each([['two-line footer', FOOTER_TWO_LINE], ['one-line footer', FOOTER_ONE_LINE]])(
        'the same settled screen never flips idle back to busy (%s)', (_n, footer) => {
            expect(fire('idle', settled(footer))).toBeNull();
        });

    it('an answer containing braille / "Working" prose mid-line is not a spinner', () => {
        const screen = settled(FOOTER_TWO_LINE);
        screen.splice(9, 1, '  The ⠿ glyph and the word Working appear in this sentence, ⠋ not as a spinner.');
        expect(fire('idle', screen)).toBeNull();
        expect(fire('busy', screen)).toBe('idle');
    });

    it('the new "Composing"/"Editing" spinner verbs mark busy, with or without the stop hint', () => {
        expect(fire('idle', BUSY_COMPOSING)).toBe('busy');
        expect(fire('idle', BUSY_EDITING_NO_HINT)).toBe('busy');
    });

    it('a busy screen is never settled (footer percent present while spinning)', () => {
        expect(fire('busy', BUSY_COMPOSING)).toBeNull();
        expect(fire('busy', BUSY_EDITING_NO_HINT)).toBeNull();
    });
});

describe('cursor-cli parser + settled-screen scrape (real captured final-answer screen)', () => {
    const rawBuf = fs.readFileSync(path.join(CURSOR_DIR, 'fixtures/final-answer-edit-2026-10-29.pty'), 'utf8');
    const screen = new TerminalScreen(40, 140);
    screen.write(rawBuf);
    const screenText = screen.getText();
    const parse = buildParseSessionFromTui(manifest.tui);

    it('PTY parser returns the final assistant text and no spinner/footer/diff-gutter junk', () => {
        const result = parse({ buffer: rawBuf, screenText });
        const assistant = result.messages.filter((m: any) => m.role === 'assistant').map((m: any) => m.content);
        expect(assistant[assistant.length - 1]).toBe('hello.txt 파일을 만들고 내용으로 hi를 넣어 두었습니다.');
        const all = result.messages.map((m: any) => m.content).join('\n');
        expect(all).not.toMatch(/Composing|Editing  \d+ tokens|\d+(?:\.\d+)?% ·|Run Everything|▎/);
        // The boxed prompt is still the (only) user turn.
        expect(result.messages.filter((m: any) => m.role === 'user').map((m: any) => m.content))
            .toContain('Create a file named hello.txt containing the word hi, then tell me in one sentence that you did it.');
    });

    it('a background-coloured NON-prompt block (diff / code span) is not classified as the user', () => {
        const buf = '\u001b[48;5;22m  ▎+ added line\u001b[49m\r\n  The answer is 4.\r\n  Composer 2.5 · 6.4% · 1 file edited\r\n  /tmp/ws · main\r\n';
        const result = parse({ buffer: buf, screenText: buf.replace(/\u001b\[[0-9;]*m/g, '') });
        expect(result.messages.some((m: any) => m.role === 'user')).toBe(false);
        expect(result.messages.map((m: any) => m.content)).toContain('The answer is 4.');
    });

    it('settled-screen scrape returns the answer after the prompt echo / tool lines', () => {
        const msgs = extractCursorScreenAssistantMessages(screenText, ['Create a file named hello.txt containing the word hi, then tell me in one sentence that you did it.']);
        expect(msgs).toHaveLength(1);
        expect(msgs[0].content).toBe('hello.txt 파일을 만들고 내용으로 hi를 넣어 두었습니다.');
    });

    it('scrape yields nothing while busy (spinner / stop hint) or without the settled footer', () => {
        expect(extractCursorScreenAssistantMessages(BUSY_COMPOSING.join('\n'))).toEqual([]);
        expect(extractCursorScreenAssistantMessages(BUSY_EDITING_NO_HINT.join('\n'))).toEqual([]);
        expect(extractCursorScreenAssistantMessages(['  The answer.', '', '  → Add a follow-up'].join('\n'))).toEqual([]);
    });

    it('scrape handles the one-line wide footer', () => {
        const msgs = extractCursorScreenAssistantMessages(settled(FOOTER_ONE_LINE).join('\n'), ['Do the task']);
        expect(msgs.map(m => m.content)).toEqual(['Created hello.txt and verified it contains hi.']);
    });
});

describe('cursor-cli parser — live 80-col screen (truecolor prompt box, soft-wrapped lines)', () => {
    // Real capture from a live standalone session (cursor-agent 2026.10.22, 80
    // cols, paths scrubbed to same-length placeholders). Differs from the
    // 140-col fixture: the prompt box uses truecolor `48;2;36;36;40` (not
    // `48;5;233`) and both the prompt and the answer wrap onto two lines.
    const rawBuf = fs.readFileSync(path.join(CURSOR_DIR, 'fixtures/live-80col-truecolor-box-2026-10-29.pty'), 'utf8');
    const screen = new TerminalScreen(28, 80);
    screen.write(rawBuf);
    const parse = buildParseSessionFromTui(manifest.tui);
    const result = parse({ buffer: rawBuf, screenText: screen.getText() });

    it('classifies the wrapped truecolor-boxed prompt as ONE user turn', () => {
        expect(result.messages.filter((m: any) => m.role === 'user').map((m: any) => m.content)).toEqual([
            'Create a file notes/qa-cursor.txt containing the single line: cursor transcript ok. Then reply with one short sentence saying what you did.',
        ]);
    });

    it('returns the wrapped final answer as ONE assistant bubble without tool/footer junk', () => {
        const assistant = result.messages.filter((m: any) => m.role === 'assistant').map((m: any) => m.content);
        expect(assistant).toHaveLength(1);
        expect(assistant[0]).toContain('cursor transcript ok');
        expect(assistant[0]).toContain('넣었습니다.');
        expect(assistant[0]).not.toMatch(/Edited|Composer|follow-up|qa-cursor\.txt \+1|▎|\/tmp\/ws/);
    });
});
