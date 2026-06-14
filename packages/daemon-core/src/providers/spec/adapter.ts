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

export class TerminalAdapter {
    private rows: number;
    private cols: number;
    private readonly screenDebounceMs: number;
    private readonly tickIntervalMs: number;
    private readonly factory: PtyTransportFactory;
    private screen: TerminalScreen;
    private pty: PtyRuntimeTransport | null = null;
    private screenTimer: ReturnType<typeof setTimeout> | null = null;
    private tickTimer: ReturnType<typeof setInterval> | null = null;
    private lastScreen = '';

    constructor(
        private readonly opts: TerminalAdapterOpts,
        private readonly handlers: TerminalAdapterHandlers,
    ) {
        this.cols = opts.cols ?? DEFAULT_SESSION_HOST_COLS;
        this.rows = opts.rows ?? DEFAULT_SESSION_HOST_ROWS;
        this.screenDebounceMs = opts.screenChangeDebounceMs ?? 80;
        this.tickIntervalMs = opts.tickIntervalMs ?? 0;
        // Import NodePtyTransportFactory lazily to avoid loading node-pty in
        // environments that don't need it (tests, fixture runners) — only when
        // no transport factory was injected. Doing it unconditionally pulled in
        // the node-pty module (and broke source-level test runs) even when a
        // fake factory was supplied.
        if (opts.transportFactory) {
            this.factory = opts.transportFactory;
        } else {
            const { NodePtyTransportFactory } = require('../../cli-adapters/pty-transport.js');
            this.factory = new NodePtyTransportFactory();
        }
        this.screen = new TerminalScreen(this.rows, this.cols);
    }

    start(): void {
        this.pty = this.factory.spawn(this.opts.binary, this.opts.args ?? [], {
            cwd: this.opts.cwd ?? process.cwd(),
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

    resize(cols: number, rows: number): void {
        this.cols = cols; this.rows = rows;
        this.pty?.resize(cols, rows);
        this.screen.resize(rows, cols);
    }

    snapshot(): string {
        return this.lastScreen || this.computeScreen();
    }

    getCursorPosition(): { row: number; col: number } {
        const pos = this.screen.getCursorPosition();
        return { row: pos.row, col: pos.col };
    }

    send_keys(text: string): void {
        this.pty?.write(text);
    }

    kill(): void {
        this.stopTimers();
        try { this.pty?.kill(); } catch { /* ignore */ }
        this.pty = null;
        this.screen.dispose();
    }

    private onChunk(chunk: string): void {
        try { this.handlers.on_pty_data?.(chunk); } catch { /* user side */ }
        this.screen.write(chunk);
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
        return this.screen.getText();
    }

    private stopTimers(): void {
        if (this.screenTimer) { clearTimeout(this.screenTimer); this.screenTimer = null; }
        if (this.tickTimer)   { clearInterval(this.tickTimer); this.tickTimer = null; }
    }
}
