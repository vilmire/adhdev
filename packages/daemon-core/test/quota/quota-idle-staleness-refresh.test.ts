/**
 * The IDLE-GATE STALENESS EXCEPTION — regression cover for the defect that
 * silently disabled quota-aware routing on the owner's mesh (2026-08-15).
 *
 * The defect was a composition of three individually-correct rules:
 *   1. the periodic refresh tick is skipped while the machine is idle;
 *   2. the event-driven refresh re-reads ONLY the provider that just finished
 *      a turn; and
 *   3. the routing gate fails OPEN on a snapshot older than staleAfterMs.
 *
 * The provider doing the work stayed fresh; every alternative aged out and
 * became ungateable — so `weeklyMinRemainingPercent: 80` applied to nobody and
 * selection silently fell back to slot order. These cases pin the fix: an
 * enabled provider whose snapshot has aged past the ROUTING horizon is
 * re-fetched even on an idle machine.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same module-level fetcher mocking as the sibling quota tests: call counts are
// real assertions about WHEN a provider was probed.
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
    QUOTA_ROUTABLE_MAX_AGE_MS,
    clearQuotaCache,
    isSnapshotStaleForRouting,
    readQuotaCache,
    refreshQuotaCacheOnce,
    startQuotaRefreshLoop,
    __resetQuotaBootRefreshForTests,
    __resetQuotaHydrationForTests,
} = await import('../../src/quota/refresh.js')

const okQuota = (provider: string, updatedAt: number) => ({
    provider,
    session: { usedPercent: 10, windowMinutes: 300, resetsAt: null },
    weekly: { usedPercent: 5, windowMinutes: 10080, resetsAt: null },
    updatedAt,
    error: null,
    status: 'ok' as const,
    metadata: {},
})

const allEnabled = () => true

let home: string
let previousHome: string | undefined

beforeEach(() => {
    previousHome = process.env.ADHDEV_CONFIG_DIR
    home = mkdtempSync(join(tmpdir(), 'adhdev-quota-stale-'))
    process.env.ADHDEV_CONFIG_DIR = home
    clearQuotaCache()
    __resetQuotaBootRefreshForTests()
    __resetQuotaHydrationForTests()
    vi.clearAllMocks()
})

afterEach(() => {
    clearQuotaCache()
    vi.useRealTimers()
    if (previousHome === undefined) delete process.env.ADHDEV_CONFIG_DIR
    else process.env.ADHDEV_CONFIG_DIR = previousHome
    rmSync(home, { recursive: true, force: true })
})

describe('isSnapshotStaleForRouting', () => {
    it('is false for a snapshot still inside the routing horizon', async () => {
        const now = 1_800_000_000_000
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli', now))
        await refreshQuotaCacheOnce([{ provider: 'codex-cli', fetch: fetchCodexQuota }], allEnabled)
        expect(isSnapshotStaleForRouting('codex-cli', now + QUOTA_ROUTABLE_MAX_AGE_MS - 1)).toBe(false)
    })

    it('is true once the snapshot ages to the routing horizon', async () => {
        const now = 1_800_000_000_000
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli', now))
        await refreshQuotaCacheOnce([{ provider: 'codex-cli', fetch: fetchCodexQuota }], allEnabled)
        expect(isSnapshotStaleForRouting('codex-cli', now + QUOTA_ROUTABLE_MAX_AGE_MS)).toBe(true)
    })

    it('is false with no entry at all — that is the pre-existing backfill case, not this one', () => {
        expect(isSnapshotStaleForRouting('codex-cli', Date.now())).toBe(false)
    })
})

describe('the idle machine keeps ALTERNATIVE providers routable', () => {
    it('re-fetches a stale snapshot even though the machine is idle', async () => {
        vi.useFakeTimers()
        const start = 1_800_000_000_000
        vi.setSystemTime(start)

        // codex-cli measured once, then the machine goes idle: no turns, so the
        // event-driven refresh never touches it again.
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli', start))
        await refreshQuotaCacheOnce([{ provider: 'codex-cli', fetch: fetchCodexQuota }], allEnabled)
        expect(fetchCodexQuota).toHaveBeenCalledTimes(1)

        const handle = startQuotaRefreshLoop({
            hasRecentCliActivity: () => false, // idle for the whole test
            intervalMs: 1000,
            fetchers: [{ provider: 'codex-cli', fetch: fetchCodexQuota }],
            isEnabled: allEnabled,
        })

        // Inside the routing horizon the idle gate still holds — no extra fetch.
        // (Time moves by ADVANCE only: setSystemTime shifts pending one-shot
        // timers by the jump delta, which would move the chain's next wake —
        // a fake-timers artifact, not real behaviour.)
        await vi.advanceTimersByTimeAsync(QUOTA_ROUTABLE_MAX_AGE_MS - 60_000)
        expect(fetchCodexQuota).toHaveBeenCalledTimes(1)

        // Past the horizon the snapshot would fail open at the routing gate, so
        // the loop refreshes it despite the machine being idle.
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli', start + QUOTA_ROUTABLE_MAX_AGE_MS + 1000))
        await vi.advanceTimersByTimeAsync(62_000)
        expect(fetchCodexQuota).toHaveBeenCalledTimes(2)

        handle.stop()
        expect(readQuotaCache()?.['codex-cli']?.updatedAt).toBe(start + QUOTA_ROUTABLE_MAX_AGE_MS + 1000)
    })

    it('does not re-fetch a DISABLED provider, however stale it is', async () => {
        vi.useFakeTimers()
        const start = 1_800_000_000_000
        vi.setSystemTime(start)
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli', start))
        await refreshQuotaCacheOnce([{ provider: 'codex-cli', fetch: fetchCodexQuota }], allEnabled)
        expect(fetchCodexQuota).toHaveBeenCalledTimes(1)

        const handle = startQuotaRefreshLoop({
            hasRecentCliActivity: () => false,
            intervalMs: 1000,
            fetchers: [{ provider: 'codex-cli', fetch: fetchCodexQuota }],
            isEnabled: () => false, // machine does not run codex-cli
        })
        vi.setSystemTime(start + QUOTA_ROUTABLE_MAX_AGE_MS * 10)
        await vi.advanceTimersByTimeAsync(1000)
        // The disabled provider is pruned, never probed.
        expect(fetchCodexQuota).toHaveBeenCalledTimes(1)
        handle.stop()
    })
})
