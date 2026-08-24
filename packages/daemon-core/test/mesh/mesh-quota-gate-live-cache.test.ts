/**
 * LIVE LOCAL READ — the 2026-08-18 copy-lag fix, pinned at the routing layer.
 *
 * The defect: the quota gate read the nodeFacts quota COPY, which is restamped
 * only on git_status ingest. The refresh timer kept the live cache current,
 * but the gate never looked at it — the owner watched the dashboard (live
 * cache) show claude weekly 9% used while routing still saw the boot-time
 * copy, and 165 minutes later the stale copy failed OPEN, routing tasks onto
 * a weekly-100% codex. The fix: callers on the quota-owning daemon inject the
 * live cache (QuotaFactsContext.liveLocalQuota, built by
 * liveLocalQuotaForRouting) and local nodes route on it; remote nodes keep
 * reading their reported nodeFacts (their only source — no network call).
 *
 * Reverting the live branch of quotaEntryFor (or the builder) makes the
 * "live local read" cases below fail while the fail-open cases keep passing —
 * that asymmetry is the point: the fix changes WHERE local readings come
 * from, never the fail-open contract.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

// Fetchers are mocked at the MODULE level so the builder test can prove the
// routing path never triggers a fetch: any fetch would show up as a call
// count, not as a slow test (same precedent as node-facts-quota.test.ts).
const fetchClaudeQuota = vi.fn()
const fetchCodexQuota = vi.fn()
const fetchCursorQuota = vi.fn()
const fetchGrokQuota = vi.fn()
const fetchKimiQuota = vi.fn()
const fetchOpencodeUsage = vi.fn()
const fetchAntigravityQuota = vi.fn()

vi.mock('../../src/quota/fetchers/antigravity.js', () => ({ fetchAntigravityQuota }))
vi.mock('../../src/quota/fetchers/claude.js', () => ({ fetchClaudeQuota, STALE_AFTER_MS: 60_000 }))
vi.mock('../../src/quota/fetchers/codex.js', () => ({ fetchCodexQuota }))
vi.mock('../../src/quota/fetchers/cursor.js', () => ({ fetchCursorQuota }))
vi.mock('../../src/quota/fetchers/grok.js', () => ({ fetchGrokQuota }))
vi.mock('../../src/quota/fetchers/kimi.js', () => ({ fetchKimiQuota }))
vi.mock('../../src/quota/fetchers/opencode.js', () => ({ fetchOpencodeUsage, OPENCODE_USAGE_DAYS: 7 }))

const {
    evaluateProviderQuotaGate,
    rankProvidersByQuotaGate,
    liveLocalQuotaForRouting,
} = await import('../../src/mesh/mesh-quota-routing.js')
const { clearQuotaCache, refreshQuotaCacheOnce } = await import('../../src/quota/refresh.js')

const MINUTE = 60_000
const NOW = 1_800_000_000_000

/** The production thresholds, made explicit so a default change cannot
 *  silently rewrite what this suite pins. */
const POLICY = { sessionMinRemainingPercent: 10, weeklyMinRemainingPercent: 15 }

const okEntry = (provider: string, weeklyUsedPercent: number, updatedAt: number) => ({
    provider,
    status: 'ok',
    session: null,
    weekly: { usedPercent: weeklyUsedPercent, windowMinutes: 10080, resetsAt: NOW + 4000 * MINUTE },
    updatedAt,
    error: null,
    metadata: {},
})

/** A nodeFacts bundle carrying `entry` as its quota copy, stamped `ageMinutes`
 *  old — the pre-fix gate input. */
function nodeWithFactsCopy(provider: string, entry: any, ageMinutes: number) {
    const stampedAt = NOW - ageMinutes * MINUTE
    return {
        id: 'node_local',
        nodeFacts: {
            reportedAt: stampedAt,
            quota: { [provider]: { ...entry, updatedAt: stampedAt } },
        },
    }
}

/** Direct live-source injection (what quotaRoutingFactsContext builds in
 *  production via liveLocalQuotaForRouting). */
const liveContext = (entries: Record<string, any>, isLocalNode: (node: any) => boolean, nodes?: any[]) => ({
    nodes,
    liveLocalQuota: { entries, isLocalNode },
})

