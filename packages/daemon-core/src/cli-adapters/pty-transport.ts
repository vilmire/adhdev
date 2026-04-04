import * as os from 'os';

let pty: any;
try {
  pty = require('node-pty');
} catch {
  pty = null;
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
    if (!pty) throw new Error('node-pty is not installed');
    const handle = pty.spawn(command, args, {
      name: os.platform() === 'win32' ? 'xterm-color' : 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: options.env,
    });
    return new NodePtyRuntimeTransport(handle);
  }
}
