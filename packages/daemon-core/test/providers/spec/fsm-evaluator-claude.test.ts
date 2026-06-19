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

// ── busy→idle completion-footer position guard (false-idle root fix #2) ──────
// Live root cause (Windows Spec Debug Snapshot): the busy→idle completion-footer
// clause `✻ … for <dur>` matched a STALE footer left over from a *previous* turn
// while the session was still generating. The footer line sits above the active
// spinner in the `body` section, so when the spinner frame momentarily lacked its
// trailing ellipsis (e.g. `✽ Ebbing (3m 29s · ↑ 10.1k tokens)`), the not-spinner
// clause flipped TRUE and busy→idle fired off the stale footer → false idle, with
// the session oscillating busy↔idle every few seconds.
//
// Fix: the footer match is now position-constrained. It only counts as a genuine
// end-of-turn footer when (a) the footer line itself carries no token counter
// (· ↑/↓ N tokens) and (b) NO active-spinner frame / "esc to interrupt" cue /
// token counter appears anywhere below it (through to the input-box chrome).
// A live progress line — with OR without an ellipsis that frame — therefore keeps
// the session busy. The duration-only completion footer still drives idle.

const FRAME_HEAD = [
    '▗ ▗   ▖ ▖  Claude Code v2.1.153',
    '  ▘▘ ▝▝    ~/Work/adhdev',
    '',
];
const FRAME_TAIL = [
    '',
    '────────────────────────────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────────────────────────────',
    '  ⏵⏵ accept edits on (shift+tab to cycle)',
];
function frame(...mid: string[]): string {
    return [...FRAME_HEAD, ...mid, ...FRAME_TAIL].join('\n');
}

describe('claude-cli v4 FSM — busy→idle completion-footer position guard', () => {
    const spec = loadSpec();

    // (a) Active spinner WITH the elapsed/token progress trailer, plus a stale
    // completion footer above it from the prior turn. Must STAY busy.
    it('(a) stale footer above an active spinner trailer → stays busy (no false idle)', () => {
        const screen = frame(
            '⏺ Did the thing',
            '',
            '✻ Baked for 7s',
            '',
            '✽ Ebbing… (3m 29s · ↑ 10.1k tokens)',
        );
        const ev = evaluateFsm(spec, 'busy', screen, undefined, undefined, clk(20000, 0));
        expect(ev.fired?.to).not.toBe('idle');
    });

    // (a') Same, but the spinner frame has NO trailing ellipsis — the exact frame
    // that defeated the old not-spinner clause. The position guard must still win.
    it("(a') stale footer above a spinner frame WITHOUT ellipsis → stays busy", () => {
        const screen = frame(
            '⏺ Did the thing',
            '',
            '✻ Baked for 7s',
            '',
            '✽ Ebbing (3m 29s · ↑ 10.1k tokens)',
        );
        const ev = evaluateFsm(spec, 'busy', screen, undefined, undefined, clk(20000, 0));
        expect(ev.fired?.to).not.toBe('idle');
    });

    // (b) A genuine completion footer (no token, nothing active below) → idle.
    it('(b) genuine completion footer "✻ Baked for 7s" once stable → idle', () => {
        const screen = frame('⏺ Done.', '', '✻ Baked for 7s');
        const ev = evaluateFsm(spec, 'busy', screen, undefined, undefined, clk(20000, 0));
        expect(ev.fired?.to).toBe('idle');
    });

    // (c) Compound-duration completion footer → idle.
    it('(c) compound-duration footer "✻ Worked for 8m 24s" → idle', () => {
        const screen = frame('⏺ Done.', '', '✻ Worked for 8m 24s');
        const ev = evaluateFsm(spec, 'busy', screen, undefined, undefined, clk(20000, 0));
        expect(ev.fired?.to).toBe('idle');
    });

    // (d) The footer line itself carries a token counter — that is a live progress
    // line, not a completion footer. Must STAY busy.
    it('(d) footer line with "· ↑ N tokens" trailer → stays busy', () => {
        const screen = frame('⏺ working', '', '✻ Worked for 7s · ↑ 1.2k tokens');
        const ev = evaluateFsm(spec, 'busy', screen, undefined, undefined, clk(20000, 0));
        expect(ev.fired?.to).not.toBe('idle');
    });

    // The position guard itself accepts a completion footer that sits below an
    // older spinner frame (the spinner is above, the footer is the latest line).
    // The separate not-spinner clause is intentionally conservative and still
    // holds busy while ANY spinner glyph remains on screen — eliminating false
    // idle takes priority over the rarer stale-spinner-above-footer frame. Assert
    // the footer clause does not, on its own, reject this layout.
    it('(e) footer clause accepts a completion footer below a stale spinner', () => {
        const busyToIdle = spec.transitions.find(t => t.label === 'busy→idle')!;
        const footerClause = (busyToIdle.when as any).all.find(
            (c: any) => typeof c.matches === 'string' && c.matches.includes('for')) as { matches: string };
        const footerRe = new RegExp(footerClause.matches, 'i');
        const body = ['✽ Thinking… (1s)', '', '✻ Baked for 7s'].join('\n');
        expect(footerRe.test(body)).toBe(true);
    });
});

