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

import { afterEach, describe, expect, it, vi } from 'vitest';
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
const IS_WIN32 = process.platform === 'win32';

type ModalButton = { index: number; label: string; key: string; current: boolean };

// On win32 the confirm CR is resent on a timer (scheduleWin32ModalConfirm) until
// the modal resolves; the fake driver never leaves 'approval', so clear the
// dangling timer between tests to avoid leaking real setTimeout handles.
const liveDrivers: any[] = [];
afterEach(() => {
    for (const d of liveDrivers.splice(0)) {
        if (d.win32ModalConfirmTimer) { clearTimeout(d.win32ModalConfirmTimer); d.win32ModalConfirmTimer = null; }
    }
});

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
        spec: {
            states: [
                { id: 'approval', label: 'Approval', modal: true, extract: { buttons: rule } },
                { id: 'busy', label: 'Generating', status: 'generating' },
            ],
        },
        currentEval: { state: { id: 'approval' }, modal: { title: 'Do you want to proceed?', buttons }, controls: [] },
        adapter: { send_keys: (k: string) => sent.push(k) },
        win32ModalConfirmTimer: null,
    });
    liveDrivers.push(driver);
    return { driver, sent };
}

// On win32 a confirm whose key ends in a CR is split (digits written, CR resent
// via the verified loop); the FIRST CR still fires synchronously, so the
// immediate keystrokes a test observes are identical except a trailing "X\r"
// becomes "X" then "\r". This normalizes the EXPECTED keys for the platform so
// the same assertion holds on win32 (split) and posix (combined single write).
function expectKeys(combined: string[]): string[] {
    if (!IS_WIN32) return combined;
    const out: string[] = [];
    for (const k of combined) {
        const m = /^([\s\S]*?)([\r\n]+)$/.exec(k);
        if (m && m[2] && m[1]) { out.push(m[1], m[2]); }
        else out.push(k);
    }
    return out;
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
        expect(sent).toEqual(expectKeys(['\r']));
        // The digit '1' must never reach the PTY — that is the leak being fixed.
        expect(sent.join('')).not.toContain('1');
    });

    it('reject (index 3): steps DOWN from the cursor row to the target, then confirms', () => {
        const { driver, sent } = makeDriver(APPROVAL_BUTTONS, ARROW_RULE);

        driver.handleClickModalButton(3);

        // current = row 1, target = row 3 → 2× DOWN then CR. No '3' typed.
        expect(sent).toEqual(expectKeys([`${DOWN}${DOWN}`, '\r']));
        expect(sent.join('')).not.toContain('3');
    });

    it('steps UP when the cursor sits below the target', () => {
        const cursorOn3 = APPROVAL_BUTTONS.map(b => ({ ...b, current: b.index === 3 }));
        const { driver, sent } = makeDriver(cursorOn3, ARROW_RULE);

        driver.handleClickModalButton(1);

        // current = row 3, target = row 1 → 2× UP then CR.
        expect(sent).toEqual(expectKeys([`${UP}${UP}`, '\r']));
    });

    it('falls back to stepping down from row 1 when no cursor marker is detected', () => {
        const noCursor = APPROVAL_BUTTONS.map(b => ({ ...b, current: false }));
        const { driver, sent } = makeDriver(noCursor, ARROW_RULE);

        driver.handleClickModalButton(2);

        // No detected cursor → assume the modal opened on row 1 → 1× DOWN + CR.
        expect(sent).toEqual(expectKeys([DOWN, '\r']));
    });

    it('honors custom cursor_keys overrides', () => {
        const { driver, sent } = makeDriver(APPROVAL_BUTTONS, { ...ARROW_RULE, cursor_keys: { up: 'k', down: 'j' } });

        driver.handleClickModalButton(2);

        expect(sent).toEqual(expectKeys(['j', '\r']));
    });
});

describe('FsmDriver — index-keyed approval modal SELECT (no regression)', () => {
    it('still types the on-screen number + key_for_index when select_mode is absent', () => {
        const { driver, sent } = makeDriver(APPROVAL_BUTTONS, INDEX_RULE);

        driver.handleClickModalButton(2);

        // Index mode: send the button's pre-rendered key ('2\r') — codex/hermes
        // approval modals rely on this number-keyed behavior. On win32 the trailing
        // CR is split off and resent via the verified loop (APPROVESTUCK), so the
        // immediate keys are '2' then '\r'; posix keeps the single combined write.
        expect(sent).toEqual(expectKeys(['2\r']));
    });
});

