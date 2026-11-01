/**
 * In-process counters for the machine quota reserve (design 2026-11-01 §2
 * "지표"): which consumer was held back by the reserve, how often the reserve
 * is edited, and how many mesh-threshold conflicts the one-time migration
 * resolved. Daemon-local, resets on restart, never leaves the machine except
 * through the `quota_reserve_get` reply the owner asked for. Counts and
 * provider/pool names only — no account keys, no content.
 */

export type QuotaReserveConsumer = 'routing' | 'assistantReview';

const blocks = new Map<string, number>();
let edits = 0;
let migrationConflictsResolved = 0;

export function recordQuotaReserveBlock(consumer: QuotaReserveConsumer, provider: string, pool?: string | null): void {
    const key = `${consumer}|${provider}${pool ? `:${pool}` : ''}`;
    blocks.set(key, (blocks.get(key) ?? 0) + 1);
}

export function recordQuotaReserveEdit(): void { edits += 1; }

export function recordQuotaReserveMigrationConflicts(count: number): void {
    if (Number.isFinite(count) && count > 0) migrationConflictsResolved += Math.floor(count);
}

export function quotaReserveStats(): {
    blocks: Array<{ consumer: QuotaReserveConsumer; target: string; count: number }>;
    edits: number;
    migrationConflictsResolved: number;
} {
    return {
        blocks: [...blocks.entries()].map(([key, count]) => {
            const [consumer, target] = key.split('|') as [QuotaReserveConsumer, string];
            return { consumer, target, count };
        }),
        edits,
        migrationConflictsResolved,
    };
}

/** Test seam. */
export function resetQuotaReserveStats(): void {
    blocks.clear();
    edits = 0;
    migrationConflictsResolved = 0;
}