// ── busy→idle footer-anchored spinner guard (false-idle root fix #3) ──────────
// Live root cause (Spec Debug Snapshot): claude-cli was actively generating —
// the bottom of the screen showed a progress spinner `✢ Spelunking… (1m 37s ·
// ↓ 6.1k tokens)` plus the `esc to interrupt` cue — yet the FSM read idle.
//
// The reason: claude draws the active progress line BELOW the `❯` input prompt
// (inside the input-box chrome). The footer section anchors on the prompt
// (`^[❯›>]`, anchor_last) and runs to EOF, so the spinner + `esc to interrupt`
// land in the `footer` section, NOT `body`. The busy→idle not-spinner clause was
// scoped to `section: "body"`, so it never saw the footer spinner → read TRUE
// ("no spinner"). Meanwhile a STALE completion footer (`✻ Baked for 7s`) from a
// prior turn still sat in `body`, so the completion-footer clause matched too.
// not-spinner TRUE + footer TRUE + stable TRUE → false idle while generating.
//
// Fix: the not-spinner clause now scans the WHOLE screen (section omitted →
// sectionText() returns the full screen), so an active spinner / esc-to-interrupt
// cue ANYWHERE — body, footer, or modal chrome — keeps the session busy. The
// completion-footer clause stays `section: "body"` (its position is correct), and
// stable_ms was raised 6000→8000 as an extra settle margin. A genuine completion
// (spinner gone, only the duration footer remains) still drives idle — proving
// this is a guard, not an over-fix.

// A generating frame where the active spinner sits BELOW the prompt box, with a
// stale completion footer left in the body from the previous turn. This is the
// exact layout that produced the live false idle.
const footerAnchoredSpinner = [
    '▗ ▗   ▖ ▖  Claude Code v2.1.153',
    '  ▘▘ ▝▝    ~/Work/adhdev',
    '',
    '⏺ Earlier output line',
    '',
    '✻ Baked for 7s',                  // STALE completion footer, in `body`
    '',
    '────────────────────────────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────────────────────────────',
    '✢ Spelunking… (1m 37s · ↓ 6.1k tokens)',   // active spinner, in `footer`
    '  esc to interrupt',
].join('\n');

// Same idea but the only generation cue below the prompt is the textual
// "esc to interrupt" hint (no leading spinner glyph this frame).
const footerAnchoredInterruptCue = [
    '▗ ▗   ▖ ▖  Claude Code v2.1.153',
    '  ▘▘ ▝▝    ~/Work/adhdev',
    '',
    '⏺ Earlier output line',
    '',
    '✻ Worked for 12s',                // STALE completion footer, in `body`
    '',
    '────────────────────────────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────────────────────────────',
    '  esc to interrupt · ctrl+t to hide todos',  // interrupt cue in `footer`
].join('\n');

// A genuine completion: the spinner / interrupt cue is gone, only the duration
// completion footer remains in `body`. Must still go idle (no over-fix).
const genuineCompletionNoSpinner = [
    '▗ ▗   ▖ ▖  Claude Code v2.1.153',
    '  ▘▘ ▝▝    ~/Work/adhdev',
    '',
    '⏺ Done.',
    '',
    '✻ Baked for 7s',                  // duration completion footer, in `body`
    '',
    '────────────────────────────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────────────────────────────',
    '  ⏵⏵ accept edits on (shift+tab to cycle)',
].join('\n');

describe('claude-cli v4 FSM — footer-anchored spinner false-idle guard', () => {
    const spec = loadSpec();

    it('the busy→idle not-spinner clause is whole-screen scoped (no section)', () => {
        // The clause must NOT be body-scoped, or a spinner in the footer section
        // (below the prompt) is invisible to it and false idle returns.
        const busyToIdle = spec.transitions.find(t => t.label === 'busy→idle')!;
        const notSpinner = (busyToIdle.when as any).all.find(
            (c: any) => c.not && c.not.matches && c.not.matches.includes('2800'));
        expect(notSpinner).toBeTruthy();
        expect(notSpinner.not.section).toBeUndefined();
    });

    it('confirms the spinner lands in the footer section, not body', () => {
        // Documents WHY the body-scoped clause failed: section resolution puts
        // the active spinner + esc-to-interrupt in `footer`, and the stale
        // completion footer in `body`.
        const lines = strip(footerAnchoredSpinner);
        const sections = resolveSections(spec.sections ?? {}, lines);
        const body = sectionText(sections, 'body', lines.join('\n'));
        const footer = sectionText(sections, 'footer', lines.join('\n'));
        expect(footer).toContain('Spelunking');
        expect(footer).toContain('esc to interrupt');
        expect(body).not.toContain('Spelunking');
        expect(body).toContain('✻ Baked for 7s'); // stale footer is in body
    });

    it('STAYS busy when an active spinner sits below the prompt (footer section)', () => {
        // Clock is well past every time gate (stable 8s, hold 800ms) so only the
        // whole-screen not-spinner clause can hold it busy. Pre-fix → idle.
        const ev = evaluateFsm(spec, 'busy', footerAnchoredSpinner, undefined, undefined, clk(30000, 0));
        expect(ev.fired?.to).not.toBe('idle');
    });

    it('STAYS busy when only an "esc to interrupt" cue sits below the prompt', () => {
        const ev = evaluateFsm(spec, 'busy', footerAnchoredInterruptCue, undefined, undefined, clk(30000, 0));
        expect(ev.fired?.to).not.toBe('idle');
    });

    it('still goes idle on a genuine completion (spinner gone) — not an over-fix', () => {
        const ev = evaluateFsm(spec, 'busy', genuineCompletionNoSpinner, undefined, undefined, clk(30000, 0));
        expect(ev.fired?.to).toBe('idle');
    });

    it('busy→idle stable_ms is 8000 (raised settle margin)', () => {
        const busyToIdle = spec.transitions.find(t => t.label === 'busy→idle')!;
        const stable = (busyToIdle.when as any).all.find((c: any) => typeof c.stable_ms === 'number');
        expect(stable.stable_ms).toBe(8000);
    });
});
