import { describe, expect, it } from 'vitest';
import type { MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared';
import { quotaRemainingPct, resolveQuotaPoolModel } from '../../src/assistant/assistant-quota.js';

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

describe('quotaRemainingPct — antigravity pool awareness', () => {
    const bucket = (name: string, group: 'gemini' | 'claude-gpt', used: number, windowMinutes: number, resets = NOW + 48 * HOUR) =>
        ({ name, group, usedPercent: used, windowMinutes, resetsAt: resets });
    const agy = (): MeshNodeFactsProviderQuota => snap({
        provider: 'antigravity-cli',
        session: win(0, NOW + HOUR),
        weekly: { usedPercent: 94.2, windowMinutes: 10080, resetsAt: NOW + 48 * HOUR },
        buckets: [
            bucket('Gemini Models · Weekly', 'gemini', 94.2, 10080),
            bucket('Gemini Models · Five Hour', 'gemini', 0, 300, NOW + HOUR),
            bucket('Claude/GPT · Weekly', 'claude-gpt', 22, 10080),
            bucket('Claude/GPT · Five Hour', 'claude-gpt', 0, 300, NOW + HOUR),
        ],
    });

    it('Claude-model session with the Gemini pool exhausted is judged by the Claude pool only', () => {
        expect(quotaRemainingPct(agy(), NOW, undefined, 'Claude Opus 5.5 (High)')).toBe(78);
    });
    it('Gemini-model session is judged by the Gemini pool', () => {
        expect(quotaRemainingPct(agy(), NOW, undefined, 'Gemini 4 Argon (High)')).toBeCloseTo(5.8);
    });
    it('unknown or absent model keeps worst-of-all', () => {
        expect(quotaRemainingPct(agy(), NOW)).toBeCloseTo(5.8);
        expect(quotaRemainingPct(agy(), NOW, undefined, 'mystery-model')).toBeCloseTo(5.8);
    });
    it('model is ignored for non-antigravity providers', () => {
        expect(quotaRemainingPct(snap(), NOW, undefined, 'Claude Opus 5.5 (High)')).toBe(45);
    });
});

describe('resolveQuotaPoolModel', () => {
    it('picks the first state candidate that names a pool', () => {
        expect(resolveQuotaPoolModel({ controlValues: { model: 'opaque' }, launchRecord: { model: { requested: 'Claude Opus 5.5 (High)' } } })).toBe('Claude Opus 5.5 (High)');
        expect(resolveQuotaPoolModel({})).toBeUndefined();
        expect(resolveQuotaPoolModel({ controlValues: { model: 'mystery' } })).toBeUndefined();
    });
});
