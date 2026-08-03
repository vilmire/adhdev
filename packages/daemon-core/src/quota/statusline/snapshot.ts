/**
 * The record the statusline wrapper writes and the quota fetcher reads.
 *
 * This is the whole contract between a process the user's terminal spawns
 * several times a second and a fetcher that may read it minutes later, so it is
 * deliberately tiny, versioned, and carries its own capture time — a consumer
 * must be able to tell a fresh reading from one left behind by a session that
 * ended yesterday.
 *
 * Content boundary: only the numbers Claude Code reports about plan
 * consumption are persisted. The statusline JSON also carries `cwd`,
 * `transcript_path`, `session_id`, cost and the model name; none of that is
 * quota, so none of it is written here.
 */
'use strict';

/** Bump when the on-disk shape changes incompatibly. */
export const SNAPSHOT_VERSION = 1;

/** One rolling window exactly as Claude Code reports it. */
export interface StatuslineWindowRecord {
    /** 0–100, as reported (`used_percentage`); not yet clamped. */
    usedPercent: number;
    /** Unix **milliseconds**, converted from the protocol's Unix seconds. */
    resetsAt: number | null;
}

export interface StatuslineSnapshot {
    version: number;
    /** Unix ms when the wrapper captured this. */
    capturedAt: number;
    /** The 5-hour rolling window, absent when Claude Code omitted it. */
    fiveHour: StatuslineWindowRecord | null;
    /** The 7-day rolling window, absent when Claude Code omitted it. */
    sevenDay: StatuslineWindowRecord | null;
    /** Claude Code version that produced the reading, for diagnostics. */
    cliVersion?: string | null;
}

/**
 * Minimum spacing between disk writes.
 *
 * Claude Code debounces statusline invocations at 300ms and re-runs the script
 * on every assistant message, so an unthrottled wrapper would write several
 * times a second for the entire life of a session. Quota moves on the order of
 * minutes; 15s of staleness is invisible to a user and removes essentially all
 * of that write traffic.
 */
export const MIN_WRITE_INTERVAL_MS = 15_000;

/**
 * Force a write even when nothing changed, so a long idle session still proves
 * the reading is current rather than letting the fetcher age it out as stale.
 */
export const MAX_WRITE_INTERVAL_MS = 30_000;

function windowsEqual(a: StatuslineWindowRecord | null, b: StatuslineWindowRecord | null): boolean {
    if (a === null || b === null) {
        return a === b;
    }
    return a.usedPercent === b.usedPercent && a.resetsAt === b.resetsAt;
}

/**
 * Decide whether a freshly-parsed reading is worth writing.
 *
 * Three rules, in order:
 *  - nothing on disk yet → always write;
 *  - inside the minimum interval → never write, even if the value changed
 *    (this is the rate limiter that survives a burst of invocations);
 *  - past the minimum → write when the numbers moved, or when the previous
 *    write is old enough that re-stamping it is worthwhile.
 */
export function shouldWriteSnapshot(
    previous: StatuslineSnapshot | null,
    next: StatuslineSnapshot,
    nowMs: number,
): boolean {
    if (previous === null) {
        return true;
    }
    const age = nowMs - previous.capturedAt;
    // A clock that jumped backwards must not wedge writes forever.
    if (age < 0) {
        return true;
    }
    if (age < MIN_WRITE_INTERVAL_MS) {
        return false;
    }
    const changed =
        !windowsEqual(previous.fiveHour, next.fiveHour) || !windowsEqual(previous.sevenDay, next.sevenDay);
    return changed || age >= MAX_WRITE_INTERVAL_MS;
}

function toFiniteNumber(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    // Percentages arrive as JSON numbers, but a string is cheap to accept and
    // costs nothing to tolerate if the protocol ever loosens.
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

/**
 * `resets_at` is Unix *seconds* in the statusline protocol; ADHDev speaks
 * milliseconds. Values already large enough to be milliseconds pass through, so
 * a future protocol change does not produce a reset date in the year 58000.
 */
function toResetMs(value: unknown): number | null {
    const seconds = toFiniteNumber(value);
    if (seconds === null || seconds <= 0) {
        return null;
    }
    return seconds > 1e11 ? seconds : Math.round(seconds * 1000);
}

function parseWindow(raw: unknown): StatuslineWindowRecord | null {
    if (typeof raw !== 'object' || raw === null) {
        return null;
    }
    const record = raw as Record<string, unknown>;
    const usedPercent = toFiniteNumber(record.used_percentage);
    if (usedPercent === null) {
        // A window with a reset time but no percentage tells us nothing about
        // consumption, which is the only thing we are here to record.
        return null;
    }
    return { usedPercent, resetsAt: toResetMs(record.resets_at) };
}

/**
 * Extract a snapshot from one statusline stdin payload.
 *
 * Returns null when the payload carries no usable window — `rate_limits` is
 * absent entirely for API-key users and for subscribers before the first API
 * response of a session, which is ordinary, not an error.
 */
export function snapshotFromStatuslineInput(input: unknown, nowMs: number): StatuslineSnapshot | null {
    if (typeof input !== 'object' || input === null) {
        return null;
    }
    const root = input as Record<string, unknown>;
    const rateLimits = root.rate_limits;
    if (typeof rateLimits !== 'object' || rateLimits === null) {
        return null;
    }
    const limits = rateLimits as Record<string, unknown>;
    const fiveHour = parseWindow(limits.five_hour);
    const sevenDay = parseWindow(limits.seven_day);
    if (fiveHour === null && sevenDay === null) {
        return null;
    }
    const version = root.version;
    return {
        version: SNAPSHOT_VERSION,
        capturedAt: nowMs,
        fiveHour,
        sevenDay,
        ...(typeof version === 'string' ? { cliVersion: version } : {}),
    };
}

/** Parse a snapshot file, returning null for anything unusable. */
export function parseSnapshotFile(raw: string): StatuslineSnapshot | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return null;
    }
    const record = parsed as Record<string, unknown>;
    if (record.version !== SNAPSHOT_VERSION) {
        return null;
    }
    const capturedAt = toFiniteNumber(record.capturedAt);
    if (capturedAt === null) {
        return null;
    }
    const fiveHour = parseRecordedWindow(record.fiveHour);
    const sevenDay = parseRecordedWindow(record.sevenDay);
    if (fiveHour === null && sevenDay === null) {
        return null;
    }
    return {
        version: SNAPSHOT_VERSION,
        capturedAt,
        fiveHour,
        sevenDay,
        ...(typeof record.cliVersion === 'string' ? { cliVersion: record.cliVersion } : {}),
    };
}

/** Re-read our own persisted window shape (camelCase), unlike the CLI's. */
function parseRecordedWindow(raw: unknown): StatuslineWindowRecord | null {
    if (typeof raw !== 'object' || raw === null) {
        return null;
    }
    const record = raw as Record<string, unknown>;
    const usedPercent = toFiniteNumber(record.usedPercent);
    if (usedPercent === null) {
        return null;
    }
    const resetsAt = toFiniteNumber(record.resetsAt);
    return { usedPercent, resetsAt: resetsAt === null ? null : resetsAt };
}