afterEach(() => {
    clearQuotaCache()
    vi.clearAllMocks()
})

describe('live local read — the gate routes on the refreshed cache, not the copy', () => {
    it('blocks on the refreshed cache value while the nodeFacts copy is stale by AGE (the owner-observed 165-minute case)', () => {
        // The copy says 91% weekly LEFT (would pass) and is 165 minutes old
        // (stale → the pre-fix gate failed open and routed onto the dying
        // provider). The live cache was refreshed 5 minutes ago: 9% left.
        const node = nodeWithFactsCopy('claude-cli', okEntry('claude-cli', 9, 0), 165)
        const context = liveContext(
            { 'claude-cli': okEntry('claude-cli', 91, NOW - 5 * MINUTE) },
            () => true,
            [node],
        )
        const block = evaluateProviderQuotaGate(node, 'claude-cli', POLICY, NOW, context)
        expect(block).toMatchObject({
            reason: 'provider_quota_weekly_low',
            window: 'weekly',
            remainingPercent: 9,
            thresholdPercent: 15,
        })
        // And the pre-fix input really was inert: the same node WITHOUT the
        // injection fails open on the stale copy (documents what changed).
        expect(evaluateProviderQuotaGate(node, 'claude-cli', POLICY, NOW, { nodes: [node] })).toBeNull()
    })

    it('clears on the refreshed cache value while the nodeFacts copy still shows exhaustion (the reverse direction)', () => {
        // Fresh-looking copy carrying a quota-exhausted error — the pre-fix
        // gate hard-blocks on it even though the account has since recovered.
        const exhaustedCopy = {
            provider: 'claude-cli',
            status: 'error',
            session: null,
            weekly: null,
            updatedAt: NOW - 2 * MINUTE,
            error: 'usage limit reached',
            metadata: { failureKind: 'quota-exhausted' },
        }
        const node = nodeWithFactsCopy('claude-cli', exhaustedCopy, 2)
        const context = liveContext(
            { 'claude-cli': okEntry('claude-cli', 50, NOW - 2 * MINUTE) },
            () => true,
            [node],
        )
        expect(evaluateProviderQuotaGate(node, 'claude-cli', POLICY, NOW, context)).toBeNull()
        // Without the injection the stale copy hard-blocks — the old behaviour.
        expect(evaluateProviderQuotaGate(node, 'claude-cli', POLICY, NOW, { nodes: [node] }))
            .toMatchObject({ reason: 'provider_quota_exhausted' })
    })

    it('ranks by the live values, so a provider that recovered in the cache wins over the copy', () => {
        const node = nodeWithFactsCopy('claude-cli', okEntry('claude-cli', 95, 0), 2)
        node.nodeFacts.quota['codex-cli'] = okEntry('codex-cli', 10, NOW - 2 * MINUTE)
        const context = liveContext(
            {
                // Cache says the OPPOSITE of the copy: claude recovered to
                // 90% left, codex is down to 5% left (gated).
                'claude-cli': okEntry('claude-cli', 10, NOW - 2 * MINUTE),
                'codex-cli': okEntry('codex-cli', 95, NOW - 2 * MINUTE),
            },
            () => true,
            [node],
        )
        const ranked = rankProvidersByQuotaGate(node, ['codex-cli', 'claude-cli'], POLICY, NOW, context)
        expect(ranked.gated.map(g => g.providerType)).toEqual(['codex-cli'])
        expect(ranked.clear).toEqual(['claude-cli'])
    })

    it('a worktree clone routes on the live cache of its LOCAL clone source', () => {
        const source: any = { id: 'node_source' } // local, no usable facts of its own
        const clone: any = { id: 'node_clone', clonedFromNodeId: 'node_source' }
        const context = liveContext(
            { 'claude-cli': okEntry('claude-cli', 91, NOW - 5 * MINUTE) },
            candidate => candidate === source,
            [source, clone],
        )
        expect(evaluateProviderQuotaGate(clone, 'claude-cli', POLICY, NOW, context))
            .toMatchObject({ reason: 'provider_quota_weekly_low', remainingPercent: 9 })
    })

    // Regression #5 (pinned from the 2026-08-18 concurrent measurement): the
    // worktree nodes carried NO nodeFacts at all, so quotaEntryFor fell back
    // to the clone source — inheriting the source's BOOT-STUCK copy (codex 7d
    // 82% at 03:39 while the live cache already read 100%). The clone must
    // route on the live cache, not on the source's stuck copy.
    it('a fact-less worktree clone sees the live cache, NOT the stuck copy of its local clone source', () => {
        // The source's nodeFacts copy: codex 82% used (18% left → would PASS),
        // frozen 7 hours ago — the meshes.json pin-down.
        const source = nodeWithFactsCopy('codex-cli', okEntry('codex-cli', 82, 0), 430)
        source.id = 'node_source'
        const clone: any = { id: 'node_clone', clonedFromNodeId: 'node_source' } // ABSENT nodeFacts
        const context = liveContext(
            // Live cache, refreshed minutes ago: codex 100% used → exhausted.
            {
                'codex-cli': {
                    provider: 'codex-cli',
                    status: 'error',
                    session: null,
                    weekly: null,
                    updatedAt: NOW - 3 * MINUTE,
                    error: 'usage limit reached',
                    metadata: { failureKind: 'quota-exhausted' },
                },
            },
            candidate => candidate === source || candidate === clone,
            [source, clone],
        )
        expect(evaluateProviderQuotaGate(clone, 'codex-cli', POLICY, NOW, context))
            .toMatchObject({ reason: 'provider_quota_exhausted' })
        // The pre-fix fallback really did inherit the stuck copy: without the
        // injection the clone reads the source's 7-hour-old bundle, which is
        // stale by AGE and fails open — the exact silent pass the owner hit.
        expect(evaluateProviderQuotaGate(clone, 'codex-cli', POLICY, NOW, { nodes: [source, clone] })).toBeNull()
    })
})

