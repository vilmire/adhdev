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
        path.join(repoRoot, 'adhdev-providers/cli/codex-cli/specs/4.0.json'),
        path.join(process.env.HOME ?? '', '.adhdev/providers/.upstream/cli/codex-cli/specs/4.0.json'),
    ];
    const found = candidates.find(p => fs.existsSync(p));
    if (!found) throw new Error('codex-cli 4.0.json spec not found in: ' + candidates.join(', '));
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

// Codex sections:
//   footer: anchor "tab to queue message|⏎\s+send|^\s*[›>]\s*$" (anchor_last)
//   modal: from_bottom 36, until footer
//   body: from_top 0, until modal
//
// modal=from_bottom 36 means the 36 lines above footer form the modal zone.
// body is everything above that. So we need at least 38 lines to get 1+ body lines.
// Use 50-line screens: body = lines 0-12, modal = lines 13-48, footer = line 49.

function makeScreen(bodyContent: string[], footerLine = '  tab to queue message  ·  ⏎ send'): string {
    // 50-line screen: body occupies first lines, rest is empty/modal, footer is last
    const lines: string[] = [...bodyContent];
    while (lines.length < 49) lines.push('');
    lines.push(footerLine);
    return lines.join('\n');
}

// A live-layout busy screen: codex draws the `Working (` / `esc to interrupt`
// spinner near the BOTTOM (just above the composer prompt), so it lands in the
// `status_tail` (from_bottom:12) window — the section every busy-cue check is
// now scoped to (SPINNER-BODY-SELFMATCH fix). Placing the spinner high in the
// body — as an assistant answer quoting the cue would — must NOT read as busy.
function makeBusyScreen(bodyContent: string[], spinnerLine: string): string {
    const lines: string[] = [...bodyContent];
    while (lines.length < 46) lines.push('');
    lines.push(spinnerLine);            // spinner in the tail window
    lines.push('');
    lines.push('› ');                   // composer prompt below the spinner
    lines.push('  tab to queue message  ·  ⏎ send');
    return lines.join('\n');
}

function makeScreenWithModal(bodyContent: string[], modalContent: string[]): string {
    const lines: string[] = [...bodyContent];
    // body occupies first lines, pad to leave room
    while (lines.length < 13) lines.push('');
    // modal content in modal zone (lines 13-48 = 36 lines)
    const paddedModal: string[] = [...modalContent];
    while (paddedModal.length < 35) paddedModal.unshift('');
    lines.push(...paddedModal.slice(0, 35));
    // Footer: must match the anchor ("tab to queue message" | "⏎ send" | lone ›)
    lines.push('  ›');
    return lines.join('\n');
}

// Codex idle screen (no composer prompt rendered yet — e.g. banner only)
const idleScreen = makeScreen([
    '',
    '  codex v0.9.1 · gpt-4o · ~/Work/myproject',
    '',
]);

// Codex idle screen with the composer prompt line rendered (`› ` at line start).
// This is the content anchor that gates the startup-grace → idle fast path.
const composerReadyScreen = makeScreen([
    '',
    '  codex v0.9.1 · gpt-4o · ~/Work/myproject',
    '',
    '› ',
    '',
]);

// Active busy: shows "Working (" spinner in the live status tail
const busyScreen = makeBusyScreen([
    '  Writing the implementation...',
    '',
], '  Working (⣿ 3s)');

// MCP init screen
const mcpInitScreen = makeScreen([
    '',
    '  Starting MCP servers (2/3)...',
    '',
]);

// Approval screen
const approvalScreen = makeScreenWithModal(
    ['  Codex wants to run:', '  rm -rf ./tmp', ''],
    [
        '  Would you like to run the following command?',
        '  › 1. Yes',
        '    2. No',
        '',
    ]
);

// Trust screen
const trustScreen = makeScreenWithModal(
    ['  ~/Work/sensitive-project', ''],
    [
        '  Do you trust the contents of this directory?',
        '  › 1. Yes, trust this directory',
        '    2. No, use safe mode',
        '',
    ]
);

// Done: no spinner
const doneScreen = makeScreen([
    '  Task completed successfully.',
    '  Modified 3 files.',
    '',
]);

// Short task
const shortBusyScreen = makeBusyScreen([
    '  OK',
    '',
], '  Working (⣾ 1s)');

