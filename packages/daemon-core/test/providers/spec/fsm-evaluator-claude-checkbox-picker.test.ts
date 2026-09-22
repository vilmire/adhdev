/**
 * REMOTE-ANSWER-PICKER-PARSE (live 2026-09-22): a multi-select AskUserQuestion
 * whose option rows carry a checkbox glyph BEFORE the number ("❯ [ ] 1. Label")
 * failed extract.buttons — the spec pattern only matched "N. label" with no
 * checkbox tolerance. As the picker's option count shrank across redraws
 * (6-buttons → 5-buttons → 2-buttons), extract.buttons kept returning 0 rows,
 * which stayed below the approval state's min_count=2 gate ("modal not
 * parseable"), so activeInteractivePrompt never got populated and the FSM's
 * question/approval classification (status-transition.ts isQuestionPicker)
 * fell back to waiting_approval — the "Answer the question" button had nothing
 * to open and the composer showed a stale "Waiting for approval..." lock.
 *
 * These tests exercise the REAL spec file end-to-end (evaluateFsm +
 * extractButtonsFromRule), not a standalone regex — a lone regex test would
 * miss the FSM spec `matches` no-`m`-flag footgun (^/$ anchoring the whole
 * screen) and any interaction with the modal section anchors.
 */

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

function clk(now: number, entered: number): FsmClock {
    return { now, stateEnteredAt: entered, regionLastChangedAt: new Map() };
}

function strip(screen: string): string[] {
    return screen.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
}

/** Builds a multi-select AskUserQuestion screen with N checkbox options,
 *  glyph BEFORE the number — the exact live-captured layout that failed. */
function checkboxPickerScreen(optionCount: number): string {
    const options = Array.from({ length: optionCount }, (_, i) =>
        `  ${i === 0 ? '❯' : ' '} [${i === 1 ? 'x' : ' '}] ${i + 1}. Option ${i + 1}`);
    return [
        '▗ ▗   ▖ ▖  Claude Code v2.1.220',
        '  ▘▘ ▝▝    ~/Work/adhdev',
        '',
        '⏺ Pick as many as apply',
        '',
        '  Scope',
        ...options,
        '',
        '  Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');
}

const spec = loadSpec();

describe('claude-cli v4 FSM — checkbox-marker AskUserQuestion picker (remote-answer-picker-parse regression)', () => {
    it.each([6, 5, 2])('classifies a %i-option checkbox picker as →picker, not →approval', (optionCount) => {
        const screen = checkboxPickerScreen(optionCount);
        const lines = strip(screen);
        const ev = evaluateFsm(spec, 'busy', screen, { row: lines.length - 1, col: 2 }, undefined, clk(10000, 0));
        expect(ev.fired?.to).toBe('picker');
        expect(ev.fired?.to).not.toBe('approval');
    });

    it.each([6, 5, 2])('extract.buttons resolves all %i checkbox rows (picker state)', (optionCount) => {
        const picker = spec.states.find(s => s.id === 'picker')!;
        const screen = checkboxPickerScreen(optionCount);
        const lines = strip(screen);
        const sections = resolveSections(spec.sections ?? {}, lines);
        const rule = picker.extract!.buttons!;
        const hay = sectionText(sections, rule.section, lines.join('\n'));
        const buttons = extractButtonsFromRule(rule, hay);
        expect(buttons).toHaveLength(optionCount);
        expect(buttons.map(b => b.index)).toEqual(Array.from({ length: optionCount }, (_, i) => i + 1));
    });

    it('extract.buttons also clears the approval state min_count=2 gate at the smallest (2-option) size', () => {
        // The originally-reported failure mode: as the picker shrank to its
        // final 2-option redraw, a misclassification into the `approval` rule's
        // path (min_count=2) must not drop below the gate either — pin the
        // approval-state rule directly so a future edit to ONLY the picker rule
        // (and not the approval rule, which shares the same pattern) is caught.
        const approval = spec.states.find(s => s.id === 'approval')!;
        const screen = checkboxPickerScreen(2);
        const lines = strip(screen);
        const sections = resolveSections(spec.sections ?? {}, lines);
        const rule = approval.extract!.buttons!;
        const hay = sectionText(sections, rule.section, lines.join('\n'));
        const buttons = extractButtonsFromRule(rule, hay);
        expect(buttons.length).toBeGreaterThanOrEqual(2);
    });

    it('checkbox glyph AFTER the number also resolves (claude-cli >=2.1 layout)', () => {
        const picker = spec.states.find(s => s.id === 'picker')!;
        const screen = [
            '▗ ▗   ▖ ▖  Claude Code v2.1.220',
            '  ▘▘ ▝▝    ~/Work/adhdev',
            '',
            '⏺ Pick as many as apply',
            '',
            '  Scope',
            '  ❯ 1. [ ] Alpha',
            '    2. [x] Beta',
            '    3. [ ] Gamma',
            '',
            '  Enter to select · ↑/↓ to navigate · Esc to cancel',
        ].join('\n');
        const lines = strip(screen);
        const sections = resolveSections(spec.sections ?? {}, lines);
        const rule = picker.extract!.buttons!;
        const hay = sectionText(sections, rule.section, lines.join('\n'));
        const buttons = extractButtonsFromRule(rule, hay);
        expect(buttons.map(b => b.index)).toEqual([1, 2, 3]);
        expect(buttons.map(b => b.label)).toEqual(['Alpha', 'Beta', 'Gamma']);
    });

    it('a genuine approval modal (no checkbox glyphs) is unaffected by the checkbox tolerance (control)', () => {
        const genuineApproval = [
            '▗ ▗   ▖ ▖  Claude Code v2.1.220',
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
        const lines = strip(genuineApproval);
        const ev = evaluateFsm(spec, 'busy', genuineApproval, { row: lines.length - 1, col: 2 }, undefined, clk(10000, 0));
        expect(ev.fired?.to).toBe('approval');

        const approval = spec.states.find(s => s.id === 'approval')!;
        const sections = resolveSections(spec.sections ?? {}, lines);
        const rule = approval.extract!.buttons!;
        const hay = sectionText(sections, rule.section, lines.join('\n'));
        const buttons = extractButtonsFromRule(rule, hay);
        expect(buttons.map(b => b.label)).toEqual(['Yes', 'No']);
    });
});
