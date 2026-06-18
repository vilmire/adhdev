import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import { evaluateFsm, type FsmClock } from '../../../src/providers/spec/fsm-evaluator.js';
import { resolveSections, sectionText, extractButtonsFromRule, extractTitle } from '../../../src/providers/spec/evaluator.js';
import type { CliSpecV4 } from '../../../src/providers/spec/fsm-types.js';

function resolveSpecPath(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '../../../../../..');
    const candidates = [
        path.join(repoRoot, 'adhdev-providers/cli/claude-cli/specs/4.0.json'),
        path.join(process.env.HOME ?? '', '.adhdev/providers/.upstream/cli/claude-cli/specs/4.0.json'),
    ];
    const found = candidates.find(p => fs.existsSync(p));
    if (!found) throw new Error('claude-cli 4.0.json spec not found in: ' + candidates.join(', '));
    return found;
}

function loadSpec(): CliSpecV4 {
    const raw = JSON.parse(fs.readFileSync(resolveSpecPath(), 'utf8'));
    const errs = validateFsmSpec(raw);
    if (errs.length) throw new Error(errs.join('; '));
    return raw as CliSpecV4;
}

function clk(now: number, entered: number, regions: [number, number][] = []): FsmClock {
    return { now, stateEnteredAt: entered, regionLastChangedAt: new Map(regions) };
}

function strip(screen: string): string[] {
    return screen.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
}

// ── Divider-LESS approval (the stalling form from the live get_spec_debug) ──
// Claude Code's "Do you want to proceed?" approvals draw NO box-divider (────)
// above the numbered choices. The old modal anchor only matched a divider line,
// so the modal section resolved EMPTY → no buttons → auto-approve never fired →
// the session stalled in approval.
const dividerlessApproval = [
    '▗ ▗   ▖ ▖  Claude Code v2.1.153',
    '  ▘▘ ▝▝    ~/Work/adhdev',
    '',
    '⏺ I will edit the file now.',
    '',
    'Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    '',
    ' Esc to cancel · Tab to amend · ctrl+e to explain',
].join('\n');

// ── Divider-BASED modal (must NOT regress) ──
const dividerApproval = [
    '▗ ▗   ▖ ▖  Claude Code v2.1.153',
    '  ▘▘ ▝▝    ~/Work/adhdev',
    '',
    '⏺ Here is the change.',
    '────────────────────────────────────────────────────────────────',
    'Edit file src/index.ts?',
    ' ❯ 1. Yes',
    '   2. No, tell Claude what to do differently',
    '',
    ' Esc to cancel',
].join('\n');

describe('claude-cli v4 FSM — divider-less approval modal', () => {
    const spec = loadSpec();

    it('spec is valid', () => {
        expect(spec.$schema).toBe('adhdev:cli/spec@4');
        expect(spec.id).toBe('claude-cli');
    });

    it('→approval fires on a divider-less proceed prompt', () => {
        const lines = strip(dividerlessApproval);
        const row = lines.length - 1;
        const ev = evaluateFsm(spec, 'busy', dividerlessApproval, { row, col: 2 }, undefined, clk(10000, 0));
        expect(ev.fired?.to).toBe('approval');
    });

    it('modal section resolves NON-EMPTY and contains the choices for a divider-less prompt', () => {
        const lines = strip(dividerlessApproval);
        const sections = resolveSections(spec.sections ?? {}, lines);
        const modal = sectionText(sections, 'modal', lines.join('\n'));
        expect(modal.trim().length).toBeGreaterThan(0);
        expect(modal).toContain('Do you want to proceed?');
        expect(modal).toContain('Yes');
        expect(modal).toContain('1.');
        expect(modal).toContain('2.');
    });

    it('extracts buttons + title from a divider-less prompt so positive-hint can fire', () => {
        const approval = spec.states.find(s => s.id === 'approval')!;
        const lines = strip(dividerlessApproval);
        const sections = resolveSections(spec.sections ?? {}, lines);
        const title = extractTitle(approval.extract!.title!, sections, lines.join('\n'));
        expect(title).toBe('Do you want to proceed?');
        const rule = approval.extract!.buttons!;
        const hay = sectionText(sections, rule.section, lines.join('\n'));
        const buttons = extractButtonsFromRule(rule, hay);
        expect(buttons.map(b => b.index)).toEqual([1, 2]);
        expect(buttons[0].key).toBe('1\r');
        // A positive-hint label ("Yes") is present for auto-approve to match.
        expect(buttons.map(b => b.label).join(' ')).toMatch(/yes/i);
    });

    it('does NOT regress the divider-based modal', () => {
        const approval = spec.states.find(s => s.id === 'approval')!;
        const lines = strip(dividerApproval);
        const row = lines.length - 1;
        const ev = evaluateFsm(spec, 'busy', dividerApproval, { row, col: 2 }, undefined, clk(10000, 0));
        expect(ev.fired?.to).toBe('approval');

        const sections = resolveSections(spec.sections ?? {}, lines);
        const modal = sectionText(sections, 'modal', lines.join('\n'));
        // Divider anchor wins (preferred entry): modal starts at the line just
        // below the ──── divider, NOT at an arbitrary body line.
        expect(modal).toContain('Edit file src/index.ts?');
        expect(modal).not.toContain('Here is the change.');
        const rule = approval.extract!.buttons!;
        const hay = sectionText(sections, rule.section, lines.join('\n'));
        const buttons = extractButtonsFromRule(rule, hay);
        expect(buttons.map(b => b.index)).toEqual([1, 2]);
        expect(buttons[0].key).toBe('1\r');
    });
});

