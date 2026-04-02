/**
 * PTY screen snapshot abstraction.
 *
 * We currently keep xterm as the default parser/model because it is already
 * proven in production, but the surface is now backend-agnostic so we can
 * swap in libghostty-vt once a native Node binding is available.
 */

import { LOG } from '../logging/logger.js';
import { GhosttyVtTerminalBackend, isGhosttyVtBackendAvailable, resolveTerminalBackendPreference } from './terminal-backends/ghostty-vt-backend.js';
import type {
    TerminalViewportBackend,
    TerminalViewportBackendKind,
    TerminalViewportBackendOptions,
    TerminalViewportBackendPreference,
} from './terminal-backends/types.js';
import { XtermTerminalBackend } from './terminal-backends/xterm-backend.js';

const DEFAULT_SCROLLBACK = 2000;
const loggedTerminalBackends = new Set<string>();

function createTerminalBackend(
    options: TerminalViewportBackendOptions,
    preference: TerminalViewportBackendPreference,
): TerminalViewportBackend {
    const ghosttyAvailable = isGhosttyVtBackendAvailable();
    if (preference === 'ghostty-vt') {
        const backend = new GhosttyVtTerminalBackend(options);
        logTerminalBackendSelection(preference, ghosttyAvailable, backend.kind);
        return backend;
    }

    if (preference === 'auto' && ghosttyAvailable) {
        const backend = new GhosttyVtTerminalBackend(options);
        logTerminalBackendSelection(preference, ghosttyAvailable, backend.kind);
        return backend;
    }

    const backend = new XtermTerminalBackend(options);
    logTerminalBackendSelection(preference, ghosttyAvailable, backend.kind);
    return backend;
}

function logTerminalBackendSelection(
    preference: TerminalViewportBackendPreference,
    ghosttyAvailable: boolean,
    backendKind: TerminalViewportBackendKind,
): void {
    const key = `${preference}:${ghosttyAvailable}:${backendKind}`;
    if (loggedTerminalBackends.has(key)) return;
    loggedTerminalBackends.add(key);
    LOG.info(
        'Terminal',
        `[terminal-screen] backend=${backendKind} preference=${preference} ghosttyAvailable=${ghosttyAvailable}`,
    );
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
