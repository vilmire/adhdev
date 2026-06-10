/**
 * SpecDriver — the single fixed script that turns a CliSpec + a
 * TerminalAdapter into the dashboard-facing wire protocol.
 *
 * Wire (dashboard ↔ daemon):
 *
 *   dashboard → daemon:
 *     { kind: 'send_message',       text }
 *     { kind: 'click_control',      control_id, payload? }
 *     { kind: 'click_modal_button', index }
 *     { kind: 'attach_image',       blob, mime }
 *     { kind: 'resize',             cols, rows }
 *     { kind: 'cancel' }
 *     { kind: 'shutdown' }
 *
 *   daemon → dashboard:
 *     { kind: 'pty_data',           chunk }
 *     { kind: 'state_changed',
 *           state: { id, label, title },
 *           modal: null | { title, buttons: [{ index, label }] },
 *           controls: [{ id, label, action_type }] }
 *     { kind: 'notification',       id, title, body }
 *     { kind: 'delegate',           id, task }
 *     { kind: 'spec_trace',         entries: [...] }
 *     { kind: 'exit',               exit_code }
 *
 * Hot reload: spec.json is watched. A reload re-evaluates and emits a
 * fresh state_changed; no PTY restart is required.
 *
 * Delegate timers: after_duration_ms is enforced here (the evaluator
 * is stateless). A timer is armed when a delegate's when_state is
 * entered and cancelled when it changes.
 */
'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TerminalAdapter, type TerminalAdapterOpts } from './adapter.js';
import type { PtyTransportFactory } from '../../cli-adapters/pty-transport.js';
import { DEFAULT_SESSION_HOST_COLS, DEFAULT_SESSION_HOST_ROWS } from '@adhdev/session-host-core';
import { evaluate, type SpecEvaluation, type TraceEntry } from './evaluator.js';
import { loadSpec } from './loader.js';
import type { CliSpec, Control, DelegateTrigger, SectionDef } from './types.js';
import { LOG } from '../../logging/logger.js';

export type DashboardEvent =
    | { kind: 'pty_data'; chunk: string }
    | { kind: 'state_changed'; state: { id: string; label: string; title: string | null };
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

export interface SpecDriverOpts {
    specPath: string;
    workingDir: string;
    extraEnv?: Record<string, string>;
    cols?: number;
    rows?: number;
    /** Set false to skip the spec.json fs.watch. */
    hotReload?: boolean;
    /** Set true to forward trace entries on every state_changed. */
    emitTrace?: boolean;
    /** Inject the daemon's PTY transport (typically SessionHostPtyTransportFactory). */
    transportFactory?: PtyTransportFactory;
    /**
     * Extra CLI args appended to spec.spawn_args. Used by the daemon to
     * pass per-launch arguments like `--session-id <uuid>` so the agent
     * uses the daemon's providerSessionId instead of generating its own.
     */
    extraCliArgs?: string[];
}

/** How long after start() to ignore "idle" readings before treating one
 *  as a real prompt-ready signal. Most TUIs paint a banner + tool list +
 *  status line on startup that can briefly score as "no state matches →
 *  default idle"; firing a send_keys into that buffer gets the input
 *  wiped when the banner clears. 2s covers the slow agents (hermes,
 *  agy) without delaying snappy ones (claude/codex) by much. */
const STARTUP_GRACE_MS = 2500;

/** Min time to stay in busy after the evaluator last reports it. Most TUIs
 *  flicker their busy spinner on and off as layout reflows (claude streams
 *  body text in the same region where the spinner lives, so the spinner
 *  disappears mid-response and the footer-only frames score as idle). The
 *  hold turns short idle gaps inside a single turn into "still busy", at
 *  the cost of looking busy for a couple seconds after a turn actually
 *  ends. Pick something long enough to cover the longest claude streaming
 *  gap we've observed (~5s between spinner refreshes) without dragging
 *  the post-turn idle indication noticeably. */
const BUSY_HOLD_MS = 6000;

/** Minimum delay between the prompt body and the submit_key in send_message.
 *  Claude / antigravity specs ship without an explicit delay_ms_before_submit
 *  and their TUIs sometimes drop the `\r` event when it arrives in the same
 *  PTY chunk as the text body — the prompt sits visible in the input field
 *  but is never submitted until the user hits Enter manually. 200ms matches
 *  codex's explicit setting and is barely perceptible to a human caller. */
const SUBMIT_DELAY_FLOOR_MS = 200;

function countNewlines(s: string): number {
    let n = 0;
    for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) === 10) n += 1;
    return n;
}

