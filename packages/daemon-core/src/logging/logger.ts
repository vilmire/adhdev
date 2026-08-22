/**
 * ADHDev Daemon — unified logger (v2)
 * 
 * log level: DEBUG < INFO < WARN < ERROR
 * 
 * Features:
 * 1. daemonLog(category, msg, level) — explicit per-category logging
 * 2. installGlobalInterceptor() — Auto-intercept console.log (once on daemon start)
 * 3. Recent log ring buffer — for remote transmission via P2P/WS
 * 4. File logging — ~/.adhdev/logs/daemon-YYYY-MM-DD.log (date-based rolling);
 *    a daemon serving a non-default port writes daemon-<port>-YYYY-MM-DD.log
 *    instead (see setLogInstancePort), so co-running daemons never interleave.
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
import { AsyncBatchWriter } from './async-batch-writer.js';
import { DEFAULT_DAEMON_PORT } from '../ipc-protocol.js';
import { resolveConfigLogsDir } from '../config/config-dir.js';

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
// Logs live under the unified ADHDev home (~/.adhdev/logs/) on every platform,
// alongside config.json, providers/, history/, daemon.pid and session-host.log.
// Earlier builds wrote to OS-specific dirs (~/Library/Logs/adhdev on macOS,
// ~/.local/share/adhdev/logs on Linux, %LOCALAPPDATA%/adhdev/logs on Windows),
// which made the daemon log undiscoverable next to everything else under
// ~/.adhdev and inconsistent with session-host.log. Honor ADHDEV_CONFIG_DIR so
// isolated/standalone namespaces keep their logs in their own home.
//
// ── Why this is resolved lazily rather than at module load ──────────────────
// This used to be a module-level `const`, which froze the log directory at
// IMPORT time. `ADHDEV_CONFIG_DIR` set any later — the normal shape of a test
// that assigns it in `beforeEach`/`test.before()` — was therefore ignored by an
// already-loaded logger, and every `LOG.warn`/`LOG.info` emitted by production
// code under test went to the REAL `~/.adhdev/logs/daemon-<date>.log`, i.e. the
// same file the live daemon writes. That is how win32-only fixture lines
// (`C:\Users\dev\...`, `wmic is not recognized`) surfaced in a live darwin
// daemon log and were mistaken for a production defect. No production state was
// ever corrupted — it is log noise only — but it reproduces on every machine
// that runs the suites without `ADHDEV_CONFIG_DIR` preset.
//
// Cost control: the write path does NOT rebuild the path per line. It reuses the
// cached `currentLogFile` and only re-derives it when either (a) the 1000-write
// rotation check runs, or (b) the raw ADHDEV_CONFIG_DIR env value differs from
// the one the cache was built from — a plain string compare on an already-loaded
// property, no path join and no syscall. That keeps logging hot-path-cheap while
// still honoring an override on the very next write rather than 1000 writes
// later. `getDaemonLogDir()` / `getCurrentDaemonLogPath()` resolve on each call;
// they are diagnostic accessors, not hot paths.
function resolveLogDir(): string {
    // Single source of truth: config/config-dir.ts (ADHDEV_CONFIG_DIR override,
    // else the running track's home config dir, then logs/). Pure resolution —
    // the write path prepares the dir via prepareLogDirOnce / getDaemonLogDir.
    return resolveConfigLogsDir();
}

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB per day
const MAX_LOG_DAYS = 7; // 7-day retention
export const MAX_SIZE_ROTATION_GENERATIONS = 3;

function ensureLogDir(dir: string): void {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { }
}

function getDateStr(): string {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// ─── Per-instance log file naming ─────────────────────────
// Several daemons can share one log dir: a second `adhdev daemon --port 19223`
// started against ~/.adhdev, or any daemon pinned to the same ADHDEV_CONFIG_DIR.
// Without an instance tag they all append to the same daemon-YYYY-MM-DD.log and
// their lines interleave, which has repeatedly sent diagnosis down the wrong
// daemon. The daemon entrypoint therefore declares the port it serves (before
// installGlobalInterceptor runs), and a non-default port moves the file to
// daemon-<port>-YYYY-MM-DD.log.
//
// Why port as the tag:
// - stable across restarts (a PID changes every launch and would proliferate
//   files faster than the 7-day sweep drains them);
// - unique among co-running daemons (two daemons cannot bind the same port);
// - already known at daemon startup, unlike any mesh/instance id.
// The DEFAULT_DAEMON_PORT instance keeps the legacy daemon-YYYY-MM-DD.log name —
// the same convention as the PID file (daemon.pid vs daemon-<port>.pid in
// daemon-cloud's daemon-pid.ts) — so every existing reader (mesh
// get_mesh_node_logs, diagnostics get_logs, docs, runbooks) keeps working for
// the primary daemon unchanged.
let logInstanceTag: string | null = null;

export function setLogInstancePort(port: number): void {
    const next = Number.isFinite(port) && port > 0 && port !== DEFAULT_DAEMON_PORT
        ? String(Math.floor(port))
        : null;
    if (next === logInstanceTag) return;
    logInstanceTag = next;
    // Re-point the active file immediately so the very next write (including the
    // startup banner from installGlobalInterceptor) lands in the tagged file.
    currentLogFile = path.join(currentLogDir, daemonLogFileName(currentDate));
}

/** The port tag currently baked into the log file name, if any. */
export function getLogInstanceTag(): string | null { return logInstanceTag; }

