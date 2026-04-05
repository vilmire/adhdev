import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import '@xterm/xterm/css/xterm.css';

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
  className?: string;
  style?: React.CSSProperties;
}

const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;

type TerminalLike = {
  cols: number;
  rows: number;
  write: (data: string) => void;
  clear: () => void;
  reset?: () => void;
  resize?: (cols: number, rows: number) => void;
  open: (host: HTMLElement) => void;
  dispose: () => void;
  onData: (listener: (data: string) => void) => { dispose: () => void };
  focus?: () => void;
  blur?: () => void;
};

type FitAddonLike = {
  fit: () => void;
};

type TerminalCtor = new (options: Record<string, unknown>) => TerminalLike;
type FitAddonCtor = new () => FitAddonLike;

interface RendererRuntime {
  kind: 'ghostty-web';
  Terminal: TerminalCtor;
  FitAddon: FitAddonCtor;
}

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

let terminalRuntimePromise: Promise<RendererRuntime> | null = null;
let rendererRuntimeLogged = false;

async function loadRendererRuntime(): Promise<RendererRuntime> {
  if (!terminalRuntimePromise) {
    terminalRuntimePromise = (async () => {
      const ghostty = await import('ghostty-web');
      if (typeof ghostty.init === 'function') {
        await ghostty.init();
      }
      return {
        kind: 'ghostty-web',
        Terminal: ghostty.Terminal as TerminalCtor,
        FitAddon: ghostty.FitAddon as FitAddonCtor,
      };
    })();
  }
  return terminalRuntimePromise;
}

export const GhosttyTerminalView = forwardRef<TerminalRendererHandle, GhosttyTerminalViewProps>(
  ({ onInput, onResize, fontSize = 13, readOnly = false, className, style }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<TerminalLike | null>(null);
    const fitAddonRef = useRef<FitAddonLike | null>(null);
    const pendingWritesRef = useRef<string[]>([]);
    const onInputRef = useRef(onInput);
    const onResizeRef = useRef(onResize);
    const readOnlyRef = useRef(readOnly);
    const lastReportedSizeRef = useRef<{ cols: number; rows: number } | null>(null);
    const [ready, setReady] = useState(false);
    const [rendererKind, setRendererKind] = useState<'ghostty-web' | null>(null);

    const fitAndReport = (force = false) => {
      try {
        fitAddonRef.current?.fit();
        const term = terminalRef.current;
        if (!term) return;
        const cols = term.cols;
        const rows = term.rows;
        const last = lastReportedSizeRef.current;
        if (force || !last || last.cols !== cols || last.rows !== rows) {
          lastReportedSizeRef.current = { cols, rows };
          onResizeRef.current?.(cols, rows);
        }
      } catch {}
    };

    useEffect(() => {
      onInputRef.current = onInput;
    }, [onInput]);

    useEffect(() => {
      onResizeRef.current = onResize;
    }, [onResize]);

    useEffect(() => {
      readOnlyRef.current = readOnly;
      if (!readOnly) return;
      try {
        terminalRef.current?.blur?.();
      } catch {}
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
        if (terminalRef.current?.reset) terminalRef.current.reset();
        else pendingWritesRef.current = [];
      },
      resize: (cols: number, rows: number) => {
        if (terminalRef.current?.resize) {
          terminalRef.current.resize(cols, rows);
          lastReportedSizeRef.current = { cols, rows };
        }
      },
      fit: () => {
        fitAndReport(true);
      },
      bumpResize: () => {
        fitAndReport(false);
      },
    }), []);

    useEffect(() => {
      let cancelled = false;
      let disposable: { dispose: () => void } | null = null;
      let termForCleanup: TerminalLike | null = null;

      async function init(): Promise<void> {
        if (!containerRef.current) return;
        const runtime = await loadRendererRuntime();
        if (cancelled || !containerRef.current) return;

        const term = new runtime.Terminal({
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

        const fitAddon = new runtime.FitAddon();
        term.open(containerRef.current);
        if ((term as any).loadAddon) {
          (term as any).loadAddon(fitAddon);
        }

        terminalRef.current = term;
        termForCleanup = term;
        fitAddonRef.current = fitAddon;
        setRendererKind(runtime.kind);
        if (!rendererRuntimeLogged) {
          rendererRuntimeLogged = true;
          console.info(`[terminal-render-web] renderer=${runtime.kind}`);
        }

        disposable = term.onData((data: string) => {
          if (readOnlyRef.current) return;
          onInputRef.current(data);
        });

        requestAnimationFrame(() => {
          try {
            setReady(true);
            if (!readOnlyRef.current) term.focus?.();
            for (const chunk of pendingWritesRef.current) term.write(chunk);
            pendingWritesRef.current = [];
          } catch {}
        });

        if (cancelled) {
          disposable.dispose();
          term.dispose();
        }
      }

      init().catch((error) => {
        console.error('[terminal-render-web] failed to initialize terminal renderer', error);
      });

      return () => {
        cancelled = true;
        lastReportedSizeRef.current = null;
        disposable?.dispose();
        termForCleanup?.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
      };
    }, [fontSize]);

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
