import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same module-level fetcher mocking as quota-boot-refresh.test.ts: the
// fetcher modules are mocked so "was this provider probed at all" is a real
// call-count assertion — the whole point of the enable gate is that a
// disabled provider's fetcher is never INVOKED (no codex app-server spawn,
// no kimi request).
const fetchClaudeQuota = vi.fn()
const fetchCodexQuota = vi.fn()
const fetchKimiQuota = vi.fn()
const fetchOpencodeUsage = vi.fn()

vi.mock('../../src/quota/fetchers/claude.js', () => ({ fetchClaudeQuota, STALE_AFTER_MS: 60_000 }))
vi.mock('../../src/quota/fetchers/codex.js', () => ({ fetchCodexQuota }))
vi.mock('../../src/quota/fetchers/kimi.js', () => ({ fetchKimiQuota }))
vi.mock('../../src/quota/fetchers/opencode.js', () => ({ fetchOpencodeUsage, OPENCODE_USAGE_DAYS: 7 }))

const {
    clearQuotaCache,
    hydrateQuotaCacheFromDisk,
    readQuotaCache,
    refreshQuotaCacheOnBoot,
    refreshQuotaCacheOnce,
    startQuotaRefreshLoop,
    __resetQuotaBootRefreshForTests,
    __resetQuotaHydrationForTests,
} = await import('../../src/quota/refresh.js')
const { saveQuotaCache } = await import('../../src/quota/persist.js')

const okQuota = (provider: string) => ({
    provider,
    session: { usedPercent: 10, windowMinutes: 300, resetsAt: null },
    weekly: { usedPercent: 5, windowMinutes: 10080, resetsAt: null },
    updatedAt: 1_700_000,
    error: null,
    status: 'ok',
    metadata: {},
})

/** The M1-Server shape: claude-cli enabled, codex-cli and kimi NOT enabled. */
const onlyClaudeEnabled = (provider: string) => provider === 'claude-cli'

afterEach(() => {
    clearQuotaCache()
    __resetQuotaBootRefreshForTests()
    __resetQuotaHydrationForTests()
    vi.clearAllMocks()
})

describe('quota enable gate — refreshQuotaCacheOnce', () => {
    it('does not invoke the fetcher of a disabled provider at all', async () => {
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'))
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))

        await refreshQuotaCacheOnce(undefined, onlyClaudeEnabled)

        expect(fetchClaudeQuota).toHaveBeenCalledTimes(1)
        expect(fetchCodexQuota).not.toHaveBeenCalled()
        expect(fetchKimiQuota).not.toHaveBeenCalled()
        const quota = readQuotaCache()
        expect(Object.keys(quota ?? {})).toEqual(['claude-cli'])
    })

    it('prunes a snapshot left behind when its provider gets disabled', async () => {
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'))
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))

        // First: everything enabled — codex gets measured and cached.
        await refreshQuotaCacheOnce(undefined, () => true)
        expect(readQuotaCache()?.['codex-cli']).toBeDefined()

        // Then codex is disabled: the next refresh must drop its entry rather
        // than keep showing a stale (possibly "unavailable") reading.
        await refreshQuotaCacheOnce(undefined, onlyClaudeEnabled)
        const quota = readQuotaCache()
        expect(quota?.['codex-cli']).toBeUndefined()
        expect(quota?.['kimi']).toBeUndefined()
        expect(quota?.['claude-cli']).toBeDefined()
    })

    it('without a predicate the legacy behaviour is unchanged (all providers probed)', async () => {
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'))
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))

        await refreshQuotaCacheOnce()
        expect(fetchClaudeQuota).toHaveBeenCalledTimes(1)
        expect(fetchCodexQuota).toHaveBeenCalledTimes(1)
        expect(fetchKimiQuota).toHaveBeenCalledTimes(1)
    })
})

describe('quota enable gate — boot refresh', () => {
    it('probes only enabled providers at boot', async () => {
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'))
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))

        refreshQuotaCacheOnBoot(onlyClaudeEnabled)
        await vi.waitFor(() => expect(readQuotaCache()).toBeDefined())

        expect(fetchClaudeQuota).toHaveBeenCalledTimes(1)
        expect(fetchCodexQuota).not.toHaveBeenCalled()
        expect(fetchKimiQuota).not.toHaveBeenCalled()
    })
})

describe('quota enable gate — hydration', () => {
    let home: string
    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'adhdev-quota-gate-'))
    })
    afterEach(() => {
        rmSync(home, { recursive: true, force: true })
    })

    it('does not restore snapshots of disabled providers from the on-disk cache', () => {
        const env = { ADHDEV_CONFIG_DIR: home }
        saveQuotaCache(
            {
                'claude-cli': okQuota('claude-cli') as any,
                'codex-cli': okQuota('codex-cli') as any,
                kimi: {
                    ...okQuota('kimi'),
                    status: 'unavailable',
                    error: 'Not signed in to Kimi Code',
                    metadata: { failureKind: 'missing-credentials' },
                } as any,
            },
            env,
        )

        const restored = hydrateQuotaCacheFromDisk(env, onlyClaudeEnabled)
        expect(restored).toBe(1)
        const quota = readQuotaCache()
        expect(Object.keys(quota ?? {})).toEqual(['claude-cli'])
    })
})

describe('quota enable gate — periodic loop', () => {
    it('an idle machine is not probed for a provider whose snapshot already exists', async () => {
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'))
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))

        // Seed claude's snapshot so nothing is missing.
        await refreshQuotaCacheOnce(undefined, onlyClaudeEnabled)
        vi.clearAllMocks()

        const loop = startQuotaRefreshLoop({
            hasRecentCliActivity: () => false,
            intervalMs: 5,
            isEnabled: onlyClaudeEnabled,
        })
        try {
            // Several ticks pass with no activity and nothing missing: no fetch.
            await new Promise(r => setTimeout(r, 40))
            expect(fetchClaudeQuota).not.toHaveBeenCalled()
            expect(fetchCodexQuota).not.toHaveBeenCalled()
            expect(fetchKimiQuota).not.toHaveBeenCalled()
        } finally {
            loop.stop()
        }
    })

    it('backfills a provider enabled after boot even without any CLI activity', async () => {
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))

        // Mutable gate: kimi starts disabled, the test flips it on later.
        let kimiEnabled = false
        const isEnabled = (provider: string) => provider === 'claude-cli' || (provider === 'kimi' && kimiEnabled)

        // Boot state: only claude measured.
        await refreshQuotaCacheOnce(undefined, isEnabled)
        vi.clearAllMocks()

        const loop = startQuotaRefreshLoop({
            hasRecentCliActivity: () => false, // machine stays idle the whole time
            intervalMs: 5,
            isEnabled,
        })
        try {
            // While kimi is disabled the idle machine is left alone.
            await new Promise(r => setTimeout(r, 30))
            expect(fetchKimiQuota).not.toHaveBeenCalled()

            // Enable kimi: the next tick backfills it despite zero activity.
            kimiEnabled = true
            await vi.waitFor(() => expect(fetchKimiQuota).toHaveBeenCalledTimes(1))
            await vi.waitFor(() => expect(readQuotaCache()?.['kimi']).toBeDefined())
        } finally {
            loop.stop()
        }
    })
})
