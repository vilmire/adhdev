/**
 * daemon-metadata-swr — pure freshness decision for daemon metadata loading.
 *
 * The daemon store (idesRef) is the held snapshot. Callers render whatever is
 * already held and freshen in the background (stale-while-revalidate). This
 * helper decides whether a background freshen is even needed, so the fetch path
 * can be reasoned about and unit-tested without React/transport wiring.
 */

export interface DaemonMetadataFreshnessInput {
    /** Force a network freshen regardless of held state. */
    force?: boolean
    /** A live metadata subscription already keeps this daemon fresh. */
    hasSubscription: boolean
    /** Epoch ms of the last successful load, or 0 if never loaded (no held data). */
    loadedAt: number
    /** Current epoch ms. */
    now: number
    /** Held data younger than this is considered fresh enough to skip. */
    minFreshMs: number
}

/**
 * Returns true when a (background) metadata load should run.
 *
 * Held-first SWR contract:
 * - force → always load.
 * - never loaded (loadedAt === 0) → load (there is nothing held to show).
 * - live subscription already keeps it fresh → skip.
 * - held data still within minFreshMs → skip (serve held, no freshen).
 * - otherwise → load (serve held immediately elsewhere, freshen in background).
 */
export function shouldLoadDaemonMetadata(input: DaemonMetadataFreshnessInput): boolean {
    const { force, hasSubscription, loadedAt, now, minFreshMs } = input
    if (force) return true
    if (loadedAt <= 0) return true
    if (hasSubscription) return false
    return (now - loadedAt) >= minFreshMs
}
