/**
 * Public + driver-internal types of the FSM spec driver (fsm-driver.ts).
 *
 * Split out of fsm-driver.ts for the file-size gate: the ISpecDriver contract
 * is consumed by cli-adapter / picker-controls / the package barrel, none of
 * which need the driver implementation itself.
 */
import type { SessionTermination } from '@adhdev/session-host-core';
import type { SpecPtyEvent } from './adapter.js';
import type { PtyTransportFactory } from '../../cli-adapters/pty-transport.js';
import type { TraceEntry } from './evaluator.js';
import type { TransitionEval } from './fsm-evaluator.js';
import type { SignalSnapshot } from './signal-envelope.js';
import type { SignalDetection } from './signal-rules.js';
import type { FsmStatus } from './fsm-types.js';
import type { ResolvedTrustPlan } from '../trust-provenance-ledger.js';
import type { ClaimedQueuedSend } from './send-submit-engine.js';
import type { QueuedWriteOutcome, SendDisposition } from './submit-policy.js';

export type DashboardEvent =
    | { kind: 'pty_data'; chunk: string }
    | { kind: 'state_changed'; state: { id: string; label: string; title: string | null; status: FsmStatus };
        modal: { title: string | null; buttons: { index: number; label: string }[]; kind: 'approval' | 'picker' | 'confirm' | null } | null;
        controls: { id: string; label: string; action_type: string }[] }
    | { kind: 'notification'; id: string; title: string; body: string }
    | { kind: 'delegate'; id: string; task: string }
    /**
     * A spec-declared `signal_rules[]` entry matched the rendered frame.
     *
     * `params` is a STRUCTURED capture map, deliberately not a rendered
     * sentence: the values are provider-authored untrusted text that reaches a
     * coordinator LLM, so the consumer must place them in quoted fields of a
     * fixed template rather than splice them into prose. Already sanitized
     * (control chars stripped, length-capped) by the detector.
     */
    | { kind: 'signal_detected'; signal: SignalDetection }
    | { kind: 'spec_trace'; entries: TraceEntry[] }
    | {
        kind: 'exit';
        exit_code: number | null;
        signal?: number | null;
        termination?: SessionTermination;
    }
    | { kind: 'spec_error'; errors: string[] };

export type DashboardCommand =
    | { kind: 'send_message'; text: string; bracketedPaste?: boolean }
    | { kind: 'pty_write'; data: string }
    | { kind: 'click_control'; control_id: string; payload?: unknown }
    | { kind: 'click_modal_button'; index: number }
    | { kind: 'attach_image'; blob: string; mime: string }
    | { kind: 'resize'; cols: number; rows: number }
    | { kind: 'cancel' }
    | { kind: 'shutdown' };

export interface DriverHistoryEntry {
    stateId: string;
    label: string;
    at: number;
    durationMs: number;
    reason: string;
    matchedStateId?: string;
    matchedRules?: string[];
    debounceKind?: string;
    idleHoldMs?: number;
    busyHoldMs?: number;
    via?: string;
}

/**
 * A frozen snapshot of the FULL FSM evaluation captured at the instant a
 * transition fired — the rich `transitions[]` table (per-transition eligible /
 * hold countdown / per-condition CondResult + remainingMs) that `getFsmDebug()`
 * otherwise only computes live for the current instant. Kept in a separate ring
 * buffer from `stateHistory` (which stays intentionally lightweight) so the
 * "why did this rule fire just before the transition" question is answerable
 * after the fact. before-only: this is the evaluation that PRODUCED the
 * transition, not the post-transition state.
 */
export interface FsmSnapshotEntry {
    /** State we transitioned out of. */
    stateFrom: string;
    /** State we transitioned into (the fired transition's destination). */
    stateTo: string;
    /** Wall-clock time the transition committed (ms). */
    at: number;
    /** The fired transition's destination state id (== stateTo; kept explicit
     *  to mirror the rule that fired). */
    firedTo: string;
    /** Human label of the fired transition (e.g. "approval→busy"). */
    firedLabel: string;
    /** Why-it-fired summary, same shape produced for stateHistory.matchedRules. */
    reason: string[];
    /** Every outgoing transition from `stateFrom` as evaluated at `at`, each
     *  with its eligible / hold / per-condition CondResult + remainingMs. This
     *  is the full pre-transition evaluation table — the whole point of the
     *  snapshot. */
    transitions: TransitionEval[];
}

