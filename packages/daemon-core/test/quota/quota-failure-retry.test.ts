import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same module-level fetcher mocking as quota-boot-refresh.test.ts /
// quota-enabled-gate.test.ts: the fetcher modules are mocked so call counts
// are real assertions about WHEN a provider was probed.
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

const {
    QUOTA_FAILURE_MAX_RETRIES,
    clearQuotaCache,
    hydrateQuotaCacheFromDisk,
    isFailureRetryDue,
    readQuotaCache,
    refreshQuotaCacheOnBoot,
    refreshQuotaCacheOnce,
    setupQuotaEventRefresh,
    startQuotaRefreshLoop,
    __resetQuotaBootRefreshForTests,
    __resetQuotaHydrationForTests,
} = await import('../../src/quota/refresh.js')
const {
    QUOTA_RATE_LIMIT_RETRY_DELAY_MS,
    QUOTA_TRANSIENT_RETRY_DELAY_MS,
    quotaFailure,
} = await import('../../src/quota/types.js')
const { saveQuotaCache } = await import('../../src/quota/persist.js')

// `updatedAt` must be NOW, not a fixed epoch constant — see the same note in
// quota-enabled-gate.test.ts: a stale-looking snapshot would trip the
// idle-gate staleness backfill and mask what these cases assert.
const okQuota = (provider: string) => ({
    provider,
    session: { usedPercent: 10, windowMinutes: 300, resetsAt: null },
    weekly: { usedPercent: 5, windowMinutes: 10080, resetsAt: null },
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    metadata: {},
})

const allEnabled = () => true

let home: string
let previousHome: string | undefined

beforeEach(() => {
    // refreshQuotaCacheOnce persists after every refresh — keep that off the
    // real $HOME.
    previousHome = process.env.ADHDEV_CONFIG_DIR
    home = mkdtempSync(join(tmpdir(), 'adhdev-quota-retry-'))
    process.env.ADHDEV_CONFIG_DIR = home
})

afterEach(() => {
    vi.useRealTimers()
    if (previousHome === undefined) delete process.env.ADHDEV_CONFIG_DIR
    else process.env.ADHDEV_CONFIG_DIR = previousHome
    rmSync(home, { recursive: true, force: true })
    clearQuotaCache()
    __resetQuotaBootRefreshForTests()
    __resetQuotaHydrationForTests()
    vi.clearAllMocks()
})

