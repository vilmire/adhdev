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
import type { SignalRule } from './signal-rules.js';

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

/**
 * TX-FSM Stage 0 (shadow) — a daemon-signal leaf. References a NORMALIZED
 * signal name from the SignalSnapshot envelope (never a provider name), so a
 * spec can combine transcript evidence with PTY conditions via all/any/not:
 *
 *   { all: [ { matches: "…" }, { signal: "final_assistant_present" } ] }
 *
 * STAGE-0 SEMANTICS: evaluated for the shadow log only. The leaf NEVER gates
 * a transition — the evaluator treats it as pass-through for the real verdict
 * and records what it WOULD have decided (TransitionEval.shadow). A missing
 * or unavailable signal fails open. Promotion to a real gate is Stage 1+.
 */
export interface FsmSignalCondition {
    /** Normalized signal name (see SIGNAL_NAMES in signal-envelope.ts). */
    signal: string;
    /** Expected value; default true. */
    equals?: boolean;
}

export type FsmCondition =
    | RegexCondition
    | ChangedCondition
    | ElapsedCondition
    | StableCondition
    | FsmSignalCondition
    | FsmAllCondition
    | FsmAnyCondition
    | FsmNotCondition;

// ─────────────────────────────────────────────────────────────────────────────
// States & transitions (v4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The coarse status an FSM state projects to the dashboard / cli-adapter. Named
 * (rather than repeated inline at each of the four consumers) so widening it
 * again surfaces as type errors at every site instead of silently diverging —
 * the `waiting_external` addition found three copies of the literal union.
 */
export type FsmStatus = 'idle' | 'generating' | 'approval' | 'waiting_external';

/** Runtime mirror of `FsmStatus`, used by the loader to validate a spec's
 *  declared `status`. Kept next to the type (and `satisfies`-checked against it)
 *  so a future value cannot be added to one without the other — the loader
 *  silently rejecting a status the engine understands would present as "my spec
 *  does not load" with no hint why. */
export const FSM_STATUS_VALUES = ['idle', 'generating', 'approval', 'waiting_external'] as const;

// Two-way lock between the list and the union. `Extract` proves every LISTED
// value is a real FsmStatus; `Exclude` proves every FsmStatus member is LISTED.
// Both are needed: with only the first, adding a union member and forgetting the
// list leaves the loader rejecting a status the engine understands — which
// presents to a spec author as "my spec does not load" with no hint why.
type _FsmStatusListIsValid =
    Exclude<(typeof FSM_STATUS_VALUES)[number], FsmStatus> extends never ? true : never;
type _FsmStatusListIsExhaustive =
    Exclude<FsmStatus, (typeof FSM_STATUS_VALUES)[number]> extends never ? true : never;
const _fsmStatusListIsValid: _FsmStatusListIsValid = true;
const _fsmStatusListIsExhaustive: _FsmStatusListIsExhaustive = true;
void _fsmStatusListIsValid;
void _fsmStatusListIsExhaustive;

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
     *  One of: idle | generating | approval | waiting_external. Defaults:
     *  modal→approval, initial→idle, id==='busy'→generating, else idle.
     *  Explicit wins.
     *
     *  `waiting_external` — APPROVAL-WAIT-BLINDSPOT (live defect, 2026-09-22).
     *  The session is BLOCKED on an action outside the terminal that only a
     *  human can perform: an OAuth/device login to be completed in a browser, a
     *  2FA confirmation, an external approval link. It is not `generating` (no
     *  work is happening and none will until the human acts) and it is not
     *  `idle` (the session cannot accept a prompt). Crucially it is also not a
     *  modal: there are NO on-screen buttons to press, so it must never be
     *  declared with `modal: true` — mesh_approve would have nothing to press
     *  and the auto-approve gate must not treat it as answerable.
     *
     *  Before this value existed there was no way to SAY "waiting on a human,
     *  outside the terminal": grok's browser-login screen matched no state at
     *  all (invisible to the FSM → zero ledger events → zero inbox rows, and
     *  the mesh stall watchdog eventually killed the task), while antigravity
     *  approximated it with `signing_in: {status: 'generating'}`, which is
     *  indistinguishable from real work.
     *
     *  Downstream it projects to the `waiting_approval` ProviderStatus (see
     *  SpecCliAdapter.getStatus) so the coordinator SEES a blocked worker in
     *  mesh_list_pending_approvals and the stall watchdog re-arms instead of
     *  reporting no_progress. Auto-approve stays inert by construction: it
     *  requires a parsed `activeModal` with buttons, and a non-modal state
     *  produces none. */
    status?: FsmStatus;
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
export interface PreLaunchTrustSettingsArray {
    /** Path to the CLI's JSON settings file. A leading `~` expands to $HOME. */
    settings_path: string;
    /** Key of the string-array of trusted folder paths within that file. */
    key: string;
}

