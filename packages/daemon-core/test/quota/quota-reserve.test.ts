import { describe, expect, it } from 'vitest';
import {
    DEFAULT_QUOTA_RESERVE,
    applyQuotaReserveSet,
    coerceQuotaReserve,
    mergeConservativeDefaults,
    quotaReserveForFacts,
    resolveQuotaReserve,
    resolveQuotaReserveDetailed,
} from '../../src/quota/quota-reserve.js';
import { evaluateProviderQuotaGate, PROVIDER_QUOTA_SESSION_LOW_SKIP_REASON, PROVIDER_QUOTA_WEEKLY_LOW_SKIP_REASON, PROVIDER_QUOTA_GROUP_EXHAUSTED_SKIP_REASON } from '../../src/mesh/mesh-quota-routing.js';
import { buildQuotaReserveView } from '../../src/quota/quota-reserve-view.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const ACCOUNT_A = 'a'.repeat(64);
const ACCOUNT_B = 'b'.repeat(64);

function node(quota: Record<string, any>, reserve?: unknown) {
    return {
        id: 'n1',
        nodeFacts: { schemaVersion: 1, reportedAt: NOW, quota, ...(reserve ? { quotaReserve: reserve } : {}) },
    };
}
function claude(sessionLeft: number, weeklyLeft = 90, lineageKey?: string) {
    return {
        provider: 'claude-cli', status: 'ok',
        session: { usedPercent: 100 - sessionLeft, windowMinutes: 300, resetsAt: null },
        weekly: { usedPercent: 100 - weeklyLeft, windowMinutes: 10080, resetsAt: null },
        updatedAt: NOW - MIN, error: null,
        ...(lineageKey ? { metadata: { accountLineage: { version: 1, kind: 'account', key: lineageKey } } } : {}),
    };
}
const bucket = (group: string, usedPercent: number, windowMinutes: number) => ({
    name: `${group} ${windowMinutes}`, group, usedPercent, windowMinutes, resetsAt: NOW + (windowMinutes === 10080 ? 2000 : 60) * MIN,
});
function agy(geminiLeft: number, claudeGptLeft: number) {
    return {
        provider: 'antigravity-cli', status: 'ok',
        session: { usedPercent: 0, windowMinutes: 300, resetsAt: NOW + 60 * MIN },
        weekly: { usedPercent: 100 - Math.min(geminiLeft, claudeGptLeft), windowMinutes: 10080, resetsAt: NOW + 2000 * MIN },
        buckets: [bucket('gemini', 100 - geminiLeft, 10080), bucket('claude-gpt', 100 - claudeGptLeft, 10080)],
        updatedAt: NOW - MIN, error: null,
    };
}

