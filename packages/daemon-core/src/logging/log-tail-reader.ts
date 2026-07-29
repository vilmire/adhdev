/**
 * Daemon log tail reader — read the last N bytes of a daemon log file, newest
 * bytes first, bounded so the result is safe to ship over a mesh P2P channel.
 *
 * Used by the mesh `get_mesh_node_logs` command: the coordinator asks a (possibly
 * remote) daemon for its recent log tail instead of having to open a session and
 * grep the file by hand. Because the mesh RPC envelope is sent as a single
 * datachannel message (~256KB SCTP ceiling, no chunking), the returned tail is
 * HARD-bounded by `tailBytes` (default 64KB, capped at MAX_TAIL_BYTES=128KB) and
 * flags `truncated:true` when more content existed than fit.
 *
 * Two read modes:
 *  - No filter (no grep/sinceMs): byte-bounded tail of the active file — read the
 *    last `tailBytes` bytes only. Cheap, backward-compatible.
 *  - Filtered (grep and/or sinceMs given): FULL-FILE scan. The filter is applied
 *    across the ENTIRE file (plus all bounded size-rotation backups) BEFORE the
 *    byte cap, then the last `tailBytes` worth of MATCHING lines are returned.
 *    This is the fix for "matches hidden behind polling spam": when the recent
 *    tail window is saturated with high-frequency lines (e.g. coordinator polling
 *    `get_pending_mesh_events`/`read_chat` every few seconds), a grep for a rarer
 *    earlier line (dispatch/inject/forward) previously matched 0 because the line
 *    had already scrolled out of the tail window before the filter ran. Filtering
 *    the whole file first surfaces those matches regardless of how much unrelated
 *    spam followed them.
 *
 * Boundary-safe: lines are cut on the newline byte (0x0A) only, which never
 * appears inside a multibyte UTF-8 sequence, so decoding each complete byte
 * segment never splits a multibyte char.
 */

import * as fs from 'fs';
import {
    getCurrentDaemonLogPath,
    getDaemonLogDir,
    MAX_SIZE_ROTATION_GENERATIONS,
} from './logger.js';

export const DEFAULT_TAIL_BYTES = 64 * 1024;
export const MAX_TAIL_BYTES = 128 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export interface ReadDaemonLogTailArgs {
    /** Date of the log file to read (defaults to today). YYYY-MM-DD string or Date. */
    date?: string | Date;
    /** Max bytes of tail to return. Clamped to (0, MAX_TAIL_BYTES]. Default 64KB. */
    tailBytes?: number;
    /** Optional regex source string; only lines matching (case-insensitive) are kept. */
    grep?: string;
    /** Optional epoch-ms floor; only lines whose leading [HH:MM:SS...] / ISO ts >= this are kept. */
    sinceMs?: number;
}

export interface DaemonLogTailResult {
    success: boolean;
    error?: string;
    lines: string[];
    /**
     * No-filter mode: true when the file was larger than the byte window.
     * Filter mode: true when matching lines were dropped from the FRONT to fit
     * the byte cap (i.e. there are older matches than the ones returned).
     */
    truncated: boolean;
    logPath: string;
    platform: NodeJS.Platform;
    bytesReturned: number;
    /** True when a grep/since filter dropped at least one line. */
    filtered: boolean;
    /** The grep source actually applied (echoed back for clarity). */
    grep?: string;
    /** True when the filtered full-file scan path ran (grep/sinceMs given). */
    fullScan: boolean;
    /** Total bytes read while scanning (filter mode scans the whole file + backup). */
    scannedBytes: number;
    /** Number of lines that matched the filter across the full scan (filter mode). */
    matchedLineCount: number;
    /** Number of scanned lines dropped by the filter ("N lines excluded by filter"). */
    excludedByFilter: number;
}

function resolveLogPath(date?: string | Date): string {
    if (date instanceof Date) return getCurrentDaemonLogPath(date);
    if (typeof date === 'string' && date.trim()) {
        const parsed = new Date(`${date.trim()}T00:00:00.000Z`);
        if (!Number.isNaN(parsed.getTime())) return getCurrentDaemonLogPath(parsed);
    }
    return getCurrentDaemonLogPath();
}

function sizeRotationPaths(primaryPath: string): string[] {
    return Array.from(
        { length: MAX_SIZE_ROTATION_GENERATIONS },
        (_, index) => primaryPath.replace(/\.log$/, `.${index + 1}.log`),
    );
}

function clampTailBytes(tailBytes?: number): number {
    if (!Number.isFinite(tailBytes) || (tailBytes as number) <= 0) return DEFAULT_TAIL_BYTES;
    return Math.min(Math.floor(tailBytes as number), MAX_TAIL_BYTES);
}