describe('codex-cli v4 FSM', () => {
    const spec = loadSpec();

    it('spec is valid', () => {
        expect(spec.$schema).toBe('adhdev:cli/spec@4');
        expect(spec.id).toBe('codex-cli');
    });

    // Startup-grace is now dual-safety: content-anchor (composer prompt rendered
    // + screen quiescent) fires early, else an 8000ms blind fallback. The blind
    // 5000ms timer was too short for codex's real startup (directory-trust /
    // "Starting MCP servers" / composer first-paint) and flushed pendingSends
    // while the composer was still redrawing — codex's clear/repaint then
    // swallowed the head (~200 chars) of the paste. See RCA.

    it('stays in starting before content anchor and before 8s fallback', () => {
        const row = idleScreen.split('\n').length - 1;
        // No composer prompt rendered, only 2s elapsed → neither branch fires.
        const ev = evaluateFsm(spec, 'starting', idleScreen, { row, col: 2 }, undefined, clk(2000, 0));
        expect(ev.fired).toBeNull();
    });

    it('does NOT idle at 6s when the composer prompt has not rendered (old 5s timer removed)', () => {
        const row = idleScreen.split('\n').length - 1;
        // 6s elapsed but < 8s fallback AND no composer anchor → still starting.
        const ev = evaluateFsm(spec, 'starting', idleScreen, { row, col: 2 }, undefined, clk(6000, 0));
        expect(ev.fired).toBeNull();
    });

    it('starting → idle via 8s blind fallback when composer never anchors', () => {
        const row = idleScreen.split('\n').length - 1;
        const ev = evaluateFsm(spec, 'starting', idleScreen, { row, col: 2 }, undefined, clk(8500, 0));
        expect(ev.fired?.to).toBe('idle');
    });

    it('starting → idle early (before 8s) once the composer prompt renders and screen is quiescent', () => {
        const row = composerReadyScreen.split('\n').length - 1;
        // Composer `› ` present, not MCP-initing, not Working, and the region has
        // been stable ≥1500ms → content anchor fires well before the 8s fallback.
        const ev = evaluateFsm(spec, 'starting', composerReadyScreen, { row, col: 2 }, undefined, clk(2000, 0));
        expect(ev.fired?.to).toBe('idle');
    });

    it('composer rendered but NOT yet stable → stays in starting (no premature flush)', () => {
        const row = composerReadyScreen.split('\n').length - 1;
        // Region changed 200ms ago (< stable_ms 1500) → still redrawing, hold.
        const ev = evaluateFsm(
            spec, 'starting', composerReadyScreen, { row, col: 2 }, undefined,
            clk(1000, 0, [[-1, 800], [4, 800]]),
        );
        expect(ev.fired).toBeNull();
    });

    it('idle → busy on Working ( spinner in body', () => {
        const row = busyScreen.split('\n').length - 1;
        const ev = evaluateFsm(spec, 'idle', busyScreen, { row, col: 2 }, undefined, clk(10000, 5000));
        expect(ev.fired?.to).toBe('busy');
    });

    it('idle → mcp_init on Starting MCP servers in body', () => {
        const row = mcpInitScreen.split('\n').length - 1;
        const ev = evaluateFsm(spec, 'idle', mcpInitScreen, { row, col: 2 }, undefined, clk(10000, 5000));
        expect(ev.fired?.to).toBe('mcp_init');
    });

    it('mcp_init → busy once Working appears in body', () => {
        const row = busyScreen.split('\n').length - 1;
        const ev = evaluateFsm(spec, 'mcp_init', busyScreen, { row, col: 2 }, undefined, clk(10000, 5000));
        expect(ev.fired?.to).toBe('busy');
    });

    it('→approval takes priority over →busy (approval during generation)', () => {
        const row = approvalScreen.split('\n').length - 1;
        const ev = evaluateFsm(spec, 'busy', approvalScreen, { row, col: 2 }, undefined, clk(10000, 0));
        expect(ev.fired?.to).toBe('approval');
    });

    it('→trust fires at highest priority from any state', () => {
        const row = trustScreen.split('\n').length - 1;
        for (const from of ['starting', 'idle', 'busy', 'mcp_init']) {
            const ev = evaluateFsm(spec, from, trustScreen, { row, col: 2 }, undefined, clk(10000, 0));
            expect(ev.fired?.to).toBe('trust');
        }
    });

    it('busy stays until spinner gone + stable (min_hold_ms not passed)', () => {
        const row = doneScreen.split('\n').length - 1;
        const ev = evaluateFsm(spec, 'busy', doneScreen, { row, col: 2 }, undefined, clk(300, 0));
        expect(ev.fired).toBeNull();
    });

    it('busy → idle once spinner gone + stable 1500ms', () => {
        const row = doneScreen.split('\n').length - 1;
        const ev = evaluateFsm(spec, 'busy', doneScreen, { row, col: 2 }, undefined, clk(2000, 0));
        expect(ev.fired?.to).toBe('idle');
    });

    it('sequential short tasks: idle → busy again after returning to idle', () => {
        const rowBusy = shortBusyScreen.split('\n').length - 1;
        const rowDone = doneScreen.split('\n').length - 1;
        // First goes busy
        const ev1 = evaluateFsm(spec, 'idle', shortBusyScreen, { row: rowBusy, col: 2 }, undefined, clk(10000, 8000));
        expect(ev1.fired?.to).toBe('busy');
        // After done and stable, returns to idle
        const ev2 = evaluateFsm(spec, 'busy', doneScreen, { row: rowDone, col: 2 }, undefined, clk(2000, 0));
        expect(ev2.fired?.to).toBe('idle');
        // Then goes busy again on next task
        const ev3 = evaluateFsm(spec, 'idle', shortBusyScreen, { row: rowBusy, col: 2 }, undefined, clk(12000, 10000));
        expect(ev3.fired?.to).toBe('busy');
    });

    it('consecutive approvals: approval→idle then →approval again', () => {
        const rowDone = doneScreen.split('\n').length - 1;
        const rowApproval = approvalScreen.split('\n').length - 1;
        // After approval dismissed, idle comes back
        const ev1 = evaluateFsm(spec, 'approval', doneScreen, { row: rowDone, col: 2 }, undefined, clk(1500, 0));
        expect(ev1.fired?.to).toBe('idle');
        // Then another approval
        const ev2 = evaluateFsm(spec, 'idle', approvalScreen, { row: rowApproval, col: 2 }, undefined, clk(10000, 8000));
        expect(ev2.fired?.to).toBe('approval');
    });

    it('approval extracts buttons', () => {
        const approval = spec.states.find(s => s.id === 'approval')!;
        const lines = approvalScreen.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
        const sections = resolveSections(spec.sections ?? {}, lines);
        const rule = approval.extract!.buttons!;
        const hay = sectionText(sections, rule.section, lines.join('\n'));
        const buttons = extractButtonsFromRule(rule, hay);
        expect(buttons.length).toBeGreaterThanOrEqual(2);
        expect(buttons[0].key).toBe('1\r');
    });

    // ── anchor-relative window regression ───────────────────────────────────
    // The old spec pinned `modal` to a fixed `from_bottom: 36` window. A long
    // approval diff (the command preview spanning > 36 lines between the header
    // question and the numbered buttons) pushes the header question far above
    // the bottom — the fixed 36-line window would clip the header off the top
    // of the modal, breaking both →approval detection (header regex) and title
    // extraction. The anchor-relative modal locates the header wherever it is
    // and bounds it at the footer, so it survives arbitrarily long diffs.
    function makeLongDiffApprovalScreen(diffLines: number): string {
        const lines: string[] = [
            '  Codex wants to run the following command:',
            '',
            '  Would you like to run the following command?',
            '  $ git apply big.patch',
        ];
        // a long command/diff preview that pushes the buttons far from header
        for (let i = 0; i < diffLines; i++) lines.push(`  + line ${i} of a very long patch preview`);
        lines.push('  › 1. Yes');
        lines.push('    2. No');
        lines.push('');
        // footer (settled prompt)
        lines.push('  tab to queue message  ·  ⏎ send');
        return lines.join('\n');
    }

    it('→approval fires even when a long diff (>36 lines) separates header from buttons', () => {
        const screen = makeLongDiffApprovalScreen(60);
        const row = screen.split('\n').length - 1;
        const ev = evaluateFsm(spec, 'busy', screen, { row, col: 2 }, undefined, clk(10000, 0));
        expect(ev.fired?.to).toBe('approval');
    });

    it('approval title + buttons survive a long diff between header and buttons', () => {
        const screen = makeLongDiffApprovalScreen(60);
        const approval = spec.states.find(s => s.id === 'approval')!;
        const lines = screen.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
        const sections = resolveSections(spec.sections ?? {}, lines);
        // Title is the header question, recovered from the anchored modal top
        // (the modal section begins at the anchored question line, not at the
        // arbitrary body preamble above it).
        const title = extractTitle(approval.extract!.title!, sections, lines.join('\n'));
        expect(title).toBe('Would you like to run the following command?');
        // Buttons are still found below the long diff.
        const rule = approval.extract!.buttons!;
        const hay = sectionText(sections, rule.section, lines.join('\n'));
        const buttons = extractButtonsFromRule(rule, hay);
        expect(buttons.map(b => b.index)).toEqual([1, 2]);
        expect(buttons[0].key).toBe('1\r');
    });
});