function daemonLogFileName(dateStr: string): string {
    return logInstanceTag
        ? `daemon-${logInstanceTag}-${dateStr}.log`
        : `daemon-${dateStr}.log`;
}

// Cached resolution of the ACTIVE log file. `currentLogDir` is retained next to
// it so a change of ADHDEV_CONFIG_DIR is detectable without re-deriving the path
// on every single write.
let currentDate = getDateStr();
let currentLogDir = resolveLogDir();
let currentLogFile = path.join(currentLogDir, daemonLogFileName(currentDate));

export function getDaemonLogDir(): string {
    // Callers treat the returned dir as ready to read/write (log-tail-reader
    // stats files under it, tests write fixtures into it), which the old
    // import-time `mkdirSync` guaranteed. Preserve that contract by preparing
    // the directory on resolution — it is a no-op once prepared.
    const dir = resolveLogDir();
    prepareLogDirOnce(dir);
    return dir;
}

export function getCurrentDaemonLogPath(date = new Date()): string {
    return path.join(getDaemonLogDir(), daemonLogFileName(date.toISOString().slice(0, 10)));
}

/**
 * Re-point the cached active log file when either the date rolled over or
 * ADHDEV_CONFIG_DIR changed. Returns true when the target file moved, so the
 * caller can drop a stale buffered writer for the previous path.
 */
function refreshCurrentLogFile(): boolean {
    const today = getDateStr();
    const dir = resolveLogDir();
    const dateChanged = today !== currentDate;
    const dirChanged = dir !== currentLogDir;
    if (!dateChanged && !dirChanged) return false;

    currentDate = today;
    currentLogDir = dir;
    currentLogDirEnv = process.env.ADHDEV_CONFIG_DIR;
    currentLogFile = path.join(dir, daemonLogFileName(today));
    // A new directory gets its full one-time preparation (create + sweep +
    // legacy-layout migration); a same-directory date rollover only needs the
    // retention sweep, which is what the original code did here.
    if (dirChanged) prepareLogDirOnce(dir);
    else if (dateChanged) cleanOldLogs(dir);
    // No handle/stream to swap: AsyncBatchWriter buffers by file path and appends
    // per path on its own timer, so lines already queued for the previous file
    // still land in that file. Switching `currentLogFile` only affects lines
    // queued from here on.
    return true;
}

/** date change detect + old file cleanup */
function checkDateRotation(): void {
    refreshCurrentLogFile();
}

