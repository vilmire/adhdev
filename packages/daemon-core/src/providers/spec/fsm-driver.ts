/**
 * FsmDriver — runs an adhdev:cli/spec@4 finite state machine against a PTY.
 *
 * Drop-in compatible with SpecDriver's public surface (subscribe / dispatch /
 * start / snapshot / getStateHistory / getDebugState / …) so the cli-adapter
 * can use either driver behind one interface. The difference is entirely
 * internal: instead of a stack of hard-coded debounce layers, this driver
 * holds ONE piece of state — the current FSM node — and on every screen change
 * asks the FSM evaluator "which outgoing transition fires?". All timing
 * (startup grace, busy hold, completion stability) is expressed in the spec as
 * transition guards (min_hold_ms) and time conditions (elapsed_ms / stable_ms).
 *
 * Because the engine carries no CLI knowledge, the only way it can be "wrong"
 * is if a spec's transitions are wrong — and that is fully inspectable via
 * getFsmDebug(), which reports every outgoing transition with its per-condition
 * match result and countdown. That is the contract: debug the spec, not the
 * engine.
 */
'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TerminalAdapter, type TerminalAdapterOpts, type SpecPtyEvent } from './adapter.js';
import { resolveCliSpawnPlanFromParts, stripRemovedSpawnArgs } from '../../cli-adapters/provider-cli-runtime.js';
import type { PtyRuntimeExitInfo, PtyTransportFactory } from '../../cli-adapters/pty-transport.js';
import { DEFAULT_SESSION_HOST_COLS, DEFAULT_SESSION_HOST_ROWS } from '@adhdev/session-host-core';
import type { SessionTermination } from '@adhdev/session-host-core';
import {
    resolveSections, sectionText, extractTitle, extractButtonsFromRule,
    type ResolvedSection, type TraceEntry,
} from './evaluator.js';
import { evaluateFsm, stableRegionKey, type FsmClock, type TransitionEval, type FsmEvaluation } from './fsm-evaluator.js';
import type { SignalSnapshot } from './signal-envelope.js';
import {
    type CliSpecV4, type FsmState, type FsmTransition,
    initialState, stateById, statusForState, modalKindForState, outgoingTransitions,
} from './fsm-types.js';
import { loadFsmSpec, reportFsmSpecWarnings } from './fsm-loader.js';
import { SendSubmitEngine } from './send-submit-engine.js';
import { applyPreLaunchTrust } from './pre-launch-trust.js';
import { applyKimiWorkspaceTrust } from '../kimi-workspace-trust.js';
import type { ResolvedTrustPlan } from '../trust-provenance-ledger.js';
import {
    createStartupDismissState, decideStartupDismiss, normalizeStartupDismissConfig, recordStartupDismiss,
    type StartupDismissConfig, type StartupDismissState,
} from '../../cli-adapters/startup-dismiss.js';
import type { Control, DelegateTrigger } from './types.js';
import { LOG } from '../../logging/logger.js';
import { recordDebugTrace } from '../../logging/debug-trace.js';
import { shouldCollectTraceCategory } from '../../logging/debug-config.js';
import {
    WIN32_PTY_WRITE_CHUNK_CHARS,
    WIN32_PTY_WRITE_CHUNK_GAP_MS,
} from '../../cli-adapters/pty-write-chunking.js';

// ── Shared driver types (formerly in driver.ts) ───────────────────────────

export type DashboardEvent =
    | { kind: 'pty_data'; chunk: string }
    | { kind: 'state_changed'; state: { id: string; label: string; title: string | null; status: 'idle' | 'generating' | 'approval' };
        modal: { title: string | null; buttons: { index: number; label: string }[]; kind: 'approval' | 'picker' | 'confirm' | null } | null;
        controls: { id: string; label: string; action_type: string }[] }
    | { kind: 'notification'; id: string; title: string; body: string }
    | { kind: 'delegate'; id: string; task: string }
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
    sendMessageWithDisposition?(text: string, bracketedPaste?: boolean): SendDisposition;
    /**
     * SEND-NOW-DOUBLE-SEND: remove every queued copy of `text` from the
     * pendingSends FIFO and report how many were taken out, so exactly ONE
     * path can still write that body.
     *
     * Exists because the interrupt path (commands/interrupt-and-deliver.ts) is a
     * second delivery route for a body the driver may ALREADY hold queued: the
     * dashboard's "Send now" is pressed on a bubble that got there by being
     * queued in the first place. Measured live (2026-09-07): interruptAndDeliver
     * timed out waiting for busy→idle and reported "not delivered, still
     * queued", and 995ms later drainPendingSends wrote that very body — the
     * caller was told to retry a message that had in fact been sent.
     *
     * Claiming the body up front makes the two routes one: whatever
     * interruptAndDeliver reports is the whole truth about that text. Optional
     * so test doubles implementing ISpecDriver need not provide it.
     */
    claimQueuedSends?(text: string): number;
    /**
     * SEND-NOW-WRONG-ITEM: suspend the autonomous pendingSends drain for up to
     * `ttlMs`, so an out-of-band caller owns the next write to the PTY.
     *
     * Exists because claiming the pressed body (claimQueuedSends) is not enough
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
}

/** No-output escape hatch for spawn priming. Live agy startup output arrived at
 *  +335ms / +612ms; 2s is >3x the slower observation while still bounding a
 *  focus-gated startup cycle to a short, human-visible pause. */
const DEFAULT_SPAWN_PRIME_MAX_WAIT_MS = 2_000;
/** Three detailed watchdog attempts show the first injection plus two repeat
 *  intervals, enough to diagnose cadence without an unbounded per-session log. */
const STALL_REFOCUS_INFO_LIMIT = 3;

// ── send_message serialization (SEND-OVERLAP) ────────────────────────────────
//
// The queue/latch/duplicate-gate machinery this driver used to own now lives in
// ./send-submit-engine.ts, together with the live-defect narrative that explains
// why it exists. This file keeps only `currentStatus()`, which that engine gates
// on but must never compute for itself.

/** FSMLOG-SESSION-ATTRIBUTION (D3): fallback log-tag sequence for drivers constructed without a
 *  session id. Process-local and monotonic — enough to group one driver's lines together. */
let fsmDriverSeq = 0;

// Submit policy (thresholds, delay resolution, win32 paste/newline encoding,
// echo normalization, drain ceiling) was pure-moved to ./submit-policy.ts
// (file-size gate). Re-exported below so existing imports from this module
// keep working. Its stateful consumers (scheduleVerifiedSubmit, writeWin32Body,
// the drain gate) then moved on to ./send-submit-engine.ts, so what this file
// still imports for its OWN use is just the win32 modal-confirm resend cadence
// (an approval CR, not a send_message submit — see scheduleWin32ModalConfirm)
// and guessExt for attach_image.
import {
    guessExt,
    WIN32_SUBMIT_RESEND_GAP_MS,
    WIN32_SUBMIT_MAX_RESENDS,
} from './submit-policy.js';
import type { QueuedWriteOutcome, SendDisposition } from './submit-policy.js';
export {
    MID_GENERATION_SUBMIT_MIN_GAP_MS,
} from './submit-policy.js';
export type { QueuedWriteOutcome, QueuedWriteRefusal, SendDisposition } from './submit-policy.js';
export {
    SUBMIT_DRAIN_SHUTDOWN_MAX_WAIT_MS,
    VERIFIED_SUBMIT_MIN_CHARS,
    chunkPreservingSurrogates,
    guessExt,
    normalizeForEcho,
    resolveEchoConfirmPolicy,
    resolveSubmitDelayMs,
    resolveWin32SubmitMode,
    shouldUseVerifiedSubmit,
} from './submit-policy.js';
export type { Win32SubmitMode } from './submit-policy.js';

// ─────────────────────────────────────────────────────────────────────────────

interface ModalSnapshot {
    title: string | null;
    buttons: { index: number; label: string; key: string; current: boolean }[];
}

interface VisibleControl {
    id: string;
    label: string;
    actionType: 'send_keys' | 'open_picker' | 'attach_image';
}

type HistoryEntry = DriverHistoryEntry;

/** Per-state evaluation snapshot (mirrors v3 SpecEvaluation shape for the
 *  parts the cli-adapter / panel consume). */
interface CurrentEval {
    state: { id: string; label: string; title: string | null; status: 'idle' | 'generating' | 'approval' };
    modal: ModalSnapshot | null;
    controls: VisibleControl[];
}

export class FsmDriver implements ISpecDriver {
    private spec!: CliSpecV4;
    private adapter: TerminalAdapter;
    private listeners = new Set<(ev: DashboardEvent) => void>();

    // ── The entire FSM state: which node we're in, and when we entered it.
    private currentStateId = '';
    private stateEnteredAt = 0;