describe('refreshQuotaCacheOnce — last-good carry-forward (wiring)', () => {
    it('a transient kimi failure after a good reading keeps the numbers in the cache', async () => {
        const kimiFetch = { provider: 'kimi' as const, fetch: fetchKimiQuota };

        fetchKimiQuota.mockResolvedValueOnce(okQuota('kimi'));
        await refreshQuotaCacheOnce([kimiFetch], allEnabled);
        expect(readQuotaCache()?.kimi?.session?.usedPercent).toBe(10);

        // Token expired mid-cycle — transient, empty windows.
        fetchKimiQuota.mockResolvedValueOnce(
            quotaFailure('kimi', 'error', 'token expired', { failureKind: 'expired-token' }),
        );
        await refreshQuotaCacheOnce([kimiFetch], allEnabled);

        const after = readQuotaCache()?.kimi;
        // The dashboard still sees the numbers instead of a bald error.
        expect(after?.session?.usedPercent).toBe(10);
        expect(after?.status).toBe('error');
        expect(after?.metadata?.lastGoodWindows).toBe(true);
    });

    it('a NON-transient kimi failure clears the numbers (real problem, not a refresh race)', async () => {
        const kimiFetch = { provider: 'kimi' as const, fetch: fetchKimiQuota };
        fetchKimiQuota.mockResolvedValueOnce(okQuota('kimi'));
        await refreshQuotaCacheOnce([kimiFetch], allEnabled);

        fetchKimiQuota.mockResolvedValueOnce(
            quotaFailure('kimi', 'unavailable', 'not signed in', { failureKind: 'missing-credentials' }),
        );
        await refreshQuotaCacheOnce([kimiFetch], allEnabled);

        expect(readQuotaCache()?.kimi?.session).toBeNull();
    });

    it('a rate-limited 429 after a good reading keeps the numbers (transient, same as expired-token)', async () => {
        const agyFetch = { provider: 'antigravity-cli' as const, fetch: fetchAntigravityQuota };

        fetchAntigravityQuota.mockResolvedValueOnce(okQuota('antigravity-cli'));
        await refreshQuotaCacheOnce([agyFetch], allEnabled);
        expect(readQuotaCache()?.['antigravity-cli']?.session?.usedPercent).toBe(10);

        fetchAntigravityQuota.mockResolvedValueOnce(
            quotaFailure('antigravity-cli', 'error', 'Antigravity quota request was rate limited', {
                failureKind: 'rate-limited',
            }),
        );
        await refreshQuotaCacheOnce([agyFetch], allEnabled);

        const after = readQuotaCache()?.['antigravity-cli'];
        expect(after?.session?.usedPercent).toBe(10);
        expect(after?.status).toBe('error');
        expect(after?.metadata?.failureKind).toBe('rate-limited');
        expect(after?.metadata?.lastGoodWindows).toBe(true);
    });

    it('quota-exhausted after a good reading DROPS the numbers (hard block, not mixed with 429)', async () => {
        const kimiFetch = { provider: 'kimi' as const, fetch: fetchKimiQuota };
        fetchKimiQuota.mockResolvedValueOnce(okQuota('kimi'));
        await refreshQuotaCacheOnce([kimiFetch], allEnabled);

        fetchKimiQuota.mockResolvedValueOnce(
            quotaFailure('kimi', 'error', 'usage limit reached', { failureKind: 'quota-exhausted' }),
        );
        await refreshQuotaCacheOnce([kimiFetch], allEnabled);

        const after = readQuotaCache()?.kimi;
        expect(after?.session).toBeNull();
        expect(after?.weekly).toBeNull();
        expect(after?.metadata?.lastGoodWindows).toBeUndefined();
        expect(after?.metadata?.failureKind).toBe('quota-exhausted');
    });
});

describe('quotaFailure retry classification', () => {
    it('stamps token-race transient kinds with the short retryAtMs and leaves persistent kinds unstamped', () => {
        const before = Date.now()
        for (const failureKind of ['expired-token', 'unauthorized', 'network', 'server'] as const) {
            const failure = quotaFailure('kimi', 'error', 'x', { failureKind })
            expect(failure.metadata?.retryAtMs).toBeGreaterThanOrEqual(before + QUOTA_TRANSIENT_RETRY_DELAY_MS)
            expect(failure.metadata?.retryAtMs).toBeLessThan(before + QUOTA_RATE_LIMIT_RETRY_DELAY_MS)
        }
        for (const failureKind of ['missing-credentials', 'parse', 'cli-unavailable', 'unsupported', 'quota-exhausted', 'unknown'] as const) {
            const failure = quotaFailure('kimi', 'error', 'x', { failureKind })
            expect(failure.metadata?.retryAtMs).toBeUndefined()
        }
    })

    it('stamps rate-limited without Retry-After at the CLI-level 7-minute floor, not the 2-minute token-race fuse', () => {
        const before = Date.now()
        const failure = quotaFailure('antigravity-cli', 'error', 'rate limited', { failureKind: 'rate-limited' })
        expect(failure.metadata?.retryAtMs).toBeGreaterThanOrEqual(before + QUOTA_RATE_LIMIT_RETRY_DELAY_MS)
        expect(QUOTA_RATE_LIMIT_RETRY_DELAY_MS).toBe(7 * 60 * 1000)
        expect(QUOTA_RATE_LIMIT_RETRY_DELAY_MS).toBeGreaterThan(QUOTA_TRANSIENT_RETRY_DELAY_MS)
    })

    it('never overrides a server-dictated retryAtMs (HTTP Retry-After)', () => {
        const failure = quotaFailure('kimi', 'error', 'x', { failureKind: 'rate-limited', retryAtMs: 123_456 })
        expect(failure.metadata?.retryAtMs).toBe(123_456)
    })
})