describe('remote preservation — remote nodes keep reading nodeFacts', () => {
    it('never routes a remote node on the injected live cache', () => {
        // Remote nodeFacts, fresh and comfortable (95% weekly left). The live
        // cache — which belongs to THIS daemon, not to the remote node — says
        // 9% left and would block if it were (wrongly) consulted.
        const node = nodeWithFactsCopy('claude-cli', okEntry('claude-cli', 5, 0), 2)
        const isLocalNode = vi.fn(() => false)
        const context = liveContext(
            { 'claude-cli': okEntry('claude-cli', 91, NOW - 2 * MINUTE) },
            isLocalNode,
            [node],
        )
        expect(evaluateProviderQuotaGate(node, 'claude-cli', POLICY, NOW, context)).toBeNull()
        expect(isLocalNode).toHaveBeenCalled()
        const ranked = rankProvidersByQuotaGate(node, ['claude-cli'], POLICY, NOW, context)
        expect(ranked.clear).toEqual(['claude-cli'])
        expect(ranked.gated).toEqual([])
    })

    it('a remote node with no usable facts fails open even when the live cache would block', () => {
        const node: any = { id: 'node_remote' } // no nodeFacts at all
        const context = liveContext(
            { 'claude-cli': okEntry('claude-cli', 91, NOW - 2 * MINUTE) },
            () => false,
            [node],
        )
        expect(evaluateProviderQuotaGate(node, 'claude-cli', POLICY, NOW, context)).toBeNull()
    })
})

describe('fail-open preservation — the fix changes the SOURCE, never the contract', () => {
    it('a live cache entry that is itself STALE still fails open', () => {
        const node: any = { id: 'node_local' }
        const context = liveContext(
            { 'claude-cli': okEntry('claude-cli', 91, NOW - 120 * MINUTE) },
            () => true,
            [node],
        )
        expect(evaluateProviderQuotaGate(node, 'claude-cli', POLICY, NOW, context)).toBeNull()
    })

    it('a FRESH quota-exhausted reading in the live cache still hard-blocks', () => {
        const node: any = { id: 'node_local' }
        const context = liveContext(
            {
                'claude-cli': {
                    provider: 'claude-cli',
                    status: 'error',
                    session: null,
                    weekly: null,
                    updatedAt: NOW - MINUTE,
                    error: 'usage limit reached',
                    metadata: { failureKind: 'quota-exhausted' },
                },
            },
            () => true,
            [node],
        )
        expect(evaluateProviderQuotaGate(node, 'claude-cli', POLICY, NOW, context))
            .toMatchObject({ reason: 'provider_quota_exhausted', window: 'unknown' })
    })

    it('a provider absent from the live cache (opted out / never measured) falls through to nodeFacts and fails open', () => {
        const node: any = { id: 'node_local' } // no nodeFacts quota either
        const context = liveContext(
            { 'claude-cli': okEntry('claude-cli', 91, NOW - 2 * MINUTE) },
            () => true,
            [node],
        )
        expect(evaluateProviderQuotaGate(node, 'kimi', POLICY, NOW, context)).toBeNull()
    })
})

