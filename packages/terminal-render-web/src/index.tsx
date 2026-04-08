import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import { FitAddon } from '@xterm/addon-fit';

export interface TerminalRendererHandle {
  write: (data: string) => void;
  clear: () => void;
  reset: () => void;
  resize: (cols: number, rows: number) => void;
  fit: () => void;
  bumpResize: () => void;
}

export interface GhosttyTerminalViewProps {
  onInput: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  fontSize?: number;
  readOnly?: boolean;
  /**
   * Default is `measured`, which avoids xterm's `fit()` and only uses measured
   * dimensions plus explicit `resize()`. `fit` is an opt-in escape hatch for
   * non-dashboard consumers and is not exposed in the dashboard GUI.
   */
  sizingMode?: 'measured' | 'fit';
  className?: string;
  style?: React.CSSProperties;
}

const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;

type RendererKind = 'webgl' | 'canvas' | 'dom';

const TERMINAL_THEME = {
  background: '#0f1117',
  foreground: '#cdd6f4',
  cursor: '#f38ba8',
  cursorAccent: '#0f1117',
  selectionBackground: 'rgba(166, 227, 161, 0.3)',
  selectionForeground: '#cdd6f4',
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

let rendererRuntimeLogged = false;

export const GhosttyTerminalView = forwardRef<TerminalRendererHandle, GhosttyTerminalViewProps>(
  ({ onInput, onResize, fontSize = 13, readOnly = false, sizingMode = 'measured', className, style }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const resizeObserverRef = useRef<ResizeObserver | null>(null);
    const pendingWritesRef = useRef<string[]>([]);
    const onInputRef = useRef(onInput);
    const onResizeRef = useRef(onResize);
    const readOnlyRef = useRef(readOnly);
    const lastReportedSizeRef = useRef<{ cols: number; rows: number } | null>(null);
    const [ready, setReady] = useState(false);
    const [rendererKind, setRendererKind] = useState<RendererKind | null>(null);

    const applyFitIfEnabled = (force = false) => {
      if (sizingMode !== 'fit') return;
      try {
        fitAddonRef.current?.fit();
        const term = terminalRef.current;
        if (!term) return;
        const { cols, rows } = term;
        const last = lastReportedSizeRef.current;
        if (force || !last || last.cols !== cols || last.rows !== rows) {
          lastReportedSizeRef.current = { cols, rows };
          onResizeRef.current?.(cols, rows);
        }
      } catch {}
    };

    useEffect(() => { onInputRef.current = onInput; }, [onInput]);
    useEffect(() => { onResizeRef.current = onResize; }, [onResize]);

    useEffect(() => {
      readOnlyRef.current = readOnly;
      if (!readOnly) return;
      try { terminalRef.current?.blur(); } catch {}
      try {
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement && containerRef.current?.contains(activeElement)) {
          activeElement.blur();
        }
      } catch {}
    }, [readOnly]);

    useImperativeHandle(ref, () => ({
      write: (data: string) => {
        if (terminalRef.current) terminalRef.current.write(data);
        else pendingWritesRef.current.push(data);
      },
      clear: () => {
        if (terminalRef.current) terminalRef.current.clear();
        else pendingWritesRef.current = [];
      },
      reset: () => {
        if (terminalRef.current) terminalRef.current.reset();
        else pendingWritesRef.current = [];
      },
      resize: (cols: number, rows: number) => {
        if (terminalRef.current) {
          terminalRef.current.resize(cols, rows);
          lastReportedSizeRef.current = { cols, rows };
        }
      },
      fit: () => applyFitIfEnabled(true),
      bumpResize: () => applyFitIfEnabled(false),
    }), []);

    useEffect(() => {
      let cancelled = false;
      let disposable: { dispose: () => void } | null = null;
      let termForCleanup: Terminal | null = null;

      function init(): void {
        if (!containerRef.current) return;
        if (cancelled) return;

        const term = new Terminal({
          cols: DEFAULT_TERMINAL_COLS,
          rows: DEFAULT_TERMINAL_ROWS,
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
          disableStdin: false,
        });

        term.open(containerRef.current);

        terminalRef.current = term;
        termForCleanup = term;
        fitAddonRef.current = null;

        if (sizingMode === 'fit') {
          const fitAddon = new FitAddon();
          term.loadAddon(fitAddon);
          fitAddonRef.current = fitAddon;
        }

        // WebGL → Canvas → DOM fallback
        let kind: RendererKind = 'dom';
        try {
          const webglAddon = new WebglAddon();
          webglAddon.onContextLoss(() => {
            webglAddon.dispose();
          });
          term.loadAddon(webglAddon);
          kind = 'webgl';
        } catch {
          try {
            term.loadAddon(new CanvasAddon());
            kind = 'canvas';
          } catch {}
        }

        if (!rendererRuntimeLogged) {
          rendererRuntimeLogged = true;
          console.info(`[terminal-render-web] renderer=${kind}`);
        }
        setRendererKind(kind);

        disposable = term.onData((data: string) => {
          if (readOnlyRef.current) return;
          onInputRef.current(data);
        });

        requestAnimationFrame(() => {
          try {
            applyFitIfEnabled(true);
            setReady(true);
            if (!readOnlyRef.current) term.focus();
            for (const chunk of pendingWritesRef.current) term.write(chunk);
            pendingWritesRef.current = [];
          } catch {}
        });

        if (cancelled) {
          disposable.dispose();
          term.dispose();
        }
      }

      try {
        init();
      } catch (error) {
        console.error('[terminal-render-web] failed to initialize terminal renderer', error);
      }

      return () => {
        cancelled = true;
        lastReportedSizeRef.current = null;
        resizeObserverRef.current?.disconnect();
        resizeObserverRef.current = null;
        disposable?.dispose();
        termForCleanup?.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
      };
    }, [fontSize, sizingMode]);

    useEffect(() => {
      if (sizingMode !== 'fit') return;
      const container = containerRef.current;
      if (!container || typeof ResizeObserver === 'undefined') return;

      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const { width, height } = entry.contentRect;
        if (width <= 0 || height <= 0) return;
        requestAnimationFrame(() => {
          applyFitIfEnabled(false);
        });
      });

      observer.observe(container);
      resizeObserverRef.current = observer;

      return () => {
        observer.disconnect();
        if (resizeObserverRef.current === observer) {
          resizeObserverRef.current = null;
        }
      };
    }, [sizingMode]);

    return (
      <div
        ref={containerRef}
        data-terminal-renderer={rendererKind || 'pending'}
        className={className}
        style={{
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          background: TERMINAL_THEME.background,
          opacity: ready ? 1 : 0,
          transition: 'opacity 200ms ease',
          ...style,
        }}
      />
    );
  },
);

GhosttyTerminalView.displayName = 'GhosttyTerminalView';
