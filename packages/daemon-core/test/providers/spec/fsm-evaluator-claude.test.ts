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
