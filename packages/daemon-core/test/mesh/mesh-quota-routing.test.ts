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
    quotaRiskSnapshotForCandidates,
    buildQuotaRankingRationale,
    describeRecoveryRelaunchDecision,
    resolveRecoveryRelaunchProvider,
    liveLocalProviderEnablementForRouting,
    ALL_PROVIDERS_QUOTA_GATED_SKIP_REASON,
    PROVIDER_QUOTA_SESSION_LOW_SKIP_REASON,
    PROVIDER_QUOTA_WEEKLY_LOW_SKIP_REASON,
    PROVIDER_QUOTA_EXHAUSTED_SKIP_REASON,
} from '../../src/mesh/mesh-quota-routing.js';
import { LOG } from '../../src/logging/logger.js';
import {
    DEFAULT_QUOTA_ROUTING_POLICY,
    mergeAndNormalizePolicy,
    normalizeQuotaRoutingPolicy,
    resolveQuotaRoutingPolicy,
} from '../../src/repo-mesh-types.js';
import { __scoreSlotForTaskForTests } from '../../src/mesh/mesh-events-coordinator.js';

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;
/**
 * An age that is definitively PAST the default staleness threshold, derived
 * from the threshold instead of written as a literal.
 *
 * These cases assert "a stale reading fails open", never "a 45-minute reading
 * fails open" — but they used to say 45 minutes, so raising the default from
 * 30 to 60 min silently turned a dozen of them into their own opposite (they
 * kept passing a FRESH snapshot to a test named "stale"). Deriving the age is
 * what makes the next threshold change a one-line edit instead of an audit.
 */
const STALE_AGE = DEFAULT_QUOTA_ROUTING_POLICY.staleAfterMs + 15 * MIN;

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
            // 60 min since 2026-08-21 (owner decision); it remains the fallback
            // for windows without resetsAt, and quota/refresh.ts pins
            // QUOTA_ROUTABLE_MAX_AGE_MS to the same value.
            staleAfterMs: 60 * MIN,
            sessionMinRemainingPercent: 10,
            sessionResetImminentMs: 5 * MIN,
            weeklyMinRemainingPercent: 15,
            spreadBonusMax: 30,
            sessionAxisWeeklyHeadroomPercent: 40,
            // ON by default (owner decision): a saturated first choice falls
            // through to the next quota-clear candidate on the SAME node rather
            // than re-electing the busy one on every reconcile tick.
            quotaBusyFallback: true,
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
        expect(normalizeQuotaRoutingPolicy({ staleAfterMs: 60 * MIN })).toBeUndefined();
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
        // Derived from the default rather than written as a literal: this case
        // is about "past the threshold", not about any particular number of
        // minutes, and hard-coding one is what made a threshold change ripple
        // through a dozen unrelated assertions.
        const pastDefault = DEFAULT_QUOTA_ROUTING_POLICY.staleAfterMs + MIN;
        expect(isQuotaSnapshotFresh(facts, { updatedAt: NOW - pastDefault }, null, NOW)).toBe(false);
        expect(isQuotaSnapshotFresh(facts, { updatedAt: NOW - pastDefault }, { staleAfterMs: pastDefault + MIN }, NOW)).toBe(true);
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
            updatedAt: NOW - STALE_AGE, // stale snapshot, fresh bundle stamp
        });
        const node = nodeWithQuota({ 'claude-cli': exhausted }, NOW);
        expect(evaluateProviderQuotaGate(node, 'claude-cli', null, NOW)).toBeNull();
    });

    it('fails OPEN when the bundle itself is old', () => {
        const exhausted = okQuota({
            session: { usedPercent: 99, windowMinutes: 300, resetsAt: null },
            weekly: { usedPercent: 99, windowMinutes: 10080, resetsAt: null },
        });
        const node = nodeWithQuota({ 'claude-cli': exhausted }, NOW - STALE_AGE);
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

    // ★REGRESSION: expired session/weekly readings must not gate (M-MESH-INFRA-0829).
    // The window-boundary-validity decision (oss 5c65c5d4) says a measured window
    // is authoritative only until its own resetsAt; after that the reading describes
    // a previous window and must fail open. isWindowTrustworthy enforces this, and
    // evaluateProviderQuotaGate re-asserts it at the gate level.
    it('fails OPEN on a session window whose resetsAt has already passed', () => {
        const node = nodeWithQuota({
            'codex-cli': okQuota({
                provider: 'codex-cli',
                session: { usedPercent: 97, windowMinutes: 300, resetsAt: NOW - 5 * MIN },
                weekly: { usedPercent: 50, windowMinutes: 10080, resetsAt: NOW + 7 * 24 * 60 * MIN },
            }),
        });
        expect(evaluateProviderQuotaGate(node, 'codex-cli', null, NOW)).toBeNull();
    });

    it('fails OPEN on a weekly window whose resetsAt has already passed', () => {
        const node = nodeWithQuota({
            'codex-cli': okQuota({
                provider: 'codex-cli',
                session: { usedPercent: 50, windowMinutes: 300, resetsAt: NOW + 60 * MIN },
                weekly: { usedPercent: 97, windowMinutes: 10080, resetsAt: NOW - 5 * MIN },
            }),
        });
        expect(evaluateProviderQuotaGate(node, 'codex-cli', null, NOW)).toBeNull();
    });

    it('still gates a session window that is below threshold BEFORE its resetsAt passes', () => {
        const node = nodeWithQuota({
            'codex-cli': okQuota({
                provider: 'codex-cli',
                session: { usedPercent: 97, windowMinutes: 300, resetsAt: NOW + 5 * MIN },
                weekly: { usedPercent: 50, windowMinutes: 10080, resetsAt: NOW + 7 * 24 * 60 * MIN },
            }),
        });
        const block = evaluateProviderQuotaGate(node, 'codex-cli', null, NOW);
        expect(block?.reason).toBe(PROVIDER_QUOTA_SESSION_LOW_SKIP_REASON);
        expect(block?.window).toBe('session');
    });
});

