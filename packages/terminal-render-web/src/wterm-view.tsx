/**
 * WtermTerminalView — Phase0 PoC alternative renderer backed by @wterm/ghostty
 * (browser libghostty, WASM VT core) + @wterm/dom (DOM grid renderer).
 *
 * This is an experimental, opt-in sibling to the xterm-based GhosttyTerminalView.
 * It implements the SAME TerminalRendererHandle / GhosttyTerminalViewProps surface
 * so CliTerminal can drive either renderer interchangeably. It is selected only
 * when explicitly toggled (env flag or prop) — see selectRenderer() in index.tsx.
 *
 * Known PoC limitations (intentionally not papered over):
 *  - @wterm/dom WTerm exposes only write/resize/focus/destroy. clear/reset are
 *    emulated by writing a RIS (ESC c) reset sequence. There is no scrollback
 *    "scrollToTop" API; we best-effort scroll the DOM container.
 *  - getVisibleText() walks the libghostty core cell grid via WTerm.bridge.
 *  - getSelection() relies on the browser DOM selection inside the grid.
 *  - There is NO addon-serialize equivalent: the core exposes a cell read API
 *    (getCell/getScrollbackCell/...) but not an ANSI re-emission serializer.
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { WTerm, type TerminalCore } from '@wterm/dom';
import { GhosttyCore } from '@wterm/ghostty';
import { sanitizeTerminalInputForProvider } from './input-sanitizer';
import type {
  GhosttyTerminalViewProps,
  TerminalRendererHandle,
} from './types';

const DEFAULT_SESSION_HOST_COLS = 80;
const DEFAULT_SESSION_HOST_ROWS = 32;
const TERMINAL_CHROME_PADDING_Y = 8;
const TERMINAL_CHROME_PADDING_X = 14;

// RIS — full reset; used to emulate xterm's clear()/reset() which @wterm/dom lacks.
const RIS = '\x1bc';

const TERMINAL_BACKGROUND = '#0f1117';

let wtermRuntimeLogged = false;

/**
 * Lazily-loaded singleton-ish ghostty core loader. Each WTerm instance needs its
 * own core (the core holds the terminal grid state), so we load a fresh core per
 * mount but cache the failure to avoid hammering on a broken WASM fetch.
 */
async function loadGhosttyCore(scrollback: number): Promise<TerminalCore> {
  const core = await GhosttyCore.load({ scrollbackLimit: scrollback });
  return core as unknown as TerminalCore;
}

