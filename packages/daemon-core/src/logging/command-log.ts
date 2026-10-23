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
import type { CommandSource } from '../commands/command-registry.js';
import {
    containsCredentialValue,
    isCredentialKey,
    redactCredentialString,
} from './credential-redactor.js';

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
    source: CommandSource | 'unknown';  // where it came from (see normalizeCommandSource)
    /** Transport-level peer identifier for src:'p2p' commands (the DataChannel
     *  connection id, e.g. `peer_…`). Identifier ONLY — never a username, email
     *  or any other PII. Answers "which connected peer sent this" where `src`
     *  alone only answers "it came over P2P". */
    peerId?: string;
    interactionId?: string;
    args?: Record<string, unknown>;  // command arguments (sensitive values masked)
    success?: boolean;    // result
    error?: string;       // error message if failed
    durationMs?: number;  // execution time
}

// ─── Sensitive field masking ─────────────────
const CONTENT_KEYS = new Set(['content', 'message', 'text']);
const MAX_MASK_DEPTH = 8;

function isSensitiveArgKey(key: string): boolean {
    return CONTENT_KEYS.has(key) || isCredentialKey(key);
}

function maskCommandLogValue(value: unknown, keyHint = '', depth = 0): unknown {
    if (isSensitiveArgKey(keyHint) || containsCredentialValue(value)) {
        return typeof value === 'string'
            ? `[${value.length} chars]`
            : '[masked]';
    }
    if (Array.isArray(value)) {
        if (depth >= MAX_MASK_DEPTH) return '[MaxDepth]';
        return value.map((item) => maskCommandLogValue(item, '', depth + 1));
    }
    if (typeof value === 'object' && value !== null) {
        if (depth >= MAX_MASK_DEPTH) return '[MaxDepth]';
        const nested: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            nested[k] = maskCommandLogValue(v, k, depth + 1);
        }
        return nested;
    }
    return value;
}

export function maskCommandLogArgs(args: any): Record<string, unknown> | undefined {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
    return maskCommandLogValue(args, '', 0) as Record<string, unknown>;
}

function maskArgs(args: any): Record<string, unknown> | undefined {
    return maskCommandLogArgs(args);
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
            ...(entry.peerId ? { peer: entry.peerId } : {}),
            ...(entry.interactionId ? { interactionId: entry.interactionId } : {}),
            ...(entry.args ? { args: maskArgs(entry.args) } : {}),
            ...(entry.success !== undefined ? { ok: entry.success } : {}),
            ...(entry.error ? { err: redactCredentialString(entry.error) } : {}),
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
                    peerId: parsed.peer,
                    interactionId: parsed.interactionId,
                    args: parsed.args ? maskArgs(parsed.args) : undefined,
                    success: parsed.ok,
                    error: typeof parsed.err === 'string' ? redactCredentialString(parsed.err) : parsed.err,
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