/**
 * Pick the effective delay (ms) to wait between writing the prompt body and
 * writing the submit_key. Exported for tests; production callers go through
 * actuallySendMessage. Floors to SUBMIT_DELAY_FLOOR_MS so specs that omit
 * delay_ms_before_submit (e.g. claude, antigravity) still get baseline
 * protection against the paste→submit race. Adds line-count bonus so
 * multi-line prompts get more settling time on TUIs that re-render per
 * embedded `\n`.
 */
export function resolveSubmitDelayMs(specBeforeSubmit: number | undefined, text: string): number {
    const lines = countNewlines(text);
    const linesBonus = Math.min(800, lines * 80);
    const spec = typeof specBeforeSubmit === 'number' && specBeforeSubmit > 0 ? specBeforeSubmit : 0;
    return Math.max(spec, SUBMIT_DELAY_FLOOR_MS + linesBonus);
}

export function matchesCompletionIdleRule(spec: CliSpec, ev: SpecEvaluation, screen: string): string | null {
    const rule = spec.debounce?.completion_idle_after;
    if (!rule?.regex) return null;
    const haystack = rule.section
        ? ev.sections.find(section => section.id === rule.section)?.text ?? ''
        : screen;
    if (!haystack) return null;
    try {
        const regex = new RegExp(rule.regex, rule.flags || '');
        const matched = regex.test(haystack);
        // Return the regex pattern as the stable key rather than the match
        // text. The match text often contains a live counter (e.g. "Compacted
        // for 1m 6s") that changes every second, which would reset
        // completionIdleFirstSeenAt on every PTY frame and prevent the hold
        // window from ever expiring.
        return matched ? rule.regex : null;
    } catch {
        return null;
    }
}

export function matchesCompletionIdleTargetState(
    spec: CliSpec,
    ev: SpecEvaluation,
    screen: string,
    cursor?: { row: number; col: number },
): boolean {
    // Test whether the idle/default state's when-condition actually matches
    // the current screen, WITHOUT the default fallback. We don't want to
    // return true just because no other state matched (which is what
    // evaluate() does via its default_state fallback).
    const targetId = spec.default_state ?? 'idle';
    const target = spec.states.find(state => state.id === targetId)
        ?? spec.states.find(state => state.id === 'idle');
    if (!target) return false;

    // Re-use the resolved sections already computed by evaluate().
    const sections = ev.sections;
    const cleanScreen = screen.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l).join('\n');

    try {
        // Import the condition evaluator — but we need it as a module-level fn.
        // Instead, call evaluate() and check: if the evaluator chose the target
        // via an *explicit* state match (not fallback), return true.
        // We detect a fallback via trace: the fallback emits "(no state matched".
        const result = evaluate(spec, screen, cursor);
        const wasFallback = result.trace.some(t => t.text.startsWith('(no state matched'));
        return result.state.id === targetId && !wasFallback;
    } catch {
        return false;
    }
}

export class SpecDriver {
    private spec!: CliSpec;
    private adapter!: TerminalAdapter;
    private listeners = new Set<(ev: DashboardEvent) => void>();
    private currentStateId: string | null = null;
    /** Have we ever seen the spec's idle state *after* the startup grace
     *  window? Until we do, the agent's startup banner may still be
     *  painting and any send_message we forward to the PTY will be wiped
     *  when the banner clears the screen. Queue + drain on first valid
     *  idle. */
    private idleSeenOnce = false;
    private startedAtMs = 0;
    private pendingSends: string[] = [];
    private currentEval: SpecEvaluation | null = null;
    private pickerInProgress: { control_id: string; phase: 'waiting'; spec: Control } | null = null;
    private delegateTimers = new Map<string, ReturnType<typeof setTimeout>>();
    /** Timestamp of the last time the evaluator returned busy. Used to debounce
     *  the busy → idle transition (see reevaluate). */
    private lastBusyAt = 0;
    /** The exact busy state object we last saw — held alongside lastBusyAt so
     *  the hold can re-emit the same { id: 'busy', label, title } payload the
     *  dashboard already learned about. currentEval can't fill this role
     *  because the evaluator already moved past busy by the time the hold
     *  kicks in. */
    private lastBusyState: SpecEvaluation['state'] | null = null;
    /** Timestamp of the last time we entered a modal state (approval/picker or
     *  any non-busy non-idle state). Used to suppress brief busy blips that
     *  appear while the modal is still on screen — Claude Code streams body
     *  text that transiently shows a spinner even while an approval modal is
     *  visible, causing rapid approval→busy→approval flicker on the dashboard. */
    private lastModalAt = 0;
    /** The modal state snapshot held across busy blips. */
    private lastModalState: SpecEvaluation['state'] | null = null;
    /** Timestamp of when we last *exited* a modal state (approval/picker → idle
     *  or directly via completion_idle_after).  Used to suppress completion_idle_after
     *  firings that were queued before the modal appeared and expire immediately
     *  after the modal is dismissed — without this the agent appears idle even
     *  though it is still generating. */
    private lastModalExitAt = 0;
    private completionIdleFirstSeenAt = 0;
    private completionIdleKey = '';
    /** Previous screen lines — passed to evaluate() for `changed` condition detection. */
    private prevScreenLines: string[] = [];
    /** Timer that re-runs evaluate() once the hold window expires. Needed
     *  because the PTY stops emitting once the agent finishes; without an
     *  explicit wake-up there's nothing to trigger the busy → idle
     *  downshift. */
    private busyExpiryTimer: ReturnType<typeof setTimeout> | null = null;
    /** Set true while reevaluate() is invoked from busyExpiryTimer callback. */
    private busyExpiryFired = false;
    /** Pending idle-commit timer. Armed when the evaluator first returns idle;
     *  fires after idle_hold_ms if no non-idle reading has cancelled it. */
    private idleHoldTimer: ReturnType<typeof setTimeout> | null = null;
    /** State snapshot captured when the idle hold was armed — emitted on commit. */
    private pendingIdleState: SpecEvaluation['state'] | null = null;
    private specWatcher: fs.FSWatcher | null = null;
    /** Ring buffer of committed state transitions (max 50). */
    private stateHistory: Array<{
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
    }> = [];
    private prevStateAt = 0;

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