/**
 * Named per-workspace-file trust scheme, for CLIs whose trust store is not an
 * array in one settings file. kimi persists trust as ONE FILE PER WORKSPACE
 * (`~/.kimi-code/workspace-trust/wd_<slug>_<sha256[:12]>` with a JSON payload)
 * and exits 0 silently when the prompt goes unanswered — so a spec migration
 * without this would kill every fresh-worktree mesh launch. The scheme's exact
 * key/payload format lives in providers/kimi-workspace-trust.ts (verified
 * against the real kimi-code source); the spec only SELECTS the scheme by
 * name — the same philosophy as native_history source kinds. New per-file
 * formats become new scheme names, never inline templates.
 *
 * 'grok_toml_file' is the second such scheme. grok's store is neither an array
 * nor one-file-per-workspace: it is a SINGLE SHARED TOML file
 * (`~/.grok/trusted_folders.toml`, honoring `GROK_HOME`) to which each trusted
 * folder is APPENDED as its own `[folders."<realpath>"]` table. Because the
 * file is shared, the writer appends rather than overwrites and no-ops when an
 * entry already exists — it must never clobber a sibling entry, and must never
 * flip a user's explicit `trusted = false` to true. The exact projection lives
 * in providers/grok-workspace-trust.ts (verified live against grok 1.0.4).
 *
 * ★History: grok trust was originally wired into the legacy ProviderCliAdapter
 * spawn path and was orphaned when that adapter was deleted in the spec
 * migration, silently regressing first-run launches in workspaces carrying
 * repo-local config (.mcp.json / .grok/lsp.json / hooks). Selecting the scheme
 * from the spec is what reattaches it to the live path.
 */
/**
 * 'codex_toml_file' is the third such scheme. Like grok it is a shared TOML
 * store keyed per folder, but the projection is NOT interchangeable: codex
 * writes `[projects."<realpath>"]` / `trust_level = "trusted"` (grok writes
 * `[folders."…"]` / `trusted = true` / `decided_at`), and it writes into
 * `$CODEX_HOME/config.toml` — codex's MAIN config file, which also carries
 * `[mcp_servers.*]`. The writer therefore appends one scoped table and never
 * rewrites the file, so a worker's automatic grant can never disturb the MCP
 * table that `delegatedWorkerIsolation` depends on. Exact projection lives in
 * providers/codex-workspace-trust.ts (verified live against codex 0.154.0).
 *
 * ★Why codex needs it at all, given the FSM already detects its trust modal: a
 * delegated worker's `CODEX_HOME` is per-session (the directory name carries a
 * session hash), so the store is empty on every launch and the prompt fires on
 * every launch. Without a pre-launch grant, every fresh codex worker parks in
 * `trust` with its dispatched task queued until a human approves.
 *
 * 'claude_json_projects' is the fourth such scheme, for claude-cli. The store
 * is neither an array, a per-workspace file, nor a shared TOML table: it is
 * `~/.claude.json`'s top-level `projects` key, a JSON OBJECT keyed by the
 * ABSOLUTE realpath, whose value carries a boolean `hasTrustDialogAccepted`
 * among many session-history fields Claude Code itself owns. The writer is
 * therefore sparse — it sets ONLY `hasTrustDialogAccepted: true` on the one
 * key for this workspace, creating the key if absent and leaving every other
 * field (on this entry and every sibling entry) untouched. Exact projection
 * lives in providers/claude-workspace-trust.ts (verified live against this
 * machine's own real `~/.claude.json`).
 *
 * ★Why claude-cli needs it despite the FSM detecting its trust modal: unlike
 * antigravity/kimi/grok/codex, claude-cli has NO worker-private HOME (absent
 * from `WORKER_PRIVATE_HOME_SPECS`), so a delegated worker runs with the REAL
 * HOME and this scheme always targets the owner's actual `~/.claude.json` —
 * there is no isolation axis to thread. Without a pre-launch grant, every
 * fresh worktree clone still hits "Is this a project you trust" and depends
 * on the FSM's reactive auto-approve.
 */
