/**
 * FSM evaluator — pure transition evaluation for adhdev:cli/spec@4.
 *
 * Given the current state, the screen, and a clock context (when the current
 * state was entered, when each cursor_above region last changed), decides
 * which outgoing transition fires — and records WHY every transition did or
 * did not fire. That "why" trace is the whole point: it is what makes the FSM
 * debuggable from the daemon API without guessing.
 *
 * Screen-content leaves (regex / changed) are delegated to the shared v3
 * condition evaluator. Time leaves (elapsed_ms / stable_ms) are evaluated here
 * against the clock context the driver passes in. No wall-clock reads happen
 * in this file — the driver owns `now` so the function stays pure & testable.
 */
'use strict';

import type { Condition, SectionDef } from './types.js';
import {
    resolveSections, evaluateCondition, type ResolvedSection, type TraceEntry,
} from './evaluator.js';
import {
    type CliSpecV4, type FsmCondition, type FsmTransition,
    outgoingTransitions, stateById,
} from './fsm-types.js';

export interface FsmClock {
    /** Wall-clock now (ms). Passed in so the evaluator stays pure. */
    now: number;
    /** When the current state was entered (ms). */
    stateEnteredAt: number;
    /** Last-changed timestamp per cursor_above region. Key = cursor_above
     *  value (0 / undefined → whole-screen, keyed as -1). Missing key means
     *  "never observed changing" → treated as stable since stateEnteredAt. */
    regionLastChangedAt: Map<number, number>;
}

/** Per-condition evaluation detail — the debugging payload. */
export interface CondResult {
    kind: 'regex' | 'changed' | 'elapsed' | 'stable' | 'all' | 'any' | 'not';
    result: boolean;
    detail: string;
    /** Remaining ms until a time-based condition would flip to true. 0 if
     *  already true or not applicable. Lets the UI show a countdown. */
    remainingMs?: number;
    children?: CondResult[];
}

/** One evaluated transition with its full reasoning. */
export interface TransitionEval {
    to: string;
    label: string;
    /** Did the `from` clause include the current state? (Always true for the
     *  transitions we return — kept for completeness.) */
    eligible: boolean;
    /** min_hold_ms guard satisfied? */
    holdSatisfied: boolean;
    holdRemainingMs: number;
    /** Guard condition result (true if no `when`). */
    condResult: boolean;
    cond?: CondResult;
    /** Overall: would this transition fire? */
    fires: boolean;
    priority: number;
}

export interface FsmEvaluation {
    /** Sections resolved from the screen (shared with v3 shape). */
    sections: ResolvedSection[];
    /** Every outgoing transition from the current state, priority-ordered,
     *  each annotated with why it fired or didn't. */
    transitions: TransitionEval[];
    /** The transition that fires (first in priority order with fires===true),
     *  or null to stay in the current state. */
    fired: TransitionEval | null;
    /** v3-compatible trace lines for the legacy inspector. */
    trace: TraceEntry[];
}

const WHOLE_SCREEN = -1;

function regionKey(cursorAbove: number | undefined): number {
    return cursorAbove && cursorAbove > 0 ? cursorAbove : WHOLE_SCREEN;
}

function isRegex(c: FsmCondition): c is import('./types.js').RegexCondition {
    return 'matches' in c;
}
function isChanged(c: FsmCondition): c is import('./types.js').ChangedCondition {
    return 'cursor_above' in c && 'changed' in c;
}
function isElapsed(c: FsmCondition): c is import('./fsm-types.js').ElapsedCondition {
    return 'elapsed_ms' in c;
}
function isStable(c: FsmCondition): c is import('./fsm-types.js').StableCondition {
    return 'stable_ms' in c;
}
function isAll(c: FsmCondition): c is import('./fsm-types.js').FsmAllCondition {
    return 'all' in c;
}
function isAny(c: FsmCondition): c is import('./fsm-types.js').FsmAnyCondition {
    return 'any' in c;
}
function isNot(c: FsmCondition): c is import('./fsm-types.js').FsmNotCondition {
    return 'not' in c;
}

/**
 * Evaluate a single FSM condition into a {result, detail, remainingMs, children}.
 * Recurses through all/any/not; defers regex/changed to the shared evaluator;
 * handles elapsed_ms/stable_ms against the clock.
 */
