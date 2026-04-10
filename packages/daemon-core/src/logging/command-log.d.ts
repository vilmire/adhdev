/**
 * ADHDev Daemon — Command History Logger
 *
 * Record all commands from dashboard/WS/P2P/Extension/API to local file.
 * Per-date JSONL file, 7-day retention, 5MB limit.
 *
 * Purpose:
 * - Debugging: track what command came and when
 * - Audit: record all commands executed from remote
 * - Stats: identify frequently used features
 */
export interface CommandLogEntry {
    ts: string;
    cmd: string;
    source: 'ws' | 'p2p' | 'ext' | 'api' | 'standalone' | 'unknown';
    args?: Record<string, unknown>;
    success?: boolean;
    error?: string;
    durationMs?: number;
}
/**
 * Log a command received from the dashboard/WS/P2P/extension/API.
 * Call this at the entry point of command handling.
 */
export declare function logCommand(entry: CommandLogEntry): void;
/**
 * Read recent command history (for dashboard display / debugging)
 */
export declare function getRecentCommands(count?: number): CommandLogEntry[];
/** Current command log file path */
export declare function getCommandLogPath(): string;
