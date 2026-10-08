/**
 * LocalTransport — HTTP client for standalone daemon at localhost:3847
 */

import { readFileSync } from 'node:fs';

import {
  ADHDEV_INTERNAL_AUTH_HEADER,
  ADHDEV_WORKER_CREDENTIAL_HEADER,
  DEFAULT_STANDALONE_PORT,
} from '@adhdev/daemon-core';

import { getTimeoutMs } from './ipc.js';

const DEFAULT_PORT = DEFAULT_STANDALONE_PORT;

// D2#3: these fetches had NO deadline at all. A standalone daemon that accepts the
// TCP connection but never replies (wedged event loop, mid-restart, a hung handler)
// left the MCP call pending forever — and an stdio MCP client cannot cancel an
// in-flight tool call, so the coordinator hung with no error and no recovery path.
//
// Tiers are REUSED from ipc.ts (getTimeoutMs) rather than redefined: LocalTransport
// carries the SAME command verbs as IpcTransport — commandForNode() dispatches
// through whichever transport the mode resolved — so a verb's responder budget is a
// property of the verb, not of the wire. Duplicating the table here would let the two
// drift and re-create the false-timeout class the IPC table's comments document at
// length. A verb with no entry gets IPC's 15s default, same as IPC.
//
// The status probe is deliberately its own short budget: it is the liveness check
// (ping() is built on it), so a wedged daemon must fail it fast rather than inherit a
// command-sized deadline.
const STATUS_TIMEOUT_MS = 10_000;

interface LocalTransportOptions {
  port?: number;
  password?: string;
  /**
   * Coordinator / assistant scope: the standalone daemon's per-boot MCP
   * credential FILE (daemon-core standalone-mcp-auth.ts). Re-read on every
   * request, so a daemon restart (which rewrites it) does not strand this
   * process with a stale token.
   */
  authFile?: string;
  /** Worker scope: the worker's own session bind (or per-task token). */
  workerCredential?: string;
}

/**
 * The daemon answered 401/403: it is up, but refused this process's
 * credential. Distinct from "unreachable" so startup can say which it is.
 */
export class LocalDaemonAuthError extends Error {
  constructor(readonly status: number, what: string) {
    super(`${what} failed: ${status} (authentication to the local daemon failed)`);
    this.name = 'LocalDaemonAuthError';
  }
}

/**
 * Wrap a fetch rejection so an abort reads as a timeout instead of the bare
 * "This operation was aborted" DOMException, which names neither the command nor
 * the deadline that fired.
 */
function describeFetchFailure(what: string, timeoutMs: number, error: unknown): Error {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new Error(`${what} timed out after ${Math.round(timeoutMs / 1000)}s (standalone daemon did not respond)`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

export class LocalTransport {
  private baseUrl: string;
  private authHeader: string | null;
  private readonly authFile: string | null;
  private readonly workerCredential: string | null;
  /** Why the last ping() failed — `auth` when the daemon refused the credential. */
  lastPingFailure: { kind: 'auth' | 'unreachable'; message: string } | null = null;

  constructor(opts: LocalTransportOptions = {}) {
    this.baseUrl = `http://localhost:${opts.port ?? DEFAULT_PORT}`;
    this.authHeader = opts.password ? `Bearer ${opts.password}` : null;
    this.authFile = opts.authFile?.trim() || null;
    this.workerCredential = opts.workerCredential?.trim() || null;
  }

  private readInternalToken(): string | null {
    if (!this.authFile) return null;
    try {
      return readFileSync(this.authFile, 'utf8').trim() || null;
    } catch {
      // Missing/unreadable (daemon mid-restart, unauthenticated daemon that
      // never wrote one): send nothing and let the daemon decide.
      return null;
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.authHeader) h['Authorization'] = this.authHeader;
    const internalToken = this.readInternalToken();
    if (internalToken) h[ADHDEV_INTERNAL_AUTH_HEADER] = internalToken;
    if (this.workerCredential) h[ADHDEV_WORKER_CREDENTIAL_HEADER] = this.workerCredential;
    return h;
  }

  async getStatus(): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/v1/status`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });
    } catch (e) {
      throw describeFetchFailure('Status fetch', STATUS_TIMEOUT_MS, e);
    }
    if (res.status === 401 || res.status === 403) throw new LocalDaemonAuthError(res.status, 'Status fetch');
    if (!res.ok) throw new Error(`Status fetch failed: ${res.status}`);
    return res.json();
  }

  async command(type: string, args: Record<string, unknown> = {}): Promise<any> {
    // Mirror IPC's nested-verb resolution: a relayed command's budget must come from
    // the verb actually being executed, not from the wrapper.
    const nestedCommand = typeof args?.command === 'string' ? args.command : '';
    const timeoutMs = getTimeoutMs(type, nestedCommand);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/v1/command`, {
        method: 'POST',
        headers: this.headers(),
        // Nested, not spread: the standalone envelope strips reserved top-level keys
        // (id, command, args, requestId) from a flattened body, so e.g.
        // mission_upsert's `id` vanished and every "close this mission" created a
        // new one instead (2026-10-02).
        body: JSON.stringify({ type, payload: args }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw describeFetchFailure(`Command ${type}`, timeoutMs, e);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Command ${type} failed: ${res.status} (authentication to the local daemon failed) ${text}`);
      }
      throw new Error(`Command ${type} failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  /** Remote-node relay capability (transports/mode.ts): the standalone daemon
   *  answers `mesh_relay_command` over its direct-WS mesh link. */
  get supportsMeshRelay(): true {
    return true;
  }

  /**
   * Run `command` on another daemon of the mesh through the standalone daemon's
   * `mesh_relay_command` — the HTTP twin of IpcTransport.meshCommand. Same
   * payload, same nested-verb timeout (getTimeoutMs resolves the relay wrapper
   * against the relayed verb). A remote failure comes back as a result
   * (`success:false`, HTTP 200), a relay that could not run at all as a throw.
   */
  async meshCommand(
    targetDaemonId: string,
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<any> {
    return this.command('mesh_relay_command', { targetDaemonId, command, args });
  }

  async ping(): Promise<boolean> {
    try {
      await this.getStatus();
      this.lastPingFailure = null;
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.lastPingFailure = { kind: e instanceof LocalDaemonAuthError ? 'auth' : 'unreachable', message };
      return false;
    }
  }
}
