/**
 * Thin generic terminal adapter.
 *
 * Spawns a PTY, feeds bytes into a headless xterm so a visible screen
 * snapshot is always available, and exposes a small hook surface
 * (init / tick / on_screen_changed / on_exit). Nothing in this module
 * knows about agents, modals, or specs — it's just a terminal host.
 *
 * The Spec Driver is built on top of this adapter and consumes the
 * hooks to drive its declarative state machine.
 *
 * Inbound from driver:
 *   send_keys(str)  — raw bytes to PTY
 *   resize(c, r)    — resize the PTY and the xterm
 *   kill()          — terminate the child
 *
 * Outbound to driver:
 *   init({ pid })
 *   on_pty_data(chunk)            — raw bytes for dashboard's terminal pane
 *   on_screen_changed(snapshot)   — coalesced visible-screen change
 *   tick()                        — periodic timer (configurable interval)
 *   on_exit({ exitCode })
 */
'use strict';

import { Terminal } from '@xterm/headless';
import { NodePtyTransportFactory, type PtyRuntimeTransport, type PtyTransportFactory } from '../../cli-adapters/pty-transport.js';

export interface TerminalAdapterOpts {
    binary: string;
    args?: string[];
    cwd: string;
    env?: Record<string, string>;
    cols?: number;
    rows?: number;
    /** Coalesce screen snapshots: emit on_screen_changed at most this often. */
    screenChangeDebounceMs?: number;
    /** tick() period. 0 disables ticks. */
    tickIntervalMs?: number;
    /**
     * Optional PTY transport factory. When the daemon supplies a
     * SessionHostPtyTransportFactory (standalone runs the PTY inside the
     * session-host so the runtime/<sid>/snapshot endpoint can serve it),
     * forward it here. Without it the PTY spawns locally inside the
     * daemon process and the dashboard's terminal pane reports
     * "Runtime terminal unavailable: Unknown session".
     */
    transportFactory?: PtyTransportFactory;
}

export interface TerminalAdapterHandlers {
    init?(info: { pid: number }): void;
    on_pty_data?(chunk: string): void;
    on_screen_changed?(snapshot: string): void;
    tick?(): void;
    on_exit?(info: { exitCode: number }): void;
}

export class TerminalAdapter {
    private term: Terminal;
    private pty: PtyRuntimeTransport | null = null;
    private factory: PtyTransportFactory;
    private cols: number;
    private rows: number;
    private screenDebounceMs: number;
    private tickIntervalMs: number;
    private screenTimer: ReturnType<typeof setTimeout> | null = null;
    private tickTimer: ReturnType<typeof setInterval> | null = null;
    private lastScreen = '';

    constructor(
        private readonly opts: TerminalAdapterOpts,
        private readonly handlers: TerminalAdapterHandlers,
    ) {
        this.cols = opts.cols ?? 100;
        this.rows = opts.rows ?? 30;
        this.screenDebounceMs = opts.screenChangeDebounceMs ?? 80;
        this.tickIntervalMs = opts.tickIntervalMs ?? 0;
        this.factory = opts.transportFactory ?? new NodePtyTransportFactory();
        this.term = new Terminal({ cols: this.cols, rows: this.rows, allowProposedApi: true, scrollback: 1000 });
    }

    start(): void {
        this.pty = this.factory.spawn(this.opts.binary, this.opts.args ?? [], {
            cwd: this.opts.cwd,
            env: { ...process.env, ...(this.opts.env ?? {}) } as Record<string, string>,
            cols: this.cols,
            rows: this.rows,
        });
        this.handlers.init?.({ pid: this.pty.pid });
        this.pty.onData((chunk) => this.onChunk(chunk));
        this.pty.onExit((info) => {
            this.stopTimers();
            this.handlers.on_exit?.({ exitCode: typeof info.exitCode === 'number' ? info.exitCode : 0 });
            this.pty = null;
        });
        if (this.tickIntervalMs > 0) {
            this.tickTimer = setInterval(() => this.handlers.tick?.(), this.tickIntervalMs);
        }
    }

    send_keys(s: string): void {
        this.pty?.write(s);
    }

    resize(cols: number, rows: number): void {
        this.cols = cols; this.rows = rows;
        this.pty?.resize(cols, rows);
        this.term.resize(cols, rows);
    }

    snapshot(): string {
        return this.lastScreen || this.computeScreen();
    }

    kill(): void {
        this.stopTimers();
        try { this.pty?.kill(); } catch { /* ignore */ }
        this.pty = null;
        this.term.dispose();
    }

    private onChunk(chunk: string): void {
        try { this.handlers.on_pty_data?.(chunk); } catch { /* user side */ }
        this.term.write(chunk);
        // Coalesce snapshot emission — rapid bursts shouldn't fire 200x.
        if (this.screenTimer) return;
        this.screenTimer = setTimeout(() => {
            this.screenTimer = null;
            const snap = this.computeScreen();
            if (snap === this.lastScreen) return;
            this.lastScreen = snap;
            try { this.handlers.on_screen_changed?.(snap); } catch { /* user side */ }
        }, this.screenDebounceMs);
    }

    private computeScreen(): string {
        const buf = this.term.buffer.active;
        const out: string[] = [];
        for (let y = 0; y < buf.length; y += 1) {
            const line = buf.getLine(y);
            if (!line) continue;
            out.push(line.translateToString(true));
        }
        while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
        return out.join('\n');
    }

    private stopTimers(): void {
        if (this.screenTimer) { clearTimeout(this.screenTimer); this.screenTimer = null; }
        if (this.tickTimer)   { clearInterval(this.tickTimer); this.tickTimer = null; }
    }
}
