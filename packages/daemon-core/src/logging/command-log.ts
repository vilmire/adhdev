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

import * as fs from 'fs';
import * as path from 'path';
import { resolveConfigLogsDir } from '../config/config-dir.js';

// ─── Config ──────────────────────────────────
// Command history lives under the unified ADHDev home (~/.adhdev/logs/) next to
// the daemon log, on every platform. The directory is resolved LAZILY through
// the shared config-dir helper: a module-level snapshot froze the dir at import
// time, so an ADHDEV_CONFIG_DIR assigned after load (tests, daemon boot
// ordering) was silently ignored and entries landed in the wrong instance home.
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_DAYS = 7;

// ─── Types ───────────────────────────────────
export interface CommandLogEntry {
    ts: string;           // ISO timestamp
    cmd: string;          // command name
    source: 'ws' | 'p2p' | 'ext' | 'api' | 'standalone' | 'unknown';  // where it came from
    interactionId?: string;
    args?: Record<string, unknown>;  // command arguments (sensitive values masked)
    success?: boolean;    // result
    error?: string;       // error message if failed
    durationMs?: number;  // execution time
}

// ─── Sensitive field masking ─────────────────
const SENSITIVE_KEYS = new Set([
    'token', 'password', 'secret', 'apiKey', 'api_key',
    'connectionToken', 'content', 'message', 'text',
]);

function maskArgs(args: any): Record<string, unknown> | undefined {
    if (!args || typeof args !== 'object') return undefined;
    const masked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
        if (SENSITIVE_KEYS.has(key)) {
            masked[key] = typeof value === 'string'
                ? `[${value.length} chars]`
                : '[masked]';
        } else if (key.startsWith('_')) {
 // internal fields: keep as-is (e.g. targetSessionId)
            masked[key] = value;
        } else if (typeof value === 'object' && value !== null) {
 // Don't recurse deeply — just note the type
            masked[key] = Array.isArray(value)
                ? `[Array(${value.length})]`
                : `[Object]`;
        } else {
            masked[key] = value;
        }
    }
    return masked;
}

// ─── File management ─────────────────────────
function getDateStr(): string {
    return new Date().toISOString().slice(0, 10);
}

let currentDate = '';
let currentDir = '';
let currentFile = '';
let writeCount = 0;

/**
 * Re-point the active file when the date rolled over or ADHDEV_CONFIG_DIR
 * changed. Cheap: two string compares when nothing moved, so callers invoke it
 * on every access instead of trusting an import-time snapshot. A new directory
 * gets created and retention-swept once.
 */
function refreshCurrentFile(): void {
    const today = getDateStr();
    const dir = resolveConfigLogsDir();
    if (today === currentDate && dir === currentDir) return;
    const dirChanged = dir !== currentDir;
    currentDate = today;
    currentDir = dir;
    currentFile = path.join(dir, `commands-${today}.jsonl`);
    if (dirChanged) {
        try { fs.mkdirSync(dir, { recursive: true }); } catch { }
        cleanOldFiles();
    }
}

function cleanOldFiles(): void {
    try {
        const files = fs.readdirSync(currentDir).filter(f => f.startsWith('commands-') && f.endsWith('.jsonl'));
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - MAX_DAYS);
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        for (const file of files) {
            const dateMatch = file.match(/commands-(\d{4}-\d{2}-\d{2})/);
            if (dateMatch && dateMatch[1] < cutoffStr) {
                try { fs.unlinkSync(path.join(currentDir, file)); } catch { }
            }
        }
    } catch { }
}

function checkSize(): void {
    try {
        const stat = fs.statSync(currentFile);
        if (stat.size > MAX_FILE_SIZE) {
            const backup = currentFile.replace('.jsonl', '.1.jsonl');
            try { fs.unlinkSync(backup); } catch { }
            fs.renameSync(currentFile, backup);
        }
    } catch { /* file doesn't exist yet */ }
}

// ─── Noise filter ────────────────────────────
// These commands are too frequent / low-value to log
const SKIP_COMMANDS = new Set([
    'heartbeat',
    'status_report',
    'read_chat',
    'mark_session_seen',
    'delete_notification',
    'mark_notification_unread',
]);

export function shouldLogCommand(cmd: string): boolean {
    return !SKIP_COMMANDS.has(cmd);
}

// ─── Public API ──────────────────────────────

/**
 * Log a command received from the dashboard/WS/P2P/extension/API.
 * Call this at the entry point of command handling.
 */
export function logCommand(entry: CommandLogEntry): void {
    if (!shouldLogCommand(entry.cmd)) return;

    try {
        refreshCurrentFile();
        if (++writeCount % 500 === 0) {
            checkSize();
        }
        
        const line = JSON.stringify({
            ts: entry.ts,
            cmd: entry.cmd,
            src: entry.source,
            ...(entry.interactionId ? { interactionId: entry.interactionId } : {}),
            ...(entry.args ? { args: maskArgs(entry.args) } : {}),
            ...(entry.success !== undefined ? { ok: entry.success } : {}),
            ...(entry.error ? { err: entry.error } : {}),
            ...(entry.durationMs !== undefined ? { ms: entry.durationMs } : {}),
        });
        
        fs.appendFileSync(currentFile, line + '\n');
    } catch { /* never crash the daemon for logging */ }
}

/**
 * Read recent command history (for dashboard display / debugging)
 */
export function getRecentCommands(count = 50): CommandLogEntry[] {
    try {
        refreshCurrentFile();
        if (!fs.existsSync(currentFile)) return [];
        const content = fs.readFileSync(currentFile, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        return lines.slice(-count).map(line => {
            try {
                const parsed = JSON.parse(line);
                return {
                    ts: parsed.ts,
                    cmd: parsed.cmd,
                    source: parsed.src,
                    interactionId: parsed.interactionId,
                    args: parsed.args,
                    success: parsed.ok,
                    error: parsed.err,
                    durationMs: parsed.ms,
                };
            } catch {
                return { ts: '', cmd: 'parse_error', source: 'unknown' as const };
            }
        });
    } catch {
        return [];
    }
}

/** Current command log file path */
export function getCommandLogPath(): string {
    refreshCurrentFile();
    return currentFile;
}
