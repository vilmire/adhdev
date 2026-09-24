/**
 * REDRAW-NUDGE — generic false-busy recovery for PTY-driven spec sessions.
 *
 * Live defect (preview, 2026-09-24, antigravity-cli on MoltBook): a worker
 * finished its turn, but the terminal emulator's screen was left in a garbled
 * frame — a stale `⡿  Running command...` spinner line and a stale
 * `esc to cancel` row from an earlier frame, the cursor parked at (0,0), and
 * the real idle footer `? for shortcuts` on the last row. The FSM re-evaluated
 * only on PTY output or a time wake, the TUI emitted nothing further, and the
 * session sat in `busy`/generating for 80+ minutes (one probe) while the
 * process was idle. The owner's manual recovery was to type `/` and delete it,
 * which made the TUI repaint — the redrawn screen was clean and the FSM
 * flipped to idle on the next frame.
 *
 * This module is the input-free equivalent of that keystroke: when the machine
 * has been in a `generating` state with NO raw PTY output for `silentMs`, it
 * resizes the PTY one column wider and back (a SIGWINCH pair — exactly what a
 * user dragging the window edge does). Full-screen/inline TUIs (Ink, Bubble
 * Tea, ratatui, …) repaint their whole frame on a width change, which replaces
 * the garbled rows; the resulting PTY output re-drives the FSM through the
 * normal on_screen_changed path, and an explicit re-evaluation after a settle
 * delay covers a TUI that repaints nothing.
 *
 * Safety:
 *   - never writes to the PTY's stdin — no keystroke, no focus event;
 *   - only while the FSM reports `generating` AND the PTY has been silent for
 *     the whole window (a streaming turn keeps resetting the clock);
 *   - at most `maxPerEpisode` nudges per continuous generating stay, spaced by
 *     at least `silentMs` (the nudge's own repaint output also restarts it);
 *   - `ADHDEV_REDRAW_NUDGE_SILENT_MS=0` disables it entirely.
 *
 * Lives outside fsm-driver.ts on purpose: that file sits at the file-size cap,
 * so the driver only wires a narrow host view into this controller.
 */

import { LOG } from '../../logging/logger.js';

export const DEFAULT_REDRAW_NUDGE_SILENT_MS = 45_000;
export const DEFAULT_REDRAW_NUDGE_MAX_PER_EPISODE = 4;
/** How long the widened geometry is held before restoring. Long enough that a
 *  TUI which debounces its resize handler (Gemini-CLI-family refreshes ~300ms
 *  after the last width change) observes the widened width rather than
 *  coalescing the pair into a no-op. */
export const DEFAULT_REDRAW_NUDGE_HOLD_MS = 750;
/** Delay after the restore before the forced re-evaluation. */
export const DEFAULT_REDRAW_NUDGE_SETTLE_MS = 1_000;

export interface RedrawNudgePolicy {
    /** Required PTY silence while generating before a nudge; 0 disables. */
    silentMs: number;
    maxPerEpisode: number;
    holdMs: number;
    settleMs: number;
}

