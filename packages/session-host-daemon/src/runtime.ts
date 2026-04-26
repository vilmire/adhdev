import * as fs from 'fs';
import * as os from 'os';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { CreateSessionPayload } from '@adhdev/session-host-core';
import {
  sanitizeSpawnEnv,
  ensureNodePtySpawnHelperPermissions,
  resolveSessionHostCols,
  resolveSessionHostRows,
} from '@adhdev/session-host-core';

type TerminalMirrorHandle = {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  formatVT(): string;
  getCursorPosition(): { col: number; row: number };
  dispose(): void;
};

type GhosttyTerminalHandle = {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  formatVT(): string;
  getCursorPosition(): { col: number; row: number };
  dispose(): void;
};

type GhosttyBinding = {
  createTerminal(options: { cols: number; rows: number; scrollback: number }): GhosttyTerminalHandle;
};

type XtermBufferLine = {
  translateToString(trimRight?: boolean): string;
};

type XtermBuffer = {
  length: number;
  viewportY: number;
  cursorX?: number;
  cursorY?: number;
  getLine(index: number): XtermBufferLine | undefined;
};

type XtermTerminal = {
  buffer: { active: XtermBuffer };
  loadAddon(addon: { activate(terminal: XtermTerminal): void }): void;
  write(data: string, callback?: () => void): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
};

type XtermCtor = new (options: { cols: number; rows: number; scrollback: number }) => XtermTerminal;

type XtermSerializeAddon = {
  serialize(options?: { range?: { start: number; end: number }; scrollback?: number; excludeModes?: boolean }): string;
  dispose(): void;
};

let terminalMirrorFactory:
  | ((options: { cols: number; rows: number; scrollback: number }) => TerminalMirrorHandle)
  | null
  | undefined;
let terminalMirrorWarning: string | null = null;
let terminalMirrorBackendLogged = false;

ensureNodePtySpawnHelperPermissions((msg: string) => console.log(`[session-host] ${msg}`));

function logTerminalMirrorBackend(message: string, level: 'info' | 'warn' = 'info'): void {
  if (terminalMirrorBackendLogged) return;
  terminalMirrorBackendLogged = true;
  const prefix = '[session-host]';
  if (level === 'warn') console.warn(`${prefix} ${message}`);
  else console.log(`${prefix} ${message}`);
}

export interface PtyRuntimeOptions {
  sessionId: string;
  payload: CreateSessionPayload;
  onData: (data: string) => void;
  onExit: (exitCode: number | null) => void;
}

// Use shared spawn env sanitizer — alias for backward compat within this file
const buildRuntimeEnv = sanitizeSpawnEnv;

function computeTerminalQueryTail(buffer: string): string {
  const prefixes = ['\x1b[6n', '\x1b[?6n'];
  const maxLength = prefixes.reduce((n, value) => Math.max(n, value.length), 0) - 1;
  const start = Math.max(0, buffer.length - maxLength);
  for (let i = start; i < buffer.length; i++) {
    const suffix = buffer.slice(i);
    if (prefixes.some((pattern) => suffix.length < pattern.length && pattern.startsWith(suffix))) {
      return suffix;
    }
  }
  return '';
}

function formatXtermViewportPlain(terminal: XtermTerminal, rows: number): string {
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.viewportY || 0);
  const end = Math.max(start, Math.min(buffer.length || 0, start + Math.max(1, rows | 0)));
  const lines: string[] = [];

  for (let i = start; i < end; i++) {
    const line = buffer.getLine(i);
    lines.push(line ? line.translateToString(true) : '');
  }

  let first = 0;
  let last = lines.length;
  while (first < last && !lines[first]?.trim()) first++;
  while (last > first && !lines[last - 1]?.trim()) last--;
  // Browser xterm runs with convertEol=false. Plain fallback snapshots therefore
  // need CRLF row boundaries; bare LF replays as a staircase from the previous
  // cursor column and makes Claude's startup art look broken.
  return lines.slice(first, last).join('\r\n');
}

function createXtermSerializeAddon(terminal: XtermTerminal): XtermSerializeAddon | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@xterm/addon-serialize');
    const SerializeAddon = mod.SerializeAddon || mod.default?.SerializeAddon || mod.default;
    if (!SerializeAddon) return null;
    const addon = new SerializeAddon() as XtermSerializeAddon & { activate(terminal: XtermTerminal): void };
    terminal.loadAddon(addon);
    return addon;
  } catch {
    return null;
  }
}

