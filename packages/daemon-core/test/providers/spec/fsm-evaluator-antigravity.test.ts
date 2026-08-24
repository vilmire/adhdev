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
        path.join(repoRoot, 'adhdev-providers/cli/antigravity-cli/specs/4.0.json'),
        path.join(process.env.HOME ?? '', '.adhdev/providers/.upstream/cli/antigravity-cli/specs/4.0.json'),
    ];
    const found = candidates.find(p => fs.existsSync(p));
    if (!found) throw new Error('antigravity-cli 4.0.json spec not found in: ' + candidates.join(', '));
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

// Antigravity uses from_bottom sections:
//   footer: last 1 line
//   modal: 24 lines above footer (lines -25 to -2)
//   body: top 0 to modal
//
// So we need screens with enough lines so body content appears above line (N-25).
// A 40-line screen: body = lines 0-14, modal = lines 15-38, footer = line 39.

function makeScreen(bodyLines: string[], statusLine = '  › '): string {
    // Build a 40-line screen: bodyLines at top, padding, then status line
    const lines: string[] = [...bodyLines];
    // Pad to 39 lines total (footer is line 39)
    while (lines.length < 39) lines.push('');
    lines.push(statusLine);  // footer: line 39
    return lines.join('\n');
}

function makeScreenWithModal(bodyLines: string[], modalLines: string[], statusLine = '  › '): string {
    const lines: string[] = [...bodyLines];
    // Pad body section (lines 0 to N-25)
    while (lines.length < 15) lines.push('');
    // Modal zone occupies lines 15-38 (24 lines = from_bottom 24 until footer)
    const paddedModal = [...modalLines];
    while (paddedModal.length < 24) paddedModal.unshift('');
    lines.push(...paddedModal.slice(0, 24));
    lines.push(statusLine); // footer: line 39
    return lines.join('\n');
}

// Idle: footer has "? for shortcuts"
const idleScreen = makeScreen(
    ['  Welcome to Antigravity CLI', '  Type a message to start...'],
    '  ? for shortcuts'
);

// Busy: braille spinner in body area
const busyScreen = makeScreen(
    ['  Analyzing your codebase...', '', '  ⠹ Thinking...', '', '  Found 42 files to examine.'],
    '  esc to cancel  ·  ? for shortcuts'
);

// Also busy: esc to cancel in footer
const busyScreen2 = makeScreen(
    ['  Refactoring component...'],
    '  esc to cancel'
);

// Signing in during startup
const signingInScreen = makeScreen(
    ['  Antigravity CLI', '  Signing in to your Google account...'],
    '  Please wait...'
);

// Approval: "Do you want to proceed?" in modal zone
const approvalScreen = makeScreenWithModal(
    ['  agy wants to run:', '  git push origin main'],
    [
        '  Do you want to proceed?',
        '  › 1. Yes, run this',
        '    2. No, skip',
    ],
    '  ? for shortcuts'
);

// Live agy 1.1.19 PTY capture (2026-08-24). This approval shape has no
// `Requesting permission for:` / `Do you want to proceed?` preamble, so the
// modal must self-anchor on the file-edit question itself.
const fileEditApprovalScreen = [
    'Accept this file edit?',
    '> 1. Yes, accept this change',
    '  2. No, reject this change',
    '  ↑/↓ Navigate · tab Amend · f full diff',
].join('\n');

const preFileEditModalAnchor = 'Do you trust the files in this folder\\?|Do you trust the contents of this project\\?|Requesting permission for:|Do you want to proceed\\?';

// Trust screen: folder trust dialog in modal zone
const trustScreen = makeScreenWithModal(
    ['  /home/user/projects/sensitive'],
    [
        '  Do you trust the files in this folder?',
        '  › 1. Yes, trust this folder',
        '    2. No, use restricted mode',
    ],
    '  ? for shortcuts'
);

// Done: spinner gone, body shows completed work, footer shows shortcuts
const doneScreen = makeScreen(
    [
        '  Refactoring complete!',
        '  Modified: Button.tsx, Input.tsx, Form.tsx',
        '',
        '  Well done. 3 files updated.',
    ],
    '  ? for shortcuts'
);

