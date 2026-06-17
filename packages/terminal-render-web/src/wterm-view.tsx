/**
 * WtermTerminalView — opt-in alternative renderer backed by @wterm/ghostty
 * (browser libghostty, WASM VT core) + @wterm/dom (DOM grid renderer).
 *
 * Sibling to the default xterm-based GhosttyTerminalView. Implements the SAME
 * TerminalRendererHandle / GhosttyTerminalViewProps surface so CliTerminal can
 * drive either renderer interchangeably; selected only when explicitly toggled
 * (settings flag / localStorage / env) — see selectTerminalRendererBackend() in
 * index.tsx.
 *
 * Production notes:
 *  - @wterm/dom CSS is imported so the grid scrolls (`.wterm.has-scrollback`
 *    becomes `overflow-y:auto`) and native text selection works (`::selection`).
 *  - ADHDev's catppuccin palette is mapped onto wterm's `--term-color-*` /
 *    `--term-fg` / `--term-bg` / `--term-cursor` CSS vars for visual parity with
 *    the xterm renderer (wterm emits `var(--term-color-N)` for the 16 ANSI
 *    colors; 256-color/RGB resolve to fixed rgb()).
 *  - fontSize is driven via `--term-font-size`; changes retrigger wterm's
 *    char-size measurement via a resize round-trip.
 *  - In `measured` sizing mode (the dashboard default) wterm's own ResizeObserver
 *    is disabled (autoResize=false), so we observe the container ourselves and
 *    call WTerm.resize(cols, rows) to reflow.
 *  - clear()/reset() write a RIS (ESC c) full reset — verified to clear the
 *    active screen, scrollback and exit alt-screen (see poc-playground P0-1).
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
// Structural + selection CSS for the wterm DOM grid (scroll/overflow/::selection).
// Import the concrete `.css` path (not the `@wterm/dom/css` subpath) so it
// matches the standard `declare module '*.css'` ambient and type-checks in
// strict consumers (web-cloud's `tsc -b`) without a custom module declaration.
import '@wterm/dom/src/terminal.css';
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

// RIS — full reset (clears screen + scrollback, exits alt-screen). Used to
// emulate xterm's clear()/reset() which @wterm/dom does not expose directly.
const RIS = '\x1bc';

const TERMINAL_BACKGROUND = '#0f1117';

// ADHDev catppuccin palette → wterm CSS variables, for visual parity with the
// xterm TERMINAL_THEME. Index order matches ANSI 0..15 (black..brightWhite).
const WTERM_THEME_VARS: Record<string, string> = {
  '--term-bg': '#0f1117',
  '--term-fg': '#cdd6f4',
  '--term-cursor': '#f38ba8',
  '--term-color-0': '#45475a', // black
  '--term-color-1': '#f38ba8', // red
  '--term-color-2': '#a6e3a1', // green
  '--term-color-3': '#f9e2af', // yellow
  '--term-color-4': '#89b4fa', // blue
  '--term-color-5': '#cba6f7', // magenta
  '--term-color-6': '#94e2d5', // cyan
  '--term-color-7': '#bac2de', // white
  '--term-color-8': '#585b70', // brightBlack
  '--term-color-9': '#f38ba8', // brightRed
  '--term-color-10': '#a6e3a1', // brightGreen
  '--term-color-11': '#f9e2af', // brightYellow
  '--term-color-12': '#89b4fa', // brightBlue
  '--term-color-13': '#cba6f7', // brightMagenta
  '--term-color-14': '#94e2d5', // brightCyan
  '--term-color-15': '#a6adc8', // brightWhite
  '--term-line-height': '1.2',
  '--term-font-family': "'JetBrains Mono', 'Fira Code', 'SF Mono', 'Menlo', monospace",
  // .wterm default has padding/border-radius/box-shadow chrome; the dashboard
  // supplies its own chrome, so zero it out for a flush fill.
  '--term-row-height': '17px',
};

const applyThemeVars = (el: HTMLElement, fontSize: number) => {
  for (const [k, v] of Object.entries(WTERM_THEME_VARS)) {
    el.style.setProperty(k, v);
  }
  el.style.setProperty('--term-font-size', `${fontSize}px`);
  el.style.setProperty('--term-row-height', `${Math.round(fontSize * 1.2)}px`);
  // Neutralize wterm's default decorative chrome inside the dashboard frame.
  el.style.padding = '0';
  el.style.borderRadius = '0';
  el.style.boxShadow = 'none';
  el.style.background = 'transparent';
  el.style.height = '100%';
  el.style.width = '100%';
};

// libghostty resolves the 16 ANSI palette colors to RGB *inside the WASM* using
// its baked "Tomorrow Night" palette, and `getCell` returns that as `fgRgb`/
// `bgRgb` — bypassing the `--term-color-*` CSS vars entirely for live output.
// There is no palette-injection API on the core, so we remap the known ghostty
// palette RGBs to ADHDev catppuccin at the cell-read boundary for visual parity
// with the xterm renderer. (Seed-replayed cells use index colors and are themed
// via the CSS vars; only core-resolved RGB needs this remap.)
const GHOSTTY_TO_CATPPUCCIN: Record<number, number> = {
  0x1d1f21: 0x45475a, 0xcc6666: 0xf38ba8, 0xb5bd68: 0xa6e3a1, 0xf0c674: 0xf9e2af,
  0x81a2be: 0x89b4fa, 0xb294bb: 0xcba6f7, 0x8abeb7: 0x94e2d5, 0xc5c8c6: 0xbac2de,
  0x666666: 0x585b70, 0xd54e53: 0xf38ba8, 0xb9ca4a: 0xa6e3a1, 0xe7c547: 0xf9e2af,
  0x7aa6da: 0x89b4fa, 0xc397d8: 0xcba6f7, 0x70c0b1: 0x94e2d5, 0xeaeaea: 0xa6adc8,
};
const remapRgb = (v: number | undefined): number | undefined =>
  v === undefined ? v : (GHOSTTY_TO_CATPPUCCIN[v >>> 0] ?? v);

/**
 * Wrap a TerminalCore so cell reads remap ghostty's baked palette RGB to the
 * ADHDev catppuccin palette. Only getCell/getScrollbackCell carry color; all
 * other methods pass through.
 */
