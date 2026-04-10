/**
 * PTY screen snapshot abstraction.
 *
 * Terminal viewport backend selection.
 *
 * Runtime preference is backend-agnostic:
 * - prefer ghostty-vt when available (or when explicitly requested)
 * - fall back to xterm when ghostty-vt is unavailable
 */
import type { TerminalViewportBackendKind, TerminalViewportBackendPreference } from './terminal-backends/types.js';
export declare function getTerminalBackendRuntimeStatus(): {
    backend: TerminalViewportBackendKind;
    preference: TerminalViewportBackendPreference;
    ghosttyAvailable: boolean;
};
export declare class TerminalScreen {
    readonly backendKind: TerminalViewportBackendKind;
    private rows;
    private cols;
    private readonly preference;
    private terminal;
    constructor(rows?: number, cols?: number);
    reset(rows?: number, cols?: number): void;
    resize(rows: number, cols: number): void;
    write(data: string): void;
    getText(): string;
    getCursorPosition(): {
        col: number;
        row: number;
    };
    dispose(): void;
    private createBackend;
}
