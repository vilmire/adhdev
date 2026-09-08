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
