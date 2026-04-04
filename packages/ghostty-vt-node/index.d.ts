export type GhosttyTerminalOptions = {
  cols: number;
  rows: number;
  scrollback: number;
};

export type GhosttyPlainTextFormatOptions = {
  trim?: boolean;
};

export interface GhosttyTerminalHandle {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  formatPlainText(options?: GhosttyPlainTextFormatOptions): string;
  formatVT(): string;
  getCursorPosition(): { col: number; row: number };
  dispose(): void;
}

export function createTerminal(options: GhosttyTerminalOptions): GhosttyTerminalHandle;
