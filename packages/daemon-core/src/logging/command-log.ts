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
import * as os from 'os';

// ─── Config ──────────────────────────────────
const LOG_DIR = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Logs', 'adhdev')
    : path.join(os.homedir(), '.local', 'share', 'adhdev', 'logs');

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_DAYS = 7;

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { }

// ─── Types ───────────────────────────────────
export interface CommandLogEntry {
    ts: string;           // ISO timestamp
    cmd: string;          // command name
    source: 'ws' | 'p2p' | 'ext' | 'api' | 'standalone' | 'unknown';  // where it came from
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

let currentDate = getDateStr();
let currentFile = path.join(LOG_DIR, `commands-${currentDate}.jsonl`);
let writeCount = 0;

function checkRotation(): void {
    const today = getDateStr();
    if (today !== currentDate) {
        currentDate = today;
        currentFile = path.join(LOG_DIR, `commands-${currentDate}.jsonl`);
        cleanOldFiles();
    }
}

function cleanOldFiles(): void {
    try {
        const files = fs.readdirSync(LOG_DIR).filter(f => f.startsWith('commands-') && f.endsWith('.jsonl'));
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - MAX_DAYS);
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        for (const file of files) {
            const dateMatch = file.match(/commands-(\d{4}-\d{2}-\d{2})/);
            if (dateMatch && dateMatch[1] < cutoffStr) {
                try { fs.unlinkSync(path.join(LOG_DIR, file)); } catch { }
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
]);

// ─── Public API ──────────────────────────────

/**
 * Log a command received from the dashboard/WS/P2P/extension/API.
 * Call this at the entry point of command handling.
 */
export function logCommand(entry: CommandLogEntry): void {
    if (SKIP_COMMANDS.has(entry.cmd)) return;
    
    try {
        if (++writeCount % 500 === 0) {
            checkRotation();
            checkSize();
        }
        
        const line = JSON.stringify({
            ts: entry.ts,
            cmd: entry.cmd,
            src: entry.source,
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
export function getCommandLogPath(): string { return currentFile; }

// Initial cleanup
cleanOldFiles();
