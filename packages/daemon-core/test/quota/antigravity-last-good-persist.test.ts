import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
    loadQuotaCache,
    mergeLastGoodForPersist,
    quotaCachePath,
    saveQuotaCache,
} from '../../src/quota/persist.js';
import {
    __resetQuotaHydrationForTests,
    carryForwardLastGoodWindows,
    clearQuotaCache,
    hydrateQuotaCacheFromDisk,
    readQuotaCache,
    refreshQuotaCacheOnce,
} from '../../src/quota/refresh.js';

// ANTIGRAVITY LAST-GOOD RETENTION ACROSS A RESTART.
//
// Owner report 2026-09-13: antigravity quota rendered a bald "Antigravity
// access token expired — run `agy`…" instead of the last numbers, and stayed
// that way across daemon restarts. Codex does not have this failure mode: it
// re-derives a reading from its rollout logs. Antigravity cannot — its
// credential store holds OAuth tokens, not buckets — so once the on-disk cache
// lost the numbers, nothing could rebuild them until the user ran `agy`.
//
// Three defects compounded, and each gets a contract here:
//   1. a numberless transient failure OVERWROTE the stored last-good (the file
//      is what a restart reads, so the error became sticky);
//   2. carry-forward judged "do we hold a reading?" on session/weekly alone, so
//      antigravity's buckets-only reading — which IS its measurement — was
//      declared absent and dropped;
//   3. the retained numbers were cued "refreshing", promising a self-heal the
//      daemon deliberately never performs.

const BUCKETS = [
    { name: 'Gemini Models · 5h', usedPercent: 40, windowMinutes: 300, resetsAt: null },
    { name: 'Claude/GPT · 5h', usedPercent: 12, windowMinutes: 300, resetsAt: null },
];

function okBucketsOnly(overrides: Record<string, unknown> = {}) {
    // Antigravity's live shape when neither pool maps onto the 5h/weekly axes:
    // both axes null, the real reading entirely on `buckets`.
    return {
        provider: 'antigravity-cli',
        status: 'ok',
        session: null,
        weekly: null,
        buckets: BUCKETS,
        updatedAt: 1_700_000_000_000,
        error: null,
        metadata: { source: 'oauth' },
    } as any;
}

function expiredTokenFailure(overrides: Record<string, unknown> = {}) {
    return {
        provider: 'antigravity-cli',
        status: 'error',
        session: null,
        weekly: null,
        updatedAt: 1_700_000_900_000,
        error: 'Antigravity access token expired — run `agy` once to refresh it, then quota will report again.',
        metadata: { source: 'oauth', failureKind: 'expired-token' },
        ...overrides,
    } as any;
}

let home: string;
let env: NodeJS.ProcessEnv;
let priorConfigDir: string | undefined;

beforeEach(() => {
    home = join(tmpdir(), `adhdev-agy-lastgood-${randomUUID().slice(0, 8)}`);
    mkdirSync(home, { recursive: true });
    env = { ADHDEV_CONFIG_DIR: home } as NodeJS.ProcessEnv;
    // refreshQuotaCacheOnce persists through the DEFAULT env, so the end-to-end
    // case below would otherwise write the machine's real ~/.adhdev cache —
    // which other daemons/tests on this box are actively using. Redirect it for
    // the duration of the test and put it back afterwards.
    priorConfigDir = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = home;
    clearQuotaCache();
    __resetQuotaHydrationForTests();
});

