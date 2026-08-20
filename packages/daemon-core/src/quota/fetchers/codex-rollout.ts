/**
 * Codex quota read from the CLI's own session rollout logs — no network, no
 * child process, no credential.
 *
 * ── Why this exists ──
 * The app-server path (`./codex.ts`) asks the CLI to call `/wham/usage` on our
 * behalf. Measured 2026-08-20 that endpoint answers 401 for an account whose
 * token is perfectly valid — the same token was completing chat turns minutes
 * earlier and does not expire until 2026-08-30. So the 401 is an ENDPOINT
 * ENTITLEMENT answer, not a sign-in problem, and the CLI's own advice
 * ("sign in again") sends the user to fix something that is not broken.
 *
 * Meanwhile the numbers are already on disk. Codex streams `rate_limits`
 * alongside its `token_count` events during ordinary chat, and writes every
 * event to `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. Reading
 * the newest one costs nothing and cannot be rejected by an entitlement check.
 * The precedent is grok (2026-08-15), where observing the tool's own log
 * likewise replaced an endpoint that had been judged unreachable.
 *
 * ── What this is NOT ──
 * A live query. These numbers are as fresh as the user's last Codex turn, in
 * exactly the way Claude's statusline snapshot is as fresh as the last prompt
 * (`./claude.ts`) — so this fetcher borrows that fetcher's discipline: a
 * reading older than the staleness bound is reported AS stale, with its true
 * capture time, and never presented as a current measurement. Nothing here
 * interpolates, extrapolates or averages; a value we did not observe is not
 * reported.
 *
 * ── Format facts (observed, codex-cli 0.5x rollouts, 2026-08-20) ──
 * One JSON object per line. The records we want look like:
 *   {"timestamp":"2026-08-20T05:31:25.185Z","type":"event_msg",
 *    "payload":{"type":"token_count","rate_limits":{
 *      "primary":{"used_percent":2.0,"window_minutes":10080,"resets_at":1787796696},
 *      "secondary":null,"plan_type":"plus"}}}
 * Note snake_case here versus the app-server's camelCase, and `resets_at` in
 * Unix SECONDS. `primary` is not necessarily the 5h window — on a Plus account
 * it is the 7-day one and `secondary` is absent — so windows are sorted by
 * duration, reusing `assignWindows` from the app-server fetcher rather than
 * re-deriving that rule and letting the two drift.
 */
'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    SESSION_WINDOW_MINUTES,
    WEEKLY_WINDOW_MINUTES,
    quotaFailure,
    windowFromPercent,
    type ProviderQuota,
    type QuotaMetadata,
    type QuotaWindow,
} from '../types.js';
import { assignWindows } from './codex-windows.js';
import type { QuotaFetchDeps } from './deps.js';
import { resolveDeps } from './deps.js';

/**
 * How old a rollout reading may be and still count as current.
 *
 * Deliberately far looser than Claude's 10 minutes: the statusline wrapper
 * re-stamps every 30s while a session is open, so a 10-minute gap there really
 * does mean "no session". Codex writes `rate_limits` only when a turn produces
 * a token_count event, so a user thinking between prompts leaves a long
 * legitimate gap. 6 hours is past the 5h window boundary, which is the point
 * where a reading stops describing the window the user is currently in.
 */
export const CODEX_ROLLOUT_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** How far back to look for a rollout file before giving up. */
const MAX_LOOKBACK_DAYS = 14;

/**
 * Cap on bytes read from the tail of a rollout file.
 *
 * Rollouts reach several MB and the record we want is near the END (the latest
 * turn), so the file is read backwards in chunks. This bounds a pathological
 * file rather than the normal case — a hit is usually in the first chunk.
 */
const TAIL_CHUNK_BYTES = 256 * 1024;
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

const SOURCE = 'rollout';

/** `$CODEX_HOME`, or `~/.codex`. Never hardcoded — the user may relocate it. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
    const override = env.CODEX_HOME?.trim();
    return override ? override : path.join(os.homedir(), '.codex');
}

export function codexSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
    return path.join(codexHome(env), 'sessions');
}

/**
 * The `rate_limits` object as it appears in a rollout line.
 *
 * Every field is optional: this is another tool's log format, and a shape we
 * did not anticipate must degrade to "no reading" rather than to a wrong one.
 */
export interface RolloutRateLimits {
    session: QuotaWindow | null;
    weekly: QuotaWindow | null;
    planType: string | null;
    /** Unix ms parsed from the record's own `timestamp`. */
    capturedAt: number;
}

