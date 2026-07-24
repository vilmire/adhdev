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

/** True once a region has been unchanged for `ms`. A stability gate — the
 *  inverse of a busy signal.
 *
 *  Region selection (precedence order):
 *   - `section`     : a named section from the spec's `sections{}` (e.g. "body").
 *                     Only lines inside that section are watched for change.
 *   - `cursor_above`: the N lines directly above the cursor.
 *   - neither       : the whole screen (default).
 *
 *  `ignore_lines` is orthogonal to region choice: lines matching it are
 *  stripped from BOTH frames before the change comparison, so a per-frame
 *  animation on those lines cannot reset the stable clock. This is the
 *  content-aware escape hatch for the busy→idle wedge — a benign residual
 *  ticker (a bare token counter / elapsed timer that repaints every frame
 *  after generation has finished) is filtered out, so a genuinely settled
 *  transcript can reach `stable_ms`. It is deliberately CONTENT-based, not
 *  geometric: an ACTIVE spinner line (glyph + esc/token trailer) does NOT
 *  match the benign pattern, so a real below-prompt spinner tick still resets
 *  the clock and holds busy (the FALSEIDLE2 / FALSEBUSY-B invariant). */
export interface StableCondition {
    stable_ms: number;
    /** Named section (from `sections{}`) that must be stable. Takes precedence
     *  over `cursor_above`. */
    section?: string;
    /** Lines above the cursor that must be stable. Default: whole screen.
     *  Ignored when `section` is set. */
    cursor_above?: number;
    /** Regex (line-tested with `m` flag). Lines matching it are removed from
     *  both the current and previous frame before deciding whether the region
     *  changed — a per-frame repaint confined to these lines does NOT reset the
     *  stability clock. Use for benign residual animation (token counter /
     *  elapsed timer). Must NOT match an active-spinner line, or a real spinner
     *  tick would be masked. */
    ignore_lines?: string;
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
    /**
     * For a modal state, what KIND of modal it is — the semantic distinction the
     * status field (always 'approval' for any modal, so the dashboard surfaces it)
     * deliberately loses. The auto-approve worker uses this to decide whether it
     * may answer the modal on the user's behalf:
     *
     *   - 'approval' — a tool/command/trust consent prompt ("Allow Bash?",
     *     "Trust this folder?"). Auto-approve MAY fire (a background mesh worker
     *     should not stall on these).
     *   - 'picker'   — a selection menu the user opened (/model, /mode, …). There
     *     is no "correct" answer to auto-pick; blindly selecting the first option
     *     silently changes the model/mode. Auto-approve must NOT fire — the user
     *     chooses.
     *   - 'confirm'  — a non-consent yes/no the user must decide. Left to the user.
     *
     * Defaults to 'approval' for a modal state that omits it (preserves the
     * pre-existing "auto-approve any modal" behaviour for un-migrated specs;
     * picker/confirm states declare their kind explicitly). Non-modal states
     * have no modal_kind.
     */
    modal_kind?: 'approval' | 'picker' | 'confirm';
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

/**
 * Declarative "trust this folder before spawn" config. Some agent CLIs gate the
 * first run in a new folder behind an interactive trust prompt and persist the
 * answer as a string array in a JSON settings file. Declaring this lets the
 * engine add the workspace path to that array before spawn so the prompt never
 * appears — the robust alternative to detecting and auto-clicking the modal.
 * CLIs without such a gate omit this field and the engine does nothing.
 */
export interface PreLaunchTrust {
    /** Path to the CLI's JSON settings file. A leading `~` expands to $HOME. */
    settings_path: string;
    /** Key of the string-array of trusted folder paths within that file. */
    key: string;
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
    /**
     * Opt-in stall recovery for focus-gated TUIs. The same CLIs that need
     * `send_on_spawn` (focus-event TUIs like antigravity's `agy`) also stop
     * rendering / flushing output the moment they believe they have lost focus
     * MID-TURN — the screen freezes and only repaints once the user presses a
     * key, which the daemon never does on its own. When this field is set and
     * the machine is in a `generating`-status state whose screen has not changed
     * for `refocus_when_stalled_ms`, the engine re-injects the `send_on_spawn`
     * prime (the focus-in event) once to wake the render loop, then waits for the
     * screen to change or for the stall window to lapse again before re-priming
     * (a cooldown that prevents a tight re-prime loop). Requires `send_on_spawn`
     * to carry the wake sequence; with no `send_on_spawn` there is nothing to
     * re-inject and the engine does nothing. Omitted by every non-focus-gated
     * CLI spec, so the engine stays CLI-agnostic.
     */
    refocus_when_stalled_ms?: number;
    /**
     * Optional pre-spawn folder-trust step. When present, the engine adds the
     * launch workspace path to the declared trusted-folders array before
     * spawning, so a CLI that gates first run on a "trust this folder?" prompt
     * (e.g. antigravity's `agy`) starts trusted and never blocks. Omitted for
     * CLIs without such a gate. See pre-launch-trust.ts.
     */
    pre_launch_trust?: PreLaunchTrust;
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
    /** Completion-timing HOLD class (native-history provider whose answer lands in native history, e.g.
     *  antigravity-cli): idle-without-final-assistant holds for the transcript instead of emitting/flooring. */
    holdCompletionForTranscript?: boolean;
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

/**
 * The modal kind for a state, or null when the state is not modal. A modal state
 * that omits `modal_kind` defaults to 'approval' so the established
 * auto-approve-any-modal behaviour is preserved for specs that have not yet
 * declared a kind; picker/confirm states must opt out by declaring their kind.
 * This is the value the cli-adapter carries on `activeModal.kind` and the
 * auto-approve gate reads — see cli-provider-instance.maybeAutoApproveStatus.
 */
export function modalKindForState(state: FsmState): 'approval' | 'picker' | 'confirm' | null {
    if (state.modal_kind) return state.modal_kind;
    if (state.modal) return 'approval';
    return null;
}
