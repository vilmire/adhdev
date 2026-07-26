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
    resolveSections, evaluateCondition, sectionText, type ResolvedSection, type TraceEntry,
} from './evaluator.js';
import {
    type CliSpecV4, type FsmCondition, type FsmTransition,
    outgoingTransitions, stateById,
} from './fsm-types.js';
import { evaluateSignalLeaf, type SignalSnapshot } from './signal-envelope.js';

export interface FsmClock {
    /** Wall-clock now (ms). Passed in so the evaluator stays pure. */
    now: number;
    /** When the current state was entered (ms). */
    stateEnteredAt: number;
    /** Last-changed timestamp per stable region. Numeric key = cursor_above
     *  value (0 / undefined → whole-screen, keyed as -1). String key =
     *  `section:<id>` for a section-scoped stable region. Missing key means
     *  "never observed changing" → treated as stable since stateEnteredAt. */
    regionLastChangedAt: Map<number | string, number>;
}

/** Per-condition evaluation detail — the debugging payload. */
export interface CondResult {
    kind: 'regex' | 'changed' | 'elapsed' | 'stable' | 'signal' | 'all' | 'any' | 'not';
    result: boolean;
    detail: string;
    /** Remaining ms until a time-based condition would flip to true. 0 if
     *  already true or not applicable. Lets the UI show a countdown. */
    remainingMs?: number;
    /** Debug-only: the actual substring a TRUE regex condition matched, so the
     *  snapshot shows WHAT text the rule fired on — not just which regex. Never
     *  read by the FSM; purely for the Spec Debug Snapshot. */
    matchedText?: string;
    /** TX-FSM Stage 0 (shadow): present only on `signal` leaves. `result` above
     *  is ALWAYS true for a signal leaf (Stage-0 pass-through — the leaf never
     *  gates a transition); this payload records what the leaf WOULD have
     *  decided against the injected snapshot. shadowResult null = the signal
     *  was unavailable/unknown (fail-open). */
    signal?: { name: string; available: boolean; value: boolean | null; shadowResult: boolean | null };
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
    /**
     * TX-FSM Stage 0 (shadow): present only when the guard contains at least
     * one `signal` leaf. Records the verdict the transition WOULD have
     * produced if signal leaves gated (condResult/fires), so the shadow log
     * can compare it against the real PTY-only outcome. `unknown` = at least
     * one signal leaf had no observation (fail-open); the shadow verdict is
     * then informational, not a counterfactual proof. NEVER consumed by the
     * driver for any transition decision — log/debug surface only.
     */
    shadow?: { condResult: boolean; fires: boolean; unknown: boolean };
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

/** The `regionLastChangedAt` key for a stable condition. The key must capture
 *  everything that makes two stable clauses watch a DIFFERENT change signal:
 *  the geometric region (`section` wins over `cursor_above`, else whole-screen)
 *  AND the `ignore_lines` filter (two clauses on the same region but different
 *  ignore patterns see different "did it change" answers). Kept in one place so
 *  the driver (which populates the map) and the evaluator (which reads it)
 *  agree on the key.
 *
 *  Bare whole-screen with no ignore filter keeps its historical numeric key -1
 *  so existing callers/tests that seed `regionLastChangedAt` with [-1, ...]
 *  keep working unchanged. */
export function stableRegionKey(cond: { section?: string; cursor_above?: number; ignore_lines?: string }): number | string {
    const region = cond.section
        ? `section:${cond.section}`
        : (cond.cursor_above && cond.cursor_above > 0 ? cond.cursor_above : WHOLE_SCREEN);
    if (!cond.ignore_lines) return region;
    return `${region}#ignore:${cond.ignore_lines}`;
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
function isSignal(c: FsmCondition): c is import('./fsm-types.js').FsmSignalCondition {
    return 'signal' in c;
}

/** True when the condition tree contains at least one `signal` leaf — only
 *  those trees get a Stage-0 shadow verdict. */
function containsSignal(c: FsmCondition): boolean {
    if (isSignal(c)) return true;
    if (isAll(c)) return c.all.some(containsSignal);
    if (isAny(c)) return c.any.some(containsSignal);
    if (isNot(c)) return containsSignal(c.not);
    return false;
}

/**
 * Fold an already-evaluated CondResult tree into the Stage-0 SHADOW verdict:
 * signal leaves contribute their shadowResult (what they WOULD have decided),
 * every other leaf contributes its real result, and all/any/not compose
 * exactly as they did for the real verdict. Pure tree fold — no re-evaluation,
 * so the shadow can never diverge from the real eval on PTY leaves.
 *
 * `unknown` tracks three-valued logic precisely: a definite child verdict
 * decides the parent (false child ⇒ all is definitely false; true child ⇒ any
 * is definitely true); only when no child decides does an unknown signal leaf
 * make the parent unknown.
 */
function foldShadow(cond: CondResult): { value: boolean; unknown: boolean } {
    if (cond.kind === 'signal') {
        const s = cond.signal;
        if (s && s.shadowResult !== null && s.shadowResult !== undefined) {
            return { value: s.shadowResult, unknown: false };
        }
        return { value: true, unknown: true }; // fail-open placeholder
    }
    if (cond.kind === 'not' && cond.children?.length) {
        const c = foldShadow(cond.children[0]);
        return { value: !c.value, unknown: c.unknown };
    }
    if (cond.kind === 'all' && cond.children) {
        const kids = cond.children.map(foldShadow);
        if (kids.some(k => !k.unknown && !k.value)) return { value: false, unknown: false };
        if (kids.some(k => k.unknown)) return { value: true, unknown: true };
        return { value: true, unknown: false };
    }
    if (cond.kind === 'any' && cond.children) {
        const kids = cond.children.map(foldShadow);
        if (kids.some(k => !k.unknown && k.value)) return { value: true, unknown: false };
        if (kids.some(k => k.unknown)) return { value: false, unknown: true };
        return { value: false, unknown: false };
    }
    return { value: cond.result, unknown: false };
}

/**
 * Evaluate a single FSM condition into a {result, detail, remainingMs, children}.
 * Recurses through all/any/not; defers regex/changed to the shared evaluator;
 * handles elapsed_ms/stable_ms against the clock.
 *
 * `signalSnapshot` is the daemon-injected observation (TX-FSM Stage 0). A
 * `signal` leaf evaluates to result=true UNCONDITIONALLY (Stage-0 pass-through
 * — the leaf never gates a transition) and records its would-be verdict in
 * CondResult.signal for the shadow fold. The pass-through, not the snapshot,
 * is what the FSM sees.
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
    signalSnapshot?: SignalSnapshot | null,
): CondResult {
    if (isAll(cond)) {
        const children = cond.all.map(c =>
            evalCond(c, sections, fullScreen, cursor, prevLines, clock, legacyTrace, stateId, signalSnapshot));
        const result = children.every(c => c.result);
        const remainingMs = result ? 0 : Math.max(0, ...children.filter(c => !c.result).map(c => c.remainingMs ?? 0));
        return { kind: 'all', result, detail: `all(${children.length})`, remainingMs, children };
    }
    if (isAny(cond)) {
        const children = cond.any.map(c =>
            evalCond(c, sections, fullScreen, cursor, prevLines, clock, legacyTrace, stateId, signalSnapshot));
        const result = children.some(c => c.result);
        // remaining = the soonest child that could flip true
        const pending = children.filter(c => !c.result).map(c => c.remainingMs ?? Infinity);
        const remainingMs = result ? 0 : (pending.length ? Math.min(...pending) : 0);
        return { kind: 'any', result, detail: `any(${children.length})`, remainingMs: Number.isFinite(remainingMs) ? remainingMs : 0, children };
    }
    if (isNot(cond)) {
        const child = evalCond(cond.not, sections, fullScreen, cursor, prevLines, clock, legacyTrace, stateId, signalSnapshot);
        return { kind: 'not', result: !child.result, detail: `not`, remainingMs: 0, children: [child] };
    }
    if (isSignal(cond)) {
        const leaf = evaluateSignalLeaf(cond, signalSnapshot);
        // STAGE-0 PASS-THROUGH: result is always true so the leaf can never
        // change `fires` — not even when a spec author adds a signal condition
        // today. The shadow fold (foldShadow) reads `signal.shadowResult`.
        return {
            kind: 'signal',
            result: true,
            detail: `${leaf.detail} (stage0 shadow — pass-through)`,
            signal: {
                name: cond.signal,
                available: !!signalSnapshot?.available,
                value: leaf.value,
                shadowResult: leaf.shadowResult,
            },
        };
    }
    if (isElapsed(cond)) {
        const age = clock.now - clock.stateEnteredAt;
        const result = age >= cond.elapsed_ms;
        const remainingMs = result ? 0 : cond.elapsed_ms - age;
        return { kind: 'elapsed', result, detail: `elapsed ${age}ms / ${cond.elapsed_ms}ms`, remainingMs };
    }
    if (isStable(cond)) {
        const key = stableRegionKey(cond);
        // If we never saw the region change, treat it as stable since the
        // state was entered (conservative — avoids a premature "stable" on
        // the very first frame).
        const lastChanged = clock.regionLastChangedAt.get(key) ?? clock.stateEnteredAt;
        const stableFor = clock.now - lastChanged;
        const result = stableFor >= cond.stable_ms;
        const remainingMs = result ? 0 : cond.stable_ms - stableFor;
        const where = cond.section ? `section=${cond.section}`
            : cond.cursor_above && cond.cursor_above > 0 ? `cursor_above=${cond.cursor_above}` : 'screen';
        const ign = cond.ignore_lines ? ' (ignore_lines)' : '';
        return { kind: 'stable', result, detail: `stable ${where}${ign} ${stableFor}ms / ${cond.stable_ms}ms`, remainingMs };
    }
    // regex / changed → shared evaluator (operates on v3 Condition shape)
    if (isRegex(cond) || isChanged(cond)) {
        const result = evaluateCondition(cond as Condition, sections, fullScreen, cursor, prevLines, legacyTrace, stateId);
        const kind = isRegex(cond) ? 'regex' : 'changed';
        const detail = isRegex(cond)
            ? `${(cond as any).section ?? '*'}~/${(cond as any).matches}/`
            : `cursor_above=${(cond as any).cursor_above} changed=${(cond as any).changed}`;
        // Debug-only: when a regex condition is TRUE, also capture the substring
        // it matched so the snapshot can show the exact text the rule fired on.
        // This re-runs the regex (read-only) and CANNOT change `result` above —
        // the FSM decision is still entirely owned by evaluateCondition().
        let matchedText: string | undefined;
        if (result && isRegex(cond)) {
            try {
                const hay = sectionText(sections, (cond as any).section, fullScreen);
                const re = new RegExp((cond as any).matches, (cond as any).flags ?? 'i');
                const m = re.exec(hay);
                if (m && m[0]) matchedText = m[0].replace(/\s+/g, ' ').trim().slice(0, 160);
            } catch { /* capture is best-effort; never affects result */ }
        }
        return matchedText ? { kind, result, detail, matchedText } : { kind, result, detail };
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
    signalSnapshot?: SignalSnapshot | null,
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
            cond = evalCond(t.when, sections, cleanScreen, cursor, prevLines, clock, legacyTrace, `${currentStateId}→${t.to}`, signalSnapshot);
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
        // TX-FSM Stage 0 (shadow): record the counterfactual verdict for any
        // guard containing a signal leaf. Read-only — `fires` above is already
        // fixed by the pass-through rule before this runs.
        if (t.when && containsSignal(t.when) && cond) {
            const folded = foldShadow(cond);
            te.shadow = {
                condResult: folded.value,
                fires: holdSatisfied && folded.value,
                unknown: folded.unknown,
            };
        }
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
