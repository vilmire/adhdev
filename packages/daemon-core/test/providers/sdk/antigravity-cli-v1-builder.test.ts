/**
 * agy spec regression — same screen scenarios the legacy v0 detect_status.js +
 * parse_approval.js hardened against, now exercised against
 * adhdev-providers/cli/antigravity-cli/specs/1.0.json via the spec evaluator.
 *
 * agy migrated from declarative-only tui block + v0 JS overrides to
 * SpecCliAdapter; if these scenarios regress, the spec drifted from real TUI.
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadSpec } from '../../../src/providers/spec/loader.js';
import { evaluate } from '../../../src/providers/spec/evaluator.js';

const SPEC_PATH = resolve(
    __dirname,
    '../../../../../../adhdev-providers/cli/antigravity-cli/specs/1.0.json',
);

describe('antigravity-cli spec — state + modal regression', () => {
    if (!existsSync(SPEC_PATH)) {
        it.skip('spec not found — skipping', () => undefined);
        return;
    }

    const res = loadSpec(SPEC_PATH);
    if (!res.ok) throw new Error(`spec invalid: ${res.errors.join('; ')}`);
    const spec = res.spec;

    it('busy: "Using Tool" anywhere on screen', () => {
        const screen = ['Using Tool: Bash', 'some output'].join('\n');
        expect(evaluate(spec, screen).state.id).toBe('busy');
    });

    it('busy: "Thinking" cue', () => {
        const screen = ['Thinking…', 'more text'].join('\n');
        expect(evaluate(spec, screen).state.id).toBe('busy');
    });

    it('busy: braille spinner glyph', () => {
        const screen = ['previous prose', 'previous prose', '⣟ Reading file…', 'a', 'b'].join('\n');
        expect(evaluate(spec, screen).state.id).toBe('busy');
    });

    it('idle: settled prompt + "? for shortcuts" footer visible', () => {
        const screen = ['Previous answer here', '', '>', '', '? for shortcuts'].join('\n');
        expect(evaluate(spec, screen).state.id).toBe('idle');
    });

    it('approval: "Do you want to proceed?" + numbered buttons in modal zone', () => {
        const screen = [
            ...Array(20).fill('body filler'),
            'agy wants to run: rm -rf /tmp/cache',
            'Do you want to proceed?',
            '> 1. Yes, allow once',
            '  2. No, cancel',
            '  3. Yes, and always allow',
            '? for shortcuts',
        ].join('\n');
        const r = evaluate(spec, screen);
        expect(r.state.id).toBe('approval');
        expect(r.modal?.buttons.map(b => b.label)).toEqual([
            'Yes, allow once',
            'No, cancel',
            'Yes, and always allow',
        ]);
    });

    it('trust_folder: "Do you trust the files in this folder?" modal', () => {
        const screen = [
            ...Array(20).fill('body filler'),
            'Do you trust the files in this folder?',
            '> 1. Yes',
            '  2. No',
            '? for shortcuts',
        ].join('\n');
        const r = evaluate(spec, screen);
        expect(r.state.id).toBe('trust_folder');
        expect(r.modal?.buttons.map(b => b.label)).toEqual(['Yes', 'No']);
    });

    it('trust_project: "Do you trust the contents of this project?" modal', () => {
        const screen = [
            ...Array(20).fill('body filler'),
            'Do you trust the contents of this project?',
            '> 1. Yes',
            '  2. No',
            '? for shortcuts',
        ].join('\n');
        const r = evaluate(spec, screen);
        expect(r.state.id).toBe('trust_project');
    });

    it('does NOT misclassify an assistant numbered list ending in "?" as modal', () => {
        // v0 buildGenericApproval was specifically removed for this. The spec's
        // modal_zone gate + explicit question regex (Do you want to proceed /
        // Do you trust ...) means no arbitrary "?" line triggers a modal.
        const screen = [
            'Here is the plan:',
            '1. Read the file',
            '2. Edit it',
            '3. Save?',
            '',
            '>',
            '? for shortcuts',
        ].join('\n');
        const r = evaluate(spec, screen);
        expect(r.modal).toBeNull();
        // Should resolve as idle, not approval
        expect(r.state.id).toBe('idle');
    });
});