    /** Subscribe to outbound events. Returns an unsubscribe fn. */
    subscribe(listener: (ev: DashboardEvent) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    start(): void {
        this.startedAtMs = Date.now();
        this.adapter.start();
        // Make sure we always re-evaluate once the startup grace has
        // expired. Without an explicit wake-up the PTY can go quiet
        // immediately after the banner paints (agy: the screen stays at
        // the input prompt forever), there's no on_screen_changed event
        // to trigger reevaluate, and any send_message we queued during
        // the grace window would never drain.
        const graceMs = this.spec.debounce?.startup_grace_ms ?? STARTUP_GRACE_MS;
        setTimeout(() => this.reevaluate(), graceMs + 100);
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

    snapshot(): string {
        return this.adapter.snapshot();
    }

    getCursorPosition(): { row: number; col: number } {
        return this.adapter.getCursorPosition();
    }

    shutdown(): void {
        for (const t of this.delegateTimers.values()) clearTimeout(t);
        this.delegateTimers.clear();
        this.cancelIdleHold();
        if (this.busyExpiryTimer) { clearTimeout(this.busyExpiryTimer); this.busyExpiryTimer = null; }
        this.specWatcher?.close();
        this.adapter.kill();
    }

    private cancelIdleHold(): void {
        if (this.idleHoldTimer) {
            clearTimeout(this.idleHoldTimer);
            this.idleHoldTimer = null;
            // If the idle hold was armed by a completion_idle_after forced-idle,
            // cancelling it means new activity arrived while we were waiting.
            // Reset the completion tracker so the hold window restarts fresh
            // when the marker reappears — otherwise the stale firstSeenAt makes
            // the hold appear already-expired on the next PTY frame that matches.
            this.completionIdleKey = '';
            this.completionIdleFirstSeenAt = 0;
        }
        this.pendingIdleState = null;
    }

    private pushHistory(stateId: string, label: string, meta?: {
        reason?: string;
        matchedStateId?: string;
        matchedRules?: string[];
        debounceKind?: string;
        idleHoldMs?: number;
        busyHoldMs?: number;
    }): void {
        const now = Date.now();
        const durationMs = this.prevStateAt > 0 ? now - this.prevStateAt : 0;
        this.prevStateAt = now;
        this.stateHistory.push({
            stateId,
            label,
            at: now,
            durationMs,
            reason: meta?.reason ?? 'eval_match',
            ...(meta?.matchedStateId !== undefined ? { matchedStateId: meta.matchedStateId } : {}),
            ...(meta?.matchedRules !== undefined ? { matchedRules: meta.matchedRules } : {}),
            ...(meta?.debounceKind !== undefined ? { debounceKind: meta.debounceKind } : {}),
            ...(meta?.idleHoldMs !== undefined ? { idleHoldMs: meta.idleHoldMs } : {}),
            ...(meta?.busyHoldMs !== undefined ? { busyHoldMs: meta.busyHoldMs } : {}),
        });
        if (this.stateHistory.length > 50) this.stateHistory.shift();
    }

    getStateHistory(): ReadonlyArray<{
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
    }> {
        return this.stateHistory;
    }

    getLastBusyAt(): number { return this.lastBusyAt; }
    hasIdleHoldPending(): boolean { return this.idleHoldTimer !== null; }
    getSpecPath(): string { return this.opts.specPath; }
    getCompletionIdleDebounceState(): { active: boolean; ageMs: number; holdMs: number; forceAfterMs: number } | null {
        if (!this.completionIdleKey || !this.completionIdleFirstSeenAt) return null;
        const rule = this.spec.debounce?.completion_idle_after;
        if (!rule) return null;
        return {
            active: true,
            ageMs: Date.now() - this.completionIdleFirstSeenAt,
            holdMs: rule.hold_ms ?? 0,
            forceAfterMs: typeof rule.force_after_ms === 'number' ? rule.force_after_ms : 0,
        };
    }
    getScreen(): string { return this.adapter.snapshot(); }
    getSections(): Array<{ id: string; text: string }> | null {
        try {
            const screen = this.adapter.snapshot();
            const ev = evaluate(this.spec, screen, undefined);
            return ev.sections.map(s => ({ id: s.id, text: s.text }));
        } catch { return null; }
    }

    // ────────────────────────────────────────────────────────────────────
    // Loading & adapter wiring
    // ────────────────────────────────────────────────────────────────────

    private loadSpecOrThrow(): void {
        const res = loadSpec(this.opts.specPath);
        if (!res.ok) throw new Error(`spec invalid: ${res.errors.join('; ')}`);
        this.spec = res.spec;
    }

    private buildAdapterOpts(): TerminalAdapterOpts {
        const baseArgs = this.spec.spawn_args ?? [];
        const extra = this.opts.extraCliArgs ?? [];
        return {
            binary: this.spec.binary,
            args: [...baseArgs, ...extra],
            cwd: this.opts.workingDir,
            env: { ...(this.spec.env ?? {}), ...(this.opts.extraEnv ?? {}) },
            cols: this.opts.cols ?? DEFAULT_SESSION_HOST_COLS,
            rows: this.opts.rows ?? DEFAULT_SESSION_HOST_ROWS,
            transportFactory: this.opts.transportFactory,
        };
    }

    private armSpecWatcher(): void {
        try {
            // Watch the parent directory so we catch atomic replacements
            // (cp, install scripts) that create a new inode — a file-level
            // watch misses those on macOS because the original inode is gone.
            const dir = path.dirname(this.opts.specPath);
            const base = path.basename(this.opts.specPath);
            this.specWatcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
                if (filename && filename !== base) return;
                const res = loadSpec(this.opts.specPath);
                if (!res.ok) { this.emit({ kind: 'spec_error', errors: res.errors }); return; }
                this.spec = res.spec;
                this.reevaluate(/*forceEmit*/ true);
            });
        } catch { /* watch is best-effort */ }
    }

