import net from 'net';
import fs from 'fs';
import { createLineParser, type SessionHostResponse } from '@adhdev/session-host-core';
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

// Matches the sister client's budget (session-host-core ipc.ts). Without it a
// server that accepts the connection but never answers leaves the CLI pending
// forever, with Ctrl-C as the only exit.
const CONTROL_REQUEST_TIMEOUT_MS = 30_000;

function serializeEnvelope(envelope: AdhMuxControlWireEnvelope): string {
  return `${JSON.stringify(envelope)}\n`;
}

/**
 * UTF8-CHUNK-BOUNDARY / PARSER-EOF-FLUSH: reuse the sister socket's decoder.
 *
 * This was a verbatim copy of session-host-core's pre-fix parser — it called
 * `chunk.toString()` on each socket Buffer in isolation — and so carried the
 * identical defect after that one was fixed. A multi-byte UTF-8 sequence
 * straddling two chunks decodes as two truncated sequences, each collapsing to
 * U+FFFD. The corruption is silent by construction: U+FFFD is legal JSON string
 * content, so the envelope still parses and only the *value* is wrong. Measured
 * on this wire shape, 25 of 129 interior byte-split points corrupted the
 * payload with zero parse errors.
 *
 * It is not theoretical traffic: `send_keys` carries user keystrokes toward the
 * pane and `capture_pane` carries terminal screen content back, so any
 * non-ASCII text in either direction is exposed at every chunk boundary.
 *
 * `createLineParser` (session-host-core `ipc.ts`) is the corrected
 * implementation: a StringDecoder holds an incomplete trailing sequence back
 * until the bytes that finish it arrive, and `end()` releases whatever it still
 * holds at EOF. Importing it rather than re-deriving it here is the point — a
 * second copy is what produced this bug in the first place.
 */
export function createControlLineParser(onEnvelope: (envelope: AdhMuxControlWireEnvelope) => void) {
  return createLineParser<AdhMuxControlWireEnvelope>(onEnvelope);
}

/**
 * Drain a parser at EOF (FIN, error, or close).
 *
 * The remainder is by definition a PARTIAL line — envelopes are newline-framed,
 * so an unterminated tail is a truncated transmission, not a message. It is
 * therefore discarded rather than parsed: `JSON.parse` on a half-written
 * envelope inside a socket close handler would raise an uncaught exception,
 * turning a peer that died mid-write into a crash of the process observing it.
 * Returning the byte count keeps the event observable without that risk.
 *
 * Without this, bytes the decoder was holding back as an incomplete UTF-8
 * sequence simply vanished with the decoder when the connection ended.
 */
function flushControlParser(parser: ReturnType<typeof createControlLineParser>): number {
  try {
    return parser.end().length;
  } catch {
    return 0;
  }
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
    // PARSER-EOF-FLUSH: hold the parser handle so its EOF flush stays reachable.
    // Passing `createControlLineParser(...)` inline to `socket.on('data', ...)`
    // discards the only reference to `end()`.
    const parser = createControlLineParser((envelope) => {
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
    });
    socket.on('data', parser);

    /**
     * Fail in-flight requests when the connection goes away, for ANY reason.
     *
     * Previously only 'error' was handled, so a clean FIN — the server exiting
     * normally — ran nothing at all: `this.socket` stayed non-null pointing at a
     * dead socket, and every pending request hung to its 30s timeout instead of
     * failing immediately with a connection reason. Mirrors the sister client's
     * error/end/close triad (session-host-core `ipc.ts`).
     */
    const failWaiters = (reason: string, error?: Error) => {
      flushControlParser(parser);
      if (this.socket === socket) this.socket = null;
      if (this.waiters.size === 0) return;
      const failure = error || new Error(`adhmux control connection ${reason} (${this.endpoint.path})`);
      for (const waiter of this.waiters.values()) {
        waiter.reject(failure);
      }
      this.waiters.clear();
    };

    socket.on('error', (error) => failWaiters('error', error));
    socket.on('end', () => failWaiters('ended'));
    socket.on('close', () => failWaiters('closed'));

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
      const timeout = setTimeout(() => {
        this.waiters.delete(requestId);
        reject(new Error(`adhmux control request timed out after 30s (${request.type})`));
      }, CONTROL_REQUEST_TIMEOUT_MS);
      this.waiters.set(requestId, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
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
      // PARSER-EOF-FLUSH: keep the handle so `end()` is reachable from the
      // teardown handlers below.
      const parser = createControlLineParser(async (envelope) => {
        if (envelope.kind !== 'request') return;
        const response = await handle(envelope.request).catch((error: any) => ({
          success: false,
          error: error?.message || String(error),
        }));
        // A peer that hung up mid-request leaves a destroyed socket; writing to
        // it would emit ERR_STREAM_DESTROYED from an async continuation with no
        // catch above it.
        if (socket.destroyed) return;
        socket.write(
          serializeEnvelope({
            kind: 'response',
            requestId: envelope.requestId,
            response,
          }),
        );
      });
      socket.on('data', parser);

      const teardown = () => {
        flushControlParser(parser);
        this.sockets.delete(socket);
      };
      // 'end' is the clean-FIN counterpart of 'close'. Handling only 'close'
      // left the decoder's held-back bytes unflushed on a half-close.
      socket.on('end', teardown);
      socket.on('close', teardown);
      socket.on('error', () => {
        teardown();
        try { socket.destroy(); } catch { /* noop */ }
      });
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
