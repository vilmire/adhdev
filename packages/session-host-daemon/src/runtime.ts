import * as os from 'os';
import * as path from 'path';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { CreateSessionPayload } from '@adhdev/session-host-core';
import { createTerminal, type GhosttyTerminalHandle } from '@adhdev/ghostty-vt-node';

if (os.platform() !== 'win32') {
  try {
    const fs = require('fs');
    const ptyDir = path.resolve(path.dirname(require.resolve('node-pty')), '..');
    const platformArch = `${os.platform()}-${os.arch()}`;
    const helper = path.join(ptyDir, 'prebuilds', platformArch, 'spawn-helper');
    if (fs.existsSync(helper)) {
      const stat = fs.statSync(helper);
      if (!(stat.mode & 0o111)) {
        fs.chmodSync(helper, stat.mode | 0o755);
      }
    }
  } catch {
    // best-effort: node-pty still works on most installs without this
  }
}

export interface PtyRuntimeOptions {
  sessionId: string;
  payload: CreateSessionPayload;
  onData: (data: string) => void;
  onExit: (exitCode: number | null) => void;
}

function buildRuntimeEnv(baseEnv: NodeJS.ProcessEnv, launchEnv?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  const source = { ...baseEnv, ...(launchEnv || {}) } as NodeJS.ProcessEnv;

  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue;
    env[key] = value;
  }

  for (const key of Object.keys(env)) {
    if (
      key === 'INIT_CWD'
      || key === 'NO_COLOR'
      || key === 'FORCE_COLOR'
      || key === 'npm_command'
      || key === 'npm_execpath'
      || key === 'npm_node_execpath'
      || key.startsWith('npm_')
      || key.startsWith('npm_config_')
      || key.startsWith('npm_package_')
      || key.startsWith('npm_lifecycle_')
      || key.startsWith('PNPM_')
      || key.startsWith('YARN_')
      || key.startsWith('BUN_')
    ) {
      delete env[key];
    }
  }

  return env;
}

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

export class PtySessionRuntime {
  readonly sessionId: string;
  readonly payload: CreateSessionPayload;
  readonly cols: number;
  readonly rows: number;

  private ptyProcess: IPty | null = null;
  private screenMirror: GhosttyTerminalHandle | null = null;
  private pendingQueryScanTail = '';
  private onDataCallback: (data: string) => void;
  private onExitCallback: (exitCode: number | null) => void;

  constructor(options: PtyRuntimeOptions) {
    this.sessionId = options.sessionId;
    this.payload = options.payload;
    this.cols = options.payload.cols || 80;
    this.rows = options.payload.rows || 24;
    this.onDataCallback = options.onData;
    this.onExitCallback = options.onExit;
  }

  start(): number {
    if (this.ptyProcess) return this.ptyProcess.pid;

    const command = this.payload.launchCommand.command;
    const args = this.payload.launchCommand.args || [];
    const cwd = this.payload.workspace || process.cwd();
    const env = buildRuntimeEnv(process.env, this.payload.launchCommand.env);

    this.ptyProcess = pty.spawn(command, args, {
      name: os.platform() === 'win32' ? 'xterm-color' : 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd,
      env,
    });
    this.screenMirror = createTerminal({
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
