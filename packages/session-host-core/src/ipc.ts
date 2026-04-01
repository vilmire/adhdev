import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { randomUUID } from 'crypto';
import type {
  SessionHostEvent,
  SessionHostRequest,
  SessionHostRequestEnvelope,
  SessionHostResponse,
  SessionHostResponseEnvelope,
  SessionHostWireEnvelope,
} from './types.js';

export interface SessionHostEndpoint {
  kind: 'unix' | 'pipe';
  path: string;
}

export function getDefaultSessionHostEndpoint(appName = 'adhdev'): SessionHostEndpoint {
  if (process.platform === 'win32') {
    return {
      kind: 'pipe',
      path: `\\\\.\\pipe\\${appName}-session-host`,
    };
  }

  return {
    kind: 'unix',
    path: path.join(os.tmpdir(), `${appName}-session-host.sock`),
  };
}

function serializeEnvelope(envelope: SessionHostWireEnvelope): string {
  return `${JSON.stringify(envelope)}\n`;
}

function createLineParser(onEnvelope: (envelope: SessionHostWireEnvelope) => void) {
  let buffer = '';
  return (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const rawLine = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (rawLine) {
        onEnvelope(JSON.parse(rawLine) as SessionHostWireEnvelope);
      }
      newlineIndex = buffer.indexOf('\n');
    }
  };
}

export interface SessionHostClientOptions {
  endpoint?: SessionHostEndpoint;
  appName?: string;
}

export class SessionHostClient {
  readonly endpoint: SessionHostEndpoint;

  private socket: net.Socket | null = null;
  private requestWaiters = new Map<string, { resolve: (value: SessionHostResponse) => void; reject: (error: Error) => void }>();
  private eventListeners = new Set<(event: SessionHostEvent) => void>();

  constructor(options: SessionHostClientOptions = {}) {
    this.endpoint = options.endpoint || getDefaultSessionHostEndpoint(options.appName || 'adhdev');
  }

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;

    const socket = net.createConnection(this.endpoint.path);
    this.socket = socket;

    socket.on('data', createLineParser((envelope) => {
      if (envelope.kind === 'response') {
        const waiter = this.requestWaiters.get(envelope.requestId);
        if (waiter) {
          this.requestWaiters.delete(envelope.requestId);
          waiter.resolve(envelope.response);
        }
        return;
      }

      if (envelope.kind === 'event') {
        for (const listener of this.eventListeners) listener(envelope.event);
      }
    }));

    socket.on('error', (error) => {
      for (const waiter of this.requestWaiters.values()) {
        waiter.reject(error);
      }
      this.requestWaiters.clear();
    });

    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
  }

  onEvent(listener: (event: SessionHostEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  async request<T = unknown>(request: SessionHostRequest): Promise<SessionHostResponse<T>> {
    await this.connect();
    if (!this.socket) throw new Error('Session host socket unavailable');

    const requestId = randomUUID();
    const envelope: SessionHostRequestEnvelope = {
      kind: 'request',
      requestId,
      request,
    };

    const response = await new Promise<SessionHostResponse>((resolve, reject) => {
      this.requestWaiters.set(requestId, { resolve, reject });
      this.socket?.write(serializeEnvelope(envelope));
    });

    return response as SessionHostResponse<T>;
  }

  async close(): Promise<void> {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    for (const waiter of this.requestWaiters.values()) {
      waiter.reject(new Error('Session host client closed'));
    }
    this.requestWaiters.clear();
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

export function createResponseEnvelope(requestId: string, response: SessionHostResponse): SessionHostResponseEnvelope {
  return {
    kind: 'response',
    requestId,
    response,
  };
}

export function writeEnvelope(socket: Pick<net.Socket, 'write'>, envelope: SessionHostWireEnvelope): void {
  socket.write(serializeEnvelope(envelope));
}

export { createLineParser };
