/**
 * PTY + terminal-screen adapter for the spec driver.
 *
 * Spawns a PTY, feeds bytes into a TerminalScreen (ghostty-vt when available,
 * xterm fallback otherwise) so a visible-screen snapshot is always available,
 * and exposes a small hook surface for the SpecDriver to consume:
 *
 *   init({ pid })               — PTY spawned
 *   on_pty_data(chunk)          — raw PTY byte chunk received
 *   on_screen_changed(snapshot) — coalesced visible-screen change
 *   on_exit({ exitCode })       — PTY exited
 *   tick()                      — periodic tick (if tickIntervalMs > 0)
 */
'use strict';

import { TerminalScreen } from '../../cli-adapters/terminal-screen.js';
import type { PtyTransportFactory } from '../../cli-adapters/pty-transport.js';
import type { PtyRuntimeTransport } from '../../cli-adapters/pty-transport.js';
import { DEFAULT_SESSION_HOST_COLS, DEFAULT_SESSION_HOST_ROWS } from '@adhdev/session-host-core';

export type { PtyTransportFactory };

export interface TerminalAdapterOpts {
    binary: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    /**
     * When true, `env` is already a COMPLETE, sanitized environment (the spawn
     * planner merged + stripped process.env already) and must be passed to the
     * PTY verbatim — NOT overlaid on top of process.env. Overlaying would
     * re-introduce the npm_/PNPM_/parent-session keys the planner explicitly
     * stripped, so the spec path's spawn env would diverge from the legacy
     * path's. Defaults to false (legacy overlay behaviour) for any caller that
     * still passes a partial env.
     */
    envIsComplete?: boolean;
    cols?: number;
    rows?: number;
    /** Coalesce screen snapshots: emit on_screen_changed at most this often. */
    screenChangeDebounceMs?: number;
    tickIntervalMs?: number;
    transportFactory?: PtyTransportFactory;
}

export interface TerminalAdapterHandlers {
    init?(info: { pid: number }): void;
    on_pty_data?(chunk: string): void;
    on_screen_changed?(snapshot: string): void;
    on_exit?(info: { exitCode: number }): void;
    tick?(): void;
}

/**
 * One entry in the PTY input/output event timeline (debug-only). Captured at
 * the single common point every spec@4 provider funnels through — this adapter
 * — so the Spec Debug Snapshot can answer "what input / output preceded a status
 * transition?". Observation only; nothing here feeds the FSM decision.
 */
export interface SpecPtyEvent {
    /** Wall-clock ms. */
    ts: number;
    kind: 'spawn' | 'input' | 'output' | 'resize' | 'cursor' | 'exit';
    /** Human-readable, control-char-escaped, length-capped preview. */
    content: string;
    /** Raw byte length before truncation (output/input only). */
    bytes?: number;
}

const MAX_PTY_EVENTS = 300;
const EVENT_CONTENT_CAP = 240;

/** Escape control characters into a visible form so the timeline is readable
 *  (CR/LF/ESC/tab become \r \n \x1b \t; other C0 controls become \xNN). */
function escapeControl(text: string): string {
    // eslint-disable-next-line no-control-regex
    return String(text).replace(/[\x00-\x1f\x7f]/g, (ch) => {
        const code = ch.charCodeAt(0);
        if (ch === '\r') return '\\r';
        if (ch === '\n') return '\\n';
        if (ch === '\t') return '\\t';
        if (code === 0x1b) return '\\x1b';
        return '\\x' + code.toString(16).padStart(2, '0');
    });
}

function capPreview(text: string): string {
    return text.length > EVENT_CONTENT_CAP ? text.slice(0, EVENT_CONTENT_CAP) + `…(+${text.length - EVENT_CONTENT_CAP})` : text;
}

export class TerminalAdapter {
    private rows: number;
    private cols: number;
    private readonly screenDebounceMs: number;
    private readonly tickIntervalMs: number;
    private factory: PtyTransportFactory | null = null;
    private screen: TerminalScreen;
    private pty: PtyRuntimeTransport | null = null;
    private screenTimer: ReturnType<typeof setTimeout> | null = null;
    private tickTimer: ReturnType<typeof setInterval> | null = null;
    private lastScreen = '';
    /** Debug-only ring buffer of PTY input/output/resize/cursor events. */
    private events: SpecPtyEvent[] = [];
    private lastCursorKey = '';

    constructor(
        private readonly opts: TerminalAdapterOpts,
        private readonly handlers: TerminalAdapterHandlers,
    ) {
        this.cols = opts.cols ?? DEFAULT_SESSION_HOST_COLS;
        this.rows = opts.rows ?? DEFAULT_SESSION_HOST_ROWS;
        this.screenDebounceMs = opts.screenChangeDebounceMs ?? 80;
        this.tickIntervalMs = opts.tickIntervalMs ?? 0;
        // NodePtyTransportFactory resolution is deferred to start(): with the
        // legacy adapter gone, instance-level tests construct the REAL
        // SpecCliAdapter (and thus this TerminalAdapter) without ever
        // spawning — a constructor-time require of node-pty made every such
        // test pay for (and possibly fail on) the native module.
        if (opts.transportFactory) this.factory = opts.transportFactory;
        this.screen = new TerminalScreen(this.rows, this.cols);
    }