describe('evaluateProviderQuotaGate — absent-entry fail-open observability', () => {
    function loaderContext(over: {
        providerEnabled?: boolean;
        quotaEnabled?: boolean;
        isLocal?: boolean;
    } = {}) {
        const { providerEnabled = true, quotaEnabled = true, isLocal = true } = over;
        const loader = {
            isMachineProviderEnabled: vi.fn(() => providerEnabled),
            isMachineQuotaEnabled: vi.fn(() => quotaEnabled),
        };
        return {
            providerEnablement: liveLocalProviderEnablementForRouting(loader, () => isLocal),
        };
    }

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('logs on an absent entry (no snapshot, no context) — the branch used to be silent', () => {
        const spy = vi.spyOn(LOG, 'info');
        const node = { id: `n-${randomUUID()}` };
        expect(evaluateProviderQuotaGate(node, 'claude-cli', null, NOW)).toBeNull();
        expect(spy).toHaveBeenCalledTimes(1);
        const [component, message] = spy.mock.calls[0];
        expect(component).toBe('MeshQuota');
        expect(message).toContain("provider 'claude-cli'");
        expect(message).toContain(node.id);
        expect(message).toContain('unclassified_remote');
    });

    it('throttles repeat lines for the same (node, provider) within the freshness window', () => {
        const spy = vi.spyOn(LOG, 'info');
        const node = { id: `n-${randomUUID()}` };
        expect(evaluateProviderQuotaGate(node, 'claude-cli', null, NOW)).toBeNull();
        expect(evaluateProviderQuotaGate(node, 'claude-cli', null, NOW + MIN)).toBeNull();
        // The throttle window IS staleAfterMs (mesh-quota-routing.ts reuses the
        // policy value), so both bounds are derived from it rather than pinned
        // to whatever it happened to be when this case was written.
        expect(evaluateProviderQuotaGate(node, 'claude-cli', null, NOW + DEFAULT_QUOTA_ROUTING_POLICY.staleAfterMs - MIN)).toBeNull();
        expect(spy).toHaveBeenCalledTimes(1); // still inside the staleAfterMs window
        expect(evaluateProviderQuotaGate(node, 'claude-cli', null, NOW + DEFAULT_QUOTA_ROUTING_POLICY.staleAfterMs + MIN)).toBeNull();
        expect(spy).toHaveBeenCalledTimes(2); // window elapsed — logs again
    });

    it('does not throttle across DIFFERENT (node, provider) keys', () => {
        const spy = vi.spyOn(LOG, 'info');
        const nodeA = { id: `n-${randomUUID()}` };
        const nodeB = { id: `n-${randomUUID()}` };
        expect(evaluateProviderQuotaGate(nodeA, 'claude-cli', null, NOW)).toBeNull();
        expect(evaluateProviderQuotaGate(nodeB, 'claude-cli', null, NOW)).toBeNull();
        expect(evaluateProviderQuotaGate(nodeA, 'codex-cli', null, NOW)).toBeNull();
        expect(spy).toHaveBeenCalledTimes(3);
    });

    it('classifies not_measured only for a CONFIRMED-local node with both axes enabled and no snapshot', () => {
        const spy = vi.spyOn(LOG, 'info');
        const node = { id: `n-${randomUUID()}` };
        const context = loaderContext({ providerEnabled: true, quotaEnabled: true, isLocal: true });
        expect(evaluateProviderQuotaGate(node, 'claude-cli', null, NOW, context)).toBeNull();
        const message = spy.mock.calls[0][1] as string;
        expect(message).toContain('not_measured');
        expect(message).not.toContain('unclassified_remote');
    });

    it('classifies probe_disabled distinctly and words it as an intended opt-out, not a fault', () => {
        const spy = vi.spyOn(LOG, 'info');
        const node = { id: `n-${randomUUID()}` };
        const context = loaderContext({ providerEnabled: true, quotaEnabled: false, isLocal: true });
        expect(evaluateProviderQuotaGate(node, 'claude-cli', null, NOW, context)).toBeNull();
        const message = spy.mock.calls[0][1] as string;
        expect(message).toContain('probe_disabled');
        expect(message.toLowerCase()).not.toMatch(/\berror\b|\bproblem\b|\bdefect\b/);
        expect(message).toContain('opt-out');
        expect(message).toContain('not a fault'); // words the opt-out as explicitly non-defect
    });

    it('classifies provider_disabled distinctly from probe_disabled', () => {
        const spy = vi.spyOn(LOG, 'info');
        const node = { id: `n-${randomUUID()}` };
        const context = loaderContext({ providerEnabled: false, quotaEnabled: true, isLocal: true });
        expect(evaluateProviderQuotaGate(node, 'claude-cli', null, NOW, context)).toBeNull();
        const message = spy.mock.calls[0][1] as string;
        expect(message).toContain('provider_disabled');
        expect(message).not.toContain('probe_disabled');
    });

    it('never reports not_measured/probe_disabled/provider_disabled for a node this daemon cannot confirm as local', () => {
        const spy = vi.spyOn(LOG, 'info');
        const node = { id: `n-${randomUUID()}`, daemonId: 'daemon_someone_else' };
        // A loader IS injected, but isLocalNode says false — must not guess a
        // local-only classification from config this daemon cannot actually
        // attribute to that remote node.
        const context = loaderContext({ providerEnabled: true, quotaEnabled: true, isLocal: false });
        expect(evaluateProviderQuotaGate(node, 'claude-cli', null, NOW, context)).toBeNull();
        const message = spy.mock.calls[0][1] as string;
        expect(message).toContain('unclassified_remote');
        expect(message).not.toContain('not_measured');
        expect(message).not.toContain('probe_disabled');
        expect(message).not.toContain('provider_disabled');
    });

    it('does not gate or otherwise change routing behaviour — logging is observation-only', () => {
        // Same absent-entry scenarios as the pre-existing fail-open assertions,
        // now with a loader context attached: the return value must be
        // unchanged (still null) regardless of classification.
        const local = loaderContext({ providerEnabled: true, quotaEnabled: true, isLocal: true });
        const disabled = loaderContext({ providerEnabled: false, quotaEnabled: true, isLocal: true });
        const probeOff = loaderContext({ providerEnabled: true, quotaEnabled: false, isLocal: true });
        expect(evaluateProviderQuotaGate({ id: 'a' }, 'claude-cli', null, NOW, local)).toBeNull();
        expect(evaluateProviderQuotaGate({ id: 'b' }, 'claude-cli', null, NOW, disabled)).toBeNull();
        expect(evaluateProviderQuotaGate({ id: 'c' }, 'claude-cli', null, NOW, probeOff)).toBeNull();
    });
});

