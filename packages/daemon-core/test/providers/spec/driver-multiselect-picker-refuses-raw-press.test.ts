/**
 * MULTISELECT-REMOTE-DEADLOCK — a raw modal-button press must REFUSE a
 * multi-select (checkbox) picker instead of silently corrupting it.
 *
 * Root cause (live, owner blocked on mobile): a multi-select AskUserQuestion
 * surfaced as the raw approval banner, whose only answer verb is
 * `resolve_action` → handleClickModalButton → a single-select `'{index}\r'`
 * injection. Both halves of that assumption are wrong for a claude-cli checkbox
 * picker (protocol measured live; see buildClaudeInteractiveTuiAnswerSteps):
 *
 *   * a digit TOGGLES a box and does NOT advance;
 *   * CR/Enter toggles the CURSOR's row rather than submitting — only Tab
 *     commits a question, and a final CR on the review page submits.
 *
 * So every remote tap flipped a checkbox the user never chose and submitted
 * nothing: the session stayed parked and flapped PROCESSING ↔ ACTION REQUIRED
 * forever. The driver is keystroke-only — it holds no bound InteractivePrompt and
 * therefore cannot build the real digit+Tab+CR sequence (that lives on
 * SpecCliAdapter.setInteractivePromptResponse) — so the correct behaviour here is
 * to write NOTHING and report the miss, which SpecCliAdapter.resolveModalMatched
 * already propagates to mesh_approve and the dashboard.
 *
 * These tests pin: (1) checkbox picker → no keys + false; (2) single-select
 * picker → unchanged keystrokes + true; (3) approval modals are untouched even
 * when checkbox-looking glyphs are on screen.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;
const IS_WIN32 = process.platform === 'win32';

type ModalButton = { index: number; label: string; key: string; current: boolean };

const liveDrivers: any[] = [];
afterEach(() => {
    for (const d of liveDrivers.splice(0)) {
        if (d.win32ModalConfirmTimer) { clearTimeout(d.win32ModalConfirmTimer); d.win32ModalConfirmTimer = null; }
    }
});

/** win32 splits a trailing CR off the confirm write; normalize expectations. */
function expectKeys(combined: string[]): string[] {
    if (!IS_WIN32) return combined;
    const out: string[] = [];
    for (const k of combined) {
        const m = /^([\s\S]*?)([\r\n]+)$/.exec(k);
        if (m && m[2] && m[1]) out.push(m[1], m[2]);
        else out.push(k);
    }
    return out;
}

/**
 * Same isolation technique as driver-approval-arrow-nav: a fake adapter capturing
 * send_keys, a resolved modal, and a minimal spec. `screen` is what the adapter
 * snapshot reports — the frame the checkbox detector reads.
 */
function makeDriver(opts: {
    buttons: ModalButton[];
    rule: Record<string, unknown>;
    /** 'picker' | 'approval' — what the FSM state declares. */
    modalKind: 'picker' | 'approval';
    screen: string;
}): { driver: any; sent: string[] } {
    const sent: string[] = [];
    const driver = Object.create(FsmDriver.prototype);
    Object.assign(driver, {
        currentStateId: 'modal',
        spec: {
            id: 'claude-cli',
            states: [
                {
                    id: 'modal',
                    label: 'Modal',
                    modal: true,
                    ...(opts.modalKind === 'picker' ? { modal_kind: 'picker' } : {}),
                    extract: { buttons: opts.rule },
                },
                { id: 'busy', label: 'Generating', status: 'generating' },
            ],
        },
        currentEval: { state: { id: 'modal' }, modal: { title: 'Pick some', buttons: opts.buttons }, controls: [] },
        adapter: {
            send_keys: (k: string) => sent.push(k),
            snapshot: () => opts.screen,
            snapshotWithScrollback: () => opts.screen,
        },
        win32ModalConfirmTimer: null,
    });
    liveDrivers.push(driver);
    return { driver, sent };
}

const BUTTONS: ModalButton[] = [
    { index: 1, label: 'TypeScript', key: '1\r', current: true },
    { index: 2, label: 'Python', key: '2\r', current: false },
    { index: 3, label: 'Rust', key: '3\r', current: false },
];

const ARROW_RULE = { pattern: '', key_for_index: '{index}\r', min_count: 2, select_mode: 'arrow_keys' };
const INDEX_RULE = { pattern: '', key_for_index: '{index}\r', min_count: 2 };

// A claude-cli MULTI-select picker: checkbox markers on the numbered option rows.
// Post-2.1 layout puts the glyph AFTER the number ("❯ 1. [ ] TypeScript").
const MULTISELECT_SCREEN = [
    'Which languages do you use?',
    ' ❯ 1. [ ] TypeScript',
    '   2. [x] Python',
    '   3. [ ] Rust',
    '',
    ' Tab to continue · Enter to toggle',
].join('\n');

// Same picker, older glyph layout (marker BEFORE the number).
const MULTISELECT_SCREEN_GLYPH_FIRST = [
    'Which languages do you use?',
    ' ❯ ☐ 1. TypeScript',
    '   ☒ 2. Python',
    '   ☐ 3. Rust',
].join('\n');

// A SINGLE-select picker: cursor/number rows only, no checkbox column.
const SINGLE_SELECT_SCREEN = [
    'Which language do you prefer?',
    ' ❯ 1. TypeScript',
    '   2. Python',
    '   3. Rust',
].join('\n');

