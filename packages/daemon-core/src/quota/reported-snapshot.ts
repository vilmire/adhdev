import type { MeshNodeFacts, MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared';
import { canTransferQuotaReading } from './account-lineage.js';

/** Re-delivery time is not measurement time. Keep a newer measured snapshot
 * when an older successful report for the SAME confirmed account and reset
 * cycle arrives later. Never splice windows: their capture clock, source and
 * lineage stay together. Current failures, uncertain identities, account/pool
 * switches and new reset cycles still replace the previous observation. */
function isOlderQuotaReport(previous: MeshNodeFactsProviderQuota, incoming: MeshNodeFactsProviderQuota): boolean {
    if (previous.status !== 'ok' || !canTransferQuotaReading(previous, incoming)) return false;
    if (!Number.isFinite(previous.updatedAt) || previous.updatedAt <= 0) return false;
    // Bucket-based providers can expose distinct model pools. Do not infer a
    // pool join from a headline session/weekly collapse or a provider error.
    if (previous.buckets?.length || incoming.buckets?.length) return false;
    if (incoming.status !== 'ok') {
        // A retained failure's updatedAt can be its LAST-GOOD data clock.
        // Only an explicit attempt clock can prove that the failure itself
        // predates our successful measurement; never hide a current failure.
        const attemptedAt = incoming.metadata?.fetchedAt;
        return typeof attemptedAt === 'number' && Number.isFinite(attemptedAt)
            && attemptedAt > 0 && attemptedAt < previous.updatedAt;
    }
    if (!Number.isFinite(incoming.updatedAt)
        || incoming.updatedAt <= 0 || previous.updatedAt <= incoming.updatedAt) return false;
    let sharedCycle = false;
    for (const axis of ['session', 'weekly', 'monthly'] as const) {
        const before = previous[axis];
        const after = incoming[axis];
        if (!before || !after) continue;
        if (before.windowMinutes !== after.windowMinutes || !Number.isFinite(before.resetsAt)
            || Number(before.resetsAt) <= 0 || before.resetsAt !== after.resetsAt) return false;
        sharedCycle = true;
    }
    return sharedCycle;
}

export function selectReportedQuotaFacts(previous: MeshNodeFacts | null | undefined, incoming: MeshNodeFacts): MeshNodeFacts {
    if (!previous?.quota || !incoming.quota) return incoming;
    const quota = { ...incoming.quota };
    let retained = false;
    // Absent providers are deliberately not resurrected (disable/account clear).
    for (const [provider, reading] of Object.entries(quota)) {
        const prior = previous.quota[provider];
        if (prior && isOlderQuotaReport(prior, reading)) {
            quota[provider] = prior;
            retained = true;
        }
    }
    return retained ? { ...incoming, quota } : incoming;
}
