/**
 * Control-bar / picker / shadow-log / wake-schedule helpers for FsmDriver —
 * split out of fsm-driver.ts for the file-size gate (move only, no behavior
 * change). Each function takes exactly what the corresponding FsmDriver method
 * read from `this`; the driver methods are thin delegates.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveSections, sectionText } from './evaluator.js';
import type { FsmEvaluation, TransitionEval } from './fsm-evaluator.js';
import type { Control } from './types.js';
import type { CliSpecV4 } from './fsm-types.js';
import type { FsmSnapshotEntry, VisibleControl } from './fsm-driver-types.js';
import { summarizeTransition } from './fsm-driver-frame.js';
import { LOG } from '../../logging/logger.js';
import { guessExt } from './submit-policy.js';

export function deriveControls(spec: CliSpecV4, stateId: string): VisibleControl[] {
    const out: VisibleControl[] = [];
    for (const c of spec.control_bar ?? []) {
        if (c.visible_when_state && !c.visible_when_state.includes(stateId)) continue;
        out.push({ id: c.id, label: c.label, actionType: c.action.type });
    }
    return out;
}

/** Soonest pending time-condition across the not-yet-firing outgoing transitions (Infinity if none). */
export function soonestPendingTransitionMs(ev: FsmEvaluation): number {
    let soonest = Infinity;
    for (const t of ev.transitions) {
        if (t.fires) continue;
        if (!t.holdSatisfied) soonest = Math.min(soonest, t.holdRemainingMs);
        const condRemain = t.cond ? t.cond.remainingMs ?? Infinity : Infinity;
        // Only treat the cond countdown as a wake source when the rest of
        // the guard (hold) is already or will be satisfied.
        if (Number.isFinite(condRemain) && condRemain > 0) soonest = Math.min(soonest, condRemain);
    }
    return soonest;
}

/**
 * TX-FSM Stage 0 (shadow): compare each signal-guarded transition's
 * counterfactual verdict against the real (PTY-only) one and log on FLIP.
 * This is the "만약 적용했다면" half of the shadow log — the Stage 1-3
 * evidence for whether signal gating would have changed any verdict, and
 * in which direction. Read-only: runs after the evaluation is complete
 * and never feeds back into it.
 */
export function logShadowDivergence(ev: FsmEvaluation, currentStateId: string, last: Map<string, boolean>, specTag: string): void {
    for (const t of ev.transitions) {
        if (!t.shadow) continue;
        const key = `${currentStateId}→${t.to}`;
        const diverges = t.shadow.fires !== t.fires;
        if ((last.get(key) ?? false) === diverges) continue;
        last.set(key, diverges);
        if (diverges) {
            LOG.info(
                'FsmDriver',
                `[${specTag}] [shadow] ${key} (${t.label}): real fires=${t.fires}`
                + ` but signal-gated verdict would be fires=${t.shadow.fires}`
                + ` (shadowCond=${t.shadow.condResult}${t.shadow.unknown ? ', signal unknown/fail-open' : ''})`,
            );
        } else {
            LOG.info(
                'FsmDriver',
                `[${specTag}] [shadow] ${key} (${t.label}): shadow verdict realigned with real fires=${t.fires}`,
            );
        }
    }
}

/** Snapshot the full FSM evaluation that produced a transition into the
 *  separate fsmSnapshotHistory ring buffer (max 20). The transitions[]
 *  table is captured by reference — it is freshly built per evaluation in
 *  evaluateFsm and never mutated after, so no clone is needed. */
export function pushFsmSnapshot(history: FsmSnapshotEntry[], from: string, fired: TransitionEval, now: number, ev: FsmEvaluation): void {
    history.push({
        stateFrom: from,
        stateTo: fired.to,
        at: now,
        firedTo: fired.to,
        firedLabel: fired.label,
        reason: summarizeTransition(fired),
        transitions: ev.transitions,
    });
    if (history.length > 20) history.shift();
}

/** Run a control-bar action's key writes. Returns true when an `open_picker` control was opened
 *  (the caller then tracks it as the in-progress picker). */
export function runControlAction(ctl: Control, payload: unknown, sendKeys: (keys: string) => void): boolean {
    const a = ctl.action;
    switch (a.type) {
        case 'send_keys': sendKeys(a.keys); return false;
        case 'open_picker':
            // Some TUIs (e.g. codex) don't register a slash command if its
            // text and the submitting Enter arrive in the same write — the
            // composer needs a beat to recognise the command before the CR.
            // Split a trailing CR/LF off the trigger and send it after a
            // short delay, mirroring send_message's delay_ms_before_submit.
            {
                const m = /^([\s\S]*?)([\r\n]+)$/.exec(a.trigger_keys);
                if (m && m[1]) {
                    sendKeys(m[1]);
                    setTimeout(() => sendKeys(m[2]), 200);
                } else {
                    sendKeys(a.trigger_keys);
                }
            }
            return true;
        case 'attach_image': {
            const p = typeof payload === 'object' && payload && (payload as any).path;
            if (typeof p === 'string') sendKeys(a.keys_template.replace(/\{path\}/g, p));
            return false;
        }
    }
    return false;
}

export function attachImageToTmpAndSend(spec: CliSpecV4, blob: string, mime: string, sendKeys: (keys: string) => void): void {
    const ctl = (spec.control_bar ?? []).find(c => c.action.type === 'attach_image');
    if (!ctl || ctl.action.type !== 'attach_image') return;
    const ext = guessExt(mime);
    const tmp = path.join(os.tmpdir(), `adhdev-attach-${Date.now()}${ext}`);
    try { fs.writeFileSync(tmp, Buffer.from(blob, 'base64')); } catch { return; }
    sendKeys(ctl.action.keys_template.replace(/\{path\}/g, tmp));
}

/** True when the in-progress picker's `wait_for` regex now matches the screen (caller clears the picker). */
export function pickerWaitSatisfied(picker: { control_id: string; spec: Control }, spec: CliSpecV4, screen: string): boolean {
    const action = picker.spec.action;
    if (action.type !== 'open_picker' || !action.wait_for.regex) return false;
    const lines = screen.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
    const sections = resolveSections(spec.sections ?? {}, lines);
    const hay = sectionText(sections, action.wait_for.section, lines.join('\n'));
    const re = new RegExp(action.wait_for.regex, action.wait_for.flags ?? 'i');
    return re.test(hay);
}