describe('rate-limited cooldown — do not re-hit a 429 whose retryAtMs is in the future', () => {
    it('skips a second probe while the 429 cooldown is active and keeps last-good windows', async () => {
        const agyFetch = { provider: 'antigravity-cli' as const, fetch: fetchAntigravityQuota }

        fetchAntigravityQuota.mockResolvedValueOnce(okQuota('antigravity-cli'))
        await refreshQuotaCacheOnce([agyFetch], allEnabled)

        fetchAntigravityQuota.mockResolvedValueOnce(
            quotaFailure('antigravity-cli', 'error', 'rate limited', { failureKind: 'rate-limited' }),
        )
        await refreshQuotaCacheOnce([agyFetch], allEnabled)
        expect(fetchAntigravityQuota).toHaveBeenCalledTimes(2)
        expect(readQuotaCache()?.['antigravity-cli']?.metadata?.lastGoodWindows).toBe(true)

        // Cooldown is 7 minutes; a stacked refresh must not spend another call.
        await refreshQuotaCacheOnce([agyFetch], allEnabled)
        expect(fetchAntigravityQuota).toHaveBeenCalledTimes(2)
        expect(readQuotaCache()?.['antigravity-cli']?.session?.usedPercent).toBe(10)
    })

    it('event-driven refresh does not re-probe a cached rate-limited provider', async () => {
        const agyFetch = { provider: 'antigravity-cli' as const, fetch: fetchAntigravityQuota }
        fetchAntigravityQuota.mockResolvedValueOnce(
            quotaFailure('antigravity-cli', 'error', 'rate limited', { failureKind: 'rate-limited' }),
        )
        await refreshQuotaCacheOnce([agyFetch], allEnabled)
        expect(fetchAntigravityQuota).toHaveBeenCalledTimes(1)

        const listeners: Array<(event: any) => void> = []
        const handle = setupQuotaEventRefresh({
            instanceManager: { onEvent: (listener: (event: any) => void) => { listeners.push(listener) } },
        })
        for (const listener of listeners) {
            listener({ event: 'agent:generating_completed', providerType: 'antigravity-cli' })
        }
        await new Promise(r => setTimeout(r, 20))
        expect(fetchAntigravityQuota).toHaveBeenCalledTimes(1)
        handle.stop()
    })

    it('first scheduled retry after a 429 waits the 7-minute floor, not 2 minutes', async () => {
        vi.useFakeTimers()
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'))
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'))
        fetchGrokQuota.mockResolvedValue(okQuota('grok-cli'))
        fetchOpencodeUsage.mockResolvedValue(okQuota('opencode'))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))
        fetchAntigravityQuota.mockImplementation(() =>
            Promise.resolve(quotaFailure('antigravity-cli', 'error', 'rate limited', { failureKind: 'rate-limited' })),
        )

        await refreshQuotaCacheOnce()
        expect(fetchAntigravityQuota).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(2 * 60_000)
        expect(fetchAntigravityQuota).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(5 * 60_000) // 7 minutes total
        expect(fetchAntigravityQuota).toHaveBeenCalledTimes(2)
    })

    it('boot refresh skips a hydrated rate-limited snapshot (restart cannot lift a 429)', async () => {
        saveQuotaCache({
            'antigravity-cli': quotaFailure('antigravity-cli', 'error', 'rate limited', {
                failureKind: 'rate-limited',
            }) as any,
        }, { ADHDEV_CONFIG_DIR: home })
        hydrateQuotaCacheFromDisk({ ADHDEV_CONFIG_DIR: home }, allEnabled)
        expect(readQuotaCache()?.['antigravity-cli']?.metadata?.failureKind).toBe('rate-limited')

        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'))
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))
        fetchGrokQuota.mockResolvedValue(okQuota('grok-cli'))
        fetchOpencodeUsage.mockResolvedValue(okQuota('opencode'))
        fetchAntigravityQuota.mockResolvedValue(okQuota('antigravity-cli'))

        refreshQuotaCacheOnBoot(allEnabled)
        await vi.waitFor(() => expect(readQuotaCache()?.['claude-cli']?.status).toBe('ok'))

        expect(fetchAntigravityQuota).not.toHaveBeenCalled()
        expect(readQuotaCache()?.['antigravity-cli']?.status).toBe('error')
        expect(readQuotaCache()?.['antigravity-cli']?.metadata?.failureKind).toBe('rate-limited')
    })
})

