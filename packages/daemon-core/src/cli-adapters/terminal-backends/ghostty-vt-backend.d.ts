import type { TerminalViewportBackend, TerminalViewportBackendOptions, TerminalViewportBackendPreference } from './types.js';
export declare function resolveTerminalBackendPreference(): TerminalViewportBackendPreference;
export declare function isGhosttyVtBackendAvailable(): boolean;
export declare class GhosttyVtTerminalBackend implements TerminalViewportBackend {
    readonly kind: "ghostty-vt";
    private terminal;
    constructor(options: TerminalViewportBackendOptions);
    resize(rows: number, cols: number): void;
    write(data: string): void;
    getText(): string;
    getCursorPosition(): {
        col: number;
        row: number;
    };
    dispose(): void;
}
