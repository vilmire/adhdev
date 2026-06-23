/**
 * Control-bar picker SELECT keystrokes — arrow-nav vs index modes + open de-dup.
 *
 * Regression (MODELSWITCH): the claude-cli /model picker is a cursor list that
 * IGNORES number keys — its cursor opens on the active model row and Enter
 * commits that row. The old SELECT path typed `{index}\r`, so picking Sonnet
 * just pressed Enter on the cursor's current row (Opus) → every selection saved
 * as Opus. The fix drives the cursor with arrow keys for `select_mode:
 * 'arrow_keys'` pickers, and de-dups the redundant picker re-open (whose
 * trailing CR also committed the wrong row).
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js';

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const ESC = String.fromCharCode(27); // ANSI escape (0x1b)
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;

// Verbatim from a live claude-cli /model picker: the cursor (❯) opens on the
// active model (row 4 = Opus, ✔), NOT row 1.
const OPUS_CURRENT_SCREEN = [
    '  Select model',
    '    1. Default (recommended)  Opus 4.8 with 1M context · everyday',
    '    2. Sonnet                 Sonnet 4.6 · routine tasks',
    '    3. Haiku                  Haiku 4.5 · quick answers',
    '  ❯ 4. Opus ✔                 Opus 4.8 · complex tasks',
    '    5. Fable (disabled)       Claude Fable 5 currently unavailable',
].join('\n');

// Same picker but the cursor sits on row 2 (Sonnet) — used to exercise DOWN nav.
const SONNET_CURRENT_SCREEN = [
    '  Select model',
    '    1. Default (recommended)  Opus 4.8 with 1M context · everyday',
    '  ❯ 2. Sonnet ✔               Sonnet 4.6 · routine tasks',
    '    3. Haiku                  Haiku 4.5 · quick answers',
    '    4. Opus                   Opus 4.8 · complex tasks',
].join('\n');

// MODELSWITCH body-pollution regression: an EXISTING conversation whose history
// carries its own "1./2./3." numbered list, a ──── divider, AND a blockquote
// "> 1." line (the blockquote even carries a cursor glyph `>` + index 1, which
// the old top-down scan mistook for the live cursor row). The real /model picker
// renders LAST, at the bottom. Pre-fix the top-down first-wins scan bound indices
// 1/2/3 to the body lines and dropped the real options → Sonnet was "not found"
// (or, when a body label collided, the wrong cursor delta committed Opus). The
// bottom-up contiguous-block scan must ignore all of the body and parse only the
// trailing picker (Default / Sonnet / Opus-current).
const BODY_POLLUTED_MODEL_PICKER = [
    '❯ Draft a release plan',
    '',
    '⏺ Sure — here is the rollout plan:',
    '  1. Cut the release branch',
    '  2. Run the smoke suite',
    '  3. Deploy to preview',
    '────────────────────────────────────────────────────────────────',
    '  > 1. an earlier quoted checklist item',
    '',
    '  Select model',
    '    1. Default (recommended)  Opus 4.8 with 1M context · everyday',
    '    2. Sonnet                 Sonnet 4.6 · routine tasks',
    '  ❯ 3. Opus ✔                 Opus 4.8 · complex tasks',
].join('\n');

const ARROW_NAV_SET_MODEL = {
    id: 'set_model',
    label: 'Model',
    visible_when_state: ['idle'],
    action: {
        type: 'open_picker',
        trigger_keys: '/model\r',
        wait_for: { section: 'modal', regex: 'Select (?:a |an )?model' },
        extract_choices: { section: 'modal', pattern: '^\\s*(?:[❯›>]\\s*)?(\\d+)\\.\\s+(.+?)\\s*$' },
        submit_key: '{index}\r',
        select_mode: 'arrow_keys',
    },
};

// An index-keyed picker (codex/hermes style) — number key still works.
const INDEX_SET_MODEL = {
    ...ARROW_NAV_SET_MODEL,
    action: { ...ARROW_NAV_SET_MODEL.action, select_mode: undefined },
};

type Dispatch = { kind: string; data?: string; control_id?: string };

function makePickerAdapter(screenText: string, setModelControl: unknown): { adapter: any; dispatches: Dispatch[] } {
    const dispatches: Dispatch[] = [];
    const adapter = Object.create(SpecCliAdapter.prototype);
    Object.assign(adapter, {
        cliType: 'claude-cli',
        driver: {
            getScreen: () => screenText,
            getSections: () => undefined,
            snapshot: () => screenText,
            dispatch: (event: Dispatch) => dispatches.push(event),
        },
        spec: { control_bar: [setModelControl] },
    });
    return { adapter, dispatches };
}

const pty = (d: Dispatch[]) => d.filter(e => e.kind === 'pty_write').map(e => e.data);
const opens = (d: Dispatch[]) => d.filter(e => e.kind === 'click_control');

describe('SpecCliAdapter — arrow-nav picker SELECT', () => {
    it('steps UP from the active row to the target and confirms (Sonnet from Opus-current)', async () => {
        const { adapter, dispatches } = makePickerAdapter(OPUS_CURRENT_SCREEN, ARROW_NAV_SET_MODEL);

        const res: any = await adapter.invokeScript('set_model', { value: 'Sonnet' });

        // current cursor = row 4 (Opus), target = row 2 (Sonnet) → 2× UP then CR.
        expect(pty(dispatches)).toEqual([`${UP}${UP}`, '\r']);
        // No number key — the digit '2' would be ignored by the cursor list.
        expect(pty(dispatches).join('')).not.toContain('2');
        expect(res.ok).toBe(true);
        expect(res.controlResult.selectedIndex).toBe(2);
        expect(res.controlResult.currentValue).toContain('Sonnet');
    });

    it('steps DOWN when the target is below the active row (Opus from Sonnet-current)', async () => {
        const { adapter, dispatches } = makePickerAdapter(SONNET_CURRENT_SCREEN, ARROW_NAV_SET_MODEL);

        // Select by explicit index 4 — the screen has two rows whose label
        // contains "Opus" (row 1 "Default … Opus 4.8" and row 4 "Opus"), so a
        // short label would be ambiguous; the index is unambiguous here.
        const res: any = await adapter.invokeScript('set_model', { choiceIndex: 4 });

        // current = row 2 (Sonnet), target = row 4 (Opus) → 2× DOWN then CR.
        expect(pty(dispatches)).toEqual([`${DOWN}${DOWN}`, '\r']);
        expect(res.controlResult.selectedIndex).toBe(4);
    });

    it('confirms with no movement when the target is already the cursor row', async () => {
        const { adapter, dispatches } = makePickerAdapter(OPUS_CURRENT_SCREEN, ARROW_NAV_SET_MODEL);

        await adapter.invokeScript('set_model', { choiceIndex: 4 });

        // delta 0 → no arrow dispatch, just the confirm CR.
        expect(pty(dispatches)).toEqual(['\r']);
    });

    it('does NOT re-open an already-rendered picker (no stray CR commits the wrong row)', async () => {
        const { adapter, dispatches } = makePickerAdapter(OPUS_CURRENT_SCREEN, ARROW_NAV_SET_MODEL);

        await adapter.invokeScript('set_model', { value: 'Haiku' });

        // The picker is already on screen, so the trigger /model\r must NOT be
        // re-sent (its CR would Enter on the current row before we navigate).
        expect(opens(dispatches)).toHaveLength(0);
        expect(pty(dispatches)).toEqual([UP, '\r']); // row 4 → row 3 = 1× UP
    });

    it('fails loud when the cursor row cannot be detected (avoids a blind Enter)', async () => {
        const noCursor = OPUS_CURRENT_SCREEN.replace('  ❯ 4. Opus ✔', '    4. Opus');
        const { adapter, dispatches } = makePickerAdapter(noCursor, ARROW_NAV_SET_MODEL);

        const res: any = await adapter.invokeScript('set_model', { value: 'Sonnet' });

        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/cursor row/i);
        // Nothing was committed.
        expect(pty(dispatches)).toEqual([]);
    });
});

describe('SpecCliAdapter — body-pollution regression (MODELSWITCH bottom-up)', () => {
    it('lists ONLY the bottom picker options, ignoring body 1./2./3. + > quote', async () => {
        const { adapter } = makePickerAdapter(BODY_POLLUTED_MODEL_PICKER, ARROW_NAV_SET_MODEL);

        const res: any = await adapter.invokeScript('set_model', {}); // list, no select
        const labels = res.controlResult.options.map((o: any) => o.label);

        // Real picker options — NOT the conversation-history list.
        expect(res.controlResult.options.map((o: any) => o.value)).toHaveLength(3);
        expect(labels.join(' ')).toContain('Default');
        expect(labels.join(' ')).toContain('Sonnet');
        expect(labels.join(' ')).toMatch(/\bOpus\b/);
        expect(labels.join(' ')).not.toMatch(/Cut the release branch|smoke suite|Deploy to preview|earlier quoted/);
        // The cursor row is the picker's Opus row, NOT the body's "> 1." line.
        expect(res.controlResult.currentValue).toContain('Opus');
        expect(res.controlResult.options.filter((o: any) => o.current)).toHaveLength(1);
    });

    it('commits the correct model: Sonnet steps 1× UP from the Opus cursor (was Opus-save)', async () => {
        const { adapter, dispatches } = makePickerAdapter(BODY_POLLUTED_MODEL_PICKER, ARROW_NAV_SET_MODEL);

        const res: any = await adapter.invokeScript('set_model', { value: 'Sonnet' });

        // Picker cursor = row 3 (Opus), Sonnet = row 2 → 1× UP then CR. Pre-fix the
        // body shadowed the options and either errored or stepped from a body row.
        expect(pty(dispatches)).toEqual([UP, '\r']);
        expect(res.ok).toBe(true);
        expect(res.controlResult.selectedIndex).toBe(2);
        expect(res.controlResult.currentValue).toContain('Sonnet');
    });
});

describe('SpecCliAdapter — index-keyed picker SELECT (no regression)', () => {
    it('still types the on-screen number + submit_key when select_mode is absent', async () => {
        const { adapter, dispatches } = makePickerAdapter(OPUS_CURRENT_SCREEN, INDEX_SET_MODEL);

        await adapter.invokeScript('set_model', { value: 'Sonnet' });

        // Index mode: type '2' then CR — the legacy behavior codex/hermes rely on.
        expect(pty(dispatches)).toEqual(['2\r']);
    });
});

describe('claude-cli spec declares arrow-nav for /model', () => {
    it.each(['3.0.json', '4.0.json'])('%s set_model uses select_mode arrow_keys', (file) => {
        const spec = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'adhdev-providers/cli/claude-cli/specs', file), 'utf8'));
        const ctl = (spec.control_bar ?? []).find((c: any) => c.id === 'set_model');
        expect(ctl?.action?.type).toBe('open_picker');
        expect(ctl?.action?.select_mode).toBe('arrow_keys');
    });
});
