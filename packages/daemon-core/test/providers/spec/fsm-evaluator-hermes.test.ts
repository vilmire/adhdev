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
        path.join(repoRoot, 'adhdev-providers/cli/hermes-cli/specs/4.0.json'),
        path.join(process.env.HOME ?? '', '.adhdev/providers/.upstream/cli/hermes-cli/specs/4.0.json'),
    ];
    const found = candidates.find(p => fs.existsSync(p));
    if (!found) throw new Error('hermes-cli 4.0.json spec not found in: ' + candidates.join(', '));
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

// Hermes idle: footer shows ❯ prompt
const idleScreen = [
    '',
    '  Welcome to Hermes Agent! Type your message or /help for commands.',
    '',
    '  assistant: Hello! I\'m ready to help you.',
    '',
    '────────────────────────────────────────────────────────────',
    '❯',
].join('\n');

// Busy: footer shows msg=interrupt (Hermes busy indicator)
const busyScreen = [
    '  user: Refactor the authentication module',
    '',
    '  assistant: I\'ll analyze the authentication module and refactor it...',
    '',
    '────────────────────────────────────────────────────────────',
    '❯  msg=interrupt  ·  Ctrl+C cancel',
].join('\n');

// Busy via musing... (thinking indicator)
const musingScreen = [
    '  user: Write a detailed analysis',
    '',
    '  assistant: musing...',
    '',
    '────────────────────────────────────────────────────────────',
    '❯  musing...',
].join('\n');

// Busy via Enter to interrupt
const enterInterruptScreen = [
    '  user: Generate a long document',
    '',
    '  assistant: Starting generation...',
    '',
    '────────────────────────────────────────────────────────────',
    '❯  Enter to interrupt  ·  /steer',
].join('\n');

// Approval: Dangerous Command dialog
const approvalScreen = [
    '  assistant: I need to run this command:',
    '  rm -rf /tmp/build',
    '',
    '  Dangerous Command',
    '',
    '  ❯ 1. Allow once',
    '    2. Allow for this session',
    '    3. Add to permanent allowlist',
    '    4. Deny',
    '',
    '────────────────────────────────────────────────────────────',
    '❯',
].join('\n');

// Approval: Approval required dialog
const approvalScreen2 = [
    '  assistant: Requesting permission to:',
    '  Modify system configuration file',
    '',
    '  Approval required',
    '',
    '  ❯ 1. Approve and run',
    '    2. Deny',
    '',
    '────────────────────────────────────────────────────────────',
    '❯',
].join('\n');

// Picker: model selection
const pickerScreen = [
    '  Select a model:',
    '',
    '  ❯ 1. claude-opus-4',
    '    2. claude-sonnet-4-6',
    '    3. gpt-4o',
    '',
    '────────────────────────────────────────────────────────────',
    '❯',
].join('\n');

// Done: footer returns to idle ❯
const doneScreen = [
    '  user: refactor auth',
    '',
    '  assistant: I\'ve completed the refactoring:',
    '  - Extracted AuthService class',
    '  - Added JWT validation',
    '  - Updated tests',
    '',
    '────────────────────────────────────────────────────────────',
    '❯',
].join('\n');

// Short message response
const shortDoneScreen = [
    '  user: hi',
    '',
    '  assistant: Hello!',
    '',
    '────────────────────────────────────────────────────────────',
    '❯',
].join('\n');

