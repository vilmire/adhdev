import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import { evaluateFsm, type FsmClock } from '../../../src/providers/spec/fsm-evaluator.js';
import { resolveSections, sectionText, extractButtonsFromRule } from '../../../src/providers/spec/evaluator.js';
import type { CliSpecV4 } from '../../../src/providers/spec/fsm-types.js';

// Resolve the claude-cli v4 spec from the sibling adhdev-providers checkout.
// Falls back to the upstream copy so the test runs in either layout.
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

const banner = [
    '▗ ▗   ▖ ▖  Claude Code v2.1.170',
    '           Sonnet 4.6 with high effort · Claude Max',
    '  ▘▘ ▝▝    ~/Work/adhdev',
    '',
    ' ▎ Meet Fable 5, our newest model. Try /model.',
    '',
    '────────────────────────────────────────────────────────────────────────────────',
    '❯',
    '────────────────────────────────────────────────────────────────────────────────',
    '  ➜ adhdev git:(main)',
].join('\n');

const busyScreen = [
    '⏺ Bash(git commit -m ...)',
    '  ⎿  [main abc123] fix something',
    '',
    '✻ Crunched for 12s',
    '',
    '────────────────────────────────────────────────────────────────────────────────',
    '❯',
    '────────────────────────────────────────────────────────────────────────────────',
].join('\n');

const doneScreen = [
    '⏺ 완료됐습니다.',
    '',
    '✻ Worked for 29s',
    '',
    '────────────────────────────────────────────────────────────────────────────────',
    '❯',
    '────────────────────────────────────────────────────────────────────────────────',
].join('\n');

const approvalScreen = [
    '⏺ Bash command',
    '',
    '────────────────────────────────────────────────────────────────────────────────',
    'Bash command',
    '❯ 1. Yes',
    '  2. No',
    '────────────────────────────────────────────────────────────────────────────────',
].join('\n');

describe('claude-cli v4 FSM', () => {
    const spec = loadSpec();

    it('spec is valid', () => {
        expect(spec.$schema).toBe('adhdev:cli/spec@4');
    });

    it('stays in starting before grace elapses', () => {
        const ev = evaluateFsm(spec, 'starting', banner, { row: 7, col: 1 }, undefined, clk(1000, 0));
        expect(ev.fired).toBeNull();
    });

    it('leaves starting → idle once grace elapses', () => {
        const ev = evaluateFsm(spec, 'starting', banner, { row: 7, col: 1 }, undefined, clk(5000, 0));
        expect(ev.fired?.to).toBe('idle');
    });

    it('does NOT go busy on the startup banner (regression: false-busy)', () => {
        const ev = evaluateFsm(spec, 'idle', banner, { row: 7, col: 1 }, undefined, clk(10000, 5000));
        expect(ev.fired).toBeNull();
    });

    it('idle → busy on real busy signal (⎿ / spinner)', () => {
        const ev = evaluateFsm(spec, 'idle', busyScreen, { row: 5, col: 2 }, undefined, clk(10000, 5000));
        expect(ev.fired?.to).toBe('busy');
    });

    it('busy stays until completion marker is stable', () => {
        // 0.6s after entering busy, marker present but region not yet stable 1.5s
        const ev = evaluateFsm(spec, 'busy', doneScreen, { row: 5, col: 2 }, undefined, clk(600, 0));
        expect(ev.fired).toBeNull();
        const busyIdle = ev.transitions.find(t => t.label === 'busy→idle');
        expect(busyIdle?.condResult).toBe(false);
    });

    it('busy → idle once completion marker stable', () => {
        const ev = evaluateFsm(spec, 'busy', doneScreen, { row: 5, col: 2 }, undefined, clk(2000, 0));
        expect(ev.fired?.to).toBe('idle');
    });

    it('any state → approval on footer prompt', () => {
        for (const from of ['idle', 'busy', 'starting']) {
            const ev = evaluateFsm(spec, from, approvalScreen, { row: 4, col: 1 }, undefined, clk(10000, 5000));
            expect(ev.fired?.to).toBe('approval');
        }
    });

    it('approval state extracts modal title + buttons from the real fixture', () => {
        const fxPath = resolveSpecPath().replace('specs/4.0.json', 'fixtures/missed-approval-write-2026-06-04.json');
        if (!fs.existsSync(fxPath)) return; // fixture only present in the providers checkout
        const screen = JSON.parse(fs.readFileSync(fxPath, 'utf8')).input.screenText as string;

        // The fixture screen must score as approval (footer ❯ 1. ...).
        const ev = evaluateFsm(spec, 'busy', screen, undefined, undefined, clk(10000, 0));
        expect(ev.fired?.to).toBe('approval');

        // And the approval state's extract.buttons must surface the choices.
        const approval = spec.states.find(s => s.id === 'approval')!;
        const lines = screen.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
        const sections = resolveSections(spec.sections ?? {}, lines);
        const rule = approval.extract!.buttons!;
        const hay = sectionText(sections, rule.section, lines.join('\n'));
        const buttons = extractButtonsFromRule(rule, hay);
        expect(buttons.length).toBeGreaterThanOrEqual(2);
        expect(buttons[0].key).toBe('1\r');
    });
});
