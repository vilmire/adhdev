/**
 * Picker control helpers for {@link SpecCliAdapter}.
 *
 * `open_picker` control_bar entries are driven purely from the live screen:
 * the spec's `wait_for` / `extract_choices` / `submit_key` decide how a picker
 * is opened, parsed and committed, so nothing here bakes in model or mode
 * names for any particular CLI.
 *
 * Split out of cli-adapter.ts as a pure move (no behaviour change) to keep
 * that file under the repo's file-size gate — same precedent as the
 * claude-tui-helpers.ts split. The adapter's `this.driver` is the only state
 * these helpers ever touched, so they take it as an explicit parameter.
 */
'use strict';

import { lastContiguousNumberedBlock } from './evaluator.js';
import type { ISpecDriver } from './fsm-driver-types.js';
import type { Control, ControlAction } from './types.js';

export function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

type OpenPickerAction = Extract<ControlAction, { type: 'open_picker' }>;

export type PickerChoice = { index: number; label: string; current: boolean };

/**
 * Open an `open_picker` control and return the options the CLI is showing,
 * parsed live from the screen via `extract_choices`. Nothing is selected —
 * the picker is left open so a follow-up SELECT invoke can commit a choice.
 */
export async function openPickerAndListChoices(
    driver: ISpecDriver,
    ctl: Control,
    action: OpenPickerAction,
): Promise<unknown> {
    driver.dispatch({ kind: 'click_control', control_id: ctl.id });
    const ready = await waitForPickerRendered(driver, action);
    const options = extractPickerChoices(driver, action);
    const currentValue = options.find(o => o.current)?.label;
    return {
        ok: true,
        effects: [{ type: 'opened_picker', controlId: ctl.id }],
        controlResult: {
            options: options.map(o => ({ value: o.label, label: o.label, current: o.current })),
            ...(currentValue ? { currentValue } : {}),
            source: 'screen-parse',
            ...(ready ? {} : { warning: 'picker_render_timeout' }),
        },
    };
}

/**
 * Drive an already-listable picker to a specific option. The option can be
 * named (choiceLabel — matched against the parsed on-screen labels) or
 * positional (choiceIndex — the on-screen number). The actual keystrokes
 * come from the spec's `submit_key` with `{index}` substituted, so the spec
 * — not this code — decides how a selection is keyed for each CLI.
 */
export async function selectPickerChoice(
    driver: ISpecDriver,
    ctl: Control,
    action: OpenPickerAction,
    choiceIndex: number | undefined,
    choiceLabel: string | undefined,
): Promise<unknown> {
    // Open + wait so the choice list is on screen before we resolve the
    // label → index mapping. The picker is normally ALREADY open here (a
    // preceding list invoke leaves it rendered), so only send the trigger
    // when it is not on screen. Re-sending the trigger to an open picker is
    // NOT a harmless no-op on claude-cli: the trailing CR of `/model\r`
    // lands as Enter on the cursor's current row and commits the wrong
    // model before we navigate. De-dup the open to avoid that.
    let options = extractPickerChoicesIfRendered(driver, action);
    if (!options) {
        driver.dispatch({ kind: 'click_control', control_id: ctl.id });
        await waitForPickerRendered(driver, action);
        options = extractPickerChoices(driver, action);
    }

    let index = choiceIndex;
    if ((index == null || !Number.isFinite(index)) && choiceLabel) {
        const needle = choiceLabel.trim().toLowerCase();
        const match = options.find(o => o.label.toLowerCase().includes(needle));
        if (!match) {
            return { ok: false, error: `choice not found on screen: ${choiceLabel}`, controlResult: { options: options.map(o => ({ value: o.label, label: o.label })) } };
        }
        index = match.index;
    }
    if (index == null || !Number.isFinite(index)) {
        return { ok: false, error: 'choiceIndex or choiceLabel required to select' };
    }

    if (action.select_mode === 'arrow_keys') {
        // Cursor-list picker (claude-cli /model): number keys are ignored.
        // The cursor starts on the active row (extract flags it `current`);
        // step it to the target row with arrows, then confirm.
        const current = options.find(o => o.current);
        if (current == null) {
            // Without a known cursor position a blind Enter would commit
            // whatever row the cursor sits on — fail loud instead.
            return {
                ok: false,
                error: 'arrow-nav picker: current cursor row not detected on screen',
                controlResult: { options: options.map(o => ({ value: o.label, label: o.label, current: o.current })) },
            };
        }
        const up = action.cursor_keys?.up ?? '[A';
        const down = action.cursor_keys?.down ?? '[B';
        const delta = index - current.index;
        const step = delta >= 0 ? down : up;
        const nav = step.repeat(Math.abs(delta));
        // Confirm key = submit_key with the (unused) {index} placeholder
        // stripped — e.g. `{index}\r` → `\r`.
        const confirm = (action.submit_key || '\r').replace(/\{index\}/g, '') || '\r';
        if (nav) driver.dispatch({ kind: 'pty_write', data: nav });
        driver.dispatch({ kind: 'pty_write', data: confirm });
    } else {
        const keys = (action.submit_key || '{index}\r').replace(/\{index\}/g, String(index));
        driver.dispatch({ kind: 'pty_write', data: keys });
    }
    const selected = options.find(o => o.index === index);
    return {
        ok: true,
        effects: [{ type: 'selected_choice', controlId: ctl.id }],
        controlResult: {
            ok: true,
            ...(selected ? { currentValue: selected.label } : {}),
            selectedIndex: index,
        },
    };
}

