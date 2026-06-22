/**
 * Approval-modal SELECT keystrokes — arrow-nav vs index modes.
 *
 * Regression (AUTOAPPROVE-1): claude-cli's new TUI approval modal is a cursor
 * list that IGNORES number keys — its cursor opens on the first option and Enter
 * commits the cursor's current row. The modal-resolve path (auto-approve and an
 * explicit dashboard click both land in handleClickModalButton) sent the button's
 * `key` = `key_for_index` with `{index}` filled in (`1\r`), so the daemon typed a
 * literal "1" into the composer and the trailing CR submitted it as a chat
 * message — "1" leaked into the worker chat and the modal never resolved, so the
 * 5s busy-window expired and re-fired in a flap.
 *
 * The fix honors a spec-declared `select_mode: 'arrow_keys'` on the approval
 * buttons rule (mirroring the /model picker's open_picker select_mode): drive the
 * cursor from its current row to the target with up/down arrows, then confirm with
 * the `key_for_index` tail (`{index}\r` → `\r`). Index-mode modals (no select_mode
 * declared) keep typing the on-screen number — codex/hermes/antigravity rely on
 * that.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import { extractButtonsFromRule, resolveSections, sectionText } from '../../../src/providers/spec/evaluator.js';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import type { CliSpecV4 } from '../../../src/providers/spec/fsm-types.js';

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const ESC = String.fromCharCode(27); // ANSI escape (0x1b)
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;

type ModalButton = { index: number; label: string; key: string; current: boolean };

/**
 * Exercise the private handleClickModalButton in isolation — same technique the
 * picker arrow-nav test uses for selectPickerChoice. We hand it a fake adapter
 * (capturing send_keys), the resolved modal, and a minimal spec whose approval
 * state carries the buttons rule under test.
 */
function makeDriver(buttons: ModalButton[], rule: Record<string, unknown>): { driver: any; sent: string[] } {
    const sent: string[] = [];
    const driver = Object.create(FsmDriver.prototype);
    Object.assign(driver, {
        currentStateId: 'approval',
        spec: { states: [{ id: 'approval', label: 'Approval', modal: true, extract: { buttons: rule } }] },
        currentEval: { state: { id: 'approval' }, modal: { title: 'Do you want to proceed?', buttons }, controls: [] },
        adapter: { send_keys: (k: string) => sent.push(k) },
    });
    return { driver, sent };
}

// A claude-cli approval modal: cursor (❯) opens on the first option.
const APPROVAL_BUTTONS: ModalButton[] = [
    { index: 1, label: 'Yes', key: '1\r', current: true },
    { index: 2, label: "Yes, and don't ask again", key: '2\r', current: false },
    { index: 3, label: 'No, and tell Claude what to do differently', key: '3\r', current: false },
];

const ARROW_RULE = { pattern: '', key_for_index: '{index}\r', min_count: 2, select_mode: 'arrow_keys' };
const INDEX_RULE = { pattern: '', key_for_index: '{index}\r', min_count: 2 };