describe('transient-failure retry — the 22-second token race', () => {
    it('retries an expired-token failure on a short fuse and converges to the fresh reading', async () => {
        vi.useFakeTimers()
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'))
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'))
        // t0: the daemon parses the credentials file in the seconds BEFORE the
        // kimi CLI renews the token → expired-token. ~22s later the CLI has
        // refreshed the file, so the next fetch succeeds. On main this failure
        // was cached identically to a success and the stale error rode out the
        // whole 15-minute tick.
        fetchKimiQuota
            .mockResolvedValueOnce(quotaFailure('kimi', 'error', 'Kimi access token expired', {
                source: 'oauth',
                failureKind: 'expired-token',
            }))
            .mockResolvedValue(okQuota('kimi'))

        await refreshQuotaCacheOnce()
        const cached = readQuotaCache()?.['kimi']
        expect(cached?.status).toBe('error')
        expect(cached?.metadata?.failureKind).toBe('expired-token')
        expect(typeof cached?.metadata?.retryAtMs).toBe('number')
        expect(fetchKimiQuota).toHaveBeenCalledTimes(1)

        // The race window itself (the CLI renewing the token ~22s later) must
        // NOT be the trigger — the retry fires on its own short fuse.
        await vi.advanceTimersByTimeAsync(22_000)
        expect(fetchKimiQuota).toHaveBeenCalledTimes(1)
        expect(readQuotaCache()?.['kimi']?.status).toBe('error')

        // The short-fuse retry fires and the cache converges to a success.
        await vi.advanceTimersByTimeAsync(QUOTA_TRANSIENT_RETRY_DELAY_MS)
        expect(fetchKimiQuota).toHaveBeenCalledTimes(2)
        const refreshed = readQuotaCache()?.['kimi']
        expect(refreshed?.status).toBe('ok')
        expect(refreshed?.error).toBeNull()

        // Success tears down the retry machinery — no third fetch, ever.
        await vi.advanceTimersByTimeAsync(60 * 60_000)
        expect(fetchKimiQuota).toHaveBeenCalledTimes(2)
    })

    it('gives a persistent failure (missing-credentials) no retryAtMs and no scheduled retry', async () => {
        vi.useFakeTimers()
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'))
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'))
        fetchKimiQuota.mockResolvedValue(quotaFailure('kimi', 'unavailable', 'Not signed in to Kimi Code', {
            source: 'oauth',
            failureKind: 'missing-credentials',
        }))

        await refreshQuotaCacheOnce()
        const cached = readQuotaCache()?.['kimi']
        expect(cached?.status).toBe('unavailable')
        expect(cached?.metadata?.retryAtMs).toBeUndefined()
        expect(fetchKimiQuota).toHaveBeenCalledTimes(1)

        // Retrying cannot conjure a login — the failure waits for the normal
        // cadence, never the short fuse.
        await vi.advanceTimersByTimeAsync(60 * 60_000)
        expect(fetchKimiQuota).toHaveBeenCalledTimes(1)
    })

    it('backs off exponentially and stops after QUOTA_FAILURE_MAX_RETRIES consecutive failures', async () => {
        vi.useFakeTimers()
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'))
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'))
        fetchKimiQuota.mockResolvedValue(quotaFailure('kimi', 'error', 'boom', { failureKind: 'network' }))

        await refreshQuotaCacheOnce() // failure #1 → retry in 2m
        expect(fetchKimiQuota).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(2 * 60_000) // retry #1 → failure #2 → next in 4m
        expect(fetchKimiQuota).toHaveBeenCalledTimes(2)
        await vi.advanceTimersByTimeAsync(4 * 60_000) // retry #2 → failure #3 → next in 8m
        expect(fetchKimiQuota).toHaveBeenCalledTimes(3)
        await vi.advanceTimersByTimeAsync(8 * 60_000) // retry #3 → failure #4 → next in 15m (capped)
        expect(fetchKimiQuota).toHaveBeenCalledTimes(4)
        await vi.advanceTimersByTimeAsync(15 * 60_000) // retry #4 → failure #5 → budget exhausted
        expect(fetchKimiQuota).toHaveBeenCalledTimes(5)

        // Hard stop: 1 initial + QUOTA_FAILURE_MAX_RETRIES retries, then the
        // provider is back on the normal cadence — no infinite loop.
        expect(QUOTA_FAILURE_MAX_RETRIES).toBe(4)
        await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
        expect(fetchKimiQuota).toHaveBeenCalledTimes(5)
        // ...and the exhausted budget is invisible to the backfill gate, so an
        // idle machine does not get re-probed every tick either.
        expect(isFailureRetryDue('kimi')).toBe(false)
    })
})

