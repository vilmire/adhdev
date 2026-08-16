import { afterEach, describe, expect, it, vi } from 'vitest'

// The quota fetchers are mocked at the MODULE level so this suite can assert the
// single most important contract of the feature: buildLocalNodeFacts must never
// call one. Mocking the modules (not just the cache) is what makes that
// assertion meaningful — a builder that reached for a fetcher would show up as a
// call count, not as a slow test.
const fetchClaudeQuota = vi.fn()
const fetchCodexQuota = vi.fn()
const fetchGrokQuota = vi.fn()
const fetchKimiQuota = vi.fn()
const fetchOpencodeUsage = vi.fn()
const fetchAntigravityQuota = vi.fn()

vi.mock('../../src/quota/fetchers/antigravity.js', () => ({ fetchAntigravityQuota }))
vi.mock('../../src/quota/fetchers/claude.js', () => ({ fetchClaudeQuota, STALE_AFTER_MS: 60_000 }))
vi.mock('../../src/quota/fetchers/codex.js', () => ({ fetchCodexQuota }))
vi.mock('../../src/quota/fetchers/grok.js', () => ({ fetchGrokQuota }))
vi.mock('../../src/quota/fetchers/kimi.js', () => ({ fetchKimiQuota }))
vi.mock('../../src/quota/fetchers/opencode.js', () => ({ fetchOpencodeUsage, OPENCODE_USAGE_DAYS: 7 }))

const { buildLocalNodeFacts } = await import('../../src/mesh/node-facts.js')
const {
    clearQuotaCache,
    hasRecentCliActivity,
    refreshQuotaCacheOnce,
    startQuotaRefreshLoop,
    QUOTA_REFRESH_INTERVAL_MS,
} = await import('../../src/quota/refresh.js')

const okQuota = (provider: string) => ({
    provider,
    session: { usedPercent: 38.2, windowMinutes: 300, resetsAt: 1_800_000 },
    weekly: { usedPercent: 12, windowMinutes: 10080, resetsAt: null },
    updatedAt: 1_700_000,
    error: null,
    status: 'ok',
    metadata: { source: 'test' },
})

afterEach(() => {
    clearQuotaCache()
    vi.clearAllMocks()
    vi.useRealTimers()
})

describe('buildLocalNodeFacts — quota', () => {
    // ★THE performance contract. buildLocalNodeFacts runs inside every
    // git_status, and mesh_status probes git_status on every node on every call.
    // The codex fetcher spawns a `codex app-server` child (~900ms), so a builder
    // that fetched would make every mesh_status pay that per node. Reverting the
    // cache-read to a fetch call makes this fail on the call counts.
    it('never invokes a quota fetcher (cache read only)', async () => {
        // Prime the cache through the legitimate path so there IS something to
        // read — otherwise a builder that fetched could hide behind an empty map.
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'))
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'))
        fetchGrokQuota.mockResolvedValue(okQuota('grok-cli'))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))
        await refreshQuotaCacheOnce()
        vi.clearAllMocks()

        for (let i = 0; i < 5; i += 1) buildLocalNodeFacts()

        expect(fetchClaudeQuota).not.toHaveBeenCalled()
        expect(fetchCodexQuota).not.toHaveBeenCalled()
        expect(fetchKimiQuota).not.toHaveBeenCalled()
    })

    it('is synchronous and cheap — returns a plain bundle, never a promise', () => {
        const facts = buildLocalNodeFacts()
        expect(facts).not.toBeInstanceOf(Promise)
        expect(facts.schemaVersion).toBe(1)
    })

    it('omits quota entirely until the refresh loop has cached something', () => {
        // "Never reported" must be distinguishable from "reported a failure", so
        // an un-primed builder emits no key at all rather than an empty object.
        const facts = buildLocalNodeFacts()
        expect(facts.quota).toBeUndefined()
        expect('quota' in facts).toBe(false)
    })

    it('carries cached snapshots into the bundle', async () => {
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'))
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'))
        fetchGrokQuota.mockResolvedValue(okQuota('grok-cli'))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))
        await refreshQuotaCacheOnce()

        const facts = buildLocalNodeFacts()
        expect(Object.keys(facts.quota ?? {}).sort()).toEqual(['antigravity-cli', 'claude-cli', 'codex-cli', 'grok-cli', 'kimi', 'opencode'])
        expect(facts.quota?.['codex-cli'].status).toBe('ok')
        expect(facts.quota?.['codex-cli'].session?.usedPercent).toBeCloseTo(38.2)
    })

    // Today 2 of 3 providers fail on a typical machine. A failure that vanished
    // from the bundle would be indistinguishable from a node that never
    // reported — the diagnosis "not installed" vs "channel broken" lives here.
    it('reports failures explicitly rather than dropping the provider', async () => {
        fetchClaudeQuota.mockResolvedValue({
            provider: 'claude-cli',
            session: null,
            weekly: null,
            updatedAt: 1_700_000,
            error: 'statusline wrapper is not installed',
            status: 'unavailable',
            metadata: { failureKind: 'missing-credentials' },
        })
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'))
        fetchGrokQuota.mockResolvedValue(okQuota('grok-cli'))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))
        await refreshQuotaCacheOnce()

        const claude = buildLocalNodeFacts().quota?.['claude-cli']
        expect(claude).toBeDefined()
        expect(claude?.status).toBe('unavailable')
        expect(claude?.metadata?.failureKind).toBe('missing-credentials')
    })

    it('records a definite failure when a fetcher breaks its never-throw contract', async () => {
        fetchClaudeQuota.mockRejectedValue(new Error('boom'))
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'))
        fetchGrokQuota.mockResolvedValue(okQuota('grok-cli'))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))
        await refreshQuotaCacheOnce()

        const quota = buildLocalNodeFacts().quota
        // The thrower is recorded as an error, and — critically — does not
        // starve the providers that answered.
        expect(quota?.['claude-cli'].status).toBe('error')
        expect(quota?.['codex-cli'].status).toBe('ok')
        expect(quota?.['kimi'].status).toBe('ok')
    })

    it('does NOT add a ttl/expiry field — age is derived from reportedAt', async () => {
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'))
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'))
        fetchGrokQuota.mockResolvedValue(okQuota('grok-cli'))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))
        await refreshQuotaCacheOnce()

        const facts = buildLocalNodeFacts()
        expect(facts.reportedAt).toBeGreaterThan(0)
        expect((facts as Record<string, unknown>).quotaTtl).toBeUndefined()
        expect(facts.quota?.['kimi'].updatedAt).toBe(1_700_000)
    })
})

