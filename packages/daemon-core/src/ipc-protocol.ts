/**
 * ADHDev IPC Protocol — Extension ↔ Daemon communication protocol
 * 
 * Message types used when Extension and Daemon communicate via localhost WS.
 * Defined in core package for import from both sides.
 */

// ─── Extension → Daemon ─────────────────────────

/** Extension registers itself with Daemon on first connection */
export interface IpcExtRegister {
    type: 'ext:register';
    payload: {
        ideType: string;       // 'cursor' | 'vscode' | 'windsurf' | 'antigravity' | ...
        ideVersion: string;    // vscode.version
        extensionVersion: string;
        instanceId: string;    // machineId + workspace hash
        machineId: string;     // vscode.env.machineId
        workspaceFolders: { name: string; path: string }[];
    };
}

/** Extension periodically send vscode status data */
export interface IpcExtStatus {
    type: 'ext:status';
    payload: {
        activeFile: string | null;
        workspaceFolders: { name: string; path: string }[];
        terminals: number;
        aiAgents: { id: string; name: string; status: string; version?: string }[];
 // requestId unnecessary for vscode event type
    };
}

/** Return Extension vscode command execution result */
export interface IpcExtCommandResult {
    type: 'ext:command_result';
    payload: {
        requestId: string;
        success: boolean;
        result?: unknown;
        error?: string;
        code?: string;
        meshCode?: string;
        reason?: string;
        transport?: 'p2p' | 'unknown';
        recoverable?: boolean;
        retryRecommended?: boolean;
        connectionState?: string;
        nextRetryAt?: string;
        authEpoch?: number;
    };
}

/** VSCode event occurring from Extension */
export interface IpcExtEvent {
    type: 'ext:event';
    payload: {
        event: 'file_changed' | 'terminal_opened' | 'terminal_closed' | 'agent_status_changed';
        data: Record<string, unknown>;
    };
}

// ─── Daemon → Extension ─────────────────────────

/** Welcome message on Daemon-Extension connection */
export interface IpcDaemonWelcome {
    type: 'daemon:welcome';
    payload: {
        daemonVersion: string;
        serverConnected: boolean;
        cdpConnected: boolean;
        localPort: number;
        cliAgents: string[];   // Currently running CLI agents
    };
}

/** Daemon to Extension vscode Request command execution */
export interface IpcDaemonExecuteVscode {
    type: 'daemon:execute_vscode';
    payload: {
        requestId: string;
        command: string;       // 'workbench.action.chat.open' etc
        args?: unknown[];
    };
}

/** Daemon to Extension status data request */
export interface IpcDaemonRequestStatus {
    type: 'daemon:request_status';
    payload: {};
}

/** Daemon notifies Extension about server connection status */
export interface IpcDaemonServerState {
    type: 'daemon:server_state';
    payload: {
        connected: boolean;
        serverUrl: string;
    };
}

/** Daemon to Extension notification display request */
export interface IpcDaemonNotify {
    type: 'daemon:notify';
    payload: {
        level: 'info' | 'warning' | 'error';
        message: string;
    };
}

/** Extension requests Daemon to execute command (e.g. CLI launch) */
export interface IpcExtCommand {
    type: 'ext:command';
    payload: {
        command: string;
        args?: any;
    };
}

// ─── Union Types ─────────────────────────────────

export type ExtToDaemonMessage =
    | IpcExtRegister
    | IpcExtStatus
    | IpcExtCommandResult
    | IpcExtEvent
    | IpcExtCommand;

export type DaemonToExtMessage =
    | IpcDaemonWelcome
    | IpcDaemonExecuteVscode
    | IpcDaemonRequestStatus
    | IpcDaemonServerState
    | IpcDaemonNotify;

export type IpcMessage = ExtToDaemonMessage | DaemonToExtMessage;

// ─── Constants ───────────────────────────────────

export const DEFAULT_DAEMON_PORT = 19222;
export const DAEMON_WS_PATH = '/ipc';

// ─── IPC load caps (audit #12, IPC load audit 2026-09-23) ──────────────────
//
// The local IPC WS server (oss/packages/daemon-core/src/ipc/local-ipc-server.ts
// for standalone, packages/daemon-cloud/src/adhdev-daemon.ts's own WebSocketServer
// for cloud) had no auth, no rate limit, no concurrency cap, and the `ws` library
// default 100 MiB maxPayload — a runaway or misbehaving local process (anything on
// loopback can connect; there is no IPC auth) was not throttled at all. These three
// constants are shared so both server implementations enforce identical limits.

/** WebSocketServer maxPayload for the local IPC endpoint. Down from the `ws`
 *  library default of 100 MiB — 32 MiB comfortably covers the largest known
 *  legitimate IPC frame (a `mesh_relay_command` carrying a dispatch `input`
 *  image envelope, capped well under this at the MCP layer) while bounding
 *  how much a single frame can cost to buffer/parse. */
export const IPC_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

/** Per-connection in-flight command cap. Each `ext:command` is handled via
 *  `void handleMessage(...)` with no prior concurrency limit — a client that
 *  pipelines requests faster than the daemon can answer them had no backpressure
 *  signal at all. Excess requests get a structured `ipc_busy` error (see
 *  IPC_BUSY_ERROR_CODE) instead of being silently queued or dropped. 32 is well
 *  above any legitimate single-client concurrency (an MCP process's own pooled
 *  WS multiplexes requestIds, but a coordinator's real fan-out — per-node probes
 *  — is bounded by mesh size, typically well under this) while still catching a
 *  runaway/looping client fast. */
export const IPC_MAX_INFLIGHT_PER_CONNECTION = 32;

/** Error code returned when IPC_MAX_INFLIGHT_PER_CONNECTION is exceeded. */
export const IPC_BUSY_ERROR_CODE = 'ipc_busy';

/** Token-bucket window + capacity for the read-only probe verbs
 *  (`get_status_metadata`, `mesh_status`, `get_mesh_queue`) — the exact
 *  commands the audit measured a coordinator hammering every 5-30s. 20 per 10s
 *  per connection sits comfortably above any legitimate polling cadence
 *  (including the MCP-side advisory rate limit of 5 calls/10s per mesh tool,
 *  which a single connection may exceed slightly when several mesh tools share
 *  one pooled WS) while still catching a genuinely runaway loop. */
export const IPC_PROBE_RATE_LIMIT_WINDOW_MS = 10_000;
export const IPC_PROBE_RATE_LIMIT_MAX_CALLS = 20;

/** Error code returned when a probe-verb token bucket is exhausted. */
export const IPC_RATE_LIMITED_ERROR_CODE = 'rate_limited';

/** Commands metered by the probe-verb token bucket. */
export const IPC_PROBE_RATE_LIMITED_COMMANDS: readonly string[] = [
    'get_status_metadata',
    'mesh_status',
    'get_mesh_queue',
];
