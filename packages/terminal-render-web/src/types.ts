import type React from 'react';

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
   *
   * `fixed` = measure cols/rows once per mount and then never observe the
   * container again (no ResizeObserver, no re-measure on bumpResize). For
   * fixed-size product surfaces where the terminal box does not change size
   * after mount; avoids the expensive wterm full-rebuild that a resize
   * round-trip triggers (renderer.setup() clears the DOM and replays the entire
   * scrollback on the next render).
   */
  sizingMode?: 'measured' | 'fit' | 'fixed';
  className?: string;
  style?: React.CSSProperties;
}
