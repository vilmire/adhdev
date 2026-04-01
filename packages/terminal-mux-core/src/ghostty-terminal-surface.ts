import { createRequire } from 'module';
import type { GhosttyTerminalHandle, GhosttyTerminalOptions } from '@adhdev/ghostty-vt-node';
import type { TerminalViewportState } from './types.js';

const require = createRequire(
  typeof __filename === 'string' ? __filename : import.meta.url,
);
const ghosttyBinding = require('@adhdev/ghostty-vt-node') as {
  createTerminal: (options: GhosttyTerminalOptions) => GhosttyTerminalHandle;
};

export interface GhosttyTerminalSurfaceOptions {
  cols?: number;
  rows?: number;
  scrollback?: number;
}

export class GhosttyTerminalSurface {
  private terminal: GhosttyTerminalHandle;
  private cols: number;
  private rows: number;
  private snapshotSeq = 0;

  constructor(options: GhosttyTerminalSurfaceOptions = {}) {
    this.cols = Math.max(1, options.cols ?? 120);
    this.rows = Math.max(1, options.rows ?? 36);
    const terminalOptions: GhosttyTerminalOptions = {
      cols: this.cols,
      rows: this.rows,
      scrollback: Math.max(1024, options.scrollback ?? 32768),
    };
    this.terminal = ghosttyBinding.createTerminal(terminalOptions);
  }

  resetFromText(text: string, snapshotSeq = 0): void {
    this.terminal.dispose();
    this.terminal = ghosttyBinding.createTerminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: 32768,
    });
    if (text) {
      this.terminal.write(text);
    }
    this.snapshotSeq = snapshotSeq;
  }

  write(data: string, snapshotSeq?: number): void {
    if (data) {
      this.terminal.write(data);
    }
    if (typeof snapshotSeq === 'number') {
      this.snapshotSeq = snapshotSeq;
    }
  }

  resize(cols: number, rows: number): void {
    this.cols = Math.max(1, cols | 0);
    this.rows = Math.max(1, rows | 0);
    this.terminal.resize(this.cols, this.rows);
  }

  getViewportState(): TerminalViewportState {
    return {
      cols: this.cols,
      rows: this.rows,
      snapshotSeq: this.snapshotSeq,
      text: this.terminal.formatPlainText({ trim: true }) || '',
    };
  }

  dispose(): void {
    this.terminal.dispose();
  }
}