describe('needsBackfill — a cached failure is not a usable snapshot', () => {
    it('backfills an idle machine when a transient failure\'s retry time has passed', async () => {
        // Seed through the disk path so the cache holds a transient failure
        // whose retry time has ALREADY passed without any retry state (the
        // process-slept-through-its-timer case). Hydration sets no retry
        // state, which isolates the needsBackfill gate from the scheduled
        // retry path.
        saveQuotaCache({
            'claude-cli': okQuota('claude-cli') as any,
            'codex-cli': okQuota('codex-cli') as any,
            kimi: {
                ...quotaFailure('kimi', 'error', 'Kimi access token expired', { failureKind: 'expired-token' }),
                metadata: { failureKind: 'expired-token', retryAtMs: Date.now() - 1000 },
            } as any,
        }, { ADHDEV_CONFIG_DIR: home })
        hydrateQuotaCacheFromDisk({ ADHDEV_CONFIG_DIR: home }, allEnabled)
        expect(isFailureRetryDue('kimi')).toBe(true)

        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'))
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))

        const loop = startQuotaRefreshLoop({
            hasRecentCliActivity: () => false, // the machine stays idle
            intervalMs: 5,
            isEnabled: allEnabled,
        })
        try {
            // On main, cache.has('kimi') counted the failure as a snapshot and
            // an idle machine was never re-probed. Now the due failure counts
            // as "no usable snapshot" and the tick recovers it.
            await vi.waitFor(() => expect(fetchKimiQuota).toHaveBeenCalled())
            await vi.waitFor(() => expect(readQuotaCache()?.['kimi']?.status).toBe('ok'))
        } finally {
            loop.stop()
        }
    })

    it('still leaves an idle machine alone when the cached failure is persistent', async () => {
        saveQuotaCache({
            'claude-cli': okQuota('claude-cli') as any,
            'codex-cli': okQuota('codex-cli') as any,
            'grok-cli': okQuota('grok-cli') as any,
            'antigravity-cli': okQuota('antigravity-cli') as any,
            opencode: okQuota('opencode') as any,
            kimi: quotaFailure('kimi', 'unavailable', 'Not signed in to Kimi Code', {
                failureKind: 'missing-credentials',
            }) as any,
        }, { ADHDEV_CONFIG_DIR: home })
        hydrateQuotaCacheFromDisk({ ADHDEV_CONFIG_DIR: home }, allEnabled)
        expect(isFailureRetryDue('kimi')).toBe(false)

        const loop = startQuotaRefreshLoop({
            hasRecentCliActivity: () => false,
            intervalMs: 5,
            isEnabled: allEnabled,
        })
        try {
            await new Promise(r => setTimeout(r, 40))
            expect(fetchKimiQuota).not.toHaveBeenCalled()
            expect(fetchClaudeQuota).not.toHaveBeenCalled()
            expect(fetchCodexQuota).not.toHaveBeenCalled()
            expect(fetchGrokQuota).not.toHaveBeenCalled()
            expect(fetchAntigravityQuota).not.toHaveBeenCalled()
        } finally {
            loop.stop()
        }
    })
})

