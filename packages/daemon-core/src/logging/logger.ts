/**
 * ADHDev Daemon — unified logger (v2)
 * 
 * log level: DEBUG < INFO < WARN < ERROR
 * 
 * Features:
 * 1. daemonLog(category, msg, level) — explicit per-category logging
 * 2. installGlobalInterceptor() — Auto-intercept console.log (once on daemon start)
 * 3. Recent log ring buffer — for remote transmission via P2P/WS
 * 4. File logging — ~/Library/Logs/adhdev/daemon.log (10MB rolling)
 * 
 * use:
 * import { daemonLog, LOG } from './daemon-logger';
 * LOG.info('CDP', 'Connected to cursor on port 9333');
 * LOG.debug('StatusReport', 'P2P heartbeat sent');
 * LOG.warn('IdeInstance', 'onTick error: ...');
 * LOG.error('Server', 'WebSocket disconnected');
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Log Level ──────────────────────────────
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_NUM: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_LABEL: Record<LogLevel, string> = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' };

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
    currentLevel = level;
    daemonLog('Logger', `Log level set to: ${level}`, 'info');
}

export function getLogLevel(): LogLevel { return currentLevel; }
// ─── File logging (date-based rolling) ──────────────────────────────
const LOG_DIR = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'adhdev', 'logs')
    : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Logs', 'adhdev')
        : path.join(os.homedir(), '.local', 'share', 'adhdev', 'logs');

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB per day
const MAX_LOG_DAYS = 7; // 7-day retention

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { }

function getDateStr(): string {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

let currentDate = getDateStr();
let currentLogFile = path.join(LOG_DIR, `daemon-${currentDate}.log`);

/** date change detect + old file cleanup */
function checkDateRotation(): void {
    const today = getDateStr();
    if (today !== currentDate) {
        currentDate = today;
        currentLogFile = path.join(LOG_DIR, `daemon-${currentDate}.log`);
        cleanOldLogs();
    }
}

/** Auto-delete log files older than MAX_LOG_DAYS */
function cleanOldLogs(): void {
    try {
        const files = fs.readdirSync(LOG_DIR).filter(f => f.startsWith('daemon-') && f.endsWith('.log'));
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - MAX_LOG_DAYS);
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        for (const file of files) {
            const dateMatch = file.match(/daemon-(\d{4}-\d{2}-\d{2})/);
            if (dateMatch && dateMatch[1] < cutoffStr) {
                try { fs.unlinkSync(path.join(LOG_DIR, file)); } catch { }
            }
        }
    } catch { }
}

/** Roll to .1 file when size limit reached within same date */
function rotateSizeIfNeeded(): void {
    try {
        const stat = fs.statSync(currentLogFile);
        if (stat.size > MAX_LOG_SIZE) {
            const backup = currentLogFile.replace('.log', '.1.log');
            try { fs.unlinkSync(backup); } catch { }
            fs.renameSync(currentLogFile, backup);
        }
    } catch { /* file doesn't exist yet */ }
}

// start when cleanup
cleanOldLogs();
// Migrate existing daemon.log, daemon.log.old (if present)
try {
    const oldLog = path.join(LOG_DIR, 'daemon.log');
    if (fs.existsSync(oldLog)) {
        const stat = fs.statSync(oldLog);
        const oldDate = stat.mtime.toISOString().slice(0, 10);
        fs.renameSync(oldLog, path.join(LOG_DIR, `daemon-${oldDate}.log`));
    }
    const oldLogBackup = path.join(LOG_DIR, 'daemon.log.old');
    if (fs.existsSync(oldLogBackup)) { fs.unlinkSync(oldLogBackup); }
} catch { }

let writeCount = 0;

function writeToFile(line: string): void {
    try {
 // Check date change + file size every 1000 writes
        if (++writeCount % 1000 === 0) {
            checkDateRotation();
            rotateSizeIfNeeded();
        }
        fs.appendFileSync(currentLogFile, line + '\n');
    } catch { }
}

// ─── Ring buffer (for remote transmission) ─────────────────
export interface LogEntry {
    ts: number;
    level: LogLevel;
    category: string;
    message: string;
}

const RING_BUFFER_SIZE = 200;
const ringBuffer: LogEntry[] = [];

/** Get recent N logs (for remote transmission) */
export function getRecentLogs(count = 50, minLevel: LogLevel = 'info'): LogEntry[] {
    const minNum = LEVEL_NUM[minLevel];
    const filtered = ringBuffer.filter(e => LEVEL_NUM[e.level] >= minNum);
    return filtered.slice(-count);
}

/** Ring buffer current size */
export function getLogBufferSize(): number { return ringBuffer.length; }

// ─── Timestamp ─────────────────────────────
function ts(): string {
    return new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
}

function fullTs(): string {
    return new Date().toISOString();
}

// ─── Preserve original console ──────────────────────
const origConsoleLog = console.log.bind(console);
const origConsoleError = console.error.bind(console);
const origConsoleWarn = console.warn.bind(console);

// ─── Core logging function ─────────────────────────

/**
 * Explicit per-category logging
 * level filter apply, File logging, Ring buffer save
 */