    // ────────────────────────────────────────────────────────────────────
    // Evaluation pipeline
    // ────────────────────────────────────────────────────────────────────

    private emitInitialState(): void {
        // Start with an empty-screen evaluation so the dashboard immediately
        // knows about the default state.
        this.reevaluate(true);
    }

    /** Re-arm the timer that wakes the driver up after BUSY_HOLD_MS so it
     *  can decide whether to downshift to idle. Always uses the most recent
     *  hold value so a spec hot-reload that shortens the hold takes effect
     *  on the next busy entry. Safe to call repeatedly; only the last call
     *  fires. */
    private scheduleBusyExpiry(holdMs: number): void {
        if (this.busyExpiryTimer) clearTimeout(this.busyExpiryTimer);
        this.busyExpiryTimer = setTimeout(() => {
            this.busyExpiryTimer = null;
            LOG.debug('SpecDriver', `[${this.opts.specPath.split('/').slice(-3).join('/')}] busyExpiry fired holdMs=${holdMs}`);
            this.busyExpiryFired = true;
            this.reevaluate();
            this.busyExpiryFired = false;
        }, Math.max(holdMs + 50, 100));
    }

    private reevaluate(forceEmit = false): void {
        const screen = this.adapter.snapshot();
        const cursor = this.adapter.getCursorPosition();
        const ev = evaluate(this.spec, screen, cursor, this.prevScreenLines.length > 0 ? this.prevScreenLines : undefined);
        // Update prevScreenLines for next evaluation's `changed` condition detection.
        this.prevScreenLines = screen.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);

