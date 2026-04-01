import type { TerminalViewportBackend, TerminalViewportBackendOptions } from './types.js';

type XtermBufferLine = {
    translateToString(trimRight?: boolean): string;
};

type XtermBuffer = {
    length: number;
    viewportY: number;
    getLine(index: number): XtermBufferLine | undefined;
};

type XtermTerminal = {
    buffer: { active: XtermBuffer };
    write(data: string, callback?: () => void): void;
    resize(cols: number, rows: number): void;
    dispose(): void;
};

let TerminalCtor: (new (options: { cols: number; rows: number; scrollback: number }) => XtermTerminal) | null = null;

function loadTerminalCtor(): new (options: { cols: number; rows: number; scrollback: number }) => XtermTerminal {
    if (!TerminalCtor) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('@xterm/xterm');
        TerminalCtor = mod.Terminal || mod.default?.Terminal || mod.default;
        if (!TerminalCtor) {
            throw new Error('@xterm/xterm Terminal export not found');
        }
    }
    return TerminalCtor;
}

export class XtermTerminalBackend implements TerminalViewportBackend {
    readonly kind = 'xterm' as const;
    private rows: number;
    private cols: number;
    private terminal: XtermTerminal;

    constructor(options: TerminalViewportBackendOptions) {
        this.rows = Math.max(1, options.rows | 0);
        this.cols = Math.max(1, options.cols | 0);
        this.terminal = this.createTerminal(options.scrollback);
    }

    resize(rows: number, cols: number): void {
        this.rows = Math.max(1, rows | 0);
        this.cols = Math.max(1, cols | 0);
        this.terminal.resize(this.cols, this.rows);
    }

    write(data: string): void {
        if (!data) return;
        this.terminal.write(data);
    }

    getText(): string {
        const buffer = this.terminal.buffer.active;
        const start = Math.max(0, buffer.viewportY || 0);
        const end = Math.max(start, Math.min(buffer.length || 0, start + this.rows));
        const lines: string[] = [];

        for (let i = start; i < end; i++) {
            const line = buffer.getLine(i);
            lines.push(line ? line.translateToString(true) : '');
        }

        let first = 0;
        let last = lines.length;
        while (first < last && !lines[first]?.trim()) first++;
        while (last > first && !lines[last - 1]?.trim()) last--;
        return lines.slice(first, last).join('\n');
    }

    dispose(): void {
        this.terminal.dispose();
    }

    private createTerminal(scrollback: number): XtermTerminal {
        const Terminal = loadTerminalCtor();
        return new Terminal({
            cols: this.cols,
            rows: this.rows,
            scrollback,
        });
    }
}