export interface PreLaunchTrustScheme {
    scheme: 'kimi_workspace_file' | 'grok_toml_file' | 'codex_toml_file' | 'claude_json_projects';
}

export type PreLaunchTrust = PreLaunchTrustSettingsArray | PreLaunchTrustScheme;

/**
 * Named interactive-prompt protocol (AskUserQuestion pickers / built-in
 * selectors — the waiting_choice path). These protocols are inherently
 * CLI-specific (transport, detection source, keystroke grammar), so — like
 * pre_launch_trust schemes and native_history source kinds — the engine
 * implements them by NAME and a spec merely selects one:
 *
 *   - 'claude_tui': claude's stream-json AskUserQuestion tool-call lines plus
 *     the TUI picker capture ("Enter to select" pages, Tab navigation).
 *   - 'kimi_wire': kimi's wire.jsonl tool-call authority
 *     (providers/kimi-pending-question.ts) plus the screen-detected built-in
 *     idle/cache-expired selector; answered with the measured digit/Tab/Enter
 *     (picker) or arrow-key (selector) protocol.
 *
 * Omitted → no interactive-prompt capture (approval modals are unaffected —
 * they are FSM states, not prompts). Legacy default: a spec with id
 * 'claude-cli' that omits this field still gets 'claude_tui' until the
 * published claude spec declares it explicitly.
 */
export interface InteractivePrompts {
    scheme: 'claude_tui' | 'kimi_wire';
}

/**
 * Declarative boot-prompt dismissal — see CliSpecV4.startup_dismiss. Shape
 * mirrors the legacy manifest's `tui.startupDismiss` (spec@4 spelling is
 * snake_case); both are normalized by cli-adapters/startup-dismiss.ts.
 */
