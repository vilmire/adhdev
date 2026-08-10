import { describe, expect, it } from 'vitest';
import { carryForwardLastGoodWindows } from '../../src/quota/refresh.js';
import type { MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared';

// LAST-GOOD CARRY-FORWARD (owner report 2026-08-10): kimi's ~15-min OAuth
// token expires on its own cadence, so a quota tick that lands in the refresh
// window returns a TRANSIENT 'expired-token' failure. Blindly caching that
// erased the last good reading and the dashboard flipped from "28% used" to a
// numberless "token expired" error. The fix keeps the prior windows (marked as
// retained) while surfacing the fresh failure signal.

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
        for (const kind of ['missing-credentials', 'parse', 'unsupported', 'no-data', 'unknown']) {
            const fresh = failure(kind);
            const merged = carryForwardLastGoodWindows(okReading(), fresh);
            expect(merged).toBe(fresh);
            expect(merged.session).toBeNull();
        }
    });

    it('no prior reading → the failure stands alone (nothing to carry)', () => {
        const fresh = failure('expired-token');
        expect(carryForwardLastGoodWindows(undefined, fresh)).toBe(fresh);
    });

    it('a prior FAILURE (no windows) is not carried — only a real reading counts', () => {
        const fresh = failure('expired-token');
        expect(carryForwardLastGoodWindows(failure('network'), fresh)).toBe(fresh);
    });
});
