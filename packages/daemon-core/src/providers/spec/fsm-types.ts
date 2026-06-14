/**
 * adhdev:cli/spec@4 — declarative FSM spec.
 *
 * A v4 spec describes a finite state machine the same way a Unity animator
 * layer does: states are nodes, transitions are directed edges with a guard
 * condition. The engine (fsm-driver.ts) holds ZERO CLI-specific knowledge —
 * every concept that used to live in the driver as a hard-coded debounce
 * (startup grace, busy hold, completion marker, idle hold) is now expressed
 * declaratively as either a state, a transition condition, or a transition
 * guard. To support a new CLI you write a spec; you never touch the engine.
 *
 * Reuses v3's section system (sections{}) and condition system (regex /
 * changed / all / any) verbatim — see types.ts. v4 only adds the FSM layer
 * (states[] + transitions[]) on top and two new leaf conditions that are
 * inherently time-based:
 *
 *   - elapsed_ms : true once N ms have passed since the CURRENT state was
 *                  entered. Replaces startup_grace_ms (a `starting` state with
 *                  one `elapsed_ms` transition to idle).
 *   - stable_ms  : true once the cursor_above region has been UNCHANGED for
 *                  N ms. Replaces screen_active_hold_ms / the old changed:false
 *                  + stable_ms combo. Pure region-stability gate.
 *
 * Both are evaluated by the driver (which owns the clock); the shared
 * condition evaluator handles the screen-content leaves (regex / changed).
 */
'use strict';