export const WtermTerminalView = forwardRef<TerminalRendererHandle, GhosttyTerminalViewProps>(
  ({ onInput, onResize, onViewportMetrics, onScrollMetrics, fontSize = 13, readOnly = false, sizingMode = 'measured', className, style }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const wtermRef = useRef<WTerm | null>(null);
    const pendingWritesRef = useRef<Array<{ data: string; onProcessed?: () => void }>>([]);
    const onInputRef = useRef(onInput);
    const onResizeRef = useRef(onResize);
    const onViewportMetricsRef = useRef(onViewportMetrics);
    const onScrollMetricsRef = useRef(onScrollMetrics);
    const readOnlyRef = useRef(readOnly);
    const lastReportedSizeRef = useRef<{ cols: number; rows: number } | null>(null);
    const [ready, setReady] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);

    useEffect(() => { onInputRef.current = onInput; }, [onInput]);
    useEffect(() => { onResizeRef.current = onResize; }, [onResize]);
    useEffect(() => { onViewportMetricsRef.current = onViewportMetrics; }, [onViewportMetrics]);
    useEffect(() => { onScrollMetricsRef.current = onScrollMetrics; }, [onScrollMetrics]);
    useEffect(() => { readOnlyRef.current = readOnly; }, [readOnly]);

    const getScrollEl = () =>
      (containerRef.current?.querySelector('.wterm') as HTMLElement | null) || containerRef.current;

    const reportViewportMetrics = () => {
      const el = getScrollEl();
      if (!el) return;
      const width = Math.max(el.clientWidth || 0, el.scrollWidth || 0) + TERMINAL_CHROME_PADDING_X * 2;
      const height = Math.max(el.clientHeight || 0, el.scrollHeight || 0) + TERMINAL_CHROME_PADDING_Y * 2;
      if (width <= 0 || height <= 0) return;
      onViewportMetricsRef.current?.({ width, height });
      reportScrollMetrics();
    };

    const reportScrollMetrics = () => {
      const el = getScrollEl();
      if (!el) return;
      const scrollTop = el.scrollTop;
      const scrollHeight = el.scrollHeight;
      const clientHeight = el.clientHeight;
      const canScroll = scrollHeight > clientHeight + 2;
      onScrollMetricsRef.current?.({
        scrollTop,
        scrollHeight,
        clientHeight,
        canScroll,
        atTop: canScroll && scrollTop <= 2,
      });
    };

    const getVisibleText = (): string => {
      const bridge = wtermRef.current?.bridge;
      if (!bridge) return '';
      try {
        const rows = bridge.getRows();
        const cols = bridge.getCols();
        const lines: string[] = [];
        for (let r = 0; r < rows; r += 1) {
          let line = '';
          for (let c = 0; c < cols; c += 1) {
            const cell = bridge.getCell(r, c);
            const code = cell?.char ?? 0;
            line += code > 0 ? String.fromCodePoint(code) : ' ';
          }
          lines.push(line.replace(/\s+$/g, ''));
        }
        return lines.join('\n').replace(/[\s\n]+$/g, '');
      } catch {
        return '';
      }
    };

    useImperativeHandle(ref, () => ({
      write: (data: string, onProcessed?: () => void) => {
        const wt = wtermRef.current;
        if (wt) {
          wt.write(data);
          onProcessed?.();
        } else {
          pendingWritesRef.current.push({ data, onProcessed });
        }
      },
      clear: () => {
        const wt = wtermRef.current;
        if (wt) wt.write(RIS);
        else pendingWritesRef.current = [];
      },
      reset: () => {
        const wt = wtermRef.current;
        if (wt) wt.write(RIS);
        else pendingWritesRef.current = [];
      },
      resize: (cols: number, rows: number) => {
        const wt = wtermRef.current;
        if (!wt) return;
        try {
          wt.resize(cols, rows);
          lastReportedSizeRef.current = { cols, rows };
        } catch {}
        requestAnimationFrame(() => reportViewportMetrics());
      },
      fit: () => {
        // @wterm/dom autoResize handles sizing from the container; report best-effort.
        requestAnimationFrame(() => reportViewportMetrics());
      },
      bumpResize: () => {
        requestAnimationFrame(() => reportViewportMetrics());
      },
      scrollToTop: () => {
        const el = getScrollEl();
        if (el) el.scrollTop = 0;
        reportScrollMetrics();
      },
      getSelection: () => {
        try {
          const sel = containerRef.current?.ownerDocument?.getSelection?.();
          return sel?.toString() || '';
        } catch {
          return '';
        }
      },
      getVisibleText,
    }), []);

    useEffect(() => {
      let cancelled = false;
      let wt: WTerm | null = null;

      async function init(): Promise<void> {
        if (!containerRef.current) return;
        try {
          const core = await loadGhosttyCore(10000);
          if (cancelled || !containerRef.current) return;

          wt = new WTerm(containerRef.current, {
            cols: DEFAULT_SESSION_HOST_COLS,
            rows: DEFAULT_SESSION_HOST_ROWS,
            core,
            autoResize: sizingMode === 'fit',
            cursorBlink: true,
            onData: (data: string) => {
              if (readOnlyRef.current) return;
              const clean = sanitizeTerminalInputForProvider(data);
              if (!clean) return;
              onInputRef.current(clean);
            },
            onResize: (cols: number, rows: number) => {
              const last = lastReportedSizeRef.current;
              if (!last || last.cols !== cols || last.rows !== rows) {
                lastReportedSizeRef.current = { cols, rows };
                onResizeRef.current?.(cols, rows);
              }
              requestAnimationFrame(() => reportViewportMetrics());
            },
          });

          await wt.init();
          if (cancelled) {
            wt.destroy();
            return;
          }

          wtermRef.current = wt;

          if (!wtermRuntimeLogged) {
            wtermRuntimeLogged = true;
            // eslint-disable-next-line no-console
            console.info('[terminal-render-web] renderer=wterm-ghostty (libghostty WASM)');
          }

          for (const chunk of pendingWritesRef.current) {
            wt.write(chunk.data);
            chunk.onProcessed?.();
          }
          pendingWritesRef.current = [];

          if (!readOnlyRef.current) {
            try { wt.focus(); } catch {}
          }

          setReady(true);
          requestAnimationFrame(() => {
            reportViewportMetrics();
            reportScrollMetrics();
          });
        } catch (error: any) {
          if (cancelled) return;
          const message = error?.message || String(error);
          // eslint-disable-next-line no-console
          console.error('[terminal-render-web] wterm-ghostty init failed', error);
          setLoadError(message);
        }
      }

      void init();

      return () => {
        cancelled = true;
        lastReportedSizeRef.current = null;
        try { wt?.destroy(); } catch {}
        wtermRef.current = null;
      };
      // sizingMode change recreates the terminal (parity with xterm renderer)
    }, [sizingMode]);

    // Scroll metric reporting on container scroll.
    useEffect(() => {
      const el = getScrollEl();
      if (!el) return;
      const onScroll = () => reportScrollMetrics();
      el.addEventListener('scroll', onScroll, { passive: true });
      return () => el.removeEventListener('scroll', onScroll);
    }, [ready]);

    return (
      <div
        data-terminal-renderer={loadError ? 'wterm-error' : ready ? 'wterm-ghostty' : 'wterm-pending'}
        className={['adhdev-terminal-renderer', 'adhdev-terminal-renderer--wterm', className].filter(Boolean).join(' ')}
        style={{
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          background: TERMINAL_BACKGROUND,
          padding: `${TERMINAL_CHROME_PADDING_Y}px ${TERMINAL_CHROME_PADDING_X}px`,
          boxSizing: 'border-box',
          opacity: ready ? 1 : loadError ? 1 : 0,
          transition: 'opacity 200ms ease',
          ...style,
        }}
      >
        {loadError ? (
          <div style={{ color: '#f38ba8', fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>
            {`[wterm-ghostty] renderer failed to load:\n${loadError}`}
          </div>
        ) : (
          <div
            ref={containerRef}
            className="adhdev-terminal-renderer-mount h-full w-full"
            style={{ width: '100%', height: '100%', overflow: 'auto', fontSize }}
          />
        )}
      </div>
    );
  },
);

WtermTerminalView.displayName = 'WtermTerminalView';