describe('event-driven refresh (agent:generating_completed, agent:stopped)', () => {
    function makeEventSource() {
        const listeners: Array<(event: any) => void> = []
        return {
            instanceManager: { onEvent: (listener: (event: any) => void) => { listeners.push(listener) } },
            emit(event: any) { for (const listener of listeners) listener(event) },
        }
    }

    it('refreshes ONLY the provider whose agent just finished a turn', async () => {
        const source = makeEventSource()
        const handle = setupQuotaEventRefresh({ instanceManager: source.instanceManager })
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'))
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))

        source.emit({ event: 'agent:generating_completed', providerType: 'kimi' })
        await vi.waitFor(() => expect(readQuotaCache()?.['kimi']?.status).toBe('ok'))

        expect(fetchKimiQuota).toHaveBeenCalledTimes(1)
        expect(fetchClaudeQuota).not.toHaveBeenCalled()
        expect(fetchCodexQuota).not.toHaveBeenCalled()
        handle.stop()
    })

    it('debounces a burst of completions to one fetch per 60s per provider', async () => {
        let now = 1_000_000
        const source = makeEventSource()
        const handle = setupQuotaEventRefresh(
            { instanceManager: source.instanceManager },
            { now: () => now },
        )
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))

        source.emit({ event: 'agent:generating_completed', providerType: 'kimi' })
        now += 10_000
        source.emit({ event: 'agent:generating_completed', providerType: 'kimi' })
        now += 10_000
        source.emit({ event: 'agent:generating_completed', providerType: 'kimi' })
        await vi.waitFor(() => expect(readQuotaCache()?.['kimi']?.status).toBe('ok'))
        expect(fetchKimiQuota).toHaveBeenCalledTimes(1)

        now += 61_000 // past the debounce window
        source.emit({ event: 'agent:generating_completed', providerType: 'kimi' })
        await vi.waitFor(() => expect(fetchKimiQuota).toHaveBeenCalledTimes(2))
        handle.stop()
    })

    it('never refetches a provider disabled on this machine', async () => {
        const source = makeEventSource()
        const providerLoader = { isMachineProviderEnabled: (type: string) => type !== 'kimi' }
        const handle = setupQuotaEventRefresh({ instanceManager: source.instanceManager, providerLoader })
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))

        source.emit({ event: 'agent:generating_completed', providerType: 'kimi' })
        source.emit({ event: 'agent:generating_completed', providerType: 'claude-cli' })
        await vi.waitFor(() => expect(readQuotaCache()?.['claude-cli']?.status).toBe('ok'))

        expect(fetchKimiQuota).not.toHaveBeenCalled()
        expect(readQuotaCache()?.['kimi']).toBeUndefined()
        handle.stop()
    })

    it('ignores non-completion events and providers without a quota fetcher', async () => {
        const source = makeEventSource()
        const handle = setupQuotaEventRefresh({ instanceManager: source.instanceManager })

        source.emit({ event: 'agent:ready', providerType: 'kimi' })
        source.emit({ event: 'agent:generating_started', providerType: 'kimi' })
        source.emit({ event: 'agent:generating_completed', providerType: 'cursor' }) // no quota fetcher shipped
        source.emit({ event: 'agent:generating_completed' }) // no providerType at all
        await new Promise(r => setTimeout(r, 20))

        expect(fetchKimiQuota).not.toHaveBeenCalled()
        expect(fetchClaudeQuota).not.toHaveBeenCalled()
        expect(fetchCodexQuota).not.toHaveBeenCalled()
        handle.stop()
    })

    it('stop() disarms the listener', async () => {
        const source = makeEventSource()
        const handle = setupQuotaEventRefresh({ instanceManager: source.instanceManager })
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))

        handle.stop()
        source.emit({ event: 'agent:generating_completed', providerType: 'kimi' })
        await new Promise(r => setTimeout(r, 20))

        expect(fetchKimiQuota).not.toHaveBeenCalled()
    })

    // 2026-08-17 incident: a kimi session went ready → generating_started ×2 →
    // agent:stopped with generating_completed never firing at all. The
    // event-driven path never armed, so quota rode the 15-minute cadence and a
    // routing decision minutes later used a stale cached value. This is the
    // reproduction of that exact gap.
    it('refreshes on agent:stopped — the session-died-without-completing case', async () => {
        const source = makeEventSource()
        const handle = setupQuotaEventRefresh({ instanceManager: source.instanceManager })
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))

        source.emit({ event: 'agent:ready', providerType: 'kimi' })
        source.emit({ event: 'agent:generating_started', providerType: 'kimi' })
        source.emit({ event: 'agent:stopped', providerType: 'kimi' })
        await vi.waitFor(() => expect(readQuotaCache()?.['kimi']?.status).toBe('ok'))

        expect(fetchKimiQuota).toHaveBeenCalledTimes(1)
        handle.stop()
    })

    it('debounces agent:stopped the same as agent:generating_completed — repeated manual stops do not hammer the fetcher', async () => {
        let now = 1_000_000
        const source = makeEventSource()
        const handle = setupQuotaEventRefresh(
            { instanceManager: source.instanceManager },
            { now: () => now },
        )
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))

        source.emit({ event: 'agent:stopped', providerType: 'kimi' })
        now += 5_000
        source.emit({ event: 'agent:stopped', providerType: 'kimi' })
        now += 5_000
        source.emit({ event: 'agent:stopped', providerType: 'kimi' })
        await vi.waitFor(() => expect(readQuotaCache()?.['kimi']?.status).toBe('ok'))
        expect(fetchKimiQuota).toHaveBeenCalledTimes(1)

        now += 61_000 // past the debounce window
        source.emit({ event: 'agent:stopped', providerType: 'kimi' })
        await vi.waitFor(() => expect(fetchKimiQuota).toHaveBeenCalledTimes(2))
        handle.stop()
    })

    it('shares the debounce window across agent:stopped and agent:generating_completed for the same provider', async () => {
        let now = 1_000_000
        const source = makeEventSource()
        const handle = setupQuotaEventRefresh(
            { instanceManager: source.instanceManager },
            { now: () => now },
        )
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))

        source.emit({ event: 'agent:generating_completed', providerType: 'kimi' })
        await vi.waitFor(() => expect(fetchKimiQuota).toHaveBeenCalledTimes(1))

        now += 5_000
        source.emit({ event: 'agent:stopped', providerType: 'kimi' })
        await new Promise(r => setTimeout(r, 20))

        // Same provider, still inside the 60s debounce window: the stop event
        // must not trigger a second fetch on top of the completion's.
        expect(fetchKimiQuota).toHaveBeenCalledTimes(1)
        handle.stop()
    })

    it('never refetches a provider disabled on this machine on agent:stopped', async () => {
        const source = makeEventSource()
        const providerLoader = { isMachineProviderEnabled: (type: string) => type !== 'kimi' }
        const handle = setupQuotaEventRefresh({ instanceManager: source.instanceManager, providerLoader })
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))

        source.emit({ event: 'agent:stopped', providerType: 'kimi' })
        await new Promise(r => setTimeout(r, 20))

        expect(fetchKimiQuota).not.toHaveBeenCalled()
        expect(readQuotaCache()?.['kimi']).toBeUndefined()
        handle.stop()
    })
})
