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
import { TerminalAdapter, type SpecPtyEvent } from './adapter.js';
import type { PtyRuntimeExitInfo } from '../../cli-adapters/pty-transport.js';
import { resolveSections, sectionText, type ResolvedSection } from './evaluator.js';
import { evaluateFsm, type FsmClock, type TransitionEval, type FsmEvaluation } from './fsm-evaluator.js';
import type { SignalSnapshot } from './signal-envelope.js';
import {
    compileSignalRules, evaluateSignalRules, SignalEmissionGate,
    type CompiledSignalRule,
} from './signal-rules.js';
import {
    type CliSpecV4, type FsmStatus,
    initialState, stateById, statusForState, modalKindForState, outgoingTransitions,
} from './fsm-types.js';
import { loadFsmSpec, reportFsmSpecWarnings } from './fsm-loader.js';
import { SendSubmitEngine, type ClaimedQueuedSend } from './send-submit-engine.js';
import { RedrawNudger } from './redraw-nudge.js';
import {
    createStartupDismissState, decideStartupDismiss, normalizeStartupDismissConfig, recordStartupDismiss,
    type StartupDismissConfig, type StartupDismissState,
} from '../../cli-adapters/startup-dismiss.js';
import type { Control, DelegateTrigger } from './types.js';
import { LOG } from '../../logging/logger.js';
import type {
    CurrentEval, DashboardCommand, DashboardEvent, DriverHistoryEntry, FsmSnapshotEntry,
    ISpecDriver, SpecDriverOpts, VisibleControl,
} from './fsm-driver-types.js';
import { applySpecPreLaunchTrust, buildSpecAdapterOpts } from './fsm-driver-launch.js';
import {
    buildGuardFrame, findStable, sameControls, sameModal, summarizeTransition, trackRegionChanges,
} from './fsm-driver-frame.js';
import { deriveModal, deriveTitle, pressModalButton } from './fsm-driver-modal.js';
import { FocusPrimer } from './fsm-focus-primer.js';


// ── send_message serialization (SEND-OVERLAP) ────────────────────────────────
//
// The queue/latch/duplicate-gate machinery this driver used to own now lives in
// ./send-submit-engine.ts, together with the live-defect narrative that explains
// why it exists. This file keeps only `currentStatus()`, which that engine gates
// on but must never compute for itself.

/** FSMLOG-SESSION-ATTRIBUTION (D3): fallback log-tag sequence for drivers constructed without a
 *  session id. Process-local and monotonic — enough to group one driver's lines together. */
let fsmDriverSeq = 0;

// Submit policy lives in ./submit-policy.ts and its stateful consumers in
// ./send-submit-engine.ts. What this file still imports for its OWN use is
// the win32 modal-confirm resend cadence (an approval CR, not a send_message
// submit — see scheduleWin32ModalConfirm) and guessExt for attach_image.
import {
    guessExt,
    WIN32_SUBMIT_RESEND_GAP_MS,
    WIN32_SUBMIT_MAX_RESENDS,
} from './submit-policy.js';
import type { QueuedWriteOutcome, SendDisposition } from './submit-policy.js';


export class FsmDriver implements ISpecDriver {
    private spec!: CliSpecV4;
    private adapter: TerminalAdapter;
    private listeners = new Set<(ev: DashboardEvent) => void>();

    // ── Spec-declared signal rules (signal-rules.ts). Compiled once per spec
    //    load; the gate collapses a banner that repaints every frame into one
    //    emission per cooldown window. Empty for every spec that declares none,
    //    which is the no-op default.
    private signalRules: CompiledSignalRule[] = [];
    private readonly signalGate = new SignalEmissionGate();

    // ── The entire FSM state: which node we're in, and when we entered it.
    private currentStateId = '';
    private stateEnteredAt = 0;

