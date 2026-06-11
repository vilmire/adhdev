import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import { evaluateFsm, type FsmClock } from '../../../src/providers/spec/fsm-evaluator.js';
import { resolveSections, sectionText, extractButtonsFromRule } from '../../../src/providers/spec/evaluator.js';
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
