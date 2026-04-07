import * as os from 'os';
import { ensureNodePtySpawnHelperPermissions } from './spawn-env.js';

let cachedPty: any | null | undefined;

function loadNodePty(): any {
  if (cachedPty !== undefined) return cachedPty;
  try {
    // Keep node-pty out of processes that delegate PTY ownership elsewhere
    // (for example via session-host on Windows), so native PTY crashes do not
    // take down the daemon just by importing this module.
    cachedPty = require('node-pty');
    ensureNodePtySpawnHelperPermissions();
  } catch {
    cachedPty = null;
  }
  return cachedPty;
}

export interface PtySpawnOptions {
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export interface PtyRuntimeWriteOwner {
  clientId: string;
  ownerType: 'agent' | 'user';
}

export interface PtyRuntimeClientInfo {
  clientId: string;
  type: 'daemon' | 'web' | 'local-terminal';
  readOnly: boolean;
}

export interface PtyRuntimeMetadata {
  runtimeId: string;
  runtimeKey?: string;
  displayName?: string;
  workspaceLabel?: string;
  writeOwner?: PtyRuntimeWriteOwner | null;
  attachedClients?: PtyRuntimeClientInfo[];
}

export interface PtyRuntimeTransport {
  readonly pid: number;
  readonly ready: Promise<void>;
  readonly terminalQueriesHandled?: boolean;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  clearBuffer?(): void;
  detach?(): void;
  updateMeta?(meta: Record<string, unknown>, replace?: boolean): void;
  getMetadata?(): PtyRuntimeMetadata | null;
  onData(callback: (data: string) => void): void;
  onExit(callback: (info: { exitCode: number }) => void): void;
}

export interface PtyTransportFactory {
  spawn(command: string, args: string[], options: PtySpawnOptions): PtyRuntimeTransport;
}

class NodePtyRuntimeTransport implements PtyRuntimeTransport {
  readonly ready = Promise.resolve();
  readonly terminalQueriesHandled = false;

  constructor(private readonly handle: any) {}

  get pid(): number {
    return this.handle.pid;
  }

  write(data: string): void {
    this.handle.write(data);
  }

  resize(cols: number, rows: number): void {
    this.handle.resize(cols, rows);
  }

  kill(): void {
    this.handle.kill();
  }

  getMetadata(): PtyRuntimeMetadata | null {
    return null;
  }

  onData(callback: (data: string) => void): void {
    this.handle.onData(callback);
  }

  onExit(callback: (info: { exitCode: number }) => void): void {
    this.handle.onExit(callback);
  }
}

export class NodePtyTransportFactory implements PtyTransportFactory {
  spawn(command: string, args: string[], options: PtySpawnOptions): PtyRuntimeTransport {
    const pty = loadNodePty();
    if (!pty) throw new Error('node-pty is not installed');
    // Validate cwd — an invalid directory causes a native crash on Windows
    // (node-pty error code 267: ERROR_DIRECTORY) that bypasses JS try/catch
    let cwd = options.cwd;
    if (cwd) {
      try {
        const fs = require('fs');
        const stat = fs.statSync(cwd);
        if (!stat.isDirectory()) cwd = os.homedir();
      } catch {
        cwd = os.homedir();
      }
    }
    const handle = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd,
      env: options.env,
    });
    return new NodePtyRuntimeTransport(handle);
  }
}
