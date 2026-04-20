/**
 * PTY screen snapshot abstraction.
 *
 * Terminal viewport backend selection.
 *
 * Runtime preference is backend-agnostic:
 * - prefer ghostty-vt when available (or when explicitly requested)
 * - fall back to xterm when ghostty-vt is unavailable
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

export function getTerminalBackendRuntimeStatus(): {
    backend: TerminalViewportBackendKind;
    preference: TerminalViewportBackendPreference;
    ghosttyAvailable: boolean;
} {
    const preference = resolveTerminalBackendPreference();
    const ghosttyAvailable = isGhosttyVtBackendAvailable();
    const backend: TerminalViewportBackendKind = (
        preference === 'ghostty-vt' || (preference === 'auto' && ghosttyAvailable)
            ? 'ghostty-vt'
            : 'xterm'
    );
    return { backend, preference, ghosttyAvailable };
}

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
    if (backendKind === 'xterm' && preference !== 'xterm' && !ghosttyAvailable) {
        const message = `[terminal-screen] ghostty-vt unavailable; using xterm fallback (preference=${preference})`;
        if (preference === 'auto') {
            LOG.info('Terminal', message);
        } else {
            LOG.warn('Terminal', message);
        }
        return;
    }
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

    getCursorPosition(): { col: number; row: number } {
        return this.terminal.getCursorPosition();
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
