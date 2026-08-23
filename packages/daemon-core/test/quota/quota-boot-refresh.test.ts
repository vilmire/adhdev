import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Same module-level fetcher mocking as test/mesh/node-facts-quota.test.ts and
// test/commands/status-meta-quota.test.ts: mock the fetcher MODULES so call
// counts and timing are real assertions, not guesses from a fast test.
const fetchClaudeQuota = vi.fn()
const fetchCodexQuota = vi.fn()
const fetchKimiQuota = vi.fn()
const fetchOpencodeUsage = vi.fn()
const fetchAntigravityQuota = vi.fn()
const fetchGrokQuota = vi.fn()

vi.mock('../../src/quota/fetchers/antigravity.js', () => ({ fetchAntigravityQuota }))
vi.mock('../../src/quota/fetchers/claude.js', () => ({ fetchClaudeQuota, STALE_AFTER_MS: 60_000 }))
vi.mock('../../src/quota/fetchers/codex.js', () => ({ fetchCodexQuota }))
vi.mock('../../src/quota/fetchers/grok.js', () => ({ fetchGrokQuota }))
vi.mock('../../src/quota/fetchers/kimi.js', () => ({ fetchKimiQuota }))
vi.mock('../../src/quota/fetchers/opencode.js', () => ({ fetchOpencodeUsage, OPENCODE_USAGE_DAYS: 7 }))

const {
    refreshQuotaCacheOnBoot,
    readQuotaCache,
    clearQuotaCache,
    __resetQuotaBootRefreshForTests,
} = await import('../../src/quota/refresh.js')

const okQuota = (provider: string) => ({
    provider,
    session: { usedPercent: 10, windowMinutes: 300, resetsAt: null },
    weekly: { usedPercent: 5, windowMinutes: 10080, resetsAt: null },
    updatedAt: 1_700_000,
    error: null,
    status: 'ok',
    metadata: {},
})

/** Never resolves until the test calls `resolve()` — lets us observe the
 *  moment refreshQuotaCacheOnBoot() RETURNS relative to the fetch settling. */
function deferred<T>() {
    let resolve!: (v: T) => void
    const promise = new Promise<T>(r => { resolve = r })
    return { promise, resolve }
}

function mockAllProvidersOk() {
    fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'))
    fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'))
    fetchKimiQuota.mockResolvedValue(okQuota('kimi'))
    fetchGrokQuota.mockResolvedValue(okQuota('grok-cli'))
    fetchAntigravityQuota.mockResolvedValue(okQuota('antigravity-cli'))
    fetchOpencodeUsage.mockResolvedValue(okQuota('opencode'))
}

function mockAllProvidersDeferred(gate: { promise: Promise<void> }) {
    fetchClaudeQuota.mockReturnValue(gate.promise.then(() => okQuota('claude-cli')))
    fetchCodexQuota.mockReturnValue(gate.promise.then(() => okQuota('codex-cli')))
    fetchKimiQuota.mockReturnValue(gate.promise.then(() => okQuota('kimi')))
    fetchGrokQuota.mockReturnValue(gate.promise.then(() => okQuota('grok-cli')))
    fetchAntigravityQuota.mockReturnValue(gate.promise.then(() => okQuota('antigravity-cli')))
    fetchOpencodeUsage.mockReturnValue(gate.promise.then(() => okQuota('opencode')))
}

afterEach(() => {
    clearQuotaCache()
    __resetQuotaBootRefreshForTests()
    vi.clearAllMocks()
})

