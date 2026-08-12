/**
 * graph-poll-backoff — decides when the RepoMesh detail-view auto-revalidate
 * timer should slow down (mesh looks stable) or snap back to the fast rate
 * (something actually moved).
 *
 * Kept as a pure module so the decision logic is unit-testable without
 * mounting RepoMesh's effect graph.
 */
import type { RepoMeshStatus } from '@adhdev/daemon-core'

/**
 * Fields that make a graph snapshot "meaningfully different" from the last one.
 * Deliberately excludes anything that changes every tick regardless of real
 * progress (refreshedAt, per-request timestamps) — including those would mean
 * the fingerprint never repeats and backoff could never engage.
 */
function fingerprintGraph(status: RepoMeshStatus | null): string {
    if (!status) return 'null'
    const nodes = [...(status.nodes ?? [])]
        .map(n => [
            n.nodeId,
            n.health,
            n.git?.branch ?? '',
            n.git?.headCommit ?? '',
            n.git?.dirty ? '1' : '0',
            n.git?.ahead ?? 0,
            n.git?.behind ?? 0,
            n.git?.hasConflicts ? '1' : '0',
            [...(n.activeSessions ?? [])].sort().join(','),
        ].join('|'))
        // Sort by nodeId so node reordering in the response (not a real change)
        // doesn't itself count as a change.
        .sort()
        .join(';')
    const queue = status.queue?.summary
    const queueFingerprint = queue
        ? [queue.pending, queue.assigned, queue.completed, queue.failed, queue.cancelled].join(',')
        : ''
    return `${nodes}::${queueFingerprint}`
}

/** Consecutive unchanged ticks required before the interval backs off. */
export const BACKOFF_STABLE_TICKS_THRESHOLD = 4
/** Interval floor/ceiling (ms). Fast rate is the existing, deliberately-picked default (see commit 12d206c1). */
export const BACKOFF_SLOW_INTERVAL_MS = 30000

/**
 * Mutable poll-rate state threaded across ticks. `fast` is the interval to use
 * when NOT backed off (caller-supplied — GRAPH_AUTO_REVALIDATE_INTERVAL_MS on
 * standalone, GRAPH_PUSH_FALLBACK_INTERVAL_MS on cloud).
 */
export interface GraphPollBackoffState {
    lastFingerprint: string | null
    stableTicks: number
    backedOff: boolean
}

export function createGraphPollBackoffState(): GraphPollBackoffState {
    return { lastFingerprint: null, stableTicks: 0, backedOff: false }
}

/**
 * Reset to fast polling — call whenever the user takes an action that should
 * be watched closely (mesh switch, manual Refresh, node add/remove/dispatch).
 * Mutates in place so callers holding the state in a ref see the reset
 * immediately without re-subscribing.
 */
export function resetGraphPollBackoff(state: GraphPollBackoffState): void {
    state.stableTicks = 0
    state.backedOff = false
}

/**
 * Feed a freshly-loaded snapshot into the backoff state and report whether the
 * interval should be slow for the NEXT tick. Call this after every graph load
 * (both the interval tick and any explicit reload), so a real change detected
 * outside the timer (e.g. an event-driven push refresh) also resets the count.
 */
export function recordGraphSnapshot(state: GraphPollBackoffState, status: RepoMeshStatus | null): boolean {
    const fingerprint = fingerprintGraph(status)
    if (state.lastFingerprint === null) {
        // First observation — nothing to compare against yet.
        state.lastFingerprint = fingerprint
        return state.backedOff
    }
    if (fingerprint !== state.lastFingerprint) {
        state.lastFingerprint = fingerprint
        resetGraphPollBackoff(state)
        return false
    }
    state.stableTicks += 1
    if (state.stableTicks >= BACKOFF_STABLE_TICKS_THRESHOLD) {
        state.backedOff = true
    }
    return state.backedOff
}

/** Effective interval for the NEXT tick given the current backoff state. */
export function resolvePollIntervalMs(state: GraphPollBackoffState, fastIntervalMs: number): number {
    return state.backedOff ? Math.max(fastIntervalMs, BACKOFF_SLOW_INTERVAL_MS) : fastIntervalMs
}