describe('fresh worktree — no facts anywhere stays gate-inert (pre-existing behaviour)', () => {
    it('returns null with no nodeFacts and no injection', () => {
        const node: any = { id: 'node_fresh' }
        expect(evaluateProviderQuotaGate(node, 'claude-cli', POLICY, NOW)).toBeNull()
        expect(evaluateProviderQuotaGate(node, 'claude-cli', POLICY, NOW, { nodes: [node] })).toBeNull()
    })

    it('returns null with an injected cache that has never measured the provider', () => {
        const node: any = { id: 'node_fresh' }
        const context = liveContext({}, () => true, [node])
        expect(evaluateProviderQuotaGate(node, 'claude-cli', POLICY, NOW, context)).toBeNull()
    })
})

describe('liveLocalQuotaForRouting — the builder the callers inject', () => {
    it('returns null while nothing has been measured, so callers behave exactly as before', () => {
        clearQuotaCache()
        expect(liveLocalQuotaForRouting(() => true)).toBeNull()
    })

    it('reads the primed cache, routes a local node on it, and NEVER triggers a fetch', async () => {
        fetchClaudeQuota.mockResolvedValue(okEntry('claude-cli', 91, NOW - 5 * MINUTE))
        fetchCodexQuota.mockResolvedValue(okEntry('codex-cli', 10, NOW - 5 * MINUTE))
        fetchGrokQuota.mockResolvedValue(okEntry('grok-cli', 10, NOW - 5 * MINUTE))
        fetchKimiQuota.mockResolvedValue(okEntry('kimi', 10, NOW - 5 * MINUTE))
        await refreshQuotaCacheOnce()
        const fetchCallsAfterPrime = [
            fetchClaudeQuota, fetchCodexQuota, fetchGrokQuota,
            fetchKimiQuota, fetchOpencodeUsage, fetchAntigravityQuota,
        ].map(f => f.mock.calls.length)

        const node: any = { id: 'node_local' } // no nodeFacts: ONLY the live cache can gate
        const live = liveLocalQuotaForRouting(() => true)
        expect(live).not.toBeNull()
        const context = { nodes: [node], liveLocalQuota: live }
        expect(evaluateProviderQuotaGate(node, 'claude-cli', POLICY, NOW, context))
            .toMatchObject({ reason: 'provider_quota_weekly_low', remainingPercent: 9 })
        expect(evaluateProviderQuotaGate(node, 'codex-cli', POLICY, NOW, context)).toBeNull()

        // The purity contract: routing READ the cache; it did not fetch.
        const fetchCallsAfterRouting = [
            fetchClaudeQuota, fetchCodexQuota, fetchGrokQuota,
            fetchKimiQuota, fetchOpencodeUsage, fetchAntigravityQuota,
        ].map(f => f.mock.calls.length)
        expect(fetchCallsAfterRouting).toEqual(fetchCallsAfterPrime)
    })

    it('memoizes the locality verdict per node object', async () => {
        fetchClaudeQuota.mockResolvedValue(okEntry('claude-cli', 10, NOW - 5 * MINUTE))
        await refreshQuotaCacheOnce()
        const oracle = vi.fn(() => true)
        const live = liveLocalQuotaForRouting(oracle)!
        const node: any = { id: 'node_local' }
        expect(live.isLocalNode(node)).toBe(true)
        expect(live.isLocalNode(node)).toBe(true)
        expect(oracle).toHaveBeenCalledTimes(1)
    })
})