    // ── Clock bookkeeping for time conditions.
    private startedAtMs = 0;
    private prevScreenLines: string[] = [];
    /** Per stable region → last time that region's content changed. Drives
     *  stable_ms conditions. Key = stableRegionKey(cond): numeric cursor_above
     *  (−1 = whole screen), or a `section:<id>` / `<region>#ignore:<pat>` string
     *  when the clause scopes to a section or declares an ignore_lines filter. */
    private regionLastChangedAt = new Map<number | string, number>();
    /** COMPLETION-EARLYNOTIFY stable-eval trace: last stable/not-stable verdict
     *  recorded per stable region, so the trace fires only when the verdict FLIPS
     *  (not every quiet frame). Cleared on every transition alongside
     *  regionLastChangedAt. Diagnostic-only — never consulted by the FSM. */
    private stableVerdictCache = new Map<number | string, boolean>();
    /** Timer that re-runs evaluate() when a time-condition would flip true
     *  with no PTY frame to trigger it. */
    private wakeTimer: ReturnType<typeof setTimeout> | null = null;
    /** Boot-prompt dismissal (CliSpecV4.startup_dismiss — OPENCODE-UPDATE-MODAL
     *  class). Config normalized once at start(); the shared decision engine
     *  bounds writes by spawn window + attempt cap + per-snapshot dedupe. */
    private startupDismissConfig: StartupDismissConfig | null = null;
    private startupDismissState: StartupDismissState = createStartupDismissState();
    /** Wall clock at start() — the spawn anchor for the dismiss window. */
    private startupDismissSpawnAt = 0;
    /** Timer driving the focus-gated stall watchdog (refocus_when_stalled_ms).
     *  Re-arms itself while the machine is generating so a re-prime can fire
     *  even when the PTY has gone completely quiet. */
    private stallTimer: ReturnType<typeof setTimeout> | null = null;
    /** Spawn-prime delay timer. First PTY output is useful readiness evidence,
     *  not proof that stdin is ready; a separate max-wait timer preserves the
     *  old spawn-relative fallback when no output ever arrives. */
    private spawnPrimeTimer: ReturnType<typeof setTimeout> | null = null;
    private spawnPrimeMaxWaitTimer: ReturnType<typeof setTimeout> | null = null;
    private spawnPrimeAwaitingOutput = false;
    /** Shared latch for the first-output and max-wait paths. Both timers call
     *  fireSpawnPrimeOnce(), which consumes it before writing. */
    private spawnPrimePending = false;
    /** Wall-clock time the last stall re-prime was injected. The cooldown gate:
     *  after a re-prime we don't re-inject until the screen changes (which
     *  resets the stall reference) or another full stall window lapses. */
    private lastRefocusAt = 0;
    private stallRefocusInfoCount = 0;
    private stallRefocusSuppressedCount = 0;
    /** Wall-clock (ms) of the most recent raw PTY output chunk. Advances on every
     *  on_pty_data — including the echo of text written into the composer — so the
     *  win32 submit settle-gate can tell when input has finished landing. */
    private lastPtyDataAt = 0;
    /** Timer driving the win32 verification-based modal-confirm CR resend loop (see
     *  scheduleWin32ModalConfirm). A lone CR that confirms an approval/picker choice
     *  is absorbed by ConPTY the same way a send_message submit CR is, so the confirm
     *  must be resent until the modal actually resolves (status leaves 'approval'). */
    private win32ModalConfirmTimer: ReturnType<typeof setTimeout> | null = null;

    private currentEval: CurrentEval | null = null;
    private stateHistory: HistoryEntry[] = [];
    private prevStateAt = 0;

    // ── send_message queueing until the machine first reaches a non-initial,
    //    non-busy ("ready") state — same contract as v3's idleSeenOnce.
    private readySeenOnce = false;

    private pickerInProgress: { control_id: string; spec: Control } | null = null;
    private delegateTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private specWatcher: fs.FSWatcher | null = null;
    /** Last full FSM evaluation, kept for the debugger. */
    private lastFsmEval: ReturnType<typeof evaluateFsm> | null = null;
    /** Ring buffer (max 20) of the full FSM evaluation captured at each
     *  transition — the rich pre-transition table that lastFsmEval only keeps
     *  for the single most recent evaluation. Separate from stateHistory. */
    private fsmSnapshotHistory: FsmSnapshotEntry[] = [];
    /** TX-FSM Stage 0 (shadow): the latest daemon-injected signal observation.
     *  Read by evalFsmNow for the shadow verdict of `signal` conditions ONLY —
     *  the Stage-0 pass-through in the evaluator means it can never alter
     *  which transition fires. */
    private signalObservation: SignalSnapshot | null = null;
    /** Per-transition last-logged shadow divergence (`${from}→${to}` → whether
     *  the shadow verdict currently disagrees with the real one), so the
     *  shadow log emits on FLIP only, not every frame. */
    private shadowDivergenceLast = new Map<string, boolean>();
    /** FSMLOG-SESSION-ATTRIBUTION (D3): session segment of every log line's prefix. */
    private readonly sessionTag: string;
    /**
     * The send/queue/submit machinery — see ./send-submit-engine.ts.
     *
     * Extracted for the file-size gate, along the one seam in this class that is
     * genuinely self-contained: it owns the pendingSends FIFO, the in-flight
     * latch, the duplicate-gate hashes, the drain reservation and every
     * write/submit timer, and reads this driver only through the narrow
     * `DriverHost` view implemented just below.
     *
     * ★ The driver deliberately keeps `currentStatus()`. The engine GATES on it
     * but must never compute its own answer — two opinions about whether the
     * terminal is idle is precisely the SEND-OVERLAP defect.
     */
    private readonly sends: SendSubmitEngine;

    constructor(private readonly opts: SpecDriverOpts) {
        // Object-literal getters below need a lexical handle on the driver; inside
        // a `get x()` the `this` is the literal, not the class.
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const self = this;
        const sessionId = typeof opts.sessionId === 'string' ? opts.sessionId.trim() : '';
        this.sessionTag = sessionId ? sessionId.slice(0, 8) : `d${++fsmDriverSeq}`;
        this.loadSpecOrThrow();
        this.adapter = new TerminalAdapter(
            this.buildAdapterOpts(),
            {
                init: () => this.emitInitialState(),
                on_pty_data: (chunk) => {
                    this.lastPtyDataAt = Date.now();
                    this.scheduleSpawnPrimeAfterFirstOutput();
                    this.emit({ kind: 'pty_data', chunk });
                },
                on_screen_changed: () => this.reevaluate(),
                on_exit: (info) => this.handleExit(info),
            },
        );
        // ★ Constructed here, after loadSpecOrThrow() and the adapter, because the
        // host view below reads both. The accessors are LIVE getters rather than
        // captured values: `spec` is replaced wholesale on a hot spec reload,
        // `readySeenOnce` latches later, and `lastPtyDataAt` advances on every PTY
        // chunk — a frozen literal would pin the engine to construction-time values
        // and the win32 settle-gate would never observe the screen going quiet.
        this.sends = new SendSubmitEngine({
            adapter: this.adapter,
            get spec() { return self.spec; },
            get opts() { return self.opts; },
            get readySeenOnce() { return self.readySeenOnce; },
            get lastPtyDataAt() { return self.lastPtyDataAt; },
            get currentStateId() { return self.currentStateId; },
            specTag: () => this.specTag(),
            // ★ The engine gates on this but never computes it — see the note on
            // the `sends` field.
            currentStatus: () => this.currentStatus(),
        });
        if (this.opts.hotReload !== false) this.armSpecWatcher();
    }

