/**
 * Shared scalar coercion helpers for quota fetchers.
 *
 * Every fetcher parses vendor JSON of unknown shape and vendor rate-limit
 * headers, so these two conversions were duplicated verbatim across them.
 */

/** Coerce a JSON scalar to a finite number, or `null` when it is not one. */
export function toNumber(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

/**
 * Resolve a `Retry-After` header to an absolute epoch-ms deadline.
 *
 * Accepts both header forms: delta-seconds (relative to `nowMs`) and an
 * HTTP-date. Returns `undefined` when the header is absent or unparseable.
 */
export function retryAfterMs(header: string | null, nowMs: number): number | undefined {
    if (!header) {
        return undefined;
    }
    const seconds = Number(header);
    if (Number.isFinite(seconds)) {
        return nowMs + seconds * 1000;
    }
    const at = new Date(header).getTime();
    return Number.isNaN(at) ? undefined : at;
}

/** Parse an ISO-8601 timestamp string to epoch ms, or `null` when absent/invalid. */
export function toIsoResetMs(value: unknown): number | null {
    if (typeof value !== 'string' || value.trim() === '') {
        return null;
    }
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? null : ms;
}

/**
 * Convert a Unix-seconds reset timestamp to epoch ms. Values already large
 * enough to be milliseconds pass through, so a future protocol change to ms
 * does not yield a reset date in the year 58000.
 */
export function toEpochResetMs(value: unknown): number | null {
    const seconds = toNumber(value);
    if (seconds === null || seconds <= 0) {
        return null;
    }
    return seconds > 1e11 ? seconds : seconds * 1000;
}

/**
 * Whether stored credentials are expired (or within `skewMs` of expiring).
 * A missing expiry is treated as "not expired" so the server can be the judge.
 */
export function isCredentialExpired(expiresAtMs: number | null, nowMs: number, skewMs: number): boolean {
    if (expiresAtMs === null) {
        return false;
    }
    return expiresAtMs - nowMs <= skewMs;
}