describe('FsmDriver — multi-select checkbox picker refuses a raw modal press', () => {
    it('writes NO keys and reports false (arrow_keys mode)', () => {
        const { driver, sent } = makeDriver({
            buttons: BUTTONS, rule: ARROW_RULE, modalKind: 'picker', screen: MULTISELECT_SCREEN,
        });

        const pressed = driver.handleClickModalButton(2);

        // The whole point: nothing reached the PTY, so no checkbox was flipped.
        expect(sent).toEqual([]);
        // ...and the caller learns the press did NOT land (resolveModalMatched → false).
        expect(pressed).toBe(false);
        // No win32 CR resend loop was armed either — a refused press must not
        // start hammering the terminal.
        expect(driver.win32ModalConfirmTimer == null).toBe(true);
    });

    it('writes NO keys and reports false (index mode — the digit path)', () => {
        const { driver, sent } = makeDriver({
            buttons: BUTTONS, rule: INDEX_RULE, modalKind: 'picker', screen: MULTISELECT_SCREEN,
        });

        const pressed = driver.handleClickModalButton(2);

        // Index mode is the path that would have typed a bare '2' — a pure toggle
        // with no submit, i.e. the silent corruption.
        expect(sent).toEqual([]);
        expect(sent.join('')).not.toContain('2');
        expect(pressed).toBe(false);
    });

    it('detects the older glyph-before-number checkbox layout too', () => {
        const { driver, sent } = makeDriver({
            buttons: BUTTONS, rule: ARROW_RULE, modalKind: 'picker', screen: MULTISELECT_SCREEN_GLYPH_FIRST,
        });

        expect(driver.handleClickModalButton(1)).toBe(false);
        expect(sent).toEqual([]);
    });

    it('reads the SCROLLBACK frame, so a tall prompt cannot hide the checkboxes', () => {
        // Viewport shows only the question (option rows scrolled off); scrollback
        // still carries them. deriveModal reads scrollback for exactly this reason.
        const { driver, sent } = makeDriver({
            buttons: BUTTONS, rule: ARROW_RULE, modalKind: 'picker', screen: MULTISELECT_SCREEN,
        });
        driver.adapter.snapshot = () => 'Which languages do you use?';
        driver.adapter.snapshotWithScrollback = () => MULTISELECT_SCREEN;

        expect(driver.handleClickModalButton(2)).toBe(false);
        expect(sent).toEqual([]);
    });
});

describe('FsmDriver — single-select pickers keep working (no regression)', () => {
    it('arrow_keys single-select picker still navigates and confirms', () => {
        const { driver, sent } = makeDriver({
            buttons: BUTTONS, rule: ARROW_RULE, modalKind: 'picker', screen: SINGLE_SELECT_SCREEN,
        });

        const pressed = driver.handleClickModalButton(3);

        // Cursor on row 1 → 2× DOWN then the confirm CR. Byte-identical to before.
        expect(sent).toEqual(expectKeys([`${DOWN}${DOWN}`, '\r']));
        expect(pressed).toBe(true);
    });

    it('index-mode single-select picker still types the on-screen number', () => {
        const { driver, sent } = makeDriver({
            buttons: BUTTONS, rule: INDEX_RULE, modalKind: 'picker', screen: SINGLE_SELECT_SCREEN,
        });

        const pressed = driver.handleClickModalButton(2);

        expect(sent).toEqual(expectKeys(['2\r']));
        expect(pressed).toBe(true);
    });

    it('a missing/failed snapshot falls back to the existing behaviour, not a refusal', () => {
        const { driver, sent } = makeDriver({
            buttons: BUTTONS, rule: ARROW_RULE, modalKind: 'picker', screen: SINGLE_SELECT_SCREEN,
        });
        driver.adapter.snapshot = () => { throw new Error('pty gone'); };
        driver.adapter.snapshotWithScrollback = () => { throw new Error('pty gone'); };

        // A snapshot failure is not evidence of a checkbox picker — refusing blind
        // would break every single-select press during a transient PTY hiccup.
        expect(driver.handleClickModalButton(1)).toBe(true);
        expect(sent).toEqual(expectKeys(['\r']));
    });
});

describe('FsmDriver — approval modals are never refused', () => {
    it('an APPROVAL modal resolves normally even with checkbox glyphs on screen', () => {
        // The refusal is gated on modal_kind === 'picker'. A tool-consent approval
        // whose prompt body happens to contain "[x]" (a markdown checklist in the
        // diff being approved) must still resolve — auto-approve depends on it.
        const approvalButtons: ModalButton[] = [
            { index: 1, label: 'Yes', key: '1\r', current: true },
            { index: 2, label: 'No', key: '2\r', current: false },
        ];
        const { driver, sent } = makeDriver({
            buttons: approvalButtons,
            rule: ARROW_RULE,
            modalKind: 'approval',
            screen: [
                'Edit TODO.md?',
                '  - [x] 1. ship the fix',
                '  - [ ] 2. write the changelog',
                'Do you want to proceed?',
                ' ❯ 1. Yes',
                '   2. No',
            ].join('\n'),
        });

        const pressed = driver.handleClickModalButton(2);

        expect(pressed).toBe(true);
        expect(sent).toEqual(expectKeys([DOWN, '\r']));
    });
});