    start(): void {
        if (!this.factory) {
            const { NodePtyTransportFactory } = require('../../cli-adapters/pty-transport.js');
            this.factory = new NodePtyTransportFactory();
        }
        const env = this.opts.envIsComplete
            ? ((this.opts.env ?? {}) as Record<string, string>)
            : ({ ...process.env, ...(this.opts.env ?? {}) } as Record<string, string>);
        const factory = this.factory!;
        this.pty = factory.spawn(this.opts.binary, this.opts.args ?? [], {
            cwd: this.opts.cwd ?? process.cwd(),
            env,
            cols: this.cols,
            rows: this.rows,
        });
        this.recordEvent('spawn', `${this.opts.binary} (${this.cols}x${this.rows})`);
        this.handlers.init?.({ pid: this.pty.pid });
        this.pty.onData((chunk) => this.onChunk(chunk));
        this.pty.onExit((info) => {
            this.stopTimers();
            this.recordEvent('exit', `exitCode=${typeof info.exitCode === 'number' ? info.exitCode : 0}`);
            this.handlers.on_exit?.({ exitCode: typeof info.exitCode === 'number' ? info.exitCode : 0 });
            this.pty = null;
        });
        if (this.tickIntervalMs > 0) {
            this.tickTimer = setInterval(() => this.handlers.tick?.(), this.tickIntervalMs);
        }
    }

    resize(cols: number, rows: number): void {
        this.cols = cols; this.rows = rows;
        this.recordEvent('resize', `${cols}x${rows}`);
        this.pty?.resize(cols, rows);
        this.screen.resize(rows, cols);
    }

    snapshot(): string {
        return this.lastScreen || this.computeScreen();
    }

    /**
     * Full-buffer snapshot including scrollback history. Unlike snapshot()
     * (visible viewport only), this survives a tall prompt whose top has
     * scrolled off-screen — used for content-pattern extraction (modal
     * buttons / approval anchors), NOT for cursor-relative conditions.
     */
    snapshotWithScrollback(): string {
        return this.screen.getTextWithScrollback();
    }

    getCursorPosition(): { row: number; col: number } {
        const pos = this.screen.getCursorPosition();
        return { row: pos.row, col: pos.col };
    }

    /** Current terminal geometry (columns × rows). Tracked here rather than
     *  read off the screen buffer so a resize is reflected immediately, before
     *  the next repaint. Consumed by the mesh_read_terminal viewport read. */
    getScreenSize(): { cols: number; rows: number } {
        return { cols: this.cols, rows: this.rows };
    }

    send_keys(text: string): void {
        this.recordEvent('input', capPreview(escapeControl(text)), text.length);
        this.pty?.write(text);
    }

    /** Forward runtime metadata (meshNodeId, workspaceLabel, lifecycle, …) to
     *  the underlying transport so it reaches the session registry. The spec
     *  path previously dropped everything but providerSessionId here, which
     *  left autoLaunch's meshNodeId stamp unbound on the record (see
     *  SESSION-ACCUMULATION-LEAK). No-op when the transport does not support
     *  metadata updates (e.g. plain node-pty). */
    updateMeta(meta: Record<string, unknown>, replace = false): void {
        if (!this.pty || typeof this.pty.updateMeta !== 'function') return;
        this.pty.updateMeta(meta, replace);
    }

    /** Debug-only: most-recent PTY input/output/resize/cursor events, oldest
     *  first. Pure observation — never consulted by the FSM. */
    getEventTimeline(limit = MAX_PTY_EVENTS): SpecPtyEvent[] {
        const n = Math.max(0, Math.min(limit, this.events.length));
        return this.events.slice(this.events.length - n);
    }

    private recordEvent(kind: SpecPtyEvent['kind'], content: string, bytes?: number): void {
        const ev: SpecPtyEvent = { ts: Date.now(), kind, content };
        if (typeof bytes === 'number') ev.bytes = bytes;
        this.events.push(ev);
        if (this.events.length > MAX_PTY_EVENTS) this.events.splice(0, this.events.length - MAX_PTY_EVENTS);
    }

    kill(): void {
        this.stopTimers();
        try { this.pty?.kill(); } catch { /* ignore */ }
        this.pty = null;
        this.screen.dispose();
    }

    private onChunk(chunk: string): void {
        this.recordEvent('output', capPreview(escapeControl(chunk)), chunk.length);
        try { this.handlers.on_pty_data?.(chunk); } catch { /* user side */ }
        this.screen.write(chunk);
        // Coalesce snapshot emission — rapid bursts shouldn't fire 200x.
        if (this.screenTimer) return;
        this.screenTimer = setTimeout(() => {
            this.screenTimer = null;
            const snap = this.computeScreen();
            // Record cursor movement at the (debounced) screen-change boundary
            // rather than per output chunk, so the timeline isn't flooded.
            const cur = this.screen.getCursorPosition();
            const curKey = `${cur.row},${cur.col}`;
            if (curKey !== this.lastCursorKey) {
                this.lastCursorKey = curKey;
                this.recordEvent('cursor', `(${cur.row},${cur.col})`);
            }
            if (snap === this.lastScreen) return;
            this.lastScreen = snap;
            try { this.handlers.on_screen_changed?.(snap); } catch { /* user side */ }
        }, this.screenDebounceMs);
    }

    private computeScreen(): string {
        return this.screen.getText();
    }

    private stopTimers(): void {
        if (this.screenTimer) { clearTimeout(this.screenTimer); this.screenTimer = null; }
        if (this.tickTimer)   { clearInterval(this.tickTimer); this.tickTimer = null; }
    }
}