        // Busy hold: many TUIs flicker between busy and idle every frame
        // (claude in particular — its token counter appears and disappears
        // as the layout reflows). Once we see busy, hold that state for
        // BUSY_HOLD_MS before allowing a downshift to idle. Any state
        // *other* than idle clears the hold immediately (approval is
        // strictly more interesting than busy, so it shouldn't be held
        // back). The hold lives on the driver, not the evaluator, so the
        // spec author doesn't have to think about debouncing.
        let evState = ev.state;
        const busyHoldMs = this.spec.debounce?.busy_hold_ms ?? BUSY_HOLD_MS;
        if (this.currentStateId === 'busy' && evState.id === 'idle') {
            const ageMs = Date.now() - this.lastBusyAt;
            if (ageMs < busyHoldMs) {
                // Pin to the last seen busy state directly — currentEval can
                // already be idle at this point (it tracks the previous tick,
                // which during the flicker is just as likely to be idle as
                // busy), so we can't rely on it to recover the busy label.
                evState = this.lastBusyState ?? evState;
            }
        }
        // Modal hold: when in a modal state (approval, picker, etc.) a brief
        // busy reading should not interrupt the modal. Claude Code streams
        // body content while the approval modal is visible, causing a spinner
        // to appear transiently — without this hold, the dashboard sees a
        // rapid modal→busy→modal flicker and the approval UI disappears and
        // reappears every few seconds. Apply the same busy_hold_ms window:
        // if the modal was entered recently and the evaluator now returns
        // busy, stay in the modal state until the hold expires or a non-busy
        // non-modal reading arrives.
        const idleStateId = this.spec.default_state ?? 'idle';
        const isModalState = (id: string | null) =>
            id !== null && id !== 'busy' && id !== idleStateId;
        if (isModalState(this.currentStateId) && evState.id === 'busy') {
            const ageMs = Date.now() - this.lastModalAt;
            if (ageMs < busyHoldMs && this.lastModalState) {
                evState = this.lastModalState;
            }
        }
        const completionIdleRule = this.spec.debounce?.completion_idle_after;
        let busyWakeMs = busyHoldMs;
        // Don't fire completion_idle_after while in a modal state (approval,
        // picker, etc.) or within a grace period after leaving one.  Two cases:
        // 1. Modal still active: the hold window may have expired so evState
        //    resolves to busy, but the user is still looking at the approval screen.
        // 2. Modal just dismissed: the timer may have been queued *before* the
        //    approval appeared and its hold expires immediately after dismissal,
        //    causing a false-idle even though the agent is still generating.
        const postModalGraceMs = busyHoldMs;
        const now = Date.now();
        const recentlyInModal = isModalState(this.currentStateId) || (this.lastModalAt > 0 && now - this.lastModalAt < postModalGraceMs);
        const recentlyLeftModal = !recentlyInModal && this.lastModalExitAt > 0 && now - this.lastModalExitAt < postModalGraceMs;
        if (evState.id === 'busy' && completionIdleRule && !recentlyInModal && !recentlyLeftModal) {
            const completionKey = matchesCompletionIdleRule(this.spec, ev, screen);
            if (completionKey) {
                const now = Date.now();
                if (completionKey !== this.completionIdleKey) {
                    this.completionIdleKey = completionKey;
                    this.completionIdleFirstSeenAt = now;
                    LOG.debug('SpecDriver', `[${this.opts.specPath.split('/').slice(-3).join('/')}] completion_idle_after matched: key="${completionKey}"`);
                }
                const holdMs = Math.max(0, completionIdleRule.hold_ms || 0);
                const forceAfterMs = typeof completionIdleRule.force_after_ms === 'number'
                    ? completionIdleRule.force_after_ms
                    : null;
                const ageMs = now - this.completionIdleFirstSeenAt;
                if (ageMs >= holdMs) {
                    const targetMatches = matchesCompletionIdleTargetState(this.spec, ev, screen, cursor);
                    const forced = !targetMatches && forceAfterMs !== null && ageMs >= holdMs + forceAfterMs;
                    LOG.debug('SpecDriver', `[${this.opts.specPath.split('/').slice(-3).join('/')}] completion_idle_after hold expired ageMs=${ageMs} targetState=${targetMatches} forced=${forced} screenTail="${screen.split(/\r?\n/).slice(-3).join('\\n').slice(-200)}"`);
                    if (targetMatches || forced) {
                        const idle = this.spec.states.find(state => state.id === this.spec.default_state)
                            ?? this.spec.states.find(state => state.id === 'idle');
                        evState = idle
                            ? { id: idle.id, label: idle.label, title: null }
                            : { id: 'idle', label: 'Ready', title: null };
                    } else {
                        busyWakeMs = Math.min(busyWakeMs, 1000);
                    }
                } else {
                    busyWakeMs = Math.min(busyWakeMs, Math.max(holdMs - ageMs, 0));
                }
            } else {
                this.completionIdleKey = '';
                this.completionIdleFirstSeenAt = 0;
            }
        } else if (evState.id !== 'busy') {
            this.completionIdleKey = '';
            this.completionIdleFirstSeenAt = 0;
        }