describe('refreshQuotaCacheOnBoot — non-blocking contract', () => {
    it('returns synchronously before the fetch settles (does not block the caller)', async () => {
        const gate = deferred<void>()
        mockAllProvidersDeferred(gate)

        // Call it exactly the way daemon-lifecycle.ts does: no await, no .then.
        const returnValue = refreshQuotaCacheOnBoot()
        expect(returnValue).toBeUndefined() // synchronous void — nothing to await even if the caller wanted to

        // The fetch is still pending — the cache must not be populated yet,
        // proving the call above did not wait for it.
        expect(readQuotaCache()).toBeUndefined()

        gate.resolve()
        await vi.waitFor(() => expect(readQuotaCache()).toBeDefined())
    })

    it('populates the cache once the deferred fetch resolves', async () => {
        mockAllProvidersOk()

        refreshQuotaCacheOnBoot()
        await vi.waitFor(() => {
            const quota = readQuotaCache()
            expect(quota).toBeDefined()
            expect(Object.keys(quota ?? {}).sort()).toEqual(['antigravity-cli', 'claude-cli', 'codex-cli', 'grok-cli', 'kimi', 'opencode'])
        })
    })

    it('bypasses the idle gate — fetches even with zero session activity to observe', async () => {
        // refreshQuotaCacheOnBoot takes no session/activity argument at all: there
        // is no hasRecentCliActivity call in its path, so it cannot be idle-gated
        // by construction. This is the regression test for that shape.
        mockAllProvidersOk()

        refreshQuotaCacheOnBoot()
        await vi.waitFor(() => expect(readQuotaCache()).toBeDefined())
        expect(fetchCodexQuota).toHaveBeenCalledTimes(1)
        expect(fetchGrokQuota).toHaveBeenCalledTimes(1)
    })

    it('is idempotent: a second call before the first resolves does not double-fetch', async () => {
        const gate = deferred<void>()
        mockAllProvidersDeferred(gate)

        refreshQuotaCacheOnBoot()
        refreshQuotaCacheOnBoot() // reentrant call while the first is still in flight
        gate.resolve()
        await vi.waitFor(() => expect(readQuotaCache()).toBeDefined())

        expect(fetchCodexQuota).toHaveBeenCalledTimes(1)
    })

    it('is idempotent: a call after the cache is already populated does not re-fetch', async () => {
        mockAllProvidersOk()

        refreshQuotaCacheOnBoot()
        await vi.waitFor(() => expect(readQuotaCache()).toBeDefined())
        vi.clearAllMocks()

        refreshQuotaCacheOnBoot()
        expect(fetchCodexQuota).not.toHaveBeenCalled()
        expect(fetchClaudeQuota).not.toHaveBeenCalled()
        expect(fetchKimiQuota).not.toHaveBeenCalled()
        expect(fetchGrokQuota).not.toHaveBeenCalled()
    })

    it('a fetch failure is caught and recorded, never thrown back at the caller', async () => {
        mockAllProvidersOk()
        fetchClaudeQuota.mockRejectedValue(new Error('boom'))

        expect(() => refreshQuotaCacheOnBoot()).not.toThrow()
        await vi.waitFor(() => {
            const quota = readQuotaCache()
            expect(quota?.['claude-cli']?.status).toBe('error')
            expect(quota?.['codex-cli']?.status).toBe('ok')
        })
    })
})

describe('daemon-lifecycle wiring — boot refresh is fired-and-forgotten, never awaited', () => {
    it('calls refreshQuotaCacheOnBoot via setImmediate, with no await anywhere on it', () => {
        const source = readFileSync(
            join(process.cwd(), 'src/boot/daemon-lifecycle.ts'),
            'utf-8',
        )
        // The call site itself must not await the boot refresh — a ~900ms codex
        // spawn must never add to daemon startup latency (module contract in
        // quota/refresh.ts). setImmediate additionally defers it past
        // initDaemonComponents' own synchronous return.
        // Both the disk hydration and the boot refresh run inside one deferred
        // callback; neither is awaited. Both receive the machine-enable
        // predicate derived from components.providerLoader — the single
        // authority for "this machine runs this provider".
        expect(source).toMatch(/setImmediate\(\(\) => \{[\s\S]{0,600}refreshQuotaCacheOnBoot\(isQuotaProviderEnabled\);[\s\S]{0,40}\}\);/)
        expect(source).not.toMatch(/await\s+refreshQuotaCacheOnBoot/)
        expect(source).not.toMatch(/await\s+hydrateQuotaCacheFromDisk/)
        // The predicate comes from the provider loader, once, via the shared
        // adapter — not re-derived per call site.
        expect(source).toMatch(/const isQuotaProviderEnabled = quotaProviderEnabledFromLoader\(components\.providerLoader\);/)
        // Hydration runs FIRST so a restart shows its last numbers immediately,
        // and it is wrapped so an unusable cache file cannot break startup.
        expect(source).toMatch(/hydrateQuotaCacheFromDisk\(process\.env, isQuotaProviderEnabled\)[\s\S]{0,200}refreshQuotaCacheOnBoot\(isQuotaProviderEnabled\)/)
        expect(source).toMatch(/try \{ hydrateQuotaCacheFromDisk\(process\.env, isQuotaProviderEnabled\); \} catch/)

        // It must run after setupQuotaRefreshLoop (the periodic loop) is already
        // wired, and setupQuotaRefreshLoop's own first tick fires only after
        // QUOTA_REFRESH_INTERVAL_MS (15 min) — so the two can never race within a
        // single boot: the loop's timer cannot fire before this call has long
        // since started (and, for a healthy fetch, finished).
        const loopIdx = source.indexOf('components.quotaRefreshLoop = setupQuotaRefreshLoop(components);')
        const bootIdx = source.indexOf('refreshQuotaCacheOnBoot(isQuotaProviderEnabled);')
        expect(loopIdx).toBeGreaterThan(-1)
        expect(bootIdx).toBeGreaterThan(loopIdx)
    })
})
