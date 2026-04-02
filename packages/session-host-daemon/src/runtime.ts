import * as os from 'os';
import * as path from 'path';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { CreateSessionPayload } from '@adhdev/session-host-core';

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

export class PtySessionRuntime {
  readonly sessionId: string;
  readonly payload: CreateSessionPayload;
  readonly cols: number;
  readonly rows: number;

  private ptyProcess: IPty | null = null;
  private onDataCallback: (data: string) => void;
  private onExitCallback: (exitCode: number | null) => void;

  constructor(options: PtyRuntimeOptions) {
    this.sessionId = options.sessionId;
    this.payload = options.payload;
    this.cols = options.payload.cols || 120;
    this.rows = options.payload.rows || 40;
    this.onDataCallback = options.onData;
    this.onExitCallback = options.onExit;
  }

  start(): number {
    if (this.ptyProcess) return this.ptyProcess.pid;

    const command = this.payload.launchCommand.command;
    const args = this.payload.launchCommand.args || [];
    const cwd = this.payload.workspace || process.cwd();
    const env = {
      ...process.env,
      ...(this.payload.launchCommand.env || {}),
    } as Record<string, string>;

    this.ptyProcess = pty.spawn(command, args, {
      name: os.platform() === 'win32' ? 'xterm-color' : 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd,
      env,
    });

    this.ptyProcess.onData((data: string) => {
      this.onDataCallback(data);
    });

    this.ptyProcess.onExit(({ exitCode }) => {
      this.ptyProcess = null;
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
  }

  stop(): void {
    if (!this.ptyProcess) return;
    this.ptyProcess.kill();
  }
}
