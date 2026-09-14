import { createRequire } from 'module';
import type { GhosttyTerminalHandle, GhosttyTerminalOptions } from '@adhdev/ghostty-vt-node';
import type { TerminalViewportState } from './types.js';

const require = createRequire(
  typeof __filename === 'string' ? __filename : import.meta.url,
);

interface GhosttyBinding {
  createTerminal: (options: GhosttyTerminalOptions) => GhosttyTerminalHandle;
}

// The native addon is loaded lazily, on first terminal construction — never at
// module load. This module is re-exported from the package barrel (index.ts), so
// an eager top-level require made a bare `import type { … } from
// '@adhdev/terminal-mux-core'` fatal on any platform-arch without a committed
// prebuilt (darwin-x64, linux-arm64): type-only consumers such as
// terminal-mux-cli's render.ts and commands-pane.ts still pull the module graph
// at runtime, so the whole adhmux CLI failed to start. Deferring the require
// keeps import-time side effects out of the barrel; only code that actually
// drives a ghostty surface pays for — or fails on — the binding.
//
// Compare session-host-daemon's runtime.ts getTerminalMirrorFactory(), which
// lazily loads the same addon and falls back to an xterm mirror. There is no
// equivalent fallback here: this class IS the ghostty surface, so the honest
// behavior is a clear error at construction rather than a silent substitute.
let cachedBinding: GhosttyBinding | null = null;
let cachedBindingError: Error | null = null;

function getGhosttyBinding(): GhosttyBinding {
  if (cachedBinding) return cachedBinding;
  if (cachedBindingError) throw cachedBindingError;
  try {
    const binding = require('@adhdev/ghostty-vt-node') as GhosttyBinding;
    if (typeof binding?.createTerminal !== 'function') {
      throw new Error('@adhdev/ghostty-vt-node does not export createTerminal()');
    }
    cachedBinding = binding;
    return cachedBinding;
  } catch (error: any) {
    cachedBindingError = new Error(
      `Ghostty terminal surface unavailable: ${error?.message || String(error)}`,
    );
    throw cachedBindingError;
  }
}

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
    this.terminal = getGhosttyBinding().createTerminal(terminalOptions);
  }

  resetFromText(text: string, snapshotSeq = 0): void {
    this.terminal.dispose();
    this.terminal = getGhosttyBinding().createTerminal({
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