function toNumber(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

/** `resets_at` is Unix seconds; pass through anything already in ms. */
function toResetMs(value: unknown): number | null {
    const seconds = toNumber(value);
    if (seconds === null || seconds <= 0) return null;
    return seconds > 1e11 ? seconds : seconds * 1000;
}

function mapRolloutWindow(raw: unknown, fallbackMinutes: number): QuotaWindow | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const record = raw as Record<string, unknown>;
    const minutes = toNumber(record.window_minutes) ?? fallbackMinutes;
    return windowFromPercent(toNumber(record.used_percent), minutes, toResetMs(record.resets_at));
}

/**
 * Parse one rollout line into a reading, or null when it carries none.
 *
 * Null covers every "not this line" case identically — malformed JSON, a
 * different event type, a `rate_limits` with no usable window — because the
 * caller's only sensible response to all of them is to keep scanning. A
 * truncated final line (the CLI was mid-write) is the common one and must not
 * throw.
 */
export function parseRolloutLine(line: string): RolloutRateLimits | null {
    const trimmed = line.trim();
    if (trimmed === '' || !trimmed.startsWith('{')) return null;
    // Cheap reject before the parse: most lines in a multi-MB rollout are
    // message content, and JSON.parse on all of them is the whole cost.
    if (!trimmed.includes('"rate_limits"')) return null;

    let record: Record<string, unknown>;
    try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
        record = parsed as Record<string, unknown>;
    } catch {
        return null;
    }

    const payload = record.payload;
    if (typeof payload !== 'object' || payload === null) return null;
    const limits = (payload as Record<string, unknown>).rate_limits;
    if (typeof limits !== 'object' || limits === null) return null;
    const limitsRecord = limits as Record<string, unknown>;

    const reported: QuotaWindow[] = [];
    const primary = mapRolloutWindow(limitsRecord.primary, SESSION_WINDOW_MINUTES);
    if (primary) reported.push(primary);
    const secondary = mapRolloutWindow(limitsRecord.secondary, WEEKLY_WINDOW_MINUTES);
    if (secondary) reported.push(secondary);
    if (reported.length === 0) return null;

    const { session, weekly } = assignWindows(reported);

    const capturedAt = Date.parse(typeof record.timestamp === 'string' ? record.timestamp : '');
    if (!Number.isFinite(capturedAt)) {
        // Without a capture time we cannot judge staleness, and a reading we
        // cannot date is one we must not present as current.
        return null;
    }

    const planTypeRaw = limitsRecord.plan_type;
    return {
        session,
        weekly,
        planType: typeof planTypeRaw === 'string' && planTypeRaw !== '' ? planTypeRaw : null,
        capturedAt,
    };
}

/**
 * Scan a rollout file backwards for the newest reading.
 *
 * Backwards because the freshest record is the last one, and a forward scan of
 * a 3 MB file to reach it would parse thousands of irrelevant chat lines. The
 * first chunk boundary is handled by discarding the leading partial line —
 * except at file start, where there is nothing before it to be partial.
 */
export function readLatestRateLimitsFromFile(file: string): RolloutRateLimits | null {
    let fd: number;
    try {
        fd = fs.openSync(file, 'r');
    } catch {
        return null;
    }
    try {
        const size = fs.fstatSync(fd).size;
        let position = size;
        let carry = '';
        let consumed = 0;

        while (position > 0 && consumed < MAX_TAIL_BYTES) {
            const length = Math.min(TAIL_CHUNK_BYTES, position);
            position -= length;
            consumed += length;
            const buffer = Buffer.alloc(length);
            fs.readSync(fd, buffer, 0, length, position);
            const text = buffer.toString('utf-8') + carry;

            const lines = text.split('\n');
            // The first element may be a partial line whose head lies in the
            // chunk we have not read yet — unless we are at the file start.
            carry = position > 0 ? lines.shift() ?? '' : '';

            for (let i = lines.length - 1; i >= 0; i -= 1) {
                const parsed = parseRolloutLine(lines[i]);
                if (parsed) return parsed;
            }
        }
        return null;
    } catch {
        return null;
    } finally {
        try {
            fs.closeSync(fd);
        } catch {
            // Nothing useful to do about a failed close.
        }
    }
}

/**
 * Rollout files newest-first, walking `sessions/YYYY/MM/DD/` back from today.
 *
 * Directory-date order rather than mtime: the layout is already
 * chronologically sorted, and a same-day set is ordered by the timestamp in
 * the filename, so no `stat` per file is needed. Bounded by MAX_LOOKBACK_DAYS
 * because a machine that has not run Codex in two weeks has no reading worth
 * reporting, and scanning its whole history to conclude that is waste.
 */
