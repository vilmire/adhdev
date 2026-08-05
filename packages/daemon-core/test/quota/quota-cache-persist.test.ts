import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
    QUOTA_CACHE_VERSION,
    loadQuotaCache,
    quotaCachePath,
    saveQuotaCache,
} from '../../src/quota/persist.js';
import {
    __resetQuotaHydrationForTests,
    clearQuotaCache,
    hydrateQuotaCacheFromDisk,
    readQuotaCache,
    refreshQuotaCacheOnce,
} from '../../src/quota/refresh.js';

// QUOTA FILE CACHE.
//
// The in-memory Map is the runtime authority; this file is only its
// serialization, so a restart can show the last measurement instead of an empty
// "never reported" state. Two properties matter most and are pinned below:
//
//  - the READ path stays a synchronous, side-effect-free Map lookup. Hydration
//    is a separate one-shot; putting file I/O behind readQuotaCache() would put
//    it inside every git_status, which mesh_status calls per node.
//  - every file problem degrades to "no cache", which is exactly the state a
//    daemon is in before its first refresh. A bad file must never be able to
//    break startup or a read.

let home: string;
let env: NodeJS.ProcessEnv;

function makeQuota(overrides: Record<string, unknown> = {}) {
    return {
        provider: 'codex-cli',
        status: 'ok',
        session: { usedPercent: 26, windowMinutes: 300, resetsAt: null },
        weekly: { usedPercent: 12, windowMinutes: 10080, resetsAt: null },
        updatedAt: 1_700_000_000_000,
        error: null,
        metadata: { source: 'app-server', planType: 'plus' },
        ...overrides,
    } as any;
}

beforeEach(() => {
    home = join(tmpdir(), `adhdev-quota-cache-${randomUUID().slice(0, 8)}`);
    mkdirSync(home, { recursive: true });
    env = { ADHDEV_HOME: home } as NodeJS.ProcessEnv;
    clearQuotaCache();
    __resetQuotaHydrationForTests();
});

afterEach(() => {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* noop */ }
    clearQuotaCache();
});