function withCatppuccinPalette(core: TerminalCore): TerminalCore {
  // Use a JS Proxy so `this` stays bound to the real core (its methods touch
  // private WASM-pointer fields), while only getCell/getScrollbackCell return
  // values are post-processed.
  return new Proxy(core, {
    get(target, prop, receiver) {
      if (prop === 'getCell') {
        return (row: number, col: number) => {
          const cell = target.getCell(row, col);
          return { ...cell, fgRgb: remapRgb(cell.fgRgb), bgRgb: remapRgb(cell.bgRgb) };
        };
      }
      if (prop === 'getScrollbackCell') {
        return (offset: number, col: number) => {
          const cell = target.getScrollbackCell(offset, col);
          return { ...cell, fgRgb: remapRgb(cell.fgRgb), bgRgb: remapRgb(cell.bgRgb) };
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as TerminalCore;
}

let wtermRuntimeLogged = false;

async function loadGhosttyCore(scrollback: number): Promise<TerminalCore> {
  const core = await GhosttyCore.load({ scrollbackLimit: scrollback });
  return withCatppuccinPalette(core as unknown as TerminalCore);
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
    const fontSizeRef = useRef(fontSize);
    const sizingModeRef = useRef(sizingMode);
    const lastReportedSizeRef = useRef<{ cols: number; rows: number } | null>(null);
    const resizeObserverRef = useRef<ResizeObserver | null>(null);
    const [ready, setReady] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);

    useEffect(() => { onInputRef.current = onInput; }, [onInput]);
    useEffect(() => { onResizeRef.current = onResize; }, [onResize]);
    useEffect(() => { onViewportMetricsRef.current = onViewportMetrics; }, [onViewportMetrics]);
    useEffect(() => { onScrollMetricsRef.current = onScrollMetrics; }, [onScrollMetrics]);
    useEffect(() => { readOnlyRef.current = readOnly; }, [readOnly]);
    useEffect(() => { sizingModeRef.current = sizingMode; }, [sizingMode]);

    // WTerm adds the `.wterm` class to the element it is constructed with
    // (containerRef.current), NOT a child. Match either to be safe.
    const getWtermEl = (): HTMLElement | null => {
      const host = containerRef.current;
      if (!host) return null;
      if (host.classList.contains('wterm')) return host;
      return host.querySelector('.wterm') as HTMLElement | null;
    };
    // The scrollable element is `.wterm` itself (overflow-y:auto when has-scrollback).
    const getScrollEl = () => getWtermEl() || containerRef.current;

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

    // Measure how many cols/rows fit the container and resize the core to match.
    // wterm only auto-resizes in autoResize mode; in measured mode we drive it.
    // Pin the scroll element to the bottom over a few animation frames, to win
    // the race against wterm's own rAF-scheduled re-render after a resize.
    const pinToBottom = (framesLeft: number) => {
      const el = getScrollEl();
      if (el && el.scrollHeight > el.clientHeight) {
        el.scrollTop = el.scrollHeight;
      }
      reportScrollMetrics();
      if (framesLeft > 0) {
        requestAnimationFrame(() => pinToBottom(framesLeft - 1));
      }
    };

    // Derive the per-character advance width. wterm renders each color run as a
    // single span, so a span's width must be divided by its character count —
    // NOT used directly (a full-line run is ~the row width).
    const measureCharWidth = (el: HTMLElement): number => {
      const spans = el.querySelectorAll('.term-row > span');
      for (const sp of Array.from(spans)) {
        const len = (sp.textContent || '').length;
        const w = (sp as HTMLElement).getBoundingClientRect().width;
        if (len > 0 && w > 0) return w / len;
      }
      // Fallback: monospace advance ≈ 0.6em.
      return (fontSizeRef.current || 13) * 0.6;
    };

    const measureAndResize = () => {
      const wt = wtermRef.current;
      const host = containerRef.current;
      if (!wt || !host) return;
      const el = getWtermEl();
      if (!el) return;
      const rowHeight = Math.max(1, Math.round((fontSizeRef.current || 13) * 1.2));
      const charWidth = measureCharWidth(el);
      const availW = host.clientWidth;
      const availH = host.clientHeight;
      if (availW <= 0 || availH <= 0 || charWidth <= 0) return;
      const cols = Math.max(2, Math.floor(availW / charWidth));
      const rows = Math.max(1, Math.floor(availH / rowHeight));
      const last = lastReportedSizeRef.current;
      if (last && last.cols === cols && last.rows === rows) return;
      try {
        wt.resize(cols, rows);
        lastReportedSizeRef.current = { cols, rows };
        onResizeRef.current?.(cols, rows);
        // After a reflow, content shifts into scrollback. wterm re-renders on
        // its own rAF, so pin to the latest output across a few frames to win
        // the race with that render (otherwise the viewport shows blank top
        // padding rows). Matches the live-streaming dashboard expectation of
        // staying at the newest output after a resize.
        pinToBottom(4);
      } catch {}
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
          // wterm renders synchronously on write (raf-batched paint follows), so
          // the parser has consumed the bytes by the time write() returns.
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
        measureAndResize();
        requestAnimationFrame(() => reportViewportMetrics());
      },
      bumpResize: () => {
        if (sizingModeRef.current !== 'fit') measureAndResize();
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
          const text = sel?.toString() || '';
          // Only return selection that lives inside this terminal's DOM.
          if (text && sel && containerRef.current) {
            const anchor = sel.anchorNode;
            if (anchor && containerRef.current.contains(anchor)) return text;
            return '';
          }
          return '';
        } catch {
          return '';
        }
      },
      getVisibleText,
    }), []);

    // Main lifecycle: load core, mount WTerm, apply theme, flush pending writes.
    useEffect(() => {
      let cancelled = false;
      let wt: WTerm | null = null;

      async function init(): Promise<void> {
        if (!containerRef.current) return;
        try {
          const core = await loadGhosttyCore(50000);
          if (cancelled || !containerRef.current) return;

          wt = new WTerm(containerRef.current, {
            cols: DEFAULT_SESSION_HOST_COLS,
            rows: DEFAULT_SESSION_HOST_ROWS,
            core,
            // In measured mode we manage resize ourselves; only let wterm's
            // own ResizeObserver run in fit mode.
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

          // Apply ADHDev theme + font size to the freshly-created .wterm element.
          const wtEl = getWtermEl();
          if (wtEl) applyThemeVars(wtEl, fontSizeRef.current);

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
            if (sizingModeRef.current !== 'fit') measureAndResize();
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
      // sizingMode change recreates the terminal (parity with xterm renderer).
    }, [sizingMode]);

    // fontSize change: update CSS var + retrigger char measurement / reflow.
    useEffect(() => {
      fontSizeRef.current = fontSize;
      const wtEl = getWtermEl();
      if (!wtEl || !wtermRef.current) return;
      wtEl.style.setProperty('--term-font-size', `${fontSize}px`);
      wtEl.style.setProperty('--term-row-height', `${Math.round(fontSize * 1.2)}px`);
      requestAnimationFrame(() => {
        if (sizingModeRef.current !== 'fit') measureAndResize();
        reportViewportMetrics();
      });
    }, [fontSize]);

    // Measured-mode container ResizeObserver → reflow the grid. (fit mode uses
    // wterm's own observer.)
    useEffect(() => {
      if (sizingMode === 'fit') return;
      const host = containerRef.current;
      const Ctor = host?.ownerDocument?.defaultView?.ResizeObserver;
      if (!host || !Ctor) return;
      const obs = new Ctor((entries) => {
        const e = entries[0];
        if (!e) return;
        const { width, height } = e.contentRect;
        if (width <= 0 || height <= 0) return;
        requestAnimationFrame(() => {
          measureAndResize();
          reportViewportMetrics();
        });
      });
      obs.observe(host);
      resizeObserverRef.current = obs;
      return () => {
        obs.disconnect();
        if (resizeObserverRef.current === obs) resizeObserverRef.current = null;
      };
    }, [sizingMode, ready]);

    // Scroll metric reporting on the scrollable element.
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
            style={{ width: '100%', height: '100%', overflow: 'hidden' }}
          />
        )}
      </div>
    );
  },
);

WtermTerminalView.displayName = 'WtermTerminalView';
