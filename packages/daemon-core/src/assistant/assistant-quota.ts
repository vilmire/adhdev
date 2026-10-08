/**
 * Assistant review-turn quota gate input (research 2026-10-08 Q7, F5): how
 * much of the assistant CLI's plan is left, as one percentage.
 *
 * The daemon already measures quota per provider (quota/refresh.ts, an
 * in-memory cache keyed by provider type — the same key as the CLI type for
 * every provider that has a fetcher). The review turn reads it through
 * `AssistantQuotaPort` so the trigger stays pure and testable; the live port
 * is a Map read, never a fetch.
 *
 * Fail-closed: anything that is not a usable reading returns null ("unknown"),
 * and the trigger skips on unknown just as on low.
 */

import type { MeshNodeFactsProviderQuota, MeshNodeFactsQuotaWindow } from '@adhdev/mesh-shared';
import { QUOTA_ROUTABLE_MAX_AGE_MS, readQuotaCache } from '../quota/refresh.js';

export interface AssistantQuotaPort {
    /** Remaining % (0–100) of the CLI's tightest current window, or null when unknown. */
    remainingPct(cliType: string, now: number): number | null;
}

/**
 * Remaining % of the tightest window in one snapshot, or null.
 *  - `quota-exhausted` → 0.
 *  - The windows count only when the snapshot is `ok`, or carries a last-good
 *    reading forward after a transient failure.
 *  - A window is current until its `resetsAt` (a measured value stays valid
 *    for the window it describes); without `resetsAt`, until the snapshot is
 *    `staleAfterMs` old. A window past its reset says nothing about now.
 *  - Session, weekly, monthly and per-pool buckets all count; the lowest
 *    remaining wins.
 */
export function quotaRemainingPct(
    entry: MeshNodeFactsProviderQuota | null | undefined,
    now: number,
    staleAfterMs: number = QUOTA_ROUTABLE_MAX_AGE_MS,
): number | null {
    if (!entry || typeof entry !== 'object') return null;
    if (entry.metadata?.failureKind === 'quota-exhausted') return 0;
    if (entry.status !== 'ok' && entry.metadata?.lastGoodWindows !== true) return null;
    const updatedAt = Number(entry.updatedAt);
    const windows: Array<Partial<MeshNodeFactsQuotaWindow> | null | undefined> = [
        entry.session, entry.weekly, entry.monthly, ...(Array.isArray(entry.buckets) ? entry.buckets : []),
    ];
    let worstUsed: number | null = null;
    for (const w of windows) {
        if (!w || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) continue;
        const resetsAt = typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? w.resetsAt : null;
        const current = resetsAt !== null ? resetsAt > now : Number.isFinite(updatedAt) && now - updatedAt < staleAfterMs;
        if (!current) continue;
        const used = Math.min(100, Math.max(0, w.usedPercent));
        worstUsed = worstUsed === null ? used : Math.max(worstUsed, used);
    }
    return worstUsed === null ? null : 100 - worstUsed;
}

/** The daemon's live quota cache (no fetch). */
export const liveAssistantQuotaPort: AssistantQuotaPort = {
    remainingPct(cliType, now) {
        return quotaRemainingPct(readQuotaCache()?.[cliType], now);
    },
};
