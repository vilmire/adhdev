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
import { FitAddon } from '@xterm/addon-fit';
import { DEFAULT_SESSION_HOST_COLS, DEFAULT_SESSION_HOST_ROWS } from '@adhdev/session-host-core/defaults';

export interface TerminalRendererHandle {
  write: (data: string, onProcessed?: () => void) => void;
  clear: () => void;
  reset: () => void;
  resize: (cols: number, rows: number) => void;
  fit: () => void;
  bumpResize: () => void;
  scrollToTop: () => void;
  getSelection: () => string;
  getVisibleText: () => string;
}

export interface GhosttyTerminalViewProps {
  onInput: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onViewportMetrics?: (metrics: { width: number; height: number }) => void;
  onScrollMetrics?: (metrics: { scrollTop: number; scrollHeight: number; clientHeight: number; atTop: boolean; canScroll: boolean }) => void;
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

type RendererKind = 'webgl' | 'dom';

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

const TERMINAL_CHROME_PADDING_Y = 8;
const TERMINAL_CHROME_PADDING_X = 14;
const TERMINAL_REPLAY_SCROLLBACK_ROWS = 50000;

const TERMINAL_CHROME_CSS = `
  .adhdev-terminal-renderer .xterm-viewport {
    scrollbar-width: thin;
    scrollbar-color: rgba(137, 180, 250, 0.45) rgba(255, 255, 255, 0.04);
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    touch-action: pan-y;
  }

  .adhdev-terminal-renderer .xterm-screen,
  .adhdev-terminal-renderer .xterm-rows {
    touch-action: pan-y;
    -webkit-touch-callout: default;
  }

  .adhdev-terminal-renderer .xterm-viewport::-webkit-scrollbar {
    width: 10px;
    height: 10px;
  }

  .adhdev-terminal-renderer .xterm-viewport::-webkit-scrollbar-track {
    background: rgba(255, 255, 255, 0.04);
    border-radius: 999px;
  }

  .adhdev-terminal-renderer .xterm-viewport::-webkit-scrollbar-thumb {
    background: linear-gradient(180deg, rgba(137, 180, 250, 0.5), rgba(203, 166, 247, 0.45));
    border-radius: 999px;
    border: 2px solid rgba(15, 17, 23, 0.9);
  }
`;

let rendererRuntimeLogged = false;

const restoreViewportAfterLocalInput = (term: Terminal, viewportYBeforeInput: number, baseYBeforeInput: number): boolean => {
  if (viewportYBeforeInput >= baseYBeforeInput) return false;
  const buffer = term.buffer.active;
  if (!buffer) return false;
  if (buffer.baseY !== baseYBeforeInput) return false;
  if (buffer.viewportY === viewportYBeforeInput) return false;
  try {
    term.scrollLines(viewportYBeforeInput - buffer.viewportY);
    return term.buffer.active.viewportY === viewportYBeforeInput;
  } catch {
    return false;
  }
};

const preserveViewportAfterLocalInput = (term: Terminal) => {
  const bufferBeforeInput = term.buffer.active;
  if (!bufferBeforeInput) return undefined;
  const viewportYBeforeInput = bufferBeforeInput.viewportY;
  const baseYBeforeInput = bufferBeforeInput.baseY;
  if (viewportYBeforeInput >= baseYBeforeInput) return;
  return () => restoreViewportAfterLocalInput(term, viewportYBeforeInput, baseYBeforeInput);
};

export const GhosttyTerminalView = forwardRef<TerminalRendererHandle, GhosttyTerminalViewProps>(
  ({ onInput, onResize, onViewportMetrics, onScrollMetrics, fontSize = 13, readOnly = false, sizingMode = 'measured', className, style }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const resizeObserverRef = useRef<ResizeObserver | null>(null);
    const pendingWritesRef = useRef<Array<{ data: string; onProcessed?: () => void }>>([]);
    const pendingLocalInputViewportRestoreRef = useRef<(() => boolean) | null>(null);
    const onInputRef = useRef(onInput);
    const onResizeRef = useRef(onResize);
    const onViewportMetricsRef = useRef(onViewportMetrics);
    const onScrollMetricsRef = useRef(onScrollMetrics);
    const readOnlyRef = useRef(readOnly);
    const lastReportedSizeRef = useRef<{ cols: number; rows: number } | null>(null);
    const [ready, setReady] = useState(false);
    const [rendererKind, setRendererKind] = useState<RendererKind | null>(null);

    const getOwnerWindow = () => containerRef.current?.ownerDocument?.defaultView || window;
    const scheduleInOwnerWindow = (callback: FrameRequestCallback) => {
      const ownerWindow = getOwnerWindow();
      return ownerWindow.requestAnimationFrame(callback);
    };

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
    useEffect(() => { onViewportMetricsRef.current = onViewportMetrics; }, [onViewportMetrics]);
    useEffect(() => { onScrollMetricsRef.current = onScrollMetrics; }, [onScrollMetrics]);

    const getViewportElement = () => containerRef.current?.querySelector('.xterm-viewport') as HTMLElement | null;

    const reportScrollMetrics = () => {
      const viewport = getViewportElement();
      if (!viewport) return;
      const scrollTop = viewport.scrollTop;
      const scrollHeight = viewport.scrollHeight;
      const clientHeight = viewport.clientHeight;
      const canScroll = scrollHeight > clientHeight + 2;
      onScrollMetricsRef.current?.({
        scrollTop,
        scrollHeight,
        clientHeight,
        canScroll,
        atTop: canScroll && scrollTop <= 2,
      });
    };

    const reportViewportMetrics = () => {
      const screen = containerRef.current?.querySelector('.xterm-screen') as HTMLElement | null;
      const viewport = containerRef.current?.querySelector('.xterm-viewport') as HTMLElement | null;
      const target = screen || viewport;
      if (!target) return;
      let width = Math.max(target.clientWidth || 0, target.scrollWidth || 0);
      let height = Math.max(target.clientHeight || 0, target.scrollHeight || 0);
      if (width <= 0 || height <= 0) return;
      width += TERMINAL_CHROME_PADDING_X * 2;
      height += TERMINAL_CHROME_PADDING_Y * 2;
      onViewportMetricsRef.current?.({ width, height });
      reportScrollMetrics();
    };

    const getVisibleText = () => {
      const term = terminalRef.current;
      const buffer = term?.buffer?.active;
      if (!term || !buffer) return '';
      const start = Math.max(0, buffer.viewportY || 0);
      const end = Math.min(buffer.length, start + term.rows);
      const lines: string[] = [];
      for (let row = start; row < end; row += 1) {
        const line = buffer.getLine(row);
        lines.push(line?.translateToString(true) || '');
      }
      return lines.join('\n').replace(/[\s\n]+$/g, '');
    };

    const refreshTerminalSurface = () => {
      const term = terminalRef.current;
      if (!term) return;
      try {
        term.refresh(0, Math.max(0, term.rows - 1));
      } catch {}
      reportViewportMetrics();
    };

    const restorePreservedLocalInputViewport = (restore: (() => boolean) | null | undefined) => {
      if (!restore) return;
      if (!restore()) return;
      reportScrollMetrics();
      refreshTerminalSurface();
    };

    useEffect(() => {
      readOnlyRef.current = readOnly;
      if (!readOnly) return;
      try { terminalRef.current?.blur(); } catch {}
      try {
        const activeElement = containerRef.current?.ownerDocument?.activeElement;
        if (activeElement instanceof HTMLElement && containerRef.current?.contains(activeElement)) {
          activeElement.blur();
        }
      } catch {}
    }, [readOnly]);

    useImperativeHandle(ref, () => ({
      write: (data: string, onProcessed?: () => void) => {
        if (terminalRef.current) terminalRef.current.write(data, onProcessed);
        else pendingWritesRef.current.push({ data, onProcessed });
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
          scheduleInOwnerWindow(() => {
            reportViewportMetrics();
          });
        }
      },
      fit: () => applyFitIfEnabled(true),
      bumpResize: () => {
        if (sizingMode === 'fit') applyFitIfEnabled(false);
        else scheduleInOwnerWindow(() => {
          refreshTerminalSurface();
        });
      },
      scrollToTop: () => {
        const scroll = (remainingAttempts = 4) => {
          const term = terminalRef.current;
          if (!term) return;
          try { term.scrollToTop(); } catch {}
          reportScrollMetrics();
          refreshTerminalSurface();
          if (remainingAttempts > 0) {
            scheduleInOwnerWindow(() => scroll(remainingAttempts - 1));
          }
        };
        scroll();
      },
      getSelection: () => terminalRef.current?.getSelection?.() || '',
      getVisibleText,
    }), []);

    useEffect(() => {
      let cancelled = false;
      let disposable: { dispose: () => void } | null = null;
      let termForCleanup: Terminal | null = null;
      let removeTouchScrollListeners: (() => void) | null = null;
      let removeLocalInputViewportListener: (() => void) | null = null;

      function init(): void {
        if (!containerRef.current) return;
        if (cancelled) return;

        const term = new Terminal({
          cols: DEFAULT_SESSION_HOST_COLS,
          rows: DEFAULT_SESSION_HOST_ROWS,
          cursorBlink: true,
          cursorStyle: 'bar',
          cursorWidth: 8,
          fontSize,
          fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', 'Menlo', monospace",
          fontWeight: '400',
          letterSpacing: 0,
          lineHeight: 1.2,
          theme: TERMINAL_THEME,
          allowTransparency: true,
          scrollback: TERMINAL_REPLAY_SCROLLBACK_ROWS,
          scrollSensitivity: 1.15,
          fastScrollSensitivity: 4,
          smoothScrollDuration: 120,
          scrollOnUserInput: false,
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

        // WebGL → DOM fallback
        const ownerWindow = containerRef.current?.ownerDocument?.defaultView;
        const isDetachedPopoutWindow = ownerWindow?.location?.pathname === '/popout.html'
          || ownerWindow?.location?.pathname?.endsWith('/popout.html')
          || !!ownerWindow?.opener;
        let kind: RendererKind = 'dom';
        if (!isDetachedPopoutWindow) {
          try {
            const webglAddon = new WebglAddon();
            webglAddon.onContextLoss(() => {
              webglAddon.dispose();
            });
            term.loadAddon(webglAddon);
            kind = 'webgl';
          } catch {}
        }

        if (!rendererRuntimeLogged) {
          rendererRuntimeLogged = true;
          console.info(`[terminal-render-web] renderer=${kind}`);
        }
        setRendererKind(kind);

        disposable = term.onData((data: string) => {
          if (readOnlyRef.current) return;
          const restoreViewportAfterInput = pendingLocalInputViewportRestoreRef.current ?? preserveViewportAfterLocalInput(term);
          pendingLocalInputViewportRestoreRef.current = null;
          onInputRef.current(data);
          restorePreservedLocalInputViewport(restoreViewportAfterInput);
          scheduleInOwnerWindow(() => {
            restorePreservedLocalInputViewport(restoreViewportAfterInput);
          });
        });

        scheduleInOwnerWindow(() => {
          try {
            applyFitIfEnabled(true);
            reportViewportMetrics();
            reportScrollMetrics();
            setReady(true);
            if (!readOnlyRef.current) term.focus();
            for (const chunk of pendingWritesRef.current) term.write(chunk.data, chunk.onProcessed);
            pendingWritesRef.current = [];
          } catch {}
        });

        const touchContainer = containerRef.current;
        const viewport = getViewportElement();
        const scrollListener = () => reportScrollMetrics();
        viewport?.addEventListener('scroll', scrollListener, { passive: true });

        const localInputViewportKeyDown = () => {
          if (readOnlyRef.current) return;
          pendingLocalInputViewportRestoreRef.current = preserveViewportAfterLocalInput(term) || null;
        };
        touchContainer.addEventListener('keydown', localInputViewportKeyDown, { capture: true });
        removeLocalInputViewportListener = () => {
          touchContainer.removeEventListener('keydown', localInputViewportKeyDown, { capture: true });
        };

        let touchLastY: number | null = null;
        let touchPixelRemainder = 0;
        const touchListenerOptions: AddEventListenerOptions = { passive: false, capture: true };
        const passiveTouchListenerOptions: AddEventListenerOptions = { passive: true, capture: true };
        const hasScrollableTerminal = (activeViewport: HTMLElement | null) => {
          const termBuffer = terminalRef.current?.buffer?.active;
          const hasDomScroll = !!activeViewport && activeViewport.scrollHeight > activeViewport.clientHeight + 2;
          const hasXtermScrollback = !!termBuffer && !!terminalRef.current && termBuffer.length > terminalRef.current.rows;
          return hasDomScroll || hasXtermScrollback;
        };
        const getApproxLineHeight = (activeViewport: HTMLElement) => {
          const term = terminalRef.current;
          const rows = Math.max(1, term?.rows || DEFAULT_SESSION_HOST_ROWS);
          const viewportLineHeight = activeViewport.clientHeight / rows;
          if (Number.isFinite(viewportLineHeight) && viewportLineHeight > 0) return viewportLineHeight;
          const firstRow = containerRef.current?.querySelector('.xterm-rows > div') as HTMLElement | null;
          const measuredLineHeight = firstRow?.getBoundingClientRect().height || 0;
          return Number.isFinite(measuredLineHeight) && measuredLineHeight > 0 ? measuredLineHeight : fontSize * 1.2;
        };
        const touchStart = (event: TouchEvent) => {
          if (event.touches.length !== 1) {
            touchLastY = null;
            touchPixelRemainder = 0;
            return;
          }
          const activeViewport = getViewportElement();
          if (!activeViewport || !hasScrollableTerminal(activeViewport)) {
            touchLastY = null;
            touchPixelRemainder = 0;
            return;
          }
          touchLastY = event.touches[0]?.clientY ?? null;
          touchPixelRemainder = 0;
        };
        const touchMove = (event: TouchEvent) => {
          if (touchLastY === null || event.touches.length !== 1) return;
          const activeViewport = getViewportElement();
          const nextY = event.touches[0]?.clientY;
          if (!activeViewport || typeof nextY !== 'number') return;
          const delta = touchLastY - nextY;
          touchLastY = nextY;
          if (Math.abs(delta) < 1) return;
          const before = activeViewport.scrollTop;
          const maxScrollTop = Math.max(0, activeViewport.scrollHeight - activeViewport.clientHeight);
          activeViewport.scrollTop = Math.max(0, Math.min(maxScrollTop, before + delta));
          if (activeViewport.scrollTop !== before) {
            event.preventDefault();
            touchPixelRemainder = 0;
            reportScrollMetrics();
            return;
          }

          const term = terminalRef.current;
          const termBuffer = term?.buffer?.active;
          if (!term || !termBuffer || termBuffer.length <= term.rows) return;
          touchPixelRemainder += delta;
          const lineDelta = Math.trunc(touchPixelRemainder / getApproxLineHeight(activeViewport));
          if (lineDelta === 0) return;
          const viewportYBefore = termBuffer.viewportY;
          try { term.scrollLines(lineDelta); } catch {}
          touchPixelRemainder -= lineDelta * getApproxLineHeight(activeViewport);
          if (termBuffer.viewportY !== viewportYBefore || Math.abs(touchPixelRemainder) < getApproxLineHeight(activeViewport)) {
            event.preventDefault();
            reportScrollMetrics();
            refreshTerminalSurface();
          }
        };
        const touchEnd = () => {
          touchLastY = null;
          touchPixelRemainder = 0;
        };
        touchContainer.addEventListener('touchstart', touchStart, passiveTouchListenerOptions);
        touchContainer.addEventListener('touchmove', touchMove, touchListenerOptions);
        touchContainer.addEventListener('touchend', touchEnd, passiveTouchListenerOptions);
        touchContainer.addEventListener('touchcancel', touchEnd, passiveTouchListenerOptions);
        removeTouchScrollListeners = () => {
          viewport?.removeEventListener('scroll', scrollListener);
          touchContainer.removeEventListener('touchstart', touchStart, passiveTouchListenerOptions);
          touchContainer.removeEventListener('touchmove', touchMove, touchListenerOptions);
          touchContainer.removeEventListener('touchend', touchEnd, passiveTouchListenerOptions);
          touchContainer.removeEventListener('touchcancel', touchEnd, passiveTouchListenerOptions);
        };

        if (cancelled) {
          removeTouchScrollListeners?.();
          removeLocalInputViewportListener?.();
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
        removeTouchScrollListeners?.();
        removeLocalInputViewportListener?.();
        pendingLocalInputViewportRestoreRef.current = null;
        termForCleanup?.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
      };
    }, [sizingMode]);

    useEffect(() => {
      const term = terminalRef.current;
      if (!term) return;
      if (term.options.fontSize === fontSize) {
        scheduleInOwnerWindow(() => {
          reportViewportMetrics();
        });
        return;
      }

      try {
        term.options.fontSize = fontSize;
        term.refresh(0, Math.max(0, term.rows - 1));
      } catch {}

      scheduleInOwnerWindow(() => {
        applyFitIfEnabled(true);
        reportViewportMetrics();
      });
    }, [fontSize]);

    useEffect(() => {
      if (sizingMode !== 'fit') return;
      const container = containerRef.current;
      const ResizeObserverCtor = container?.ownerDocument?.defaultView?.ResizeObserver;
      if (!container || !ResizeObserverCtor) return;

      const observer = new ResizeObserverCtor((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const { width, height } = entry.contentRect;
        if (width <= 0 || height <= 0) return;
        scheduleInOwnerWindow(() => {
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

    useEffect(() => {
      const ownerWindow = containerRef.current?.ownerDocument?.defaultView;
      const ownerDoc = containerRef.current?.ownerDocument;
      if (!ownerWindow || !ownerDoc) return;

      const repaint = () => {
        scheduleInOwnerWindow(() => {
          refreshTerminalSurface();
        });
      };

      ownerWindow.addEventListener('focus', repaint);
      ownerWindow.addEventListener('resize', repaint);
      ownerWindow.addEventListener('pageshow', repaint);
      ownerDoc.addEventListener('visibilitychange', repaint);
      return () => {
        ownerWindow.removeEventListener('focus', repaint);
        ownerWindow.removeEventListener('resize', repaint);
        ownerWindow.removeEventListener('pageshow', repaint);
        ownerDoc.removeEventListener('visibilitychange', repaint);
      };
    }, [rendererKind, sizingMode]);

    return (
      <>
        <style>{TERMINAL_CHROME_CSS}</style>
        <div
          data-terminal-renderer={rendererKind || 'pending'}
          className={['adhdev-terminal-renderer', className].filter(Boolean).join(' ')}
          style={{
            width: '100%',
            height: '100%',
            overflow: 'hidden',
            background: TERMINAL_THEME.background,
            padding: `${TERMINAL_CHROME_PADDING_Y}px ${TERMINAL_CHROME_PADDING_X}px`,
            boxSizing: 'border-box',
            opacity: ready ? 1 : 0,
            transition: 'opacity 200ms ease',
            ...style,
          }}
        >
          <div
            ref={containerRef}
            className="adhdev-terminal-renderer-mount h-full w-full"
            style={{
              width: '100%',
              height: '100%',
              overflow: 'hidden',
            }}
          />
        </div>
      </>
    );
  },
);

GhosttyTerminalView.displayName = 'GhosttyTerminalView';