        if (evState.id === 'busy') {
            this.lastBusyAt = Date.now();
            this.lastBusyState = evState;
            // Cancel any pending idle commit — non-idle reading invalidates it.
            this.cancelIdleHold();
            // Reset completion_idle_after tracking only when the completion
            // marker is NOT present. If the marker is on screen (key is set
            // by the block above), clearing it here would restart the hold
            // window on every PTY frame and the hold would never expire.
            // Only reset when the marker disappeared (key is empty), meaning
            // a new tool-output burst arrived that pushed the marker off
            // screen — in that case the old firstSeenAt is stale and should
            // restart when the marker reappears.
            //
            // Also reset on busy re-entry (transitioning back from a non-busy
            // state). The previous generation may have set completionIdleKey
            // and firstSeenAt; without this reset the hold window appears
            // instantly expired on the new generation's first PTY frame that
            // re-matches the same completion regex key, causing a false-idle
            // before the new generation has a chance to run.
            if (!this.completionIdleKey || this.currentStateId !== 'busy') {
                this.completionIdleKey = '';
                this.completionIdleFirstSeenAt = 0;
            }
            // Schedule a re-evaluation when the hold window expires. PTYs
            // typically stop emitting once the agent stops printing (the
            // footer settles), so without an explicit timer the driver
            // never wakes up to downshift to idle and the dashboard sees
            // status stuck at generating long after the turn ended.
            this.scheduleBusyExpiry(busyWakeMs);
        } else if (evState.id !== this.currentStateId && evState.id !== 'busy') {
            // Non-busy modal states (approval, picker, signing_in) also cancel
            // any in-flight idle hold — they are higher-priority than idle.
            if (evState.id !== (this.spec.default_state ?? 'idle')) {
                this.cancelIdleHold();
            }
            // Track the modal entry timestamp so the modal-hold above can
            // suppress brief busy blips while the modal is still on screen.
            if (isModalState(evState.id)) {
                this.lastModalAt = Date.now();
                this.lastModalState = evState;
            } else {
                // Leaving modal territory (going to idle) — clear the hold,
                // but record the exit time so completion_idle_after can be
                // suppressed during the grace period after dismissal.
                if (this.lastModalAt > 0) this.lastModalExitAt = Date.now();
                this.lastModalAt = 0;
                this.lastModalState = null;
            }
        }

        // Idle hold: if idle_hold_ms is set, don't commit idle immediately.
        // Arm a timer; if a non-idle reading arrives before it fires, cancel.
        const idleHoldMs = this.spec.debounce?.idle_hold_ms ?? 0;
        const isIdleState = evState.id === (this.spec.default_state ?? 'idle');
        if (isIdleState && idleHoldMs > 0 && this.currentStateId !== evState.id) {
            if (!this.idleHoldTimer) {
                this.pendingIdleState = evState;
                const capturedEv = ev;
                const capturedMatchedRules = extractMatchedRules(ev);
                this.idleHoldTimer = setTimeout(() => {
                    this.idleHoldTimer = null;
                    const committed = this.pendingIdleState;
                    this.pendingIdleState = null;
                    if (!committed) return;
                    LOG.debug('SpecDriver', `[${this.opts.specPath.split('/').slice(-3).join('/')}] idleHold committed after ${idleHoldMs}ms`);
                    this.currentStateId = committed.id;
                    this.currentEval = capturedEv;
                    this.pushHistory(committed.id, committed.label, {
                        reason: 'idle_hold_committed',
                        matchedStateId: capturedEv.state.id,
                        matchedRules: capturedMatchedRules,
                        debounceKind: 'idle_hold',
                        idleHoldMs,
                    });
                    this.emit({
                        kind: 'state_changed',
                        state: committed,
                        modal: null,
                        controls: capturedEv.controls.map(c => ({ id: c.id, label: c.label, action_type: c.actionType })),
                    });
                    this.armOrCancelDelegateTimers(committed.id);
                    if (this.opts.emitTrace) this.emit({ kind: 'spec_trace', entries: capturedEv.trace });
                }, idleHoldMs);
            }
            // Don't fall through to the normal changed/emit path for idle.
            this.currentEval = ev;
            const graceMs2 = this.spec.debounce?.startup_grace_ms ?? STARTUP_GRACE_MS;
            if (!this.idleSeenOnce && Date.now() - this.startedAtMs >= graceMs2) {
                this.idleSeenOnce = true;
                const queued = this.pendingSends.splice(0);
                for (const text of queued) setTimeout(() => this.actuallySendMessage(text), 50);
            }
            if (this.pickerInProgress) this.tryAdvancePicker(screen);
            return;
        }

