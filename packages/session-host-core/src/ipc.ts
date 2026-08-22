import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import type {
  SessionHostEvent,
  SessionHostRequest,
  SessionHostRequestEnvelope,
  SessionHostResponse,
  SessionHostResponseEnvelope,
  SessionHostWireEnvelope,
} from './types.js';

function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

export interface SessionHostEndpoint {
  kind: 'unix' | 'pipe';
  path: string;
}

export interface SessionHostEndpointOptions {
  /**
   * Instance IPC namespace key (see instance-key.ts). '' / omitted yields the
   * legacy default-instance endpoint; a non-empty key suffixes the endpoint so
   * each config-dir instance gets its own socket/pipe.
   */
  ipcKey?: string;
  /** Test seam: override the platform the endpoint shape is derived for. */
  platform?: NodeJS.Platform;
}

export function getDefaultSessionHostEndpoint(
  appName = 'adhdev',
  options: SessionHostEndpointOptions = {},
): SessionHostEndpoint {
  const rawKey = typeof options.ipcKey === 'string' ? options.ipcKey.trim() : '';
  // Fail closed on a malformed key: silently dropping it would collapse the
  // endpoint back onto the default instance's namespace — a cross-instance leak.
  if (rawKey && !/^[0-9a-f]{12}$/.test(rawKey)) {
    throw new Error(`Invalid session-host ipcKey "${rawKey}" — expected '' or a 12-hex-char instance key`);
  }
  const suffix = rawKey ? `-${rawKey}` : '';
  const platform = options.platform || process.platform;
  if (platform === 'win32') {
    return {
      kind: 'pipe',
      path: `\\\\.\\pipe\\${appName}-session-host${suffix}`,
    };
  }

  return {
    kind: 'unix',
    path: path.join(os.tmpdir(), `${appName}-session-host${suffix}.sock`),
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

/**
 * Why an established session-host connection went away.
 * - `error`  — socket emitted 'error' (includes ECONNRESET on abrupt host death)
 * - `ended`  — peer sent FIN ('end'): the host closed the connection cleanly
 * - `closed` — socket fully closed ('close') without a preceding error/end
 */
export type SessionHostDisconnectReason = 'error' | 'ended' | 'closed';

/**
 * Sockets that reached 'connect' at least once. Used to distinguish a genuine
 * disconnect (host died under us) from a connect attempt that never landed
 * (host not up yet) — only the former is a session-host death signal.
 */
const establishedSockets = new WeakSet<net.Socket>();

export interface SessionHostDisconnectInfo {
  reason: SessionHostDisconnectReason;
  endpointPath: string;
  /** In-flight requests abandoned by this disconnect (they were rejected). */
  pendingRequests: number;
  error?: Error;
}

export class SessionHostClient {
  readonly endpoint: SessionHostEndpoint;

  private socket: net.Socket | null = null;
  private requestWaiters = new Map<string, { resolve: (value: SessionHostResponse) => void; reject: (error: Error) => void }>();
  private eventListeners = new Set<(event: SessionHostEvent) => void>();
  private disconnectListeners = new Set<(info: SessionHostDisconnectInfo) => void>();
  /** Guards against emitting both an 'error'-path and a 'close'-path disconnect for one socket. */
  private disconnectedSockets = new WeakSet<net.Socket>();

  constructor(options: SessionHostClientOptions = {}) {
    this.endpoint = options.endpoint || getDefaultSessionHostEndpoint(options.appName || 'adhdev');
  }

  /**
   * Fires when an established connection to the session host goes away.
   *
   * Before this existed the client registered only 'data' and 'error' handlers,
   * so a *clean* FIN — the host process exiting normally, or dying to an
   * uncaught exception that took the socket down without an error event on our
   * end — ran nothing at all: `this.socket` stayed non-null pointing at a dead
   * socket, in-flight waiters hung to their 30s timeout, and no caller was told.
   * That silence is what let a session-host death present downstream as an
   * unrelated application-level fault (a missing completion marker) instead of
   * "the host is gone".
   */
  onDisconnect(listener: (info: SessionHostDisconnectInfo) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => {
      this.disconnectListeners.delete(listener);
    };
  }

  private handleDisconnect(socket: net.Socket, reason: SessionHostDisconnectReason, error?: Error): void {
    if (this.disconnectedSockets.has(socket)) return;
    this.disconnectedSockets.add(socket);

    // A connect that never succeeded is a *failed connect*, not a disconnect —
    // reporting it as a host death would make every poll against a not-yet-started
    // host look like a crash. connect() already surfaces that failure to its caller
    // via the awaited 'error'. Still clear socket state below? No: connect()'s own
    // error path handles a never-established socket, and `this.socket` is
    // overwritten on the next connect() attempt regardless.
    const wasEstablished = establishedSockets.has(socket);
    if (!wasEstablished) {
      if (this.socket === socket) this.socket = null;
      try { socket.destroy(); } catch { /* noop */ }
      // Reject waiters anyway — a request() that raced a dying socket must not hang.
      const failure = error || new Error(`Session host connect failed (${this.endpoint.path})`);
      for (const waiter of this.requestWaiters.values()) waiter.reject(failure);
      this.requestWaiters.clear();
      return;
    }

    const pendingRequests = this.requestWaiters.size;
    const failure = error || new Error(`Session host connection ${reason} (${this.endpoint.path})`);
    for (const waiter of this.requestWaiters.values()) {
      waiter.reject(failure);
    }
    this.requestWaiters.clear();

    // Clear the dead socket reference so the next connect() creates a fresh
    // connection instead of short-circuiting on the `!this.socket.destroyed`
    // guard at the top of connect().
    if (this.socket === socket) {
      this.socket = null;
    }
    try { socket.destroy(); } catch { /* noop */ }

    const info: SessionHostDisconnectInfo = {
      reason,
      endpointPath: this.endpoint.path,
      pendingRequests,
      error,
    };
    for (const listener of this.disconnectListeners) {
      // A throwing observer must not suppress the remaining ones, and must not
      // propagate out of a socket event handler (that would be an uncaught
      // exception in the daemon).
      try { listener(info); } catch { /* noop */ }
    }
  }

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    // Cleanup stale socket reference left after error/disconnect
    if (this.socket) {
      try { this.socket.destroy(); } catch { /* noop */ }
      this.socket = null;
    }

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
      this.handleDisconnect(socket, 'error', error);
    });

    // 'close'/'end' are the clean-FIN counterparts of 'error'. The host server
    // has always handled both directions (server.ts registers close+end); this
    // side handled neither, so host death was observable only if it happened to
    // surface as a socket error.
    socket.on('close', () => {
      this.handleDisconnect(socket, 'closed');
    });
    socket.on('end', () => {
      this.handleDisconnect(socket, 'ended');
    });

    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => {
        establishedSockets.add(socket);
        resolve();
      });
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

    const requestId = generateUUID();
    const envelope: SessionHostRequestEnvelope = {
      kind: 'request',
      requestId,
      request,
    };

    const response = await new Promise<SessionHostResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.requestWaiters.delete(requestId);
        reject(new Error(`Session host request timed out after 30s (${request.type})`));
      }, 30_000);
      this.requestWaiters.set(requestId, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      this.socket?.write(serializeEnvelope(envelope));
    });

    return response as SessionHostResponse<T>;
  }

  async close(): Promise<void> {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    // Deliberate teardown: suppress the 'close' handler's disconnect signal so
    // callers don't see an intentional close reported as a session-host death.
    this.disconnectedSockets.add(socket);
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