export function daemonLog(category: string, msg: string, level: LogLevel = 'info'): void {
 // Level filter (console output)
    const shouldOutput = LEVEL_NUM[level] >= LEVEL_NUM[currentLevel];

    const label = LEVEL_LABEL[level];
    const line = `[${ts()}] [${label}] [${category}] ${msg}`;

 // Always record to file (including DEBUG)
    writeToFile(line);

 // Always save to ring buffer (for remote transmission)
    ringBuffer.push({ ts: Date.now(), level, category, message: msg });
    if (ringBuffer.length > RING_BUFFER_SIZE) {
        ringBuffer.splice(0, ringBuffer.length - RING_BUFFER_SIZE);
    }

 // Apply filter to console output
    if (shouldOutput) {
        origConsoleLog(line);
    }
}

// ─── Convenience API ────────────────────────────────

/**
 * Scoped logger instance for a specific component.
 * Created via LOG.forComponent('CDP:cursor').
 */
export interface ScopedLogger {
    debug: (msg: string) => void;
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    /** Returns a plain (msg: string) => void function at the given level.
     *  Useful as logFn callback for ProviderLoader, DaemonStatusReporter, etc. */
    asLogFn: (level?: LogLevel) => (msg: string) => void;
}

/**
 * LOG — unified logging API
 *
 * Usage:
 *   LOG.info('CDP', 'Connected to cursor on port 9333');
 *   LOG.debug('StatusReport', 'P2P heartbeat sent');
 *
 * Component-scoped logger:
 *   const log = LOG.forComponent('ACP:cursor');
 *   log.info('Session created');
 *   log.debug('Heartbeat');
 *
 * As callback for external components:
 *   new ProviderLoader({ logFn: LOG.forComponent('Provider').asLogFn() });
 *   new DaemonStatusReporter({ logFn: LOG.forComponent('Status').asLogFn() });
 */
export const LOG = {
    debug: (category: string, msg: string) => daemonLog(category, msg, 'debug'),
    info: (category: string, msg: string) => daemonLog(category, msg, 'info'),
    warn: (category: string, msg: string) => daemonLog(category, msg, 'warn'),
    error: (category: string, msg: string) => daemonLog(category, msg, 'error'),

    /**
     * Create a scoped logger for a specific component.
     * Category is baked in so callers only pass the message.
     */
    forComponent(category: string): ScopedLogger {
        return {
            debug: (msg: string) => daemonLog(category, msg, 'debug'),
            info: (msg: string) => daemonLog(category, msg, 'info'),
            warn: (msg: string) => daemonLog(category, msg, 'warn'),
            error: (msg: string) => daemonLog(category, msg, 'error'),
            asLogFn: (level: LogLevel = 'info') => (msg: string) => daemonLog(category, msg, level),
        };
    },
};

// ─── global interceptor ────────────────────────

let interceptorInstalled = false;

/**
 * console.log/warn/error global interceptor install
 * Prevent recording in places not using daemonLog.
 * daemon start when 1time call.
 */
export function installGlobalInterceptor(): void {
    if (interceptorInstalled) return;
    interceptorInstalled = true;

    const stripAnsi = (str: string) => str.replace(/\x1B\[[0-9;]*m/g, '');

 // Ignore lines already recorded via daemonLog (prevent duplicates)
    const isDaemonLogLine = (msg: string) => /\[(DBG|INF|WRN|ERR)\]/.test(msg);

    console.log = (...args: any[]) => {
        origConsoleLog(...args);
        try {
            const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
            const clean = stripAnsi(msg);
 // Skip lines not yet recorded via daemonLog
            if (isDaemonLogLine(clean)) return;
            const line = clean.startsWith('[20') ? clean : `[${fullTs()}] ${clean}`;
            writeToFile(line);
 // Also save to ring buffer (auto-detect category)
            const catMatch = clean.match(/\[([^\]]+)\]/);
            ringBuffer.push({
                ts: Date.now(),
                level: 'info',
                category: catMatch?.[1] || 'System',
                message: clean,
            });
            if (ringBuffer.length > RING_BUFFER_SIZE) {
                ringBuffer.splice(0, ringBuffer.length - RING_BUFFER_SIZE);
            }
        } catch { }
    };

    console.error = (...args: any[]) => {
        origConsoleError(...args);
        try {
            const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
            const clean = stripAnsi(msg);
            if (isDaemonLogLine(clean)) return;
            const line = `[${fullTs()}] [ERROR] ${clean}`;
            writeToFile(line);
            ringBuffer.push({ ts: Date.now(), level: 'error', category: 'System', message: clean });
            if (ringBuffer.length > RING_BUFFER_SIZE) {
                ringBuffer.splice(0, ringBuffer.length - RING_BUFFER_SIZE);
            }
        } catch { }
    };

    console.warn = (...args: any[]) => {
        origConsoleWarn(...args);
        try {
            const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
            const clean = stripAnsi(msg);
            if (isDaemonLogLine(clean)) return;
            const line = `[${fullTs()}] [WARN] ${clean}`;
            writeToFile(line);
            ringBuffer.push({ ts: Date.now(), level: 'warn', category: 'System', message: clean });
            if (ringBuffer.length > RING_BUFFER_SIZE) {
                ringBuffer.splice(0, ringBuffer.length - RING_BUFFER_SIZE);
            }
        } catch { }
    };

    writeToFile(`\n=== ADHDev Daemon started at ${fullTs()} ===`);
    writeToFile(`Log file: ${currentLogFile}`);
    writeToFile(`Log level: ${currentLevel}`);
}

/** current log file path (dateper) */
export function getLogPath(): string { return currentLogFile; }
/** LOG_PATH — backward compat (current date file) */
export const LOG_PATH = path.join(LOG_DIR, `daemon-${getDateStr()}.log`);
export const LOG_DIR_PATH = LOG_DIR;