        const changed = forceEmit
            || evState.id !== this.currentStateId
            || !shallowSameModal(ev, this.currentEval)
            || !shallowSameControls(ev, this.currentEval);

        // Picker state tracking — if a picker is waiting for its
        // wait_for cue and now sees it, complete the picker flow.
        if (this.pickerInProgress) this.tryAdvancePicker(screen);

        this.currentEval = ev;
        // First time we ever see idle (or any non-busy non-startup state),
        // flush any queued send_message calls that arrived before the
        // agent finished painting its banner. Subsequent idle/busy
        // toggles don't retrigger.
        // Wait at least the spec's startup_grace_ms after start() so we
        // don't treat a transient "matches no state, default idle"
        // reading during the banner paint as a real idle. After that,
        // the first non-busy observation is a real prompt-ready signal
        // and we drain any queued send_message calls.
        const graceMs = this.spec.debounce?.startup_grace_ms ?? STARTUP_GRACE_MS;
        const sinceStart = Date.now() - this.startedAtMs;
        if (!this.idleSeenOnce && evState.id !== 'busy' && sinceStart >= graceMs) {
            this.idleSeenOnce = true;
            const queued = this.pendingSends.splice(0);
            for (const text of queued) {
                setTimeout(() => this.actuallySendMessage(text), 50);
            }
        }
        if (changed) {
            this.currentStateId = evState.id;
            const matchedRules = extractMatchedRules(ev);
            // Determine reason and debounce kind for this transition
            let transitionReason: string;
            let debounceKind: string;
            let transitionBusyHoldMs: number | undefined;
            if (forceEmit) {
                transitionReason = 'forceEmit';
                debounceKind = 'none';
            } else if (evState.id !== ev.state.id) {
                // evState was overridden — completion_idle_after forced idle
                transitionReason = 'completion_idle_after';
                debounceKind = 'completion_idle_after';
            } else if (this.busyExpiryFired) {
                // busyExpiryTimer woke us up and hold has now expired
                transitionReason = 'busy_hold_expired';
                debounceKind = 'busy_hold';
                transitionBusyHoldMs = busyHoldMs;
            } else {
                transitionReason = 'eval_match';
                debounceKind = 'none';
            }
            this.pushHistory(evState.id, evState.label, {
                reason: transitionReason,
                matchedStateId: ev.state.id,
                matchedRules,
                debounceKind,
                ...(transitionBusyHoldMs !== undefined ? { busyHoldMs: transitionBusyHoldMs } : {}),
            });
            this.emit({
                kind: 'state_changed',
                state: evState,
                modal: ev.modal ? { title: ev.modal.title, buttons: ev.modal.buttons.map(b => ({ index: b.index, label: b.label })) } : null,
                controls: ev.controls.map(c => ({ id: c.id, label: c.label, action_type: c.actionType })),
            });
            for (const n of ev.notifications) this.emit({ kind: 'notification', id: n.id, title: n.title, body: n.body });
            this.armOrCancelDelegateTimers(evState.id);
            if (this.opts.emitTrace) this.emit({ kind: 'spec_trace', entries: ev.trace });
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
        const task = (d.task_template)
            .replace(/\{node\}/g, os.hostname())
            .replace(/\{state\.label\}/g, ev?.state.label ?? '')
            .replace(/\{state\.title\}/g, ev?.state.title ?? '')
            .replace(/\{duration_ms\}/g, String(d.after_duration_ms ?? 0));
        this.emit({ kind: 'delegate', id: d.id, task });
    }

    // ────────────────────────────────────────────────────────────────────
    // Dashboard commands
    // ────────────────────────────────────────────────────────────────────

    private handleSendMessage(text: string): void {
        if (!this.idleSeenOnce) {
            // Agent is still drawing its startup banner. Queue and drain
            // when we see idle so we don't fire keystrokes into a buffer
            // that's about to be cleared.
            this.pendingSends.push(text);
            return;
        }
        this.actuallySendMessage(text);
    }