describe('quota cache storage', () => {
    // ── Contract 1: round trip ──────────────────────────────────────────────
    it('restores the same snapshots after the in-memory cache is emptied', () => {
        const providers = { 'codex-cli': makeQuota(), kimi: makeQuota({ provider: 'kimi' }) };
        expect(saveQuotaCache(providers, env)).toBe(true);

        const restored = loadQuotaCache(env);
        expect(restored).toEqual(providers);
    });

    it('hydrates the live Map from disk', () => {
        saveQuotaCache({ 'codex-cli': makeQuota() }, env);
        expect(readQuotaCache()).toBeUndefined(); // nothing measured in-process

        expect(hydrateQuotaCacheFromDisk(env)).toBe(1);
        expect(readQuotaCache()?.['codex-cli']).toMatchObject({ provider: 'codex-cli', status: 'ok' });
    });

    it('honours ADHDEV_HOME for the cache location', () => {
        expect(quotaCachePath(env)).toBe(join(home, 'quota', 'cache.json'));
        saveQuotaCache({ 'codex-cli': makeQuota() }, env);
        expect(existsSync(join(home, 'quota', 'cache.json'))).toBe(true);
    });

    it('writes the file 0600 (a snapshot may carry an account email)', () => {
        saveQuotaCache({ 'codex-cli': makeQuota() }, env);
        const mode = statSync(quotaCachePath(env)).mode & 0o777;
        expect(mode).toBe(0o600);
    });

    it('writes a versioned envelope', () => {
        saveQuotaCache({ 'codex-cli': makeQuota() }, env);
        const parsed = JSON.parse(readFileSync(quotaCachePath(env), 'utf-8'));
        expect(parsed.version).toBe(QUOTA_CACHE_VERSION);
        expect(typeof parsed.updatedAt).toBe('number');
        expect(parsed.providers['codex-cli'].status).toBe('ok');
    });

    // ── Contract 5: the three states survive the round trip ─────────────────
    it('preserves unavailable/error and failureKind across a round trip', () => {
        // "looked and could not read" must stay distinguishable from "never
        // reported" (= absent) after a restart, or the UI's three-state
        // rendering collapses.
        const providers = {
            'codex-cli': makeQuota({
                status: 'unavailable', session: null, weekly: null,
                error: 'Not signed in to Codex', metadata: { source: 'app-server', failureKind: 'missing-credentials' },
            }),
            kimi: makeQuota({
                provider: 'kimi', status: 'error', session: null, weekly: null,
                error: 'request failed', metadata: { source: 'oauth', failureKind: 'expired-token' },
            }),
        };
        saveQuotaCache(providers, env);
        const restored = loadQuotaCache(env)!;

        expect(restored['codex-cli'].status).toBe('unavailable');
        expect(restored['codex-cli'].metadata?.failureKind).toBe('missing-credentials');
        expect(restored['codex-cli'].error).toBe('Not signed in to Codex');
        expect(restored.kimi.status).toBe('error');
        expect(restored.kimi.metadata?.failureKind).toBe('expired-token');
        // A provider that never reported is simply absent — not a third entry.
        expect(restored['claude-cli']).toBeUndefined();
    });

    // ── Contract 2: fail-soft on every file problem ─────────────────────────
    it('returns no cache when the file is absent', () => {
        expect(loadQuotaCache(env)).toBeUndefined();
        expect(() => hydrateQuotaCacheFromDisk(env)).not.toThrow();
        expect(readQuotaCache()).toBeUndefined();
    });

    it('returns no cache when the file is corrupt', () => {
        mkdirSync(join(home, 'quota'), { recursive: true });
        writeFileSync(quotaCachePath(env), '{ not json', 'utf-8');
        expect(loadQuotaCache(env)).toBeUndefined();
        expect(() => hydrateQuotaCacheFromDisk(env)).not.toThrow();
        expect(readQuotaCache()).toBeUndefined();
    });

    it('ignores a file written by a different version', () => {
        mkdirSync(join(home, 'quota'), { recursive: true });
        writeFileSync(quotaCachePath(env), JSON.stringify({
            version: QUOTA_CACHE_VERSION + 99,
            updatedAt: Date.now(),
            providers: { 'codex-cli': makeQuota() },
        }), 'utf-8');
        expect(loadQuotaCache(env)).toBeUndefined();
    });

    it('does not throw when the file cannot be written', () => {
        // Unwritable location: the refresh that produced the numbers must not
        // fail just because the cache could not be saved.
        const blocked = { ADHDEV_HOME: join(home, 'nope', '\0invalid') } as NodeJS.ProcessEnv;
        expect(() => saveQuotaCache({ 'codex-cli': makeQuota() }, blocked)).not.toThrow();
        expect(saveQuotaCache({ 'codex-cli': makeQuota() }, blocked)).toBe(false);
    });

    it('drops a corrupt entry but keeps the providers that round-tripped', () => {
        mkdirSync(join(home, 'quota'), { recursive: true });
        writeFileSync(quotaCachePath(env), JSON.stringify({
            version: QUOTA_CACHE_VERSION,
            updatedAt: Date.now(),
            providers: { 'codex-cli': makeQuota(), kimi: 'not-an-object', 'claude-cli': { noStatus: true } },
        }), 'utf-8');
        const restored = loadQuotaCache(env)!;
        expect(Object.keys(restored)).toEqual(['codex-cli']);
    });

    // ── Contract 3/4: the read path and startup are untouched ───────────────
    it('readQuotaCache performs NO file I/O', () => {
        // The guarantee that keeps quota off the request path: mesh_status calls
        // git_status per node, and each of those reads this cache.
        saveQuotaCache({ 'codex-cli': makeQuota() }, env);
        const fsSpy = vi.spyOn(require('node:fs'), 'readFileSync');
        readQuotaCache();
        expect(fsSpy).not.toHaveBeenCalled();
        fsSpy.mockRestore();
    });

    it('hydration is one-shot and never overwrites a live measurement', async () => {
        saveQuotaCache({ 'codex-cli': makeQuota({ metadata: { source: 'from-disk' } }) }, env);

        // A real fetch lands first…
        await refreshQuotaCacheOnce([
            { provider: 'codex-cli' as const, fetch: async () => makeQuota({ metadata: { source: 'live' } }) },
        ]);
        // …so hydration must not clobber it.
        expect(hydrateQuotaCacheFromDisk(env)).toBe(0);
        expect(readQuotaCache()?.['codex-cli'].metadata?.source).toBe('live');

        // And a second hydration call is a no-op.
        __resetQuotaHydrationForTests();
        expect(hydrateQuotaCacheFromDisk(env)).toBe(0);
    });

    it('a refresh WRITES the cache file, including per-provider failures', async () => {
        // The wiring test: without it, deleting the save call from
        // refreshQuotaCacheOnce would leave every other case here green.
        // ADHDEV_HOME is pointed at the temp home for the duration so the real
        // save path (process.env) lands where this test can read it.
        const previous = process.env.ADHDEV_HOME;
        process.env.ADHDEV_HOME = home;
        try {
            await refreshQuotaCacheOnce([
                { provider: 'codex-cli' as const, fetch: async () => makeQuota() },
                { provider: 'kimi' as const, fetch: async () => { throw new Error('boom'); } },
            ]);

            expect(existsSync(quotaCachePath(env))).toBe(true);
            const persisted = loadQuotaCache(env)!;
            expect(persisted['codex-cli'].status).toBe('ok');
            // A failure is recorded, not dropped — it must survive a restart too.
            expect(persisted.kimi.status).toBe('error');
            expect(persisted.kimi.metadata?.failureKind).toBe('unknown');
        } finally {
            if (previous === undefined) delete process.env.ADHDEV_HOME;
            else process.env.ADHDEV_HOME = previous;
        }
    });
});
