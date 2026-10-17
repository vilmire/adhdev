import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountLineageFromCliJwt, sameQuotaAccount, UNKNOWN_ACCOUNT_LINEAGE, settleCredentialQuota } from '../../src/quota/account-lineage.js';
import { carryForwardLastGoodWindows, clearQuotaCache, hydrateQuotaCacheFromDisk, readQuotaCache, refreshQuotaCacheOnce } from '../../src/quota/refresh.js';
import { loadQuotaCache, mergeLastGoodForPersist, saveQuotaCache } from '../../src/quota/persist.js';
import type { ProviderQuota } from '../../src/quota/types.js';

const jwt = (sub: string, extra = {}) => ['e30', Buffer.from(JSON.stringify({ iss: 'https://issuer.test', sub, ...extra })).toString('base64url'), 'signature'].join('.');
const lineage = (sub: string) => accountLineageFromCliJwt('antigravity-cli', jwt(sub), 'https://quota.test');
const A = lineage('fixture-account-a');
const B = lineage('fixture-account-b');
const reading = (account = A, extra: Partial<ProviderQuota> = {}): ProviderQuota => ({
    provider: 'antigravity-cli', status: 'ok', session: null,
    weekly: { usedPercent: 24, windowMinutes: 10080, resetsAt: 1_900_000_000_000 },
    buckets: [{ name: 'Gemini Models · Weekly', usedPercent: 24, windowMinutes: 10080, resetsAt: 1_900_000_000_000 }],
    updatedAt: 1_800_000_000_000, error: null,
    metadata: { source: 'oauth', accountLineage: account }, ...extra,
});
const failed = (account = A, kind = 'network'): ProviderQuota => ({
    ...reading(account), session: null, weekly: null, buckets: [], status: 'error', updatedAt: 1_800_000_060_000,
    error: 'fixture failure', metadata: { accountLineage: account, source: 'keychain', failureKind: kind as never },
});
const homes: string[] = [];
afterEach(() => { clearQuotaCache(); vi.useRealTimers(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const env = () => { const home = mkdtempSync(join(tmpdir(), 'quota-lineage-')); homes.push(home); return { ADHDEV_CONFIG_DIR: home }; };

describe('stable owning-CLI lineage', () => {
    it('uses only issuer/subject/provider/quota authority, never rotating tokens or metadata', () => {
        const before = accountLineageFromCliJwt('grok-cli', jwt('fixture', { exp: 100, jti: 'old' }), 'https://billing.test');
        const after = accountLineageFromCliJwt('grok-cli', jwt('fixture', { exp: 200, jti: 'new' }), 'https://billing.test');
        expect(sameQuotaAccount(before, after)).toBe(true);
        expect(sameQuotaAccount(before, accountLineageFromCliJwt('grok-cli', jwt('other'), 'https://billing.test'))).toBe(false);
        expect(sameQuotaAccount(before, accountLineageFromCliJwt('grok-cli', jwt('fixture'), 'https://other.test'))).toBe(false);
        expect(JSON.stringify(before)).not.toMatch(/fixture|issuer|billing|old|new|@/);
    });
    it('never equates unknown, legacy, opaque tokens, emails, or malformed digests', () => {
        for (const value of [undefined, UNKNOWN_ACCOUNT_LINEAGE, { kind: 'account', key: 'not-a-digest', version: 1 }]) expect(sameQuotaAccount(value, value)).toBe(false);
        expect(accountLineageFromCliJwt('grok-cli', 'opaque-token', 'https://quota.test')).toEqual(UNKNOWN_ACCOUNT_LINEAGE);
        expect(accountLineageFromCliJwt('grok-cli', jwt('', { email: 'synthetic@example.invalid' }), 'https://quota.test')).toEqual(UNKNOWN_ACCOUNT_LINEAGE);
    });
});

describe('memory and disk transfer boundary', () => {
    it.each(['network', 'expired-token', 'unauthorized', 'server', 'rate-limited'])('isolates a different account on %s while preserving a confirmed same-account reading', (kind) => {
        const old = reading();
        const fresh = failed(B, kind);
        expect(carryForwardLastGoodWindows(old, fresh)).toBe(fresh);
        expect(mergeLastGoodForPersist({ 'antigravity-cli': fresh }, { 'antigravity-cli': old })['antigravity-cli']).toBe(fresh);
        const retained = carryForwardLastGoodWindows(old, failed(A, kind));
        expect(retained.weekly?.usedPercent).toBe(24);
        expect(retained.buckets).toEqual(old.buckets);
        expect(retained.updatedAt).toBe(old.updatedAt);
        expect(retained.metadata?.source).toBe('keychain');
        expect(retained.metadata?.lastGood?.source).toBe('oauth');
    });
    it('does not transfer legacy or unknown lineage, even when account labels/source match', () => {
        for (const old of [reading(UNKNOWN_ACCOUNT_LINEAGE), { ...reading(), metadata: { source: 'oauth' } }]) {
            const fresh = failed(UNKNOWN_ACCOUNT_LINEAGE);
            expect(carryForwardLastGoodWindows(old, fresh)).toBe(fresh);
            expect(mergeLastGoodForPersist({ p: fresh }, { p: old }).p).toBe(fresh);
        }
        expect(carryForwardLastGoodWindows(reading(), failed(UNKNOWN_ACCOUNT_LINEAGE)).weekly).toBeNull();
    });
    it('provider equality is also required; a matching digest alone cannot transfer windows from a different provider', () => {
        const fresh = { ...failed(), provider: 'grok-cli' as const };
        expect(carryForwardLastGoodWindows(reading(), fresh)).toBe(fresh);
    });
    it('a new success replaces the entire previous pool reading, without carrying old groups', () => {
        const fresh = reading(B, { weekly: { usedPercent: 97, windowMinutes: 10080, resetsAt: null }, buckets: [] });
        expect(carryForwardLastGoodWindows(reading(), fresh)).toBe(fresh);
        expect(mergeLastGoodForPersist({ p: fresh }, { p: reading() }).p).toBe(fresh);
    });
    it('persists the new numberless account state rather than resurrecting the old one after restart', () => {
        const config = env();
        saveQuotaCache({ 'antigravity-cli': reading() }, config);
        saveQuotaCache(mergeLastGoodForPersist({ 'antigravity-cli': failed(B) }, loadQuotaCache(config)), config);
        hydrateQuotaCacheFromDisk(config, undefined, () => B);
        expect(readQuotaCache()?.['antigravity-cli'].weekly).toBeNull();
        expect(readQuotaCache()?.['antigravity-cli'].buckets ?? []).toEqual([]);
    });
    it.each(['known different', 'unknown current', 'legacy stored', 'unknown stored'])('does not hydrate account-scoped reading when %s', (scenario) => {
        const config = env();
        const stored = scenario === 'legacy stored' ? { ...reading(), metadata: { source: 'oauth', usage: { days: 1, totalTokens: 8 } } }
            : reading(scenario === 'unknown stored' ? UNKNOWN_ACCOUNT_LINEAGE : A);
        saveQuotaCache({ 'antigravity-cli': stored }, config);
        hydrateQuotaCacheFromDisk(config, undefined, () => scenario === 'unknown current' ? UNKNOWN_ACCOUNT_LINEAGE : B);
        const restored = readQuotaCache()?.['antigravity-cli'];
        expect(restored?.weekly).toBeNull();
        expect(restored?.buckets).toEqual([]);
        expect(restored?.metadata?.usage).toBeUndefined();
        expect(restored?.metadata?.lineageUncertain).toBe(true);
        expect(restored?.error).not.toMatch(/signed.out|log.in|account switch/i);
    });
    it('keeps a provider-method 429 cooldown while refusing unknown account numbers at hydration', () => {
        const config = env();
        const old = reading(UNKNOWN_ACCOUNT_LINEAGE, { status: 'error', metadata: {
            source: 'oauth', failureKind: 'rate-limited', retryAtMs: 1_900_000_000_000,
            accountLineage: UNKNOWN_ACCOUNT_LINEAGE,
        } });
        saveQuotaCache({ 'antigravity-cli': old }, config);
        hydrateQuotaCacheFromDisk(config);
        const restored = readQuotaCache()?.['antigravity-cli'];
        expect(restored?.weekly).toBeNull();
        expect(restored?.metadata?.failureKind).toBe('rate-limited');
        expect(restored?.metadata?.retryAtMs).toBe(1_900_000_000_000);
    });
    it('hydrates a confirmed stable account across token rotation with its original measurement/attempt clocks', () => {
        const config = env();
        const old = reading(A, { metadata: { source: 'oauth', accountLineage: A, fetchedAt: 1_800_000_100_000 } });
        saveQuotaCache({ 'antigravity-cli': old }, config);
        hydrateQuotaCacheFromDisk(config, undefined, () => A);
        expect(readQuotaCache()?.['antigravity-cli']).toEqual(old);
    });
});

describe('collection/publication races', () => {
    it('same-account rotation is continuous; unknown rotation is uncertainty rather than a false account switch', () => {
        const before = { token: 'old', lineage: A, authority: 'https://quota.test' };
        expect(settleCredentialQuota(reading(), before, { ...before, token: 'new' }).status).toBe('ok');
        const changed = settleCredentialQuota(reading(), before, { ...before, token: 'other', lineage: B });
        expect(changed.weekly).toBeNull();
        expect(changed.metadata?.accountLineage).toEqual(B);
        expect(changed.metadata?.lineageUncertain).toBe(true);
        const unknown = { ...before, lineage: UNKNOWN_ACCOUNT_LINEAGE };
        const result = settleCredentialQuota(reading(UNKNOWN_ACCOUNT_LINEAGE), unknown, { ...unknown, token: 'new' });
        expect(result.weekly).toBeNull();
        expect(result.metadata?.lineageUncertain).toBe(true);
        expect(result.error).not.toMatch(/signed.out|log.in|account switch/i);
    });
    it.each(['ok', 'network', 'expired-token'])('a stale %s result cannot overwrite a newer account measurement', async (kind) => {
        let release!: (q: ProviderQuota) => void;
        const pending = new Promise<ProviderQuota>(resolve => { release = resolve; });
        const old = refreshQuotaCacheOnce([{ provider: 'antigravity-cli', fetch: () => pending }]);
        const fresh = reading(B);
        await refreshQuotaCacheOnce([{ provider: 'antigravity-cli', fetch: async () => fresh }]);
        release(kind === 'ok' ? reading() : failed(A, kind));
        await old;
        expect(readQuotaCache()?.['antigravity-cli'].metadata?.accountLineage).toEqual(B);
        expect(readQuotaCache()?.['antigravity-cli'].status).toBe('ok');
    });
    it('validates current identity at publication even when no new fetch was started', async () => {
        await refreshQuotaCacheOnce([{ provider: 'antigravity-cli', fetch: async () => reading() }], undefined, { readAccountLineage: () => B });
        const current = readQuotaCache()?.['antigravity-cli'];
        expect(current?.weekly).toBeNull();
        expect(current?.metadata?.lineageUncertain).toBe(true);
        expect(current?.metadata?.accountLineage).toEqual(B);
    });
    it('an older multi-provider batch cannot replace the newer account retry callback after waiting for another provider', async () => {
        vi.useFakeTimers();
        let release!: (q: ProviderQuota) => void;
        const slow = new Promise<ProviderQuota>(resolve => { release = resolve; });
        const oldFetch = vi.fn(async () => reading());
        const oldBatch = refreshQuotaCacheOnce([
            { provider: 'antigravity-cli', fetch: oldFetch },
            { provider: 'opencode', fetch: () => slow },
        ]);
        await Promise.resolve(); // the old account published; its batch still waits
        const network = failed(B);
        network.metadata!.retryAtMs = Date.now() + 120_000;
        const currentFetch = vi.fn().mockResolvedValueOnce(network).mockResolvedValue(reading(B));
        await refreshQuotaCacheOnce([{ provider: 'antigravity-cli', fetch: currentFetch }]);
        release({ ...reading(), provider: 'opencode' });
        await oldBatch;
        await vi.advanceTimersByTimeAsync(120_001);
        expect(oldFetch).toHaveBeenCalledTimes(1);
        expect(currentFetch).toHaveBeenCalledTimes(2);
        expect(readQuotaCache()?.['antigravity-cli'].metadata?.accountLineage).toEqual(B);
    });
    it('clearing the cache fences an in-flight result instead of resurrecting it', async () => {
        let release!: (q: ProviderQuota) => void;
        const pending = new Promise<ProviderQuota>(resolve => { release = resolve; });
        const old = refreshQuotaCacheOnce([{ provider: 'antigravity-cli', fetch: () => pending }]);
        clearQuotaCache(); release(reading()); await old;
        expect(readQuotaCache()).toBeUndefined();
    });
});
