import * as fs from 'fs';
import * as os from 'os';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { CreateSessionPayload, SessionTerminalSnapshot } from '@adhdev/session-host-core';
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
  formatPlainText(): string;
  getCursorPosition(): { col: number; row: number };
  dispose(): void;
};

type GhosttyTerminalHandle = {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  formatVT(): string;
  formatPlainText(options?: { trim?: boolean }): string;
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
  onExit: (exitCode: number | null, signal: number | null) => void;
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
    const raw = line ? line.translateToString(false) : '';
    lines.push(raw.replace(/\s+$/, ''));
  }

  let first = 0;
  let last = lines.length;
  while (first < last && !lines[first]?.trim()) first++;
  while (last > first && !lines[last - 1]?.trim()) last--;
  // Use CRLF row boundaries for unambiguous terminal replay regardless of the
  // browser xterm convertEol setting. CRLF is always explicit; bare LF depends
  // on convertEol being true to reset the cursor column, which is not guaranteed
  // for all xterm consumer configurations.
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

function formatCursorRestore(terminal: XtermTerminal, rows: number): string {
  const buffer = terminal.buffer.active;
  const row = Math.max(0, Math.min(Math.max(0, rows | 0) - 1, buffer.cursorY || 0));
  const col = Math.max(0, buffer.cursorX || 0);
  return `\x1b[${row + 1};${col + 1}H`;
}

function serializeXtermViewport(terminal: XtermTerminal, serializer: XtermSerializeAddon, rows: number): string {
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.viewportY || 0);
  const end = Math.max(start, Math.min(Math.max(0, buffer.length || 0) - 1, start + Math.max(1, rows | 0) - 1));
  if (end < start) return '';
  const viewport = serializer.serialize({
    range: { start, end },
    excludeModes: true,
  });
  // Range serialization reproduces the visible cells, but leaves the replay cursor
  // at the end of the serialized viewport. CLIs like Claude frequently update the
  // current status line with relative cursor movement; if the dashboard seeds a
  // snapshot and then receives an incremental update, that update must continue
  // from the live cursor row, not from the next line after the viewport replay.
  return `${viewport}${formatCursorRestore(terminal, rows)}`;
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
    formatPlainText(): string {
      return formatXtermViewportPlain(terminal, currentRows).replace(/\r\n/g, '\n');
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
        formatPlainText(): string {
          return viewportSnapshot.formatPlainText();
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
  private cols: number;
  private rows: number;

  private ptyProcess: IPty | null = null;
  private screenMirror: TerminalMirrorHandle | null = null;
  private pendingQueryScanTail = '';
  private terminalModeScanTail = '';
  private altScreen = false;
  private pasteMode = false;
  private scrollRegion: { top: number; bot: number };
  private onDataCallback: (data: string) => void;
  private onExitCallback: (exitCode: number | null, signal: number | null) => void;

  constructor(options: PtyRuntimeOptions) {
    this.sessionId = options.sessionId;
    this.payload = options.payload;
    this.cols = resolveSessionHostCols(options.payload.cols);
    this.rows = resolveSessionHostRows(options.payload.rows);
    this.scrollRegion = { top: 0, bot: this.rows - 1 };
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
      this.trackTerminalModes(data);
      this.respondToTerminalQueries(data);
      this.onDataCallback(data);
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this.ptyProcess = null;
      this.screenMirror?.dispose();
      this.screenMirror = null;
      this.pendingQueryScanTail = '';
      this.terminalModeScanTail = '';
      // Preserve the nullable/unknown exitCode and signal exactly as node-pty
      // reports them: a signal-terminated process arrives as exitCode=null and
      // must stay distinguishable from a clean exit 0.
      this.onExitCallback(
        typeof exitCode === 'number' ? exitCode : null,
        typeof signal === 'number' ? signal : null,
      );
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
    this.cols = Math.max(1, cols | 0);
    this.rows = Math.max(1, rows | 0);
    this.scrollRegion = {
      top: Math.min(this.scrollRegion.top, this.rows - 1),
      bot: Math.min(Math.max(this.scrollRegion.top, this.scrollRegion.bot), this.rows - 1),
    };
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

  getTerminalSnapshot(): SessionTerminalSnapshot {
    if (!this.ptyProcess || !this.screenMirror) {
      throw new Error(`Session not running: ${this.sessionId}`);
    }
    const cursor = this.screenMirror.getCursorPosition();
    return {
      text: this.screenMirror.formatPlainText(),
      state: {
        cursor: {
          row: Math.max(0, cursor.row | 0),
          col: Math.max(0, cursor.col | 0),
        },
        altScreen: this.altScreen,
        pasteMode: this.pasteMode,
        rawMode: true,
        scrollRegion: { ...this.scrollRegion },
        cols: this.cols,
        rows: this.rows,
      },
    };
  }

  private trackTerminalModes(data: string): void {
    if (!data) return;
    const combined = this.terminalModeScanTail + data;
    const privateMode = /\x1b\[\?([0-9;]*)([hl])/g;
    let privateMatch: RegExpExecArray | null;
    while ((privateMatch = privateMode.exec(combined)) !== null) {
      const enabled = privateMatch[2] === 'h';
      for (const mode of privateMatch[1].split(';')) {
        if (mode === '47' || mode === '1047' || mode === '1049') this.altScreen = enabled;
        if (mode === '2004') this.pasteMode = enabled;
      }
    }

    const scrollRegion = /\x1b\[(\d*)(?:;(\d*))?r/g;
    let scrollMatch: RegExpExecArray | null;
    while ((scrollMatch = scrollRegion.exec(combined)) !== null) {
      const top = scrollMatch[1] ? Number.parseInt(scrollMatch[1], 10) - 1 : 0;
      const bot = scrollMatch[2] ? Number.parseInt(scrollMatch[2], 10) - 1 : this.rows - 1;
      this.scrollRegion = {
        top: Math.max(0, Math.min(this.rows - 1, top)),
        bot: Math.max(0, Math.min(this.rows - 1, bot)),
      };
      if (this.scrollRegion.bot < this.scrollRegion.top) {
        this.scrollRegion = { top: 0, bot: this.rows - 1 };
      }
    }

    const lastEscape = combined.lastIndexOf('\x1b');
    this.terminalModeScanTail = lastEscape >= 0 && combined.length - lastEscape < 64
      ? combined.slice(lastEscape)
      : '';
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
