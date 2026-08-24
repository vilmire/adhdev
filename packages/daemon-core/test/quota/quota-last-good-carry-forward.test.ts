import { describe, expect, it } from 'vitest';
import { carryForwardLastGoodWindows } from '../../src/quota/refresh.js';
import type { MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared';

// LAST-GOOD CARRY-FORWARD (owner report 2026-08-10): kimi's ~15-min OAuth
// token expires on its own cadence, so a quota tick that lands in the refresh
// window returns a TRANSIENT 'expired-token' failure. Blindly caching that
// erased the last good reading and the dashboard flipped from "28% used" to a
// numberless "token expired" error. The fix keeps the prior windows (marked as
// retained) while surfacing the fresh failure signal.
//
// Follow-up (2026-08-13): the original fix only chained off a fresh 'ok'
// predecessor, so a SECOND consecutive transient failure had no 'ok' entry to
// carry from and the numbers vanished anyway. The fix widened the predecessor
// check to also accept an already-carried-forward entry (metadata.lastGoodWindows)
// that still holds a window, so the carry survives an unbounded run of
// consecutive transient failures, not just one.

const win = (usedPercent: number) => ({ usedPercent, windowMinutes: 300, resetsAt: null });

const okReading = (): MeshNodeFactsProviderQuota => ({
    provider: 'kimi',
    status: 'ok',
    session: win(28),
    weekly: { usedPercent: 71, windowMinutes: 10080, resetsAt: null },
    updatedAt: 1_700_000,
    error: null,
    metadata: { source: 'oauth' },
});

const failure = (failureKind: string): MeshNodeFactsProviderQuota => ({
    provider: 'kimi',
    status: 'error',
    session: null,
    weekly: null,
    updatedAt: 2_000_000,
    error: `kimi ${failureKind}`,
    metadata: { source: 'oauth', failureKind },
});

describe('carryForwardLastGoodWindows', () => {
    it('a fresh OK reading always replaces wholesale', () => {
        const fresh = okReading();
        expect(carryForwardLastGoodWindows(failure('expired-token'), fresh)).toBe(fresh);
    });

    it('a TRANSIENT failure keeps the prior windows + age and carries the failure signal', () => {
        const merged = carryForwardLastGoodWindows(okReading(), failure('expired-token'));
        // Numbers survive so the dashboard still shows 28% / 71%.
        expect(merged.session?.usedPercent).toBe(28);
        expect(merged.weekly?.usedPercent).toBe(71);
        expect(merged.updatedAt).toBe(1_700_000); // the reading's own age, not the failure's
        // But the fresh failure is still surfaced for anyone who branches on it.
        expect(merged.status).toBe('error');
        expect(merged.error).toContain('expired-token');
        expect(merged.metadata?.failureKind).toBe('expired-token');
        expect(merged.metadata?.lastGoodWindows).toBe(true);
    });

    it('every transient kind (network/server/rate-limited/unauthorized) carries forward', () => {
        for (const kind of ['network', 'server', 'rate-limited', 'unauthorized', 'expired-token']) {
            const merged = carryForwardLastGoodWindows(okReading(), failure(kind));
            expect(merged.session?.usedPercent).toBe(28);
            expect(merged.metadata?.lastGoodWindows).toBe(true);
        }
    });

    it('a NON-transient failure replaces wholesale — old numbers must not mask a real problem', () => {
        for (const kind of ['missing-credentials', 'parse', 'unsupported', 'no-data', 'unknown', 'quota-exhausted', 'cli-unavailable']) {
            const fresh = failure(kind);
            const merged = carryForwardLastGoodWindows(okReading(), fresh);
            expect(merged).toBe(fresh);
            expect(merged.session).toBeNull();
        }
    });

    it('quota-exhausted (hard block) is NOT carried — must not mix with rate-limited', () => {
        const merged = carryForwardLastGoodWindows(okReading(), failure('quota-exhausted'));
        expect(merged.session).toBeNull();
        expect(merged.weekly).toBeNull();
        expect(merged.metadata?.lastGoodWindows).toBeUndefined();
        expect(merged.metadata?.failureKind).toBe('quota-exhausted');
    });

    it('rate-limited (transient 429) keeps the last numbers, distinct from quota-exhausted', () => {
        const merged = carryForwardLastGoodWindows(okReading(), failure('rate-limited'));
        expect(merged.session?.usedPercent).toBe(28);
        expect(merged.weekly?.usedPercent).toBe(71);
        expect(merged.status).toBe('error');
        expect(merged.metadata?.failureKind).toBe('rate-limited');
        expect(merged.metadata?.lastGoodWindows).toBe(true);
    });

    it('no prior reading → the failure stands alone (nothing to carry)', () => {
        const fresh = failure('expired-token');
        expect(carryForwardLastGoodWindows(undefined, fresh)).toBe(fresh);
    });

    it('a prior FAILURE that never held windows is not carried — only a real reading counts', () => {
        const fresh = failure('expired-token');
        expect(carryForwardLastGoodWindows(failure('network'), fresh)).toBe(fresh);
    });

    it('THREE consecutive transient failures still keep the numbers (the reported bug)', () => {
        // Tick 1: ok -> failure. Carries from the fresh 'ok'.
        const afterTick1 = carryForwardLastGoodWindows(okReading(), failure('expired-token'));
        expect(afterTick1.session?.usedPercent).toBe(28);
        expect(afterTick1.metadata?.lastGoodWindows).toBe(true);

        // Tick 2: carried -> failure again. Before the fix, prev.status was
        // 'error' (not 'ok'), so this used to fall through and lose the numbers.
        const afterTick2 = carryForwardLastGoodWindows(afterTick1, failure('network'));
        expect(afterTick2.session?.usedPercent).toBe(28);
        expect(afterTick2.weekly?.usedPercent).toBe(71);
        expect(afterTick2.metadata?.lastGoodWindows).toBe(true);

        // Tick 3: same again — must not regress on a longer chain either.
        const afterTick3 = carryForwardLastGoodWindows(afterTick2, failure('rate-limited'));
        expect(afterTick3.session?.usedPercent).toBe(28);
        expect(afterTick3.weekly?.usedPercent).toBe(71);
        expect(afterTick3.metadata?.lastGoodWindows).toBe(true);

        // updatedAt must stay pinned to the ORIGINAL observation the whole way
        // through, never bumped forward by a carried tick — a carried reading
        // must not look freshly measured.
        expect(afterTick1.updatedAt).toBe(1_700_000);
        expect(afterTick2.updatedAt).toBe(1_700_000);
        expect(afterTick3.updatedAt).toBe(1_700_000);
    });

    it('a carried-forward entry that lost its windows to a non-transient failure does not resurrect them', () => {
        const afterTransient = carryForwardLastGoodWindows(okReading(), failure('expired-token'));
        const afterNonTransient = carryForwardLastGoodWindows(afterTransient, failure('missing-credentials'));
        expect(afterNonTransient.session).toBeNull();
        expect(afterNonTransient.weekly).toBeNull();

        // A transient failure AFTER that non-transient one has nothing to carry.
        const afterAnotherTransient = carryForwardLastGoodWindows(afterNonTransient, failure('expired-token'));
        expect(afterAnotherTransient.session).toBeNull();
        expect(afterAnotherTransient.metadata?.lastGoodWindows).toBeUndefined();
    });
it('carries the provider-specific axes too — monthly and per-pool buckets survive a transient failure', () => {
        // antigravity's per-pool buckets and cursor's monthly window belong to
        // the same reading as session/weekly; dropping them on carry-forward
        // blanked the per-pool chips on every token blip (owner request
        // 2026-08-24: both antigravity pools must stay visible).
        const prev = {
            ...okReading(),
            provider: 'antigravity-cli',
            monthly: { usedPercent: 12, windowMinutes: 43200, resetsAt: null },
            buckets: [
                { name: 'Gemini Models · Weekly', usedPercent: 9, windowMinutes: 10080, resetsAt: null },
                { name: 'Claude/GPT · Weekly', usedPercent: 3, windowMinutes: 10080, resetsAt: null },
            ],
        };
        const merged = carryForwardLastGoodWindows(prev, { ...failure('expired-token'), provider: 'antigravity-cli' });
        expect(merged.metadata?.lastGoodWindows).toBe(true);
        expect(merged.monthly).toEqual(prev.monthly);
        expect(merged.buckets).toEqual(prev.buckets);
    });
});