export interface ISpecDriver {
    subscribe(listener: (ev: DashboardEvent) => void): () => void;
    start(): void;
    dispatch(cmd: DashboardCommand): void;
    /** Release the runtime without ending it (daemon shutdown/restart). */
    detach(): void;
    /**
     * BUTTON-INDEX-MISMAP (Fix C.3): click a modal button by its FSM display index and report
     * whether a button was actually matched and its confirm keys dispatched. Unlike the
     * fire-and-forget `dispatch('click_modal_button')`, callers that need to know the click
     * landed (mesh_approve → SpecCliAdapter.resolveModalMatched) can observe a miss.
     */
    clickModalButton(index: number): boolean;
    /**
     * QUEUED-SEND-LOSS: send a message and report whether it reached the PTY or
     * was only queued. Same behaviour as `dispatch({kind:'send_message'})`, which
     * remains the fire-and-forget form; callers that must not report "sent" for
     * a body still sitting in memory use this instead. Optional so test doubles
     * implementing ISpecDriver need not provide it.
     */
    sendMessageWithDisposition?(text: string, bracketedPaste?: boolean, messageId?: string): SendDisposition;
    /**
     * Wiring-unification D2 — the FIFO is keyed by `OutboundMessage.messageId`
     * (see SendSubmitEngine.QueuedSendEntry). `claimQueuedSend` takes the body
     * parked under that id out of the FIFO and returns it, so exactly ONE route
     * (send-now / interrupt / cancel) can still write it — the SEND-NOW-DOUBLE-
     * SEND guard, measured live 2026-09-07 (an interrupt timed out, reported
     * "not delivered", and the idle drain wrote the same body 995 ms later).
     * `restoreQueuedSend` puts a claimed entry back in place after a refused
     * write. All optional so test doubles implementing ISpecDriver need not
     * provide them.
     */
    hasQueuedSend?(messageId: string): boolean;
    queuedMessageIds?(): string[];
    claimQueuedSend?(messageId: string): ClaimedQueuedSend | null;
    restoreQueuedSend?(claimed: ClaimedQueuedSend): void;
    /**
     * SEND-NOW-WRONG-ITEM: suspend the autonomous pendingSends drain for up to
     * `ttlMs`, so an out-of-band caller owns the next write to the PTY.
     *
     * Exists because claiming the pressed body (claimQueuedSend) is not enough
     * when the FIFO holds OTHER entries. The interrupt path reaches idle by
     * design, and `drainPendingSends()` runs on the same FSM frame that observes
     * idle — strictly before the caller's own poll sees it. So the leftover
     * entry is written first and takes the in-flight latch, and the pressed body
     * is re-parked behind it.
     *
     * Measured live (2026-09-11, owner report, rc.10): two bodies queued, "Send
     * now" pressed on the second, and the first was delivered. The driver log
     * reads `draining queued send` immediately followed by
     * `send queued — previous send still in flight`.
     *
     * The TTL is mandatory and self-healing: a caller that dies between reserve
     * and release must not wedge the owner's queue forever. Optional so test
     * doubles implementing ISpecDriver need not provide it.
     */
    reserveDrain?(ttlMs: number): void;
    /** SEND-NOW-WRONG-ITEM: end a reserveDrain() early and drain immediately if
     *  the machine is idle. Safe to call when no reservation is held. */
    releaseDrain?(): void;
    /**
     * SEND-NOW-AGENT-QUEUE: write a body into a GENERATING composer as a SPLIT
     * write (text, gap, submit key) so the CLI's own input queue takes it,
     * WITHOUT interrupting the turn in flight. POSIX only.
     *
     * ★ The full derivation — the live A/B that separates this from the retired
     * atomic force-inject, why win32 is refused, and why the gate opened here is
     * exactly one — lives with the types in ./submit-policy.ts
     * (QueuedWriteOutcome). Read it before widening anything here.
     *
     * Optional so test doubles implementing ISpecDriver need not provide it.
     */
    sendMessageDuringGeneration?(text: string, bracketedPaste?: boolean): QueuedWriteOutcome;
    /**
     * NOTIF-IMMEDIACY: does the loaded spec declare
     * `send_message.mid_generation_queue`?
     *
     * A narrow read-only projection of the spec rather than an accessor for the
     * whole `CliSpecV4`: the spec is driver-private on purpose, and exposing it
     * wholesale would let callers form their own opinions about send readiness —
     * the class of second-opinion bug the SEND-OVERLAP work removed. Optional so
     * test doubles and out-of-tree drivers need not provide it (absent → treated
     * as not opted in).
     */
    supportsMidGenerationQueue?(): boolean;
    updateMeta(meta: Record<string, unknown>, replace?: boolean): void;
    snapshot(): string;
    getCursorPosition(): { row: number; col: number };
    getScreen(): string;
    /** Current terminal geometry (columns × rows). Optional so a non-Fsm
     *  ISpecDriver implementation (test doubles) need not provide it; the
     *  mesh_read_terminal path falls back to a 0×0 geometry when absent. */
    getScreenSize?(): { cols: number; rows: number };
    getSpecPath(): string;
    shutdown(): void;
    getStateHistory(): ReadonlyArray<DriverHistoryEntry>;
    /** Sections resolved from `screenText`, or from a fresh snapshot when
     *  omitted. Callers that already hold a screen MUST pass it, so the
     *  sections and the screen describe the same frame. */
    getSections(screenText?: string): Array<{ id: string; text: string }> | null;
    getLastBusyAt(): number;
    hasIdleHoldPending(): boolean;
    hasSeenReady(): boolean;
    /**
     * Wiring-unification A5-3 — the adapter clocks. Wall-clock (ms) of the most
     * recent raw PTY chunk (`lastOutputAt`) and of the most recent rendered
     * screen change (`lastScreenChangeAt`); 0 until first observed. Surfaced by
     * SpecCliAdapter.getStatus() so the mesh stall watchdog, the completion
     * engine and the status-transition progress fingerprint read live clocks
     * rather than the dead `undefined` they got before. Optional so test
     * doubles implementing ISpecDriver need not provide them (absent → the
     * status omits the clocks, exactly the pre-fix shape).
     */
    getLastOutputAt?(): number;
    getLastScreenChangeAt?(): number;
    /** REDRAW-NUDGE: lifetime count of false-busy resize wiggles (redraw-nudge.ts). */
    getRedrawNudgeCount?(): number;
    getCompletionIdleDebounceState(): { active: boolean; ageMs: number; holdMs: number; forceAfterMs: number } | null;
    getFsmDebug?(): unknown;
    getFsmSnapshotHistory?(): ReadonlyArray<FsmSnapshotEntry>;
    getEventTimeline?(limit?: number): ReadonlyArray<SpecPtyEvent>;
    /**
     * TX-FSM Stage 0 (shadow): inject the daemon-normalized signal observation.
     * Observation ONLY — the driver receives the envelope, never a reader; all
     * file discovery / session pinning / parsing stays daemon-side so the FSM
     * engine remains a generic PTY engine. The snapshot feeds the shadow
     * verdict of `signal` conditions exclusively; it cannot gate a transition.
     */
    setSignalObservation?(snapshot: SignalSnapshot | null): void;
    /**
     * ENTER-LOSS shutdown drain gate (2026-09-10 incident, layer ①). True while a
     * message body has been written to the PTY but its submit key has not yet been
     * confirmed (echo-gate waiting, resend loop running, chunked body still being
     * written, or a queued-send drain about to write). Optional so test doubles need
     * not provide it; callers typeof-guard and treat absence as "nothing in flight".
     */
    hasInFlightSubmit?(): boolean;
    /**
     * ENTER-LOSS layer ①: resolve once no submit is in flight, or after `timeoutMs`
     * — whichever comes first. Resolves `true` when drained, `false` on timeout
     * (the caller must log and proceed; never wait unboundedly).
     */
    whenSubmitDrained?(timeoutMs: number): Promise<boolean>;
    /**
     * ENTER-LOSS layer ③ (composer-residue sweep): scrollback-inclusive screen
     * text, so a tall residue body whose head scrolled off-viewport can still be
     * integrity-checked against the ledger original. Optional — test doubles and
     * non-FSM drivers may omit it; callers fall back to snapshot().
     */
    snapshotWithScrollback?(): string;
    /**
     * APPROVE-LATCH-STALE (live defect, 2026-09-23): re-run one FSM evaluation
     * against the CURRENT screen and re-emit unconditionally, so the adapter's
     * latched state/modal is refreshed on demand.
     *
     * Why this has to be callable from outside the PTY pump: a modal state whose
     * only exits are pure CONTENT guards declares no elapsed_ms/stable_ms, so
     * scheduleWakeForState() arms no timer; the stall watchdog is `generating`-only;
     * and a focus-event TUI (antigravity's `agy`) repaints only on a keypress. The
     * latch therefore freezes at whatever the ENTRY frame parsed — and a
     * priority-90 `busy→approval-timeout` / `signing_in→approval-timeout` entry
     * has no modal anchor at all, so that entry frame can latch `modal = null`
     * while the state is authoritatively `approval`. mesh_approve then sees
     * waiting_approval with no buttons and hard-refuses a session that is in
     * fact sitting at a fully drawn picker.
     *
     * This refreshes the MODAL, never the status derivation: status stays
     * `statusForState(state)` exactly as adapter-status-projection.ts:81-84
     * requires ("do not infer status from whether a modal parsed this frame").
     *
     * Optional so test doubles and out-of-tree drivers need not provide it;
     * callers treat its absence as "no refresh available" and fall through to
     * the latched value.
     */
    refreshNow?(): void;
}

