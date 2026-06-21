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
import { TerminalAdapter, type TerminalAdapterOpts } from './adapter.js';
import { resolveCliSpawnPlanFromParts } from '../../cli-adapters/provider-cli-runtime.js';
import type { PtyTransportFactory } from '../../cli-adapters/pty-transport.js';
import { DEFAULT_SESSION_HOST_COLS, DEFAULT_SESSION_HOST_ROWS } from '@adhdev/session-host-core';
import {
    resolveSections, sectionText, extractTitle, extractButtonsFromRule,
    type ResolvedSection, type TraceEntry,
} from './evaluator.js';
import { evaluateFsm, type FsmClock, type TransitionEval, type FsmEvaluation } from './fsm-evaluator.js';
import {
    type CliSpecV4, type FsmState, type FsmTransition,
    initialState, stateById, statusForState, outgoingTransitions,
} from './fsm-types.js';
import { loadFsmSpec } from './fsm-loader.js';
import { applyPreLaunchTrust } from './pre-launch-trust.js';
import type { Control, DelegateTrigger } from './types.js';
import { LOG } from '../../logging/logger.js';

// ── Shared driver types (formerly in driver.ts) ───────────────────────────

export type DashboardEvent =
    | { kind: 'pty_data'; chunk: string }
    | { kind: 'state_changed'; state: { id: string; label: string; title: string | null; status: 'idle' | 'generating' | 'approval' };
        modal: { title: string | null; buttons: { index: number; label: string }[] } | null;
        controls: { id: string; label: string; action_type: string }[] }
    | { kind: 'notification'; id: string; title: string; body: string }
    | { kind: 'delegate'; id: string; task: string }
    | { kind: 'spec_trace'; entries: TraceEntry[] }
    | { kind: 'exit'; exit_code: number }
    | { kind: 'spec_error'; errors: string[] };

export type DashboardCommand =
    | { kind: 'send_message'; text: string }
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
    snapshot(): string;
    getCursorPosition(): { row: number; col: number };
    getScreen(): string;
    getSpecPath(): string;
    shutdown(): void;
    getStateHistory(): ReadonlyArray<DriverHistoryEntry>;
    getSections(): Array<{ id: string; text: string }> | null;
    getLastBusyAt(): number;
    hasIdleHoldPending(): boolean;
    getCompletionIdleDebounceState(): { active: boolean; ageMs: number; holdMs: number; forceAfterMs: number } | null;
    getFsmDebug?(): unknown;
    getFsmSnapshotHistory?(): ReadonlyArray<FsmSnapshotEntry>;
}

export interface SpecDriverOpts {
    specPath: string;
    workingDir: string;
    extraEnv?: Record<string, string>;
    cols?: number;
    rows?: number;
    hotReload?: boolean;
    emitTrace?: boolean;
    transportFactory?: PtyTransportFactory;
    extraCliArgs?: string[];
}

function countNewlines(s: string): number {
    let n = 0;
    for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) === 10) n += 1;
    return n;
}

const SUBMIT_DELAY_FLOOR_MS = 200;

// win32 ConPTY submit reliability: after the text settles we write the submit
// key (CR) as its OWN keystroke, then repeat it once after a short gap. The
// repeat is the safety net for the case where ConPTY drops/coalesces the first
// lone CR; on an already-submitted prompt the second CR lands on an empty input
// and is a harmless no-op. The gap must be long enough that the TUI has redrawn
// after the first CR before the second arrives.
const WIN32_SUBMIT_REPEAT_GAP_MS = 300;

export function resolveSubmitDelayMs(specBeforeSubmit: number | undefined, text: string): number {
    const lines = countNewlines(text);
    const linesBonus = Math.min(800, lines * 80);
    const spec = typeof specBeforeSubmit === 'number' && specBeforeSubmit > 0 ? specBeforeSubmit : 0;
    return Math.max(spec, SUBMIT_DELAY_FLOOR_MS + linesBonus);
}

export function guessExt(mime: string): string {
    if (/png/i.test(mime)) return '.png';
    if (/jpe?g/i.test(mime)) return '.jpg';
    if (/gif/i.test(mime)) return '.gif';
    if (/webp/i.test(mime)) return '.webp';
    return '.bin';
}

// ─────────────────────────────────────────────────────────────────────────────

