import type { MeshNodeFacts, MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared';
import { canTransferQuotaReading } from './account-lineage.js';

/** Clocks from different hosts are only comparable when their capture/attempt
 * chain is causal and bounded by this receiver's known observation time and the
 * reported windows. Missing evidence means replace, never retain. */
function hasBoundedClock(reading: MeshNodeFactsProviderQuota, observedAt: number): boolean {
    const capturedAt = reading.updatedAt;
    const attemptedAt = reading.metadata?.fetchedAt;
    if (!Number.isFinite(observedAt) || observedAt <= 0
        || !Number.isFinite(capturedAt) || capturedAt <= 0
        || typeof attemptedAt !== 'number' || !Number.isFinite(attemptedAt)
        || attemptedAt < capturedAt || attemptedAt > observedAt) return false;
    for (const axis of ['session', 'weekly', 'monthly'] as const) {
        const window = reading[axis];
        if (!window) continue;
        const reset = window.resetsAt;
        const minutes = window.windowMinutes;
        if (typeof reset !== 'number' || !Number.isFinite(reset)
            || typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0
            || capturedAt >= reset || capturedAt < reset - minutes * 60_000) return false;
    }
    return true;
}

/** Re-delivery time is not measurement time. Keep a newer measured snapshot
 * only for the SAME confirmed account and positively shared reset cycle.
 * Never splice measurement windows, source or lineage. */
function isOlderQuotaReport(previous: MeshNodeFactsProviderQuota, incoming: MeshNodeFactsProviderQuota, observedAt: number): boolean {
    if (previous.status !== 'ok' || !canTransferQuotaReading(previous, incoming)) return false;
    // Bucket-based providers can expose distinct model pools. Do not infer a
    // pool join from a headline session/weekly collapse or a provider error.
    if (previous.buckets?.length || incoming.buckets?.length) return false;
    if (!hasBoundedClock(previous, observedAt) || !hasBoundedClock(incoming, observedAt)) return false;
    let sharedCycle = false;
    for (const axis of ['session', 'weekly', 'monthly'] as const) {
        const before = previous[axis];
        const after = incoming[axis];
        if (!before || !after) continue;
        if (before.windowMinutes !== after.windowMinutes || before.resetsAt !== after.resetsAt) return false;
        sharedCycle = true;
    }
    if (!sharedCycle) return false;
    // Failures can carry a last-good data clock: compare their explicit attempt
    // clock only AFTER proving the same cycle. Unknown/current failures win.
    const incomingClock = incoming.status === 'ok' ? incoming.updatedAt : incoming.metadata?.fetchedAt;
    return typeof incomingClock === 'number' && incomingClock < previous.updatedAt;
}

export function selectReportedQuotaFacts(previous: MeshNodeFacts | null | undefined, incoming: MeshNodeFacts, observedAt: number): MeshNodeFacts {
    if (!previous?.quota || !incoming.quota) return incoming;
    const quota = { ...incoming.quota };
    let retained = false;
    // Absent providers are deliberately not resurrected (disable/account clear).
    for (const [provider, reading] of Object.entries(quota)) {
        const prior = previous.quota[provider];
        if (prior && isOlderQuotaReport(prior, reading, observedAt)) {
            // Optional account identity follows the CURRENT disclosure choice,
            // even when its measurement is delayed. Do not resurrect omitted PII.
            const metadata = { ...prior.metadata };
            if (reading.metadata?.accountEmail === undefined) delete metadata.accountEmail;
            else metadata.accountEmail = reading.metadata.accountEmail;
            quota[provider] = { ...prior, metadata };
            retained = true;
        }
    }
    return retained ? { ...incoming, quota } : incoming;
}
