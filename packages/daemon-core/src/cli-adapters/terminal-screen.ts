/**
 * PTY screen snapshot abstraction — ghostty-vt backend.
 */

import { GhosttyVtTerminalBackend } from './terminal-backends/ghostty-vt-backend.js';
import type { TerminalViewportBackendKind } from './terminal-backends/types.js';
import { DEFAULT_SESSION_HOST_COLS, DEFAULT_SESSION_HOST_ROWS } from '@adhdev/session-host-core';

const DEFAULT_SCROLLBACK = 2000;

export function getTerminalBackendRuntimeStatus(): {
    backend: TerminalViewportBackendKind;
} {
    return { backend: 'ghostty-vt' };
}

export class TerminalScreen {
    readonly backendKind: TerminalViewportBackendKind = 'ghostty-vt';
    private rows: number;
    private cols: number;
    private terminal: GhosttyVtTerminalBackend;

    constructor(rows = DEFAULT_SESSION_HOST_ROWS, cols = DEFAULT_SESSION_HOST_COLS) {
        this.rows = Math.max(1, rows | 0);
        this.cols = Math.max(1, cols | 0);
        this.terminal = this.createBackend();
    }

    reset(rows = this.rows, cols = this.cols): void {
        this.rows = Math.max(1, rows | 0);
        this.cols = Math.max(1, cols | 0);
        this.terminal.dispose();
        this.terminal = this.createBackend();
    }

    resize(rows: number, cols: number): void {
        this.rows = Math.max(1, rows | 0);
        this.cols = Math.max(1, cols | 0);
        this.terminal.resize(this.rows, this.cols);
    }

    write(data: string): void {
        this.terminal.write(data);
    }

    getText(): string {
        return this.terminal.getText();
    }

    /** Full buffer including scrollback history (see backend doc). */
    getTextWithScrollback(): string {
        return this.terminal.getTextWithScrollback();
    }

    getCursorPosition(): { col: number; row: number } {
        if (typeof this.terminal.getCursorPosition !== 'function') return { col: 0, row: 0 };
        return this.terminal.getCursorPosition();
    }

    /** Current viewport dimensions (cols × rows). */
    getSize(): { cols: number; rows: number } {
        return { cols: this.cols, rows: this.rows };
    }

    dispose(): void {
        this.terminal.dispose();
    }

    private createBackend(): GhosttyVtTerminalBackend {
        return new GhosttyVtTerminalBackend({
            cols: this.cols,
            rows: this.rows,
            scrollback: DEFAULT_SCROLLBACK,
        });
    }
}
