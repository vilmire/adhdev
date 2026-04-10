import type { TerminalViewportBackend, TerminalViewportBackendOptions } from './types.js';
export declare class XtermTerminalBackend implements TerminalViewportBackend {
    readonly kind: "xterm";
    private rows;
    private cols;
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
    private createTerminal;
}
