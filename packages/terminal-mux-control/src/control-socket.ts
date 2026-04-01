import net from 'net';
import fs from 'fs';
import { type SessionHostResponse } from '@adhdev/session-host-core';
import { getWorkspaceControlEndpoint, type WorkspaceControlEndpoint } from './storage.js';

export interface AdhMuxControlRequest {
  type:
    | 'workspace_state'
    | 'list_panes'
    | 'capture_pane'
    | 'copy_pane'
    | 'search_pane'
    | 'select_pane'
    | 'replace_pane'
    | 'split_window'
    | 'resize_pane'
    | 'select_layout'
    | 'swap_panes'
    | 'zoom_pane'
    | 'kill_pane'
    | 'send_keys'
    | (string & {});
  payload?: Record<string, unknown>;
}

export interface AdhMuxControlEvent {
  type: 'workspace_update' | 'runtime_update';
  payload: Record<string, unknown>;
}

interface AdhMuxControlRequestEnvelope {
  kind: 'request';
  requestId: string;
  request: AdhMuxControlRequest;
}

interface AdhMuxControlResponseEnvelope {
  kind: 'response';
  requestId: string;
  response: SessionHostResponse;
}

interface AdhMuxControlEventEnvelope {
  kind: 'event';
  event: AdhMuxControlEvent;
}

type AdhMuxControlWireEnvelope = AdhMuxControlRequestEnvelope | AdhMuxControlResponseEnvelope | AdhMuxControlEventEnvelope;

function serializeEnvelope(envelope: AdhMuxControlWireEnvelope): string {
  return `${JSON.stringify(envelope)}\n`;
}

function createControlLineParser(onEnvelope: (envelope: AdhMuxControlWireEnvelope) => void) {
  let buffer = '';
  return (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const rawLine = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (rawLine) {
        onEnvelope(JSON.parse(rawLine) as AdhMuxControlWireEnvelope);
      }
      newlineIndex = buffer.indexOf('\n');
    }
  };
}

export class AdhMuxControlClient {
  readonly endpoint: WorkspaceControlEndpoint;
  private socket: net.Socket | null = null;
  private waiters = new Map<string, { resolve: (value: SessionHostResponse) => void; reject: (error: Error) => void }>();
  private eventListeners = new Set<(event: AdhMuxControlEvent) => void>();

  constructor(workspaceName: string) {
    this.endpoint = getWorkspaceControlEndpoint(workspaceName);
  }

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    const socket = net.createConnection(this.endpoint.path);
    this.socket = socket;
    socket.on('data', createControlLineParser((envelope) => {
      if (envelope.kind === 'response') {
        const waiter = this.waiters.get(envelope.requestId);
        if (!waiter) return;
        this.waiters.delete(envelope.requestId);
        waiter.resolve(envelope.response);
        return;
      }
      if (envelope.kind === 'event') {
        for (const listener of this.eventListeners) listener(envelope.event);
      }
    }));
    socket.on('error', (error) => {
      for (const waiter of this.waiters.values()) {
        waiter.reject(error);
      }
      this.waiters.clear();
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
  }

  async request<T = unknown>(request: AdhMuxControlRequest): Promise<SessionHostResponse<T>> {
    await this.connect();
    if (!this.socket) throw new Error('adhmux control socket unavailable');
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const envelope: AdhMuxControlRequestEnvelope = { kind: 'request', requestId, request };
    const response = await new Promise<SessionHostResponse>((resolve, reject) => {
      this.waiters.set(requestId, { resolve, reject });
      this.socket?.write(serializeEnvelope(envelope));
    });
    return response as SessionHostResponse<T>;
  }

  onEvent(listener: (event: AdhMuxControlEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    for (const waiter of this.waiters.values()) {
      waiter.reject(new Error('adhmux control client closed'));
    }
    this.waiters.clear();
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      socket.once('close', done);
      socket.end();
      socket.destroy();
      setTimeout(done, 50);
    });
  }
}

export async function withAdhMuxControlClient<T>(
  workspaceName: string,
  fn: (client: AdhMuxControlClient) => Promise<T>,
): Promise<T> {
  const client = new AdhMuxControlClient(workspaceName);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

export class AdhMuxControlServer {
  readonly endpoint: WorkspaceControlEndpoint;
  private readonly sockets = new Set<net.Socket>();
  private readonly server: net.Server;

  constructor(
    workspaceName: string,
    handle: (request: AdhMuxControlRequest) => Promise<SessionHostResponse>,
  ) {
    this.endpoint = getWorkspaceControlEndpoint(workspaceName);
    if (this.endpoint.kind === 'unix' && fs.existsSync(this.endpoint.path)) {
      fs.unlinkSync(this.endpoint.path);
    }
    this.server = net.createServer((socket) => {
      this.sockets.add(socket);
      socket.on('close', () => {
        this.sockets.delete(socket);
      });
      socket.on('data', createControlLineParser(async (envelope) => {
        if (envelope.kind !== 'request') return;
        const response = await handle(envelope.request).catch((error: any) => ({
          success: false,
          error: error?.message || String(error),
        }));
        socket.write(
          serializeEnvelope({
            kind: 'response',
            requestId: envelope.requestId,
            response,
          }),
        );
      }));
    });
    this.server.listen(this.endpoint.path);
    this.server.on('close', () => {
      if (this.endpoint.kind === 'unix' && fs.existsSync(this.endpoint.path)) {
        fs.unlinkSync(this.endpoint.path);
      }
    });
  }

  broadcast(event: AdhMuxControlEvent): void {
    const envelope = serializeEnvelope({ kind: 'event', event });
    for (const socket of this.sockets) {
      if (!socket.destroyed) socket.write(envelope);
    }
  }

  close(): void {
    this.server.close();
  }
}

export function createAdhMuxControlServer(
  workspaceName: string,
  handle: (request: AdhMuxControlRequest) => Promise<SessionHostResponse>,
): AdhMuxControlServer {
  return new AdhMuxControlServer(workspaceName, handle);
}