/**
 * Auto-delete log files older than MAX_LOG_DAYS.
 * Takes the directory explicitly so a caller mid-switch sweeps the directory it
 * means to, not whatever the env happens to resolve to at that instant.
 */
function cleanOldLogs(logDir: string): void {
    try {
        const files = fs.readdirSync(logDir).filter(f => f.startsWith('daemon-') && f.endsWith('.log'));
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - MAX_LOG_DAYS);
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        for (const file of files) {
            // Matches both the legacy daemon-YYYY-MM-DD.log and the per-instance
            // daemon-<port>-YYYY-MM-DD.log layouts (plus their .N size-rotation
            // backups), so tagged files age out on the same 7-day retention.
            const dateMatch = file.match(/^daemon-(?:\d+-)?(\d{4}-\d{2}-\d{2})/);
            if (dateMatch && dateMatch[1] < cutoffStr) {
                try { fs.unlinkSync(path.join(logDir, file)); } catch { }
            }
        }
    } catch { }
}

function sizeRotationPath(logFile: string, generation: number): string {
    // Insert the generation before the extension: daemon-<date>.log →
    // daemon-<date>.1.log. Written generically (not a hardcoded `.log` match) so
    // the raw stdio-capture logs rotate too — `daemon-launchd.out` would keep its
    // name under a `/\.log$/`-only replace, and every generation would collide on
    // the same path. Extensionless files get the generation appended.
    const match = logFile.match(/^(.*)(\.[^./\\]+)$/);
    if (!match) return `${logFile}.${generation}`;
    return `${match[1]}.${generation}${match[2]}`;
}

export function rotateSizeGenerations(
    logFile: string,
    maxGenerations = MAX_SIZE_ROTATION_GENERATIONS,
): void {
    if (maxGenerations < 1) return;
    const oldest = sizeRotationPath(logFile, maxGenerations);
    try { fs.unlinkSync(oldest); } catch { }
    for (let generation = maxGenerations - 1; generation >= 1; generation--) {
        const source = sizeRotationPath(logFile, generation);
        const destination = sizeRotationPath(logFile, generation + 1);
        try { fs.renameSync(source, destination); } catch { }
    }
    fs.renameSync(logFile, sizeRotationPath(logFile, 1));
}

/** Default cap for raw stdio-capture logs (see rotateCaptureLogIfNeeded). */
export const MAX_CAPTURE_LOG_SIZE = 10 * 1024 * 1024; // 10 MB
/** Bounded history kept for raw stdio-capture logs. */
export const MAX_CAPTURE_LOG_GENERATIONS = 2;

/**
 * Rotate a RAW STDIO-CAPTURE log (`daemon-service.log`, `daemon-launchd.out`)
 * if it has grown past `maxSize`.
 *
 * These files are not written through this logger — they are the child's stdout/
 * stderr, wired up either as an append fd or a shell `>>` redirect — so nothing
 * in the normal write path can ever bound them. Before this helper they had
 * rotation on exactly one path (`service restart`) and retention on none:
 * `cleanOldLogs` only matches `daemon-<date>`, which neither file has. In
 * practice they simply grew forever (observed: a 44MB daemon-service.log and a
 * 36MB daemon-launchd.out).
 *
 * Call this at the moment the file is about to be opened for appending — that is
 * the one point every producer passes through, and rotating a file no writer
 * holds open avoids the fd-still-pointing-at-the-renamed-inode problem.
 *
 * Returns true if a rotation happened. Best-effort: never throws.
 */
export function rotateCaptureLogIfNeeded(
    logPath: string,
    maxSize: number = MAX_CAPTURE_LOG_SIZE,
    maxGenerations: number = MAX_CAPTURE_LOG_GENERATIONS,
): boolean {
    try {
        const stat = fs.statSync(logPath);
        if (stat.size <= maxSize) return false;
    } catch {
        return false; // no file yet — nothing to rotate
    }
    try {
        rotateSizeGenerations(logPath, maxGenerations);
        return true;
    } catch {
        return false;
    }
}

