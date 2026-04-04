export type TerminalViewportBackendKind = 'xterm' | 'ghostty-vt';

export type TerminalViewportBackendPreference = TerminalViewportBackendKind | 'auto';

export type TerminalViewportBackendOptions = {
    rows: number;
    cols: number;
    scrollback: number;
};

export interface TerminalViewportBackend {
    readonly kind: TerminalViewportBackendKind;
    resize(rows: number, cols: number): void;
    write(data: string): void;
    getText(): string;
    getCursorPosition(): { col: number; row: number };
    dispose(): void;
}