    // ── Clock bookkeeping for time conditions.
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
    /** APPROVE-LATCH-STALE: how many times reevaluate() has run. The single
     *  observable that distinguishes "the latch is fresh" from "the latch is
     *  whatever the entry frame parsed" — a stale latch is invisible in every
     *  other debug field, because getFsmDebug() re-derives its verdict live and
     *  so always LOOKS current even when the adapter's latch is minutes old.
     *  That blind spot is why this defect reached production. Read-only. */
    private evalCount = 0;
    /** Boot-prompt dismissal (CliSpecV4.startup_dismiss — OPENCODE-UPDATE-MODAL
     *  class). Config normalized once at start(); the shared decision engine
     *  bounds writes by spawn window + attempt cap + per-snapshot dedupe. */
    private startupDismissConfig: StartupDismissConfig | null = null;
    private startupDismissState: StartupDismissState = createStartupDismissState();
    /** Wall clock at start() — the spawn anchor for the dismiss window. */
    private startupDismissSpawnAt = 0;
    /** Spawn prime + focus-gated stall watchdog (see fsm-focus-primer.ts). */
    private readonly focusPrimer: FocusPrimer;
    /** Wall-clock (ms) of the most recent raw PTY output chunk. Advances on every
     *  on_pty_data — including the echo of text written into the composer — so the
     *  win32 submit settle-gate can tell when input has finished landing. */
    private lastPtyDataAt = 0;
    /** Wall-clock (ms) of the most recent RENDERED screen change — set from the
     *  TerminalAdapter's coalesced on_screen_changed, which fires only when the
     *  rendered text actually differs from the previous snapshot. Stricter than
     *  lastPtyDataAt (keepalive / cursor-only bytes advance that one but not
     *  this). Session-global, unlike the per-state stable_ms bookkeeping in
     *  regionLastChangedAt, which is cleared on every transition. */
    private lastScreenChangedAt = 0;
    /** Timer driving the win32 verification-based modal-confirm CR resend loop (see
     *  scheduleWin32ModalConfirm). A lone CR that confirms an approval/picker choice
     *  is absorbed by ConPTY the same way a send_message submit CR is, so the confirm
     *  must be resent until the modal actually resolves (status leaves 'approval'). */
    private win32ModalConfirmTimer: ReturnType<typeof setTimeout> | null = null;

    private currentEval: CurrentEval | null = null;
    /** Dedup latch for warnModalParseMiss — see that method. */
    private lastModalParseMissKey: string | null = null;
    private stateHistory: DriverHistoryEntry[] = [];
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
    /** REDRAW-NUDGE: input-free false-busy recovery (see redraw-nudge.ts). */
    private readonly redrawNudge: RedrawNudger;