describe('FsmDriver — approval modal arrow-nav SELECT', () => {
    it('approve (index 1, cursor already there): confirms with a lone CR, no number key', () => {
        const { driver, sent } = makeDriver(APPROVAL_BUTTONS, ARROW_RULE);

        driver.handleClickModalButton(1);

        // Cursor is on row 1 already → no arrows, just the confirm CR.
        expect(sent).toEqual(['\r']);
        // The digit '1' must never reach the PTY — that is the leak being fixed.
        expect(sent.join('')).not.toContain('1');
    });

    it('reject (index 3): steps DOWN from the cursor row to the target, then confirms', () => {
        const { driver, sent } = makeDriver(APPROVAL_BUTTONS, ARROW_RULE);

        driver.handleClickModalButton(3);

        // current = row 1, target = row 3 → 2× DOWN then CR. No '3' typed.
        expect(sent).toEqual([`${DOWN}${DOWN}`, '\r']);
        expect(sent.join('')).not.toContain('3');
    });

    it('steps UP when the cursor sits below the target', () => {
        const cursorOn3 = APPROVAL_BUTTONS.map(b => ({ ...b, current: b.index === 3 }));
        const { driver, sent } = makeDriver(cursorOn3, ARROW_RULE);

        driver.handleClickModalButton(1);

        // current = row 3, target = row 1 → 2× UP then CR.
        expect(sent).toEqual([`${UP}${UP}`, '\r']);
    });

    it('falls back to stepping down from row 1 when no cursor marker is detected', () => {
        const noCursor = APPROVAL_BUTTONS.map(b => ({ ...b, current: false }));
        const { driver, sent } = makeDriver(noCursor, ARROW_RULE);

        driver.handleClickModalButton(2);

        // No detected cursor → assume the modal opened on row 1 → 1× DOWN + CR.
        expect(sent).toEqual([DOWN, '\r']);
    });

    it('honors custom cursor_keys overrides', () => {
        const { driver, sent } = makeDriver(APPROVAL_BUTTONS, { ...ARROW_RULE, cursor_keys: { up: 'k', down: 'j' } });

        driver.handleClickModalButton(2);

        expect(sent).toEqual(['j', '\r']);
    });
});

describe('FsmDriver — index-keyed approval modal SELECT (no regression)', () => {
    it('still types the on-screen number + key_for_index when select_mode is absent', () => {
        const { driver, sent } = makeDriver(APPROVAL_BUTTONS, INDEX_RULE);

        driver.handleClickModalButton(2);

        // Index mode: send the button's pre-rendered key ('2\r') — codex/hermes
        // approval modals rely on this number-keyed behavior.
        expect(sent).toEqual(['2\r']);
    });
});

describe('extractButtonsFromRule — cursor row detection', () => {
    it('flags the ❯-marked row as current and the rest as not', () => {
        const hay = [
            'Do you want to proceed?',
            '   1. Yes',
            ' ❯ 2. No',
        ].join('\n');
        const buttons = extractButtonsFromRule(
            { section: 'modal', pattern: '^\\s*(?:[❯›>]\\s*)?(\\d+)\\.\\s*(.+?)\\s*$', flags: 'gm', key_for_index: '{index}\r' },
            hay,
        );
        expect(buttons.find(b => b.index === 1)?.current).toBe(false);
        expect(buttons.find(b => b.index === 2)?.current).toBe(true);
    });
});

describe('claude-cli spec declares arrow-nav for the approval modal', () => {
    it.each(['3.0.json', '4.0.json'])('%s approval buttons use select_mode arrow_keys', (file) => {
        const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'adhdev-providers/cli/claude-cli/specs', file), 'utf8'));
        const approval = (raw.states ?? []).find((s: any) => s.id === 'approval');
        expect(approval?.extract?.buttons?.select_mode).toBe('arrow_keys');
    });

    it('the 4.0 spec still validates with the new field', () => {
        const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'adhdev-providers/cli/claude-cli/specs/4.0.json'), 'utf8'));
        expect(validateFsmSpec(raw)).toEqual([]);
    });

    it('end-to-end: a live divider-less approval screen yields a cursor-flagged button set (4.0)', () => {
        const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'adhdev-providers/cli/claude-cli/specs/4.0.json'), 'utf8'));
        const spec = raw as CliSpecV4;
        const approval = spec.states.find(s => s.id === 'approval')!;
        const screen = [
            '⏺ I will edit the file now.',
            '',
            'Do you want to proceed?',
            ' ❯ 1. Yes',
            '   2. No',
            '',
            ' Esc to cancel',
        ];
        const sections = resolveSections(spec.sections ?? {}, screen);
        const rule = approval.extract!.buttons!;
        const hay = sectionText(sections, rule.section, screen.join('\n'));
        const buttons = extractButtonsFromRule(rule, hay);
        expect(buttons.map(b => b.index)).toEqual([1, 2]);
        expect(buttons.find(b => b.index === 1)?.current).toBe(true);
        expect(buttons.find(b => b.index === 2)?.current).toBe(false);
        expect(rule.select_mode).toBe('arrow_keys');
    });
});