export interface SpecDriverOpts {
    specPath: string;
    workingDir: string;
    extraEnv?: Record<string, string>;
    /** Absolute launch-planning result. Null/absent array stores are never resolved here. */
    resolvedTrustPlan?: ResolvedTrustPlan | null;
    cols?: number;
    rows?: number;
    hotReload?: boolean;
    emitTrace?: boolean;
    transportFactory?: PtyTransportFactory;
    extraCliArgs?: string[];
    /**
     * FSMLOG-SESSION-ATTRIBUTION (D3): the owning provider instance's session id, used only to
     * prefix this driver's log lines. Without it every concurrent session logs under the same
     * `[cli/claude-code/4.0.json]` tag, so multi-session logs cannot be attributed to a session
     * — the direct cause of a misdiagnosis where one session's FSM transitions were read as
     * another's. Optional: callers that have no session id (tests, out-of-tree embedders) fall
     * back to a per-instance short uid, which still groups one driver's lines together.
     */
    sessionId?: string;
    /**
     * MANIFEST-SEND-DELAY: the provider manifest's `sendDelayMs`, threaded in from
     * route.ts so the spec path actually honours it. Before this it was DEAD on the
     * spec path — its only reader belonged to the ProviderCliAdapter engine deleted
     * in 48e5ed1a — which made manifests actively misleading: grok-cli declares
     * `sendDelayMs: 1200` while its spec says 200, so it ran at 200 and an
     * investigation into a grok submit failure was nearly waved off on the strength
     * of the declared-but-unused 1200.
     *
     * It is a FLOOR, not an override: resolveSubmitDelayMs takes the max of this,
     * the spec's `delay_ms_before_submit`, and the size-derived bonus. A manifest
     * therefore can only ask for MORE settling time than the spec/heuristic already
     * computed, never less — so wiring it cannot shorten any existing wait and
     * cannot weaken the echo-gate that d7332b84 put in front of the submit key.
     */
    manifestSendDelayMs?: number;
    /**
     * PERMISSION-MODE-DUPLICATE: the selected auto-approve mode's `removeArgs` — base-arg
     * flags that this launch's `extraCliArgs` replace. `applyAutoApproveModeLaunchArgs`
     * filters them out of the provider MANIFEST's `spawn.args`, but this path spawns from
     * the SPEC's `spawn_args`, so without threading the list here the two collide: grok-cli
     * in `auto` mode spawned `--permission-mode acceptEdits --permission-mode auto`, which
     * its clap-based CLI rejects.
     *
     * The LIST is threaded rather than a pre-filtered array because the manifest and the
     * spec legitimately declare different values for the same flag (claude-cli: manifest
     * `acceptEdits`, specs/4.0.json `default`).
     */
    removeSpawnArgs?: string[];
    /**
     * ★SPAWN-LOG-VERSION: the provider MANIFEST's version, threaded in from
     * route.ts purely for the spawn diagnostic line.
     *
     * `CliSpecV4` (specs/4.0.json) is the FSM runtime spec and carries no
     * version of its own, so buildAdapterOpts() had nothing to pass and every
     * spec-path spawn logged `Spawning (spec vunknown)`. That line is the one
     * record of which bundle a session is running — and it mattered on
     * 2026-09-17, when a daemon was serving a provider version several hours
     * behind the activated pointer and the log could not say so.
     *
     * The manifest version was never unavailable, only unthreaded: route.ts
     * holds the resolved `CliProviderModule` at construction time. Optional,
     * so tests and out-of-tree embedders that build a driver without a
     * manifest keep logging `vunknown` rather than breaking.
     */
    manifestProviderVersion?: string;
}

// ── Driver-internal evaluation snapshot shapes (shared with the modal /
//    frame helper modules; not part of the package surface). ──────────────

export interface ModalSnapshot {
    title: string | null;
    buttons: { index: number; label: string; key: string; current: boolean }[];
}

export interface VisibleControl {
    id: string;
    label: string;
    actionType: 'send_keys' | 'open_picker' | 'attach_image';
}

/** Per-state evaluation snapshot (mirrors v3 SpecEvaluation shape for the
 *  parts the cli-adapter / panel consume). */
export interface CurrentEval {
    state: { id: string; label: string; title: string | null; status: FsmStatus };
    modal: ModalSnapshot | null;
    controls: VisibleControl[];
}