// ── APPROVESTUCK fixB: win32 modal-confirm CR resend ─────────────────────────
// Root cause (live, 3× capture): the claude cd/untrusted-hooks approval auto-fired
// its confirm CR via handleClickModalButton, but on win32 ConPTY a lone CR is
// absorbed as a literal newline (the same lone-CR-swallow that scheduleWin32Submit
// exists to defeat for send_message). The modal never resolved → the FSM flapped
// approval↔busy for ~75s while auto-approve re-fired into the void. Fix: the confirm
// CR is now resent on a cadence until the modal actually resolves (status leaves
// 'approval'), gated + bounded exactly like the send_message submit loop.
describe('FsmDriver — APPROVESTUCK win32 modal-confirm CR resend', () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p, configurable: true });
    const GAP = 350; // WIN32_SUBMIT_RESEND_GAP_MS

    afterEach(() => {
        vi.useRealTimers();
        Object.defineProperty(process, 'platform', realPlatform);
    });

    it('win32: fires the confirm CR immediately, then resends while still in approval, and stops once resolved', () => {
        setPlatform('win32');
        vi.useFakeTimers();
        const { driver, sent } = makeDriver(APPROVAL_BUTTONS, ARROW_RULE);

        driver.handleClickModalButton(1);
        // Cursor on row 1 → no arrows; the first confirm CR fires synchronously.
        expect(sent).toEqual(['\r']);
        expect(driver.win32ModalConfirmTimer).not.toBeNull(); // a resend is armed

        // Still in the modal (status 'approval') → the gated resend fires another CR.
        vi.advanceTimersByTime(GAP);
        expect(sent).toEqual(['\r', '\r']);
        expect(driver.win32ModalConfirmTimer).not.toBeNull();

        // Modal resolves: the FSM leaves approval (→ generating). The next gated
        // tick observes status !== 'approval' and stops — no stray CR into the
        // next turn's composer.
        driver.currentStateId = 'busy';
        vi.advanceTimersByTime(GAP);
        expect(sent).toEqual(['\r', '\r']);
        expect(driver.win32ModalConfirmTimer).toBeNull();
    });

    it('win32 index-mode: writes the digit once, then resends only the confirm CR while in approval', () => {
        setPlatform('win32');
        vi.useFakeTimers();
        const { driver, sent } = makeDriver(APPROVAL_BUTTONS, INDEX_RULE);

        driver.handleClickModalButton(2);
        // Digit written separately, first CR fired; the combined '2\r' is never one write.
        expect(sent).toEqual(['2', '\r']);
        expect(sent).not.toContain('2\r');

        vi.advanceTimersByTime(GAP);
        expect(sent).toEqual(['2', '\r', '\r']); // CR resent, digit NOT repeated
    });

    it('win32: the resend loop is bounded by the retry budget (does not spin forever)', () => {
        setPlatform('win32');
        vi.useFakeTimers();
        const { driver, sent } = makeDriver(APPROVAL_BUTTONS, ARROW_RULE);

        driver.handleClickModalButton(1); // never leaves 'approval' in this fake
        vi.advanceTimersByTime(GAP * 30); // well past WIN32_SUBMIT_MAX_RESENDS (14)
        expect(sent.length).toBeLessThanOrEqual(14);
        expect(sent.length).toBeGreaterThan(1); // it DID resend
        expect(driver.win32ModalConfirmTimer).toBeNull(); // budget spent → loop ended
    });

    it('posix: a single confirm CR, no resend timer (unchanged behavior)', () => {
        setPlatform('linux');
        const { driver, sent } = makeDriver(APPROVAL_BUTTONS, ARROW_RULE);

        driver.handleClickModalButton(1);
        expect(sent).toEqual(['\r']);
        expect(driver.win32ModalConfirmTimer == null).toBe(true);
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

// ── CURSORMARKER: per-spec cursor_marker opt-in ──────────────────────────────
// The engine's default focus-marker class is `[❯›>→]`, which includes a bare
// `>`. antigravity-cli renders assistant/tool text INSIDE the modal section, and
// that text carries markdown blockquotes (`> 1. …`). A quoted line that happens
// to be numbered therefore parsed as a button AND was flagged `current: true`.
// When such a line lands inside the bottom-most contiguous numbered block (i.e.
// it is adjacent to the real options, so lastContiguousNumberedBlock cannot
// filter it), two rows claim the cursor and arrow-nav steps from the wrong one —
// committing the wrong approval choice.
//
// The fix is per-spec, NOT an engine default change: a spec whose modal section
// can contain blockquotes declares `cursor_marker: "❯›"` to drop bare `>`.
// Specs that omit it keep the engine literal verbatim.
//
// NOTE on fixture shape: lastContiguousNumberedBlock already filters a quoted
// line whose index BREAKS the descending chain (`> 1.` above `❯ 1.`). The
// surviving hazard — reproduced below — is a quoted line whose index CONTINUES
// it, so the quote lands inside the option block and steals `current`.
describe('extractButtonsFromRule — per-spec cursor_marker (CURSORMARKER)', () => {
    // The quoted `> 1.` continues into the real options (2./3.), so the
    // bottom-block reduction keeps it — and it is the ONLY row flagged current,
    // i.e. arrow-nav would step from a phantom cursor and commit the wrong row.
    const QUOTED_MODAL = [
        'Requesting permission for:',
        '  > 1. quoted checklist item from the assistant',
        '  2. Yes, proceed',
        '  3. No, cancel',
    ].join('\n');

    // A second shape: the real cursor IS present, but the quote also claims it —
    // two rows current, so the cursor delta is ambiguous.
    const QUOTED_MODAL_WITH_REAL_CURSOR = [
        'Requesting permission for:',
        '  > 1. quoted checklist item from the assistant',
        '  ❯ 2. Yes, proceed',
        '    3. No, cancel',
    ].join('\n');

    const ANTIGRAVITY_RULE = {
        section: 'modal',
        pattern: '^\\s*(?:[❯›>]\\s*)?(\\d+)\\.\\s*(\\S.+?)\\s*$',
        flags: 'gm',
        key_for_index: '{index}\r',
        min_count: 2,
        select_mode: 'arrow_keys' as const,
        continuation_lines: true,
    };

    it('WITHOUT cursor_marker: a blockquote row is a false-positive cursor row', () => {
        const buttons = extractButtonsFromRule(ANTIGRAVITY_RULE, QUOTED_MODAL);
        // The quote is the ONLY row flagged current — arrow-nav would treat the
        // quoted line as the cursor position and commit the wrong option.
        expect(buttons.map(b => b.label)).toEqual([
            'quoted checklist item from the assistant', 'Yes, proceed', 'No, cancel',
        ]);
        expect(buttons.filter(b => b.current).map(b => b.label))
            .toEqual(['quoted checklist item from the assistant']);
    });

    it('WITHOUT cursor_marker: the quote also steals current from the real ❯ row', () => {
        const buttons = extractButtonsFromRule(ANTIGRAVITY_RULE, QUOTED_MODAL_WITH_REAL_CURSOR);
        // Two rows current → ambiguous cursor delta.
        expect(buttons.filter(b => b.current).length).toBeGreaterThan(1);
    });

    it('WITH cursor_marker "❯›": the blockquote no longer claims the cursor', () => {
        const buttons = extractButtonsFromRule({ ...ANTIGRAVITY_RULE, cursor_marker: '❯›' }, QUOTED_MODAL);
        // The quoted row is still PARSED (the pattern's own `>` alternation is
        // untouched — this fix only narrows cursor detection) but is not current.
        expect(buttons.map(b => b.label)).toEqual([
            'quoted checklist item from the assistant', 'Yes, proceed', 'No, cancel',
        ]);
        expect(buttons.filter(b => b.current)).toHaveLength(0);
    });

    it('WITH cursor_marker "❯›": exactly the real ❯ row is current', () => {
        const buttons = extractButtonsFromRule(
            { ...ANTIGRAVITY_RULE, cursor_marker: '❯›' }, QUOTED_MODAL_WITH_REAL_CURSOR);
        expect(buttons.filter(b => b.current).map(b => b.label)).toEqual(['Yes, proceed']);
    });

    it('an unset cursor_marker is byte-identical to the engine default', () => {
        for (const hay of [QUOTED_MODAL, QUOTED_MODAL_WITH_REAL_CURSOR]) {
            const withoutField = extractButtonsFromRule(ANTIGRAVITY_RULE, hay);
            const withUnset = extractButtonsFromRule({ ...ANTIGRAVITY_RULE, cursor_marker: undefined }, hay);
            const explicitDefault = extractButtonsFromRule({ ...ANTIGRAVITY_RULE, cursor_marker: '❯›>→' }, hay);
            expect(withUnset).toEqual(withoutField);
            expect(explicitDefault).toEqual(withoutField);
        }
    });
});

describe('antigravity-cli 4.0 spec opts into cursor_marker', () => {
    const raw = () => JSON.parse(fs.readFileSync(
        path.join(REPO_ROOT, 'adhdev-providers/cli/antigravity-cli/specs/4.0.json'), 'utf8'));

    it('every arrow_keys buttons rule declares cursor_marker "❯›"', () => {
        const rules = (raw().states ?? [])
            .map((s: any) => s?.extract?.buttons)
            .filter((b: any) => b?.select_mode === 'arrow_keys');
        expect(rules.length).toBe(2); // approval + trust
        for (const r of rules) expect(r.cursor_marker).toBe('❯›');
    });

    it('still validates with the new field', () => {
        expect(validateFsmSpec(raw())).toEqual([]);
    });

    it('end-to-end: a blockquote-polluted approval screen yields exactly one cursor row', () => {
        const spec = raw() as CliSpecV4;
        const approval = spec.states.find(s => s.id === 'approval')!;
        const screen = [
            '⏺ Following the reviewer notes:',
            '',
            'Requesting permission for:',
            '  > 1. quoted checklist item from the assistant',
            '  ❯ 2. Yes, proceed',
            '    3. No, cancel',
        ];
        const sections = resolveSections(spec.sections ?? {}, screen);
        const rule = approval.extract!.buttons!;
        const hay = sectionText(sections, rule.section, screen.join('\n'));
        const buttons = extractButtonsFromRule(rule, hay);
        expect(buttons.filter(b => b.current).map(b => b.label)).toEqual(['Yes, proceed']);
    });
});

describe('cursor_marker-less specs are unchanged (engine default preserved)', () => {
    // The 7 built-in specs that do NOT opt in must keep the literal `[❯›>→]`
    // default. Guard by counting: any new opt-in is a deliberate spec edit.
    const CLI_ROOT = () => path.join(REPO_ROOT, 'adhdev-providers/cli');

    it('exactly one provider spec family declares cursor_marker (antigravity)', () => {
        const optedIn: string[] = [];
        for (const dir of fs.readdirSync(CLI_ROOT())) {
            const specDir = path.join(CLI_ROOT(), dir, 'specs');
            if (!fs.existsSync(specDir)) continue;
            for (const f of fs.readdirSync(specDir).filter(n => n.endsWith('.json'))) {
                const text = fs.readFileSync(path.join(specDir, f), 'utf8');
                if (text.includes('"cursor_marker"')) optedIn.push(`${dir}/${f}`);
            }
        }
        expect(optedIn).toEqual(['antigravity-cli/4.0.json']);
    });

    it("claude-cli 4.0's approval rule has no cursor_marker and behaves on the engine literal", () => {
        const raw = JSON.parse(fs.readFileSync(
            path.join(REPO_ROOT, 'adhdev-providers/cli/claude-cli/specs/4.0.json'), 'utf8'));
        const rule = raw.states.find((s: any) => s.id === 'approval').extract.buttons;
        expect(rule.cursor_marker).toBeUndefined();
        const hay = [' ❯ 1. Yes', '   2. No'].join('\n');
        const buttons = extractButtonsFromRule(rule, hay);
        expect(buttons.find(b => b.index === 1)?.current).toBe(true);
        expect(buttons.find(b => b.index === 2)?.current).toBe(false);
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