/** Roll through a bounded .1-.3 history when the size limit is reached. */
function rotateSizeIfNeeded(): void {
    try {
        const stat = fs.statSync(currentLogFile);
        if (stat.size > MAX_LOG_SIZE) {
            rotateSizeGenerations(currentLogFile);
        }
    } catch { /* file doesn't exist yet */ }
}

/**
 * One-time-per-directory startup housekeeping: create the dir, sweep expired
 * files, and migrate the pre-dated `daemon.log` / `daemon.log.old` layout.
 *
 * This used to run as a module-level side effect, which meant it fired against
 * the import-time directory — the very thing that made the log path
 * unoverridable. It is now driven from the first write into each directory, so
 * a daemon still performs exactly the same housekeeping on exactly the same
 * `~/.adhdev/logs` at startup, while a later ADHDEV_CONFIG_DIR change gets its
 * own directory prepared rather than silently reusing the first one.
 */
const preparedLogDirs = new Set<string>();

function prepareLogDirOnce(dir: string): void {
    if (preparedLogDirs.has(dir)) return;
    preparedLogDirs.add(dir);
    ensureLogDir(dir);
    cleanOldLogs(dir);
    // Migrate existing daemon.log, daemon.log.old (if present)
    try {
        const oldLog = path.join(dir, 'daemon.log');
        if (fs.existsSync(oldLog)) {
            const stat = fs.statSync(oldLog);
            const oldDate = stat.mtime.toISOString().slice(0, 10);
            fs.renameSync(oldLog, path.join(dir, `daemon-${oldDate}.log`));
        }
        const oldLogBackup = path.join(dir, 'daemon.log.old');
        if (fs.existsSync(oldLogBackup)) { fs.unlinkSync(oldLogBackup); }
    } catch { }
}

let writeCount = 0;
// The raw env value the cached `currentLogDir` was derived from. Comparing this
// is a string compare on an already-loaded property — no path join, no syscall —
// which is what lets the override be honored on the very next write instead of
// waiting for the 1000-write rotation window. Date rollover stays on the
// rotation cadence, where it has always been.
let currentLogDirEnv = process.env.ADHDEV_CONFIG_DIR;

function writeToFile(line: string): void {
    try {
        // Full re-resolve (date + dir) on the rotation cadence; the hot path
        // otherwise reuses the cached file name.
        if (++writeCount % 1000 === 0) {
            checkDateRotation();
            rotateSizeIfNeeded();
        } else if (process.env.ADHDEV_CONFIG_DIR !== currentLogDirEnv) {
            currentLogDirEnv = process.env.ADHDEV_CONFIG_DIR;
            refreshCurrentLogFile();
        }
        prepareLogDirOnce(currentLogDir);
        AsyncBatchWriter.write(currentLogFile, line + '\n');
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

 // Apply the active log level consistently to console, file, and the remote ring buffer.
 // Debug hot paths are useful when explicitly enabled, but should not inflate normal-mode logs.
    if (!shouldOutput) return;

    writeToFile(line);

    ringBuffer.push({ ts: Date.now(), level, category, message: msg });
    if (ringBuffer.length > RING_BUFFER_SIZE) {
        ringBuffer.splice(0, ringBuffer.length - RING_BUFFER_SIZE);
    }

    origConsoleLog(line);
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
/**
 * Replaces the former `LOG_DIR_PATH` const (and its sibling `LOG_PATH`, now
 * `getCurrentDaemonLogPath()`). As consts they were snapshotted at import, so
 * they named the import-time directory AND the import-time date — a long-running
 * daemon's `LOG_PATH` still pointed at yesterday's file after a rollover. Both
 * were internal to this package (never re-exported from index.ts) and had a
 * single lazy consumer, so resolving on access is correct and effectively free.
 */
export function getLogDirPath(): string { return getDaemonLogDir(); }