    private actuallySendMessage(text: string): void {
        const sm = this.spec.send_message;
        const perChar = sm.delay_ms_per_char ?? 0;
        // Floor the gap between text and submit_key. Without this, claude /
        // antigravity specs (which leave delay_ms_before_submit unset)
        // race: text bytes and `\r` arrive back-to-back, the TUI processes
        // the `\r` while still digesting the text input, and the prompt
        // sits visible in the input field but never submits — the user has
        // to press Enter manually. Scale with line count so multi-line
        // pastes (which take longer for the TUI to render) get more
        // settling time.
        const beforeSubmit = resolveSubmitDelayMs(sm.delay_ms_before_submit, text);
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
        // Reject controls that aren't currently visible.
        const ev = this.currentEval;
        if (ctl.visible_when_state && ev && !ctl.visible_when_state.includes(ev.state.id)) return;

        const a = ctl.action;
        switch (a.type) {
            case 'send_keys':
                this.adapter.send_keys(a.keys);
                return;
            case 'open_picker':
                this.adapter.send_keys(a.trigger_keys);
                this.pickerInProgress = { control_id: ctl.id, phase: 'waiting', spec: ctl };
                return;
            case 'attach_image': {
                const p = typeof payload === 'object' && payload && (payload as any).path;
                if (typeof p === 'string') {
                    const keys = a.keys_template.replace(/\{path\}/g, p);
                    this.adapter.send_keys(keys);
                }
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
        // tempfile_then_keys: write decoded bytes to a temp file, then
        // fire the attach_image control_bar entry with that path.
        const ctl = (this.spec.control_bar ?? []).find(c => c.action.type === 'attach_image');
        if (!ctl || ctl.action.type !== 'attach_image') return;
        const ext = guessExt(mime);
        const tmp = path.join(os.tmpdir(), `adhdev-attach-${Date.now()}${ext}`);
        try {
            fs.writeFileSync(tmp, Buffer.from(blob, 'base64'));
        } catch { return; }
        const keys = ctl.action.keys_template.replace(/\{path\}/g, tmp);
        this.adapter.send_keys(keys);
    }

    private tryAdvancePicker(screen: string): void {
        const picker = this.pickerInProgress;
        if (!picker) return;
        const action = picker.spec.action;
        if (action.type !== 'open_picker') return;
        const hay = sectionTextFromSnapshot(this.spec, screen, action.wait_for.section) ?? screen;
        if (!action.wait_for.regex) return;
        const re = new RegExp(action.wait_for.regex, action.wait_for.flags ?? 'i');
        if (!re.test(hay)) return;
        // Cue arrived — the dashboard now sees the picker modal via
        // state_changed. We do NOT auto-submit; the dashboard must call
        // click_modal_button(index). After the modal closes the picker
        // tracking naturally clears the next time the screen settles.
        this.pickerInProgress = null;
    }

    private handleExit(exitCode: number): void {
        this.emit({ kind: 'exit', exit_code: exitCode });
        this.shutdown();
    }

    private emit(ev: DashboardEvent): void {
        for (const l of this.listeners) {
            try { l(ev); } catch { /* listener side */ }
        }
    }
}

function shallowSameModal(a: SpecEvaluation, b: SpecEvaluation | null): boolean {
    if (!b) return false;
    if (!a.modal && !b.modal) return true;
    if (!a.modal || !b.modal) return false;
    if (a.modal.title !== b.modal.title) return false;
    if (a.modal.buttons.length !== b.modal.buttons.length) return false;
    for (let i = 0; i < a.modal.buttons.length; i += 1) {
        if (a.modal.buttons[i].label !== b.modal.buttons[i].label) return false;
    }
    return true;
}

function shallowSameControls(a: SpecEvaluation, b: SpecEvaluation | null): boolean {
    if (!b) return false;
    if (a.controls.length !== b.controls.length) return false;
    for (let i = 0; i < a.controls.length; i += 1) {
        if (a.controls[i].id !== b.controls[i].id) return false;
    }
    return true;
}

function sectionTextFromSnapshot(spec: CliSpec, screen: string, sectionId: string | undefined): string | null {
    if (!sectionId) return null;
    const ev = evaluate(spec, screen);
    return ev.sections.find(s => s.id === sectionId)?.text ?? null;
}

function guessExt(mime: string): string {
    if (/png/i.test(mime)) return '.png';
    if (/jpe?g/i.test(mime)) return '.jpg';
    if (/gif/i.test(mime)) return '.gif';
    if (/webp/i.test(mime)) return '.webp';
    return '.bin';
}

function extractMatchedRules(ev: SpecEvaluation): string[] {
    if (!Array.isArray(ev.trace)) return [];
    return ev.trace
        .filter(t => t.kind === 'state_match')
        .map(t => t.text)
        .filter(Boolean);
}