describe('hermes-cli v4 FSM', () => {
    const spec = loadSpec();

    it('spec is valid', () => {
        expect(spec.$schema).toBe('adhdev:cli/spec@4');
        expect(spec.id).toBe('hermes-cli');
    });

    it('stays in starting before 3s grace or welcome screen', () => {
        // Empty screen, 1s elapsed — neither elapsed_ms nor welcome
        const emptyScreen = '\n\n\n\n\n\n❯';
        const ev = evaluateFsm(spec, 'starting', emptyScreen, { row: 6, col: 1 }, undefined, clk(1000, 0));
        // startup-grace needs both elapsed_ms:3000 AND (footer ❯ OR welcome banner)
        const graceT = ev.transitions.find(t => t.label === 'startup-grace');
        expect(graceT?.fires).toBe(false);
    });

    it('starting → idle once welcome banner + 3s elapsed', () => {
        const ev = evaluateFsm(spec, 'starting', idleScreen, { row: 6, col: 1 }, undefined, clk(3500, 0));
        expect(ev.fired?.to).toBe('idle');
    });

    it('starting → idle after 15s timeout (fallback)', () => {
        const ev = evaluateFsm(spec, 'starting', '\n\n\n\n\n\n❯', { row: 6, col: 1 }, undefined, clk(15500, 0));
        expect(ev.fired?.to).toBe('idle');
    });

    it('idle → busy on msg=interrupt in footer', () => {
        const ev = evaluateFsm(spec, 'idle', busyScreen, { row: 5, col: 1 }, undefined, clk(10000, 5000));
        expect(ev.fired?.to).toBe('busy');
    });

    it('idle → busy on musing... in footer', () => {
        const ev = evaluateFsm(spec, 'idle', musingScreen, { row: 5, col: 1 }, undefined, clk(10000, 5000));
        expect(ev.fired?.to).toBe('busy');
    });

    it('idle → busy on Enter to interrupt in footer', () => {
        const ev = evaluateFsm(spec, 'idle', enterInterruptScreen, { row: 5, col: 1 }, undefined, clk(10000, 5000));
        expect(ev.fired?.to).toBe('busy');
    });

    it('→approval fires at priority 100 from any state (Dangerous Command)', () => {
        for (const from of ['idle', 'busy', 'starting']) {
            const ev = evaluateFsm(spec, from, approvalScreen, { row: 11, col: 1 }, undefined, clk(10000, 0));
            expect(ev.fired?.to).toBe('approval');
        }
    });

    it('→approval fires on Approval required dialog', () => {
        const ev = evaluateFsm(spec, 'busy', approvalScreen2, { row: 11, col: 1 }, undefined, clk(10000, 0));
        expect(ev.fired?.to).toBe('approval');
    });

    it('→picker fires on model selection', () => {
        const ev = evaluateFsm(spec, 'idle', pickerScreen, { row: 7, col: 1 }, undefined, clk(10000, 5000));
        expect(ev.fired?.to).toBe('picker');
    });

    it('busy stays until footer returns to clean ❯ + stable', () => {
        // min_hold_ms=400, only 200ms elapsed
        const ev = evaluateFsm(spec, 'busy', doneScreen, { row: 8, col: 1 }, undefined, clk(200, 0));
        expect(ev.fired).toBeNull();
    });

    it('busy → idle once footer is clean ❯ + stable 1500ms', () => {
        const ev = evaluateFsm(spec, 'busy', doneScreen, { row: 8, col: 1 }, undefined, clk(2000, 0));
        expect(ev.fired?.to).toBe('idle');
    });

    it('approval → idle once modal cleared + footer clean', () => {
        const ev = evaluateFsm(spec, 'approval', doneScreen, { row: 8, col: 1 }, undefined, clk(1200, 0));
        expect(ev.fired?.to).toBe('idle');
    });

    it('approval → busy if busy signal appears after approval', () => {
        const ev = evaluateFsm(spec, 'approval', busyScreen, { row: 5, col: 1 }, undefined, clk(10000, 0));
        expect(ev.fired?.to).toBe('busy');
    });

    it('consecutive approvals: two approvals in sequence', () => {
        // First approval handled
        const ev1 = evaluateFsm(spec, 'approval', doneScreen, { row: 8, col: 1 }, undefined, clk(1200, 0));
        expect(ev1.fired?.to).toBe('idle');
        // Second approval arrives
        const ev2 = evaluateFsm(spec, 'idle', approvalScreen2, { row: 11, col: 1 }, undefined, clk(12000, 10000));
        expect(ev2.fired?.to).toBe('approval');
        // Second approval handled
        const ev3 = evaluateFsm(spec, 'approval', doneScreen, { row: 8, col: 1 }, undefined, clk(2400, 0));
        expect(ev3.fired?.to).toBe('idle');
    });

    it('short message succession: idle→busy→idle→busy', () => {
        // Task 1 starts
        const ev1 = evaluateFsm(spec, 'idle', busyScreen, { row: 5, col: 1 }, undefined, clk(5000, 4000));
        expect(ev1.fired?.to).toBe('busy');
        // Task 1 done
        const ev2 = evaluateFsm(spec, 'busy', shortDoneScreen, { row: 8, col: 1 }, undefined, clk(2000, 0));
        expect(ev2.fired?.to).toBe('idle');
        // Task 2 starts quickly after
        const ev3 = evaluateFsm(spec, 'idle', busyScreen, { row: 5, col: 1 }, undefined, clk(8000, 7000));
        expect(ev3.fired?.to).toBe('busy');
        // Task 2 done
        const ev4 = evaluateFsm(spec, 'busy', shortDoneScreen, { row: 8, col: 1 }, undefined, clk(2000, 0));
        expect(ev4.fired?.to).toBe('idle');
    });

    it('long task: remains busy throughout (60s)', () => {
        const ev = evaluateFsm(spec, 'busy', busyScreen, { row: 5, col: 1 }, undefined, clk(60000, 0));
        expect(ev.fired?.to).not.toBe('idle');
    });

    it('approval extracts title and buttons (Dangerous Command)', () => {
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