describe('antigravity-cli v4 FSM', () => {
    const spec = loadSpec();

    it('spec is valid', () => {
        expect(spec.$schema).toBe('adhdev:cli/spec@4');
        expect(spec.id).toBe('antigravity-cli');
    });

    it('stays in starting before 15s grace', () => {
        const ev = evaluateFsm(spec, 'starting', idleScreen, { row: 39, col: 4 }, undefined, clk(5000, 0));
        const startupTransition = ev.transitions.find(t => t.label === 'startup-grace');
        expect(startupTransition?.fires).toBe(false);
    });

    it('starting → signing_in if Signing in appears before grace', () => {
        const ev = evaluateFsm(spec, 'starting', signingInScreen, { row: 39, col: 4 }, undefined, clk(2000, 0));
        expect(ev.fired?.to).toBe('signing_in');
    });

    it('signing_in → idle once signing in is gone + footer shortcut visible', () => {
        const ev = evaluateFsm(spec, 'signing_in', idleScreen, { row: 39, col: 4 }, undefined, clk(2000, 0));
        expect(ev.fired?.to).toBe('idle');
    });

    it('idle → busy on braille spinner in body', () => {
        const ev = evaluateFsm(spec, 'idle', busyScreen, { row: 39, col: 4 }, undefined, clk(20000, 15000));
        expect(ev.fired?.to).toBe('busy');
    });

    it('idle → busy on esc to cancel in footer', () => {
        const ev = evaluateFsm(spec, 'idle', busyScreen2, { row: 39, col: 4 }, undefined, clk(20000, 15000));
        expect(ev.fired?.to).toBe('busy');
    });

    it('→trust fires at highest priority from idle or busy', () => {
        for (const from of ['idle', 'busy']) {
            const ev = evaluateFsm(spec, from, trustScreen, { row: 39, col: 4 }, undefined, clk(20000, 0));
            expect(ev.fired?.to).toBe('trust');
        }
    });

    it('→approval fires from busy when approval modal appears', () => {
        const ev = evaluateFsm(spec, 'busy', approvalScreen, { row: 39, col: 4 }, undefined, clk(10000, 0));
        expect(ev.fired?.to).toBe('approval');
    });

    it('recognizes the live `Accept this file edit?` approval through the real section path', () => {
        expect(new RegExp(preFileEditModalAnchor).test(fileEditApprovalScreen)).toBe(false);
        expect(new RegExp(spec.sections!.modal.anchor as string).test(fileEditApprovalScreen)).toBe(true);

        const lines = fileEditApprovalScreen.split('\n');
        const sections = resolveSections(spec.sections ?? {}, lines);
        expect(sectionText(sections, 'modal', fileEditApprovalScreen)).toBe(fileEditApprovalScreen);

        const ev = evaluateFsm(spec, 'busy', fileEditApprovalScreen, { row: 3, col: 45 }, undefined, clk(10000, 0));
        expect(ev.fired?.to).toBe('approval');

        const approval = spec.states.find(state => state.id === 'approval')!;
        const modalText = sectionText(sections, 'modal', fileEditApprovalScreen);
        expect(extractTitle(approval.extract!.title!, sections, fileEditApprovalScreen)).toBe('Accept this file edit?');
        const buttons = extractButtonsFromRule(approval.extract!.buttons!, modalText);
        expect(buttons).toHaveLength(2);
        expect(buttons.map(button => button.key)).toEqual(['1\r', '2\r']);
        expect(buttons[0].label).toBe('Yes, accept this change');
        expect(buttons[1].label).toContain('No, reject this change');
    });

    it('keeps confirmed agy 1.1.19 approval prompts aligned between the modal anchor and transition', () => {
        const approvalPattern = (spec.transitions.find(transition => transition.label === '→approval')!.when as any).matches;
        const prompts = [
            'Accept this file edit?',
            'Allow access to this file?',
            'Allow creation of this file?',
            'Allow sandbox bypass for command execution?',
        ];
        for (const prompt of prompts) {
            expect(new RegExp(spec.sections!.modal.anchor as string).test(prompt)).toBe(true);
            expect(new RegExp(approvalPattern).test(prompt)).toBe(true);
        }
    });

    it('busy stays until spinner gone + footer present + stable', () => {
        // min_hold_ms=500 not yet passed (200ms)
        const ev = evaluateFsm(spec, 'busy', doneScreen, { row: 39, col: 4 }, undefined, clk(200, 0));
        expect(ev.fired).toBeNull();
    });

    it('busy → idle once spinner gone, footer has shortcuts, stable 1500ms', () => {
        const ev = evaluateFsm(spec, 'busy', doneScreen, { row: 39, col: 4 }, undefined, clk(2500, 0));
        expect(ev.fired?.to).toBe('idle');
    });

    it('consecutive approvals: approval→idle→approval', () => {
        // First approval handled
        const ev1 = evaluateFsm(spec, 'approval', doneScreen, { row: 39, col: 4 }, undefined, clk(1500, 0));
        expect(ev1.fired?.to).toBe('idle');
        // Second approval arrives
        const ev2 = evaluateFsm(spec, 'idle', approvalScreen, { row: 39, col: 4 }, undefined, clk(20000, 18000));
        expect(ev2.fired?.to).toBe('approval');
    });

    it('long task: remains busy throughout', () => {
        // 60 seconds into busy, still showing spinner
        const ev = evaluateFsm(spec, 'busy', busyScreen, { row: 39, col: 4 }, undefined, clk(60000, 0));
        expect(ev.fired?.to).not.toBe('idle');
    });

    it('approval extracts title and buttons', () => {
        const approval = spec.states.find(s => s.id === 'approval')!;
        const lines = approvalScreen.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
        const sections = resolveSections(spec.sections ?? {}, lines);
        const rule = approval.extract!.buttons!;
        const hay = sectionText(sections, rule.section, lines.join('\n'));
        const buttons = extractButtonsFromRule(rule, hay);
        expect(buttons.length).toBeGreaterThanOrEqual(2);
        expect(buttons[0].key).toBe('1\r');
    });
});

