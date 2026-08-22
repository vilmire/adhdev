/**
 * THE CARRY-FORWARD BACKFILL STORM — regression cover for the defect that
 * defeated the 2026-08-21 axis split on exactly the providers it was built to
 * protect (observed on the owner's mesh 2026-08-22).
 *
 * The composition, all three parts individually correct:
 *   1. `carryForwardLastGoodWindows` DELIBERATELY preserves the previous entry's
 *      `updatedAt` on a transient failure — the retained windows really are the
 *      older reading, so claiming they are fresh would be a lie;
 *   2. `isSnapshotStaleForRouting` reads `updatedAt`, because the routing gate's
 *      question is about the age of the DATA (the 2026-08-15 fix); and
 *   3. the loop's `backfillDue` used that same predicate to decide whether to
 *      spend a FETCH.
 *
 * So a provider whose credential keeps expiring — kimi's ~15-minute OAuth tokens
 * are the standing case, and three of the owner's providers were in this state —
 * holds a FROZEN `updatedAt`, is therefore stale-for-routing on every tick
 * forever, and got backfilled on every tick forever. The network axis has a
 * cadenced TTL of Infinity specifically so a timer never hits a third party's
 * endpoint; the backfill walked around it, and the more broken the provider was,
 * the harder we hit it.
 *
 * The fix reads the ATTEMPT clock (`metadata.fetchedAt`) for the scheduling half
 * of that decision while leaving the routing half on `updatedAt`. These cases
 * pin both halves: the storm is gone, AND the 2026-08-15 safety net still fires
 * for a provider that genuinely is not being probed.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchKimiQuota = vi.fn()
const fetchCodexQuota = vi.fn()

vi.mock('../../src/quota/fetchers/kimi.js', () => ({ fetchKimiQuota }))
vi.mock('../../src/quota/fetchers/codex.js', () => ({ fetchCodexQuota }))

const {
    QUOTA_FAILURE_MAX_RETRIES,
    QUOTA_ROUTABLE_MAX_AGE_MS,
    clearQuotaCache,
    isSnapshotStaleForRouting,
    readQuotaCache,
    refreshQuotaCacheOnce,
    startQuotaRefreshLoop,
    __resetQuotaBootRefreshForTests,
    __resetQuotaHydrationForTests,
} = await import('../../src/quota/refresh.js')

const TICK_MS = 15 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

const okQuota = (provider: string, updatedAt: number) => ({
    provider,
    session: { usedPercent: 26, windowMinutes: 300, resetsAt: null },
    weekly: { usedPercent: 54, windowMinutes: 10080, resetsAt: null },
    updatedAt,
    error: null,
    status: 'ok' as const,
    metadata: {},
})

/** A transient failure of the kind kimi's expiring OAuth token produces. */
const expiredToken = (provider: string, updatedAt: number) => ({
    provider,
    session: null,
    weekly: null,
    updatedAt,
    error: 'token expired',
    status: 'error' as const,
    metadata: { failureKind: 'expired-token' as const, retryAtMs: updatedAt + 1000 },
})

const allEnabled = () => true

let home: string
let previousHome: string | undefined