    constructor(private readonly opts: SpecDriverOpts) {
        // Object-literal getters below need a lexical handle on the driver; inside
        // a `get x()` the `this` is the literal, not the class.
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const self = this;
        const sessionId = typeof opts.sessionId === 'string' ? opts.sessionId.trim() : '';
        this.sessionTag = sessionId ? sessionId.slice(0, 8) : `d${++fsmDriverSeq}`;
        this.loadSpecOrThrow();
        this.adapter = new TerminalAdapter(
            buildSpecAdapterOpts(this.spec, this.opts),
            {
                init: () => this.emitInitialState(),
                on_pty_data: (chunk) => {
                    this.lastPtyDataAt = Date.now();
                    this.focusPrimer.onPtyOutput();
                    this.emit({ kind: 'pty_data', chunk });
                },
                on_screen_changed: () => {
                    this.lastScreenChangedAt = Date.now();
                    this.reevaluate();
                },
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
        this.redrawNudge = new RedrawNudger({
            isGenerating: () => this.currentStatus() === 'generating',
            quietSince: () => Math.max(this.lastPtyDataAt, this.stateEnteredAt),
            getSize: () => this.adapter.getScreenSize(),
            resize: (cols, rows) => this.adapter.resize(cols, rows),
            reevaluate: () => this.reevaluate(),
            tag: () => this.specTag(),
        });
        this.focusPrimer = new FocusPrimer({
            get spec() { return self.spec; },
            adapter: this.adapter,
            specTag: () => this.specTag(),
            currentStatus: () => this.currentStatus(),
            stallScreenReferenceAt: () => this.stallScreenReferenceAt(),
        });
        if (this.opts.hotReload !== false) this.armSpecWatcher();
    }

    subscribe(listener: (ev: DashboardEvent) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    start(): void {
        const now = Date.now();
        const init = initialState(this.spec);
        this.currentStateId = init.id;
        this.stateEnteredAt = now;
        this.prevStateAt = now;
        applySpecPreLaunchTrust(this.spec, this.opts, this.specTag());
        this.startupDismissConfig = normalizeStartupDismissConfig(this.spec.startup_dismiss);
        this.startupDismissState = createStartupDismissState();
        this.startupDismissSpawnAt = now;
        // Arm before adapter.start(): a transport may synchronously flush
        // buffered child output while registering onData during start().
        this.focusPrimer.armSpawnPrime();
        this.adapter.start();
        // The initial state may have a purely time-based exit (elapsed_ms);
        // schedule a wake so we leave it even if the PTY goes quiet.
        this.scheduleWakeForState();
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
    sendMessageWithDisposition(text: string, bracketedPaste?: boolean, messageId?: string): SendDisposition {
        return this.sends.handleSendMessage(text, bracketedPaste, messageId);
    }

    /** SEND-NOW-AGENT-QUEUE: see ISpecDriver.sendMessageDuringGeneration. */
    sendMessageDuringGeneration(text: string, bracketedPaste?: boolean): QueuedWriteOutcome {
        return this.sends.sendMessageDuringGeneration(text, bracketedPaste);
    }

    /** NOTIF-IMMEDIACY: see ISpecDriver.supportsMidGenerationQueue. */
    supportsMidGenerationQueue(): boolean {
        return this.spec?.send_message?.mid_generation_queue === true;
    }

    /** SEND-NOW-WRONG-ITEM: see ISpecDriver.reserveDrain. */
    reserveDrain(ttlMs: number): void {
        this.sends.reserveDrain(ttlMs);
    }

    /** SEND-NOW-WRONG-ITEM: see ISpecDriver.releaseDrain. */
    releaseDrain(): void {
        this.sends.releaseDrain();
    }

    /** D2 messageId-keyed FIFO access — see ISpecDriver.claimQueuedSend. */
    hasQueuedSend(messageId: string): boolean { return this.sends.hasQueuedSend(messageId); }
    queuedMessageIds(): string[] { return this.sends.queuedMessageIds(); }
    claimQueuedSend(messageId: string): ClaimedQueuedSend | null { return this.sends.claimQueuedSend(messageId); }
    restoreQueuedSend(claimed: ClaimedQueuedSend): void { this.sends.restoreQueuedSend(claimed); }

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
        this.redrawNudge.dispose();
        this.focusPrimer.dispose();
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
        /** @see evalCount — total reevaluate() runs for this driver. */
        evalCount: number;
    } {
        const now = Date.now();
        const viewportCursor = this.adapter.getCursorPosition();
        // APPROVAL-WAIT-BLINDSPOT fix ③: the debugger must evaluate the SAME
        // frame reevaluate() does. Reading the bare viewport here while the real
        // evaluation reads the guard frame would make getFsmDebug report a
        // verdict the engine never computed — which is precisely how the 4-minute
        // late `waiting_approval` stayed un-diagnosed: the debug surface agreed
        // with the (wrong) viewport-only reading and nothing contradicted it.
        const guard = this.guardFrame(this.adapter.snapshot(), viewportCursor);
        const ev = this.evalFsmNow(guard.screen, guard.cursor, now);
        const state = stateById(this.spec, this.currentStateId);
        return {
            currentState: this.currentStateId,
            label: state?.label ?? this.currentStateId,
            stateAgeMs: now - this.stateEnteredAt,
            status: state ? statusForState(state) : 'idle',
            // Report the VIEWPORT cursor — this field is a human-facing "where is
            // the caret on screen" readout, and the guard-frame rebase is an
            // internal coordinate shift that would read as a bogus row number.
            cursor: viewportCursor,
            transitions: ev.transitions,
            evalCount: this.evalCount,
        };
    }

    getStateHistory(): ReadonlyArray<DriverHistoryEntry> { return this.stateHistory; }
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
            // APPROVAL-WAIT-BLINDSPOT fix ③: when the caller supplies no screen,
            // resolve against the same guard frame the transitions use, so a
            // section whose anchor sits just above the viewport reports the text
            // the guards actually matched rather than an empty string. When the
            // caller DOES supply a screen the contract above still wins — slice
            // exactly what they handed us and nothing else.
            if (screenText === undefined) {
                const guard = this.guardFrame(this.adapter.snapshot(), this.adapter.getCursorPosition());
                return resolveSections(this.spec.sections ?? {}, guard.lines).map(s => ({ id: s.id, text: s.text }));
            }
            const lines = screenText.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
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
    /** @see ISpecDriver.getLastOutputAt — raw PTY chunk clock, 0 until first output. */
    getLastOutputAt(): number {
        return this.lastPtyDataAt;
    }
    /** @see ISpecDriver.getLastScreenChangeAt — rendered screen-change clock, 0 until first change. */
    getLastScreenChangeAt(): number {
        return this.lastScreenChangedAt;
    }
    /** @see ISpecDriver.getRedrawNudgeCount */
    getRedrawNudgeCount(): number { return this.redrawNudge.getTotalNudges(); }
    getCompletionIdleDebounceState(): { active: boolean; ageMs: number; holdMs: number; forceAfterMs: number } | null {
        // Surface the busy→ready transition's stable countdown, if any, so the
        // existing panel field stays meaningful.
        const out = outgoingTransitions(this.spec, this.currentStateId);
        const toReady = this.lastFsmEval?.transitions.find((_t, i) => {
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
        this.compileSignalRules();
        reportFsmSpecWarnings(res.warnings, this.specTag(), LOG.warn.bind(LOG));
    }

    /** Compile the spec's declared signal_rules once per spec load (never per
     *  frame) and reset the emission gate, so a hot-reloaded rule set starts
     *  from a clean cooldown state rather than inheriting the old rules' clocks. */
    private compileSignalRules(): void {
        this.signalRules = compileSignalRules(
            (this.spec as { signal_rules?: unknown }).signal_rules,
            this.specTag(),
        );
        this.signalGate.reset();
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
                this.compileSignalRules();
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

    /** APPROVAL-WAIT-BLINDSPOT fix ③: the frame transition guards evaluate —
     *  see buildGuardFrame (fsm-driver-frame.ts). */
    private guardFrame(viewportScreen: string, cursor: { row: number; col: number }) {
        return buildGuardFrame(viewportScreen, cursor, () => this.scrollbackLines());
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
        this.evalCount += 1;
        const now = Date.now();
        const screen = this.adapter.snapshot();
        this.maybeDismissStartupPrompt(screen, now);
        const viewportCursor = this.adapter.getCursorPosition();
        // APPROVAL-WAIT-BLINDSPOT fix ③: guards evaluate against the same
        // scrollback-inclusive class of buffer the modal extraction already
        // used, with the cursor rebased so cursor_above/changed windows land on
        // identical content. See buildGuardFrame for why both the frame AND the
        // cursor have to move together, and why the height is fixed.
        const guard = this.guardFrame(screen, viewportCursor);
        const currentLines = guard.lines;
        const cursor = guard.cursor;

        // Track per-region change timestamps for stable_ms conditions BEFORE
        // we overwrite prevScreenLines. Uses the guard frame + rebased cursor so
        // it stays on the same coordinate system as the conditions that read it.
        trackRegionChanges({
            spec: this.spec,
            stateId: this.currentStateId,
            stateEnteredAt: this.stateEnteredAt,
            prevLines: this.prevScreenLines,
            regionLastChangedAt: this.regionLastChangedAt,
            stableVerdictCache: this.stableVerdictCache,
        }, currentLines, cursor, now);

        const ev = this.evalFsmNow(guard.screen, cursor, now);
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
            this.focusPrimer.scheduleStallWatchdog();
            this.redrawNudge.schedule();
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
        this.focusPrimer.scheduleStallWatchdog();
        this.redrawNudge.schedule();
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
        // A new state gets a fresh modal-parse-miss verdict: leaving and
        // re-entering an unparseable modal should report again.
        this.lastModalParseMissKey = null;
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
        const statusOf = (id: string) => { const st = stateById(this.spec, id); return st ? statusForState(st) : 'idle'; };
        this.redrawNudge.onTransition(statusOf(from), statusOf(fired.to), fired.label);
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

        const modal = deriveModal(state, modalSections, modalFullScreen, (id, reason) => this.warnModalParseMiss(id, reason));
        const controls = this.deriveControls(state.id);
        const title = modal?.title ?? deriveTitle(state, modalSections, modalFullScreen);

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

        // Signal rules are evaluated on EVERY frame, not only when the FSM state
        // changed: a usage-limit banner can appear while the machine sits in one
        // state the whole time, so gating this on `changed` below would miss the
        // very case the feature exists for. Re-emission is controlled by the
        // rule's own cooldown/fingerprint gate instead.
        this.evaluateSignalRulesForFrame(sections, screen);

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

    /**
     * Emit a modal-parse-miss warning at most once per (state, reason) pair.
     *
     * emitStateChanged runs on EVERY frame, so an unparseable modal would
     * otherwise log on every repaint for as long as the session sits on it. The
     * latch resets whenever the reason changes or the FSM leaves the state, so a
     * second visit to a genuinely still-broken screen reports again.
     */
    private warnModalParseMiss(stateId: string, reason: string): void {
        const key = `${stateId}${reason}`;
        if (this.lastModalParseMissKey === key) return;
        this.lastModalParseMissKey = key;
        LOG.warn('FsmDriver', `[${this.spec.id}] modal not parseable — ${reason}. mesh_approve cannot act on this screen; mesh_send_keys is allowed through as the escape hatch (see SpecCliAdapter.injectKeys).`);
    }

    private deriveControls(stateId: string): VisibleControl[] {
        const out: VisibleControl[] = [];
        for (const c of this.spec.control_bar ?? []) {
            if (c.visible_when_state && !c.visible_when_state.includes(stateId)) continue;
            out.push({ id: c.id, label: c.label, actionType: c.action.type });
        }
        return out;
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
        // APPROVE-LATCH-STALE fix ② (defence in depth): an approval state whose
        // exits are pure CONTENT guards contributes nothing finite above, so the
        // loop leaves `soonest = Infinity` and NO timer is armed — the latched
        // modal then freezes until the next PTY frame, which on a focus-event TUI
        // (antigravity's `agy`, quiet at a drawn modal) may never come. Fix ① in
        // handleResolveAction recovers the approve path on demand; this floor keeps
        // every OTHER reader (mesh_status, the dashboard, the auto-approve gate)
        // from looking at a minutes-old modal too.
        //
        // Scoped to approval-class states only, and only as a FLOOR: a state with
        // a genuine sooner deadline keeps it. Cost is negligible relative to what
        // the engine already does — a full reevaluate() runs on every PTY frame
        // during `generating` (many per second, same bounded 200-line guard
        // window), so ~0.5/sec while a session sits at a modal is far below the
        // load already accepted. 2s rather than 1s because nothing here needs
        // sub-second latency: the reader is a human or a coordinator round-trip,
        // and 2s halves the idle wakeups for the same practical freshness.
        const st = stateById(this.spec, this.currentStateId);
        if (st && statusForState(st) === 'approval') {
            soonest = Math.min(soonest, FsmDriver.APPROVAL_LATCH_REFRESH_FLOOR_MS);
        }
        if (!Number.isFinite(soonest)) return;
        this.wakeTimer = setTimeout(() => { this.wakeTimer = null; this.reevaluate(); }, Math.max(soonest + 30, 50));
    }

    /** @see scheduleWakeForState — floor poll interval while parked at a modal. */
    private static readonly APPROVAL_LATCH_REFRESH_FLOOR_MS = 2000;

    /** Wall-clock time the screen last changed IN THE CURRENT STATE, falling
     *  back to state entry when it has not changed since (i.e. fully stalled
     *  from the start of the state). State-relative on purpose — the stall
     *  window is measured from state entry. Not the session-global clock the
     *  adapter status surfaces; that is getLastScreenChangeAt(). */
    private stallScreenReferenceAt(): number {
        return this.regionLastChangedAt.get(-1) ?? this.stateEnteredAt;
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

    /**
     * Evaluate the spec's signal rules against the current frame and emit one
     * `signal_detected` per rule that matched AND passed its emission gate.
     *
     * Wrapped in try/catch and fully no-op when the spec declares no rules:
     * this runs on the status-evaluation hot path, so a malformed rule must
     * never be able to break status detection. Detection is advisory — losing a
     * signal is strictly preferable to wedging the FSM.
     */
    private evaluateSignalRulesForFrame(sections: ResolvedSection[], fullScreen: string): void {
        if (this.signalRules.length === 0) return;
        try {
            const detections = evaluateSignalRules(
                this.signalRules,
                fullScreen,
                (id) => sectionText(sections, id, fullScreen) || null,
                this.signalGate,
                Date.now(),
            );
            for (const signal of detections) {
                // info-level keeps rule id + kind + param NAMES only. The captured
                // VALUES are provider-authored text, so they stay at debug — the
                // same split state.title already uses.
                LOG.info(
                    'FsmDriver',
                    `[${this.specTag()}] signal ${signal.ruleId} (${signal.kind}) matched; params=[${Object.keys(signal.params).join(',')}]`,
                );
                LOG.debug('FsmDriver', `[${this.specTag()}] signal ${signal.ruleId} params=${JSON.stringify(signal.params)}`);
                this.emit({ kind: 'signal_detected', signal });
            }
        } catch (e: any) {
            LOG.warn('FsmDriver', `[${this.specTag()}] signal rule evaluation failed: ${e?.message || e}`);
        }
    }

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

    /** APPROVE-LATCH-STALE — see ISpecDriver.refreshNow for the full rationale.
     *  forceEmit so a re-parse that yields the SAME CurrentEval still re-emits:
     *  the adapter's latch is refreshed via the state_changed listener, and a
     *  `changed`-gated emit would skip exactly the null→null case we need to
     *  distinguish from null→buttons. */
    refreshNow(): void {
        this.reevaluate(true);
    }

    /** The agent's current coarse status, derived from the FSM node we're in. */
    private currentStatus(): FsmStatus {
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
        return pressModalButton({
            modal: this.currentEval?.modal,
            state: stateById(this.spec, this.currentStateId),
            specId: this.spec.id,
            readScrollbackLines: () => this.scrollbackLines(),
            sendKeys: (keys) => this.adapter.send_keys(keys),
            submitConfirm: (keys) => this.submitModalConfirm(keys),
        }, index);
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