interface ModalSnapshot {
    title: string | null;
    buttons: { index: number; label: string; key: string }[];
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
    /** Per cursor_above region (key: cursor_above, -1 = whole screen) → last
     *  time that region's content changed. Drives stable_ms conditions. */
    private regionLastChangedAt = new Map<number, number>();
    /** Timer that re-runs evaluate() when a time-condition would flip true
     *  with no PTY frame to trigger it. */
    private wakeTimer: ReturnType<typeof setTimeout> | null = null;
    /** Timer driving the focus-gated stall watchdog (refocus_when_stalled_ms).
     *  Re-arms itself while the machine is generating so a re-prime can fire
     *  even when the PTY has gone completely quiet. */
    private stallTimer: ReturnType<typeof setTimeout> | null = null;
    /** Wall-clock time the last stall re-prime was injected. The cooldown gate:
     *  after a re-prime we don't re-inject until the screen changes (which
     *  resets the stall reference) or another full stall window lapses. */
    private lastRefocusAt = 0;

    private currentEval: CurrentEval | null = null;
    private stateHistory: HistoryEntry[] = [];
    private prevStateAt = 0;

    // ── send_message queueing until the machine first reaches a non-initial,
    //    non-busy ("ready") state — same contract as v3's idleSeenOnce.
    private readySeenOnce = false;
    private pendingSends: string[] = [];

    private pickerInProgress: { control_id: string; spec: Control } | null = null;
    private delegateTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private specWatcher: fs.FSWatcher | null = null;
    /** Last full FSM evaluation, kept for the debugger. */
    private lastFsmEval: ReturnType<typeof evaluateFsm> | null = null;
    /** Ring buffer (max 20) of the full FSM evaluation captured at each
     *  transition — the rich pre-transition table that lastFsmEval only keeps
     *  for the single most recent evaluation. Separate from stateHistory. */
    private fsmSnapshotHistory: FsmSnapshotEntry[] = [];

