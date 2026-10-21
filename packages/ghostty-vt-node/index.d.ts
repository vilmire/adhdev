export type GhosttyTerminalOptions = {
  cols: number;
  rows: number;
  scrollback: number;
};

export type GhosttyPlainTextFormatOptions = {
  trim?: boolean;
};

/**
 * Coordinate space of a row index.
 * - `active`: the rows x cols area the cursor moves in. `cursorRow` is in this
 *   space, and it does not move when the user scrolls through history.
 * - `viewport`: the visible area. Equal to `active` unless the viewport is
 *   scrolled into history (`viewportScrollbackOffset > 0`).
 */
export type GhosttyCoordinateSpace = 'active' | 'viewport';

export type GhosttyCellWideKind = 'narrow' | 'wide' | 'spacer-tail' | 'spacer-head';

export type GhosttyCell = {
  /** Physical cell column, 0-based. */
  col: number;
  /** The cell's full grapheme cluster as stored natively; '' for empty cells and spacers. */
  text: string;
  /** 2 for a wide lead cell, 0 for spacers, 1 otherwise. */
  width: 0 | 1 | 2;
  wideKind: GhosttyCellWideKind;
};

export type GhosttyRow = {
  /** Row index, 0-based, in `coordinateSpace`. */
  row: number;
  coordinateSpace: GhosttyCoordinateSpace;
  /**
   * Row text. Empty cells before content read as U+0020; the trailing run of
   * content-less cells is omitted; spacer cells contribute nothing. For
   * readability only — `cells` is the authority for columns.
   */
  text: string;
  /** This row soft-wraps into the next physical row. */
  wrapped: boolean;
  /** This row continues a soft-wrap from the previous physical row. */
  wrapContinuation: boolean;
  /** Exactly `cols` entries, present when requested. */
  cells?: GhosttyCell[];
};

export type GhosttyViewportOptions = {
  /** Rows to include: none (default), the cursor's row, or all ACTIVE rows. */
  includeRows?: 'none' | 'cursor' | 'all';
  cells?: boolean;
};

export type GhosttyScrollbar = {
  /** Rows in the selected screen: retained history + active area. */
  total: number;
  /** Row of `total` at which the visible viewport starts. */
  offset: number;
  /** Visible rows. */
  len: number;
};

/** One native snapshot; every field describes the same terminal state. */
export type GhosttyViewport = {
  /** Per-terminal mutation counter (write/resize/scrollViewport). */
  revision: number;
  /** Space of `cursorRow` and of every entry in `lines`. Always 'active'. */
  coordinateSpace: 'active';
  rows: number;
  cols: number;
  cursorRow: number;
  cursorCol: number;
  cursorPendingWrap: boolean;
  /** DEC mode 25; says nothing about whether the cursor is in the viewport. */
  cursorVisible: boolean;
  activeScreen: 'primary' | 'alternate';
  scrollbar: GhosttyScrollbar;
  /** Retained history rows of the selected screen (scrollbar.total - scrollbar.len). */
  scrollbackRows: number;
  /** Screen row at which the ACTIVE area starts. */
  activeOriginRow: number;
  /** Screen row at which the VIEWPORT starts (scrollbar.offset). */
  viewportOriginRow: number;
  /** How many rows the viewport is scrolled up from the active area. */
  viewportScrollbackOffset: number;
  /** Cursor row in VIEWPORT space, or null when the cursor is scrolled out of view. */
  cursorViewportRow: number | null;
  /** ACTIVE rows: all of them, or just the cursor's row, per `includeRows`. */
  lines?: GhosttyRow[];
};

export type GhosttyReadRowOptions = {
  cells?: boolean;
  /** Defaults to 'active'. */
  space?: GhosttyCoordinateSpace;
  /** Throw ERR_GHOSTTY_STALE_REVISION unless the terminal is still at this revision. */
  expectedRevision?: number;
};

export interface GhosttyTerminalHandle {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  formatPlainText(options?: GhosttyPlainTextFormatOptions): string;
  formatVT(): string;
  getCursorPosition(): { col: number; row: number };
  dispose(): void;
  // API level 2. Absent on older binaries: check `capabilities.viewport`.
  getViewport?(options?: GhosttyViewportOptions): GhosttyViewport;
  readRow?(row: number, options?: GhosttyReadRowOptions): GhosttyRow & { revision: number };
  scrollViewport?(target: 'top' | 'bottom' | number): void;
}

export type GhosttyBindingInfo = {
  /** 1 for binaries that predate getBindingInfo. */
  apiLevel: number;
  /** Binding source digest embedded at compile time (scripts/binding-digest.mjs). */
  sourceDigest: string | null;
  ghosttyRevision: string | null;
  napiVersion: number | null;
};

export function createTerminal(options: GhosttyTerminalOptions): GhosttyTerminalHandle;

export const bindingInfo: GhosttyBindingInfo;
export const capabilities: Readonly<{ viewport: boolean }>;
