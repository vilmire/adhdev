/**
 * PTY screen snapshot abstraction.
 *
 * We currently keep xterm as the default parser/model because it is already
 * proven in production, but the surface is now backend-agnostic so we can
 * swap in libghostty-vt once a native Node binding is available.
 */

import { GhosttyVtTerminalBackend, isGhosttyVtBackendAvailable, resolveTerminalBackendPreference } from './terminal-backends/ghostty-vt-backend.js';
import type {
    TerminalViewportBackend,
    TerminalViewportBackendKind,
    TerminalViewportBackendOptions,
    TerminalViewportBackendPreference,
} from './terminal-backends/types.js';
import { XtermTerminalBackend } from './terminal-backends/xterm-backend.js';

const DEFAULT_SCROLLBACK = 2000;

function createTerminalBackend(
    options: TerminalViewportBackendOptions,
    preference: TerminalViewportBackendPreference,
): TerminalViewportBackend {
    if (preference === 'ghostty-vt') {
        return new GhosttyVtTerminalBackend(options);
    }

    if (preference === 'auto' && isGhosttyVtBackendAvailable()) {
        return new GhosttyVtTerminalBackend(options);
    }

    return new XtermTerminalBackend(options);
}

export class TerminalScreen {
    readonly backendKind: TerminalViewportBackendKind;
    private rows: number;
    private cols: number;
    private readonly preference: TerminalViewportBackendPreference;
    private terminal: TerminalViewportBackend;

    constructor(rows = 40, cols = 120) {
        this.rows = Math.max(1, rows | 0);
        this.cols = Math.max(1, cols | 0);
        this.preference = resolveTerminalBackendPreference();
        this.terminal = this.createBackend();
        this.backendKind = this.terminal.kind;
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

    dispose(): void {
        this.terminal.dispose();
    }

    private createBackend(): TerminalViewportBackend {
        return createTerminalBackend({
            cols: this.cols,
            rows: this.rows,
            scrollback: DEFAULT_SCROLLBACK,
        }, this.preference);
    }
}