export interface StartupDismiss {
    patterns: Array<{ regex: string; flags?: string }>;
    /** Key sequence written when a pattern matches (e.g. "\u001b" for Esc). */
    key: string;
    /** Max dismiss writes per session. Default 3. */
    max_attempts?: number;
    /** Only dismiss within this window after spawn (ms). Default 20000. */
    window_ms?: number;
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
     * Optional raw byte sequences written to the PTY once, shortly after the
     * child produces its first output, to prime a TUI that gates its input
     * handling on a terminal event the
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
    /** Delay (ms) after first PTY output before writing `send_on_spawn`. Default 250. */
    send_on_spawn_delay_ms?: number;
    /**
     * Maximum time (ms) to wait for first PTY output before writing
     * `send_on_spawn` immediately. Optional; defaults to 2000 so older provider
     * specs gain a bounded no-output fallback without being updated.
     */
    send_on_spawn_max_wait_ms?: number;
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
    /**
     * Boot-time prompt dismissal (OPENCODE-UPDATE-MODAL class): some CLIs open
     * a dialog that hijacks the composer before the first input — e.g.
     * opencode's "Update Available … Ask / Skip / Confirm" — dismissible with a
     * key (its own footer hints Esc) and suppressible only via config files the
     * daemon must not edit. When declared, the engine writes `key` whenever a
     * pattern matches the screen. Bounded by construction (spawn window +
     * attempt cap + per-snapshot dedupe in the shared decision engine,
     * cli-adapters/startup-dismiss.ts) so it can never key-spam. Not an
     * approval: a generic approval gate would press the affirmative and run
     * the update. Omitted by CLIs without such a prompt.
     */
    startup_dismiss?: StartupDismiss;
    /** Named interactive-prompt protocol (waiting_choice path) — see
     *  InteractivePrompts. Omitted → no prompt capture. */
    interactive_prompts?: InteractivePrompts;
    send_message: {
        submit_key: string;
        delay_ms_before_submit?: number;
        delay_ms_per_char?: number;
        /**
         * POSIX image-prompt delivery opt-in (claude-cli multi-image loss fix).
         * When true AND a send_message dispatch carries `bracketedPaste: true`
         * (set by the CLI provider instance only when the input envelope held
         * image parts), the body is wrapped in a bracketed-paste region
         * (ESC[200~ … ESC[201~) instead of a raw write, so the CLI's paste
         * handler deterministically attaches EVERY image path in the body.
         * Without the wrap the CLI's heuristic paste detector (~800-char single
         * burst) attaches none of them (short body) or only the last one (body
         * split across pipe chunks) — the rest degrade to plain-text paths.
         * Omitted/false → byte-for-byte legacy writes. See
         * test/providers/spec/driver-posix-image-paste.test.ts.
         */
        posix_bracketed_paste_for_images?: boolean;
        /**
         * NOTIF-IMMEDIACY opt-in: this CLI holds input typed DURING a turn in its
         * own queue and answers it as the next turn (claude-cli shows "Press up to
         * edit queued messages").
         *
         * When true, an autonomous mesh terminal notification may be delivered to a
         * BUSY coordinator through the SEND-NOW-AGENT-QUEUE split write instead of
         * waiting for an idle edge. Omitted/false → the body takes the adapter FIFO
         * (surfaced at the next turn boundary) or the ordinary idle-edge hold.
         *
         * ★ Default false, and deliberately per-spec rather than global. The live
         * A/B that established the split write works (2026-09-12: SPLIT consumed,
         * ATOMIC not) was measured against claude-cli v2.1.220 ONLY. A CLI without
         * a mid-turn input queue would swallow the write silently — and because the
         * pending row is marked drained BEFORE the write, a silent swallow is
         * permanent loss of a completion's finalSummary. So a spec opts in only
         * after its OWN measurement; nothing is extrapolated from claude-cli.
         *
         * This flag does not by itself authorise the write: the mesh caller also
         * enforces POSIX-only (the driver refuses win32 before reading state) and
         * the MID_GENERATION_MAX_BODY_CHARS size ceiling.
         */
        mid_generation_queue?: boolean;
    };
    sections: Record<string, SectionDef>;
    states: FsmState[];
    transitions: FsmTransition[];
    control_bar?: Control[];
    /**
     * Declarative screen-signal extraction — see providers/spec/signal-rules.ts.
     *
     * Each rule names a pattern to look for in the rendered frame and captures
     * named parameters out of it; a match is published to the coordinator as a
     * STRUCTURED event (rule id + kind + params), never as prose. This is how a
     * provider announcement the FSM has no state for — "you've hit your usage
     * limit until 15:45" — becomes something the coordinator can act on.
     *
     * Orthogonal to `notifications`/`delegate` (state-keyed, no captures) and to
     * `transitions` (which describe the machine's state; a signal deliberately
     * does NOT move the FSM). Adding a signal type is a spec-only edit.
     *
     * Omitted by every spec that needs none — the engine then does nothing.
     */
    signal_rules?: SignalRule[];
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
export function statusForState(state: FsmState): FsmStatus {
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