describe('resolveQuotaReserve — order, sparse storage, validation', () => {
    it('falls back to the code defaults 10 / 15 / 5 min / 20 (owner Q6)', () => {
        expect(resolveQuotaReserve(undefined, { provider: 'claude-cli' })).toEqual({
            routingSessionMinPercent: 10, routingLongMinPercent: 15, routingSessionResetImminentMs: 5 * MIN, assistantReviewMinPercent: 20,
        });
    });

    it('resolves account-pool → account-provider → pool → provider → defaults, field by field', () => {
        const raw = {
            version: 1,
            defaults: { routingSessionMinPercent: 11, routingLongMinPercent: 22, assistantReviewMinPercent: 33 },
            pools: {
                'antigravity-cli': { routingSessionMinPercent: 12 },
                'antigravity-cli:gemini': { routingSessionMinPercent: 13 },
            },
            accounts: { [ACCOUNT_A]: { 'antigravity-cli': { routingSessionMinPercent: 14 }, 'antigravity-cli:gemini': { routingSessionMinPercent: 15 } } },
        };
        const at = (input: any) => resolveQuotaReserveDetailed(raw, { provider: 'antigravity-cli', ...input });
        expect(at({ pool: 'gemini', accountKey: ACCOUNT_A }).policy.routingSessionMinPercent).toBe(15);
        expect(at({ pool: 'claude-gpt', accountKey: ACCOUNT_A }).policy.routingSessionMinPercent).toBe(14);
        expect(at({ pool: 'gemini', accountKey: ACCOUNT_B }).policy.routingSessionMinPercent).toBe(13);
        expect(at({ pool: 'claude-gpt' }).policy.routingSessionMinPercent).toBe(12);
        expect(resolveQuotaReserve(raw, { provider: 'codex-cli' }).routingSessionMinPercent).toBe(11);
        // Fields fill independently: the pool layer sets only the session floor.
        const gem = at({ pool: 'gemini' });
        expect(gem.policy.routingLongMinPercent).toBe(22);
        expect(gem.source.routingSessionMinPercent).toBe('pool');
        expect(gem.source.routingLongMinPercent).toBe('defaults');
        expect(gem.source.routingSessionResetImminentMs).toBe('code-default');
    });

    it('stores sparsely: a value equal to what it would inherit is never written', () => {
        expect(applyQuotaReserveSet(undefined, { scope: 'defaults', policy: { routingSessionMinPercent: 10 } })).toBeUndefined();
        const withDefaults = applyQuotaReserveSet(undefined, { scope: 'defaults', policy: { routingSessionMinPercent: 30 } })!;
        expect(withDefaults.defaults).toEqual({ routingSessionMinPercent: 30 });
        // a pool value equal to the defaults layer is dropped; a different one is kept
        const same = applyQuotaReserveSet(withDefaults, { scope: 'pool', key: 'claude-cli', policy: { routingSessionMinPercent: 30 } })!;
        expect(same.pools).toBeUndefined();
        const diff = applyQuotaReserveSet(withDefaults, { scope: 'pool', key: 'claude-cli', policy: { routingSessionMinPercent: 10 } })!;
        expect(diff.pools).toEqual({ 'claude-cli': { routingSessionMinPercent: 10 } }); // overrides defaults back down
        // null clears the scope
        const cleared = applyQuotaReserveSet(diff, { scope: 'pool', key: 'claude-cli', policy: null })!;
        expect(cleared.pools).toBeUndefined();
        expect(applyQuotaReserveSet(cleared, { scope: 'defaults', policy: null })).toBeUndefined();
    });

    it('validates strictly: unknown fields, out-of-range percents, negative durations, bad keys → invalid_quota_reserve', () => {
        const set = (input: any) => () => applyQuotaReserveSet(undefined, input);
        expect(set({ scope: 'defaults', policy: { nope: 1 } })).toThrow(/invalid_quota_reserve: unknown field/);
        expect(set({ scope: 'defaults', policy: { routingSessionMinPercent: 101 } })).toThrow(/between 0 and 100/);
        expect(set({ scope: 'defaults', policy: { routingLongMinPercent: -1 } })).toThrow(/between 0 and 100/);
        expect(set({ scope: 'defaults', policy: { routingSessionResetImminentMs: -5 } })).toThrow(/>= 0/);
        expect(set({ scope: 'defaults', policy: { routingSessionMinPercent: '5' } })).toThrow(/finite number/);
        expect(set({ scope: 'pool', key: 'bad key!', policy: {} })).toThrow(/invalid_quota_reserve/);
        expect(set({ scope: 'account', key: 'claude-cli', policy: {} })).toThrow(/accountKey/);
        expect(set({ scope: 'account', accountKey: 'not-hex', key: 'claude-cli', policy: {} })).toThrow(/accountKey/);
        expect(set({ scope: 'galaxy', policy: {} })).toThrow(/unknown scope/);
    });

    it('lenient coercion of untrusted stored/wire values drops bad pieces without throwing', () => {
        const out = coerceQuotaReserve({ version: 1, defaults: { routingSessionMinPercent: 999, routingLongMinPercent: 40 }, pools: { 'bad key': { routingLongMinPercent: 5 } }, junk: 1 });
        expect(out?.defaults).toEqual({ routingLongMinPercent: 40 });
        expect(out?.pools).toBeUndefined();
        expect(coerceQuotaReserve('junk')).toBeUndefined();
    });

    it('merges migration values conservatively: percents max, reset-imminent min', () => {
        const merged = mergeConservativeDefaults({ routingSessionMinPercent: 30, routingSessionResetImminentMs: 10 * MIN }, {
            routingSessionMinPercent: 20, routingLongMinPercent: 25, routingSessionResetImminentMs: 2 * MIN,
        });
        expect(merged).toEqual({ routingSessionMinPercent: 30, routingLongMinPercent: 25, routingSessionResetImminentMs: 2 * MIN });
    });

    it('ships a facts copy without the migration trail, shedding accounts then pools when oversize', () => {
        const big: any = { version: 1, defaults: { routingLongMinPercent: 40 }, migration: { at: 'x', fromMeshes: [], resolution: 'max' }, accounts: {}, pools: {} };
        for (let i = 0; i < 60; i++) big.accounts[i.toString(16).padStart(64, '0')] = { 'claude-cli': { routingLongMinPercent: 50 } };
        const facts = quotaReserveForFacts(big)!;
        expect(facts.migration).toBeUndefined();
        expect(facts.accounts).toBeUndefined();
        expect(facts.defaults).toEqual({ routingLongMinPercent: 40 });
        expect(quotaReserveForFacts({ version: 1 })).toBeUndefined();
    });
});