/**
 * Read up to `limitBytes` from the end of `filePath`, on a UTF-8 line boundary.
 * Returns the decoded text, whether the read was truncated (file bigger than the
 * window), and the number of bytes actually decoded.
 */
function readByteBoundedTail(filePath: string, limitBytes: number): { text: string; truncated: boolean; bytesReturned: number } {
    const fd = fs.openSync(filePath, 'r');
    try {
        const stat = fs.fstatSync(fd);
        const size = stat.size;
        if (size === 0) return { text: '', truncated: false, bytesReturned: 0 };

        const want = Math.min(limitBytes, size);
        let start = size - want;
        const truncated = start > 0;

        // Collect chunks newest-last into a buffer covering [start, size).
        const buffers: Buffer[] = [];
        let position = start;
        while (position < size) {
            const chunkSize = Math.min(READ_CHUNK_BYTES, size - position);
            const chunk = Buffer.alloc(chunkSize);
            fs.readSync(fd, chunk, 0, chunkSize, position);
            buffers.push(chunk);
            position += chunkSize;
        }
        let buf = Buffer.concat(buffers);

        // If we truncated mid-line, drop the leading partial line so we never emit
        // a half-decoded line (and never split a multibyte char at the window edge).
        if (truncated) {
            const firstNewline = buf.indexOf(0x0a);
            if (firstNewline >= 0) {
                buf = buf.subarray(firstNewline + 1);
            }
        }
        return { text: buf.toString('utf-8'), truncated, bytesReturned: buf.length };
    } finally {
        fs.closeSync(fd);
    }
}

/** Split decoded text into lines, dropping the trailing empty element a final
 * newline produces. Pure helper shared by both read modes. */
function splitLogLines(text: string): string[] {
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
}

/**
 * Keep the LAST lines whose cumulative UTF-8 byte size (counting one byte per
 * line for the joining newline) stays within `limitBytes`. Always keeps at least
 * the final line, even if it alone exceeds the cap (matches the no-filter path's
 * "never return nothing when there is content" behaviour). `truncated` is true
 * when earlier lines were dropped to fit.
 */
function takeLastLinesWithinBytes(lines: string[], limitBytes: number): { kept: string[]; truncated: boolean; bytesReturned: number } {
    if (lines.length === 0) return { kept: [], truncated: false, bytesReturned: 0 };
    let total = 0;
    let firstKept = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
        const lineBytes = Buffer.byteLength(lines[i], 'utf-8') + 1; // +1 ≈ joining newline
        // Once at least one line is kept, stop before overflowing the cap.
        if (firstKept !== lines.length && total + lineBytes > limitBytes) break;
        total += lineBytes;
        firstKept = i;
    }
    return {
        kept: lines.slice(firstKept),
        truncated: firstKept > 0,
        bytesReturned: total,
    };
}