// ── BUSY-IDLE-BOUNDED-FALLBACK: repaint-wedged stable clock (AGY) ────────────
// AGY-SPEC-BUSY-WEDGE RCA (2026-07-26), same family as the codex-cli fix: after
// a completed turn a benign repaint inside the cursor_above:4 window keeps
// resetting the stable clock faster than 1500ms, so the strict all(4) never
// passes and the session wedges in busy. The exact ticker string is not yet
// captured, so NO ignore_lines is added; instead busy→idle gained a bounded
// fallback arm: same modal/esc-to-cancel vetoes + `? for shortcuts` required +
// live braille activity-marker veto (idle→busy regex reused) + elapsed 60000.
// These tests pin it with a VIRTUAL clock: region key 4 (the strict arm's
// stable window) is marked changed 500ms ago, so the strict arm can never
// pass — exactly the live wedge condition.

// Completed turn with shortcuts footer but `esc to cancel` STILL visible and
// no braille marker — isolates the esc-to-cancel veto.
const escCancelDoneScreen = makeScreen(
    ['  Refactoring complete!', '  Modified: Button.tsx'],
    '  esc to cancel  ·  ? for shortcuts'
);

// Completed turn with NO shortcuts footer — isolates the shortcuts requirement.
const noShortcutsDoneScreen = makeScreen(
    ['  Refactoring complete!', '  Modified: Button.tsx'],
    '  › '
);

// Live activity marker (braille + Generating/Running/Thinking) in body with a
// shortcuts-only footer — isolates the braille veto from the esc-to-cancel one.
function brailleActiveScreen(glyph: string, verb: string): string {
    return makeScreen(
        ['  Working on your request...', '', `  ${glyph} ${verb}...`],
        '  ? for shortcuts'
    );
}