function evalCond(
    cond: FsmCondition,
    sections: ResolvedSection[],
    fullScreen: string,
    cursor: { row: number; col: number } | undefined,
    prevLines: string[] | undefined,
    clock: FsmClock,
    legacyTrace: TraceEntry[],
    stateId: string,
): CondResult {
    if (isAll(cond)) {
        const children = cond.all.map(c =>
            evalCond(c, sections, fullScreen, cursor, prevLines, clock, legacyTrace, stateId));
        const result = children.every(c => c.result);
        const remainingMs = result ? 0 : Math.max(0, ...children.filter(c => !c.result).map(c => c.remainingMs ?? 0));
        return { kind: 'all', result, detail: `all(${children.length})`, remainingMs, children };
    }
    if (isAny(cond)) {
        const children = cond.any.map(c =>
            evalCond(c, sections, fullScreen, cursor, prevLines, clock, legacyTrace, stateId));
        const result = children.some(c => c.result);
        // remaining = the soonest child that could flip true
        const pending = children.filter(c => !c.result).map(c => c.remainingMs ?? Infinity);
        const remainingMs = result ? 0 : (pending.length ? Math.min(...pending) : 0);
        return { kind: 'any', result, detail: `any(${children.length})`, remainingMs: Number.isFinite(remainingMs) ? remainingMs : 0, children };
    }
    if (isNot(cond)) {
        const child = evalCond(cond.not, sections, fullScreen, cursor, prevLines, clock, legacyTrace, stateId);
        return { kind: 'not', result: !child.result, detail: `not`, remainingMs: 0, children: [child] };
    }
    if (isElapsed(cond)) {
        const age = clock.now - clock.stateEnteredAt;
        const result = age >= cond.elapsed_ms;
        const remainingMs = result ? 0 : cond.elapsed_ms - age;
        return { kind: 'elapsed', result, detail: `elapsed ${age}ms / ${cond.elapsed_ms}ms`, remainingMs };
    }
    if (isStable(cond)) {
        const key = regionKey(cond.cursor_above);
        // If we never saw the region change, treat it as stable since the
        // state was entered (conservative — avoids a premature "stable" on
        // the very first frame).
        const lastChanged = clock.regionLastChangedAt.get(key) ?? clock.stateEnteredAt;
        const stableFor = clock.now - lastChanged;
        const result = stableFor >= cond.stable_ms;
        const remainingMs = result ? 0 : cond.stable_ms - stableFor;
        const where = key === WHOLE_SCREEN ? 'screen' : `cursor_above=${cond.cursor_above}`;
        return { kind: 'stable', result, detail: `stable ${where} ${stableFor}ms / ${cond.stable_ms}ms`, remainingMs };
    }
    // regex / changed → shared evaluator (operates on v3 Condition shape)
    if (isRegex(cond) || isChanged(cond)) {
        const result = evaluateCondition(cond as Condition, sections, fullScreen, cursor, prevLines, legacyTrace, stateId);
        const kind = isRegex(cond) ? 'regex' : 'changed';
        const detail = isRegex(cond)
            ? `${(cond as any).section ?? '*'}~/${(cond as any).matches}/`
            : `cursor_above=${(cond as any).cursor_above} changed=${(cond as any).changed}`;
        return { kind, result, detail };
    }
    return { kind: 'all', result: false, detail: 'unknown condition' };
}

function fromLabel(t: FsmTransition): string {
    const from = Array.isArray(t.from) ? t.from.join('|') : t.from;
    return t.label ?? `${from}→${t.to}`;
}

/**
 * Evaluate the FSM: given the current state id and screen, return every
 * outgoing transition annotated with why it fires/doesn't, plus the one that
 * fires (if any).
 */
export function evaluateFsm(
    spec: CliSpecV4,
    currentStateId: string,
    screenText: string,
    cursor: { row: number; col: number } | undefined,
    prevLines: string[] | undefined,
    clock: FsmClock,
): FsmEvaluation {
    const legacyTrace: TraceEntry[] = [];
    const lines = screenText.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
    const cleanScreen = lines.join('\n');
    const sections = resolveSections(spec.sections ?? {}, lines);

    const outgoing = outgoingTransitions(spec, currentStateId);
    const transitions: TransitionEval[] = [];
    let fired: TransitionEval | null = null;

    for (const t of outgoing) {
        const holdMs = t.min_hold_ms ?? 0;
        const heldFor = clock.now - clock.stateEnteredAt;
        const holdSatisfied = heldFor >= holdMs;
        const holdRemainingMs = holdSatisfied ? 0 : holdMs - heldFor;

        let cond: CondResult | undefined;
        let condResult = true;
        if (t.when) {
            cond = evalCond(t.when, sections, cleanScreen, cursor, prevLines, clock, legacyTrace, `${currentStateId}→${t.to}`);
            condResult = cond.result;
        }

        const fires = holdSatisfied && condResult;
        const te: TransitionEval = {
            to: t.to,
            label: fromLabel(t),
            eligible: true,
            holdSatisfied,
            holdRemainingMs,
            condResult,
            cond,
            fires,
            priority: t.priority ?? 0,
        };
        transitions.push(te);
        if (fires && !fired) fired = te;
    }

    // Validate destination exists (defensive — loader should catch this).
    if (fired && !stateById(spec, fired.to)) {
        legacyTrace.push({ kind: 'state_skip', text: `transition target ${fired.to} not found` });
        fired = null;
    }

    return { sections, transitions, fired, trace: legacyTrace };
}

/**
 * Evaluate a single condition against a screen + section map — for the spec
 * editor's live preview ("does this regex match the current screen right
 * now?"). Time leaves (elapsed_ms/stable_ms) are evaluated against a synthetic
 * clock where the state was just entered, so they report their countdown
 * rather than firing; the preview is about screen-content match, not timing.
 */
export function evaluateConditionPreview(
    cond: FsmCondition,
    sections: Record<string, SectionDef> | undefined,
    screenText: string,
    cursor?: { row: number; col: number },
): CondResult {
    const lines = screenText.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
    const cleanScreen = lines.join('\n');
    const resolved = resolveSections(sections ?? {}, lines);
    const clock: FsmClock = { now: 0, stateEnteredAt: 0, regionLastChangedAt: new Map() };
    return evalCond(cond, resolved, cleanScreen, cursor, undefined, clock, [], 'preview');
}
