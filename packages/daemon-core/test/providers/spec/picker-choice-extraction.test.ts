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

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');

function claudeSetModelExtractPattern(): { pattern: string; flags?: string } {
    const specPath = path.join(REPO_ROOT, 'adhdev-providers/cli/claude-cli/specs/4.0.json');
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    const ctl = (spec.control_bar ?? []).find((c: any) => c.id === 'set_model');
    expect(ctl, 'claude-cli spec must declare a set_model control').toBeTruthy();
    expect(ctl.action.type).toBe('open_picker');
    return ctl.action.extract_choices;
}

/** Mirror of SpecCliAdapter.extractPickerChoices line-parse logic. */
function parseChoices(text: string, ec: { pattern: string; flags?: string }) {
    const out: Array<{ index: number; label: string; current: boolean }> = [];
    const seen = new Set<number>();
    for (const rawLine of text.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        const m = new RegExp(ec.pattern, ec.flags ?? '').exec(line);
        if (!m) continue;
        const idx = Number(m[1]);
        if (!Number.isFinite(idx) || seen.has(idx)) continue;
        const label = (m[2] ?? '').replace(/\s+/g, ' ').trim();
        if (!label) continue;
        const current = /^\s*[❯›>]/.test(line) || /[✔✓●]\s*$/.test(label);
        seen.add(idx);
        out.push({ index: idx, label, current });
    }
    return out;
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