// ── SPINNER-BODY-SELFMATCH: assistant body quotes the busy cue ────────────────
// Sibling of the claude-cli rc.6 "assistant text cannot self-match spinner
// chrome" regression. Live codex-cli sessions render their own RCA/explanation
// into the transcript body. When that answer quotes codex's busy chrome — the
// literal `Working (` header or the `esc to interrupt` interrupt hint — the OLD
// spec checked those literals against the whole-screen `body` section, so the
// assistant prose self-matched: idle→busy false-fired, and busy→idle's
// not-clause read TRUE forever → the session wedged in `generating` even though
// no live spinner was on the status tail. The fix scopes every busy-cue check to
// `status_tail` (from_bottom:12) and anchors the cue on codex's animated-spinner
// shape, so quoted prose in the scrollback can no longer look like generation.

// An idle codex screen whose assistant answer QUOTES the busy chrome (`Working (`
// and a bare `esc to interrupt`) in the body scrollback, while the live status
// tail carries NO spinner — just the settled composer prompt. Must read idle.
const assistantQuotesBusyCue = makeScreen([
    '  Codex explained the spinner detection:',
    '',
    '  The old spec matched the literal "Working (" header and the bare',
    '  "esc to interrupt" hint against the whole screen. Quoting either',
    '  string here — Working (like this) or esc to interrupt — must not',
    '  be read as a live spinner now that the check is tail-scoped.',
    '',
], '  › ');