export function listRolloutFilesNewestFirst(
    env: NodeJS.ProcessEnv = process.env,
    nowMs: number = Date.now(),
): string[] {
    const root = codexSessionsDir(env);
    const files: string[] = [];
    for (let back = 0; back <= MAX_LOOKBACK_DAYS; back += 1) {
        const day = new Date(nowMs - back * 24 * 60 * 60 * 1000);
        const dir = path.join(
            root,
            String(day.getUTCFullYear()),
            String(day.getUTCMonth() + 1).padStart(2, '0'),
            String(day.getUTCDate()).padStart(2, '0'),
        );
        let entries: string[];
        try {
            entries = fs.readdirSync(dir);
        } catch {
            continue;
        }
        const dayFiles = entries
            .filter((name) => name.startsWith('rollout-') && name.endsWith('.jsonl'))
            .sort()
            .reverse()
            .map((name) => path.join(dir, name));
        files.push(...dayFiles);
    }
    return files;
}

/**
 * How many rollout files to open before concluding there is no reading.
 *
 * A file with no `rate_limits` at all is normal (a session that errored out
 * before its first turn), so one miss must not end the search — but neither
 * should we open a fortnight of logs. Sized to cover a handful of short
 * sessions in a row.
 */
const MAX_FILES_SCANNED = 8;

export interface RolloutReadResult {
    reading: RolloutRateLimits | null;
    /** Files opened, so a caller can say "looked and found nothing". */
    filesScanned: number;
}

/** Newest reading across the most recent rollout files. */
export function readLatestCodexRateLimits(
    env: NodeJS.ProcessEnv = process.env,
    nowMs: number = Date.now(),
): RolloutReadResult {
    const files = listRolloutFilesNewestFirst(env, nowMs);
    let scanned = 0;
    let best: RolloutRateLimits | null = null;
    /**
     * Files opened since the first hit. Filenames sort by session START time,
     * but a long-running earlier session can hold a LATER record than a short
     * later one — so the first hit is not automatically the newest, and exactly
     * one more file is examined to catch that. Counting since the hit (rather
     * than testing the absolute scan count) is what makes the bound hold when
     * the first files searched turn out to contain nothing at all.
     */
    let scannedSinceHit = 0;
    for (const file of files) {
        if (scanned >= MAX_FILES_SCANNED) break;
        scanned += 1;
        const reading = readLatestRateLimitsFromFile(file);
        if (reading && (best === null || reading.capturedAt > best.capturedAt)) {
            best = reading;
        }
        if (best !== null) {
            scannedSinceHit += 1;
            if (scannedSinceHit >= 2) break;
        }
    }
    return { reading: best, filesScanned: scanned };
}

/**
 * Build a quota snapshot from the local rollout logs. Network calls: zero.
 *
 * Never throws. Returns `null` when there is no reading at all, letting the
 * caller decide whether to fall back — this function does not invent a failure
 * snapshot for a condition ("Codex has simply not been used") that the caller
 * may be able to answer better.
 */
export function fetchCodexQuotaFromRollout(overrides: QuotaFetchDeps = {}): ProviderQuota | null {
    const deps = resolveDeps(overrides);
    const now = deps.now();
    const { reading } = readLatestCodexRateLimits(deps.env, now);
    if (reading === null) return null;

    const metadata: QuotaMetadata = {
        source: SOURCE,
        ...(reading.planType !== null ? { planType: reading.planType } : {}),
    };

    const age = now - reading.capturedAt;
    if (age > CODEX_ROLLOUT_STALE_AFTER_MS) {
        const hours = Math.round(age / (60 * 60 * 1000));
        // Same contract as the Claude fetcher's stale branch: report the real
        // windows with their REAL capture time and an explicit stale marker.
        // Consumption since then is unknown, and guessing at it would be the
        // one thing worse than saying so.
        return {
            provider: 'codex-cli',
            session: reading.session,
            weekly: reading.weekly,
            updatedAt: reading.capturedAt,
            error: `Codex quota reading is stale (${hours}h old) — run codex to refresh`,
            status: 'error',
            metadata: { ...metadata, failureKind: 'no-data' },
        };
    }

    return {
        provider: 'codex-cli',
        session: reading.session,
        weekly: reading.weekly,
        updatedAt: reading.capturedAt,
        error: null,
        status: 'ok',
        metadata,
    };
}

/** A "looked locally, found nothing" snapshot, for when no fallback answered. */
export function codexRolloutMissingFailure(env: NodeJS.ProcessEnv = process.env): ProviderQuota {
    return quotaFailure(
        'codex-cli',
        'unavailable',
        `No Codex usage recorded yet in ${codexSessionsDir(env)} — run codex on this machine, then retry`,
        { source: SOURCE, failureKind: 'no-data' },
    );
}
