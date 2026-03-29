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