describe('the launch gate judges a snapshot by the reserve of the machine that reported it', () => {
    it('same node + same reading → same verdict whatever the mesh policy says (reserve is not mesh policy)', () => {
        const reporting = node({ 'claude-cli': claude(8) }, { version: 1, defaults: { routingSessionMinPercent: 10 } });
        const meshA = { staleAfterMs: 10 * MIN };
        const meshB = { spreadBonusMax: 99, quotaBusyFallback: false };
        const a = evaluateProviderQuotaGate(reporting, 'claude-cli', meshA, NOW);
        const b = evaluateProviderQuotaGate(reporting, 'claude-cli', meshB, NOW);
        expect(a?.reason).toBe(PROVIDER_QUOTA_SESSION_LOW_SKIP_REASON);
        expect(b).toEqual(a);
        expect(a?.thresholdPercent).toBe(10);
    });

    it('antigravity: pool reserves apply independently (gemini 20 blocks 8% gemini, claude-gpt 60% passes)', () => {
        const reporting = node({ 'antigravity-cli': agy(8, 60) }, { version: 1, pools: { 'antigravity-cli:gemini': { routingLongMinPercent: 20 } } });
        const gemini = evaluateProviderQuotaGate(reporting, 'antigravity-cli', null, NOW, undefined, { model: 'Gemini 3 Pro' });
        const claudeSlot = evaluateProviderQuotaGate(reporting, 'antigravity-cli', null, NOW, undefined, { model: 'Claude Sonnet' });
        expect(gemini?.reason).toBeOneOf([PROVIDER_QUOTA_WEEKLY_LOW_SKIP_REASON, PROVIDER_QUOTA_GROUP_EXHAUSTED_SKIP_REASON]);
        expect(claudeSlot).toBeNull();
        // 15% gemini: below the gemini pool's 20 floor but above the code default 15 → only the pool reserve blocks it
        const mid = node({ 'antigravity-cli': agy(18, 60) }, { version: 1, pools: { 'antigravity-cli:gemini': { routingLongMinPercent: 20 } } });
        expect(evaluateProviderQuotaGate(mid, 'antigravity-cli', null, NOW, undefined, { model: 'Gemini 3 Pro' })).toMatchObject({ reason: PROVIDER_QUOTA_WEEKLY_LOW_SKIP_REASON, thresholdPercent: 20 });
        expect(evaluateProviderQuotaGate(node({ 'antigravity-cli': agy(18, 60) }), 'antigravity-cli', null, NOW, undefined, { model: 'Gemini 3 Pro' })).toBeNull();
    });

    it('account override: account A (reserve 30) blocks at 25%, account B passes; unknown lineage cannot be overridden', () => {
        const reserve = { version: 1, defaults: { routingSessionMinPercent: 12 }, accounts: { [ACCOUNT_A]: { 'claude-cli': { routingSessionMinPercent: 30 } } } };
        expect(evaluateProviderQuotaGate(node({ 'claude-cli': claude(25, 90, ACCOUNT_A) }, reserve), 'claude-cli', null, NOW))
            .toMatchObject({ reason: PROVIDER_QUOTA_SESSION_LOW_SKIP_REASON, thresholdPercent: 30 });
        expect(evaluateProviderQuotaGate(node({ 'claude-cli': claude(25, 90, ACCOUNT_B) }, reserve), 'claude-cli', null, NOW)).toBeNull();
        expect(evaluateProviderQuotaGate(node({ 'claude-cli': claude(25, 90) }, reserve), 'claude-cli', null, NOW)).toBeNull();
    });

    it('an older node that reports no reserve is judged by the code defaults (fail-open direction unchanged)', () => {
        expect(evaluateProviderQuotaGate(node({ 'claude-cli': claude(12) }), 'claude-cli', null, NOW)).toBeNull();
        expect(evaluateProviderQuotaGate(node({ 'claude-cli': claude(9) }), 'claude-cli', null, NOW))
            .toMatchObject({ reason: PROVIDER_QUOTA_SESSION_LOW_SKIP_REASON, thresholdPercent: DEFAULT_QUOTA_RESERVE.routingSessionMinPercent });
        // garbage reserve on the wire is ignored, never throws
        expect(evaluateProviderQuotaGate(node({ 'claude-cli': claude(12) }, { version: 1, defaults: { routingSessionMinPercent: 'x' } }), 'claude-cli', null, NOW)).toBeNull();
    });

    it('a live local node is judged by the live machine reserve, not its stale facts copy', () => {
        const local = node({ 'claude-cli': claude(25) }, { version: 1, defaults: { routingSessionMinPercent: 5 } });
        const context = {
            liveLocalQuota: { entries: { 'claude-cli': claude(25) as any }, isLocalNode: () => true, reserve: { version: 1, defaults: { routingSessionMinPercent: 40 } } },
        };
        expect(evaluateProviderQuotaGate(local, 'claude-cli', null, NOW, context as any)).toMatchObject({ reason: PROVIDER_QUOTA_SESSION_LOW_SKIP_REASON, thresholdPercent: 40 });
    });
});

describe('quota_reserve_get view', () => {
    it('shows interactive state without blocking: within-reserve flag per provider and pool, with the source layer', () => {
        const cache: any = { 'claude-cli': claude(8, 90, ACCOUNT_A), 'antigravity-cli': agy(8, 60) };
        const view = buildQuotaReserveView({ version: 1, defaults: { routingSessionMinPercent: 15 } }, cache);
        const row = view.rows.find(r => r.provider === 'claude-cli')!;
        expect(row).toMatchObject({ withinReserve: true, withinReserveWindow: 'session', accountKey: ACCOUNT_A });
        expect(row.source.routingSessionMinPercent).toBe('defaults');
        const gem = view.rows.find(r => r.poolKey === 'antigravity-cli:gemini')!;
        const cg = view.rows.find(r => r.poolKey === 'antigravity-cli:claude-gpt')!;
        expect(gem.withinReserve).toBe(true);
        expect(cg.withinReserve).toBe(false);
        expect(view.accounts['claude-cli']).toEqual([ACCOUNT_A]);
    });
});