    subscribe(listener: (ev: DashboardEvent) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    start(): void {
        const now = Date.now();
        this.startedAtMs = now;
        const init = initialState(this.spec);
        this.currentStateId = init.id;
        this.stateEnteredAt = now;
        this.prevStateAt = now;
        // Pre-trust the workspace before spawning so a first-run folder-trust
        // prompt never appears (best-effort; failures fall back to the FSM's
        // trust-modal detection). Only runs for specs that declare it.
        if (this.spec.pre_launch_trust) {
            if (this.opts.resolvedTrustPlan) {
                applyPreLaunchTrust(this.spec.pre_launch_trust, this.opts.resolvedTrustPlan);
            } else if ('scheme' in this.spec.pre_launch_trust
                && this.spec.pre_launch_trust.scheme === 'kimi_workspace_file') {
                // Kimi has no worker-private HOME yet. Keep its current
                // KIMI_CODE_HOME/os.homedir() behavior until that isolation work lands.
                applyKimiWorkspaceTrust(this.opts.workingDir);
            } else {
                // Fail closed for array stores: resolving `~` here would use the
                // daemon's real HOME and recreate the worker trust leak.
                LOG.warn('pre-launch-trust', 'skipping array trust without a resolved launch plan');
            }
        }
        this.startupDismissConfig = normalizeStartupDismissConfig(this.spec.startup_dismiss);
        this.startupDismissState = createStartupDismissState();
        this.startupDismissSpawnAt = now;
        // Arm before adapter.start(): a transport may synchronously flush
        // buffered child output while registering onData during start().
        this.armSpawnPrime();
        this.adapter.start();
        // The initial state may have a purely time-based exit (elapsed_ms);
        // schedule a wake so we leave it even if the PTY goes quiet.
        this.scheduleWakeForState();
    }

    private armSpawnPrime(): void {
        const seqs = this.spec.send_on_spawn;
        if (!Array.isArray(seqs) || seqs.length === 0) return;
        this.spawnPrimeAwaitingOutput = true;
        this.spawnPrimePending = true;
        const configuredMaxWait = this.spec.send_on_spawn_max_wait_ms;
        const maxWait = typeof configuredMaxWait === 'number' && Number.isFinite(configuredMaxWait)
            ? Math.max(0, configuredMaxWait)
            : DEFAULT_SPAWN_PRIME_MAX_WAIT_MS;
        this.spawnPrimeMaxWaitTimer = setTimeout(() => {
            this.spawnPrimeMaxWaitTimer = null;
            this.fireSpawnPrimeOnce('max-wait');
        }, maxWait);
    }

    /** Start the configured prime delay only after the child produces output.
     *  On macOS, writing at a fixed spawn-relative deadline can land while the
     *  slave is still in canonical echo mode: focus-in is echoed as `^[[I` and
     *  lost before the TUI installs its input handler. First output is the
     *  earliest transport-level readiness evidence available to the engine. */
    private scheduleSpawnPrimeAfterFirstOutput(): void {
        if (!this.spawnPrimeAwaitingOutput) return;
        this.spawnPrimeAwaitingOutput = false;
        if (this.spawnPrimeMaxWaitTimer) {
            clearTimeout(this.spawnPrimeMaxWaitTimer);
            this.spawnPrimeMaxWaitTimer = null;
        }
        const delay = Math.max(0, this.spec.send_on_spawn_delay_ms ?? 250);
        this.spawnPrimeTimer = setTimeout(() => {
            this.spawnPrimeTimer = null;
            this.fireSpawnPrimeOnce('first-output');
        }, delay);
    }

    /** Consume the one-shot spawn-prime latch and cancel the competing timer
     *  before writing. JavaScript callbacks are serialized, so whichever path
     *  gets here first makes every later/queued callback a no-op. */
    private fireSpawnPrimeOnce(trigger: 'first-output' | 'max-wait'): void {
        if (!this.spawnPrimePending) return;
        this.spawnPrimePending = false;
        this.spawnPrimeAwaitingOutput = false;
        if (this.spawnPrimeTimer) { clearTimeout(this.spawnPrimeTimer); this.spawnPrimeTimer = null; }
        if (this.spawnPrimeMaxWaitTimer) { clearTimeout(this.spawnPrimeMaxWaitTimer); this.spawnPrimeMaxWaitTimer = null; }
        this.sendSpawnPrime('spawn-prime', trigger);
    }

    /** Write the declared `send_on_spawn` sequences to the PTY once. Used both
     *  on the first-output spawn path and, for focus-gated TUIs, by the stall
     *  watchdog to re-inject the focus-in wake mid-turn. No-op when the spec
     *  declares no prime, so non-focus-gated CLIs are never poked. */
    private sendSpawnPrime(
        source: 'spawn-prime' | 'stall-refocus',
        trigger?: 'first-output' | 'max-wait',
    ): void {
        const seqs = this.spec.send_on_spawn;
        if (!Array.isArray(seqs) || seqs.length === 0) return;
        const validSeqs = seqs.filter((seq): seq is string => typeof seq === 'string' && seq.length > 0);
        if (validSeqs.length === 0) return;
        if (source === 'spawn-prime') {
            LOG.info('FsmDriver', `[${this.specTag()}] spawn prime firing trigger=${trigger ?? 'unknown'} sequences=${validSeqs.length}`);
        }
        for (const seq of validSeqs) {
            void this.adapter.send_keys(seq, { source, specTag: this.specTag() });
        }
    }

    /** Boot-prompt dismissal (CliSpecV4.startup_dismiss). Runs on every
     *  reevaluation; the shared decision engine makes it a cheap no-op outside
     *  the spawn window and bounds writes (attempt cap + per-snapshot dedupe),
     *  so a prompt that survives the key can never become a key-spam loop. */
    private maybeDismissStartupPrompt(screen: string, now: number): void {
        if (!this.startupDismissConfig) return;
        const verdict = decideStartupDismiss(
            this.startupDismissConfig, this.startupDismissState, screen, this.startupDismissSpawnAt, now,
        );
        if (!verdict.dismiss) return;
        recordStartupDismiss(this.startupDismissState, screen);
        LOG.info('FsmDriver', `[${this.specTag()}] startup prompt matched /${verdict.matchedPattern}/ — sending dismiss key (attempt ${this.startupDismissState.attempts})`);
        try { this.adapter.send_keys(this.startupDismissConfig.key); } catch { /* pty gone — nothing to dismiss */ }
    }

    dispatch(cmd: DashboardCommand): void {
        switch (cmd.kind) {
            case 'send_message': this.sends.handleSendMessage(cmd.text, cmd.bracketedPaste); return;
            case 'pty_write': this.adapter.send_keys(cmd.data); return;
            case 'click_control': this.handleClickControl(cmd.control_id, cmd.payload); return;
            case 'click_modal_button': this.clickModalButton(cmd.index); return;
            case 'attach_image': this.handleAttachImage(cmd.blob, cmd.mime); return;
            case 'resize': this.adapter.resize(cmd.cols, cmd.rows); return;
            case 'cancel': this.adapter.send_keys('\x03'); return;
            case 'shutdown': this.shutdown(); return;
        }
    }

    /** QUEUED-SEND-LOSS: see ISpecDriver.sendMessageWithDisposition. */
    sendMessageWithDisposition(text: string, bracketedPaste?: boolean): SendDisposition {
        return this.sends.handleSendMessage(text, bracketedPaste);
    }

    /** SEND-NOW-AGENT-QUEUE: see ISpecDriver.sendMessageDuringGeneration. */
    sendMessageDuringGeneration(text: string, bracketedPaste?: boolean): QueuedWriteOutcome {
        return this.sends.sendMessageDuringGeneration(text, bracketedPaste);
    }

    /** SEND-NOW-WRONG-ITEM: see ISpecDriver.reserveDrain. */
    reserveDrain(ttlMs: number): void {
        this.sends.reserveDrain(ttlMs);
    }

    /** SEND-NOW-WRONG-ITEM: see ISpecDriver.releaseDrain. */
    releaseDrain(): void {
        this.sends.releaseDrain();
    }

    /** SEND-NOW-DOUBLE-SEND: see ISpecDriver.claimQueuedSends. */
    claimQueuedSends(text: string): number {
        return this.sends.claimQueuedSends(text);
    }

    /** Forward runtime metadata to the terminal transport so mesh binding
     *  fields (meshNodeId / meshNodeFor / workspaceLabel / lifecycle) reach
     *  the session registry. Not a DashboardCommand — this is a control-plane
     *  update, not user input. */
    updateMeta(meta: Record<string, unknown>, replace = false): void {
        this.adapter.updateMeta(meta, replace);
    }

    /**
     * TX-FSM Stage 0 (shadow): receive the daemon-normalized signal
     * observation. The driver stores it verbatim — it does NOT poll, parse,
     * or read anything itself (generic-PTY-engine boundary). The observation
     * only feeds the shadow verdict of `signal` conditions; the evaluator's
     * Stage-0 pass-through guarantees it cannot change a transition.
     */
    setSignalObservation(snapshot: SignalSnapshot | null): void {
        this.signalObservation = snapshot ?? null;
    }

    snapshot(): string { return this.adapter.snapshot(); }
    getCursorPosition(): { row: number; col: number } { return this.adapter.getCursorPosition(); }
    getScreen(): string { return this.adapter.snapshot(); }
    getScreenSize(): { cols: number; rows: number } { return this.adapter.getScreenSize(); }

    /** Scrollback-inclusive screen as line array — used only for modal/button
     *  content extraction so a tall prompt's off-screen anchors stay matchable.
     *  Falls back to the viewport snapshot if scrollback read is unavailable. */
    private scrollbackLines(): string[] {
        let screen = '';
        try {
            screen = this.adapter.snapshotWithScrollback();
        } catch { /* fall through to viewport */ }
        if (!screen) screen = this.adapter.snapshot();
        return screen.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
    }
    getSpecPath(): string { return this.opts.specPath; }

    shutdown(): void {
        for (const t of this.delegateTimers.values()) clearTimeout(t);
        this.delegateTimers.clear();
        if (this.wakeTimer) { clearTimeout(this.wakeTimer); this.wakeTimer = null; }
        if (this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null; }
        if (this.spawnPrimeTimer) { clearTimeout(this.spawnPrimeTimer); this.spawnPrimeTimer = null; }
        if (this.spawnPrimeMaxWaitTimer) { clearTimeout(this.spawnPrimeMaxWaitTimer); this.spawnPrimeMaxWaitTimer = null; }
        this.spawnPrimeAwaitingOutput = false;
        this.spawnPrimePending = false;
        this.flushStallRefocusLogSummary();
        // ENTER-LOSS layer ① scope note: clearing these timers DROPS any submit
        // still in flight — which is exactly why shutdownDaemonComponents runs
        // the drain gate (cliManager.drainInFlightSubmits) BEFORE the teardown
        // that reaches here. The gate only covers the graceful shutdown path: a
        // SIGKILL / crash / power loss never runs it (nor this method), which is
        // why the boot-time composer-residue sweep (layer ③) exists as the
        // backstop for those paths.
        // SEND-OVERLAP: this also drops the queued-send drain timer — a torn-down
        // driver must never write a queued body into a dead PTY.
        this.sends.cancelTimers();
        if (this.win32ModalConfirmTimer) { clearTimeout(this.win32ModalConfirmTimer); this.win32ModalConfirmTimer = null; }
        // QUEUED-SEND-LOSS: discarding the backlog is correct, doing it silently
        // is not. `pendingSends` is a memory-only FIFO, and the daemon already
        // told the dashboard the send succeeded — so a driver torn down while a
        // body is queued loses owner input that the UI has, by then, cleared
        // from the draft box. Nobody finds out. This log is the only record that
        // it happened. Content-free by construction: lengths and a count, never
        // the prompt bodies (they are user data, and this is an ordinary
        // shutdown path that runs on every session teardown).
        if (this.sends.queueDepth > 0) {
            const lengths = this.sends.queuedLengths();
            LOG.warn(
                'FsmDriver',
                `[${this.specTag()}] DISCARDING ${this.sends.queueDepth} queued send(s) on shutdown — `
                + `owner input accepted but never submitted (session=${this.opts.sessionId || 'unknown'}, lengths=[${lengths.join(',')}])`,
            );
        }
        this.sends.discardQueued();
        this.specWatcher?.close();
        this.adapter.kill();
    }

    // ── Debug surface (the whole reason for the rewrite) ──────────────────
    //
    // getFsmDebug() answers, for the CURRENT instant: which state am I in,
    // how long have I been here, and for every outgoing transition — does its
    // guard pass right now, and if not, which sub-condition is blocking and
    // how many ms until it would flip. No screenshots required.

    getFsmDebug(): {
        currentState: string;
        label: string;
        stateAgeMs: number;
        status: string;
        cursor: { row: number; col: number };
        transitions: TransitionEval[];
    } {
        const now = Date.now();
        const cursor = this.adapter.getCursorPosition();
        const screen = this.adapter.snapshot();
        const ev = this.evalFsmNow(screen, cursor, now);
        const state = stateById(this.spec, this.currentStateId);
        return {
            currentState: this.currentStateId,
            label: state?.label ?? this.currentStateId,
            stateAgeMs: now - this.stateEnteredAt,
            status: state ? statusForState(state) : 'idle',
            cursor,
            transitions: ev.transitions,
        };
    }

    getStateHistory(): ReadonlyArray<HistoryEntry> { return this.stateHistory; }
    getFsmSnapshotHistory(): ReadonlyArray<FsmSnapshotEntry> { return this.fsmSnapshotHistory; }
    /** Debug-only PTY input/output/resize/cursor timeline from the adapter. */
    getEventTimeline(limit?: number): ReadonlyArray<SpecPtyEvent> {
        return this.adapter.getEventTimeline(limit);
    }
    getSections(screenText?: string): Array<{ id: string; text: string }> | null {
        try {
            // Slice the caller's screen when one is supplied. Taking a fresh
            // snapshot here would read a DIFFERENT frame than the caller already
            // holds: during generating the TUI repaints continuously (spinner,
            // reflow after a resize), so the two reads land on separate frames
            // and the reported sections stop matching the reported screen —
            // observed as a screen whose first line was wrapped at one width
            // while `footer` came from a later paint at another width, a
            // combination no single VT buffer can hold.
            const screen = screenText ?? this.adapter.snapshot();
            const lines = screen.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
            return resolveSections(this.spec.sections ?? {}, lines).map(s => ({ id: s.id, text: s.text }));
        } catch { return null; }
    }

    /** v3-compat shims so the cli-adapter's existing debug snapshot keeps
     *  working without branching on driver type. */
    getLastBusyAt(): number {
        // Approximate: time we entered a generating-status state.
        const st = stateById(this.spec, this.currentStateId);
        return st && statusForState(st) === 'generating' ? this.stateEnteredAt : 0;
    }
    hasIdleHoldPending(): boolean {
        // FSM has no separate idle-hold timer; min_hold_ms is the analog.
        // Report true while any outgoing transition is hold-blocked.
        return (this.lastFsmEval?.transitions ?? []).some(t => !t.holdSatisfied && t.condResult);
    }
    /**
     * True once the machine has reached its first non-initial idle state (the
     * prompt is genuinely drawn — see maybeMarkReady). The cli-adapter surfaces
     * this on its idle status so CliProviderInstance can re-arm the queue-claim
     * agent:ready on the first genuine ready, independent of the boot-time
     * starting→idle one-shot (which is consumed too early for specs whose
     * initial state already reports idle).
     */
    hasSeenReady(): boolean {
        return this.readySeenOnce;
    }
    getCompletionIdleDebounceState(): { active: boolean; ageMs: number; holdMs: number; forceAfterMs: number } | null {
        // Surface the busy→ready transition's stable countdown, if any, so the
        // existing panel field stays meaningful.
        const out = outgoingTransitions(this.spec, this.currentStateId);
        const toReady = this.lastFsmEval?.transitions.find((t, i) => {
            const st = stateById(this.spec, out[i]?.to ?? '');
            return st && statusForState(st) === 'idle';
        });
        if (!toReady || !toReady.cond) return null;
        const stable = findStable(toReady.cond);
        if (!stable) return null;
        return { active: true, ageMs: 0, holdMs: stable.totalMs, forceAfterMs: 0 };
    }

    // ────────────────────────────────────────────────────────────────────
    // Loading & adapter wiring
    // ────────────────────────────────────────────────────────────────────

    private loadSpecOrThrow(): void {
        const res = loadFsmSpec(this.opts.specPath);
        if (!res.ok) throw new Error(`fsm spec invalid: ${res.errors.join('; ')}`);
        this.spec = res.spec;
        reportFsmSpecWarnings(res.warnings, this.specTag(), LOG.warn.bind(LOG));
    }

    private buildAdapterOpts(): TerminalAdapterOpts {
        // Single-source spawn resolution: route the spec's binary/args/env
        // through the shared spawn planner (resolveCliSpawnPlanFromParts,
        // inherited from the legacy ProviderCliAdapter engine deleted in
        // 48e5ed1a). This gives the spec/FSM path
        // findBinary (PATH + npm-global / Node-dir fallback so an off-PATH
        // `codex`/`claude` resolves), `{{workingDir}}` token substitution, shell
        // wrapping for script-shims / non-absolute / non-native binaries, and a
        // sanitized env with TERMINAL_CWD — none of which it had when it passed
        // `this.spec.binary` straight to the PTY.
        const cols = this.opts.cols ?? DEFAULT_SESSION_HOST_COLS;
        const rows = this.opts.rows ?? DEFAULT_SESSION_HOST_ROWS;
        // PERMISSION-MODE-DUPLICATE: the spec's own base args are subject to the
        // selected auto-approve mode's removeArgs, exactly as the manifest's
        // spawn.args are in applyAutoApproveModeLaunchArgs. Without this the two
        // sources both contribute a `--permission-mode`.
        const specSpawnArgs = stripRemovedSpawnArgs(
            this.spec.spawn_args ?? [],
            this.opts.removeSpawnArgs ?? [],
        );
        const plan = resolveCliSpawnPlanFromParts({
            command: this.spec.binary,
            baseArgs: specSpawnArgs,
            baseEnv: this.spec.env ?? {},
            workingDir: this.opts.workingDir,
            extraArgs: this.opts.extraCliArgs ?? [],
            extraEnv: this.opts.extraEnv ?? {},
            geometry: { cols, rows },
            // CliSpecV4 is the FSM runtime spec (specs/4.0.json), not the
            // provider manifest, so it carries no `type`/`providerVersion`.
            // `id`/`name` is the identity this path actually has; the manifest
            // version is genuinely unavailable here rather than omitted.
            diagnosticCliType: this.spec.id || this.spec.name,
        });
        return {
            binary: plan.shellCmd,
            args: plan.shellArgs,
            cwd: plan.ptyOptions.cwd,
            // plan.ptyOptions.env is already a complete, sanitized environment —
            // pass it verbatim, do not overlay process.env (see envIsComplete).
            env: plan.ptyOptions.env,
            envIsComplete: true,
            cols,
            rows,
            transportFactory: this.opts.transportFactory,
        };
    }

    private armSpecWatcher(): void {
        try {
            const dir = path.dirname(this.opts.specPath);
            const base = path.basename(this.opts.specPath);
            this.specWatcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
                if (filename && filename !== base) return;
                const res = loadFsmSpec(this.opts.specPath);
                if (!res.ok) {
                    this.emit({ kind: 'spec_error', errors: res.errors });
                    return;
                }
                this.spec = res.spec;
                reportFsmSpecWarnings(res.warnings, this.specTag(), LOG.warn.bind(LOG));
                LOG.info('FsmDriver', `[${this.specTag()}] spec hot-reloaded`);
                // Re-evaluate immediately with the new transitions.
                this.reevaluate(true);
            });
        } catch { /* best-effort */ }
    }

    private emitInitialState(): void {
        this.reevaluate(true);
    }

    // ────────────────────────────────────────────────────────────────────
    // Core: evaluate the FSM and commit transitions
    // ────────────────────────────────────────────────────────────────────

    private buildClock(now: number): FsmClock {
        return {
            now,
            stateEnteredAt: this.stateEnteredAt,
            regionLastChangedAt: this.regionLastChangedAt,
        };
    }

    private evalFsmNow(screen: string, cursor: { row: number; col: number }, now: number) {
        const prev = this.prevScreenLines.length > 0 ? this.prevScreenLines : undefined;
        return evaluateFsm(this.spec, this.currentStateId, screen, cursor, prev, this.buildClock(now), this.signalObservation);
    }

    /**
     * TX-FSM Stage 0 (shadow): compare each signal-guarded transition's
     * counterfactual verdict against the real (PTY-only) one and log on FLIP.
     * This is the "만약 적용했다면" half of the shadow log — the Stage 1-3
     * evidence for whether signal gating would have changed any verdict, and
     * in which direction. Read-only: runs after the evaluation is complete
     * and never feeds back into it.
     */
    private logShadowDivergence(ev: FsmEvaluation): void {
        for (const t of ev.transitions) {
            if (!t.shadow) continue;
            const key = `${this.currentStateId}→${t.to}`;
            const diverges = t.shadow.fires !== t.fires;
            if ((this.shadowDivergenceLast.get(key) ?? false) === diverges) continue;
            this.shadowDivergenceLast.set(key, diverges);
            if (diverges) {
                LOG.info(
                    'FsmDriver',
                    `[${this.specTag()}] [shadow] ${key} (${t.label}): real fires=${t.fires}`
                    + ` but signal-gated verdict would be fires=${t.shadow.fires}`
                    + ` (shadowCond=${t.shadow.condResult}${t.shadow.unknown ? ', signal unknown/fail-open' : ''})`,
                );
            } else {
                LOG.info(
                    'FsmDriver',
                    `[${this.specTag()}] [shadow] ${key} (${t.label}): shadow verdict realigned with real fires=${t.fires}`,
                );
            }
        }
    }

    private reevaluate(forceEmit = false): void {
        const now = Date.now();
        const screen = this.adapter.snapshot();
        this.maybeDismissStartupPrompt(screen, now);
        const cursor = this.adapter.getCursorPosition();
        const currentLines = screen.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);

        // Track per-region change timestamps for stable_ms conditions BEFORE
        // we overwrite prevScreenLines.
        this.trackRegionChanges(currentLines, cursor, now);

        const ev = this.evalFsmNow(screen, cursor, now);
        this.lastFsmEval = ev;
        this.prevScreenLines = currentLines;
        this.logShadowDivergence(ev);

        if (ev.fired) {
            this.commitTransition(ev.fired, now, ev);
            // Mark ready BEFORE emitStateChanged so SpecCliAdapter.getStatus()
            // on the idle-entry frame already has fsmReadySeen=true. The
            // adapter's statusCallback → detectStatusTransition runs inside
            // emit; if maybeMarkReady ran after, a quiet CLI (no further PTY
            // frames at the prompt) would never re-poll and agent:ready would
            // never fire — antigravity signing_in→idle, live M-MESH-INFRA-0829.
            this.maybeMarkReady();
            // After a transition, immediately re-derive controls/modal for the
            // new state and emit. Re-run once so a chain like approval→busy
            // that's already satisfied doesn't wait for the next PTY frame.
            this.emitStateChanged(forceEmit);
            this.scheduleWakeForState();
            this.scheduleStallWatchdog();
            // Drain queued sends on the SAME frame the machine reaches "ready".
            // The first delegated message is queued in pendingSends until the
            // FSM first enters a non-initial idle state (the prompt is drawn).
            // That readiness is normally reached BY a transition (e.g.
            // signing_in→idle / starting→idle) — and an idle state has no
            // pending time-condition, so scheduleWakeForState() arms no timer
            // and, agy being quiet at the prompt, no further PTY frame arrives.
            // Without this call the queued first message would strand here
            // forever (the "first input never processed" bug). maybeMarkReady is
            // idempotent (guarded by readySeenOnce) so calling it on both
            // branches is safe. Drain stays after emit so detectStatusTransition
            // observes idle+fsmReadySeen before the first queued body is written.
            this.sends.drainPendingSends();
            return;
        }

        // No transition — refresh modal/controls (content inside the same
        // state can still change, e.g. modal title/buttons) and emit if changed.
        this.maybeMarkReady();
        this.emitStateChanged(forceEmit);
        // Schedule a wake for the soonest pending time-condition.
        this.scheduleWakeForState();
        this.scheduleStallWatchdog();
        // Drain queued sends once we first reach a "ready" state.
        this.sends.drainPendingSends();
    }

    private commitTransition(fired: TransitionEval, now: number, ev: FsmEvaluation): void {
        const from = this.currentStateId;
        // Capture the full pre-transition evaluation BEFORE we mutate state, so
        // the snapshot records why this transition fired from `from`.
        this.pushFsmSnapshot(from, fired, now, ev);
        this.currentStateId = fired.to;
        this.stateEnteredAt = now;
        // Region change timestamps are relative to the previous state's
        // activity; reset so stable_ms in the new state measures from entry.
        this.regionLastChangedAt.clear();
        this.stableVerdictCache.clear();
        this.pushHistory(fired.to, stateById(this.spec, fired.to)?.label ?? fired.to, {
            reason: 'transition',
            via: `${from}→${fired.to}`,
            matchedRules: summarizeTransition(fired),
        });
        LOG.info('FsmDriver', `[${this.specTag()}] ${from} → ${fired.to} (${fired.label})`);
    }

    /** Snapshot the full FSM evaluation that produced a transition into the
     *  separate fsmSnapshotHistory ring buffer (max 20). The transitions[]
     *  table is captured by reference — it is freshly built per evaluation in
     *  evaluateFsm and never mutated after, so no clone is needed. */
    private pushFsmSnapshot(from: string, fired: TransitionEval, now: number, ev: FsmEvaluation): void {
        this.fsmSnapshotHistory.push({
            stateFrom: from,
            stateTo: fired.to,
            at: now,
            firedTo: fired.to,
            firedLabel: fired.label,
            reason: summarizeTransition(fired),
            transitions: ev.transitions,
        });
        if (this.fsmSnapshotHistory.length > 20) this.fsmSnapshotHistory.shift();
    }

    /** Re-derive the visible modal + controls for the current state and emit a
     *  state_changed if anything differs from the last emit. */
    private emitStateChanged(forceEmit: boolean): void {
        const state = stateById(this.spec, this.currentStateId);
        if (!state) return;
        const screen = this.adapter.snapshot();
        const lines = screen.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
        const sections = resolveSections(this.spec.sections ?? {}, lines);

        // Modal states (approval / picker) extract their buttons + title from a
        // SCROLLBACK-INCLUSIVE buffer: claude-cli renders an approval as a box,
        // and when the prompt body (a big diff / long explanation) is tall the
        // top of the box — including the `─────` separator that anchors the
        // `modal` section — scrolls above the viewport. Matching only the
        // viewport then yields < min_count buttons, deriveModal returns null,
        // and auto-approve never fires (the "long prompts never auto-approve"
        // bug). The viewport stays authoritative for transitions / cursor
        // conditions; only this content-pattern extraction reads scrollback.
        const modalLines = state.modal
            ? this.scrollbackLines()
            : lines;
        const modalSections = state.modal
            ? resolveSections(this.spec.sections ?? {}, modalLines)
            : sections;
        const modalFullScreen = modalLines.join('\n');

        const modal = this.deriveModal(state, modalSections, modalFullScreen);
        const controls = this.deriveControls(state.id);
        const title = modal?.title ?? this.deriveTitle(state, modalSections, modalFullScreen);

        const next: CurrentEval = {
            // status is derived from the FSM state itself (statusForState), NOT from
            // whether a modal was parsed this frame. A modal state whose buttons briefly
            // fail to parse (PTY repaint → deriveModal returns null) must still report
            // its authoritative status (e.g. 'approval'), so the adapter never collapses
            // an approval/busy state to idle on a transient modal-parse miss.
            state: { id: state.id, label: state.label, title, status: statusForState(state) },
            modal,
            controls,
        };

        const changed = forceEmit
            || !this.currentEval
            || this.currentEval.state.id !== next.state.id
            || this.currentEval.state.title !== next.state.title
            || !sameModal(this.currentEval.modal, next.modal)
            || !sameControls(this.currentEval.controls, next.controls);

        this.currentEval = next;
        if (this.pickerInProgress) this.tryAdvancePicker(screen);

        if (changed) {
            this.emit({
                kind: 'state_changed',
                state: next.state,
                // kind is the SEMANTIC modal class (approval vs picker/confirm)
                // derived from the FSM state, NOT from the parsed buttons — the
                // status field already collapsed it to 'approval' so the modal is
                // surfaced. The auto-approve worker needs the distinction back to
                // avoid answering a /model picker on the user's behalf.
                modal: next.modal ? { title: next.modal.title, buttons: next.modal.buttons.map(b => ({ index: b.index, label: b.label })), kind: modalKindForState(state) } : null,
                controls: next.controls.map(c => ({ id: c.id, label: c.label, action_type: c.actionType })),
            });
            this.fireNotifications(state.id, title);
            this.armOrCancelDelegateTimers(state.id);
        }
    }

    private deriveModal(state: FsmState, sections: ResolvedSection[], fullScreen: string): ModalSnapshot | null {
        const rule = state.extract?.buttons;
        if (!rule) return null;
        const hay = sectionText(sections, rule.section, fullScreen);
        const minCount = rule.min_count ?? 2;
        let buttons = extractButtonsFromRule(rule, hay);
        if (buttons.length < minCount && rule.section) {
            // Whole-screen fallback: the modal `section` can resolve too short
            // when a spec's `until` anchor clips the section BEFORE the choices
            // (e.g. a claude-cli approval whose command preview carries a leading
            // shell-redirect line — `>/dev/null 2>&1` — that an over-broad
            // `[…>…]` modal-terminator anchor mistakes for the input prompt,
            // stranding the `❯ 1. Yes / 2. No` buttons below the cut and wedging
            // auto-approve forever). The buttons are still present in the full
            // buffer, so re-extract from it. `lastContiguousNumberedBlock`
            // (inside extractButtonsFromRule) already isolates the real
            // bottom-most choice block from any stray body-numbered lines the
            // wider scope pulls in, so this cannot bind the wrong rows. Guards
            // it to the buttons-under-count case only, so a correctly-scoped
            // spec pays nothing.
            const whole = extractButtonsFromRule(rule, fullScreen);
            if (whole.length >= minCount) buttons = whole;
        }
        if (buttons.length < minCount) return null;
        const title = this.deriveTitle(state, sections, fullScreen);
        return { title, buttons };
    }

    private deriveTitle(state: FsmState, sections: ResolvedSection[], fullScreen: string): string | null {
        const rule = state.extract?.title;
        if (!rule) return null;
        return extractTitle(rule, sections, fullScreen);
    }

    private deriveControls(stateId: string): VisibleControl[] {
        const out: VisibleControl[] = [];
        for (const c of this.spec.control_bar ?? []) {
            if (c.visible_when_state && !c.visible_when_state.includes(stateId)) continue;
            out.push({ id: c.id, label: c.label, actionType: c.action.type });
        }
        return out;
    }

    /** Track which stable regions changed since the previous frame so
     *  stable_ms conditions can measure quiet time. We record every distinct
     *  stable region referenced in the current state (numeric cursor_above /
     *  whole-screen -1, and named `section:<id>` regions) plus, for each, the
     *  optional `ignore_lines` filter that folds into its key.
     *
     *  `ignore_lines` is the content-aware fix for the busy→idle wedge: lines
     *  matching it are stripped from BOTH frames before the comparison, so a
     *  benign residual ticker (bare token counter / elapsed timer that repaints
     *  every frame post-generation) no longer resets the clock — while an active
     *  spinner line, which does NOT match the benign pattern, still does (the
     *  FALSEIDLE2 / FALSEBUSY-B whole-screen invariant is preserved). */
    private trackRegionChanges(currentLines: string[], cursor: { row: number; col: number }, now: number): void {
        if (this.prevScreenLines.length === 0) return;
        const descs = this.stableRegionDescriptors();
        // COMPLETION-EARLYNOTIFY hook 4: record the stable/not-stable verdict for each
        // tracked region, but ONLY when the verdict flips (see stableVerdictCache) so a
        // quiet screen does not spam the ring buffer. This is the case-b diagnostic — an
        // ignore_lines-scoped stable clause declaring a tool-execution screen "stable-idle"
        // shows up here as verdict:true with a short fingerprint. Payload carries lengths
        // and the pattern SOURCE only — never screen text.
        const stableTraceOn = shouldCollectTraceCategory('fsm-transition');
        // Section ranges depend on screen content, so resolve per-frame for both
        // frames — but only when some tracked region is actually section-scoped.
        const needsSections = descs.some(d => !!d.section);
        const curSections = needsSections ? resolveSections(this.spec.sections ?? {}, currentLines) : [];
        const prevSections = needsSections ? resolveSections(this.spec.sections ?? {}, this.prevScreenLines) : [];
        for (const d of descs) {
            let curLines: string[]; let prevLines: string[];
            if (d.section) {
                curLines = sliceSectionLines(currentLines, curSections, d.section);
                prevLines = sliceSectionLines(this.prevScreenLines, prevSections, d.section);
            } else if (!d.cursor_above || d.cursor_above <= 0) {
                curLines = currentLines;
                prevLines = this.prevScreenLines;
            } else {
                // CODEX-FSM-DEGENERATE-STABLE fix: cursor.row is the backend's RAW
                // row coordinate (ghostty getCursorPosition(), un-normalized), while
                // currentLines is the VIEWPORT snapshot with blank ends trimmed
                // (ghostty-vt-backend getText → trimBlankEnds). The two coordinate
                // spaces diverge whenever trailing blank rows are trimmed away (or
                // the backend counts scrollback rows): cursor.row then overshoots
                // the array and slice(start, cursor.row) returns an EMPTY window.
                // Two empty windows compare equal on every frame, so
                // regionLastChangedAt never advances and stable_ms accumulates
                // forever — the FSM read a generating screen as
                // "stable cursor_above=4 353833ms / 1500ms" and committed a false
                // busy→idle (live RCA: generating_completed at duration=402s while
                // the native transcript kept growing).
                //
                // Invariant: an unmeasurable window must NEVER read as "stable".
                // Clamp the window end to the content length (when the cursor sits
                // in the trimmed blank region, the lines directly above it in
                // content terms are the content tail), and when the window is still
                // empty (no measurable content at all) mark the region CHANGED so
                // the stable clock restarts instead of accumulating.
                const window = stableCursorWindow(currentLines.length, cursor.row, d.cursor_above);
                if (!window) {
                    this.regionLastChangedAt.set(d.key, now);
                    continue;
                }
                curLines = currentLines.slice(window.start, window.end);
                prevLines = this.prevScreenLines.slice(window.start, window.end);
            }
            const cur = filterIgnoredLines(curLines, d.ignoreRe).join('\n');
            const prev = filterIgnoredLines(prevLines, d.ignoreRe).join('\n');
            if (cur !== prev) this.regionLastChangedAt.set(d.key, now);
            if (stableTraceOn && typeof d.holdMs === 'number') {
                const lastChanged = this.regionLastChangedAt.get(d.key) ?? this.stateEnteredAt;
                const ageMs = now - lastChanged;
                const verdict = ageMs >= d.holdMs;
                if (this.stableVerdictCache.get(d.key) !== verdict) {
                    this.stableVerdictCache.set(d.key, verdict);
                    recordDebugTrace({
                        category: 'fsm-transition',
                        stage: 'stable-eval',
                        level: 'debug',
                        payload: {
                            state: this.currentStateId,
                            regionKey: String(d.key),
                            ignorePattern: d.ignoreRe?.source ?? null,
                            fingerprintLen: cur.length,
                            ageMs,
                            holdMs: d.holdMs,
                            verdict,
                        },
                    });
                }
            }
        }
    }

    /** Every distinct stable-region descriptor referenced by stable_ms
     *  conditions in the current state's outgoing transitions, plus the plain
     *  whole-screen key (-1) that other machinery (stall watchdog) reads.
     *  De-duplicated by key. Cached lazily per spec load would be nicer but the
     *  set is tiny. */
    private stableRegionDescriptors(): StableRegionDescriptor[] {
        const byKey = new Map<number | string, StableRegionDescriptor>();
        byKey.set(-1, { key: -1 });
        for (const t of outgoingTransitions(this.spec, this.currentStateId)) {
            collectStableDescriptors(t.when, byKey);
        }
        return [...byKey.values()];
    }

    /** Schedule a re-evaluation for the soonest pending time-condition on any
     *  outgoing transition (elapsed_ms / stable_ms / min_hold_ms). Without
     *  this, a state whose only exit is time-based would never leave once the
     *  PTY goes quiet. */
    private scheduleWakeForState(): void {
        if (this.wakeTimer) { clearTimeout(this.wakeTimer); this.wakeTimer = null; }
        const ev = this.lastFsmEval;
        if (!ev) return;
        let soonest = Infinity;
        for (const t of ev.transitions) {
            if (t.fires) continue;
            if (!t.holdSatisfied) soonest = Math.min(soonest, t.holdRemainingMs);
            const condRemain = t.cond ? t.cond.remainingMs ?? Infinity : Infinity;
            // Only treat the cond countdown as a wake source when the rest of
            // the guard (hold) is already or will be satisfied.
            if (Number.isFinite(condRemain) && condRemain > 0) soonest = Math.min(soonest, condRemain);
        }
        if (!Number.isFinite(soonest)) return;
        this.wakeTimer = setTimeout(() => { this.wakeTimer = null; this.reevaluate(); }, Math.max(soonest + 30, 50));
    }

    // ── Focus-gated stall watchdog (refocus_when_stalled_ms) ──────────────────
    //
    // A focus-event TUI (antigravity's `agy`) freezes its render loop the moment
    // it thinks it has lost focus mid-turn: the screen stops updating and only
    // repaints on the next keypress, which the daemon never sends. The output
    // pump is wired entirely to PTY onData (no PTY data → no reevaluate, no
    // on_screen_changed), so a normal time-wake that only re-reads the screen
    // can't help — there is nothing new to read. The fix is to re-inject the
    // focus-in wake (`send_on_spawn`) so the CLI flushes the held output itself.

    /** True when this spec opts into stall recovery (declares a positive
     *  refocus window AND a wake sequence to re-inject). */
    private stallRecoveryEnabled(): boolean {
        const ms = this.spec.refocus_when_stalled_ms;
        return typeof ms === 'number' && ms > 0
            && Array.isArray(this.spec.send_on_spawn) && this.spec.send_on_spawn.length > 0;
    }

    /** Wall-clock time the screen last changed in the current state, falling
     *  back to state entry when it has not changed since (i.e. fully stalled
     *  from the start of the state). */
    private lastScreenChangeAt(): number {
        return this.regionLastChangedAt.get(-1) ?? this.stateEnteredAt;
    }

    /** Arm a timer to re-inject the focus-in prime if the screen stays frozen
     *  through a `generating` state. Only active for opted-in focus-gated specs;
     *  a no-op (and cleared) for every other CLI and every non-generating state.
     *  Re-arms itself so it keeps watching while the PTY is quiet. */
    private scheduleStallWatchdog(): void {
        if (this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null; }
        if (!this.stallRecoveryEnabled()) return;
        const st = stateById(this.spec, this.currentStateId);
        if (!st || statusForState(st) !== 'generating') return;
        const windowMs = this.spec.refocus_when_stalled_ms as number;
        // Cooldown reference: a re-prime defers the next one by a full window,
        // even if the screen has not yet repainted, so we don't tight-loop.
        const since = Math.max(this.lastScreenChangeAt(), this.lastRefocusAt);
        const remaining = windowMs - (Date.now() - since);
        this.stallTimer = setTimeout(
            () => { this.stallTimer = null; this.onStallTick(); },
            Math.max(remaining + 30, 50),
        );
    }

    /** Fire when the stall window elapses: if the screen is still frozen and we
     *  are still generating, re-inject the focus-in wake once, then re-arm. */
    private onStallTick(): void {
        if (!this.stallRecoveryEnabled()) return;
        const st = stateById(this.spec, this.currentStateId);
        if (!st || statusForState(st) !== 'generating') return;
        const windowMs = this.spec.refocus_when_stalled_ms as number;
        const now = Date.now();
        const stalledFor = now - this.lastScreenChangeAt();
        const sinceLastRefocus = now - this.lastRefocusAt;
        if (stalledFor >= windowMs && sinceLastRefocus >= windowMs) {
            if (this.stallRefocusInfoCount < STALL_REFOCUS_INFO_LIMIT) {
                this.stallRefocusInfoCount += 1;
                LOG.info('FsmDriver', `[${this.specTag()}] stall detected (${stalledFor}ms quiet, generating) — re-injecting focus-in (${this.stallRefocusInfoCount}/${STALL_REFOCUS_INFO_LIMIT} detailed)`);
            } else {
                this.stallRefocusSuppressedCount += 1;
            }
            this.sendSpawnPrime('stall-refocus');
            this.lastRefocusAt = now;
        }
        // Keep watching: the re-prime may not flush instantly, and a still-quiet
        // screen needs the next window to come around.
        this.scheduleStallWatchdog();
    }

    /** Emit one exact session summary, then zero the counter so recursive or
     *  repeated shutdown calls cannot duplicate it. Write failures remain warn
     *  per attempt in TerminalAdapter and are never suppressed here. */
    private flushStallRefocusLogSummary(): void {
        const suppressed = this.stallRefocusSuppressedCount;
        if (suppressed === 0) return;
        this.stallRefocusSuppressedCount = 0;
        LOG.info('FsmDriver', `[${this.specTag()}] stall refocus log summary: ${suppressed} later reinjection(s) suppressed after first ${STALL_REFOCUS_INFO_LIMIT}`);
    }

    private maybeMarkReady(): void {
        if (this.readySeenOnce) return;
        const st = stateById(this.spec, this.currentStateId);
        if (!st) return;
        // "Ready" = a non-initial state whose status is idle (the prompt is up).
        // Latch only — the queued first send is drained AFTER emitStateChanged
        // so detectStatusTransition observes idle+fsmReadySeen (and fires
        // agent:ready) before the body is written. drainPendingSends still
        // serializes one message at a time (SEND-OVERLAP).
        if (!st.initial && statusForState(st) === 'idle') {
            this.readySeenOnce = true;
        }
    }

    // ────────────────────────────────────────────────────────────────────
    // Notifications & delegates
    // ────────────────────────────────────────────────────────────────────

    private fireNotifications(stateId: string, title: string | null): void {
        for (const n of this.spec.notifications ?? []) {
            if (n.when_state !== stateId) continue;
            const body = (n.body ?? '').replace(/\{state\.title\}/g, title ?? '');
            this.emit({ kind: 'notification', id: n.id, title: n.title, body });
        }
    }

    private armOrCancelDelegateTimers(currentStateId: string): void {
        for (const d of this.spec.delegate ?? []) {
            const armed = this.delegateTimers.has(d.id);
            const shouldFire = d.when_state === currentStateId;
            if (shouldFire && !armed) {
                const delay = d.after_duration_ms ?? 0;
                const t = setTimeout(() => { this.fireDelegate(d); this.delegateTimers.delete(d.id); }, delay);
                this.delegateTimers.set(d.id, t);
            } else if (!shouldFire && armed) {
                clearTimeout(this.delegateTimers.get(d.id)!);
                this.delegateTimers.delete(d.id);
            }
        }
    }

    private fireDelegate(d: DelegateTrigger): void {
        const ev = this.currentEval;
        const task = d.task_template
            .replace(/\{node\}/g, os.hostname())
            .replace(/\{state\.label\}/g, ev?.state.label ?? '')
            .replace(/\{state\.title\}/g, ev?.state.title ?? '')
            .replace(/\{duration_ms\}/g, String(d.after_duration_ms ?? 0));
        this.emit({ kind: 'delegate', id: d.id, task });
    }

    // ────────────────────────────────────────────────────────────────────
    // Dashboard commands (identical semantics to v3)
    // ────────────────────────────────────────────────────────────────────

    /** SUBMIT-SILENT-FAILURE: true when the most recent send exhausted its submit
     *  resend budget without the agent ever leaving the composer. A caller seeing
     *  this should treat an apparent 'generating' status as untrustworthy. */
    lastSubmitUnconfirmed(): boolean {
        return this.sends.lastSubmitUnconfirmed();
    }

    /** ENTER-LOSS layer ① — see ISpecDriver.hasInFlightSubmit. Duck-typed by
     *  cli-adapter / the shutdown drain gate (`typeof … === 'function'`), so
     *  dropping this forwarder would silently turn the gate into a no-op rather
     *  than fail to compile. */
    hasInFlightSubmit(): boolean {
        return this.sends.hasInFlightSubmit();
    }

    /** ENTER-LOSS layer ① — see ISpecDriver.whenSubmitDrained. Duck-typed like
     *  hasInFlightSubmit above. */
    whenSubmitDrained(timeoutMs: number): Promise<boolean> {
        return this.sends.whenSubmitDrained(timeoutMs);
    }

    /** ENTER-LOSS layer ③ — see ISpecDriver.snapshotWithScrollback. */
    snapshotWithScrollback(): string {
        return this.adapter.snapshotWithScrollback();
    }

    /** The agent's current coarse status, derived from the FSM node we're in. */
    private currentStatus(): 'idle' | 'generating' | 'approval' {
        const st = stateById(this.spec, this.currentStateId);
        return st ? statusForState(st) : 'idle';
    }

    private handleClickControl(controlId: string, payload?: unknown): void {
        const ctl = (this.spec.control_bar ?? []).find(c => c.id === controlId);
        if (!ctl) return;
        if (ctl.visible_when_state && !ctl.visible_when_state.includes(this.currentStateId)) return;
        const a = ctl.action;
        switch (a.type) {
            case 'send_keys': this.adapter.send_keys(a.keys); return;
            case 'open_picker':
                // Some TUIs (e.g. codex) don't register a slash command if its
                // text and the submitting Enter arrive in the same write — the
                // composer needs a beat to recognise the command before the CR.
                // Split a trailing CR/LF off the trigger and send it after a
                // short delay, mirroring send_message's delay_ms_before_submit.
                {
                    const m = /^([\s\S]*?)([\r\n]+)$/.exec(a.trigger_keys);
                    if (m && m[1]) {
                        this.adapter.send_keys(m[1]);
                        setTimeout(() => this.adapter.send_keys(m[2]), 200);
                    } else {
                        this.adapter.send_keys(a.trigger_keys);
                    }
                }
                this.pickerInProgress = { control_id: ctl.id, spec: ctl };
                return;
            case 'attach_image': {
                const p = typeof payload === 'object' && payload && (payload as any).path;
                if (typeof p === 'string') this.adapter.send_keys(a.keys_template.replace(/\{path\}/g, p));
                return;
            }
        }
    }

    /**
     * BUTTON-INDEX-MISMAP (Fix C.3): public modal-click entry that returns whether a button
     * matching the requested FSM display index was actually found and its confirm keys were
     * dispatched. The old private handleClickModalButton silently `return`ed on a miss (no
     * modal captured, or no button whose `.index` equals the requested display index), so a
     * mis-mapped index looked identical to a successful press. Callers that need to know
     * whether the click landed (mesh_approve → resolveModal) can now observe the miss instead
     * of reporting success into the void. The generic `dispatch('click_modal_button')` path
     * keeps ignoring the return (fire-and-forget UI clicks).
     */
    clickModalButton(index: number): boolean {
        return this.handleClickModalButton(index);
    }

    private handleClickModalButton(index: number): boolean {
        const m = this.currentEval?.modal;
        if (!m) return false;
        const btn = m.buttons.find(b => b.index === index);
        if (!btn) return false;

        const rule = stateById(this.spec, this.currentStateId)?.extract?.buttons;
        if (rule?.select_mode === 'arrow_keys') {
            // Cursor-list approval modal (claude-cli new TUI): number keys are
            // IGNORED — sending `btn.key` ("1\r") types a literal "1" into the
            // composer and the trailing CR submits it as a chat message. Drive
            // the cursor from its current row to the target row with arrows,
            // then confirm. The cursor opens on the first option, so when the
            // marker isn't detected we step down from row 1 (index - 1).
            const from = m.buttons.find(b => b.current)?.index ?? 1;
            const up = rule.cursor_keys?.up ?? '\x1b[A';
            const down = rule.cursor_keys?.down ?? '\x1b[B';
            const delta = btn.index - from;
            const step = delta >= 0 ? down : up;
            const nav = step.repeat(Math.abs(delta));
            // Confirm = key_for_index with the (now unused) {index} stripped:
            // `{index}\r` → `\r`.
            const confirm = (rule.key_for_index || '\r').replace(/\{index\}/g, '') || '\r';
            if (nav) this.adapter.send_keys(nav);
            this.submitModalConfirm(confirm);
            return true;
        }
        this.submitModalConfirm(btn.key);
        return true;
    }

    /**
     * Submit a modal-confirm key sequence (the choice key + its trailing CR).
     *
     * On win32 the trailing CR is the SAME lone-CR-swallow case as a send_message
     * submit: ConPTY can absorb a single CR as a literal newline instead of a
     * confirm, so the approval/picker modal never resolves and the FSM flaps
     * approval↔busy while auto-approve keeps firing into the void (APPROVESTUCK).
     * So we split any non-CR prefix (e.g. the "1" of "1\r") off, write it once, and
     * resend the CR on a fixed cadence until the modal actually resolves (status
     * leaves 'approval'). Non-win32 keeps the single direct write — its CR submits
     * on the first try.
     */
    private submitModalConfirm(keys: string): void {
        if (process.platform !== 'win32') {
            this.adapter.send_keys(keys);
            return;
        }
        const m = /^([\s\S]*?)([\r\n]+)$/.exec(keys);
        const prefix = m ? m[1] : keys;
        const cr = m ? m[2] : '';
        if (prefix) this.adapter.send_keys(prefix);
        if (!cr) return;
        this.scheduleWin32ModalConfirm(cr);
    }

    /**
     * win32 modal-confirm CR resend loop. Mirrors scheduleVerifiedSubmit's phase-2
     * verified resend, but gated on still being IN a modal (status 'approval')
     * rather than still idle: the first CR fires immediately, then resends every
     * WIN32_SUBMIT_RESEND_GAP_MS while the FSM is still showing the modal, up to
     * WIN32_SUBMIT_MAX_RESENDS. The instant the modal resolves (status flips to
     * generating/idle) we stop, so no stray CR leaks into the next turn's composer.
     */
    private scheduleWin32ModalConfirm(submitKey: string): void {
        if (this.win32ModalConfirmTimer) { clearTimeout(this.win32ModalConfirmTimer); this.win32ModalConfirmTimer = null; }
        const fire = (attempt: number): void => {
            this.win32ModalConfirmTimer = null;
            this.adapter.send_keys(submitKey);
            if (attempt + 1 >= WIN32_SUBMIT_MAX_RESENDS) return;
            this.win32ModalConfirmTimer = setTimeout(() => {
                // Left the modal → it resolved; stop resending.
                if (this.currentStatus() !== 'approval') { this.win32ModalConfirmTimer = null; return; }
                fire(attempt + 1);
            }, WIN32_SUBMIT_RESEND_GAP_MS);
        };
        fire(0);
    }

    private handleAttachImage(blob: string, mime: string): void {
        const ctl = (this.spec.control_bar ?? []).find(c => c.action.type === 'attach_image');
        if (!ctl || ctl.action.type !== 'attach_image') return;
        const ext = guessExt(mime);
        const tmp = path.join(os.tmpdir(), `adhdev-attach-${Date.now()}${ext}`);
        try { fs.writeFileSync(tmp, Buffer.from(blob, 'base64')); } catch { return; }
        this.adapter.send_keys(ctl.action.keys_template.replace(/\{path\}/g, tmp));
    }

    private tryAdvancePicker(screen: string): void {
        const picker = this.pickerInProgress;
        if (!picker) return;
        const action = picker.spec.action;
        if (action.type !== 'open_picker' || !action.wait_for.regex) return;
        const lines = screen.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
        const sections = resolveSections(this.spec.sections ?? {}, lines);
        const hay = sectionText(sections, action.wait_for.section, lines.join('\n'));
        const re = new RegExp(action.wait_for.regex, action.wait_for.flags ?? 'i');
        if (!re.test(hay)) return;
        this.pickerInProgress = null;
    }

    private handleExit(info: PtyRuntimeExitInfo): void {
        this.emit({
            kind: 'exit',
            exit_code: info.exitCode,
            ...(info.signal !== undefined ? { signal: info.signal } : {}),
            ...(info.termination ? { termination: info.termination } : {}),
        });
        this.shutdown();
    }

    private pushHistory(stateId: string, label: string, meta: { reason: string; via?: string; matchedRules?: string[] }): void {
        const now = Date.now();
        const durationMs = this.prevStateAt > 0 ? now - this.prevStateAt : 0;
        this.prevStateAt = now;
        this.stateHistory.push({
            stateId, label, at: now, durationMs,
            reason: meta.reason,
            ...(meta.via ? { via: meta.via } : {}),
            ...(meta.matchedRules ? { matchedRules: meta.matchedRules } : {}),
        });
        if (this.stateHistory.length > 50) this.stateHistory.shift();
    }

    /**
     * FSMLOG-SESSION-ATTRIBUTION (D3): log prefix identifying BOTH the spec being driven and the
     * session driving it. Previously spec-only, which made every concurrent session of the same
     * provider log under an identical tag. The session segment is the owning instance's session id
     * (short form — the leading 8 chars are what mesh ledger/trace lines carry, so logs grep-join
     * against them), or a per-driver `d<n>` fallback when no session id was supplied.
     */
    private specTag(): string {
        const spec = this.opts.specPath.split(/[/\\]/).slice(-3).join('/');
        return `${spec}|${this.sessionTag}`;
    }

    private emit(ev: DashboardEvent): void {
        for (const l of this.listeners) {
            try { l(ev); } catch { /* listener side */ }
        }
    }
}

