import { describe, expect, it, vi, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Isolate all mesh file I/O to a per-run temp dir (same pattern as the other mesh tests).
const testTmpDir = join(tmpdir(), `adhdev-mesh-quota-routing-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' }),
}));

import {
    evaluateProviderQuotaGate,
    isQuotaSnapshotFresh,
    quotaSnapshotAgeMs,
    quotaSpreadBonusByProvider,
    rankProvidersByQuotaGate,
    ALL_PROVIDERS_QUOTA_GATED_SKIP_REASON,
    PROVIDER_QUOTA_SESSION_LOW_SKIP_REASON,
    PROVIDER_QUOTA_WEEKLY_LOW_SKIP_REASON,
    PROVIDER_QUOTA_EXHAUSTED_SKIP_REASON,
} from '../../src/mesh/mesh-quota-routing.js';
import {
    DEFAULT_QUOTA_ROUTING_POLICY,
    mergeAndNormalizePolicy,
    normalizeQuotaRoutingPolicy,
    resolveQuotaRoutingPolicy,
} from '../../src/repo-mesh-types.js';
import { __scoreSlotForTaskForTests } from '../../src/mesh/mesh-events-coordinator.js';

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;

function nodeWithQuota(quota: Record<string, any> | undefined, reportedAt: number = NOW) {
    return {
        id: 'n1',
        nodeFacts: { schemaVersion: 1, reportedAt, ...(quota ? { quota } : {}) },
    };
}

function okQuota(over: Record<string, any> = {}) {
    return {
        provider: 'claude-cli',
        status: 'ok',
        session: { usedPercent: 50, windowMinutes: 300, resetsAt: null },
        weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: null },
        updatedAt: NOW - MIN,
        error: null,
        ...over,
    };
}

afterEach(() => {
    try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('quota routing policy — resolution & persistence economy', () => {
    it('resolves the owner-confirmed defaults when unset', () => {
        expect(resolveQuotaRoutingPolicy(undefined)).toEqual({
            staleAfterMs: 30 * MIN,
            sessionMinRemainingPercent: 10,
            sessionResetImminentMs: 5 * MIN,
            weeklyMinRemainingPercent: 15,
            spreadBonusMax: 30,
        });
        expect(resolveQuotaRoutingPolicy(null)).toEqual(DEFAULT_QUOTA_ROUTING_POLICY);
    });

    it('fills only the unset fields and clamps out-of-range values', () => {
        expect(resolveQuotaRoutingPolicy({ sessionMinRemainingPercent: 25 })).toEqual({
            ...DEFAULT_QUOTA_ROUTING_POLICY,
            sessionMinRemainingPercent: 25,
        });
        // >100% thresholds clamp to 100; a negative stale window falls back to default.
        expect(resolveQuotaRoutingPolicy({ weeklyMinRemainingPercent: 250 }).weeklyMinRemainingPercent).toBe(100);
        expect(resolveQuotaRoutingPolicy({ staleAfterMs: -5 }).staleAfterMs).toBe(DEFAULT_QUOTA_ROUTING_POLICY.staleAfterMs);
        expect(resolveQuotaRoutingPolicy({ sessionResetImminentMs: -1 }).sessionResetImminentMs).toBe(DEFAULT_QUOTA_ROUTING_POLICY.sessionResetImminentMs);
    });

    it('drops an absent or all-default quotaRouting from the persisted policy', () => {
        expect(mergeAndNormalizePolicy(undefined, undefined).quotaRouting).toBeUndefined();
        expect(mergeAndNormalizePolicy(undefined, {
            quotaRouting: { sessionMinRemainingPercent: 10, weeklyMinRemainingPercent: 15 },
        } as any).quotaRouting).toBeUndefined();
        expect(normalizeQuotaRoutingPolicy({ staleAfterMs: 30 * MIN })).toBeUndefined();
        expect(normalizeQuotaRoutingPolicy('junk')).toBeUndefined();
    });

    it('persists only explicit non-default overrides, idempotently', () => {
        const merged = mergeAndNormalizePolicy(undefined, {
            quotaRouting: { sessionMinRemainingPercent: 25, staleAfterMs: 10 * MIN },
        } as any);
        expect(merged.quotaRouting).toEqual({ sessionMinRemainingPercent: 25, staleAfterMs: 10 * MIN });
        const remerged = mergeAndNormalizePolicy(merged, undefined);
        expect(remerged.quotaRouting).toEqual(merged.quotaRouting);
    });
});

describe('quotaSnapshotAgeMs — clock-skew-safe staleness', () => {
    it('combines bundle transit age and same-clock snapshot age', () => {
        // reportedAt - updatedAt is a difference of two REPORTER-clock stamps,
        // so the reporter↔coordinator skew cancels out of that term.
        const facts = { reportedAt: NOW - 5 * MIN };
        const quota = { updatedAt: NOW - 20 * MIN };
        expect(quotaSnapshotAgeMs(facts, quota, NOW)).toBe(20 * MIN);
    });

    it('a reporter clock running AHEAD of the coordinator reads as fresh, never negative', () => {
        const facts = { reportedAt: NOW + 10 * MIN }; // reporter 10 min ahead
        const quota = { updatedAt: NOW + 9 * MIN };
        expect(quotaSnapshotAgeMs(facts, quota, NOW)).toBe(MIN);
        expect(isQuotaSnapshotFresh(facts, quota, null, NOW)).toBe(true);
    });

    it('is stale past the (configurable) threshold', () => {
        const facts = { reportedAt: NOW };
        expect(isQuotaSnapshotFresh(facts, { updatedAt: NOW - 31 * MIN }, null, NOW)).toBe(false);
        expect(isQuotaSnapshotFresh(facts, { updatedAt: NOW - 31 * MIN }, { staleAfterMs: 60 * MIN }, NOW)).toBe(true);
    });
});

describe('evaluateProviderQuotaGate — launch gate (fail-open)', () => {
    it('blocks when the session window remaining is below threshold', () => {
        const node = nodeWithQuota({ 'claude-cli': okQuota({ session: { usedPercent: 92, windowMinutes: 300, resetsAt: null } }) });
        const block = evaluateProviderQuotaGate(node, 'claude-cli', null, NOW);
        expect(block?.reason).toBe(PROVIDER_QUOTA_SESSION_LOW_SKIP_REASON);
        expect(block?.window).toBe('session');
        expect(block?.remainingPercent).toBeCloseTo(8);
        expect(block?.thresholdPercent).toBe(10);
    });

    it('blocks when the weekly window remaining is below its (more conservative) threshold', () => {
        const node = nodeWithQuota({ 'claude-cli': okQuota({ weekly: { usedPercent: 86, windowMinutes: 10080, resetsAt: null } }) });
        const block = evaluateProviderQuotaGate(node, 'claude-cli', null, NOW);
        expect(block?.reason).toBe(PROVIDER_QUOTA_WEEKLY_LOW_SKIP_REASON);
        expect(block?.remainingPercent).toBeCloseTo(14);
        expect(block?.thresholdPercent).toBe(15);
    });

    it('passes when both windows have headroom', () => {
        const node = nodeWithQuota({ 'claude-cli': okQuota() });
        expect(evaluateProviderQuotaGate(node, 'claude-cli', null, NOW)).toBeNull();
    });

    it('honours configured thresholds', () => {
        const node = nodeWithQuota({ 'claude-cli': okQuota() }); // session remaining 50
        expect(evaluateProviderQuotaGate(node, 'claude-cli', { sessionMinRemainingPercent: 60 }, NOW)?.reason)
            .toBe(PROVIDER_QUOTA_SESSION_LOW_SKIP_REASON);
        expect(evaluateProviderQuotaGate(node, 'claude-cli', { sessionMinRemainingPercent: 40 }, NOW)).toBeNull();
    });

    it('fails OPEN on a stale snapshot — old data must not exclude a node', () => {
        const exhausted = okQuota({
            session: { usedPercent: 99, windowMinutes: 300, resetsAt: null },
            weekly: { usedPercent: 99, windowMinutes: 10080, resetsAt: null },
            updatedAt: NOW - 45 * MIN, // 45 min old snapshot, fresh bundle stamp
        });
        const node = nodeWithQuota({ 'claude-cli': exhausted }, NOW);
        expect(evaluateProviderQuotaGate(node, 'claude-cli', null, NOW)).toBeNull();
    });

    it('fails OPEN when the bundle itself is old', () => {
        const exhausted = okQuota({
            session: { usedPercent: 99, windowMinutes: 300, resetsAt: null },
            weekly: { usedPercent: 99, windowMinutes: 10080, resetsAt: null },
        });
        const node = nodeWithQuota({ 'claude-cli': exhausted }, NOW - 31 * MIN);
        expect(evaluateProviderQuotaGate(node, 'claude-cli', null, NOW)).toBeNull();
    });

    it('fails OPEN on missing quota, missing facts, or a non-ok status', () => {
        expect(evaluateProviderQuotaGate(nodeWithQuota(undefined), 'claude-cli', null, NOW)).toBeNull();
        expect(evaluateProviderQuotaGate({ id: 'bare' }, 'claude-cli', null, NOW)).toBeNull();
        expect(evaluateProviderQuotaGate(nodeWithQuota({}), 'claude-cli', null, NOW)).toBeNull();
        const errored = nodeWithQuota({
            'claude-cli': okQuota({
                status: 'error',
                session: { usedPercent: 99, windowMinutes: 300, resetsAt: null },
            }),
        });
        expect(evaluateProviderQuotaGate(errored, 'claude-cli', null, NOW)).toBeNull();
        const unavailable = nodeWithQuota({
            'claude-cli': okQuota({
                status: 'unavailable',
                session: { usedPercent: 99, windowMinutes: 300, resetsAt: null },
            }),
        });
        expect(evaluateProviderQuotaGate(unavailable, 'claude-cli', null, NOW)).toBeNull();
    });

    it('still gates when the reporter clock runs ahead (skew absorbed by same-clock diff)', () => {
        const quota = okQuota({
            session: { usedPercent: 95, windowMinutes: 300, resetsAt: null },
            updatedAt: NOW + 9 * MIN,
        });
        const node = nodeWithQuota({ 'claude-cli': quota }, NOW + 10 * MIN);
        expect(evaluateProviderQuotaGate(node, 'claude-cli', null, NOW)?.reason)
            .toBe(PROVIDER_QUOTA_SESSION_LOW_SKIP_REASON);
    });

    it('does not gate a different provider than the one resolved', () => {
        const node = nodeWithQuota({
            'claude-cli': okQuota({ session: { usedPercent: 99, windowMinutes: 300, resetsAt: null } }),
        });
        expect(evaluateProviderQuotaGate(node, 'codex-cli', null, NOW)).toBeNull();
    });
});

describe('evaluateProviderQuotaGate — quota-exhausted hard block', () => {
    const exhaustedQuota = (over: Record<string, any> = {}) => okQuota({
        status: 'error',
        session: null,
        weekly: null,
        error: 'Kimi usage limit reached (HTTP 403) — quota refreshes at the next reset/billing cycle',
        metadata: { source: 'oauth', failureKind: 'quota-exhausted' },
        ...over,
    });

    // The reason this fix exists: a provider that reported its plan exhausted
    // must NOT be assigned a task.
    it('BLOCKS on a fresh error snapshot whose failureKind is quota-exhausted', () => {
        const node = nodeWithQuota({ kimi: exhaustedQuota() });
        const block = evaluateProviderQuotaGate(node, 'kimi', null, NOW);
        expect(block?.reason).toBe(PROVIDER_QUOTA_EXHAUSTED_SKIP_REASON);
        expect(block?.window).toBe('unknown');
    });

    // The maximum-risk counterpart: every other non-ok reading must still pass.
    it('fails OPEN on any other failureKind, even on a fresh error snapshot', () => {
        for (const failureKind of ['unauthorized', 'expired-token', 'rate-limited', 'network', 'server', 'parse', 'missing-credentials', 'no-data', 'unknown']) {
            const node = nodeWithQuota({ kimi: exhaustedQuota({ metadata: { failureKind } }) });
            expect(evaluateProviderQuotaGate(node, 'kimi', null, NOW), failureKind).toBeNull();
        }
    });

    it('fails OPEN on a STALE quota-exhausted snapshot — old data must not exclude a node', () => {
        const node = nodeWithQuota({ kimi: exhaustedQuota({ updatedAt: NOW - 45 * MIN }) }, NOW);
        expect(evaluateProviderQuotaGate(node, 'kimi', null, NOW)).toBeNull();
    });

    it('fails OPEN on quota-exhausted when the bundle itself is old', () => {
        const node = nodeWithQuota({ kimi: exhaustedQuota() }, NOW - 31 * MIN);
        expect(evaluateProviderQuotaGate(node, 'kimi', null, NOW)).toBeNull();
    });

    it('fails OPEN on unavailable status even with a quota-exhausted kind', () => {
        const node = nodeWithQuota({ kimi: exhaustedQuota({ status: 'unavailable' }) });
        expect(evaluateProviderQuotaGate(node, 'kimi', null, NOW)).toBeNull();
    });

    it('an ok snapshot with full headroom still passes (exhaustion kind only rides errors)', () => {
        const node = nodeWithQuota({ kimi: okQuota() });
        expect(evaluateProviderQuotaGate(node, 'kimi', null, NOW)).toBeNull();
    });
});

describe('evaluateProviderQuotaGate — session reset-imminent relaxation', () => {
    // In every case below reportedAt = NOW and updatedAt = NOW - MIN, so the
    // skew-safe reporter-now estimate is exactly NOW (age = MIN, reporterNow
    // = updatedAt + age). resetsAt values are therefore plain NOW-relative.
    const lowSession = (resetsAt: number | null) => okQuota({
        session: { usedPercent: 95, windowMinutes: 300, resetsAt },
    });

    it('WAIVES the session block when the reset is less than sessionResetImminentMs away', () => {
        const node = nodeWithQuota({ 'claude-cli': lowSession(NOW + 4 * MIN) });
        expect(evaluateProviderQuotaGate(node, 'claude-cli', null, NOW)).toBeNull();
    });

    it('keeps the block when the reset is further than sessionResetImminentMs away', () => {
        const node = nodeWithQuota({ 'claude-cli': lowSession(NOW + 30 * MIN) });
        expect(evaluateProviderQuotaGate(node, 'claude-cli', null, NOW)?.reason)
            .toBe(PROVIDER_QUOTA_SESSION_LOW_SKIP_REASON);
    });

    it('treats an already-past reset as recovered — the low reading is about to be replaced', () => {
        const node = nodeWithQuota({ 'claude-cli': lowSession(NOW - 2 * MIN) });
        expect(evaluateProviderQuotaGate(node, 'claude-cli', null, NOW)).toBeNull();
    });

    it('is conservative when the window carries NO resetsAt stamp — block kept', () => {
        const node = nodeWithQuota({ 'claude-cli': lowSession(null) });
        expect(evaluateProviderQuotaGate(node, 'claude-cli', null, NOW)?.reason)
            .toBe(PROVIDER_QUOTA_SESSION_LOW_SKIP_REASON);
    });

    it('honours a configured sessionResetImminentMs', () => {
        const node = nodeWithQuota({ 'claude-cli': lowSession(NOW + 8 * MIN) });
        expect(evaluateProviderQuotaGate(node, 'claude-cli', { sessionResetImminentMs: 10 * MIN }, NOW)).toBeNull();
        expect(evaluateProviderQuotaGate(node, 'claude-cli', { sessionResetImminentMs: 2 * MIN }, NOW)?.reason)
            .toBe(PROVIDER_QUOTA_SESSION_LOW_SKIP_REASON);
    });

    it('NEVER relaxes the weekly gate, even with an imminent weekly reset', () => {
        const node = nodeWithQuota({
            'claude-cli': okQuota({
                weekly: { usedPercent: 90, windowMinutes: 10080, resetsAt: NOW + MIN },
            }),
        });
        expect(evaluateProviderQuotaGate(node, 'claude-cli', null, NOW)?.reason)
            .toBe(PROVIDER_QUOTA_WEEKLY_LOW_SKIP_REASON);
    });

    it('compares resetsAt on the REPORTER clock — skew cancels out of the estimate', () => {
        // Reporter clock runs 10 min AHEAD of the coordinator: reportedAt =
        // NOW + 10min, updatedAt = NOW + 9min → reporter-now estimate lands on
        // the reporter's actual NOW + 10min, so a reset 3 min out on the
        // reporter clock reads as imminent.
        const quota = okQuota({
            session: { usedPercent: 95, windowMinutes: 300, resetsAt: NOW + 13 * MIN },
            updatedAt: NOW + 9 * MIN,
        });
        const node = nodeWithQuota({ 'claude-cli': quota }, NOW + 10 * MIN);
        expect(evaluateProviderQuotaGate(node, 'claude-cli', null, NOW)).toBeNull();
    });
});

describe('rankProvidersByQuotaGate — selection-loop gate + weekly-remaining priority', () => {
    const exhausted = (over: Record<string, any> = {}) => okQuota({
        status: 'error',
        session: null,
        weekly: null,
        error: 'usage limit reached (HTTP 403)',
        metadata: { source: 'oauth', failureKind: 'quota-exhausted' },
        ...over,
    });

    it('orders gate-clear candidates by WEEKLY remaining headroom, descending', () => {
        const node = nodeWithQuota({
            // kimi listed first by the caller but only 20% weekly remaining...
            kimi: okQuota({ provider: 'kimi', weekly: { usedPercent: 80, windowMinutes: 10080, resetsAt: null } }),
            // ...claude-cli has 60% weekly remaining and must win the sort.
            'claude-cli': okQuota({ weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: null } }),
        });
        const ranked = rankProvidersByQuotaGate(node, ['kimi', 'claude-cli'], null, NOW);
        expect(ranked.gated).toEqual([]);
        expect(ranked.clear).toEqual(['claude-cli', 'kimi']);
    });

    it('keeps the caller order on a weekly tie (stable sort)', () => {
        const node = nodeWithQuota({
            kimi: okQuota({ provider: 'kimi' }),          // weekly 60 remaining
            'claude-cli': okQuota(),                      // weekly 60 remaining
        });
        expect(rankProvidersByQuotaGate(node, ['kimi', 'claude-cli'], null, NOW).clear)
            .toEqual(['kimi', 'claude-cli']);
    });

    it('sorts UNKNOWN-weekly candidates below every measured one, caller order among themselves', () => {
        const node = nodeWithQuota({
            // measured: only 20% weekly remaining — still outranks the unmeasured.
            'claude-cli': okQuota({ weekly: { usedPercent: 80, windowMinutes: 10080, resetsAt: null } }),
            // kimi: no quota entry at all; codex-cli: fresh but no weekly window.
            codex: okQuota({ provider: 'codex', weekly: null }),
        });
        const ranked = rankProvidersByQuotaGate(node, ['kimi', 'codex', 'claude-cli'], null, NOW);
        expect(ranked.clear).toEqual(['claude-cli', 'kimi', 'codex']);
    });

    it('excludes gated providers from clear and reports their blocks in caller order', () => {
        const node = nodeWithQuota({
            kimi: exhausted(),
            'claude-cli': okQuota({ weekly: { usedPercent: 88, windowMinutes: 10080, resetsAt: null } }), // 12% < 15% → weekly-low
            codex: okQuota({ provider: 'codex' }),
        });
        const ranked = rankProvidersByQuotaGate(node, ['kimi', 'claude-cli', 'codex'], null, NOW);
        expect(ranked.clear).toEqual(['codex']);
        expect(ranked.gated.map(g => g.providerType)).toEqual(['kimi', 'claude-cli']);
        expect(ranked.gated[0].block.reason).toBe(PROVIDER_QUOTA_EXHAUSTED_SKIP_REASON);
        expect(ranked.gated[1].block.reason).toBe(PROVIDER_QUOTA_WEEKLY_LOW_SKIP_REASON);
    });

    it('returns an empty clear list when EVERY candidate is quota-gated', () => {
        const node = nodeWithQuota({
            kimi: exhausted(),
            'claude-cli': exhausted(),
        });
        const ranked = rankProvidersByQuotaGate(node, ['kimi', 'claude-cli'], null, NOW);
        expect(ranked.clear).toEqual([]);
        expect(ranked.gated).toHaveLength(2);
    });

    it('FAIL-OPEN regression guard: expired-token / stale / missing readings are never blocked', () => {
        const node = nodeWithQuota({
            kimi: exhausted({ metadata: { source: 'oauth', failureKind: 'expired-token' } }),
            'claude-cli': exhausted({ updatedAt: NOW - 45 * MIN }), // stale exhaustion fails open
            // codex: no entry at all
        });
        const ranked = rankProvidersByQuotaGate(node, ['kimi', 'claude-cli', 'codex'], null, NOW);
        expect(ranked.gated).toEqual([]);
        expect(ranked.clear).toEqual(['kimi', 'claude-cli', 'codex']); // all unknown-weekly, caller order
    });

    it('exposes the dedicated all-gated skip reason constant (non-actionable WAIT)', () => {
        expect(ALL_PROVIDERS_QUOTA_GATED_SKIP_REASON).toBe('all_providers_quota_gated');
    });
});

describe('quotaSpreadBonusByProvider — bounded headroom preference', () => {
    it('scores full headroom at the cap and half headroom at half the cap', () => {
        const full = nodeWithQuota({
            'claude-cli': okQuota({
                session: { usedPercent: 0, windowMinutes: 300, resetsAt: null },
                weekly: { usedPercent: 0, windowMinutes: 10080, resetsAt: null },
            }),
        });
        expect(quotaSpreadBonusByProvider(full, null, NOW)['claude-cli']).toBe(30);
        const half = nodeWithQuota({ 'claude-cli': okQuota() }); // 50 / 60 remaining
        expect(quotaSpreadBonusByProvider(half, null, NOW)['claude-cli']).toBe(15);
    });

    it('is governed by the TIGHTEST window (the one that would gate first)', () => {
        const node = nodeWithQuota({
            'claude-cli': okQuota({
                session: { usedPercent: 80, windowMinutes: 300, resetsAt: null }, // 20 remaining
                weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: null }, // 90 remaining
            }),
        });
        expect(quotaSpreadBonusByProvider(node, null, NOW)['claude-cli']).toBe(6); // 30 * 0.2
    });

    it('honours a configured cap', () => {
        const full = nodeWithQuota({
            'claude-cli': okQuota({
                session: { usedPercent: 0, windowMinutes: 300, resetsAt: null },
                weekly: null,
            }),
        });
        expect(quotaSpreadBonusByProvider(full, { spreadBonusMax: 10 }, NOW)['claude-cli']).toBe(10);
    });

    it('yields 0 for stale, failed, or absent readings — identical to pre-feature scoring', () => {
        const stale = nodeWithQuota({ 'claude-cli': okQuota({ updatedAt: NOW - 45 * MIN }) }, NOW);
        expect(quotaSpreadBonusByProvider(stale, null, NOW)['claude-cli']).toBe(0);
        const errored = nodeWithQuota({ 'claude-cli': okQuota({ status: 'unavailable', session: null, weekly: null }) });
        expect(quotaSpreadBonusByProvider(errored, null, NOW)['claude-cli']).toBe(0);
        expect(quotaSpreadBonusByProvider(nodeWithQuota(undefined), null, NOW)).toEqual({});
        expect(quotaSpreadBonusByProvider({ id: 'bare' }, null, NOW)).toEqual({});
    });
});

describe('scoreSlotForTask — quota axis never overturns fitness', () => {
    const easyTask = { difficulty: 'easy' };

    it('prefers the slot with more quota headroom under equal difficulty fit', () => {
        const slot = { provider: 'claude-cli', difficulty: ['easy'] } as any;
        const rich = __scoreSlotForTaskForTests(slot, easyTask, 30);
        const poor = __scoreSlotForTaskForTests(slot, easyTask, 5);
        expect(rich).toBeGreaterThan(poor);
        expect(rich - poor).toBe(25);
    });

    it('a full quota bonus CANNOT reverse a difficulty mismatch (cap 30 < match 100)', () => {
        const matching = { provider: 'a', difficulty: ['easy'] } as any;
        const mismatching = { provider: 'b', difficulty: ['hard'] } as any;
        const mismatchWithFullQuota = __scoreSlotForTaskForTests(mismatching, easyTask, 30);
        const matchWithNoQuota = __scoreSlotForTaskForTests(matching, easyTask, 0);
        expect(mismatchWithFullQuota).toBeLessThan(matchWithNoQuota);
        // exact numbers pinned: base 1 + 0 difficulty + 30 cap vs base 1 + 100 match
        expect(mismatchWithFullQuota).toBe(31);
        expect(matchWithNoQuota).toBe(101);
    });

    it('quota level with requiredTags coverage (+30): both are secondary preferences', () => {
        const slot = { provider: 'a', capability: ['x'] } as any;
        const task = { requiredTags: ['x'] };
        expect(__scoreSlotForTaskForTests(slot, task, 0)).toBe(31); // 1 + 30 coverage
        expect(__scoreSlotForTaskForTests(slot, task, 30)).toBe(61);
    });

    it('omitting the bonus reproduces the pre-feature scores exactly', () => {
        const exact = { provider: 'a', difficulty: ['easy'] } as any;
        const general = { provider: 'b' } as any;
        expect(__scoreSlotForTaskForTests(exact, easyTask)).toBe(101);
        expect(__scoreSlotForTaskForTests(general, easyTask)).toBe(21);
        expect(__scoreSlotForTaskForTests(exact, {})).toBe(1);
    });
});
