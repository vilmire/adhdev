import { describe, expect, it } from 'vitest';
import type { MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared';
import { quotaRemainingPct } from '../../src/assistant/assistant-quota.js';

/**
 * Review-turn quota gate input (research 2026-10-08 Q7, F5): remaining % of
 * the assistant CLI's tightest current window, null when unknown.
 */

const NOW = Date.parse('2026-10-08T12:00:00Z');
const HOUR = 3_600_000;
const win = (usedPercent: number, resetsAt: number | null = NOW + HOUR) => ({ usedPercent, windowMinutes: 300, resetsAt });
const snap = (over: Partial<MeshNodeFactsProviderQuota> = {}): MeshNodeFactsProviderQuota => ({
    provider: 'claude-cli', status: 'ok', session: win(30), weekly: win(55, NOW + 48 * HOUR), updatedAt: NOW - 60_000, error: null, ...over,
});

describe('quotaRemainingPct', () => {
    it('is 100 − the most-used current window (session, weekly, monthly, buckets)', () => {
        expect(quotaRemainingPct(snap(), NOW)).toBe(45);
        expect(quotaRemainingPct(snap({ monthly: win(90, NOW + 10 * HOUR) }), NOW)).toBe(10);
        expect(quotaRemainingPct(snap({ buckets: [{ name: 'claude', usedPercent: 85, windowMinutes: 300, resetsAt: NOW + HOUR }] }), NOW)).toBe(15);
    });

    it('unknown (null) without a snapshot, a non-ok snapshot, or no current window', () => {
        expect(quotaRemainingPct(undefined, NOW)).toBeNull();
        expect(quotaRemainingPct(snap({ status: 'error' }), NOW)).toBeNull();
        expect(quotaRemainingPct(snap({ status: 'unavailable', metadata: { failureKind: 'no-data' } }), NOW)).toBeNull();
        expect(quotaRemainingPct(snap({ session: null, weekly: null }), NOW)).toBeNull();
        // both windows already reset → the reading says nothing about now
        expect(quotaRemainingPct(snap({ session: win(99, NOW - 1), weekly: win(99, NOW - 1) }), NOW)).toBeNull();
    });

    it('a window without resetsAt is current until the snapshot is stale', () => {
        expect(quotaRemainingPct(snap({ session: win(40, null), weekly: null }), NOW)).toBe(60);
        expect(quotaRemainingPct(snap({ session: win(40, null), weekly: null, updatedAt: NOW - 2 * HOUR }), NOW, HOUR)).toBeNull();
    });

    it('a carried-forward last-good reading counts; quota-exhausted is 0', () => {
        expect(quotaRemainingPct(snap({ status: 'error', metadata: { lastGoodWindows: true } }), NOW)).toBe(45);
        expect(quotaRemainingPct(snap({ status: 'error', session: null, weekly: null, metadata: { failureKind: 'quota-exhausted' } }), NOW)).toBe(0);
    });
});