// ── helpers ──────────────────────────────────────────────────────────────

function sameModal(a: ModalSnapshot | null, b: ModalSnapshot | null): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.title !== b.title) return false;
    if (a.buttons.length !== b.buttons.length) return false;
    for (let i = 0; i < a.buttons.length; i += 1) {
        if (a.buttons[i].label !== b.buttons[i].label) return false;
    }
    return true;
}

function sameControls(a: VisibleControl[], b: VisibleControl[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i].id !== b[i].id) return false;
    return true;
}

/** A compact one-line-per-condition summary of why a transition fired. */
function summarizeTransition(t: TransitionEval): string[] {
    const out: string[] = [`${t.label} fired`];
    if (t.cond) flattenCond(t.cond, out, 1);
    return out;
}

function flattenCond(c: import('./fsm-evaluator.js').CondResult, out: string[], depth: number): void {
    const matched = c.matchedText ? ` matched=${JSON.stringify(c.matchedText)}` : '';
    out.push(`${'  '.repeat(depth)}${c.kind} ${c.detail} = ${c.result}${c.remainingMs ? ` (${c.remainingMs}ms left)` : ''}${matched}`);
    for (const child of c.children ?? []) flattenCond(child, out, depth + 1);
}

function findStable(c: import('./fsm-evaluator.js').CondResult): { totalMs: number } | null {
    if (c.kind === 'stable') {
        const m = /\/ (\d+)ms/.exec(c.detail);
        return { totalMs: m ? Number(m[1]) : 0 };
    }
    for (const child of c.children ?? []) {
        const r = findStable(child);
        if (r) return r;
    }
    return null;
}