describe('evaluateProviderQuotaGate — REMOTE enablement facts classification', () => {
    // The coverage gap this block closes: before nodes reported their own
    // enablement switches, every node but this daemon's own (and its worktree
    // clones) fell to 'unclassified_remote', so in an N-node mesh the
    // coordinator could not tell an opt-out from a never-measured provider on
    // any node but one. These nodes carry NO local loader context at all —
    // classification comes purely from what the node itself reported.
    function remoteNode(
        enablement: Record<string, unknown> | undefined,
        extra: Record<string, unknown> = {},
    ) {
        return {
            id: `n-${randomUUID()}`,
            daemonId: 'daemon_someone_else',
            nodeFacts: {
                schemaVersion: 1,
                reportedAt: NOW,
                ...(enablement ? { providerEnablement: enablement } : {}),
            },
            ...extra,
        };
    }

    function classifyRemote(node: any, context?: any): string {
        const spy = vi.spyOn(LOG, 'info');
        expect(evaluateProviderQuotaGate(node, 'claude-cli', null, NOW, context)).toBeNull();
        return spy.mock.calls[0][1] as string;
    }

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('classifies provider_disabled on a REMOTE node from its reported facts', () => {
        const message = classifyRemote(remoteNode({
            'claude-cli': { enabled: false, quotaEnabled: true },
        }));
        expect(message).toContain('provider_disabled');
        expect(message).not.toContain('unclassified_remote');
    });

    it('classifies probe_disabled on a REMOTE node and still words it as an intended opt-out', () => {
        const message = classifyRemote(remoteNode({
            'claude-cli': { enabled: true, quotaEnabled: false },
        }));
        expect(message).toContain('probe_disabled');
        expect(message).toContain('opt-out');
        expect(message).toContain('not a fault');
        expect(message.toLowerCase()).not.toMatch(/\berror\b|\bproblem\b|\bdefect\b/);
    });

    it('classifies not_measured on a REMOTE node whose switches are both on', () => {
        const message = classifyRemote(remoteNode({
            'claude-cli': { enabled: true, quotaEnabled: true },
        }));
        expect(message).toContain('not_measured');
        expect(message).not.toContain('unclassified_remote');
    });

    it('reads a worktree clone\'s reason from its SOURCE node\'s reported facts', () => {
        const source = remoteNode({ 'claude-cli': { enabled: true, quotaEnabled: false } });
        const clone = { id: `n-${randomUUID()}`, clonedFromNodeId: source.id, nodeFacts: { schemaVersion: 1, reportedAt: NOW } };
        const message = classifyRemote(clone, { nodes: [source, clone] });
        expect(message).toContain('probe_disabled');
    });

    // ★THE back-compat contract. A daemon predating this field sends nothing;
    // reading that absence as "disabled" would fabricate a fail-closed verdict
    // from a missing field — the exact misread this test pins shut.
    it('falls back to unclassified_remote for an OLD daemon that sends no enablement facts — absence is never "disabled"', () => {
        const message = classifyRemote(remoteNode(undefined));
        expect(message).toContain('unclassified_remote');
        expect(message).not.toContain('probe_disabled');
        expect(message).not.toContain('provider_disabled');
        expect(message).not.toContain('not_measured');
    });

    it('falls back to unclassified_remote when the bundle omits THIS provider', () => {
        const message = classifyRemote(remoteNode({ 'codex-cli': { enabled: true, quotaEnabled: true } }));
        expect(message).toContain('unclassified_remote');
    });

    it('treats a MALFORMED or partial entry as no report, never as an opt-out', () => {
        for (const bad of [
            { 'claude-cli': { enabled: false } },                       // missing quotaEnabled
            { 'claude-cli': { quotaEnabled: false } },                  // missing enabled
            { 'claude-cli': { enabled: 'false', quotaEnabled: 'false' } }, // strings, not booleans
            { 'claude-cli': null },
            { 'claude-cli': 'disabled' },
        ] as Record<string, unknown>[]) {
            vi.restoreAllMocks();
            const message = classifyRemote(remoteNode(bad));
            expect(message, JSON.stringify(bad)).toContain('unclassified_remote');
            expect(message, JSON.stringify(bad)).not.toContain('provider_disabled');
        }
    });

    it('prefers the LIVE local config over a reported copy for a node this daemon owns', () => {
        // The node's stamped facts say "both on" but the live loader says the
        // probe is off. The config is current; the stamp is from the last
        // git_status, so the live read must win.
        const node = {
            id: `n-${randomUUID()}`,
            nodeFacts: {
                schemaVersion: 1,
                reportedAt: NOW,
                providerEnablement: { 'claude-cli': { enabled: true, quotaEnabled: true } },
            },
        };
        const context = {
            providerEnablement: liveLocalProviderEnablementForRouting(
                { isMachineProviderEnabled: () => true, isMachineQuotaEnabled: () => false },
                () => true,
            ),
        };
        const message = classifyRemote(node, context);
        expect(message).toContain('probe_disabled');
        expect(message).not.toContain('not_measured');
    });

    // ★Routing must be untouched: this whole axis is observation-only.
    it('does not change routing behaviour for ANY remote classification — still fail-open', () => {
        for (const enablement of [
            { 'claude-cli': { enabled: false, quotaEnabled: false } },
            { 'claude-cli': { enabled: true, quotaEnabled: false } },
            { 'claude-cli': { enabled: true, quotaEnabled: true } },
            undefined,
        ]) {
            const node = remoteNode(enablement);
            expect(evaluateProviderQuotaGate(node, 'claude-cli', null, NOW)).toBeNull();
            const ranked = rankProvidersByQuotaGate(node, ['claude-cli'], null, NOW);
            expect(ranked.clear).toEqual(['claude-cli']);
            expect(ranked.gated).toEqual([]);
        }
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
        const node = nodeWithQuota({ kimi: exhaustedQuota({ updatedAt: NOW - STALE_AGE }) }, NOW);
        expect(evaluateProviderQuotaGate(node, 'kimi', null, NOW)).toBeNull();
    });

    it('fails OPEN on quota-exhausted when the bundle itself is old', () => {
        const node = nodeWithQuota({ kimi: exhaustedQuota() }, NOW - STALE_AGE);
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
        const node = nodeWithQuota({ kimi: retainedQuota({ updatedAt: NOW - STALE_AGE }) });
        expect(evaluateProviderQuotaGate(node, 'kimi', null, NOW)).toBeNull();
    });

    it('blocks from a stale exhausted retained window while its own reset is still in the future', () => {
        const node = nodeWithQuota({
            kimi: retainedQuota({
                weekly: { usedPercent: 100, windowMinutes: 10080, resetsAt: NOW + 2 * 24 * 60 * MIN },
                updatedAt: NOW - 85 * MIN,
            }),
        });
        expect(evaluateProviderQuotaGate(node, 'kimi', null, NOW)?.reason)
            .toBe(PROVIDER_QUOTA_WEEKLY_LOW_SKIP_REASON);
    });

    it('fails OPEN on a stale exhausted retained window after its own reset has passed', () => {
        const node = nodeWithQuota({
            kimi: retainedQuota({
                weekly: { usedPercent: 100, windowMinutes: 10080, resetsAt: NOW - MIN },
                updatedAt: NOW - 85 * MIN,
            }),
        });
        expect(evaluateProviderQuotaGate(node, 'kimi', null, NOW)).toBeNull();
    });

    it('keeps a stale retained window with sufficient headroom gate-clear before reset', () => {
        const node = nodeWithQuota({
            kimi: retainedQuota({
                weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: NOW + 2 * 24 * 60 * MIN },
                updatedAt: NOW - 85 * MIN,
            }),
        });
        expect(evaluateProviderQuotaGate(node, 'kimi', { weeklyMinRemainingPercent: 80 }, NOW)).toBeNull();
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

    // ★INVERTED 2026-08-28 (owner-ratified) — this test previously asserted
    // ['claude-cli', 'kimi'] under risk = remaining × ELAPSED-fraction, whose
    // premise was "a large remainder right after a reset scores ~0, so size
    // alone must not win". That premise IS the CLIFF the rebalance removes:
    // deferring a big remainder because its reset is far away is exactly what
    // strands it unspent (a 7d window clears ~14 points/day at even pace, so
    // 99% is already behind schedule the moment the window opens, while the
    // 20% one can lose at most 20 points). The size-alone concern it was
    // guarding is now carried by the DIVERGENCE GUARD test below, which pins
    // the bound that actually matters: a tiny remainder at the reset edge
    // still cannot beat a substantial one.
    it('a large remainder with a distant reset is spent EARLY — over-supply outranks a small imminent loss', () => {
        const node = nodeWithQuota({
            // 99% left with 7 full days to go (just reset) → risk ~49.3.
            // Over-supplied: it cannot be burned at even pace, so spread it in now.
            kimi: okQuota({ provider: 'kimi', weekly: weeklyWindow(1, NOW + 7 * DAY) }),
            // 20% left evaporating in 2h → risk ~18.9. A certain but SMALL loss.
            'claude-cli': okQuota({ weekly: weeklyWindow(80, NOW + 2 * 60 * MIN) }),
        });
        const ranked = rankProvidersByQuotaGate(node, ['kimi', 'claude-cli'], null, NOW);
        expect(ranked.clear).toEqual(['kimi', 'claude-cli']);
        // Pin the direction explicitly: risk must be driven by time REMAINING,
        // so the just-reset candidate carries real (not ~0) risk.
        const kimiRisk = ranked.rankingEvidence.find(e => e.providerType === 'kimi')?.risk ?? 0;
        expect(kimiRisk).toBeGreaterThan(40);
    });

    // ★UNCHANGED ASSERTION, and that is the point: this is the guard that keeps
    // the rebalanced formula from becoming plain remaining/timeLeft ("required
    // burn rate"), which diverges as timeLeft → 0. The saturating form keeps
    // risk ≤ remaining identically, so the bound survives the 2026-08-28
    // rebalance untouched — only the losing candidate's score moved.
    it('DIVERGENCE GUARD: a tiny remainder at the reset edge must NOT beat a 90% remainder', () => {
        const node = nodeWithQuota({
            // 16% is the smallest remainder that passes the weekly gate (15%
            // threshold) — even 1 minute from its reset it caps at risk ~16
            // (risk ≤ remaining by construction)...
            kimi: okQuota({ provider: 'kimi', weekly: weeklyWindow(84, NOW + MIN) }),
            // ...while 90% with 4 of 7 days left scores ~55.1.
            'claude-cli': okQuota({ weekly: weeklyWindow(10, NOW + 4 * DAY) }),
        });
        const ranked = rankProvidersByQuotaGate(node, ['kimi', 'claude-cli'], null, NOW);
        expect(ranked.clear).toEqual(['claude-cli', 'kimi']);
        // The bound itself, not just the resulting order: no candidate's risk
        // may exceed its own remaining, at any distance from the reset.
        for (const e of ranked.rankingEvidence) {
            expect(e.risk!).toBeLessThanOrEqual(e.remainingPercent! + 1e-9);
        }
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

    // ★NARROWED 2026-08-20. This still pins unknown-last, but the meaning of
    // "unknown" is now strictly NO READABLE WINDOW — never measured, or a
    // reading with no such window. A snapshot that is merely no longer current
    // but still CARRIES numbers is a RETAINED reading and competes on the
    // ranking axis at full weight; see the retained-reading tests below. Both
    // candidates here are genuinely unreadable, which is why the assertion is
    // unchanged.
    it('sorts candidates with NO READABLE weekly window below every readable one, caller order among themselves', () => {
        const node = nodeWithQuota({
            // measured: only 20% weekly remaining — still outranks the unreadable.
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
            'claude-cli': exhausted({ updatedAt: NOW - STALE_AGE }), // stale exhaustion fails open
            // codex: no entry at all
        });
        const ranked = rankProvidersByQuotaGate(node, ['kimi', 'claude-cli', 'codex'], null, NOW);
        expect(ranked.gated).toEqual([]);
        expect(ranked.clear).toEqual(['kimi', 'claude-cli', 'codex']); // all unknown-weekly, caller order
    });

    it('exposes the dedicated all-gated skip reason constant (non-actionable WAIT)', () => {
        expect(ALL_PROVIDERS_QUOTA_GATED_SKIP_REASON).toBe('all_providers_quota_gated');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // BALANCE REGRESSION (2026-08-28). Pins the two biases the risk rebalance
    // removed. Injection check for red/green: restore the old formula in
    // expiryRiskScore —
    //     return remainingPercent * (1 - timeLeftFraction);
    // — and every test in this block fails.
    // ═══════════════════════════════════════════════════════════════════════
    describe('expiry-risk balance — starvation and cliff', () => {
        // The exact fleet reading the owner reported: codex holding the LARGEST
        // remainder with the FARTHEST reset took zero dispatches all day, while
        // claude — already the most consumed — kept winning and drained first.
        // Old formula: codex 5.66 < kimi 21.43 < claude 22.14 (codex LAST).
        // New formula: codex 27.67 > kimi 23.33 > claude 16.13 (codex FIRST).
        const measuredFleet = () => nodeWithQuota({
            codex: okQuota({ provider: 'codex', weekly: weeklyWindow(34, NOW + 6.4 * DAY) }),   // 66% left, 6.4d
            'claude-cli': okQuota({ weekly: weeklyWindow(69, NOW + 2 * DAY) }),                 // 31% left, 2d
            kimi: okQuota({ provider: 'kimi', weekly: weeklyWindow(50, NOW + 4 * DAY) }),       // 50% left, 4d
        });

        it('STARVATION: a far-reset provider holding the largest remainder is no longer ranked last', () => {
            const ranked = rankProvidersByQuotaGate(
                measuredFleet(), ['kimi', 'claude-cli', 'codex'], null, NOW);
            expect(ranked.gated).toEqual([]);
            // codex must LEAD, not trail: it is the most over-supplied relative
            // to the time it has left to burn it.
            expect(ranked.clear).toEqual(['codex', 'kimi', 'claude-cli']);
        });

        it('STARVATION: ranking is monotone in over-supply, so no candidate is structurally unreachable', () => {
            const ranked = rankProvidersByQuotaGate(
                measuredFleet(), ['kimi', 'claude-cli', 'codex'], null, NOW);
            const risk = Object.fromEntries(
                ranked.rankingEvidence.map(e => [e.providerType, e.risk!]));
            // The measured spread must stay well-separated — a near-tie would
            // let caller order silently decide and reintroduce the starvation.
            expect(risk.codex).toBeGreaterThan(risk.kimi);
            expect(risk.kimi).toBeGreaterThan(risk['claude-cli']);
            expect(risk.codex).toBeCloseTo(27.67, 1);
            expect(risk.kimi).toBeCloseTo(23.33, 1);
            expect(risk['claude-cli']).toBeCloseTo(16.13, 1);
        });

        it('CLIFF: a big remainder outranks a small one EARLY, before its window runs out', () => {
            // Same provider, same 80% remainder, two points in its window.
            // Under the old formula the early reading scored ~11 (deferred) and
            // only spiked near the reset — by which point it could not be burnt.
            const early = rankProvidersByQuotaGate(nodeWithQuota({
                codex: okQuota({ provider: 'codex', weekly: weeklyWindow(20, NOW + 6 * DAY) }),  // 80%, 6d left
                'claude-cli': okQuota({ weekly: weeklyWindow(60, NOW + 6 * DAY) }),              // 40%, 6d left
            }), ['claude-cli', 'codex'], null, NOW);
            expect(early.clear).toEqual(['codex', 'claude-cli']);
        });

        it('CLIFF: risk RISES as the reset approaches — same remainder, later in the window', () => {
            const riskAt = (daysLeft: number) => {
                const node = nodeWithQuota({
                    // session: null keeps this measuring the WEEKLY axis. With a
                    // readable session window the 2′ conditional gate would
                    // switch axes here (80% weekly clears the 40% headroom
                    // threshold) and the evidence would report the session risk.
                    codex: okQuota({
                        provider: 'codex',
                        session: null,
                        weekly: weeklyWindow(20, NOW + daysLeft * DAY),
                    }),
                });
                const ranked = rankProvidersByQuotaGate(node, ['codex'], null, NOW);
                expect(ranked.rankingEvidence[0].axis).toBe('weekly');
                return ranked.rankingEvidence[0].risk!;
            };
            const far = riskAt(6);
            const mid = riskAt(3);
            const near = riskAt(0.5);
            // Monotone urgency, but bounded: never above the 80% remainder.
            expect(far).toBeLessThan(mid);
            expect(mid).toBeLessThan(near);
            expect(near).toBeLessThanOrEqual(80);
            // ★And the far reading is NOT ~0 — that collapse is what starved
            // codex. A distant reset on a large remainder is evidence of
            // over-supply, not of safety.
            expect(far).toBeGreaterThan(20);
        });

        it('preserves the even-spend axis: at an equal reset the larger remainder still wins', () => {
            const sameReset = NOW + 5 * DAY;
            const ranked = rankProvidersByQuotaGate(nodeWithQuota({
                kimi: okQuota({ provider: 'kimi', weekly: weeklyWindow(80, sameReset) }),        // 20%
                'claude-cli': okQuota({ weekly: weeklyWindow(40, sameReset) }),                  // 60%
            }), ['kimi', 'claude-cli'], null, NOW);
            expect(ranked.clear).toEqual(['claude-cli', 'kimi']);
        });
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

    it('★expired session windows are unreadable and fall back to weekly instead of ranking as maximum risk', () => {
        const node = nodeWithQuota({
            kimi: okQuota({
                provider: 'kimi',
                // Before the fix both past windows clamped elapsedFraction to
                // 1, so kimi's 90% dead-window remainder incorrectly won.
                session: sessionWindow(10, NOW - MIN),
                weekly: weeklyWindow(59, NOW + 5 * DAY),          // 41% left
            }),
            'claude-cli': okQuota({
                session: sessionWindow(80, NOW - MIN),
                weekly: weeklyWindow(40, NOW + 5 * DAY),          // 60% left → weekly winner
            }),
        });
        const ranked = rankProvidersByQuotaGate(node, ['kimi', 'claude-cli'], null, NOW);
        expect(ranked.sessionAxisActive).toBe(true);
        expect(ranked.clear).toEqual(['claude-cli', 'kimi']);
        expect(ranked.rankingEvidence).toEqual([
            expect.objectContaining({ providerType: 'claude-cli', axis: 'weekly' }),
            expect.objectContaining({ providerType: 'kimi', axis: 'weekly' }),
        ]);
    });

    // ★REPLACED 2026-08-20 (was: 'session reading STALE: the whole snapshot
    // fails open to the weekly order'). The old test asserted
    // ['claude-cli', 'kimi'] on the premise "kimi's snapshot is stale →
    // weekly-unknown → sorts LAST" — i.e. it pinned the unconditional
    // unknown-last PARTITION, which is the defect being fixed (see the
    // RETAINED READINGS section of rankProvidersByQuotaGate).
    //
    // What survives unchanged is the part that was actually about the SESSION
    // AXIS. What changes in the 2026-08-28 owner decision is that a retained
    // reading competes at exactly the same weight as a fresh reading until its
    // resetsAt boundary passes.
    //
    // The inputs below are the old test's verbatim, and the expected order
    // flips, for a reason worth stating: kimi's session window resets in 20
    // MINUTES holding 70% unused (risk 65.3) while claude-cli's resets in
    // 4.5 hours (risk 7.0). The old partition was suppressing a genuinely urgent
    // expiry signal purely because the reading was 45 minutes old — spending
    // kimi first here is the correct answer on the axis this module exists to
    // implement.
    it('session reading AGED: it ranks at full weight, and a truly imminent expiry wins', () => {
        const agedSession = okQuota({
            session: sessionWindow(30, NOW + 20 * MIN),            // 70% left, resets in 20m
            weekly: weeklyWindow(40, NOW + 5 * DAY),
            updatedAt: NOW - STALE_AGE,                             // past staleAfterMs → RETAINED, not current
        });
        const node = nodeWithQuota({
            kimi: agedSession,
            'claude-cli': okQuota({
                session: sessionWindow(30, NOW + 270 * MIN),       // 70% left, resets in 4.5h
                weekly: weeklyWindow(40, NOW + 5 * DAY),
            }),
        });
        expect(rankProvidersByQuotaGate(node, ['kimi', 'claude-cli'], null, NOW).clear)
            .toEqual(['kimi', 'claude-cli']);
    });

    it('a stale reading ties a fresh reading with identical values — caller order decides', () => {
        // Identical windows on both candidates make risk tie exactly. Age must
        // add no hidden tie-break: the stable sort preserves the stale
        // candidate's input position.
        const node = nodeWithQuota({
            kimi: okQuota({
                provider: 'kimi',
                session: null,
                weekly: weeklyWindow(40, NOW + 5 * DAY),
                updatedAt: NOW - STALE_AGE,                         // RETAINED (aged)
            }),
            'claude-cli': okQuota({
                session: null,
                weekly: weeklyWindow(40, NOW + 5 * DAY),           // CURRENT, same numbers
            }),
        });
        expect(rankProvidersByQuotaGate(node, ['kimi', 'claude-cli'], null, NOW).clear)
            .toEqual(['kimi', 'claude-cli']);
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
        // Still an exhaustive toEqual — the ranking evidence is part of the
        // return now, and with nothing measured every entry must be BARE:
        // an axis label and no numbers. An evidence block carrying invented
        // risk here would be exactly the "assumed full" failure the
        // module header bans, so it is asserted, not loosened away.
        expect(rankProvidersByQuotaGate(nodeWithQuota(undefined), ['kimi', 'claude-cli', 'codex'], null, NOW))
            .toEqual({
                clear: ['kimi', 'claude-cli', 'codex'],
                gated: [],
                sessionAxisActive: false,
                rankingEvidence: [
                    { providerType: 'kimi', axis: 'weekly' },
                    { providerType: 'claude-cli', axis: 'weekly' },
                    { providerType: 'codex', axis: 'weekly' },
                ],
            });
    });
});

/**
 * ★REGRESSION SUITE for the 2026-08-20 fleet-wide stranding
 * (M-ROUTING-UNKNOWN-LAST-STRANDS-UNMEASURABLE-PROVIDER).
 *
 * Reproduces the observed node exactly: three `difficult` slots, no
 * requiredTags, where only grok carries a current reading. Under the old
 * unconditional unknown-last partition grok was `clear[0]` DETERMINISTICALLY —
 * not merely likely — so claude and kimi could never be selected on this node,
 * and the same shape held on every node in the fleet (MoltBook, Jupiter,
 * MainPC, and this Mac all reported claude stale).
 *
 * For claude the partition additionally closed a self-reinforcing loop: its
 * quota only refreshes while a Claude Code session is open, so "never
 * selected" and "never measured" caused each other.
 */
describe('rankProvidersByQuotaGate — retained readings compete (2026-08-20 stranding regression)', () => {
    const DAY = 24 * 60 * MIN;
    const weeklyWindow = (usedPercent: number, resetsAt: number | null) =>
        ({ usedPercent, windowMinutes: 10080, resetsAt });

    /** claude-cli's STRUCTURAL shape: real windows, `status:'error'` with
     *  failureKind 'no-data' — the statusline bridge holding a reading that is
     *  no longer current. This is what the live fetcher emits
     *  (quota/fetchers/claude.ts), not a shape invented for the test. */
    const claudeStructural = (weeklyUsed: number, resetsAt: number | null, ageMs = 90 * MIN) => okQuota({
        provider: 'claude-cli',
        status: 'error',
        session: null,
        weekly: weeklyWindow(weeklyUsed, resetsAt),
        updatedAt: NOW - ageMs,
        error: 'Claude quota reading is stale — open a Claude Code session to refresh',
        metadata: { source: 'statusline', failureKind: 'no-data' },
    });

    /** kimi's AGED shape: a transient carry-forward with proven last-good
     *  windows. Fetch failure does not invalidate those windows before reset. */
    const kimiAged = (weeklyUsed: number, resetsAt: number | null, ageMs = 90 * MIN) => okQuota({
        provider: 'kimi',
        status: 'error',
        session: null,
        weekly: weeklyWindow(weeklyUsed, resetsAt),
        updatedAt: NOW - ageMs,
        error: 'token expired',
        metadata: { source: 'oauth', failureKind: 'expired-token', lastGoodWindows: true },
    });

    it('★the observed case: a stale claude is SELECTABLE against a fresh grok', () => {
        // grok is fresh but only 34% weekly remaining and 6 days from its
        // reset → very little is about to evaporate (raw risk ~4.9).
        // claude retains 85% weekly with 1 day to go → risk ~72.9.
        const node = nodeWithQuota({
            'grok-cli': okQuota({ provider: 'grok-cli', session: null, weekly: weeklyWindow(66, NOW + 6 * DAY) }),
            'claude-cli': claudeStructural(15, NOW + DAY),
            kimi: kimiAged(50, NOW + 6 * DAY),
        });
        const ranked = rankProvidersByQuotaGate(node, ['grok-cli', 'claude-cli', 'kimi'], null, NOW);
        // The load-bearing assertion is that claude is no longer pinned last.
        expect(ranked.clear[0]).toBe('claude-cli');
        expect(ranked.gated).toEqual([]);
    });

    it('★the loop-breaking property: claude is reachable as clear[0], not merely present in clear', () => {
        // Under the OLD partition claude was always in `clear` too — that was
        // the argument for why unknown-last "strands nobody". But the caller
        // takes clear[0], so presence was never sufficient. This pins the
        // distinction that actually matters.
        const node = nodeWithQuota({
            'grok-cli': okQuota({ provider: 'grok-cli', session: null, weekly: weeklyWindow(66, NOW + 6 * DAY) }),
            'claude-cli': claudeStructural(15, NOW + DAY),
        });
        expect(rankProvidersByQuotaGate(node, ['grok-cli', 'claude-cli'], null, NOW).clear[0])
            .toBe('claude-cli');
    });

    it('structural and transient stale readings tie at identical measured values', () => {
        // Same windows, same age, same risk. failureKind must not affect
        // ranking; the stable sort keeps the caller order.
        const node = nodeWithQuota({
            kimi: kimiAged(20, NOW + DAY),
            'claude-cli': claudeStructural(20, NOW + DAY),
        });
        expect(rankProvidersByQuotaGate(node, ['kimi', 'claude-cli'], null, NOW).clear)
            .toEqual(['kimi', 'claude-cli']);
    });

    it('failureKind does not change the rank of an otherwise identical reading', () => {
        const structural = nodeWithQuota({
            kimi: okQuota({
                provider: 'kimi', status: 'error', session: null,
                weekly: weeklyWindow(20, NOW + DAY), updatedAt: NOW - 90 * MIN,
                error: 'no reading', metadata: { source: 'oauth', failureKind: 'no-data' },
            }),
            'claude-cli': claudeStructural(20, NOW + DAY),
        });
        // Both STRUCTURAL now → exact tie on every axis → caller order holds.
        expect(rankProvidersByQuotaGate(structural, ['kimi', 'claude-cli'], null, NOW).clear)
            .toEqual(['kimi', 'claude-cli']);
        // Flip ONLY kimi's failureKind to a transient one: order is unchanged.
        const aged = nodeWithQuota({
            kimi: kimiAged(20, NOW + DAY),
            'claude-cli': claudeStructural(20, NOW + DAY),
        });
        expect(rankProvidersByQuotaGate(aged, ['kimi', 'claude-cli'], null, NOW).clear)
            .toEqual(['kimi', 'claude-cli']);
    });

    it('a retained reading ranks identically to a fresh reading with equal values', () => {
        const node = nodeWithQuota({
            'claude-cli': claudeStructural(40, NOW + 5 * DAY),
            'grok-cli': okQuota({ provider: 'grok-cli', session: null, weekly: weeklyWindow(40, NOW + 5 * DAY) }),
        });
        expect(rankProvidersByQuotaGate(node, ['claude-cli', 'grok-cli'], null, NOW).clear)
            .toEqual(['claude-cli', 'grok-cli']);
    });

    it('★145-minute-stale last-good windows beat a fresh reading when measured risk is higher', () => {
        const node = nodeWithQuota({
            codex: okQuota({
                provider: 'codex', status: 'error', session: null,
                weekly: weeklyWindow(20, NOW + 5 * DAY), // 80% left, risk ~22.9
                updatedAt: NOW - 145 * MIN,
                error: 'token expired',
                metadata: { source: 'oauth', failureKind: 'expired-token', lastGoodWindows: true },
            }),
            'claude-cli': okQuota({
                session: null,
                weekly: weeklyWindow(80, NOW + MIN), // 20% left, risk ~20
            }),
        });
        const ranked = rankProvidersByQuotaGate(node, ['claude-cli', 'codex'], null, NOW);
        expect(ranked.clear).toEqual(['codex', 'claude-cli']);
        expect(ranked.rankingEvidence[0]).toMatchObject({
            providerType: 'codex',
            axis: 'weekly',
            remainingPercent: 80,
        });
        expect(ranked.rankingEvidence[0].risk!).toBeGreaterThan(ranked.rankingEvidence[1].risk!);
        expect(ranked.rankingEvidence[0]).not.toHaveProperty('confidence');
        expect(ranked.rankingEvidence[0]).not.toHaveProperty('rankedRisk');
    });

    it('a reading whose resetsAt passed is unknown and sorts below a live reading', () => {
        const node = nodeWithQuota({
            codex: okQuota({
                provider: 'codex', session: null,
                weekly: weeklyWindow(0, NOW - MIN),
                updatedAt: NOW - 145 * MIN,
            }),
            'claude-cli': okQuota({
                session: null,
                weekly: weeklyWindow(80, NOW + MIN),
            }),
        });
        const ranked = rankProvidersByQuotaGate(node, ['codex', 'claude-cli'], null, NOW);
        expect(ranked.clear).toEqual(['claude-cli', 'codex']);
        expect(ranked.rankingEvidence[1]).toEqual({ providerType: 'codex', axis: 'weekly' });
    });

    it('★REVERSE DIRECTION: a genuinely exhausted provider is still GATED, never merely out-ranked', () => {
        // The fix must not turn a measured "cannot run" into a soft
        // preference. A fresh quota-exhausted grok stays out of `clear`
        // entirely, and claude wins by GATING, not by ranking.
        const node = nodeWithQuota({
            'grok-cli': okQuota({
                provider: 'grok-cli', status: 'error', session: null, weekly: null,
                error: 'usage limit reached (HTTP 403)',
                metadata: { source: 'oauth', failureKind: 'quota-exhausted' },
            }),
            'claude-cli': claudeStructural(15, NOW + DAY),
        });
        const ranked = rankProvidersByQuotaGate(node, ['grok-cli', 'claude-cli'], null, NOW);
        expect(ranked.clear).toEqual(['claude-cli']);
        expect(ranked.gated.map(g => g.providerType)).toEqual(['grok-cli']);
        expect(ranked.gated[0].block.reason).toBe(PROVIDER_QUOTA_EXHAUSTED_SKIP_REASON);
    });

    it('★REVERSE DIRECTION: a retained reading BELOW threshold is still gated by its own windows', () => {
        // Retained windows marked lastGoodWindows and not yet reset remain
        // authoritative for GATING (evaluateProviderQuotaGate) — ranking
        // changes did not soften that path.
        const node = nodeWithQuota({
            kimi: okQuota({
                provider: 'kimi', status: 'error', session: null,
                weekly: weeklyWindow(95, NOW + DAY),           // 5% left < 15% threshold
                updatedAt: NOW - 90 * MIN,
                error: 'token expired',
                metadata: { source: 'oauth', failureKind: 'expired-token', lastGoodWindows: true },
            }),
        });
        const ranked = rankProvidersByQuotaGate(node, ['kimi'], null, NOW);
        expect(ranked.clear).toEqual([]);
        expect(ranked.gated[0].block.reason).toBe(PROVIDER_QUOTA_WEEKLY_LOW_SKIP_REASON);
    });

    it('a provider with NO reading at all is still last — ranking needs a real measurement', () => {
        const node = nodeWithQuota({
            'claude-cli': claudeStructural(90, NOW + 6 * DAY),  // retained, tiny risk
            // codex: no entry at all
        });
        expect(rankProvidersByQuotaGate(node, ['codex', 'claude-cli'], null, NOW).clear)
            .toEqual(['claude-cli', 'codex']);
    });

    it('★the TAG WORKAROUND still works: a single narrowed candidate wins regardless of ranking', () => {
        // Until this fix landed, `required_tags:["provider=claude-cli"]` was the
        // only way to reach claude at all, and that escape hatch must keep
        // working. requiredTags narrowing happens in resolveUsableProvider
        // BEFORE the candidate list reaches this function, so the tagged case
        // arrives here as a one-element list — ranking cannot reorder it, and
        // the retained reading must not gate it either.
        const node = nodeWithQuota({
            'grok-cli': okQuota({ provider: 'grok-cli', session: null, weekly: weeklyWindow(1, NOW + DAY) }),
            'claude-cli': claudeStructural(15, NOW + DAY),
        });
        const ranked = rankProvidersByQuotaGate(node, ['claude-cli'], null, NOW);
        expect(ranked.clear).toEqual(['claude-cli']);
        expect(ranked.gated).toEqual([]);
    });

    it('the spread bonus follows window provenance — unmarked retained shapes score 0, marked ones score by headroom', () => {
        // claudeStructural models the PRE-2026-08-24 claude fetcher shape:
        // retained windows WITHOUT the lastGoodWindows provenance mark. That
        // shape keeps scoring 0 (windows of unproven provenance stay inert)…
        const unmarked = nodeWithQuota({ 'claude-cli': claudeStructural(15, NOW + DAY) });
        expect(quotaSpreadBonusByProvider(unmarked, null, NOW)['claude-cli']).toBe(0);
        // …while the CURRENT fetcher shape (same reading, lastGoodWindows
        // marked) expresses the preference until the window resets — the
        // owner's 2026-08-24 window-boundary-validity decision.
        const markedEntry = claudeStructural(15, NOW + DAY);
        markedEntry.metadata = { ...markedEntry.metadata, lastGoodWindows: true };
        const marked = nodeWithQuota({ 'claude-cli': markedEntry });
        expect(quotaSpreadBonusByProvider(marked, null, NOW)['claude-cli']).toBe(26); // 30 * 0.85
    });

    describe('quotaRiskSnapshotForCandidates — the reading is self-describing', () => {
        it('reports a retained reading with the risk compared by the sort', () => {
            const node = nodeWithQuota({ 'claude-cli': claudeStructural(20, NOW + DAY) });
            const [snapshot] = quotaRiskSnapshotForCandidates(node, ['claude-cli'], null, NOW);
            expect(snapshot.providerType).toBe('claude-cli');
            expect(snapshot.axis).toBe('weekly');
            expect(snapshot.remainingPercent).toBe(80);
            expect(snapshot.risk).toBeGreaterThan(0);
            expect(snapshot).not.toHaveProperty('confidence');
            expect(snapshot).not.toHaveProperty('rankedRisk');
        });

        it('uses the same diagnostic shape for a fresh reading', () => {
            const node = nodeWithQuota({
                'grok-cli': okQuota({ provider: 'grok-cli', session: null, weekly: weeklyWindow(40, NOW + DAY) }),
            });
            const [snapshot] = quotaRiskSnapshotForCandidates(node, ['grok-cli'], null, NOW);
            expect(snapshot.risk).toBeGreaterThan(0);
            expect(snapshot).not.toHaveProperty('confidence');
            expect(snapshot).not.toHaveProperty('rankedRisk');
        });

        it('reports the actual session axis used by the ranking', () => {
            const node = nodeWithQuota({
                kimi: okQuota({
                    provider: 'kimi',
                    session: { usedPercent: 30, windowMinutes: 300, resetsAt: NOW + 20 * MIN },
                    weekly: weeklyWindow(40, NOW + 5 * DAY),
                }),
            });
            const [snapshot] = quotaRiskSnapshotForCandidates(node, ['kimi'], null, NOW);
            expect(snapshot).toEqual(expect.objectContaining({
                providerType: 'kimi',
                axis: 'session',
                risk: expect.any(Number),
            }));
        });

        it('does not expose stale-age trust tiers', () => {
            const node = nodeWithQuota({
                'claude-cli': claudeStructural(20, NOW + DAY),
                kimi: kimiAged(20, NOW + DAY),
            });
            const byProvider = new Map(
                quotaRiskSnapshotForCandidates(node, ['claude-cli', 'kimi'], null, NOW)
                    .map(s => [s.providerType, s]),
            );
            expect(byProvider.get('claude-cli')?.risk).toBeCloseTo(byProvider.get('kimi')!.risk!, 10);
            expect(byProvider.get('claude-cli')?.remainingPercent).toBe(byProvider.get('kimi')?.remainingPercent);
            expect(byProvider.get('claude-cli')).not.toHaveProperty('confidence');
            expect(byProvider.get('kimi')).not.toHaveProperty('rankedRisk');
        });
    });
});

describe('buildQuotaRankingRationale — the selection-rationale summary', () => {
    it('keeps the winner and every loser when within the bound', () => {
        const rationale = buildQuotaRankingRationale(
            { providerType: 'claude-cli', model: 'opus', fitnessScore: 101 },
            [
                { providerType: 'grok-cli', fitnessScore: 112, reason: 'lower_quota_rank' },
                { providerType: 'kimi', fitnessScore: 101, reason: 'lower_quota_rank' },
            ],
        );
        expect(rationale.winner).toEqual({ providerType: 'claude-cli', model: 'opus', fitnessScore: 101 });
        expect(rationale.losers).toHaveLength(2);
        expect(rationale).not.toHaveProperty('losersOmitted');
    });

    it('bounds the loser list and reports what it dropped', () => {
        const losers = Array.from({ length: 7 }, (_, i) => ({
            providerType: `p${i}`, fitnessScore: 10 - i, reason: 'lower_slot_order',
        }));
        const rationale = buildQuotaRankingRationale({ providerType: 'w', fitnessScore: 50 }, losers);
        expect(rationale.losers.map(l => l.providerType)).toEqual(['p0', 'p1', 'p2', 'p3']);
        expect(rationale.losersOmitted).toBe(3);
    });

    it('a lone winner produces an empty loser list, not a missing field', () => {
        const rationale = buildQuotaRankingRationale({ providerType: 'solo', fitnessScore: 1 }, []);
        expect(rationale.losers).toEqual([]);
        expect(rationale).not.toHaveProperty('losersOmitted');
    });
});

describe('quotaSpreadBonusByProvider — bounded headroom preference', () => {
    it('inherits spread bonuses from a facts-less worktree clone source', () => {
        const source = {
            ...nodeWithQuota({
                'claude-cli': okQuota({
                    session: { usedPercent: 50, windowMinutes: 300, resetsAt: null },
                    weekly: { usedPercent: 50, windowMinutes: 10080, resetsAt: null },
                }),
            }),
            id: 'base-node',
        };
        const clone = { id: 'worktree-node', clonedFromNodeId: source.id };

        expect(quotaSpreadBonusByProvider(clone, null, NOW, { nodes: [source, clone] }))
            .toEqual({ 'claude-cli': 15 });
    });

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

    it('yields 0 for boundary-expired, failed, or absent readings — identical to pre-feature scoring', () => {
        // okQuota's default windows carry NO resetsAt, so an aged reading has
        // nothing bounding its validity and falls back to the wall-clock
        // staleAfterMs check (2026-08-24: the fallback, no longer the rule).
        const unstampedStale = nodeWithQuota({ 'claude-cli': okQuota({ updatedAt: NOW - STALE_AGE }) }, NOW);
        expect(quotaSpreadBonusByProvider(unstampedStale, null, NOW)['claude-cli']).toBe(0);
        const errored = nodeWithQuota({ 'claude-cli': okQuota({ status: 'unavailable', session: null, weekly: null }) });
        expect(quotaSpreadBonusByProvider(errored, null, NOW)['claude-cli']).toBe(0);
        expect(quotaSpreadBonusByProvider(nodeWithQuota(undefined), null, NOW)).toEqual({});
        expect(quotaSpreadBonusByProvider({ id: 'bare' }, null, NOW)).toEqual({});
    });

    it('a wall-clock-stale reading whose windows have NOT reset keeps its bonus (2026-08-24 window-boundary validity)', () => {
        const node = nodeWithQuota({
            'claude-cli': okQuota({
                session: { usedPercent: 50, windowMinutes: 300, resetsAt: NOW + 60 * MIN },
                weekly: { usedPercent: 50, windowMinutes: 10080, resetsAt: NOW + 24 * 60 * MIN },
                updatedAt: NOW - STALE_AGE,
            }),
        }, NOW);
        expect(quotaSpreadBonusByProvider(node, null, NOW)['claude-cli']).toBe(15);
    });

    it('only the window past its OWN reset drops out — the surviving window still expresses the preference', () => {
        const node = nodeWithQuota({
            'claude-cli': okQuota({
                // Session reset already passed → its 90%-used reading is a dead
                // window's and must not drag the bonus down…
                session: { usedPercent: 90, windowMinutes: 300, resetsAt: NOW - 10 * MIN },
                // …while the weekly window is still running and governs alone.
                weekly: { usedPercent: 50, windowMinutes: 10080, resetsAt: NOW + 24 * 60 * MIN },
                updatedAt: NOW - STALE_AGE,
            }),
        }, NOW);
        expect(quotaSpreadBonusByProvider(node, null, NOW)['claude-cli']).toBe(15);
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
