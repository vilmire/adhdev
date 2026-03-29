/**
 * CliTerminal — xterm.js based CLI terminal emulator
 *
 * Directly renders PTY raw output, displaying CLI tool's original TUI as-is.
 * Passes key input directly to PTY, supporting shortcuts, mode switching, and full control.
 */
import { useEffect, useRef, forwardRef, useImperativeHandle, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

export interface CliTerminalHandle {
    write: (data: string) => void;
    clear: () => void;
    fit: () => void;
    /** cols+5 → revert to original cols after 100ms to force TUI redraw */
    bumpResize: () => void;
}

interface CliTerminalProps {
    onInput: (data: string) => void;
    onResize?: (cols: number, rows: number) => void;
    fontSize?: number;
}

const TERMINAL_THEME = {
    background: '#0f1117',
    foreground: '#cdd6f4',
    cursor: '#f38ba8',
    cursorAccent: '#0f1117',
    selectionBackground: 'rgba(166, 227, 161, 0.3)',
    selectionForeground: '#cdd6f4',
    // Catppuccin Mocha palette
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#cba6f7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#cba6f7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8',
};

export const CliTerminal = forwardRef<CliTerminalHandle, CliTerminalProps>(
    ({ onInput, onResize, fontSize = 13 }, ref) => {
        const containerRef = useRef<HTMLDivElement>(null);
        const termRef = useRef<Terminal | null>(null);
        const fitAddonRef = useRef<FitAddon | null>(null);
        const [ready, setReady] = useState(false);

        useImperativeHandle(ref, () => ({
            write: (data: string) => {
                termRef.current?.write(data);
            },
            clear: () => {
                termRef.current?.clear();
            },
            fit: () => {
                try {
                    fitAddonRef.current?.fit();
                    if (termRef.current) {
                        onResize?.(termRef.current.cols, termRef.current.rows);
                    }
                } catch { }
            },
            bumpResize: () => {
                try {
                    fitAddonRef.current?.fit();
                    const term = termRef.current;
                    if (!term) return;
                    const cols = term.cols;
                    const rows = term.rows;
                    onResize?.(cols + 5, rows);
                    setTimeout(() => {
                        onResize?.(cols, rows);
                    }, 100);
                } catch { }
            },
        }));

        useEffect(() => {
            if (!containerRef.current) return;

            const term = new Terminal({
                cursorBlink: true,
                cursorStyle: 'bar',
                fontSize,
                fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', 'Menlo', monospace",
                fontWeight: '400',
                letterSpacing: 0,
                lineHeight: 1.2,
                theme: TERMINAL_THEME,
                allowTransparency: true,
                scrollback: 5000,
                convertEol: false,
            });

            const fitAddon = new FitAddon();
            const webLinksAddon = new WebLinksAddon();
            term.loadAddon(fitAddon);
            term.loadAddon(webLinksAddon);
            term.open(containerRef.current);

            // Slight delay before fit (after DOM fully rendered)
            requestAnimationFrame(() => {
                fitAddon.fit();
                onResize?.(term.cols, term.rows);
                setReady(true);
            });

            // Key input → PTY stdin
            const dataDisposable = term.onData((data: string) => {
                onInput(data);
            });

            // Detect resize
            const ro = new ResizeObserver(() => {
                requestAnimationFrame(() => {
                    try {
                        fitAddon.fit();
                        onResize?.(term.cols, term.rows);
                    } catch { }
                });
            });
            ro.observe(containerRef.current);

            termRef.current = term;
            fitAddonRef.current = fitAddon;

            return () => {
                dataDisposable.dispose();
                ro.disconnect();
                term.dispose();
                termRef.current = null;
                fitAddonRef.current = null;
            };
        }, [fontSize]);

        return (
            <div
                ref={containerRef}
                className="w-full h-full rounded-lg overflow-hidden transition-opacity duration-200"
                style={{
                    background: TERMINAL_THEME.background,
                    opacity: ready ? 1 : 0,
                }}
            />
        );
    }
);

CliTerminal.displayName = 'CliTerminal';
