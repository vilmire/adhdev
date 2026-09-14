/**
 * LocalTransport — HTTP client for standalone daemon at localhost:3847
 */

import { DEFAULT_STANDALONE_PORT } from '@adhdev/daemon-core';

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

export interface LocalTransportOptions {
  port?: number;
  password?: string;
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

  constructor(opts: LocalTransportOptions = {}) {
    this.baseUrl = `http://localhost:${opts.port ?? DEFAULT_PORT}`;
    this.authHeader = opts.password ? `Bearer ${opts.password}` : null;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.authHeader) h['Authorization'] = this.authHeader;
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
        body: JSON.stringify({ type, ...args }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw describeFetchFailure(`Command ${type}`, timeoutMs, e);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Command ${type} failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  async ping(): Promise<boolean> {
    try {
      await this.getStatus();
      return true;
    } catch {
      return false;
    }
  }
}