describe('codex-cli v4 FSM — assistant text cannot self-match spinner chrome', () => {
    const spec = loadSpec();

    it('does NOT re-enter busy from idle on a quoted "Working ("/"esc to interrupt" in body', () => {
        const row = assistantQuotesBusyCue.split('\n').length - 1;
        const ev = evaluateFsm(spec, 'idle', assistantQuotesBusyCue, { row, col: 2 }, undefined, clk(30000, 0));
        expect(ev.fired?.to).not.toBe('busy');
    });

    it('busy→idle when only the quoted cue remains in body (no live tail spinner)', () => {
        const row = assistantQuotesBusyCue.split('\n').length - 1;
        const ev = evaluateFsm(spec, 'busy', assistantQuotesBusyCue, { row, col: 2 }, undefined, clk(30000, 0));
        expect(ev.fired?.to).toBe('idle');
    });

    it('idle→busy is scoped to status_tail (not the whole-screen body)', () => {
        const idleToBusy = spec.transitions.find(t => t.label === 'idle→busy')!;
        expect((idleToBusy.when as any).section).toBe('status_tail');
    });

    it('the tail-anchored spinner regex rejects quoted prose but keeps the live spinner/hint', () => {
        const re = new RegExp((spec.transitions.find(t => t.label === 'idle→busy')!.when as any).matches, 'i');
        // Prose that merely mentions the cue must NOT match.
        expect(re.test('  string here — Working (like this) or esc to interrupt —')).toBe(false);
        expect(re.test('  quoting the bare esc to interrupt hint')).toBe(false);
        expect(re.test('  explaining the Working (header) cue')).toBe(false);
        // The genuine animated spinner header (glyph or elapsed digit) still matches.
        expect(re.test('  Working (⣿ 3s)')).toBe(true);
        expect(re.test('  Thinking (⣾ 12s)')).toBe(true);
        // The genuine footer interrupt hint inside the live status parens matches.
        expect(re.test('  Working (⣿ 3s · esc to interrupt)')).toBe(true);
        expect(re.test('  … • esc to interrupt)')).toBe(true);
    });

    it('a live tail spinner still drives idle→busy (fix is a guard, not an over-fix)', () => {
        const row = busyScreen.split('\n').length - 1;
        const ev = evaluateFsm(spec, 'idle', busyScreen, { row, col: 2 }, undefined, clk(30000, 0));
        expect(ev.fired?.to).toBe('busy');
    });
});