// Parse a leading timestamp from a log line into epoch ms. The unified logger
// writes `[HH:MM:SS.mmm]` (local time, today's date) and the startup banner uses
// a full timestamp; we best-effort parse `[HH:MM:SS...]` against the file's date.
// Returns null when no timestamp can be extracted (line is then kept by sinceMs).
function parseLineEpochMs(line: string, fileDate: Date): number | null {
    const m = line.match(/^\[(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/);
    if (!m) {
        // Try an embedded ISO timestamp as a fallback.
        const iso = line.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?/);
        if (iso) {
            const t = Date.parse(iso[0].replace(' ', 'T'));
            return Number.isNaN(t) ? null : t;
        }
        return null;
    }
    const d = new Date(fileDate);
    d.setHours(Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? Number(m[4].padEnd(3, '0')) : 0);
    return d.getTime();
}

/** Build the case-insensitive line predicate for a grep source, falling back to
 * a literal (lowercased substring) match when the source is not a valid regex. */
function buildGrepPredicate(grepSource: string): (line: string) => boolean {
    let re: RegExp | null = null;
    try {
        re = new RegExp(grepSource, 'i');
    } catch {
        re = null;
    }
    if (re) {
        const compiled = re;
        return (line: string) => compiled.test(line);
    }
    const needle = grepSource.toLowerCase();
    return (line: string) => line.toLowerCase().includes(needle);
}

function fileDateFor(date?: string | Date): Date {
    if (date instanceof Date) return date;
    if (typeof date === 'string' && date.trim()) return new Date(`${date.trim()}T00:00:00.000Z`);
    return new Date();
}

function errorResult(error: string, logPath: string, platform: NodeJS.Platform): DaemonLogTailResult {
    return {
        success: false,
        error,
        lines: [],
        truncated: false,
        logPath,
        platform,
        bytesReturned: 0,
        filtered: false,
        fullScan: false,
        scannedBytes: 0,
        matchedLineCount: 0,
        excludedByFilter: 0,
    };
}

/**
 * Read the daemon log tail for `date` (default today), bounded to `tailBytes`.
 *
 * - No grep/sinceMs → byte-bounded tail of the active file (legacy behaviour).
 * - grep and/or sinceMs given → FULL-FILE scan: the filter is applied across the
 *   whole file (plus the bounded size-rotation backups) BEFORE the byte cap, so
 *   matches that have scrolled out of the recent tail window (e.g. behind
 *   coordinator polling spam) are still returned. Only the last `tailBytes` worth
 *   of matching lines ship over P2P.
 *
 * Falls back to the newest available size-rotation backup (`*.1.log` first)
 * when the primary file does not exist.
 */
export function readDaemonLogTail(args: ReadDaemonLogTailArgs = {}): DaemonLogTailResult {
    const platform = process.platform;
    const limitBytes = clampTailBytes(args.tailBytes);
    const primaryPath = resolveLogPath(args.date);
    const backupPaths = sizeRotationPaths(primaryPath);
    const primaryExists = fs.existsSync(primaryPath);
    const existingBackupPaths = backupPaths.filter((backupPath) => fs.existsSync(backupPath));

    if (!primaryExists && existingBackupPaths.length === 0) {
        return errorResult(
            `No daemon log file at ${primaryPath} (dir: ${getDaemonLogDir()})`,
            primaryPath,
            platform,
        );
    }

    // Reported log path: the active file when present, else the backup.
    const logPath = primaryExists ? primaryPath : existingBackupPaths[0];

    const hasGrep = typeof args.grep === 'string' && args.grep.trim().length > 0;
    const hasSince = Number.isFinite(args.sinceMs);
    const filterMode = hasGrep || hasSince;

    // ── No-filter mode: cheap byte-bounded tail of the active file ──────────
    if (!filterMode) {
        let raw: { text: string; truncated: boolean; bytesReturned: number };
        try {
            raw = readByteBoundedTail(logPath, limitBytes);
        } catch (e: any) {
            return errorResult(`Failed to read ${logPath}: ${e?.message ?? String(e)}`, logPath, platform);
        }
        const lines = splitLogLines(raw.text);
        return {
            success: true,
            lines,
            truncated: raw.truncated,
            logPath,
            platform,
            bytesReturned: raw.bytesReturned,
            filtered: false,
            fullScan: false,
            scannedBytes: raw.bytesReturned,
            matchedLineCount: lines.length,
            excludedByFilter: 0,
        };
    }

    // ── Filter mode: scan the WHOLE file (backup then primary, chronological)
    // so matches behind a saturated tail window are still found. ────────────
    let scannedBytes = 0;
    let allLines: string[] = [];
    try {
        // Oldest retained generation first, then the active file, preserving
        // chronological order across the bounded rotation history.
        for (const p of [...existingBackupPaths].reverse().concat(primaryExists ? [primaryPath] : [])) {
            if (!p) continue;
            const buf = fs.readFileSync(p);
            scannedBytes += buf.length;
            allLines = allLines.concat(splitLogLines(buf.toString('utf-8')));
        }
    } catch (e: any) {
        return errorResult(`Failed to read ${logPath}: ${e?.message ?? String(e)}`, logPath, platform);
    }

    const scannedLineCount = allLines.length;
    let lines = allLines;

    // since filter — keep lines at/after the floor (and lines with no timestamp).
    if (hasSince) {
        const fileDate = fileDateFor(args.date);
        const floor = args.sinceMs as number;
        lines = lines.filter((line) => {
            const ts = parseLineEpochMs(line, fileDate);
            return ts === null || ts >= floor;
        });
    }

    // grep filter
    let appliedGrep: string | undefined;
    if (hasGrep) {
        appliedGrep = (args.grep as string).trim();
        const matches = buildGrepPredicate(appliedGrep);
        lines = lines.filter(matches);
    }

    const matchedLineCount = lines.length;
    const excludedByFilter = scannedLineCount - matchedLineCount;

    // Byte cap applies to the MATCHING lines: keep the newest matches that fit.
    const capped = takeLastLinesWithinBytes(lines, limitBytes);

    return {
        success: true,
        lines: capped.kept,
        truncated: capped.truncated,
        logPath,
        platform,
        bytesReturned: capped.bytesReturned,
        filtered: excludedByFilter > 0,
        fullScan: true,
        scannedBytes,
        matchedLineCount,
        excludedByFilter,
        ...(appliedGrep ? { grep: appliedGrep } : {}),
    };
}