/** Resolved description of one stable region the driver must track: its map
 *  key, the geometry (section / cursor_above / whole-screen), and a compiled
 *  `ignore_lines` matcher. */
interface StableRegionDescriptor {
    key: number | string;
    section?: string;
    cursor_above?: number;
    ignoreRe?: RegExp;
    /** The stable_ms threshold the FIRST clause on this region declares. Used
     *  only by the COMPLETION-EARLYNOTIFY stable-eval trace to report the
     *  stable/not-stable verdict; the FSM decision itself is owned by the
     *  evaluator against the live clause. */
    holdMs?: number;
}

function collectStableDescriptors(when: FsmTransition['when'], byKey: Map<number | string, StableRegionDescriptor>): void {
    if (!when) return;
    const w = when as any;
    if ('stable_ms' in w) {
        const key = stableRegionKey(w);
        const existing = byKey.get(key);
        if (!existing) {
            let ignoreRe: RegExp | undefined;
            if (w.ignore_lines) {
                // Compile once here; a bad pattern is validated at load time, so
                // this is best-effort and simply skips the filter if it throws.
                try { ignoreRe = new RegExp(w.ignore_lines, 'm'); } catch { /* validated at load */ }
            }
            byKey.set(key, { key, section: w.section, cursor_above: w.cursor_above, ignoreRe, holdMs: typeof w.stable_ms === 'number' ? w.stable_ms : undefined });
        } else if (existing.holdMs === undefined && typeof w.stable_ms === 'number') {
            // Enrich the -1 whole-screen seed (or an earlier clause) with a threshold
            // so its verdict can be traced. Geometry/ignoreRe from the first set win.
            existing.holdMs = w.stable_ms;
        }
        return;
    }
    if ('all' in w) { for (const c of w.all) collectStableDescriptors(c, byKey); return; }
    if ('any' in w) { for (const c of w.any) collectStableDescriptors(c, byKey); return; }
    if ('not' in w) { collectStableDescriptors(w.not, byKey); return; }
}