function serializeXtermViewport(terminal: XtermTerminal, serializer: XtermSerializeAddon, rows: number): string {
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.viewportY || 0);
  const end = Math.max(start, Math.min(Math.max(0, buffer.length || 0) - 1, start + Math.max(1, rows | 0) - 1));
  if (end < start) return '';
  return serializer.serialize({
    range: { start, end },
    excludeModes: true,
  });
}

function createXtermMirror(options: { cols: number; rows: number; scrollback: number }): TerminalMirrorHandle {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('@xterm/xterm');
  const Terminal = (mod.Terminal || mod.default?.Terminal || mod.default) as XtermCtor | undefined;
  if (!Terminal) {
    throw new Error('@xterm/xterm Terminal export not found');
  }

  let currentRows = Math.max(1, options.rows | 0);
  const terminal = new Terminal({
    cols: Math.max(1, options.cols | 0),
    rows: currentRows,
    scrollback: Math.max(0, options.scrollback | 0),
  });
  const serializer = createXtermSerializeAddon(terminal);

  return {
    write(data: string | Uint8Array): void {
      if (!data) return;
      terminal.write(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    },
    resize(cols: number, rows: number): void {
      currentRows = Math.max(1, rows | 0);
      terminal.resize(Math.max(1, cols | 0), currentRows);
    },
    formatVT(): string {
      if (serializer) return serializeXtermViewport(terminal, serializer, currentRows);
      return formatXtermViewportPlain(terminal, currentRows);
    },
    getCursorPosition(): { col: number; row: number } {
      const buffer = terminal.buffer.active;
      return {
        col: Math.max(0, buffer.cursorX || 0),
        row: Math.max(0, buffer.cursorY || 0),
      };
    },
    dispose(): void {
      serializer?.dispose();
      terminal.dispose();
    },
  };
}

function normalizeGhosttyBinding(mod: any): GhosttyBinding | null {
  const raw = mod?.default?.createTerminal ? mod.default : mod?.createTerminal ? mod : null;
  if (!raw) return null;

  // Keep Ghostty as the authoritative emulator for terminal query responses, but use
  // xterm's serialized active viewport for UI seeding. Ghostty's formatter serializes
  // scrollback before the active viewport; after full-screen Claude Code redraws (for
  // example `/status` -> Esc), replaying that as a fresh terminal seed makes stale
  // splash-screen rows visible as duplicated logos. xterm's serialize addon gives us
  // the viewport-only seed without dropping SGR color/style or CRLF row movement.
  return {
    createTerminal(options: { cols: number; rows: number; scrollback: number }): GhosttyTerminalHandle {
      const handle = raw.createTerminal(options) as any;
      const viewportSnapshot = createXtermMirror(options);
      return {
        write(data: string | Uint8Array): void {
          handle.write(data);
          viewportSnapshot.write(data);
        },
        resize(cols: number, rows: number): void {
          handle.resize(cols, rows);
          viewportSnapshot.resize(cols, rows);
        },
        formatVT(): string {
          return viewportSnapshot.formatVT();
        },
        getCursorPosition(): { col: number; row: number } {
          if (typeof handle.getCursorPosition === 'function') return handle.getCursorPosition() as { col: number; row: number };
          return viewportSnapshot.getCursorPosition();
        },
        dispose(): void {
          handle.dispose();
          viewportSnapshot.dispose();
        },
      };
    },
  };
}

export const __testing = {
  createXtermMirror,
  formatXtermViewportPlain,
  serializeXtermViewport,
};

function getTerminalMirrorFactory(): (options: { cols: number; rows: number; scrollback: number }) => TerminalMirrorHandle {
  if (terminalMirrorFactory) return terminalMirrorFactory;
  if (terminalMirrorFactory === null) {
    throw new Error(terminalMirrorWarning || 'No terminal mirror backend available');
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ghosttyMod = require('@adhdev/ghostty-vt-node');
    const binding = normalizeGhosttyBinding(ghosttyMod);
    if (!binding) {
      throw new Error('@adhdev/ghostty-vt-node does not export createTerminal()');
    }
    terminalMirrorFactory = (options) => binding.createTerminal(options);
    logTerminalMirrorBackend('terminal mirror backend=ghostty-vt');
    return terminalMirrorFactory;
  } catch (ghosttyError: any) {
    try {
      terminalMirrorFactory = createXtermMirror;
      terminalMirrorWarning = `Ghostty VT unavailable; falling back to xterm mirror (${ghosttyError?.message || String(ghosttyError)})`;
      logTerminalMirrorBackend(terminalMirrorWarning, 'warn');
      return terminalMirrorFactory;
    } catch (xtermError: any) {
      terminalMirrorFactory = null;
      terminalMirrorWarning = `No terminal mirror backend available (ghostty: ${ghosttyError?.message || String(ghosttyError)}; xterm: ${xtermError?.message || String(xtermError)})`;
      logTerminalMirrorBackend(terminalMirrorWarning, 'warn');
      throw new Error(terminalMirrorWarning);
    }
  }
}

export class PtySessionRuntime {
  readonly sessionId: string;
  readonly payload: CreateSessionPayload;
  readonly cols: number;
  readonly rows: number;

  private ptyProcess: IPty | null = null;
  private screenMirror: TerminalMirrorHandle | null = null;
  private pendingQueryScanTail = '';
  private onDataCallback: (data: string) => void;
  private onExitCallback: (exitCode: number | null) => void;

  constructor(options: PtyRuntimeOptions) {
    this.sessionId = options.sessionId;
    this.payload = options.payload;
    this.cols = resolveSessionHostCols(options.payload.cols);
    this.rows = resolveSessionHostRows(options.payload.rows);
    this.onDataCallback = options.onData;
    this.onExitCallback = options.onExit;
  }

  start(): number {
    if (this.ptyProcess) return this.ptyProcess.pid;

    const command = this.payload.launchCommand.command;
    const args = this.payload.launchCommand.args || [];
    const env = buildRuntimeEnv(process.env, this.payload.launchCommand.env);

    // Validate workspace directory — an invalid cwd causes a native crash on Windows
    // (node-pty error code 267: ERROR_DIRECTORY) that bypasses JS try/catch
    let cwd = this.payload.workspace || process.cwd();
    if (cwd) {
      try {
        const stat = fs.statSync(cwd);
        if (!stat.isDirectory()) cwd = os.homedir();
      } catch {
        cwd = os.homedir();
      }
    }

    this.ptyProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd,
      env,
    });
    this.screenMirror = getTerminalMirrorFactory()({
      cols: this.cols,
      rows: this.rows,
      scrollback: 32768,
    });

    this.ptyProcess.onData((data: string) => {
      this.screenMirror?.write(data);
      this.respondToTerminalQueries(data);
      this.onDataCallback(data);
    });

    this.ptyProcess.onExit(({ exitCode }) => {
      this.ptyProcess = null;
      this.screenMirror?.dispose();
      this.screenMirror = null;
      this.pendingQueryScanTail = '';
      this.onExitCallback(exitCode ?? null);
    });

    return this.ptyProcess.pid;
  }

  write(data: string): void {
    if (!this.ptyProcess) throw new Error(`Session not running: ${this.sessionId}`);
    this.ptyProcess.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.ptyProcess) throw new Error(`Session not running: ${this.sessionId}`);
    this.ptyProcess.resize(cols, rows);
    this.screenMirror?.resize(cols, rows);
  }

  stop(): void {
    if (!this.ptyProcess) return;
    this.ptyProcess.kill();
  }

  sendSignal(signal: string): void {
    if (!this.ptyProcess) throw new Error(`Session not running: ${this.sessionId}`);
    const normalized = String(signal || '').trim().toUpperCase();
    if (!normalized) throw new Error('signal is required');

    try {
      process.kill(this.ptyProcess.pid, normalized as NodeJS.Signals);
    } catch {
      if (normalized === 'SIGTERM' || normalized === 'SIGKILL') {
        this.ptyProcess.kill();
        return;
      }
      throw new Error(`Unsupported signal for runtime ${this.sessionId}: ${normalized}`);
    }
  }

  getSnapshotText(): string {
    return this.screenMirror?.formatVT() || '';
  }

  private respondToTerminalQueries(data: string): void {
    if (!this.ptyProcess || !this.screenMirror || !data) return;

    const combined = this.pendingQueryScanTail + data;
    const regex = /\x1b\[(\?)?6n/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(combined)) !== null) {
      const cursor = this.screenMirror.getCursorPosition();
      const row = Math.max(1, (cursor.row | 0) + 1);
      const col = Math.max(1, (cursor.col | 0) + 1);
      const response = match[1]
        ? `\x1b[?${row};${col}R`
        : `\x1b[${row};${col}R`;
      this.ptyProcess.write(response);
    }

    this.pendingQueryScanTail = computeTerminalQueryTail(combined);
  }
}