// ── Spinner-glyph unification (false-idle root fix) ───────────────────────────
// Live root cause: the busy→idle not-spinner check and the idle→busy spinner
// check used a narrow inline glyph set (8 Braille frames + a few asterisks). When
// a tool ran, claude-cli's spinner cycled through OTHER glyphs in the full Braille
// range (U+2800–U+28FF) or showed only the textual "esc to interrupt" cue. Those
// frames did not match the narrow set, so:
//   - idle→busy failed to re-fire after a brief idle blip → stuck idle, and
//   - busy→idle's not-spinner clause read TRUE (no glyph matched) → false idle.
// Fix: both transitions now match the full Braille range + asterisk frames + the
// "esc to interrupt/stop" cue, aligned with provider.v1.json tui.spinner. The
// completion footer (✻ … for Ns, no token) is a SEPARATE glyph (✻ ∉ spinner set)
// and must keep driving busy→idle — it must not be misread as a spinner.

// All screens carry the real generating-layout chrome (input box + footer hints)
// so the spinner/footer line resolves into the `body` section, mirroring a live
// claude-cli frame. Without the input box the modal section swallows the screen.

// A busy screen mid-tool: the spinner is a richer Braille frame NOT in the old
// narrow set, plus the "esc to interrupt" cue. No completion footer present.
const richSpinnerBusy = [
    '▗ ▗   ▖ ▖  Claude Code v2.1.153',
    '  ▘▘ ▝▝    ~/Work/adhdev',
    '',
    '⏺ Let me run the tests.',
    '',
    '⣾ Running the test suite… (esc to interrupt)',
    '',
    '────────────────────────────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────────────────────────────',
    '  ⏵⏵ accept edits on (shift+tab to cycle)',
].join('\n');

// Another mid-tool frame whose only generation cue is the textual interrupt hint
// appearing mid-line (no leading spinner glyph this frame).
const interruptCueOnly = [
    '▗ ▗   ▖ ▖  Claude Code v2.1.153',
    '  ▘▘ ▝▝    ~/Work/adhdev',
    '',
    '⏺ Working on it.',
    '',
    'Bloviating about edge cases (esc to interrupt · ctrl+t to hide todos)',
    '',
    '────────────────────────────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────────────────────────────',
    '  ⏵⏵ accept edits on (shift+tab to cycle)',
].join('\n');

// A real completion footer: settled ✻ glyph + "for Ns", no token counter. This is
// what legitimately ends generation → busy→idle.
const completionFooter = [
    '▗ ▗   ▖ ▖  Claude Code v2.1.153',
    '  ▘▘ ▝▝    ~/Work/adhdev',
    '',
    '⏺ Done — all tests pass.',
    '',
    '✻ Compacting conversation for 12s',
    '',
    '────────────────────────────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────────────────────────────',
    '  ⏵⏵ accept edits on (shift+tab to cycle)',
].join('\n');

describe('claude-cli v4 FSM — spinner glyph unification', () => {
    const spec = loadSpec();

    it('(a) idle→busy fires on a rich Braille spinner frame outside the old narrow set', () => {
        const ev = evaluateFsm(spec, 'idle', richSpinnerBusy, undefined, undefined, clk(5000, 0));
        expect(ev.fired?.to).toBe('busy');
    });

    it('(a) idle→busy fires on a mid-line "esc to interrupt" cue with no leading glyph', () => {
        const ev = evaluateFsm(spec, 'idle', interruptCueOnly, undefined, undefined, clk(5000, 0));
        expect(ev.fired?.to).toBe('busy');
    });

    it('(a) busy STAYS busy on a rich Braille spinner frame (no false idle)', () => {
        // Clock is well past every busy→idle time gate (stable 6s, hold 800ms) so
        // the only thing keeping it busy is the not-spinner clause reading the rich
        // spinner as "still spinning". Pre-fix this frame slipped through to idle.
        const ev = evaluateFsm(spec, 'busy', richSpinnerBusy, undefined, undefined, clk(20000, 0));
        expect(ev.fired?.to).not.toBe('idle');
    });

    it('(b) busy→idle fires on a genuine completion footer once stable (no regression)', () => {
        const ev = evaluateFsm(spec, 'busy', completionFooter, undefined, undefined, clk(20000, 0));
        expect(ev.fired?.to).toBe('idle');
    });

    it('(c) the completion footer glyph (✻) is NOT misclassified as a spinner', () => {
        // If ✻ leaked into the spinner set, the not-spinner clause of busy→idle
        // would read FALSE on the footer and idle would never be reached — a
        // false-busy stall. Assert the spinner condition itself does not match.
        const busyToIdle = spec.transitions.find(t => t.label === 'busy→idle')!;
        const notSpinner = (busyToIdle.when as any).all.find(
            (c: any) => c.not && c.not.matches && c.not.matches.includes('2800'));
        const spinnerRe = new RegExp(notSpinner.not.matches, 'i');
        expect(spinnerRe.test('✻ Compacting conversation for 12s')).toBe(false);
        // ...but a real spinner frame still matches.
        expect(spinnerRe.test('⣾ Running the test suite… (esc to interrupt)')).toBe(true);
    });

    it('(c) approval-modal "Esc to cancel" footer is NOT read as a spinner cue', () => {
        // The spinner cue is "esc to interrupt/stop", deliberately excluding the
        // approval modal's "Esc to cancel" — otherwise an approval screen would
        // look like generation.
        const idleToBusy = spec.transitions.find(t => t.label === 'idle→busy')!;
        const spinnerRe = new RegExp((idleToBusy.when as any).matches, 'i');
        expect(spinnerRe.test(' Esc to cancel · Tab to amend · ctrl+e to explain')).toBe(false);
    });
});