/** Lines of section `id` on the given frame, or [] if that section is absent
 *  this frame. Used to compute per-frame change of a section-scoped stable
 *  region. */
function sliceSectionLines(lines: string[], sections: ResolvedSection[], id: string): string[] {
    const sec = sections.find(s => s.id === id);
    if (!sec) return [];
    return lines.slice(sec.fromLine, sec.toLine);
}

/** Drop lines matching `ignoreRe` so a per-frame repaint confined to them does
 *  not register as a region change. No filter → lines returned unchanged.
 *  Exported for unit tests of the stable_ms `ignore_lines` change-detection. */
export function filterIgnoredLines(lines: string[], ignoreRe: RegExp | undefined): string[] {
    if (!ignoreRe) return lines;
    return lines.filter(l => !ignoreRe.test(l));
}

/** Compute the [start, end) line window a cursor_above stable region measures,
 *  reconciling the backend's raw cursor row with the blank-trimmed viewport
 *  line array (see the CODEX-FSM-DEGENERATE-STABLE note in trackRegionChanges).
 *  The window end is clamped to the content length so an overshooting cursor
 *  row measures the content tail instead of slicing past the array into a
 *  permanently-empty — and therefore permanently "unchanged" — window.
 *  Returns null when no measurable window exists (cursor at/above row 0, or no
 *  content): the caller must treat the region as CHANGED, never stable.
 *  Exported for unit tests. */
export function stableCursorWindow(lineCount: number, cursorRow: number, cursorAbove: number): { start: number; end: number } | null {
    const end = Math.min(Math.max(0, cursorRow), Math.max(0, lineCount));
    const start = Math.max(0, end - cursorAbove);
    if (end <= start) return null;
    return { start, end };
}
