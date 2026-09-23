/**
 * IPC load guards (audit #12, IPC load audit 2026-09-23) — per-connection
 * in-flight command cap and a per-command token bucket for the read-only
 * probe verbs a coordinator polls at a 5-30s cadence.
 *
 * Both the cloud daemon's own local IPC WebSocketServer (adhdev-daemon.ts)
 * and daemon-core's shared LocalIpcServer (local-ipc-server.ts, used by
 * standalone) construct one guard set PER CONNECTION and check it before
 * dispatching each `ext:command` — kept here, dependency-free, so the two
 * server implementations enforce byte-for-byte identical limits instead of
 * two hand-rolled copies drifting apart.
 */

import {
    IPC_BUSY_ERROR_CODE,
    IPC_MAX_INFLIGHT_PER_CONNECTION,
    IPC_PROBE_RATE_LIMITED_COMMANDS,
    IPC_PROBE_RATE_LIMIT_MAX_CALLS,
    IPC_PROBE_RATE_LIMIT_WINDOW_MS,
    IPC_RATE_LIMITED_ERROR_CODE,
} from '../ipc-protocol.js';

const PROBE_RATE_LIMITED_COMMAND_SET = new Set(IPC_PROBE_RATE_LIMITED_COMMANDS);

export interface IpcGuardRejection {
    code: typeof IPC_BUSY_ERROR_CODE | typeof IPC_RATE_LIMITED_ERROR_CODE;
    error: string;
    /** Only present for rate_limited — how long the client should back off. */
    retryAfterMs?: number;
}

/**
 * Per-connection state: in-flight command count + a sliding-window token
 * bucket per probe-verb command name. Constructed once when a WS connection
 * is accepted (`onClientConnected`) and discarded when it closes — limits are
 * PER CONNECTION, not global, so one runaway client cannot starve another's
 * budget, and a fresh connection (e.g. after the MCP pooled-WS eviction/
 * reconnect cycle) always starts with a clean budget.
 */
export class IpcConnectionLoadGuard {
    private inFlight = 0;
    // command -> timestamps (ms) of calls within the current window, oldest first.
    private readonly probeCallTimestamps = new Map<string, number[]>();

    /**
     * Call BEFORE dispatching a command. Returns a rejection describing the
     * structured error to send back (never throws) — the caller is expected to
     * short-circuit and respond with that error instead of running the handler.
     * Returns null when the command may proceed; the caller MUST then call
     * `release()` exactly once when the command settles (success or failure).
     */
    tryAcquire(command: string, now: number = Date.now()): IpcGuardRejection | null {
        if (this.inFlight >= IPC_MAX_INFLIGHT_PER_CONNECTION) {
            return {
                code: IPC_BUSY_ERROR_CODE,
                error: `Too many in-flight commands on this connection (max ${IPC_MAX_INFLIGHT_PER_CONNECTION}). Wait for outstanding requests to complete before sending more.`,
            };
        }

        if (PROBE_RATE_LIMITED_COMMAND_SET.has(command)) {
            const windowStart = now - IPC_PROBE_RATE_LIMIT_WINDOW_MS;
            const timestamps = this.probeCallTimestamps.get(command) ?? [];
            // Drop timestamps that have aged out of the window.
            while (timestamps.length > 0 && timestamps[0] <= windowStart) {
                timestamps.shift();
            }
            if (timestamps.length >= IPC_PROBE_RATE_LIMIT_MAX_CALLS) {
                // Oldest timestamp in the window determines when a slot frees up.
                const retryAfterMs = Math.max(0, timestamps[0] + IPC_PROBE_RATE_LIMIT_WINDOW_MS - now);
                this.probeCallTimestamps.set(command, timestamps);
                return {
                    code: IPC_RATE_LIMITED_ERROR_CODE,
                    error: `Rate limit exceeded for '${command}' on this connection (max ${IPC_PROBE_RATE_LIMIT_MAX_CALLS} per ${IPC_PROBE_RATE_LIMIT_WINDOW_MS / 1000}s). Retry after ${retryAfterMs}ms.`,
                    retryAfterMs,
                };
            }
            timestamps.push(now);
            this.probeCallTimestamps.set(command, timestamps);
        }

        this.inFlight += 1;
        return null;
    }

    /** Call exactly once for every `tryAcquire` that returned null, when the
     *  command settles (success, error, or exception — always in a `finally`). */
    release(): void {
        if (this.inFlight > 0) this.inFlight -= 1;
    }

    /** Current in-flight count — exposed for diagnostics/tests only. */
    get inFlightCount(): number {
        return this.inFlight;
    }
}