import type {
    RegexCondition, ChangedCondition,
    Control, NotificationRule, DelegateTrigger,
    NativeHistoryConfig, SectionDef, ExtractTitle, ExtractButtons,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Conditions (v4)
//
// Superset of v3 conditions. Adds the two time-based leaves. The shared
// evaluator handles regex/changed; the driver handles elapsed_ms/stable_ms
// because they need the wall clock and per-region change timestamps.
// ─────────────────────────────────────────────────────────────────────────────

/** True once `ms` have elapsed since the current state was entered. */
export interface ElapsedCondition {
    elapsed_ms: number;
}

/** True once the region `cursor_above` lines above the cursor has been
 *  unchanged for `ms`. A stability gate — the inverse of a busy signal. */
export interface StableCondition {
    stable_ms: number;
    /** Lines above the cursor that must be stable. Default: whole screen. */
    cursor_above?: number;
}

export interface FsmAllCondition {
    all: FsmCondition[];
}

export interface FsmAnyCondition {
    any: FsmCondition[];
}

/** Negation — true when the inner condition is false. Lets a transition say
 *  "go busy unless the completion marker is present", etc. */
export interface FsmNotCondition {
    not: FsmCondition;
}

export type FsmCondition =
    | RegexCondition
    | ChangedCondition
    | ElapsedCondition
    | StableCondition
    | FsmAllCondition
    | FsmAnyCondition
    | FsmNotCondition;

// ─────────────────────────────────────────────────────────────────────────────
// States & transitions (v4)
// ─────────────────────────────────────────────────────────────────────────────

export interface FsmState {
    id: string;
    label: string;
    /** Exactly one state must be `initial: true` — the state at spawn. */
    initial?: boolean;
    /** Modal states (approval/picker) expose modal buttons in the UI and are
     *  treated as "interesting" — the dashboard surfaces them distinctly. */
    modal?: boolean;
    /** Status this state maps to for the dashboard/cli-adapter status field.
     *  One of: idle | generating | approval. Defaults: modal→approval,
     *  initial→idle, id==='busy'→generating, else idle. Explicit wins. */
    status?: 'idle' | 'generating' | 'approval';
    /** Optional extraction run whenever this state is the committed state —
     *  used by modal states to surface a title + buttons. */
    extract?: {
        title?: ExtractTitle;
        buttons?: ExtractButtons;
    };
}

export interface FsmTransition {
    /** Source state id, or list of source ids, or "*" for any state. */
    from: string | string[];
    /** Destination state id. */
    to: string;
    /** Guard condition. Omitted → always eligible (only gated by `from` +
     *  min_hold_ms). Evaluated against the current screen + clock. */
    when?: FsmCondition;
    /** Minimum time the machine must have been in `from` before this edge can
     *  fire. Replaces busy_hold_ms / idle_hold_ms (per-edge, not global). */
    min_hold_ms?: number;
    /** Higher priority transitions are evaluated first. Default 0. Ties broken
     *  by declaration order. */
    priority?: number;
    /** Human label for the debugger. */
    label?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// CliSpecV4 — the v4 runtime spec
// ─────────────────────────────────────────────────────────────────────────────

export interface CliSpecV4 {
    $schema: 'adhdev:cli/spec@4';
    id: string;
    name: string;
    binary: string;
    spawn_args?: string[];
    env?: Record<string, string>;
    cli_version_range?: string;
    /**
     * Optional raw byte sequences written to the PTY once, shortly after spawn,
     * to prime a TUI that gates its input handling on a terminal event the
     * daemon would otherwise never emit. The canonical case is a focus-event
     * TUI (Ink `useStdin`/`useFocus`, e.g. antigravity's `agy`) that enables
     * focus reporting (`CSI ?1004h`) and treats its input box as unfocused —
     * silently dropping the first programmatic write — until it receives a
     * focus-in event (`ESC [ I`). Declaring `["[I"]` here wakes the input
     * stream on spawn so the first delegated message lands without a manual
     * keystroke. CLIs that do not focus-gate input simply omit this field; the
     * engine writes nothing extra for them, so it stays CLI-agnostic.
     */
    send_on_spawn?: string[];
    /** Delay (ms) after spawn before writing `send_on_spawn`. Default 250. */
    send_on_spawn_delay_ms?: number;
    send_message: {
        submit_key: string;
        delay_ms_before_submit?: number;
        delay_ms_per_char?: number;
    };
    sections: Record<string, SectionDef>;
    states: FsmState[];
    transitions: FsmTransition[];
    control_bar?: Control[];
    notifications?: NotificationRule[];
    delegate?: DelegateTrigger[];
    native_history?: NativeHistoryConfig;
    requiresFinalAssistantBeforeIdle?: boolean;
}

export function isV4Spec(raw: unknown): raw is CliSpecV4 {
    return !!raw && typeof raw === 'object'
        && (raw as { $schema?: string }).$schema === 'adhdev:cli/spec@4';
}

export function initialState(spec: CliSpecV4): FsmState {
    return spec.states.find(s => s.initial) ?? spec.states[0];
}

export function stateById(spec: CliSpecV4, id: string): FsmState | undefined {
    return spec.states.find(s => s.id === id);
}

/** Outgoing transitions from `stateId`, highest priority first, declaration
 *  order as tiebreak. Includes wildcard ("*") and list-membership sources. */
export function outgoingTransitions(spec: CliSpecV4, stateId: string): FsmTransition[] {
    const matches = spec.transitions.filter(t => {
        if (t.from === '*') return true;
        if (Array.isArray(t.from)) return t.from.includes(stateId);
        return t.from === stateId;
    });
    // Stable sort by priority desc; Array.prototype.sort is stable in V8 so
    // equal-priority edges keep declaration order.
    return matches
        .map((t, i) => ({ t, i }))
        .sort((a, b) => (b.t.priority ?? 0) - (a.t.priority ?? 0) || a.i - b.i)
        .map(x => x.t);
}

/** Map a state to the dashboard status string, applying the documented
 *  defaults when `status` is not explicit. */
export function statusForState(state: FsmState): 'idle' | 'generating' | 'approval' {
    if (state.status) return state.status;
    if (state.modal) return 'approval';
    if (state.id === 'busy' || state.id === 'generating') return 'generating';
    return 'idle';
}
