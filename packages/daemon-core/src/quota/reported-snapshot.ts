import type { MeshNodeFacts, MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared';
import { canTransferQuotaReading } from './account-lineage.js';

/** Re-delivery time is not measurement time. Keep a newer measured snapshot
 * when an older successful report for the SAME confirmed account and reset
 * cycle arrives later. Never splice windows: their capture clock, source and
 * lineage stay together. Failures, uncertain identities, account/pool switches
 * and new reset cycles must still replace the previous observation. */
function olderReadingInSameCycle(previous: MeshNodeFactsProviderQuota, incoming: MeshNodeFactsProviderQuota): boolean {
    if (previous.status !== 'ok' || incoming.status !== 'ok' || !canTransferQuotaReading(previous, incoming)) return false;
    if (!Number.isFinite(previous.updatedAt) || !Number.isFinite(incoming.updatedAt)
        || incoming.updatedAt <= 0 || previous.updatedAt <= incoming.updatedAt) return false;
    // Bucket-based providers can expose distinct model pools. Do not infer a
    // pool join from a headline session/weekly collapse.
    if (previous.buckets?.length || incoming.buckets?.length) return false;
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
        if (prior && olderReadingInSameCycle(prior, reading)) {
            quota[provider] = prior;
            retained = true;
        }
    }
    return retained ? { ...incoming, quota } : incoming;
}
