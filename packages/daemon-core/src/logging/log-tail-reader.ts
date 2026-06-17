/**
 * Daemon log tail reader — read the last N bytes of a daemon log file, newest
 * bytes first, bounded so the result is safe to ship over a mesh P2P channel.
 *
 * Used by the mesh `get_mesh_node_logs` command: the coordinator asks a (possibly
 * remote) daemon for its recent log tail instead of having to open a session and
 * grep the file by hand. Because the mesh RPC envelope is sent as a single
 * datachannel message (~256KB SCTP ceiling, no chunking), the returned tail is
 * HARD-bounded by `tailBytes` (default 64KB, capped at MAX_TAIL_BYTES=128KB) and
 * flags `truncated:true` when the file was larger.
 *
 * Boundary-safe: lines are cut on the newline byte (0x0A) only, which never
 * appears inside a multibyte UTF-8 sequence, so decoding each complete byte
 * segment never splits a multibyte char.
 */

import * as fs from 'fs';
import { getCurrentDaemonLogPath, getDaemonLogDir } from './logger.js';

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
    truncated: boolean;
    logPath: string;
    platform: NodeJS.Platform;
    bytesReturned: number;
    /** True when a grep/since filter dropped lines from the raw tail window. */
    filtered: boolean;
    /** The grep source actually applied (echoed back for clarity). */
    grep?: string;
}

function resolveLogPath(date?: string | Date): string {
    if (date instanceof Date) return getCurrentDaemonLogPath(date);
    if (typeof date === 'string' && date.trim()) {
        const parsed = new Date(`${date.trim()}T00:00:00.000Z`);
        if (!Number.isNaN(parsed.getTime())) return getCurrentDaemonLogPath(parsed);
    }
    return getCurrentDaemonLogPath();
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

/**
 * Read the daemon log tail for `date` (default today), bounded to `tailBytes`,
 * with optional grep (regex source) and sinceMs filters. Falls back to the
 * size-rotation backup (`*.1.log`) when the primary file does not exist.
 */
export function readDaemonLogTail(args: ReadDaemonLogTailArgs = {}): DaemonLogTailResult {
    const platform = process.platform;
    const limitBytes = clampTailBytes(args.tailBytes);
    let logPath = resolveLogPath(args.date);

    // Fall back to the size-rotation backup if the active file is absent.
    if (!fs.existsSync(logPath)) {
        const backup = logPath.replace(/\.log$/, '.1.log');
        if (fs.existsSync(backup)) {
            logPath = backup;
        } else {
            return {
                success: false,
                error: `No daemon log file at ${logPath} (dir: ${getDaemonLogDir()})`,
                lines: [],
                truncated: false,
                logPath,
                platform,
                bytesReturned: 0,
                filtered: false,
            };
        }
    }

    let raw: { text: string; truncated: boolean; bytesReturned: number };
    try {
        raw = readByteBoundedTail(logPath, limitBytes);
    } catch (e: any) {
        return {
            success: false,
            error: `Failed to read ${logPath}: ${e?.message ?? String(e)}`,
            lines: [],
            truncated: false,
            logPath,
            platform,
            bytesReturned: 0,
            filtered: false,
        };
    }

    let lines = raw.text.split('\n');
    // A trailing newline yields a final empty element — drop it.
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const rawCount = lines.length;

    // since filter
    if (Number.isFinite(args.sinceMs)) {
        const fileDate = args.date instanceof Date
            ? args.date
            : typeof args.date === 'string' && args.date.trim()
                ? new Date(`${args.date.trim()}T00:00:00.000Z`)
                : new Date();
        const floor = args.sinceMs as number;
        lines = lines.filter((line) => {
            const ts = parseLineEpochMs(line, fileDate);
            // Keep lines with no parseable timestamp (continuation/stack lines).
            return ts === null || ts >= floor;
        });
    }

    // grep filter
    let appliedGrep: string | undefined;
    if (typeof args.grep === 'string' && args.grep.trim()) {
        appliedGrep = args.grep.trim();
        let re: RegExp | null = null;
        try {
            re = new RegExp(appliedGrep, 'i');
        } catch {
            re = null;
        }
        if (re) {
            const compiled = re;
            lines = lines.filter((line) => compiled.test(line));
        } else {
            // Invalid regex → fall back to a literal substring match.
            const needle = appliedGrep.toLowerCase();
            lines = lines.filter((line) => line.toLowerCase().includes(needle));
        }
    }

    return {
        success: true,
        lines,
        truncated: raw.truncated,
        logPath,
        platform,
        bytesReturned: raw.bytesReturned,
        filtered: lines.length !== rawCount,
        ...(appliedGrep ? { grep: appliedGrep } : {}),
    };
}