beforeEach(() => {
    previousHome = process.env.ADHDEV_CONFIG_DIR
    home = mkdtempSync(join(tmpdir(), 'adhdev-quota-storm-'))
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

describe('a network-axis provider stuck in carry-forward', () => {
    it('is backfilled once per routing horizon, NOT once per tick', async () => {
        vi.useFakeTimers()
        const start = 1_800_000_000_000
        vi.setSystemTime(start)

        // One good reading, so the entry has windows to carry forward.
        fetchKimiQuota.mockImplementation(async () => okQuota('kimi', Date.now()))
        await refreshQuotaCacheOnce([{ provider: 'kimi', fetch: fetchKimiQuota }], allEnabled)
        const baseline = fetchKimiQuota.mock.calls.length

        // From here the token is always expired — the live 2026-08-22 state.
        fetchKimiQuota.mockImplementation(async () => expiredToken('kimi', Date.now()))

        const handle = startQuotaRefreshLoop({
            hasRecentCliActivity: () => false, // idle for the whole day
            intervalMs: TICK_MS,
            fetchers: [{ provider: 'kimi', fetch: fetchKimiQuota }],
            isEnabled: allEnabled,
        })
        await vi.advanceTimersByTimeAsync(DAY_MS)
        handle.stop()

        const fetches = fetchKimiQuota.mock.calls.length - baseline
        const ticks = DAY_MS / TICK_MS // 96

        // The defect fetched on EVERY tick (96/day) against a third-party
        // endpoint. The intent is one per routing horizon (~24/day), plus the
        // bounded short-fuse retries the failure episode legitimately schedules
        // (QUOTA_FAILURE_MAX_RETRIES, which stops on its own — see
        // updateFailureRetry). Allowing that budget on top is deliberate: those
        // retries are the mechanism that RECOVERS from a transient failure, and
        // this test is about the unbounded per-tick storm, not about them.
        const horizonsPerDay = DAY_MS / QUOTA_ROUTABLE_MAX_AGE_MS // 24
        expect(fetches).toBeLessThanOrEqual(horizonsPerDay + QUOTA_FAILURE_MAX_RETRIES)
        expect(fetches).toBeLessThan(ticks / 2)
    })

    it('still retains its last-good windows and its honest data age', async () => {
        vi.useFakeTimers()
        const start = 1_800_000_000_000
        vi.setSystemTime(start)

        fetchKimiQuota.mockImplementation(async () => okQuota('kimi', Date.now()))
        await refreshQuotaCacheOnce([{ provider: 'kimi', fetch: fetchKimiQuota }], allEnabled)
        fetchKimiQuota.mockImplementation(async () => expiredToken('kimi', Date.now()))

        const handle = startQuotaRefreshLoop({
            hasRecentCliActivity: () => false,
            intervalMs: TICK_MS,
            fetchers: [{ provider: 'kimi', fetch: fetchKimiQuota }],
            isEnabled: allEnabled,
        })
        await vi.advanceTimersByTimeAsync(DAY_MS)
        handle.stop()

        const entry = readQuotaCache()?.kimi
        // Throttling the FETCH must not change what the user and the routing
        // gate see: the retained windows and the original (honest) data age.
        expect(entry?.metadata?.lastGoodWindows).toBe(true)
        expect(entry?.weekly?.usedPercent).toBe(54)
        expect(entry?.updatedAt).toBe(start)
        expect(isSnapshotStaleForRouting('kimi', start + DAY_MS)).toBe(true)
    })
})

describe('the 2026-08-15 safety net is unchanged', () => {
    it('still backfills a provider that is genuinely not being probed', async () => {
        vi.useFakeTimers()
        const start = 1_800_000_000_000
        vi.setSystemTime(start)

        // A healthy provider measured once, then left alone on an idle machine:
        // no turns, so the event-driven refresh never touches it.
        fetchCodexQuota.mockImplementation(async () => okQuota('codex-cli', Date.now()))
        await refreshQuotaCacheOnce([{ provider: 'codex-cli', fetch: fetchCodexQuota }], allEnabled)
        expect(fetchCodexQuota).toHaveBeenCalledTimes(1)

        const handle = startQuotaRefreshLoop({
            hasRecentCliActivity: () => false,
            intervalMs: TICK_MS,
            fetchers: [{ provider: 'codex-cli', fetch: fetchCodexQuota }],
            isEnabled: allEnabled,
        })

        // Inside the horizon the idle gate holds.
        await vi.advanceTimersByTimeAsync(QUOTA_ROUTABLE_MAX_AGE_MS - TICK_MS)
        expect(fetchCodexQuota).toHaveBeenCalledTimes(1)

        // Past it, the snapshot would fail open at the routing gate, so the
        // backfill fires — the guarantee that must survive this fix.
        await vi.advanceTimersByTimeAsync(TICK_MS * 2)
        expect(fetchCodexQuota.mock.calls.length).toBeGreaterThan(1)

        handle.stop()
    })

    it('backfills a provider with no snapshot at all', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(1_800_000_000_000)
        fetchCodexQuota.mockImplementation(async () => okQuota('codex-cli', Date.now()))

        const handle = startQuotaRefreshLoop({
            hasRecentCliActivity: () => false,
            intervalMs: TICK_MS,
            fetchers: [{ provider: 'codex-cli', fetch: fetchCodexQuota }],
            isEnabled: allEnabled,
        })
        await vi.advanceTimersByTimeAsync(TICK_MS)
        handle.stop()

        expect(fetchCodexQuota).toHaveBeenCalled()
    })
})