describe('hasRecentCliActivity — the idle-skip gate', () => {
    const now = 10_000_000

    it('treats a working session as active', () => {
        for (const status of ['generating', 'waiting_approval', 'waiting_choice', 'starting']) {
            expect(hasRecentCliActivity([{ status, lastMessageAt: 0 }], now)).toBe(true)
        }
    })

    it('treats a recently-messaged idle session as active', () => {
        expect(hasRecentCliActivity([{ status: 'idle', lastMessageAt: now - 60_000 }], now)).toBe(true)
    })

    it('treats a long-quiet machine as idle', () => {
        expect(hasRecentCliActivity([{ status: 'idle', lastMessageAt: now - 60 * 60_000 }], now)).toBe(false)
        expect(hasRecentCliActivity([], now)).toBe(false)
    })

    it('ignores unusable activity timestamps instead of counting them as fresh', () => {
        expect(hasRecentCliActivity([{ status: 'idle', lastMessageAt: undefined }], now)).toBe(false)
        expect(hasRecentCliActivity([{ status: 'idle', lastMessageAt: 'nonsense' }], now)).toBe(false)
    })
})

describe('startQuotaRefreshLoop', () => {
    it('skips the fetch entirely while the machine is idle', () => {
        vi.useFakeTimers()
        const handle = startQuotaRefreshLoop({ hasRecentCliActivity: () => false, intervalMs: 1000 })
        vi.advanceTimersByTime(10_000)
        handle.stop()

        expect(fetchCodexQuota).not.toHaveBeenCalled()
        expect(fetchClaudeQuota).not.toHaveBeenCalled()
        expect(fetchKimiQuota).not.toHaveBeenCalled()
    })

    it('fetches on a tick once the machine is active', async () => {
        vi.useFakeTimers()
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'))
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'))
        fetchGrokQuota.mockResolvedValue(okQuota('grok-cli'))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))

        const handle = startQuotaRefreshLoop({ hasRecentCliActivity: () => true, intervalMs: 1000 })
        await vi.advanceTimersByTimeAsync(1000)
        handle.stop()

        expect(fetchCodexQuota).toHaveBeenCalledTimes(1)
    })

    it('does not fetch at boot — the first tick is one interval away', () => {
        vi.useFakeTimers()
        const handle = startQuotaRefreshLoop({ hasRecentCliActivity: () => true, intervalMs: 1000 })
        expect(fetchCodexQuota).not.toHaveBeenCalled()
        handle.stop()
    })

    it('refreshes no more than once per interval, and the interval is >= 15 minutes', async () => {
        expect(QUOTA_REFRESH_INTERVAL_MS).toBeGreaterThanOrEqual(15 * 60 * 1000)

        vi.useFakeTimers()
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'))
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'))
        fetchGrokQuota.mockResolvedValue(okQuota('grok-cli'))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))
        const handle = startQuotaRefreshLoop({ hasRecentCliActivity: () => true, intervalMs: 1000 })
        await vi.advanceTimersByTimeAsync(3000)
        handle.stop()

        expect(fetchCodexQuota).toHaveBeenCalledTimes(3)
    })

    it('stops fetching after stop()', async () => {
        vi.useFakeTimers()
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'))
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'))
        fetchGrokQuota.mockResolvedValue(okQuota('grok-cli'))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))
        const handle = startQuotaRefreshLoop({ hasRecentCliActivity: () => true, intervalMs: 1000 })
        await vi.advanceTimersByTimeAsync(1000)
        handle.stop()
        await vi.advanceTimersByTimeAsync(10_000)

        expect(fetchCodexQuota).toHaveBeenCalledTimes(1)
    })
})