/** Parse the picker choices only if the picker already appears rendered on
 *  the live screen (its `wait_for` condition currently matches and at least
 *  one choice parses). Returns the parsed choices when open, else null so
 *  the caller knows it must send the trigger to open it. Used to de-dup the
 *  picker open in {@link selectPickerChoice}. */
export function extractPickerChoicesIfRendered(
    driver: ISpecDriver,
    action: OpenPickerAction,
): PickerChoice[] | null {
    const wf = action.wait_for;
    if (wf?.regex) {
        const re = new RegExp(wf.regex, wf.flags ?? 'i');
        if (!re.test(readScreenSectionText(driver, wf.section))) return null;
    }
    const options = extractPickerChoices(driver, action);
    return options.length > 0 ? options : null;
}

/** Poll the live screen until the picker's `wait_for` condition matches,
 *  up to a short budget. Returns true if it rendered, false on timeout. */
export async function waitForPickerRendered(driver: ISpecDriver, action: OpenPickerAction): Promise<boolean> {
    const wf = action.wait_for;
    if (!wf?.regex) { await delay(250); return true; }
    const re = new RegExp(wf.regex, wf.flags ?? 'i');
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
        await delay(120);
        const hay = readScreenSectionText(driver, wf.section);
        if (re.test(hay)) return true;
    }
    return false;
}

/** Parse the picker's `extract_choices` pattern against the live screen.
 *  Each match yields { index, label, current }. `current` is true for the
 *  line the CLI marks with its cursor glyph (❯ ›). Purely screen-driven —
 *  no model/mode names are baked in. */
export function extractPickerChoices(driver: ISpecDriver, action: OpenPickerAction): PickerChoice[] {
    const ec = action.extract_choices;
    if (!ec?.pattern) return [];
    const text = readScreenSectionText(driver, ec.section);
    // Collect EVERY matching line in screen order with no top-down de-dup.
    // The picker section can include conversation history above it (a stray
    // "1./2./3." list, blockquote `>` lines); a `seen.has(idx)` first-wins
    // scan would let those body lines claim the option indices and shadow
    // the real choices — committing the wrong model under arrow-key nav.
    const all: PickerChoice[] = [];
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
    // Real options are the bottom-most contiguous numbered block; this also
    // confines the `current` cursor flag to that block so a body `>` line is
    // never mistaken for the cursor row.
    return lastContiguousNumberedBlock(all);
}

/** Live text of a named screen section (or the whole screen when no
 *  section is named), resolved from the driver's current sections. */
