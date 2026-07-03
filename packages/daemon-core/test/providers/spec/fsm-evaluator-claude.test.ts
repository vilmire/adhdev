import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import { evaluateFsm, stableRegionKey, type FsmClock } from '../../../src/providers/spec/fsm-evaluator.js';
import { resolveSections, sectionText, extractButtonsFromRule, extractTitle } from '../../../src/providers/spec/evaluator.js';
import { filterIgnoredLines } from '../../../src/providers/spec/fsm-driver.js';
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

function clk(now: number, entered: number, regions: [number | string, number][] = []): FsmClock {
    return { now, stateEnteredAt: entered, regionLastChangedAt: new Map(regions) };
}

/** The regionLastChangedAt key the given transition's stable clause watches.
 *  Derived from the spec so a change to the clause's region/ignore_lines keeps
 *  these tests honest instead of hard-coding a brittle key string. */
function stableKeyOf(spec: CliSpecV4, label: string): number | string {
    const t = spec.transitions.find(tr => tr.label === label)!;
    const stable = (t.when as any).all.find((c: any) => typeof c.stable_ms === 'number');
    return stableRegionKey(stable);
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

// ── FALSEIDLE2: ellipsis-less spinner + whole-screen stable gate ──────────────
// Live re-occurrence (rc.354 / 5d100a17): busy→idle's all(3) read TRUE while the
// agent was actively generating, firing a false idle (→ early completion notif,
// then a second on the real idle = double completion notification). Root causes
// the prior fixes (a63485a position-guard, fix#3 whole-screen not-spinner) did
// NOT close:
//
//   (Gap B) the not-spinner clause REQUIRED a trailing ellipsis (…|...), so an
//           ellipsis-less progress frame — claude's newer format
//           `✽ Ebbing (3m · ↑10k tokens)` — slipped through (not-spinner TRUE)
//           even though the glyph IS in the spinner set. Whole-screen scope (fix
//           #3) didn't help because the regex itself didn't match the frame.
//   (Gap A) the stable clause keyed on `cursor_above: 4` — the 4 lines ABOVE the
//           composer cursor. But claude draws the active spinner + ticking
//           elapsed timer BELOW the cursor (footer/input chrome), so the watched
//           region was static during generation → stable trivially satisfied.
//
// Fix (spec-only): (1) relax the spinner regex to match glyph+word with EITHER
// ellipsis OR an elapsed-time (`\d+[smh]`) / token-counter (`↑/↓ N tokens`)
// trailer OR the esc-to-interrupt cue — ellipsis no longer required. The same
// regex is shared by idle→busy / busy→idle / approval→busy / approval→idle
// (unify maintained). (2) drop `cursor_above` from the busy→idle stable clause so
// it measures WHOLE-SCREEN quiet — the below-cursor spinner tick now resets the
// 8s timer every second, making a false idle during generation structurally
// impossible regardless of the spinner frame's exact format.

describe('claude-cli v4 FSM — FALSEIDLE2 ellipsis-less spinner + whole-screen stable', () => {
    const spec = loadSpec();

    // The exact live false-idle layout: an active spinner with NO trailing
    // ellipsis and NO esc cue sits below the prompt (footer section); a stale
    // completion footer from the prior turn sits in body. Only the relaxed
    // not-spinner clause (matching the glyph + token trailer) can hold it busy.
    const footerSpinnerEllipsisLessNoEsc = [
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
        '✽ Ebbing (3m · ↑10k tokens)',     // active spinner below prompt, NO ellipsis, NO esc
    ].join('\n');

    // A genuine completion: spinner/timer gone, only the duration footer remains.
    const genuineCompletion = [
        '▗ ▗   ▖ ▖  Claude Code v2.1.153',
        '  ▘▘ ▝▝    ~/Work/adhdev',
        '',
        '⏺ Done.',
        '',
        '✻ Worked for 8s',                 // duration completion footer, in `body`
        '',
        '────────────────────────────────────────────────────────────────',
        '❯ ',
        '────────────────────────────────────────────────────────────────',
        '  ⏵⏵ accept edits on (shift+tab to cycle)',
    ].join('\n');

    it('(a) ellipsis-less active spinner keeps busy (not-spinner now FALSE)', () => {
        // Clock is well past every time gate (stable 8s, hold 800ms), so only the
        // relaxed not-spinner clause can hold busy. Pre-fix (ellipsis required)
        // → not-spinner TRUE → false idle. Post-fix → matches via token trailer.
        const ev = evaluateFsm(spec, 'busy', footerSpinnerEllipsisLessNoEsc, undefined, undefined, clk(30000, 0));
        expect(ev.fired?.to).not.toBe('idle');
    });

    it('(a/unit) the relaxed spinner regex matches an ellipsis-less progress frame', () => {
        const busyToIdle = spec.transitions.find(t => t.label === 'busy→idle')!;
        const notSpinner = (busyToIdle.when as any).all.find(
            (c: any) => c.not && c.not.matches && c.not.matches.includes('2800'));
        const re = new RegExp(notSpinner.not.matches, 'i');
        expect(re.test('✽ Ebbing (3m · ↑10k tokens)')).toBe(true);   // ellipsis-less, token trailer
        expect(re.test('✢ Spelunking (1m 37s · ↓ 6.1k tokens)')).toBe(true);
        expect(re.test('✽ Ebbing… (3m 29s · ↑ 10.1k tokens)')).toBe(true); // ellipsis still works
        // completion footer (✻ ∉ spinner set) must NOT be read as a spinner.
        expect(re.test('✻ Worked for 8s')).toBe(false);
        expect(re.test('✻ Compacting conversation for 12s')).toBe(false);
    });

    it('(b) busy→idle stable clause stays whole-screen (no cursor_above) but content-aware', () => {
        // The clause is still whole-screen scoped (no cursor_above) so a below-
        // cursor spinner tick still resets the timer — the FALSEIDLE2 structural
        // fix for Gap A. SESSION-STATE-WEDGE additionally adds `ignore_lines` so a
        // benign residual ticker (bare token counter / ✻ elapsed line) does NOT
        // reset it; the two together let a real spinner hold busy while a settled
        // transcript still reaches stable.
        const busyToIdle = spec.transitions.find(t => t.label === 'busy→idle')!;
        const stable = (busyToIdle.when as any).all.find((c: any) => typeof c.stable_ms === 'number');
        expect(stable.stable_ms).toBe(8000);
        expect(stable.cursor_above).toBeUndefined();
        expect(stable.section).toBeUndefined();
        expect(typeof stable.ignore_lines).toBe('string');
    });

    it('(b) a recent spinner-driven whole-screen change holds busy even on a completion-looking frame', () => {
        // genuineCompletion looks idle (not-spinner TRUE, footer TRUE) but the
        // whole screen changed 1s ago on a NON-ignored line (a spinner tick analog)
        // — the driver records that into the clause's ignore-scoped key. Whole-
        // screen stable is unsatisfied → stays busy.
        const key = stableKeyOf(spec, 'busy→idle');
        const ev = evaluateFsm(spec, 'busy', genuineCompletion, undefined, undefined, clk(30000, 0, [[key, 29000]]));
        expect(ev.fired?.to).not.toBe('idle');
    });

    it('(c) genuine completion (screen quiet ≥8s) → idle', () => {
        // No recent whole-screen change (regionLastChangedAt empty → measured from
        // stateEnteredAt=0): quiet 30s ≥ 8s, not-spinner TRUE, footer TRUE → idle.
        const ev = evaluateFsm(spec, 'busy', genuineCompletion, undefined, undefined, clk(30000, 0));
        expect(ev.fired?.to).toBe('idle');
    });

    it('(d) completion footer "✻ Worked for 8s" stays idle-eligible (glyph outside spinner set)', () => {
        const idleToBusy = spec.transitions.find(t => t.label === 'idle→busy')!;
        const re = new RegExp((idleToBusy.when as any).matches, 'i');
        // ✻ is not in the spinner glyph set even with the relaxed trailer, so a
        // duration completion footer never re-arms idle→busy as a spinner.
        expect(re.test('✻ Worked for 8s')).toBe(false);
    });

    it('(obs) a fired regex transition carries matchedText without changing the decision (SPECDBG)', () => {
        // SPECDBG debug-only enrichment: evalCond captures the substring a TRUE
        // regex matched, purely for the Spec Debug Snapshot. The transition
        // decision must be unchanged (still fires to busy).
        const ev = evaluateFsm(spec, 'idle', richSpinnerBusy, undefined, undefined, clk(5000, 0));
        expect(ev.fired?.to).toBe('busy');           // decision unchanged
        expect(ev.fired?.cond?.result).toBe(true);
        expect(typeof ev.fired?.cond?.matchedText).toBe('string');
        expect(ev.fired?.cond?.matchedText).toMatch(/Running the test suite|esc to interrupt/);
    });

    it('(obs) a FALSE regex leaf carries no matchedText; the TRUE footer leaf does (SPECDBG)', () => {
        // genuineCompletion has no spinner → the not-clause's inner regex is
        // FALSE (no snippet captured); the TRUE footer regex captures one.
        const ev = evaluateFsm(spec, 'busy', genuineCompletion, undefined, undefined, clk(30000, 0));
        expect(ev.fired?.to).toBe('idle');
        const all = ev.fired?.cond?.children ?? [];
        const notSpinner = all.find(c => c.kind === 'not');
        const footer = all.find(c => c.kind === 'regex' && c.result);
        expect(notSpinner?.children?.[0]?.matchedText).toBeUndefined();
        expect(typeof footer?.matchedText).toBe('string');
    });

    it('(unify) all four spinner-detecting clauses use the identical regex', () => {
        const m = (l: string) => spec.transitions.find(t => t.label === l)!.when as any;
        const i2b = m('idle→busy').matches;
        const b2i = m('busy→idle').all[0].not.matches;
        // approval→busy (R4 AUTOAPPROVE/sticky-approval guard) is now all:[ {not: footer ❯ 1.},
        // {not: footer Esc to cancel}, {not: Do you want to proceed?}, {stable_ms,cursor_above},
        // {matches: <spinner>} ]. The spinner regex is the trailing flat positive clause (no
        // section, no not) — read it from there so the "all four spinner clauses use the
        // identical regex" invariant still holds post-merge.
        const a2b = m('approval→busy').all.find((c: any) => c.matches && !c.section && !c.not).matches;
        // approval→idle keeps the spinner as a negated body clause: {not:{section:'body',matches:<spinner>}}.
        const a2i = m('approval→idle').all.find((c: any) => c.not && c.not.section === 'body' && c.not.matches).not.matches;
        expect(b2i).toBe(i2b);
        expect(a2b).toBe(i2b);
        expect(a2i).toBe(i2b);
    });
});

// ── (a) modal button extraction survives a divider BELOW the choices ──────────
// Live root cause (auto-approve stall): the modal section's preferred anchor is a
// bare `────` rule (^[─╌]+$, anchor_last). claude renders an approval as
//   ────────────  (rule above the modal)
//    Bash command / … / Do you want to proceed?
//    ❯ 1. Yes / 2. No
//   ────────────  (a CLOSING rule below the choices)
//    Esc to cancel …
// anchor_last latched the LOWER closing rule, so the modal section resolved to
// just "────\n Esc to cancel" — extractButtonsFromRule returned 0 buttons,
// deriveModal returned null (< min_count 2), activeModal went null, and the
// auto-approve gate bailed (`if (!modal || buttons.length === 0) return`) so the
// approval never auto-fired. The →approval transition still fired (footer ❯ 1.
// is visible), so the session sat in approval forever.
//
// Fix (evaluator.ts): an array anchor now resolves each candidate independently
// and picks the TOPMOST resolved line. The divider-less fallback candidate
// (the question line just above the numbered choices) sits ABOVE the closing
// rule, so it wins and the section spans the whole modal → buttons extract.

const D = '─'.repeat(64);

// The exact snapshot shape: header "Bash command", the question, ❯ 1. Yes / 2.
// No, and an "Esc to cancel" footer hint — WITH a closing divider below the
// choices (the form that stranded the buttons pre-fix).
const bashApprovalDividerBelow = [
    '❯ Run the build for me',
    '',
    '⏺ Bash(npm run build)',
    ' ⎿  Running…',
    '',
    D,
    ' Bash command',
    '',
    ' npm run build',
    ' Run shell command',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    ' 2. No',
    D,
    ' Esc to cancel · Tab to amend · ctrl+e to explain',
].join('\n');

describe('claude-cli v4 FSM — modal buttons survive a divider below the choices', () => {
    const spec = loadSpec();

    it('→approval still fires (footer ❯ 1. is visible)', () => {
        const ev = evaluateFsm(spec, 'busy', bashApprovalDividerBelow, { row: 12, col: 2 }, undefined, clk(10000, 0));
        expect(ev.fired?.to).toBe('approval');
    });

    it('modal section spans the choices, not the closing rule', () => {
        const lines = strip(bashApprovalDividerBelow);
        const sections = resolveSections(spec.sections ?? {}, lines);
        const modal = sectionText(sections, 'modal', lines.join('\n'));
        expect(modal).toContain('Do you want to proceed?');
        expect(modal).toContain('1. Yes');
        expect(modal).toContain('2. No');
        // Must NOT collapse to just the closing rule + footer hint.
        expect(modal.trim().startsWith('Esc to cancel')).toBe(false);
    });

    it('extracts both buttons so the auto-approve gate can fire (was 0 → null)', () => {
        const approval = spec.states.find(s => s.id === 'approval')!;
        const lines = strip(bashApprovalDividerBelow);
        const sections = resolveSections(spec.sections ?? {}, lines);
        const rule = approval.extract!.buttons!;
        const hay = sectionText(sections, rule.section, lines.join('\n'));
        const buttons = extractButtonsFromRule(rule, hay);
        expect(buttons.map(b => b.index)).toEqual([1, 2]);
        expect(buttons[0].key).toBe('1\r');
        expect(buttons.map(b => b.label).join(' ')).toMatch(/yes/i);
        // min_count (2) is met → deriveModal would return a non-null modal.
        expect(buttons.length).toBeGreaterThanOrEqual(rule.min_count ?? 2);
    });

    // Same modal but ALSO trailed by the input-box chrome (──── / ❯ / ──── /
    // ⏵⏵) — two more bare dividers below the choices. The topmost-landmark rule
    // must still anchor on the question line above the choices.
    it('survives input-box chrome below the choices too', () => {
        const screen = [
            '⏺ Bash(npm run build)', ' ⎿  Running…', '',
            D, ' Bash command', '', ' npm run build', ' Run shell command', '',
            ' Do you want to proceed?', ' ❯ 1. Yes', ' 2. No', '',
            D, '❯ ', D, ' ⏵⏵ accept edits on (shift+tab to cycle)',
        ].join('\n');
        const lines = strip(screen);
        const sections = resolveSections(spec.sections ?? {}, lines);
        const rule = spec.states.find(s => s.id === 'approval')!.extract!.buttons!;
        const hay = sectionText(sections, rule.section, lines.join('\n'));
        const buttons = extractButtonsFromRule(rule, hay);
        expect(buttons.map(b => b.index)).toEqual([1, 2]);
    });
});

// ── (c) approval→busy footer guard (approval sticky) ─────────────────────────
// approval→idle guards on `not footer ❯ 1.` (the modal is gone) but approval→busy
// did NOT — so a residual spinner / "esc to interrupt" cue left over from the
// pre-approval turn flipped the FSM approval→busy while the modal's "❯ 1." choice
// was STILL on screen. That collapsed the live modal to a generating state, the
// modal stopped being surfaced, and auto-approve never fired (the 2nd-order flap).
// Fix (4.0.json): approval→busy now also requires the footer ❯ 1. anchor to be
// ABSENT, mirroring approval→idle. While the modal is up, approval is sticky.

describe('claude-cli v4 FSM — approval→busy footer guard (sticky approval)', () => {
    const spec = loadSpec();

    it('approval→busy when-clause carries the not-footer ❯ 1. guard', () => {
        const t = spec.transitions.find(tr => tr.label === 'approval→busy')!;
        const clauses = (t.when as any).all as any[];
        expect(Array.isArray(clauses)).toBe(true);
        const guard = clauses.find(c => c.not && c.not.section === 'footer'
            && typeof c.not.matches === 'string' && c.not.matches.includes('1\\.'));
        expect(guard).toBeTruthy();
    });

    // Modal still up (footer ❯ 1.) AND a residual spinner in the body. Pre-fix
    // this flipped to busy; now approval is sticky.
    const stickyApproval = [
        '❯ Run the build please',
        '',
        '⏺ Bash(npm run build)',
        ' ⎿  Running…',
        '✶ Finishing up… (esc to interrupt)',
        D,
        ' Bash command',
        ' npm run build',
        ' Do you want to proceed?',
        ' ❯ 1. Yes',
        ' 2. No',
        '',
        ' Esc to cancel · Tab to amend',
    ].join('\n');

    // Genuine resume: the modal is gone (no ❯ 1.), the spinner is active → busy.
    const genuineResume = [
        '❯ Run the build please',
        '',
        '⏺ Bash(npm run build)',
        '✶ Finishing up… (esc to interrupt)',
        '',
        D, '❯ ', D,
        ' ⏵⏵ accept edits on (shift+tab to cycle)',
    ].join('\n');

    it('STAYS in approval while the modal ❯ 1. is still on screen (residual spinner)', () => {
        // Clock well past min_hold (1500ms) so only the footer guard holds it.
        const ev = evaluateFsm(spec, 'approval', stickyApproval, { row: 9, col: 2 }, undefined, clk(10000, 0));
        expect(ev.fired?.to).not.toBe('busy');
    });

    it('approval→busy still fires once the modal dismisses and the spinner is active', () => {
        const ev = evaluateFsm(spec, 'approval', genuineResume, { row: 6, col: 2 }, undefined, clk(10000, 0));
        expect(ev.fired?.to).toBe('busy');
    });

    // ── APPROVAL-BUSY-FLICKER (live snapshot b4232227) ─────────────────────
    // The remaining gap the not-footer(❯ 1.)/not-footer(Esc to cancel) guards
    // did NOT close: a TORN repaint frame where BOTH footer markers are
    // momentarily gone (so both not-footer guards PASS) while the modal box +
    // its "Do you want to proceed?" question are still on screen and a body
    // spinner animates. Pre-fix that single torn frame satisfied approval→busy;
    // the next full frame re-fired →approval (priority 100, no hold), producing
    // the ~1.5s approval↔busy oscillation (the period == approval→busy min_hold).
    // Fix: approval→busy additionally requires (a) NOT "Do you want to proceed?"
    // anywhere, and (b) the modal region (cursor_above 12) stable for 700ms — a
    // one-frame tear can satisfy neither.
    const tornApproval = [
        '❯ Run the build please',
        '',
        '⏺ Bash(npm run build)',
        '  ⎿  Running…',
        '✳ Scurrying… (esc to interrupt)',   // body spinner animating
        D,
        ' Bash command',
        ' npm run build',
        ' Do you want to proceed?',           // modal question STILL up
        '',                                   // ← ❯ 1. Yes / Esc to cancel rows
        D,                                    //   not yet repainted this frame
    ].join('\n');

    it('(flicker) the proceed-question guard is present on approval→busy', () => {
        const clauses = (spec.transitions.find(t => t.label === 'approval→busy')!.when as any).all as any[];
        const proceedGuard = clauses.find(c => c.not && !c.not.section
            && typeof c.not.matches === 'string' && /Do you want to proceed/.test(c.not.matches));
        expect(proceedGuard, 'approval→busy missing not(Do you want to proceed?) guard').toBeTruthy();
        const stableGuard = clauses.find(c => typeof c.stable_ms === 'number');
        expect(stableGuard, 'approval→busy missing stable_ms tear guard').toBeTruthy();
    });

    it('(flicker) STAYS in approval on a torn frame: footer markers gone but question still up', () => {
        // Clock past min_hold (1500ms); the proceed-question guard alone blocks busy.
        const ev = evaluateFsm(spec, 'approval', tornApproval, { row: 11, col: 2 }, undefined, clk(10000, 0));
        expect(ev.fired?.to).not.toBe('busy');
    });

    it('(flicker) a single torn paint cannot demote: modal region not stable long enough', () => {
        // Even hypothesising the question string were absent, the modal region
        // (cursor_above 12) changed 100ms ago → stable_ms(700) unsatisfied → no busy.
        const ev = evaluateFsm(spec, 'approval', tornApproval, { row: 11, col: 2 }, undefined, clk(10000, 0, [[-1, 9900], [12, 9900]]));
        expect(ev.fired?.to).not.toBe('busy');
    });
});

// ── FALSEBUSY: middle-dot (·) body text false-matching the spinner glyph set ──
// Live root cause (coordinator claude-cli session 4b86ddc6, busy held ~26 min):
// the spinner glyph class led with `·` (U+00B7 MIDDLE DOT). That glyph is NOT a
// distinguishing claude spinner frame (claude animates with the asterisk frames
// ✢✳✶✽✷✸✹ and the Braille range ⠀-⣿), but `·` is a common prose / list bullet.
// A mission-list body line such as `· WARMUPGAP — guard dispatch-row updates…`
// (bullet + word + trailing ellipsis) therefore matched the spinner regex. Because
// the busy→idle not-spinner clause is — deliberately — whole-screen scoped (the
// FALSEIDLE2 / footer-anchored-spinner fixes, so a real spinner BELOW the prompt is
// still seen), that body line kept not-spinner FALSE forever → busy→idle never
// satisfied its all(3) → the session stuck busy. The same `·` also let idle→busy
// false-fire on the bullet, falsely ENTERING busy from a quiet prompt.
//
// Fix (spec-only, minimal): drop `·` from the shared spinner glyph class in all
// four spinner-detecting clauses (idle→busy / busy→idle / approval→busy /
// approval→idle) AND from the busy→idle completion-footer spinner-below lookahead.
// Whole-screen scope is UNCHANGED (FALSEIDLE2 invariant preserved) — only the one
// prose-colliding glyph is removed, so real asterisk / Braille spinners still hold
// busy while mission-list bullets no longer masquerade as a spinner.

describe('claude-cli v4 FSM — FALSEBUSY middle-dot body false-match', () => {
    const spec = loadSpec();
    const Dline = '─'.repeat(64);

    // A quiet idle prompt whose body is a `·`-bulleted mission list (the exact
    // shape that false-matched). Footer is the ❯ composer, no spinner, no modal.
    const missionListIdle = [
        '▗ ▗   ▖ ▖  Claude Code v2.1.153',
        '  ▘▘ ▝▝    ~/Work/adhdev',
        '',
        '⏺ Here are the active missions:',
        '· WARMUPGAP — guard dispatch-row updates…',
        '· FALSEIDLE2 — ellipsis-less spinner regex…',
        '· SPECDBG 등',
        '',
        Dline, '❯ ', Dline,
        '  ⏵⏵ accept edits on (shift+tab to cycle)',
    ].join('\n');

    // Same mission-list body but WITH a genuine completion footer present, so the
    // busy→idle completion-footer clause is satisfiable — the recovery path that
    // was wedged shut by the `·` line holding not-spinner FALSE.
    const missionListWithCompletion = [
        '▗ ▗   ▖ ▖  Claude Code v2.1.153',
        '  ▘▘ ▝▝    ~/Work/adhdev',
        '',
        '⏺ Done. Active missions:',
        '· WARMUPGAP — guard dispatch-row updates…',
        '· SPECDBG 등',
        '',
        '✻ Worked for 8s',
        '',
        Dline, '❯ ', Dline,
        '  ⏵⏵ accept edits on (shift+tab to cycle)',
    ].join('\n');

    // A real generating frame: Braille spinner + esc cue (must still hold busy).
    const realBrailleBusy = [
        '▗ ▗   ▖ ▖  Claude Code v2.1.153',
        '  ▘▘ ▝▝    ~/Work/adhdev',
        '',
        '⏺ Let me run the tests.',
        '',
        '⣾ Running the test suite… (esc to interrupt)',
        '',
        Dline, '❯ ', Dline,
        '  ⏵⏵ accept edits on (shift+tab to cycle)',
    ].join('\n');

    it('(guard) idle→busy does NOT false-fire on a `·`-bulleted mission list', () => {
        // Pre-fix: `· WARMUPGAP … updates…` matched the spinner regex → false busy.
        const ev = evaluateFsm(spec, 'idle', missionListIdle, undefined, undefined, clk(5000, 0));
        expect(ev.fired?.to).not.toBe('busy');
    });

    it('(entry) idle→busy still fires on a real asterisk spinner (✢ Slithering…)', () => {
        const slither = missionListIdle.replace('⏺ Here are the active missions:', '✢ Slithering… (esc to interrupt)');
        const ev = evaluateFsm(spec, 'idle', slither, undefined, undefined, clk(5000, 0));
        expect(ev.fired?.to).toBe('busy');
    });

    it('(entry) idle→busy still fires on a real Braille spinner (⣾ …)', () => {
        const ev = evaluateFsm(spec, 'idle', realBrailleBusy, undefined, undefined, clk(5000, 0));
        expect(ev.fired?.to).toBe('busy');
    });

    it('(recovery) busy→idle escapes once a `·` line no longer blocks not-spinner', () => {
        // not-spinner now TRUE (the `·` line is no longer a spinner), completion
        // footer present, screen quiet ≥8s → idle. Pre-fix: stuck busy forever.
        const ev = evaluateFsm(spec, 'busy', missionListWithCompletion, undefined, undefined, clk(30000, 0));
        expect(ev.fired?.to).toBe('idle');
    });

    it('(FALSEIDLE2 preserved) busy STAYS busy on a real Braille spinner frame', () => {
        const ev = evaluateFsm(spec, 'busy', realBrailleBusy, undefined, undefined, clk(30000, 0));
        expect(ev.fired?.to).not.toBe('idle');
    });

    it('(FALSEIDLE2 preserved) busy→idle not-spinner clause stays whole-screen scoped', () => {
        // The fix must NOT re-scope the clause to a section — that is the exact
        // regression the bottom-anchoring approach would have caused.
        const busyToIdle = spec.transitions.find(t => t.label === 'busy→idle')!;
        const notSpinner = (busyToIdle.when as any).all.find(
            (c: any) => c.not && c.not.matches && c.not.matches.includes('2800'));
        expect(notSpinner.not.section).toBeUndefined();
    });

    it('(unit) the spinner regex drops `·` but keeps real spinner glyphs', () => {
        const idleToBusy = spec.transitions.find(t => t.label === 'idle→busy')!;
        const re = new RegExp((idleToBusy.when as any).matches, 'i');
        // prose bullet no longer reads as a spinner
        expect(re.test('· WARMUPGAP — guard dispatch-row updates…')).toBe(false);
        expect(re.test('· SPECDBG 등')).toBe(false);
        // real claude spinner frames still match
        expect(re.test('✢ Slithering… (esc to interrupt)')).toBe(true);
        expect(re.test('⣾ Running the test suite… (esc to interrupt)')).toBe(true);
        expect(re.test('✽ Ebbing (3m · ↑10k tokens)')).toBe(true);
        // `·` is gone from the glyph class itself
        expect((idleToBusy.when as any).matches).not.toContain('[·');
    });

    it('(unify) all four spinner clauses still share the identical (de-dotted) regex', () => {
        const m = (l: string) => spec.transitions.find(t => t.label === l)!.when as any;
        const i2b = m('idle→busy').matches;
        const b2i = m('busy→idle').all[0].not.matches;
        const a2b = m('approval→busy').all.find((c: any) => c.matches && !c.section && !c.not).matches;
        const a2i = m('approval→idle').all.find((c: any) => c.not && c.not.section === 'body' && c.not.matches).not.matches;
        expect(b2i).toBe(i2b);
        expect(a2b).toBe(i2b);
        expect(a2i).toBe(i2b);
        expect(i2b).not.toContain('[·');
    });
});

// ── FALSEBUSY mechanism B: completion footer pushed out of the viewport ───────
// Live root cause (coordinator "Cody" claude-cli sessions): mesh tool-call output /
// mission lists / JSON convergence reports FILL the 32-row viewport, so BOTH the
// generation `esc to interrupt` cue AND the `✻ … for Ns` completion footer scroll
// out of the visible viewport. The session is genuinely idle (no spinner glyph, the
// body is static), yet busy→idle wedges: cond1 not-spinner = TRUE, cond3 stable =
// TRUE, but cond2 (the `✻ … for Ns` completion footer, HARD-required) = FALSE
// forever → all() never satisfied → permanent busy (observed ~26 min).
//
// Fix (additive, spec-only): a parallel `busy→idle-quiet` transition that drives
// idle on whole-screen no-spinner + a longer whole-screen stable window
// (stable_ms 12000), WITHOUT requiring the completion footer. The original
// busy→idle (footer fast-path, 8s) is left byte-identical, so every existing
// FALSEIDLE2 / footer-position / SPECDBG test is untouched. This is safe against
// false-idle because claude-cli draws a per-second ticking elapsed timer during
// generation (whole-screen changes every ~1s → 12s stable is never reached while
// generating) and is NOT focus-gated (no refocus_when_stalled_ms stall-freeze).

describe('claude-cli v4 FSM — FALSEBUSY B: footer pushed out of viewport (Cody)', () => {
    const spec = loadSpec();
    const Dline = '─'.repeat(64);

    // A "Cody-type" idle screen: mesh/JSON/mission output fills the viewport; the
    // generation esc cue and the ✻…for Ns completion footer have BOTH scrolled out.
    // Genuinely idle (no spinner glyph), ❯ composer at the bottom.
    const codyIdle = [
        '⏺ Mission convergence report:',
        '{ "missions": [',
        '    {"id":"WARMUPGAP","status":"done"},',
        '    {"id":"FALSEIDLE2","status":"done"},',
        '    {"id":"FALSEBUSY","status":"active"} ],',
        '  "nodes": 4, "note": "footer pushed out of viewport" }',
        '· WARMUPGAP — guard dispatch-row updates',
        '· SPECDBG — PTY event timeline',
        '1. converge providers', '2. relocate oss test', '3. await approval',
        'Done. Awaiting next instruction.',
        Dline, '❯ ', Dline,
        '  ⏵⏵ accept edits on (shift+tab to cycle)',
    ].join('\n');

    // Same, but the body fills to the last line — even the ❯ composer is pushed out.
    const codyIdleNoComposer = [
        '⏺ Mission convergence report:',
        '{ "missions":[{"id":"FALSEBUSY","status":"active"}], "nodes":4 }',
        '· WARMUPGAP — guard dispatch-row updates',
        '· SPECDBG — PTY event timeline',
        '1. converge providers', '2. relocate oss test', '3. await approval',
        'Done. Awaiting next instruction. (no composer / footer visible)',
    ].join('\n');

    // Actively generating: a real spinner sits at the bottom (esc cue in-frame).
    const codyGenerating = [
        '⏺ Mission convergence report:',
        '{ "missions": [ {"id":"FALSEBUSY","status":"active"} ] }',
        '· WARMUPGAP — guard dispatch-row updates',
        '1. converge providers', '2. relocate oss test',
        '✢ Spelunking… (1m 37s · ↓ 6.1k tokens · esc to interrupt)',
        Dline, '❯ ', Dline,
        '  ⏵⏵ accept edits on (shift+tab to cycle)',
    ].join('\n');

    it('(repro) original-style stick: cond2 footer required — see busy→idle alone', () => {
        // The footer fast-path alone cannot fire (no ✻…for Ns). It is the additive
        // busy→idle-quiet transition that recovers — asserted below.
        const busyToIdle = spec.transitions.find(t => t.label === 'busy→idle')!;
        const footerClause = (busyToIdle.when as any).all.find(
            (c: any) => typeof c.matches === 'string' && c.matches.includes('for'));
        expect(new RegExp(footerClause.matches).test(codyIdle)).toBe(false); // no completion footer on screen
    });

    it('(recovery) Cody idle → idle via busy→idle-quiet once whole-screen quiet ≥12s', () => {
        const ev = evaluateFsm(spec, 'busy', codyIdle, undefined, undefined, clk(30000, 0));
        expect(ev.fired?.to).toBe('idle');
    });

    it('(recovery) Cody idle with even the composer pushed out → still idle', () => {
        const ev = evaluateFsm(spec, 'busy', codyIdleNoComposer, undefined, undefined, clk(30000, 0));
        expect(ev.fired?.to).toBe('idle');
    });

    it('(no false-idle) Cody generating (spinner in-frame) → stays busy', () => {
        const ev = evaluateFsm(spec, 'busy', codyGenerating, undefined, undefined, clk(30000, 0));
        expect(ev.fired?.to).not.toBe('idle');
    });

    it('(no false-idle) Cody generating, whole-screen changed 2s ago → stays busy', () => {
        // Spinner tick 2s ago keeps the whole-screen stable timer under 12s.
        const key = stableKeyOf(spec, 'busy→idle-quiet');
        const ev = evaluateFsm(spec, 'busy', codyGenerating, undefined, undefined, clk(60000, 0, [[key, 58000]]));
        expect(ev.fired?.to).not.toBe('idle');
    });

    it('(gate) Cody idle settled only 9s → not yet idle (12s window)', () => {
        const key = stableKeyOf(spec, 'busy→idle-quiet');
        const ev = evaluateFsm(spec, 'busy', codyIdle, undefined, undefined, clk(60000, 0, [[key, 51000]]));
        expect(ev.fired?.to).not.toBe('idle');
    });

    it('(fast-path intact) a genuine completion footer still drives idle at 8s', () => {
        const footerDone = [
            '▗ ▗   ▖ ▖  Claude Code v2.1.153', '  ▘▘ ▝▝    ~/Work/adhdev', '',
            '⏺ Done.', '', '✻ Worked for 8s', '',
            Dline, '❯ ', Dline, '  ⏵⏵ accept edits on (shift+tab to cycle)',
        ].join('\n');
        const ev = evaluateFsm(spec, 'busy', footerDone, undefined, undefined, clk(30000, 0));
        expect(ev.fired?.to).toBe('idle');
    });

    it('(FALSEIDLE2 preserved) original busy→idle unchanged; quiet transition added', () => {
        const orig = spec.transitions.find(t => t.label === 'busy→idle')!;
        const notSpinner = (orig.when as any).all.find(
            (c: any) => c.not && c.not.matches && c.not.matches.includes('2800'));
        expect(notSpinner.not.section).toBeUndefined();                  // still whole-screen
        expect((orig.when as any).all.find((c: any) => typeof c.stable_ms === 'number').stable_ms).toBe(8000);
        const quiet = spec.transitions.find(t => t.label === 'busy→idle-quiet') as any;
        expect(quiet).toBeTruthy();
        expect(quiet.from).toBe('busy');
        expect(quiet.to).toBe('idle');
        // quiet reuses the SAME whole-screen not-spinner clause (no section) + a longer stable.
        expect(quiet.when.all[0].not.section).toBeUndefined();
        expect(quiet.when.all[0].not.matches).toBe(notSpinner.not.matches);
        expect(quiet.when.all.find((c: any) => typeof c.stable_ms === 'number').stable_ms).toBe(12000);
    });

    it('(FALSEIDLE2 preserved) a real Braille spinner still holds busy on the quiet path too', () => {
        const realSpin = [
            '▗ ▗   ▖ ▖  Claude Code v2.1.153', '  ▘▘ ▝▝    ~/Work/adhdev', '',
            '⏺ Working', '', '⣾ Running the test suite… (esc to interrupt)', '',
            Dline, '❯ ', Dline, '  ⏵⏵ accept edits on (shift+tab to cycle)',
        ].join('\n');
        const ev = evaluateFsm(spec, 'busy', realSpin, undefined, undefined, clk(30000, 0));
        expect(ev.fired?.to).not.toBe('idle');
    });

    it('(no false-idle) a streaming token counter (no spinner glyph) holds busy on the quiet path', () => {
        // '✻ Worked for 7s · ↑ 1.2k tokens' has NO spinner glyph (✻ is excluded) but a
        // live token counter — a generation signal. The quiet path's token guard must
        // keep it busy even when the frame looks stable. Plain JSON 'tokens' (no ↑/↓
        // arrow) does NOT trip it, so genuine Cody idle still recovers (covered above).
        const tokenProgress = [
            '▗ ▗   ▖ ▖  Claude Code v2.1.153', '  ▘▘ ▝▝    ~/Work/adhdev', '',
            '⏺ working', '', '✻ Worked for 7s · ↑ 1.2k tokens', '',
            Dline, '❯ ', Dline, '  ⏵⏵ accept edits on (shift+tab to cycle)',
        ].join('\n');
        const ev = evaluateFsm(spec, 'busy', tokenProgress, undefined, undefined, clk(30000, 0));
        expect(ev.fired?.to).not.toBe('idle');
        // a token counter that is part of plain JSON output (no arrow) must NOT block recovery
        const quiet = spec.transitions.find(t => t.label === 'busy→idle-quiet') as any;
        const tokenGuard = quiet.when.all.find((c: any) => c.not && /tokens\?/.test(c.not.matches) && !c.not.matches.includes('2800'));
        const re = new RegExp(tokenGuard.not.matches, 'i');
        expect(re.test('"tokens": 1234, "nodes": 4')).toBe(false);
        expect(re.test('✻ Worked for 7s · ↑ 1.2k tokens')).toBe(true);
    });

    // ── SESSION-STATE-WEDGE (결함2): content-aware ignore_lines ────────────────
    // The wedge: after generation finishes, a benign residual ticker keeps
    // repainting the whole screen every frame (a bare token counter, an elapsed
    // timer, a ✻ line). Pre-fix the whole-screen stable clock reset on every
    // such tick → busy→idle / busy→idle-quiet never reached stable_ms → the
    // session latched 'generating' for tens of minutes despite being idle.
    //
    // Fix: `ignore_lines` on the stable clauses strips those benign lines before
    // the change comparison. It is CONTENT-based: an active spinner line does NOT
    // match, so the FALSEIDLE2 "below-prompt spinner tick holds busy" invariant
    // survives (asserted just above and here).

    it('(wedge) busy→idle & busy→idle-quiet stable clauses carry an ignore_lines filter', () => {
        for (const label of ['busy→idle', 'busy→idle-quiet']) {
            const t = spec.transitions.find(tr => tr.label === label)! as any;
            const stable = t.when.all.find((c: any) => typeof c.stable_ms === 'number');
            expect(typeof stable.ignore_lines).toBe('string');
        }
    });

    it('(wedge) ignore_lines matches benign residual tickers but NOT active spinners', () => {
        const stable = (spec.transitions.find(t => t.label === 'busy→idle-quiet')!.when as any)
            .all.find((c: any) => typeof c.stable_ms === 'number');
        const re = new RegExp(stable.ignore_lines, 'm');
        // benign residual animation that must be filtered (would otherwise wedge):
        expect(re.test('✻ Worked for 29s')).toBe(true);            // frozen/ticking elapsed line
        expect(re.test('✻ Compacting conversation for 12s')).toBe(true);
        expect(re.test('  ↑ 6.1k tokens')).toBe(true);             // bare token counter line
        expect(re.test('↓ 12.3k tokens · 4 files')).toBe(true);
        // active spinners must NOT be filtered — a real tick must still hold busy:
        expect(re.test('✽ Ebbing (3m · ↑10k tokens)')).toBe(false);
        expect(re.test('✢ Spelunking… (1m 37s · ↓ 6.1k tokens)')).toBe(false);
        expect(re.test('⣾ Running the test suite… (esc to interrupt)')).toBe(false);
        // ordinary transcript lines are untouched:
        expect(re.test('⏺ Done. Awaiting next instruction.')).toBe(false);
        expect(re.test('· WARMUPGAP — guard dispatch-row updates')).toBe(false);
    });

    it('(wedge/driver) filterIgnoredLines masks benign ticker deltas but keeps spinner deltas', () => {
        // This is exactly the comparison the driver's trackRegionChanges runs to
        // decide whether the whole-screen stable clock resets. Two frames that
        // differ ONLY on ignored lines must compare EQUAL (no reset → can settle);
        // a frame whose spinner line changed must compare UNEQUAL (reset → busy).
        const stable = (spec.transitions.find(t => t.label === 'busy→idle-quiet')!.when as any)
            .all.find((c: any) => typeof c.stable_ms === 'number');
        const re = new RegExp(stable.ignore_lines, 'm');
        const join = (ls: string[]) => filterIgnoredLines(ls, re).join('\n');

        // Frame N and N+1 differ only on a ticking ✻-elapsed line and a token
        // counter — both ignored. Post-filter the two frames are identical.
        const frameA = ['⏺ Done.', '✻ Worked for 7s', '  ↑ 1.1k tokens', '❯ '];
        const frameB = ['⏺ Done.', '✻ Worked for 8s', '  ↑ 1.3k tokens', '❯ '];
        expect(join(frameA)).toBe(join(frameB));

        // But when the active spinner line itself changes frame-to-frame, the
        // filter leaves it in → the frames differ → the clock resets (busy held).
        const spinA = ['⏺ Working', '⣾ Running the test suite… (esc to interrupt)', '❯ '];
        const spinB = ['⏺ Working', '⣿ Running the test suite… (esc to interrupt)', '❯ '];
        expect(join(spinA)).not.toBe(join(spinB));
    });

    it('(wedge) a settled Cody frame with the ignore-key never marked changed → recovers idle', () => {
        // The wedge scenario expressed at the evaluator boundary: the ONLY thing
        // that animated post-completion was a benign ticker, so the driver never
        // records a change into the clause's ignore-scoped key. With that key
        // absent (measured from state entry), a 30s-old busy state is quiet ≥12s →
        // busy→idle-quiet fires. codyIdle has no spinner and no arrow-token line.
        const ev = evaluateFsm(spec, 'busy', codyIdle, undefined, undefined, clk(30000, 0));
        expect(ev.fired?.to).toBe('idle');
    });
});

// ── APPROVESTUCK fixA: decisive footer-marker gate on the approval modal ──────
// Root cause (live, cd/untrusted-hooks modal): the →approval transition keyed ONLY
// on the footer `❯ 1.` anchor. But the footer section is `^[❯›>]` anchor_last — the
// LAST prompt-cursor line through EOF — so a composer line a worker typed that
// starts with "1." (rendered `❯ 1. converge providers …`) IS the footer and matched
// `[❯›>]\s*1\.`, false-entering approval with no real modal on screen. The active
// claude approval modal ALWAYS renders its decisive chrome — the `Esc to cancel ·
// Tab to amend · ctrl+e to explain` footer and/or the `Do you want to proceed?`
// question (both visible in every real-screen fixture above) — so →approval now
// also requires one of those markers. Stickiness on approval→busy / approval→idle is
// reinforced with the same `Esc to cancel` footer guard (modal up ⇒ never idle).

describe('claude-cli v4 FSM — APPROVESTUCK footer-marker approval gate (fixA)', () => {
    const spec = loadSpec();
    const Dline = '─'.repeat(64);

    // A quiet composer where a worker typed a numbered line starting "1." — this is
    // the EXACT false-match: the composer (footer) reads `❯ 1. …`, no modal present.
    const composerTypedNumber = [
        '▗ ▗   ▖ ▖  Claude Code v2.1.153',
        '  ▘▘ ▝▝    ~/Work/adhdev',
        '',
        '⏺ Here is the plan.',
        '',
        Dline,
        '❯ 1. converge providers then relocate the oss test',
        Dline,
        '  ⏵⏵ accept edits on (shift+tab to cycle)',
    ].join('\n');

    it('(unit) →approval when-clause requires ❯ 1. AND the footer-scoped "Esc to cancel" invariant', () => {
        // APPROVAL-FALSE-POSITIVE fix: the decisive marker is now a REQUIRED footer-scoped
        // "Esc to cancel" leg (promoted out of the prior any[]), and the whole-screen
        // "Do you want to proceed?" leg is removed. "Esc to cancel" is the true invariant —
        // present in footer+modal scope across all approval boxes — whereas
        // "Do you want to proceed?" varies by approval kind (file-write boxes ask a different
        // question) and, being whole-screen scoped, matched assistant body / scrollback /
        // pasted commands → false approval. The footer scope binds the marker to the actual box.
        const t = spec.transitions.find(tr => tr.label === '→approval')!;
        const all = (t.when as any).all as any[];
        expect(Array.isArray(all)).toBe(true);
        const footerChoice = all.find(c => c.section === 'footer' && typeof c.matches === 'string' && c.matches.includes('1\\.'));
        expect(footerChoice).toBeTruthy();
        // The decisive marker is a direct, footer-scoped AND leg — no any[] fallback.
        const escMarker = all.find(c => c.section === 'footer' && typeof c.matches === 'string' && /Esc to cancel/.test(c.matches));
        expect(escMarker).toBeTruthy();
        // The loose whole-screen "Do you want to proceed?" leg must be gone entirely.
        const hasWholeScreenProceed = all.some(c =>
            (typeof c.matches === 'string' && /Do you want to proceed/.test(c.matches) && c.section !== 'footer' && c.section !== 'modal')
            || (Array.isArray(c.any) && c.any.some((s: any) => typeof s.matches === 'string' && /Do you want to proceed/.test(s.matches))));
        expect(hasWholeScreenProceed).toBe(false);
    });

    it('does NOT false-enter approval on a composer-typed "❯ 1." line (no modal marker)', () => {
        // The footer ❯ 1. anchor matches (proving the old gate WOULD have fired)...
        const footerClause = (spec.transitions.find(t => t.label === '→approval')!.when as any)
            .all.find((c: any) => c.section === 'footer' && c.matches.includes('1\\.'));
        const lines = strip(composerTypedNumber);
        const sections = resolveSections(spec.sections ?? {}, lines);
        const footer = sectionText(sections, 'footer', lines.join('\n'));
        expect(new RegExp(footerClause.matches).test(footer)).toBe(true);
        // ...but with no decisive marker the transition must NOT fire approval.
        const ev = evaluateFsm(spec, 'busy', composerTypedNumber, { row: 6, col: 2 }, undefined, clk(10000, 0));
        expect(ev.fired?.to).not.toBe('approval');
    });

    it('DOES enter approval once the same screen carries the decisive marker', () => {
        const withModal = composerTypedNumber
            .replace('⏺ Here is the plan.', 'Do you want to proceed?')
            .replace('❯ 1. converge providers then relocate the oss test', ' ❯ 1. Yes')
            .replace('  ⏵⏵ accept edits on (shift+tab to cycle)', ' Esc to cancel · Tab to amend · ctrl+e to explain');
        const ev = evaluateFsm(spec, 'busy', withModal, { row: 6, col: 2 }, undefined, clk(10000, 0));
        expect(ev.fired?.to).toBe('approval');
    });

    it('real divider-less / divider / bash approval screens still enter approval (no regression)', () => {
        for (const screen of [dividerlessApproval, dividerApproval, bashApprovalDividerBelow]) {
            const lines = strip(screen);
            const ev = evaluateFsm(spec, 'busy', screen, { row: lines.length - 1, col: 2 }, undefined, clk(10000, 0));
            expect(ev.fired?.to).toBe('approval');
        }
    });

    it('(sticky) approval→busy AND approval→idle carry the not-footer "Esc to cancel" guard', () => {
        for (const label of ['approval→busy', 'approval→idle']) {
            const clauses = (spec.transitions.find(t => t.label === label)!.when as any).all as any[];
            const guard = clauses.find(c => c.not && c.not.section === 'footer'
                && typeof c.not.matches === 'string' && /Esc to cancel/.test(c.not.matches));
            expect(guard, `${label} missing Esc to cancel guard`).toBeTruthy();
        }
    });

    it('(sticky) STAYS in approval while the "Esc to cancel" footer is up, even without ❯ 1.', () => {
        // Modal chrome where the choice line momentarily lacks the ❯ marker but the
        // decisive "Esc to cancel" footer is still rendered + a residual spinner.
        // Pre-fix the not(footer ❯ 1.) guard alone would let approval→busy fire.
        const markerStillUp = [
            '❯ Run the build please',
            '',
            '⏺ Bash(npm run build)',
            '✶ Finishing up… (esc to interrupt)',
            Dline,
            ' Bash command',
            ' Do you want to proceed?',
            '   1. Yes',
            '   2. No',
            '',
            ' Esc to cancel · Tab to amend',
        ].join('\n');
        const ev = evaluateFsm(spec, 'approval', markerStillUp, { row: 7, col: 2 }, undefined, clk(10000, 0));
        expect(ev.fired?.to).not.toBe('busy');
        expect(ev.fired?.to).not.toBe('idle');
    });
});
