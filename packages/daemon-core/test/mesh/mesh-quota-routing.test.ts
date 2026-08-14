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
    describeRecoveryRelaunchDecision,
    resolveRecoveryRelaunchProvider,
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
            sessionAxisWeeklyHeadroomPercent: 40,
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
        expect(resolveQuotaRoutingPolicy({ sessionAxisWeeklyHeadroomPercent: 250 }).sessionAxisWeeklyHeadroomPercent).toBe(100);
        // Percent fields clamp into 0..100 (same convention as the gate thresholds).
        expect(resolveQuotaRoutingPolicy({ sessionAxisWeeklyHeadroomPercent: -1 }).sessionAxisWeeklyHeadroomPercent).toBe(0);
        expect(resolveQuotaRoutingPolicy({ staleAfterMs: -5 }).staleAfterMs).toBe(DEFAULT_QUOTA_ROUTING_POLICY.staleAfterMs);
        expect(resolveQuotaRoutingPolicy({ sessionResetImminentMs: -1 }).sessionResetImminentMs).toBe(DEFAULT_QUOTA_ROUTING_POLICY.sessionResetImminentMs);
    });

    it('drops an absent or all-default quotaRouting from the persisted policy', () => {
        expect(mergeAndNormalizePolicy(undefined, undefined).quotaRouting).toBeUndefined();
        expect(mergeAndNormalizePolicy(undefined, {
            quotaRouting: { sessionMinRemainingPercent: 10, weeklyMinRemainingPercent: 15 },
        } as any).quotaRouting).toBeUndefined();
        expect(normalizeQuotaRoutingPolicy({ staleAfterMs: 30 * MIN })).toBeUndefined();
        expect(normalizeQuotaRoutingPolicy({ sessionAxisWeeklyHeadroomPercent: 40 })).toBeUndefined();
        expect(normalizeQuotaRoutingPolicy({ sessionAxisWeeklyHeadroomPercent: 55 }))
            .toEqual({ sessionAxisWeeklyHeadroomPercent: 55 });
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

    it('uses clone-source facts when a new worktree node has no facts of its own', () => {
        const source = {
            ...nodeWithQuota({
                kimi: okQuota({
                    provider: 'kimi',
                    weekly: { usedPercent: 100, windowMinutes: 10080, resetsAt: null },
                }),
                'codex-cli': okQuota({
                    provider: 'codex-cli',
                    weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: null },
                }),
            }),
            id: 'base-node',
        };
        const clone = { id: 'worktree-node', clonedFromNodeId: source.id };
        const mesh = { nodes: [source, clone] };

        expect(evaluateProviderQuotaGate(clone, 'kimi', { weeklyMinRemainingPercent: 80 }, NOW, mesh)?.reason)
            .toBe(PROVIDER_QUOTA_WEEKLY_LOW_SKIP_REASON);
        expect(evaluateProviderQuotaGate(clone, 'codex-cli', { weeklyMinRemainingPercent: 80 }, NOW, mesh))
            .toBeNull();
        const ranked = rankProvidersByQuotaGate(
            clone,
            ['kimi', 'codex-cli'],
            { weeklyMinRemainingPercent: 80 },
            NOW,
            mesh,
        );
        expect(ranked.clear).toEqual(['codex-cli']);
        expect(ranked.gated.map(entry => entry.providerType)).toEqual(['kimi']);
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

describe('evaluateProviderQuotaGate — retained last-good windows', () => {
    const retainedQuota = (over: Record<string, any> = {}) => okQuota({
        provider: 'kimi',
        status: 'error',
        error: 'token expired',
        metadata: { source: 'oauth', failureKind: 'expired-token', lastGoodWindows: true },
        ...over,
    });

    it('blocks from a fresh retained weekly window when the current probe errored', () => {
        const node = nodeWithQuota({
            kimi: retainedQuota({ weekly: { usedPercent: 100, windowMinutes: 10080, resetsAt: null } }),
        });
        const block = evaluateProviderQuotaGate(node, 'kimi', { weeklyMinRemainingPercent: 80 }, NOW);
        expect(block?.reason).toBe(PROVIDER_QUOTA_WEEKLY_LOW_SKIP_REASON);
        expect(block?.remainingPercent).toBe(0);
    });

    it('fails OPEN once the retained reading is older than staleAfterMs', () => {
        const node = nodeWithQuota({ kimi: retainedQuota({ updatedAt: NOW - 31 * MIN }) });
        expect(evaluateProviderQuotaGate(node, 'kimi', null, NOW)).toBeNull();
    });

    it('keeps a fresh retained reading with sufficient headroom gate-clear', () => {
        const node = nodeWithQuota({
            kimi: retainedQuota({ weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: null } }),
        });
        expect(evaluateProviderQuotaGate(node, 'kimi', { weeklyMinRemainingPercent: 80 }, NOW)).toBeNull();
    });

    it('fails OPEN when an error has windows but no lastGoodWindows provenance', () => {
        const node = nodeWithQuota({
            kimi: retainedQuota({
                weekly: { usedPercent: 100, windowMinutes: 10080, resetsAt: null },
                metadata: { source: 'oauth', failureKind: 'expired-token' },
            }),
        });
        expect(evaluateProviderQuotaGate(node, 'kimi', { weeklyMinRemainingPercent: 80 }, NOW)).toBeNull();
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

describe('rankProvidersByQuotaGate — selection-loop gate + weekly expiry-risk priority', () => {
    const exhausted = (over: Record<string, any> = {}) => okQuota({
        status: 'error',
        session: null,
        weekly: null,
        error: 'usage limit reached (HTTP 403)',
        metadata: { source: 'oauth', failureKind: 'quota-exhausted' },
        ...over,
    });
    const DAY = 24 * 60 * MIN;
    const weeklyWindow = (usedPercent: number, resetsAt: number | null) =>
        ({ usedPercent, windowMinutes: 10080, resetsAt });

    it('orders gate-clear candidates by WEEKLY remaining when the reset time is equal', () => {
        const sameReset = NOW + 5 * DAY;
        const node = nodeWithQuota({
            // kimi listed first by the caller but only 20% weekly remaining...
            kimi: okQuota({ provider: 'kimi', weekly: weeklyWindow(80, sameReset) }),
            // ...claude-cli has 60% weekly remaining and must win the risk tie.
            'claude-cli': okQuota({ weekly: weeklyWindow(40, sameReset) }),
        });
        const ranked = rankProvidersByQuotaGate(node, ['kimi', 'claude-cli'], null, NOW);
        expect(ranked.gated).toEqual([]);
        expect(ranked.clear).toEqual(['claude-cli', 'kimi']);
    });

    // ★The core of the expiry-risk delta: an unused weekly remainder EVAPORATES
    // at the reset, so a smaller remainder hours from its reset is spent before
    // a larger one with days to spare.
    it('prefers the smaller remainder whose reset is IMMINENT over a larger remainder with days to spare', () => {
        const node = nodeWithQuota({
            kimi: okQuota({ provider: 'kimi', weekly: weeklyWindow(60, NOW + 5 * DAY) }),   // 40% left, 5d
            'claude-cli': okQuota({ weekly: weeklyWindow(80, NOW + 2 * 60 * MIN) }),        // 20% left, 2h
        });
        const ranked = rankProvidersByQuotaGate(node, ['kimi', 'claude-cli'], null, NOW);
        expect(ranked.clear).toEqual(['claude-cli', 'kimi']);
    });

    it('a large remainder right AFTER a reset scores ~0 risk — size alone must not win', () => {
        const node = nodeWithQuota({
            // 99% left but the window has 7 full days to go (just reset)...
            kimi: okQuota({ provider: 'kimi', weekly: weeklyWindow(1, NOW + 7 * DAY) }),
            // ...vs 20% left evaporating in 2h — the certain loss comes first.
            'claude-cli': okQuota({ weekly: weeklyWindow(80, NOW + 2 * 60 * MIN) }),
        });
        expect(rankProvidersByQuotaGate(node, ['kimi', 'claude-cli'], null, NOW).clear)
            .toEqual(['claude-cli', 'kimi']);
    });

    it('DIVERGENCE GUARD: a tiny remainder at the reset edge must NOT beat a 90% remainder', () => {
        const node = nodeWithQuota({
            // 16% is the smallest remainder that passes the weekly gate (15%
            // threshold) — even it caps at risk ~16 (risk ≤ remaining by
            // construction) despite being 1 minute from its reset...
            kimi: okQuota({ provider: 'kimi', weekly: weeklyWindow(84, NOW + MIN) }),
            // ...while 90% with 4 of 7 days left scores ~38.6.
            'claude-cli': okQuota({ weekly: weeklyWindow(10, NOW + 4 * DAY) }),
        });
        expect(rankProvidersByQuotaGate(node, ['kimi', 'claude-cli'], null, NOW).clear)
            .toEqual(['claude-cli', 'kimi']);
    });

    it('keeps the caller order on a weekly tie (same remaining, same reset — stable sort)', () => {
        const sameReset = NOW + 5 * DAY;
        const node = nodeWithQuota({
            kimi: okQuota({ provider: 'kimi', weekly: weeklyWindow(40, sameReset) }),
            'claude-cli': okQuota({ weekly: weeklyWindow(40, sameReset) }),
        });
        expect(rankProvidersByQuotaGate(node, ['kimi', 'claude-cli'], null, NOW).clear)
            .toEqual(['kimi', 'claude-cli']);
    });

    it('reset-time UNKNOWN (remaining known): zero invented urgency — below positive risk, above remaining-unknown', () => {
        const node = nodeWithQuota({
            // measured with evidenced urgency: 30% left, 1d to go (risk ~25.7)
            codex: okQuota({ provider: 'codex', weekly: weeklyWindow(70, NOW + DAY) }),
            // remaining known (50%) but resetsAt absent → risk 0, no invented urgency
            'claude-cli': okQuota({ weekly: weeklyWindow(50, null) }),
            // kimi: no quota entry at all → remaining unknown
        });
        const ranked = rankProvidersByQuotaGate(node, ['kimi', 'claude-cli', 'codex'], null, NOW);
        expect(ranked.clear).toEqual(['codex', 'claude-cli', 'kimi']);
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

describe('rankProvidersByQuotaGate — session (5h) expiry axis, the 2′ conditional gate', () => {
    const DAY = 24 * 60 * MIN;
    const weeklyWindow = (usedPercent: number, resetsAt: number | null) =>
        ({ usedPercent, windowMinutes: 10080, resetsAt });
    const sessionWindow = (usedPercent: number, resetsAt: number | null) =>
        ({ usedPercent, windowMinutes: 300, resetsAt });
    // In every case below reportedAt = NOW and updatedAt = NOW - MIN, so the
    // skew-safe reporter-now estimate is exactly NOW and resetsAt values are
    // plain NOW-relative.

    // Comfortable weekly headroom (> 40) on every candidate: the session axis
    // ranks. Both weekly readings are identical, so the weekly axis alone
    // would keep the caller order — only the 5h axis can flip it.
    it('weekly-comfortable: prefers the provider whose SESSION remainder is about to evaporate', () => {
        const node = nodeWithQuota({
            'claude-cli': okQuota({
                session: sessionWindow(30, NOW + 270 * MIN),       // 70% left, 4.5h to reset → risk ~7
                weekly: weeklyWindow(40, NOW + 5 * DAY),           // 60% left — comfortable
            }),
            kimi: okQuota({
                provider: 'kimi',
                session: sessionWindow(30, NOW + 20 * MIN),        // 70% left, 20min to reset → risk ~65
                weekly: weeklyWindow(40, NOW + 5 * DAY),           // identical weekly reading
            }),
        });
        const ranked = rankProvidersByQuotaGate(node, ['claude-cli', 'kimi'], null, NOW);
        expect(ranked.gated).toEqual([]);
        expect(ranked.clear).toEqual(['kimi', 'claude-cli']);
    });

    // Weekly-tight candidate present (30 ≤ 40): the 5h axis is IGNORED and the
    // weekly axis governs — spending kimi's expiring session first would drain
    // its tight weekly budget early.
    it('weekly-tight: keeps the weekly order even when a session remainder is about to evaporate', () => {
        const node = nodeWithQuota({
            kimi: okQuota({
                provider: 'kimi',
                session: sessionWindow(30, NOW + 20 * MIN),        // expiring-in-20min session
                weekly: weeklyWindow(70, NOW + 5 * DAY),           // 30% left — tight
            }),
            'claude-cli': okQuota({
                session: sessionWindow(30, NOW + 270 * MIN),
                weekly: weeklyWindow(40, NOW + 5 * DAY),           // 60% left — wins the weekly tie-break
            }),
        });
        expect(rankProvidersByQuotaGate(node, ['kimi', 'claude-cli'], null, NOW).clear)
            .toEqual(['claude-cli', 'kimi']);
    });

    // Fail-open on the 5h axis: sessions unreadable → the decision is exactly
    // what the weekly axis would have made.
    it('session reading missing: falls back to the weekly order (fail-open)', () => {
        const node = nodeWithQuota({
            kimi: okQuota({
                provider: 'kimi',
                session: null,                                     // 5h axis unreadable
                weekly: weeklyWindow(40, NOW + 5 * DAY),
            }),
            'claude-cli': okQuota({
                session: null,
                weekly: weeklyWindow(40, NOW + 2 * 60 * MIN),      // same remaining, reset in 2h → higher risk
            }),
        });
        expect(rankProvidersByQuotaGate(node, ['kimi', 'claude-cli'], null, NOW).clear)
            .toEqual(['claude-cli', 'kimi']);
    });

    it('session reading STALE: the whole snapshot fails open to the weekly order', () => {
        const staleSession = okQuota({
            session: sessionWindow(30, NOW + 20 * MIN),
            weekly: weeklyWindow(40, NOW + 5 * DAY),
            updatedAt: NOW - 45 * MIN,                             // stale → neither axis reads it
        });
        const node = nodeWithQuota({
            kimi: staleSession,
            'claude-cli': okQuota({
                session: sessionWindow(30, NOW + 270 * MIN),
                weekly: weeklyWindow(40, NOW + 5 * DAY),
            }),
        });
        // kimi's snapshot is stale → weekly-unknown → sorts LAST; claude-cli's
        // comfortable weekly reading activates the session axis for itself.
        expect(rankProvidersByQuotaGate(node, ['kimi', 'claude-cli'], null, NOW).clear)
            .toEqual(['claude-cli', 'kimi']);
    });

    // Unknown-last on the 5h axis too: a session-measured candidate outranks a
    // session-unreadable one when the session axis is active.
    it('session-axis mode sorts session-unreadable below session-measured (unknown-last)', () => {
        const node = nodeWithQuota({
            'claude-cli': okQuota({
                session: null,                                     // 5h unreadable
                weekly: weeklyWindow(40, NOW + 5 * DAY),
            }),
            kimi: okQuota({
                provider: 'kimi',
                session: sessionWindow(30, NOW + 20 * MIN),        // expiring session
                weekly: weeklyWindow(40, NOW + 5 * DAY),
            }),
        });
        expect(rankProvidersByQuotaGate(node, ['claude-cli', 'kimi'], null, NOW).clear)
            .toEqual(['kimi', 'claude-cli']);
    });

    // ★Boundary pin: the activation test is STRICTLY greater-than. A weekly
    // remaining of exactly the threshold stays weekly-protected; one point
    // above it switches to the session axis.
    it('activates on weekly remaining > threshold only — exactly AT the threshold stays weekly', () => {
        const atThreshold = nodeWithQuota({
            kimi: okQuota({
                provider: 'kimi',
                session: sessionWindow(30, NOW + 20 * MIN),        // expiring session
                weekly: weeklyWindow(60, NOW + 5 * DAY),           // exactly 40% left = threshold
            }),
            'claude-cli': okQuota({
                session: sessionWindow(30, NOW + 270 * MIN),
                weekly: weeklyWindow(40, NOW + 5 * DAY),           // 60% left
            }),
        });
        // Weekly mode: claude-cli's larger weekly remainder wins the tie-break
        // — the expiring session is deliberately NOT harvested.
        expect(rankProvidersByQuotaGate(atThreshold, ['kimi', 'claude-cli'], null, NOW).clear)
            .toEqual(['claude-cli', 'kimi']);

        const oneAbove = nodeWithQuota({
            kimi: okQuota({
                provider: 'kimi',
                session: sessionWindow(30, NOW + 20 * MIN),
                weekly: weeklyWindow(59, NOW + 5 * DAY),           // 41% left > threshold
            }),
            'claude-cli': okQuota({
                session: sessionWindow(30, NOW + 270 * MIN),
                weekly: weeklyWindow(40, NOW + 5 * DAY),
            }),
        });
        expect(rankProvidersByQuotaGate(oneAbove, ['kimi', 'claude-cli'], null, NOW).clear)
            .toEqual(['kimi', 'claude-cli']);
    });

    it('honours a configured sessionAxisWeeklyHeadroomPercent', () => {
        const node = nodeWithQuota({
            kimi: okQuota({
                provider: 'kimi',
                session: sessionWindow(30, NOW + 20 * MIN),
                weekly: weeklyWindow(40, NOW + 5 * DAY),           // 60% left
            }),
            'claude-cli': okQuota({
                session: sessionWindow(30, NOW + 270 * MIN),
                weekly: weeklyWindow(40, NOW + 5 * DAY),
            }),
        });
        // 60 > 70 is false → weekly mode → tie → caller order.
        expect(rankProvidersByQuotaGate(node, ['claude-cli', 'kimi'], { sessionAxisWeeklyHeadroomPercent: 70 }, NOW).clear)
            .toEqual(['claude-cli', 'kimi']);
        // 60 > 50 → session mode → kimi's expiring session wins.
        expect(rankProvidersByQuotaGate(node, ['claude-cli', 'kimi'], { sessionAxisWeeklyHeadroomPercent: 50 }, NOW).clear)
            .toEqual(['kimi', 'claude-cli']);
    });

    it('no quota information at all: caller order preserved byte-for-byte', () => {
        expect(rankProvidersByQuotaGate(nodeWithQuota(undefined), ['kimi', 'claude-cli', 'codex'], null, NOW))
            .toEqual({ clear: ['kimi', 'claude-cli', 'codex'], gated: [] });
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

describe('resolveRecoveryRelaunchProvider — the recovery-relaunch gate', () => {
    // The failure-recovery path re-queues a dead session's task and relaunches.
    // Before this gate it relaunched the SAME provider unconditionally, so a
    // quota-caused death repeated itself. Every assertion below turns on the
    // provider's QUOTA SNAPSHOT — never on the fact that a session died.

    it('BLOCKS a same-provider relaunch when the provider reported its quota exhausted', () => {
        const node = nodeWithQuota({
            'kimi': okQuota({
                provider: 'kimi',
                status: 'error',
                session: null,
                weekly: null,
                metadata: { failureKind: 'quota-exhausted' },
            }),
        });
        const d = resolveRecoveryRelaunchProvider(node, 'kimi', ['kimi'], null, NOW);
        expect(d.action).toBe('block');
        expect(d.providerType).toBeUndefined();
        expect(d.block?.reason).toBe(PROVIDER_QUOTA_EXHAUSTED_SKIP_REASON);
    });

    it('BLOCKS when the failed provider is below a window threshold', () => {
        const node = nodeWithQuota({
            'claude-cli': okQuota({ weekly: { usedPercent: 97, windowMinutes: 10080, resetsAt: null } }),
        });
        const d = resolveRecoveryRelaunchProvider(node, 'claude-cli', ['claude-cli'], null, NOW);
        expect(d.action).toBe('block');
        expect(d.block?.reason).toBe(PROVIDER_QUOTA_WEEKLY_LOW_SKIP_REASON);
    });

    // ★DEADLOCK REGRESSION GUARD. 'expired-token' is self-healing — the CLI
    // refreshes its own token on its next run — so blocking the relaunch would
    // mean the CLI never runs and the token never refreshes. It must fail open,
    // and it must do so even on a node with no alternative provider.
    it('does NOT block on expired-token, even on a single-provider node', () => {
        const node = nodeWithQuota({
            'kimi': okQuota({
                provider: 'kimi',
                status: 'error',
                session: null,
                weekly: null,
                metadata: { failureKind: 'expired-token' },
            }),
        });
        const d = resolveRecoveryRelaunchProvider(node, 'kimi', ['kimi'], null, NOW);
        expect(d.action).toBe('keep');
        expect(d.providerType).toBe('kimi');
    });

    it('does not block on any other transient failure kind', () => {
        for (const failureKind of ['unauthorized', 'network', 'server', 'rate-limited', 'cli-unavailable', 'parse', 'unknown']) {
            const node = nodeWithQuota({
                'kimi': okQuota({ provider: 'kimi', status: 'error', session: null, weekly: null, metadata: { failureKind } }),
            });
            expect(resolveRecoveryRelaunchProvider(node, 'kimi', ['kimi'], null, NOW).action).toBe('keep');
        }
    });

    // ★MISCLASSIFICATION REGRESSION GUARD. Observed live: a kimi CLI exited 0
    // within ~20ms, six consecutive times, because it prompts to trust an
    // unseen folder and a worktree is always a new path. Quota was perfectly
    // healthy. A gate that read "died repeatedly" as a quota signal would have
    // blacklisted a working provider over an environment problem — this gate
    // reads only the snapshot, so such a death relaunches untouched.
    it('relaunches normally when the session died with HEALTHY quota', () => {
        const node = nodeWithQuota({ 'kimi': okQuota({ provider: 'kimi' }) });
        const d = resolveRecoveryRelaunchProvider(node, 'kimi', ['kimi'], null, NOW);
        expect(d.action).toBe('keep');
        expect(d.providerType).toBe('kimi');
        expect(d.block).toBeUndefined();
    });

    it('relaunches normally when quota is unknown, opted-out, or stale', () => {
        // No snapshot at all (never reported / quotaEnabled === false).
        expect(resolveRecoveryRelaunchProvider(nodeWithQuota(undefined), 'kimi', ['kimi'], null, NOW).action).toBe('keep');
        expect(resolveRecoveryRelaunchProvider(nodeWithQuota({}), 'kimi', ['kimi'], null, NOW).action).toBe('keep');
        // A STALE exhaustion reading must fail open like everything else —
        // routing on an old reading would exclude a provider that has since reset.
        const staleExhausted = nodeWithQuota({
            'kimi': okQuota({
                provider: 'kimi', status: 'error', session: null, weekly: null,
                updatedAt: NOW - 90 * MIN,
                metadata: { failureKind: 'quota-exhausted' },
            }),
        });
        expect(resolveRecoveryRelaunchProvider(staleExhausted, 'kimi', ['kimi'], null, NOW).action).toBe('keep');
    });

    it('FALLS THROUGH to the node\'s next gate-clear provider instead of stalling', () => {
        const node = nodeWithQuota({
            'kimi': okQuota({
                provider: 'kimi', status: 'error', session: null, weekly: null,
                metadata: { failureKind: 'quota-exhausted' },
            }),
            'claude-cli': okQuota({ provider: 'claude-cli' }),
        });
        const d = resolveRecoveryRelaunchProvider(node, 'kimi', ['kimi', 'claude-cli'], null, NOW);
        expect(d.action).toBe('fallback');
        expect(d.providerType).toBe('claude-cli');
        // The block that caused the diversion is reported for the log line.
        expect(d.block?.reason).toBe(PROVIDER_QUOTA_EXHAUSTED_SKIP_REASON);
    });

    it('orders fall-through candidates by the same weekly expiry risk as the launch loop', () => {
        // Both alternatives are gate-clear; 'b' has the same remainder but a
        // window nearly elapsed, so its remainder is the one about to evaporate.
        const node = nodeWithQuota({
            'kimi': okQuota({
                provider: 'kimi', status: 'error', session: null, weekly: null,
                metadata: { failureKind: 'quota-exhausted' },
            }),
            'a': okQuota({ provider: 'a', weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: NOW + 10000 * MIN } }),
            'b': okQuota({ provider: 'b', weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: NOW + 10 * MIN } }),
        });
        const d = resolveRecoveryRelaunchProvider(node, 'kimi', ['kimi', 'a', 'b'], null, NOW);
        expect(d.action).toBe('fallback');
        expect(d.providerType).toBe('b');
        expect(rankProvidersByQuotaGate(node, ['a', 'b'], null, NOW).clear).toEqual(['b', 'a']);
    });

    // ★NO-DEAD-END GUARD. When every alternative is ALSO gated there is nothing
    // to relaunch, so the decision is 'block' — but the caller has already
    // re-queued the task, so blocking leaves it PENDING for the ordinary drain
    // (another node, or this one once a window resets). It is never failed or
    // cancelled here, and no phantom provider is invented.
    it('blocks rather than trading one exhausted provider for another', () => {
        const exhausted = (provider: string) => okQuota({
            provider, status: 'error', session: null, weekly: null,
            metadata: { failureKind: 'quota-exhausted' },
        });
        const node = nodeWithQuota({ 'kimi': exhausted('kimi'), 'claude-cli': exhausted('claude-cli') });
        const d = resolveRecoveryRelaunchProvider(node, 'kimi', ['kimi', 'claude-cli'], null, NOW);
        expect(d.action).toBe('block');
        expect(d.providerType).toBeUndefined();
    });

    it('blocks a single-provider node with no alternative to offer', () => {
        const node = nodeWithQuota({
            'kimi': okQuota({
                provider: 'kimi', status: 'error', session: null, weekly: null,
                metadata: { failureKind: 'quota-exhausted' },
            }),
        });
        // No candidate list at all, and a list naming only the failed provider,
        // both resolve to block — never to a relaunch of the exhausted provider.
        expect(resolveRecoveryRelaunchProvider(node, 'kimi', [], null, NOW).action).toBe('block');
        expect(resolveRecoveryRelaunchProvider(node, 'kimi', ['kimi'], null, NOW).action).toBe('block');
    });

    it('honours tunable thresholds rather than hardcoded ones', () => {
        const node = nodeWithQuota({
            'claude-cli': okQuota({ weekly: { usedPercent: 80, windowMinutes: 10080, resetsAt: null } }),
        });
        // 20% remaining clears the default 15% threshold...
        expect(resolveRecoveryRelaunchProvider(node, 'claude-cli', ['claude-cli'], null, NOW).action).toBe('keep');
        // ...and is blocked once the operator raises it.
        expect(resolveRecoveryRelaunchProvider(node, 'claude-cli', ['claude-cli'], { weeklyMinRemainingPercent: 30 }, NOW).action).toBe('block');
    });

    it('blocks defensively when the failed provider type is missing', () => {
        expect(resolveRecoveryRelaunchProvider(nodeWithQuota({}), '', [], null, NOW).action).toBe('block');
    });
});

describe('describeRecoveryRelaunchDecision — recovery-relaunch observability', () => {
    it('stays SILENT on keep, so a normal death gains no log line', () => {
        expect(describeRecoveryRelaunchDecision(
            { action: 'keep', providerType: 'kimi' }, 'n1', 'kimi', 't1',
        )).toBeNull();
    });

    it('names the cause and the substitute on a fall-through', () => {
        const msg = describeRecoveryRelaunchDecision(
            { action: 'fallback', providerType: 'claude-cli', block: { reason: PROVIDER_QUOTA_EXHAUSTED_SKIP_REASON, window: 'unknown', remainingPercent: 0, thresholdPercent: 0 } },
            'n1', 'kimi', 't1',
        );
        expect(msg).toContain('kimi');
        expect(msg).toContain(PROVIDER_QUOTA_EXHAUSTED_SKIP_REASON);
        expect(msg).toContain('claude-cli');
    });

    it('says the task stays queued when nothing is relaunched', () => {
        const msg = describeRecoveryRelaunchDecision(
            { action: 'block', block: { reason: PROVIDER_QUOTA_WEEKLY_LOW_SKIP_REASON, window: 'weekly', remainingPercent: 3, thresholdPercent: 15 } },
            'n1', 'kimi', 'task-9',
        );
        expect(msg).toContain('task-9');
        expect(msg).toContain('stays queued');
    });
});