export function readScreenSectionText(driver: ISpecDriver, sectionId?: string): string {
    try {
        // One read: the section text and the whole-screen fallback must come
        // from the same frame, or a repaint between them yields a section
        // that never coexisted with the screen it is reported against.
        const screen = driver.getScreen();
        const sections = driver.getSections(screen);
        if (sectionId && sections) {
            const hit = sections.find(s => s.id === sectionId);
            if (hit) return hit.text;
        }
        return screen;
    } catch {
        return '';
    }
}

/**
 * Map an adapter invokeScript(name, args) call onto a control_bar entry.
 *
 * scriptName is matched against control.id. The control's action.type
 * drives the dispatch:
 *
 *   send_keys     → click_control                   (e.g. stop)
 *   open_picker   → two roles, driven by the screen, not a hardcoded list:
 *                   - LIST  (no choice arg): open the picker, wait for it
 *                     to render, parse the on-screen options via
 *                     `extract_choices`, and return them as
 *                     `controlResult.options` (+ `currentValue`). This is
 *                     how the dashboard's Model/Mode controls learn what is
 *                     actually selectable in this CLI right now.
 *                   - SELECT (args.choiceIndex / args.choiceLabel): drive
 *                     the picker to that option using `submit_key`.
 *   attach_image  → attach_image dispatch; expects args.blob (data url
 *                   or base64) and args.mime
 *
 * Callers that pass an unknown control id get a { not_found } response.
 * No control matched, no driver call — keeps the surface honest.
 */
export function invokeSpecControl(
    driver: ISpecDriver,
    controls: Control[],
    scriptName: string,
    args?: Record<string, unknown>,
): Promise<unknown> {
    const ctl = controls.find(c => c.id === scriptName);
    if (!ctl) {
        return Promise.resolve({ ok: false, error: `unknown control: ${scriptName}` });
    }
    // Args may arrive as either { blob, mime } (direct invocation) or
    // { params: { blob, mime } } (when the dashboard wraps script args
    // in a params bag). Look at both.
    const flat: Record<string, unknown> = { ...(args || {}) };
    if (args && typeof args.params === 'object' && args.params) {
        Object.assign(flat, args.params as Record<string, unknown>);
    }
    const action = ctl.action;
    if (action.type === 'attach_image') {
        const blob = typeof flat.blob === 'string' ? flat.blob : '';
        const mime = typeof flat.mime === 'string' ? flat.mime : 'image/png';
        if (!blob) return Promise.resolve({ ok: false, error: 'attach_image requires args.blob (base64 or data URL)' });
        driver.dispatch({ kind: 'attach_image', blob, mime });
        return Promise.resolve({ ok: true, effects: [{ type: 'attached_image', controlId: ctl.id }] });
    }
    if (action.type === 'open_picker') {
        const choiceIndex = typeof flat.choiceIndex === 'number' ? flat.choiceIndex
            : typeof flat.choiceIndex === 'string' && flat.choiceIndex.trim() ? Number(flat.choiceIndex)
            : undefined;
        // `value` is the arg the dashboard's generic value-control set path
        // sends ({ value: <chosen option> }). control_bar pickers are
        // surfaced to the dashboard as dynamic `select` controls whose
        // option values are the screen-parsed labels, so a bare `value`
        // is just a label to match against the live choices.
        const choiceLabel = typeof flat.choiceLabel === 'string' ? flat.choiceLabel
            : typeof flat.choice === 'string' ? flat.choice
            : typeof flat.value === 'string' ? flat.value
            : undefined;
        if ((typeof choiceIndex === 'number' && Number.isFinite(choiceIndex)) || (choiceLabel && choiceLabel.trim())) {
            return selectPickerChoice(driver, ctl, action, choiceIndex, choiceLabel);
        }
        return openPickerAndListChoices(driver, ctl, action);
    }
    // send_keys routes through click_control.
    driver.dispatch({ kind: 'click_control', control_id: ctl.id, payload: flat });
    return Promise.resolve({ ok: true, effects: [{ type: 'sent_keys', controlId: ctl.id }] });
}
