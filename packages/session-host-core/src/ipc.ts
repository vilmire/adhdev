import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { generateUUID } from './uuid.js';
import { StringDecoder } from 'string_decoder';
import type {
  AttachSessionPayload,
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

/** Reserve the trailing NUL in sockaddr_un; named pipes have a separate namespace. */
export function validateSessionHostEndpoint(
  endpoint: SessionHostEndpoint,
  platform: NodeJS.Platform = process.platform,
): void {
  if (endpoint.kind !== 'unix') return;
  // Darwin/BSD use 104 bytes; Linux provides 108. Default conservatively elsewhere.
  const limit = platform === 'linux' ? 108 : 104;
  const pathBytes = Buffer.byteLength(endpoint.path, 'utf8');
  if (pathBytes + 1 > limit) {
    throw new Error(`session_host_unix_socket_path_too_long: path_bytes=${pathBytes} required_bytes=${pathBytes + 1} limit_bytes=${limit} platform=${platform}`);
  }
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

/**
 * UTF8-CHUNK-BOUNDARY: decode the socket stream, never the individual chunk.
 *
 * This used to call `chunk.toString()` on every Buffer independently. A socket
 * hands us arbitrary byte slices — a multi-byte UTF-8 sequence straddling two
 * chunks gets decoded as two truncated sequences, and each half becomes U+FFFD.
 * The damage is silent by construction: the replacement character is valid JSON
 * string content, so the envelope still parses and only the *value* is wrong.
 * A pasted 11,994-char Korean prompt lost exactly one character that way — the
 * `도` beginning at wire offset 8190, split across the 8192-byte chunk boundary,
 * arrived as `�착`.
 *
 * StringDecoder holds an incomplete trailing sequence back until the bytes that
 * finish it arrive, which is the only correct way to turn a byte stream into
 * text. String chunks bypass it: they are already decoded, and feeding them
 * through `Buffer.from` would re-encode text the caller never asked us to touch.
 *
 * The envelope type is a parameter (defaulting to this package's own wire type)
 * purely so sibling newline-framed sockets can REUSE this decoder rather than
 * re-deriving it. `@adhdev/terminal-mux-control`'s control socket carried a
 * verbatim `chunk.toString()` copy of the pre-fix parser and inherited the same
 * silent corruption; it now shares this implementation. Nothing about the
 * framing is session-host-specific — only the payload type was, and that is now
 * the caller's to name.
 */
function createLineParser<TEnvelope = SessionHostWireEnvelope>(
  onEnvelope: (envelope: TEnvelope) => void,
) {
  let fragments: string[] = [];
  const decoder = new StringDecoder('utf8');
  const parser = (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let start = 0;
    for (;;) {
      const newline = text.indexOf('\n', start);
      if (newline < 0) { if (start < text.length) fragments.push(text.slice(start)); break; }
      fragments.push(text.slice(start, newline));
      const rawLine = fragments.join('').trim();
      fragments = [];
      start = newline + 1;
      if (rawLine) onEnvelope(JSON.parse(rawLine) as TEnvelope);
    }
  };
  /**
   * Flush at EOF, returning whatever text never formed a complete line.
   *
   * `decoder.end()` releases any bytes still held back as an incomplete UTF-8
   * sequence; without it those bytes vanish with the decoder. What is left in
   * the buffer is by definition a partial line — envelopes are newline-framed,
   * so an unterminated tail is a truncated transmission, not a message. It is
   * therefore RETURNED for the caller to log rather than parsed: calling
   * JSON.parse on a half-written envelope inside a socket EOF handler would
   * raise an uncaught exception in the daemon, turning a peer that died
   * mid-write into a crash of the process observing it.
   */
  parser.end = (): string => {
    const remainder = fragments.join('') + decoder.end();
    fragments = [];
    return remainder;
  };
  return parser;
}

export interface SessionHostClientOptions {
  endpoint?: SessionHostEndpoint;
  appName?: string;
  requestTimeoutMs?: number;
  /** Join the shared client registry (default true). Disable for short-lived probes. */
  registerAsShared?: boolean;
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
const activeClientRefs = new Set<WeakRef<SessionHostClient>>();

export function disconnectSessionHostClients(endpoint?: SessionHostEndpoint, error?: Error): void {
  for (const ref of activeClientRefs) {
    const client = ref.deref();
    if (!client) {
      activeClientRefs.delete(ref);
      continue;
    }
    if (!endpoint || client.endpoint.path === endpoint.path) {
      client.disconnect(error);
    }
  }
}

export function findConnectedSessionHostClient(endpoint?: SessionHostEndpoint): SessionHostClient | null {
  for (const ref of activeClientRefs) {
    const client = ref.deref();
    if (!client) {
      activeClientRefs.delete(ref);
      continue;
    }
    if ((!endpoint || client.endpoint.path === endpoint.path) && client.isConnected()) {
      return client;
    }
  }
  return null;
}

export interface SessionHostDisconnectInfo {
  reason: SessionHostDisconnectReason;
  endpointPath: string;
  /** In-flight requests abandoned by this disconnect (they were rejected). */
  pendingRequests: number;
  error?: Error;
  /**
   * Bytes discarded from a newline-unterminated frame at EOF (0 when the peer
   * hung up on a clean frame boundary, which is the normal case).
   *
   * Non-zero means the peer was cut off MID-WRITE — diagnostic context that
   * distinguishes "the host exited" from "the host died with a frame in
   * flight". Before the parser's `end()` was reachable this was unknowable:
   * the bytes were dropped with the decoder and no counter existed.
   */
  droppedTailBytes: number;
}

export class SessionHostClient {
  readonly endpoint: SessionHostEndpoint;

  private socket: net.Socket | null = null;
  private connectPromise: Promise<void> | null = null;
  private requestTimeoutMs = 30_000;
  private requestWaiters = new Map<string, { resolve: (value: SessionHostResponse) => void; reject: (error: Error) => void }>();
  private eventListeners = new Set<(event: SessionHostEvent) => void>();
  private disconnectListeners = new Set<(info: SessionHostDisconnectInfo) => void>();
  /** Guards against emitting both an 'error'-path and a 'close'-path disconnect for one socket. */
  private disconnectedSockets = new WeakSet<net.Socket>();
  /** Session subscriptions established via create_session/attach_session, replayed automatically on reconnect. */
  private attachedSessions = new Map<string, AttachSessionPayload>();

  constructor(options: SessionHostClientOptions = {}) {
    this.endpoint = options.endpoint || getDefaultSessionHostEndpoint(options.appName || 'adhdev');
    if (typeof options.requestTimeoutMs === 'number' && options.requestTimeoutMs > 0) {
      this.requestTimeoutMs = options.requestTimeoutMs;
    }
    if (options.registerAsShared !== false) activeClientRefs.add(new WeakRef(this));
  }

  static disconnectClients(endpoint?: SessionHostEndpoint, error?: Error): void {
    disconnectSessionHostClients(endpoint, error);
  }

  static findConnectedClient(endpoint?: SessionHostEndpoint): SessionHostClient | null {
    return findConnectedSessionHostClient(endpoint);
  }

  isConnected(): boolean {
    return Boolean(this.socket && !this.socket.destroyed && establishedSockets.has(this.socket));
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

  private handleDisconnect(
    socket: net.Socket,
    reason: SessionHostDisconnectReason,
    error?: Error,
    droppedTailBytes = 0,
  ): void {
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
      this.connectPromise = null;
    }
    try { socket.destroy(); } catch { /* noop */ }

    const info: SessionHostDisconnectInfo = {
      reason,
      endpointPath: this.endpoint.path,
      pendingRequests,
      error,
      droppedTailBytes,
    };
    for (const listener of this.disconnectListeners) {
      // A throwing observer must not suppress the remaining ones, and must not
      // propagate out of a socket event handler (that would be an uncaught
      // exception in the daemon).
      try { listener(info); } catch { /* noop */ }
    }
  }

  private sendRawRequestOnSocket<T = unknown>(
    socket: net.Socket,
    request: SessionHostRequest,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<SessionHostResponse<T>> {
    const requestId = generateUUID();
    const envelope: SessionHostRequestEnvelope = {
      kind: 'request',
      requestId,
      request,
    };
    const timeoutLabel = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}s` : `${timeoutMs}ms`;
    const startedAt = Date.now();
    const startedMonotonicAt = performance.now();
    return new Promise<SessionHostResponse<T>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const actualElapsedMs = Math.max(0, Math.round(performance.now() - startedMonotonicAt));
        const wallElapsedMs = Math.max(0, Date.now() - startedAt);
        const observerLagMs = Math.max(0, actualElapsedMs - timeoutMs);
        const timeoutError = Object.assign(
          new Error(`Session host request timed out after ${timeoutLabel} (${request.type})`),
          {
            code: 'SESSION_HOST_REQUEST_TIMEOUT',
            requestType: request.type,
            scheduledTimeoutMs: timeoutMs,
            actualElapsedMs,
            wallElapsedMs,
            observerLagMs,
          },
        );
        if (this.socket === socket) {
          this.disconnect(timeoutError);
        } else {
          this.requestWaiters.delete(requestId);
          this.disconnectedSockets.add(socket);
          try { socket.destroy(); } catch { /* noop */ }
          reject(timeoutError);
        }
      }, timeoutMs);
      this.requestWaiters.set(requestId, {
        resolve: (value) => { clearTimeout(timeout); resolve(value as SessionHostResponse<T>); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      socket.write(serializeEnvelope(envelope));
    });
  }

  async connect(timeoutMs = this.requestTimeoutMs): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      if (this.connectPromise) await this.connectPromise;
      return;
    }
    // Cleanup stale socket reference left after error/disconnect
    if (this.socket) {
      try { this.socket.destroy(); } catch { /* noop */ }
      this.socket = null;
    }
    this.connectPromise = null;

    const socket = net.createConnection(this.endpoint.path);
    this.socket = socket;

    // PARSER-EOF-FLUSH: keep the parser handle so its EOF flush is reachable.
    // Inlining `createLineParser(...)` into the 'data' registration discarded
    // the only reference to `end()`, so bytes held back by the StringDecoder as
    // an incomplete UTF-8 sequence were lost with the decoder when the host
    // disconnected.
    const parser = createLineParser((envelope) => {
      if (envelope.kind === 'response') {
        const waiter = this.requestWaiters.get(envelope.requestId);
        if (waiter) {
          this.requestWaiters.delete(envelope.requestId);
          waiter.resolve(envelope.response);
        }
        return;
      }

      if (envelope.kind === 'event') {
        for (const listener of this.eventListeners) {
          // An observer must never abort frame draining and strand a response
          // behind an event in the same socket chunk.
          try { listener(envelope.event); } catch { /* observer owns its error */ }
        }
      }
    });
    socket.on('data', parser);

    /**
     * Drain the parser at EOF. The remainder is a partial, newline-unterminated
     * frame — a truncated transmission rather than a message — so it is NOT
     * parsed. Feeding a half-written envelope to JSON.parse here would throw
     * inside a socket event handler with no catch above it, converting a host
     * that died mid-write into an uncaught exception in this process. That is
     * exactly the failure the parser's contract set out to avoid.
     *
     * Reported through the existing disconnect surface rather than a new one:
     * a non-empty tail means the peer was cut off mid-frame, which is
     * diagnostic context for the disconnect that is about to be emitted.
     */
    const flushParser = (): string => {
      try {
        return parser.end();
      } catch {
        return '';
      }
    };

    socket.on('error', (error) => {
      const remainder = flushParser();
      this.handleDisconnect(socket, 'error', error, remainder.length);
    });

    // 'close'/'end' are the clean-FIN counterparts of 'error'. The host server
    // has always handled both directions (server.ts registers close+end); this
    // side handled neither, so host death was observable only if it happened to
    // surface as a socket error.
    socket.on('close', () => {
      this.handleDisconnect(socket, 'closed', undefined, flushParser().length);
    });
    socket.on('end', () => {
      this.handleDisconnect(socket, 'ended', undefined, flushParser().length);
    });

    const connectTask = (async () => {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          socket.off('connect', connected);
          socket.off('error', failed);
          socket.off('close', closed);
        };
        const connected = () => { cleanup(); establishedSockets.add(socket); resolve(); };
        const failed = (error: Error) => { cleanup(); reject(error); };
        const closed = () => failed(new Error('Session host connection closed before connect'));
        const connectStartedAt = Date.now();
        const connectStartedMonotonicAt = performance.now();
        const timer = setTimeout(() => {
          const actualElapsedMs = Math.max(0, Math.round(performance.now() - connectStartedMonotonicAt));
          const wallElapsedMs = Math.max(0, Date.now() - connectStartedAt);
          const observerLagMs = Math.max(0, actualElapsedMs - timeoutMs);
          const error = Object.assign(
            new Error(`Session host connect timed out after ${timeoutMs}ms`),
            {
              code: 'SESSION_HOST_CONNECT_TIMEOUT',
              scheduledTimeoutMs: timeoutMs,
              actualElapsedMs,
              wallElapsedMs,
              observerLagMs,
            },
          );
          failed(error);
          if (this.socket === socket) this.disconnect(error);
        }, timeoutMs);
        socket.once('connect', connected);
        socket.once('error', failed);
        socket.once('close', closed);
      });
      if (this.attachedSessions.size > 0 && this.socket === socket && !socket.destroyed) {
        for (const [sessionId, sub] of [...this.attachedSessions.entries()]) {
          if (this.socket !== socket || socket.destroyed) break;
          const replayResponse = await this.sendRawRequestOnSocket(socket, {
            type: 'attach_session',
            payload: sub,
          }).catch(() => null);
          if (replayResponse && !replayResponse.success) {
            this.attachedSessions.delete(sessionId);
          }
        }
      }
    })();

    this.connectPromise = connectTask;
    try {
      await connectTask;
    } finally {
      if (this.connectPromise === connectTask) {
        this.connectPromise = null;
      }
    }
  }

  onEvent(listener: (event: SessionHostEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  async request<T = unknown>(request: SessionHostRequest, options: { timeoutMs?: number } = {}): Promise<SessionHostResponse<T>> {
    const timeoutMs = Math.max(1, options.timeoutMs ?? this.requestTimeoutMs);
    const deadline = Date.now() + timeoutMs;
    const alreadyConnected = this.isConnected() && !this.connectPromise;
    // A probe must also bound a connect/re-attach already in flight on this
    // client; that task may have started with the normal 30s timeout.
    if (options.timeoutMs !== undefined) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const raceStartedAt = Date.now();
      const raceStartedMonotonicAt = performance.now();
      try {
        await Promise.race([
          this.connect(timeoutMs),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              const actualElapsedMs = Math.max(0, Math.round(performance.now() - raceStartedMonotonicAt));
              const wallElapsedMs = Math.max(0, Date.now() - raceStartedAt);
              const observerLagMs = Math.max(0, actualElapsedMs - timeoutMs);
              const error = Object.assign(
                new Error(`Session host connect timed out after ${timeoutMs}ms`),
                {
                  code: 'SESSION_HOST_CONNECT_TIMEOUT',
                  scheduledTimeoutMs: timeoutMs,
                  actualElapsedMs,
                  wallElapsedMs,
                  observerLagMs,
                },
              );
              reject(error);
              this.disconnect(error);
            }, timeoutMs);
          }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    } else {
      await this.connect(timeoutMs);
    }
    const requestSocket = this.socket;
    if (!requestSocket) throw new Error('Session host socket unavailable');

    const response = await this.sendRawRequestOnSocket<T>(requestSocket, request, options.timeoutMs === undefined || alreadyConnected ? timeoutMs : Math.max(1, deadline - Date.now()));
    if (response.success) {
      if (request.type === 'attach_session') {
        this.attachedSessions.set(request.payload.sessionId, {
          sessionId: request.payload.sessionId,
          clientId: request.payload.clientId,
          clientType: request.payload.clientType,
          readOnly: request.payload.readOnly === true,
        });
      } else if (request.type === 'create_session') {
        const createdId = (response.result as { sessionId?: string } | undefined)?.sessionId || request.payload.sessionId;
        const clientId = typeof request.payload.clientId === 'string' ? request.payload.clientId.trim() : '';
        if (createdId && clientId) {
          this.attachedSessions.set(createdId, {
            sessionId: createdId,
            clientId,
            clientType: request.payload.clientType || 'daemon',
            readOnly: false,
          });
        }
      } else if (request.type === 'detach_session' || request.type === 'delete_session') {
        this.attachedSessions.delete(request.payload.sessionId);
      }
    }
    return response;
  }

  disconnect(error?: Error): void {
    const socket = this.socket;
    if (socket) {
      this.handleDisconnect(socket, error ? 'error' : 'closed', error, 0);
      return;
    }
    this.connectPromise = null;
    const failure = error || new Error(`Session host client disconnected (${this.endpoint.path})`);
    for (const waiter of this.requestWaiters.values()) {
      waiter.reject(failure);
    }
    this.requestWaiters.clear();
  }

  async close(): Promise<void> {
    this.attachedSessions.clear();
    this.connectPromise = null;
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
