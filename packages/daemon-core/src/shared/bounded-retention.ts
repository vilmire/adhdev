// ---------------------------------------------------------------------------
// bounded-retention — TTL + cardinality bounds for long-lived daemon-side Maps
// ---------------------------------------------------------------------------
// A daemon process lives for days. Several tracking Maps were only ever written
// to, or were pruned solely by an event (`agent:stopped`, shutdown) that is not
// guaranteed to arrive — so a key class whose cardinality grows with the number
// of distinct sessions / peers / meshes seen over the daemon's lifetime grew
// without bound. These helpers make that retention explicit.
//
// Deliberately conservative by design: the callers below all have a semantic
// "still relevant" window, and a bound that expires an ENTRY THAT IS STILL LIVE
// is a correctness regression (a dropped session mirror, a lost DIRECT-fail
// streak). So:
//   • TTL is always chosen >= the caller's own staleness/validity horizon, so a
//     bound can only ever remove what the caller already treats as expired.
//   • The cardinality cap is a last-resort backstop set far above any realistic
//     working set, and it evicts the OLDEST entries first — so under any normal
//     load nothing is evicted at all.
// ---------------------------------------------------------------------------

/** Read a timestamp off a tracked entry. */
export type RetentionTimestampReader<V> = (value: V) => number;

export interface BoundedRetentionOptions<V> {
    /** Entries older than this (by `readTimestamp`) are removed. */
    ttlMs: number;
    /**
     * Hard cap on entry count, applied AFTER the TTL sweep. When exceeded, the
     * oldest entries are evicted until the map is back at the cap. Set well
     * above the realistic working set — this is a backstop, not a cache policy.
     */
    maxEntries: number;
    /** Extracts the entry's last-touched epoch-ms. */
    readTimestamp: RetentionTimestampReader<V>;
    /** Current time, injectable for tests. Defaults to `Date.now()`. */
    now?: number;
    /**
     * Optional guard: return true to protect an entry from BOTH the TTL sweep
     * and the cardinality eviction. Used where liveness is known out-of-band
     * (e.g. a peer that currently holds an open connection).
     */
    isProtected?: (key: string, value: V) => boolean;
}

export interface BoundedRetentionResult {
    /** Entries removed because they exceeded the TTL. */
    expired: number;
    /** Entries removed because the map was over `maxEntries`. */
    evicted: number;
}

/**
 * Apply TTL + cardinality bounds to `map`, mutating it in place.
 *
 * Returns what was removed so callers can log an eviction (which, for the
 * cardinality path, is a signal worth seeing — it means the working set grew
 * past the backstop).
 */
export function applyBoundedRetention<V>(
    map: Map<string, V>,
    options: BoundedRetentionOptions<V>,
): BoundedRetentionResult {
    const { ttlMs, maxEntries, readTimestamp, isProtected } = options;
    const now = options.now ?? Date.now();
    let expired = 0;
    let evicted = 0;

    if (ttlMs > 0) {
        for (const [key, value] of map) {
            if (isProtected?.(key, value)) continue;
            const at = readTimestamp(value);
            // A non-finite / zero timestamp means "never stamped" — do not treat
            // that as infinitely old (it would delete a freshly-created entry
            // whose timestamp field is filled in a later step). The cardinality
            // backstop below still covers it.
            if (!Number.isFinite(at) || at <= 0) continue;
            if (now - at > ttlMs) {
                map.delete(key);
                expired++;
            }
        }
    }

    if (maxEntries > 0 && map.size > maxEntries) {
        // Oldest-first eviction. Entries with no usable timestamp sort oldest,
        // which is right: they are the ones we have no evidence of relevance for.
        const candidates: Array<{ key: string; at: number }> = [];
        for (const [key, value] of map) {
            if (isProtected?.(key, value)) continue;
            const at = readTimestamp(value);
            candidates.push({ key, at: Number.isFinite(at) && at > 0 ? at : 0 });
        }
        candidates.sort((a, b) => a.at - b.at);
        const overflow = map.size - maxEntries;
        for (let i = 0; i < candidates.length && evicted < overflow; i++) {
            map.delete(candidates[i].key);
            evicted++;
        }
    }

    return { expired, evicted };
}

/**
 * Bounded variant of `map.set` for maps whose value IS the timestamp (number).
 *
 * Used by the "last time we did X for key K" throttle maps, whose key class
 * (sessionId, `sessionId:reason`, meshId, `meshId::daemonId`) grows with what
 * the daemon has seen and previously had no removal path at all.
 */
export function setWithBoundedRetention(
    map: Map<string, number>,
    key: string,
    at: number,
    options: { ttlMs: number; maxEntries: number; now?: number },
): BoundedRetentionResult {
    map.set(key, at);
    return applyBoundedRetention(map, {
        ttlMs: options.ttlMs,
        maxEntries: options.maxEntries,
        readTimestamp: (value) => value,
        now: options.now ?? at,
    });
}
