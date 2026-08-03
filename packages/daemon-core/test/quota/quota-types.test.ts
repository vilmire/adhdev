import { describe, expect, it } from 'vitest';

import {
    SESSION_WINDOW_MINUTES,
    WEEKLY_WINDOW_MINUTES,
    clampPercent,
    quotaFailure,
    windowFromPercent,
    windowFromUsage,
} from '../../src/quota/types';

describe('quota window normalization', () => {
    it('clamps percentages into 0-100 and neutralizes non-finite input', () => {
        expect(clampPercent(42)).toBe(42);
        expect(clampPercent(-5)).toBe(0);
        expect(clampPercent(180)).toBe(100);
        expect(clampPercent(Number.NaN)).toBe(0);
        expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(100);
    });

    it('builds a window from a used/limit pair', () => {
        expect(windowFromUsage(25, 100, SESSION_WINDOW_MINUTES, 1234)).toEqual({
            usedPercent: 25,
            windowMinutes: SESSION_WINDOW_MINUTES,
            resetsAt: 1234,
        });
    });

    it('clamps over-limit usage rather than reporting above 100 percent', () => {
        expect(windowFromUsage(150, 100, WEEKLY_WINDOW_MINUTES)?.usedPercent).toBe(100);
    });

    it('returns null when a window cannot be described', () => {
        expect(windowFromUsage(null, 100, SESSION_WINDOW_MINUTES)).toBeNull();
        expect(windowFromUsage(10, null, SESSION_WINDOW_MINUTES)).toBeNull();
        // A zero/negative limit is not "0% used" — it is unusable data.
        expect(windowFromUsage(0, 0, SESSION_WINDOW_MINUTES)).toBeNull();
        expect(windowFromUsage(1, -5, SESSION_WINDOW_MINUTES)).toBeNull();
        expect(windowFromUsage(Number.NaN, 100, SESSION_WINDOW_MINUTES)).toBeNull();
    });

    it('builds a window from a precomputed percentage', () => {
        expect(windowFromPercent(73.5, WEEKLY_WINDOW_MINUTES, null)).toEqual({
            usedPercent: 73.5,
            windowMinutes: WEEKLY_WINDOW_MINUTES,
            resetsAt: null,
        });
        expect(windowFromPercent(null, WEEKLY_WINDOW_MINUTES)).toBeNull();
        expect(windowFromPercent(120, WEEKLY_WINDOW_MINUTES)?.usedPercent).toBe(100);
    });

    it('produces a failure snapshot with no windows and a preserved failure kind', () => {
        const failure = quotaFailure('kimi', 'unavailable', 'Not signed in', {
            failureKind: 'missing-credentials',
        });

        expect(failure).toMatchObject({
            provider: 'kimi',
            session: null,
            weekly: null,
            status: 'unavailable',
            error: 'Not signed in',
            metadata: { failureKind: 'missing-credentials' },
        });
        expect(typeof failure.updatedAt).toBe('number');
    });
});