    constructor(private readonly opts: SpecDriverOpts) {
        this.loadSpecOrThrow();
        this.adapter = new TerminalAdapter(
            this.buildAdapterOpts(),
            {
                init: () => this.emitInitialState(),
                on_pty_data: (chunk) => this.emit({ kind: 'pty_data', chunk }),
                on_screen_changed: () => this.reevaluate(),
                on_exit: ({ exitCode }) => this.handleExit(exitCode),
            },
        );
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
            applyPreLaunchTrust(this.spec.pre_launch_trust, this.opts.workingDir);
        }
        this.adapter.start();
        // Prime focus-gated TUIs (see CliSpecV4.send_on_spawn). Written once,
        // shortly after spawn, so the input stream is awake before the first
        // delegated message — without this, a focus-event CLI like antigravity
        // drops the first programmatic write until a manual keystroke.
        this.scheduleSpawnPrime();
        // The initial state may have a purely time-based exit (elapsed_ms);
        // schedule a wake so we leave it even if the PTY goes quiet.
        this.scheduleWakeForState();
    }

    private scheduleSpawnPrime(): void {
        const seqs = this.spec.send_on_spawn;
        if (!Array.isArray(seqs) || seqs.length === 0) return;
        const delay = Math.max(0, this.spec.send_on_spawn_delay_ms ?? 250);
        setTimeout(() => this.sendSpawnPrime(), delay);
    }

    /** Write the declared `send_on_spawn` sequences to the PTY once. Used both
     *  at spawn (scheduleSpawnPrime) and, for focus-gated TUIs, by the stall
     *  watchdog to re-inject the focus-in wake mid-turn. No-op when the spec
     *  declares no prime, so non-focus-gated CLIs are never poked. */
    private sendSpawnPrime(): void {
        const seqs = this.spec.send_on_spawn;
        if (!Array.isArray(seqs) || seqs.length === 0) return;
        for (const seq of seqs) {
            if (typeof seq === 'string' && seq.length > 0) this.adapter.send_keys(seq);
        }
    }

    dispatch(cmd: DashboardCommand): void {
        switch (cmd.kind) {
            case 'send_message': this.handleSendMessage(cmd.text); return;
            case 'pty_write': this.adapter.send_keys(cmd.data); return;
            case 'click_control': this.handleClickControl(cmd.control_id, cmd.payload); return;
            case 'click_modal_button': this.handleClickModalButton(cmd.index); return;
            case 'attach_image': this.handleAttachImage(cmd.blob, cmd.mime); return;
            case 'resize': this.adapter.resize(cmd.cols, cmd.rows); return;
            case 'cancel': this.adapter.send_keys('\x03'); return;
            case 'shutdown': this.shutdown(); return;
        }
    }

    snapshot(): string { return this.adapter.snapshot(); }
    getCursorPosition(): { row: number; col: number } { return this.adapter.getCursorPosition(); }
    getScreen(): string { return this.adapter.snapshot(); }

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
    getSections(): Array<{ id: string; text: string }> | null {
        try {
            const screen = this.adapter.snapshot();
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
    }

    private buildAdapterOpts(): TerminalAdapterOpts {
        // Single-source spawn resolution: route the spec's binary/args/env
        // through the SAME planner the legacy ProviderCliAdapter uses
        // (resolveCliSpawnPlanFromParts). This gives the spec/FSM path
        // findBinary (PATH + npm-global / Node-dir fallback so an off-PATH
        // `codex`/`claude` resolves), `{{workingDir}}` token substitution, shell
        // wrapping for script-shims / non-absolute / non-native binaries, and a
        // sanitized env with TERMINAL_CWD — none of which it had when it passed
        // `this.spec.binary` straight to the PTY.
        const cols = this.opts.cols ?? DEFAULT_SESSION_HOST_COLS;
        const rows = this.opts.rows ?? DEFAULT_SESSION_HOST_ROWS;
        const plan = resolveCliSpawnPlanFromParts({
            command: this.spec.binary,
            baseArgs: this.spec.spawn_args ?? [],
            baseEnv: this.spec.env ?? {},
            workingDir: this.opts.workingDir,
            extraArgs: this.opts.extraCliArgs ?? [],
            extraEnv: this.opts.extraEnv ?? {},
            geometry: { cols, rows },
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
        return evaluateFsm(this.spec, this.currentStateId, screen, cursor, prev, this.buildClock(now));
    }

    private reevaluate(forceEmit = false): void {
        const now = Date.now();
        const screen = this.adapter.snapshot();
        const cursor = this.adapter.getCursorPosition();
        const currentLines = screen.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);

        // Track per-region change timestamps for stable_ms conditions BEFORE
        // we overwrite prevScreenLines.
        this.trackRegionChanges(currentLines, cursor, now);

        const ev = this.evalFsmNow(screen, cursor, now);
        this.lastFsmEval = ev;
        this.prevScreenLines = currentLines;

        if (ev.fired) {
            this.commitTransition(ev.fired, now, ev);
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
            // branches is safe.
            this.maybeMarkReady();
            return;
        }

        // No transition — refresh modal/controls (content inside the same
        // state can still change, e.g. modal title/buttons) and emit if changed.
        this.emitStateChanged(forceEmit);
        // Schedule a wake for the soonest pending time-condition.
        this.scheduleWakeForState();
        this.scheduleStallWatchdog();
        // Drain queued sends once we first reach a "ready" state.
        this.maybeMarkReady();
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
                modal: next.modal ? { title: next.modal.title, buttons: next.modal.buttons.map(b => ({ index: b.index, label: b.label })) } : null,
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
        const buttons = extractButtonsFromRule(rule, hay);
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

    /** Track which cursor_above regions changed since the previous frame so
     *  stable_ms conditions can measure quiet time. We record every region
     *  size referenced by a stable_ms condition in the spec, plus the whole
     *  screen (-1). */
    private trackRegionChanges(currentLines: string[], cursor: { row: number; col: number }, now: number): void {
        if (this.prevScreenLines.length === 0) return;
        const sizes = this.stableRegionSizes();
        for (const size of sizes) {
            let cur: string; let prev: string;
            if (size < 0) {
                cur = currentLines.join('\n');
                prev = this.prevScreenLines.join('\n');
            } else {
                const start = Math.max(0, cursor.row - size);
                cur = currentLines.slice(start, cursor.row).join('\n');
                prev = this.prevScreenLines.slice(start, cursor.row).join('\n');
            }
            if (cur !== prev) this.regionLastChangedAt.set(size, now);
        }
    }

    /** All cursor_above region sizes referenced by stable_ms conditions in the
     *  current state's outgoing transitions, plus whole-screen. Cached lazily
     *  per spec load would be nicer but the set is tiny. */
    private stableRegionSizes(): Set<number> {
        const sizes = new Set<number>([-1]);
        for (const t of outgoingTransitions(this.spec, this.currentStateId)) {
            collectStableSizes(t.when, sizes);
        }
        return sizes;
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
            LOG.info('FsmDriver', `[${this.specTag()}] stall detected (${stalledFor}ms quiet, generating) — re-injecting focus-in`);
            this.sendSpawnPrime();
            this.lastRefocusAt = now;
        }
        // Keep watching: the re-prime may not flush instantly, and a still-quiet
        // screen needs the next window to come around.
        this.scheduleStallWatchdog();
    }

    private maybeMarkReady(): void {
        if (this.readySeenOnce) return;
        const st = stateById(this.spec, this.currentStateId);
        if (!st) return;
        // "Ready" = a non-initial state whose status is idle (the prompt is up).
        if (!st.initial && statusForState(st) === 'idle') {
            this.readySeenOnce = true;
            const queued = this.pendingSends.splice(0);
            for (const text of queued) setTimeout(() => this.actuallySendMessage(text), 50);
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

    private handleSendMessage(text: string): void {
        if (!this.readySeenOnce) { this.pendingSends.push(text); return; }
        this.actuallySendMessage(text);
    }

    private actuallySendMessage(text: string): void {
        const sm = this.spec.send_message;
        const perChar = sm.delay_ms_per_char ?? 0;
        const beforeSubmit = resolveSubmitDelayMs(sm.delay_ms_before_submit, text);

        // win32 ConPTY submit: the text and the submit key (CR) must NOT be
        // combined into one PTY write. Ink-based TUIs (claude-cli) treat a single
        // write that carries text + a trailing CR as a bracketed/multi-line paste
        // and absorb the CR as a literal newline in the input box instead of a
        // submit keystroke — the prompt sits typed-but-unsent until the user hits
        // Enter manually. (A previous "atomic write" attempt regressed exactly
        // this way.) Instead, write the text, let it settle so the TUI leaves any
        // paste-accumulation state, then deliver the CR as its OWN keystroke. We
        // send the CR twice with a short gap: ConPTY can drop/coalesce the first
        // lone CR, and a second CR on an already-submitted (now empty) prompt is a
        // harmless no-op. perChar typing simulation is skipped on win32;
        // correctness of submission wins over the typing visual there.
        if (process.platform === 'win32') {
            const submitTwice = (): void => {
                this.adapter.send_keys(sm.submit_key);
                setTimeout(() => this.adapter.send_keys(sm.submit_key), WIN32_SUBMIT_REPEAT_GAP_MS);
            };
            this.adapter.send_keys(text);
            if (beforeSubmit > 0) setTimeout(submitTwice, beforeSubmit);
            else submitTwice();
            return;
        }

        if (perChar === 0) {
            this.adapter.send_keys(text);
            if (beforeSubmit > 0) setTimeout(() => this.adapter.send_keys(sm.submit_key), beforeSubmit);
            else this.adapter.send_keys(sm.submit_key);
            return;
        }
        let i = 0;
        const iv = setInterval(() => {
            if (i >= text.length) {
                clearInterval(iv);
                setTimeout(() => this.adapter.send_keys(sm.submit_key), beforeSubmit);
                return;
            }
            this.adapter.send_keys(text[i]);
            i += 1;
        }, perChar);
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

    private handleClickModalButton(index: number): void {
        const m = this.currentEval?.modal;
        if (!m) return;
        const btn = m.buttons.find(b => b.index === index);
        if (!btn) return;
        this.adapter.send_keys(btn.key);
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

    private handleExit(exitCode: number): void {
        this.emit({ kind: 'exit', exit_code: exitCode });
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

    private specTag(): string {
        return this.opts.specPath.split('/').slice(-3).join('/');
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
    out.push(`${'  '.repeat(depth)}${c.kind} ${c.detail} = ${c.result}${c.remainingMs ? ` (${c.remainingMs}ms left)` : ''}`);
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

function collectStableSizes(when: FsmTransition['when'], sizes: Set<number>): void {
    if (!when) return;
    const w = when as any;
    if ('stable_ms' in w) { sizes.add(w.cursor_above && w.cursor_above > 0 ? w.cursor_above : -1); return; }
    if ('all' in w) { for (const c of w.all) collectStableSizes(c, sizes); return; }
    if ('any' in w) { for (const c of w.any) collectStableSizes(c, sizes); return; }
    if ('not' in w) { collectStableSizes(w.not, sizes); return; }
}
