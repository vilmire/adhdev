/**
 * Dynamic control-bar picker: choice extraction from a live screen.
 *
 * The model/mode controls are open_picker actions whose options are NOT a
 * hardcoded enum — they are parsed from whatever the CLI renders when the
 * picker opens, using the spec's `extract_choices.pattern`. This test locks
 * that parse (and the "which option is current" detection) against the real
 * claude-cli /model picker layout captured from a live session, so a spec
 * regex regression is caught without a live CLI.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js';
import { lastContiguousNumberedBlock } from '../../../src/providers/spec/evaluator.js';

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');

function claudeSetModelExtractPattern(): { pattern: string; flags?: string } {
    const specPath = path.join(REPO_ROOT, 'adhdev-providers/cli/claude-cli/specs/4.0.json');
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    const ctl = (spec.control_bar ?? []).find((c: any) => c.id === 'set_model');
    expect(ctl, 'claude-cli spec must declare a set_model control').toBeTruthy();
    expect(ctl.action.type).toBe('open_picker');
    return ctl.action.extract_choices;
}

/** Mirror of SpecCliAdapter.extractPickerChoices line-parse logic: collect every
 *  numbered line in screen order (no top-down de-dup) then reduce to the
 *  bottom-most contiguous block via the shared helper. */
function parseChoices(text: string, ec: { pattern: string; flags?: string }) {
    const all: Array<{ index: number; label: string; current: boolean }> = [];
    for (const rawLine of text.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        const m = new RegExp(ec.pattern, ec.flags ?? '').exec(line);
        if (!m) continue;
        const idx = Number(m[1]);
        if (!Number.isFinite(idx) || idx <= 0) continue;
        const label = (m[2] ?? '').replace(/\s+/g, ' ').trim();
        if (!label) continue;
        const current = /^\s*[❯›>]/.test(line) || /[✔✓●]\s*$/.test(label);
        all.push({ index: idx, label, current });
    }
    return lastContiguousNumberedBlock(all);
}

/** Drive the REAL SpecCliAdapter.extractPickerChoices against a fixed screen —
 *  no stub of the parse logic. The adapter reads the screen through its driver,
 *  so we hand it a minimal driver returning `screen`. */
function realExtract(screen: string, ec: { pattern: string; flags?: string }) {
    const adapter: any = Object.create(SpecCliAdapter.prototype);
    Object.assign(adapter, {
        cliType: 'claude-cli',
        driver: { getScreen: () => screen, getSections: () => undefined, snapshot: () => screen },
    });
    return adapter.extractPickerChoices({ extract_choices: ec });
}

// Verbatim from a live claude-cli v2.1.170 /model picker (the cursor row uses ❯
// and the active model is flagged with ✔).
const LIVE_MODEL_PICKER = [
    '❯ /model',
    '  Select model',
    '    1. Default (recommended)  Opus 4.8 with 1M context · Best for everyday,',
    '    2. Sonnet                 Sonnet 4.6 · Efficient for routine tasks',
    '    3. Haiku                  Haiku 4.5 · Fastest for quick answers',
    '  ❯ 4. Opus ✔                 Opus 4.8 · Best for everyday, complex tasks',
    '    5. Fable (disabled)       Claude Fable 5 is currently unavailable. Learn',
].join('\n');

describe('control-bar picker — dynamic choice extraction', () => {
    it('parses every numbered model option from the live /model screen', () => {
        const choices = parseChoices(LIVE_MODEL_PICKER, claudeSetModelExtractPattern());
        expect(choices.map(c => c.index)).toEqual([1, 2, 3, 4, 5]);
        expect(choices.find(c => c.index === 2)?.label).toContain('Sonnet');
        expect(choices.find(c => c.index === 3)?.label).toContain('Haiku');
        expect(choices.find(c => c.index === 5)?.label).toContain('Fable');
    });

    it('flags the cursor/checkmarked option as current (not a hardcoded name)', () => {
        const choices = parseChoices(LIVE_MODEL_PICKER, claudeSetModelExtractPattern());
        const current = choices.filter(c => c.current);
        expect(current).toHaveLength(1);
        expect(current[0].index).toBe(4);
        expect(current[0].label).toContain('Opus');
    });

    it('returns nothing when the screen has no numbered options (picker not open)', () => {
        const choices = parseChoices('just a prompt\n❯ \nno options here', claudeSetModelExtractPattern());
        expect(choices).toEqual([]);
    });
});

// ── Body-pollution regression (MODELSWITCH bottom-up) ────────────────────────
// The picker's `modal` section can be pulled too far up by the divider anchor so
// it swallows conversation history. That history can carry its OWN numbered list
// ("1./2./3.") and even a blockquote `> 1.` whose leading `>` looks like a TUI
// cursor marker. A top-down first-wins parse bound the low option indices to
// those body lines and dedup-dropped the real picker rows below — so /model
// saved whatever the body happened to show, not the chosen model. The fix scans
// the parsed matches bottom-up and keeps only the last contiguous numbered block
// (the on-screen picker), which also confines the `current` flag to that block.
const POLLUTED_MODEL_PICKER = [
    '⏺ Here are three options I weighed:',
    '    1. foo first',
    '    2. bar second',
    '    3. baz third',
    '> 1. a quoted numbered line that also looks like option one',
    '────────────────────────────────────────────────────────────',
    '  Select model',
    '  ❯ 1. Default (recommended)  Opus 4.8 with 1M context · everyday',
    '    2. Sonnet                 Sonnet 4.6 · routine tasks',
    '    3. Haiku                  Haiku 4.5 · quick answers',
].join('\n');

describe('control-bar picker — body pollution does not shadow real options', () => {
    const ec = claudeSetModelExtractPattern();

    it('extracts the BOTTOM picker block, not the body numbered list (real adapter)', () => {
        const choices = realExtract(POLLUTED_MODEL_PICKER, ec);
        expect(choices.map((c: any) => c.index)).toEqual([1, 2, 3]);
        // Labels must be the model rows at the bottom — NOT foo/bar/baz above.
        expect(choices[0].label).toContain('Default');
        expect(choices[1].label).toContain('Sonnet');
        expect(choices[2].label).toContain('Haiku');
        expect(choices.some((c: any) => /foo|bar|baz|quoted/.test(c.label))).toBe(false);
    });

    it('flags the picker cursor row (Default) as current — not the body `>` line', () => {
        const choices = realExtract(POLLUTED_MODEL_PICKER, ec);
        const current = choices.filter((c: any) => c.current);
        expect(current).toHaveLength(1);
        expect(current[0].index).toBe(1);
        expect(current[0].label).toContain('Default');
    });

    it('parseChoices mirror agrees with the real adapter on the polluted screen', () => {
        expect(parseChoices(POLLUTED_MODEL_PICKER, ec)).toEqual(realExtract(POLLUTED_MODEL_PICKER, ec));
    });
});