describe('antigravity-cli v4 FSM — busy→idle bounded fallback (repaint wedge)', () => {
    const spec = loadSpec();

    // Region key 4 = the strict arm's {stable_ms:1500, cursor_above:4} window;
    // "changed 500ms ago" keeps the strict arm permanently blocked, so only the
    // bounded fallback arm can ever fire in these tests.
    const UNSTABLE: [number, number][] = [[4, 60500]];

    it('strict arm still fires first on a genuinely quiet completed screen (~1.5s fast path)', () => {
        const ev = evaluateFsm(spec, 'busy', doneScreen, { row: 39, col: 4 }, undefined, clk(2000, 0));
        expect(ev.fired?.to).toBe('idle');
    });

    it('does NOT fire at 59s when the repaint keeps the stable window unsettled (wedge repro)', () => {
        const ev = evaluateFsm(
            spec, 'busy', doneScreen, { row: 39, col: 4 }, undefined,
            clk(59000, 0, [[4, 58500]]),
        );
        expect(ev.fired).toBeNull();
    });

    it('fires busy→idle at 61s on the completed screen despite the repaint wedge', () => {
        const ev = evaluateFsm(spec, 'busy', doneScreen, { row: 39, col: 4 }, undefined, clk(61000, 0, UNSTABLE));
        expect(ev.fired?.to).toBe('idle');
    });

    it('veto: footer `esc to cancel` blocks the fallback at 61s', () => {
        const ev = evaluateFsm(spec, 'busy', escCancelDoneScreen, { row: 39, col: 4 }, undefined, clk(61000, 0, UNSTABLE));
        expect(ev.fired).toBeNull();
    });

    it('veto: a live braille Generating/Running/Thinking marker blocks the fallback at 61s', () => {
        for (const [glyph, verb] of [['⠹', 'Generating'], ['⠿', 'Running'], ['⠋', 'Thinking']] as const) {
            const screen = brailleActiveScreen(glyph, verb);
            const ev = evaluateFsm(spec, 'busy', screen, { row: 39, col: 4 }, undefined, clk(61000, 0, UNSTABLE));
            expect(ev.fired).toBeNull();
        }
    });

    it('veto: an approval modal with shortcuts footer routes to approval at 61s, never idle', () => {
        const ev = evaluateFsm(spec, 'busy', approvalScreen, { row: 39, col: 4 }, undefined, clk(61000, 0, UNSTABLE));
        expect(ev.fired?.to).toBe('approval');
        expect(ev.fired?.to).not.toBe('idle');
    });

    it('veto: a trust modal routes to trust at 61s, never idle', () => {
        const ev = evaluateFsm(spec, 'busy', trustScreen, { row: 39, col: 4 }, undefined, clk(61000, 0, UNSTABLE));
        expect(ev.fired?.to).toBe('trust');
        expect(ev.fired?.to).not.toBe('idle');
    });

    it('does NOT fire at 61s without the `? for shortcuts` footer', () => {
        const ev = evaluateFsm(spec, 'busy', noShortcutsDoneScreen, { row: 39, col: 4 }, undefined, clk(61000, 0, UNSTABLE));
        expect(ev.fired).toBeNull();
    });

    it('the fallback vetoes reuse the shipping regexes (no drift) and no transcript signals', () => {
        const busyToIdle = spec.transitions.find(t => t.label === 'busy→idle')!;
        const arms = (busyToIdle.when as any).any as any[];
        expect(arms).toHaveLength(2);
        const strict = arms[0].all as any[];
        const fallback = arms[1].all as any[];
        // Modal veto identical to the strict arm / →approval pattern.
        const modalOf = (all: any[]) => all.find(c => c.not?.section === 'modal')?.not?.matches;
        expect(modalOf(fallback)).toBe(modalOf(strict));
        expect(modalOf(fallback)).toBe((spec.transitions.find(t => t.label === '→approval')!.when as any).matches);
        // Braille activity veto identical to the idle→busy body braille regex.
        const idleToBusyArms = (spec.transitions.find(t => t.label === 'idle→busy')!.when as any).any as any[];
        const idleBusyBraille = idleToBusyArms.find(c => c.section === 'body')?.matches;
        const fallbackBraille = fallback.find(c => c.not?.section === 'body')?.not?.matches;
        expect(fallbackBraille).toBe(idleBusyBraille);
        // esc-to-cancel veto + shortcuts requirement present in both arms.
        for (const all of [strict, fallback]) {
            expect(all.some(c => c.not?.section === 'footer' && c.not.matches === 'esc to cancel')).toBe(true);
            expect(all.some(c => c.section === 'footer' && c.matches === '\\? for shortcuts')).toBe(true);
        }
        // The fallback must not consult transcript signals.
        expect(JSON.stringify(busyToIdle.when)).not.toContain('final_assistant_present');
        expect(JSON.stringify(busyToIdle.when)).not.toContain('signal');
    });
});