function envInt(raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function resolveRedrawNudgePolicy(env: NodeJS.ProcessEnv = process.env): RedrawNudgePolicy {
    return {
        silentMs: envInt(env.ADHDEV_REDRAW_NUDGE_SILENT_MS, DEFAULT_REDRAW_NUDGE_SILENT_MS),
        maxPerEpisode: envInt(env.ADHDEV_REDRAW_NUDGE_MAX, DEFAULT_REDRAW_NUDGE_MAX_PER_EPISODE),
        holdMs: envInt(env.ADHDEV_REDRAW_NUDGE_HOLD_MS, DEFAULT_REDRAW_NUDGE_HOLD_MS),
        settleMs: envInt(env.ADHDEV_REDRAW_NUDGE_SETTLE_MS, DEFAULT_REDRAW_NUDGE_SETTLE_MS),
    };
}

/** The narrow driver surface the controller needs. All reads are live. */
export interface RedrawNudgeHost {
    /** True while the FSM's current state reports `generating`. */
    isGenerating(): boolean;
    /** Start of the current quiet window: max(last raw PTY chunk, state entry). */
    quietSince(): number;
    getSize(): { cols: number; rows: number };
    /** PTY + emulator resize (TerminalAdapter.resize). */
    resize(cols: number, rows: number): void;
    /** Re-read the screen and run the FSM once. */
    reevaluate(): void;
    /** Log prefix (spec|session). */
    tag(): string;
}

export class RedrawNudger {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private timerDueAt = 0;
    private holdTimer: ReturnType<typeof setTimeout> | null = null;
    private settleTimer: ReturnType<typeof setTimeout> | null = null;
    private episodeNudges = 0;
    private totalNudges = 0;
    private lastNudgeAt = 0;
    private wiggling = false;
    private disposed = false;

    constructor(
        private readonly host: RedrawNudgeHost,
        private readonly policy: RedrawNudgePolicy = resolveRedrawNudgePolicy(),
    ) {}

    /** Nudges issued over the driver's lifetime (surfaced to the stall watchdog). */
    getTotalNudges(): number { return this.totalNudges; }
    /** Nudges issued in the current generating episode. */
    getEpisodeNudges(): number { return this.episodeNudges; }

    /** (Re)arm the silence timer for the current state. Called after every FSM
     *  evaluation, so it is cheap when nothing changed. */
    schedule(): void {
        if (this.disposed || this.policy.silentMs <= 0) return;
        if (!this.host.isGenerating() || this.episodeNudges >= this.policy.maxPerEpisode) {
            this.clearTimer();
            return;
        }
        if (this.wiggling) return; // the settle re-evaluation re-arms
        const dueAt = Math.max(this.host.quietSince(), this.lastNudgeAt) + this.policy.silentMs;
        if (this.timer && this.timerDueAt === dueAt) return;
        this.clearTimer();
        this.timerDueAt = dueAt;
        this.timer = setTimeout(() => { this.timer = null; this.onTick(); }, Math.max(dueAt - Date.now() + 30, 50));
    }

    /** Status edge from the driver's commitTransition. Ends the episode when the
     *  machine leaves `generating`, and reports a nudge-driven recovery. */
    onTransition(fromStatus: string, toStatus: string, label: string): void {
        if (fromStatus !== 'generating' || toStatus === 'generating') return;
        const now = Date.now();
        if (this.episodeNudges > 0 && toStatus === 'idle' && now - this.lastNudgeAt <= Math.max(this.policy.silentMs, 5_000)) {
            LOG.info('FsmDriver', `[${this.host.tag()}] false busy: screen redraw revealed idle (${label}) `
                + `after ${this.episodeNudges} redraw nudge(s), ${now - this.lastNudgeAt}ms after the last`);
        }
        this.episodeNudges = 0;
        this.clearTimer();
    }

    dispose(): void {
        this.disposed = true;
        this.clearTimer();
        if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; }
        if (this.settleTimer) { clearTimeout(this.settleTimer); this.settleTimer = null; }
    }

    private clearTimer(): void {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        this.timerDueAt = 0;
    }

    private onTick(): void {
        if (this.disposed || this.wiggling || !this.host.isGenerating()) return;
        if (this.episodeNudges >= this.policy.maxPerEpisode) return;
        const now = Date.now();
        const quietMs = now - Math.max(this.host.quietSince(), this.lastNudgeAt);
        if (quietMs < this.policy.silentMs) { this.schedule(); return; }
        this.nudge(quietMs);
    }

    private nudge(quietMs: number): void {
        const { cols, rows } = this.host.getSize();
        if (!(cols > 0 && rows > 0)) return;
        this.episodeNudges += 1;
        this.totalNudges += 1;
        this.lastNudgeAt = Date.now();
        this.wiggling = true;
        LOG.info('FsmDriver', `[${this.host.tag()}] redraw nudge ${this.episodeNudges}/${this.policy.maxPerEpisode}: `
            + `generating with no PTY output for ${quietMs}ms — resize wiggle ${cols}x${rows}→${cols + 1}x${rows}→${cols}x${rows} `
            + '(SIGWINCH only, no input sent)');
        try { this.host.resize(cols + 1, rows); } catch { /* PTY gone — restore below is a no-op too */ }
        this.holdTimer = setTimeout(() => {
            this.holdTimer = null;
            try { this.host.resize(cols, rows); } catch { /* PTY gone */ }
            this.wiggling = false;
            if (this.disposed) return;
            this.settleTimer = setTimeout(() => {
                this.settleTimer = null;
                if (this.disposed) return;
                // reevaluate() → schedule() re-arms the next window (or clears it
                // when the redraw flipped the machine out of generating).
                this.host.reevaluate();
            }, this.policy.settleMs);
        }, this.policy.holdMs);
    }
}