afterEach(() => {
    if (priorConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = priorConfigDir;
    try { rmSync(home, { recursive: true, force: true }); } catch { /* noop */ }
    clearQuotaCache();
});

describe('carry-forward counts a buckets-only reading as real', () => {
    it('retains buckets when the fresh read is an expired token', () => {
        const out = carryForwardLastGoodWindows(okBucketsOnly(), expiredTokenFailure());

        // The reading survives...
        expect(out.buckets).toEqual(BUCKETS);
        expect(out.metadata?.lastGoodWindows).toBe(true);
        // ...with the age of the OBSERVATION, not of the failure.
        expect(out.updatedAt).toBe(1_700_000_000_000);
        // ...while the fresh failure signal is still surfaced.
        expect(out.status).toBe('error');
        expect(out.metadata?.failureKind).toBe('expired-token');
    });

    it('chains off an already-retained buckets entry (the restart shape)', () => {
        // What hydration restores after a restart: a non-ok entry marked
        // lastGoodWindows. Without chaining, the SECOND consecutive failure
        // has no 'ok' predecessor and the numbers vanish anyway.
        const retained = carryForwardLastGoodWindows(okBucketsOnly(), expiredTokenFailure());
        const next = carryForwardLastGoodWindows(retained, expiredTokenFailure());

        expect(next.buckets).toEqual(BUCKETS);
        expect(next.metadata?.lastGoodWindows).toBe(true);
        expect(next.updatedAt).toBe(1_700_000_000_000);
    });

    it('still replaces wholesale on a NON-transient failure', () => {
        // Signed out is a real state the old numbers would mask.
        const signedOut = expiredTokenFailure({
            status: 'unavailable',
            error: 'Not signed in to Antigravity',
            metadata: { source: 'oauth', failureKind: 'missing-credentials' },
        });
        const out = carryForwardLastGoodWindows(okBucketsOnly(), signedOut);

        expect(out.buckets).toBeUndefined();
        expect(out.metadata?.lastGoodWindows).toBeUndefined();
    });
});

describe('a numberless snapshot never clobbers the stored last-good', () => {
    it('keeps stored buckets while taking the fresh failure signal', () => {
        const merged = mergeLastGoodForPersist(
            { 'antigravity-cli': expiredTokenFailure() },
            { 'antigravity-cli': okBucketsOnly() },
        );

        expect(merged['antigravity-cli'].buckets).toEqual(BUCKETS);
        expect(merged['antigravity-cli'].updatedAt).toBe(1_700_000_000_000);
        expect(merged['antigravity-cli'].metadata?.lastGoodWindows).toBe(true);
        expect(merged['antigravity-cli'].status).toBe('error');
        expect(merged['antigravity-cli'].metadata?.failureKind).toBe('expired-token');
    });

    it('lets a fresh reading replace the stored one', () => {
        const fresher = okBucketsOnly();
        fresher.updatedAt = 1_700_009_999_000;
        fresher.buckets = [{ name: 'Gemini Models · 5h', usedPercent: 77, windowMinutes: 300, resetsAt: null }];

        const merged = mergeLastGoodForPersist(
            { 'antigravity-cli': fresher },
            { 'antigravity-cli': okBucketsOnly() },
        );

        expect(merged['antigravity-cli'].buckets?.[0]?.usedPercent).toBe(77);
        expect(merged['antigravity-cli'].updatedAt).toBe(1_700_009_999_000);
        // Not a retained reading — it was measured now.
        expect(merged['antigravity-cli'].metadata?.lastGoodWindows).toBeUndefined();
    });

    it('does not resurrect a provider the enable gate pruned', () => {
        // Absent from `fresh` means deliberately dropped, not "no news".
        const merged = mergeLastGoodForPersist({}, { 'antigravity-cli': okBucketsOnly() });
        expect(merged['antigravity-cli']).toBeUndefined();
    });

    it('does not invent numbers when nothing was ever stored', () => {
        const merged = mergeLastGoodForPersist(
            { 'antigravity-cli': expiredTokenFailure() },
            undefined,
        );
        expect(merged['antigravity-cli'].buckets).toBeUndefined();
        expect(merged['antigravity-cli'].metadata?.lastGoodWindows).toBeUndefined();
    });
});

describe('★restart + expired token + prior buckets → chips, not an error wall', () => {
    it('survives a refresh-then-restart cycle with the numbers intact', async () => {
        // ── Process 1: a good reading lands and is persisted.
        await refreshQuotaCacheOnce(
            [{ provider: 'antigravity-cli' as any, fetch: async () => okBucketsOnly() }],
        );
        expect(readQuotaCache()?.['antigravity-cli']?.buckets).toEqual(BUCKETS);

        // ── Still process 1: the token expires. The tick records the failure.
        await refreshQuotaCacheOnce(
            [{ provider: 'antigravity-cli' as any, fetch: async () => expiredTokenFailure() }],
        );
        const live = readQuotaCache()?.['antigravity-cli'];
        expect(live?.buckets).toEqual(BUCKETS);
        expect(live?.metadata?.lastGoodWindows).toBe(true);

        // The FILE — what the next process reads — must still hold the numbers.
        const onDisk = loadQuotaCache();
        expect(onDisk?.['antigravity-cli']?.buckets).toEqual(BUCKETS);

        // ── Process 2: daemon restarts, hydrates, and the token is STILL expired.
        clearQuotaCache();
        __resetQuotaHydrationForTests();
        expect(hydrateQuotaCacheFromDisk()).toBe(1);
        await refreshQuotaCacheOnce(
            [{ provider: 'antigravity-cli' as any, fetch: async () => expiredTokenFailure() }],
        );

        const afterRestart = readQuotaCache()?.['antigravity-cli'];
        // ★The chips the user reads are still there...
        expect(afterRestart?.buckets).toEqual(BUCKETS);
        expect(afterRestart?.metadata?.lastGoodWindows).toBe(true);
        // ...at their original observation time, not the failure's.
        expect(afterRestart?.updatedAt).toBe(1_700_000_000_000);
        // ...and the file did not degrade either, so a THIRD restart is safe.
        expect(loadQuotaCache()?.['antigravity-cli']?.buckets).toEqual(BUCKETS);
    });

    it('keeps the numbers on disk when a fetcher THROWS', async () => {
        // ★This is the path the in-memory carry-forward cannot cover, and the
        // one the persist barrier exists for. A fetcher that breaks its
        // never-throw contract is caught in refreshQuotaCacheOnce and recorded
        // as a numberless `failureKind: 'unknown'` snapshot written STRAIGHT
        // into the cache — carryForwardLastGoodWindows is never consulted. Left
        // to persist blind, that erased the stored reading; with antigravity
        // there is no second source to rebuild it from, so the numbers were
        // gone for good. Verified by reverting the barrier: this reads
        // `undefined`.
        await refreshQuotaCacheOnce(
            [{ provider: 'antigravity-cli' as any, fetch: async () => okBucketsOnly() }],
        );
        await refreshQuotaCacheOnce([{
            provider: 'antigravity-cli' as any,
            fetch: async () => { throw new Error('contract violation'); },
        }]);

        expect(loadQuotaCache()?.['antigravity-cli']?.buckets).toEqual(BUCKETS);
        expect(loadQuotaCache()?.['antigravity-cli']?.metadata?.lastGoodWindows).toBe(true);
    });
});

describe('the persisted file keeps its existing contract', () => {
    it('saveQuotaCache still writes exactly what it is given', () => {
        // The barrier lives in mergeLastGoodForPersist, NOT in the writer: a
        // save must stay a pure serialization so seeding a cache in a test (or
        // any future caller) cannot be silently overridden by disk state.
        saveQuotaCache({ 'antigravity-cli': okBucketsOnly() }, env);
        saveQuotaCache({ 'antigravity-cli': expiredTokenFailure() }, env);

        const parsed = JSON.parse(readFileSync(quotaCachePath(env), 'utf-8'));
        expect(parsed.providers['antigravity-cli'].buckets).toBeUndefined();
    });
});
