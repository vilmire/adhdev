/**
 * TIMER CHAIN — the refresh loop sleeps until the next per-provider EXPIRY
 * instead of waking on a fixed 15-minute setInterval.
 *
 * Why: an idle machine whose snapshots are all inside the routing horizon has
 * no work until the oldest one ages out, so waking every 15 minutes to
 * discover that was the last reason the "idle daemon is never quiet" complaint
 * survived the axis split. The chain recomputes its next wake after every wake
 * AND after every out-of-band refresh (event-driven, SWR, force, retry) via
 * the quotaCacheChangedListener hook.
 *
 * What these cases pin:
 *   - the idle-quiet win, as a NUMBER (wakeups per day, interval vs chain);
 *   - the safety nets that must survive the change: the staleness backfill
 *     still fires at its horizon, and an ACTIVE machine's file axis is
 *     refreshed no later than before (in fact at its 60s TTL);
 *   - the "a wake never fails to come" guarantees: clock-skewed entries are
 *     ceilinged at the routing horizon, a mid-chain event/force refresh
 *     recomputes the next wake instead of corrupting it, and stop() leaves no
 *     timer behind.
 *
 * NOTE on fake timers: vitest's setSystemTime SHIFTS pending timers by the
 * jump delta (observed: a timer armed for T survives a jump to T+ε and fires
 * late). These tests therefore move time ONLY with advanceTimersByTimeAsync
 * once the loop is armed — no mid-test clock jumps.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same module-level fetcher mocking as the sibling quota tests: call counts are
// real assertions about WHEN a provider was probed.
const fetchAntigravityQuota = vi.fn()
const fetchClaudeQuota = vi.fn()
const fetchCodexQuota = vi.fn()
const fetchCursorQuota = vi.fn()
const fetchGrokQuota = vi.fn()
const fetchKimiQuota = vi.fn()
const fetchOpencodeUsage = vi.fn()

vi.mock('../../src/quota/fetchers/antigravity.js', () => ({ fetchAntigravityQuota }))
vi.mock('../../src/quota/fetchers/claude.js', () => ({ fetchClaudeQuota, STALE_AFTER_MS: 60_000 }))
vi.mock('../../src/quota/fetchers/codex.js', () => ({ fetchCodexQuota }))
vi.mock('../../src/quota/fetchers/cursor.js', () => ({ fetchCursorQuota }))
vi.mock('../../src/quota/fetchers/grok.js', () => ({ fetchGrokQuota }))
vi.mock('../../src/quota/fetchers/kimi.js', () => ({ fetchKimiQuota }))
vi.mock('../../src/quota/fetchers/opencode.js', () => ({ fetchOpencodeUsage, OPENCODE_USAGE_DAYS: 7 }))

const {
    QUOTA_ROUTABLE_MAX_AGE_MS,
    clearQuotaCache,
    forceRefreshQuota,
    readQuotaCache,
    refreshQuotaCacheOnce,
    setupQuotaEventRefresh,
    startQuotaRefreshLoop,
    __resetQuotaAmbientEnableGateForTests,
    __resetQuotaBootRefreshForTests,
    __resetQuotaHydrationForTests,
} = await import('../../src/quota/refresh.js')

const START = 1_800_000_000_000
const INTERVAL_MS = 15 * 60 * 1000 // the pre-chain fixed cadence
const DAY_MS = 24 * 60 * 60 * 1000

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

const claudeFetcher = { provider: 'claude-cli' as const, fetch: fetchClaudeQuota }
const codexFetcher = { provider: 'codex-cli' as const, fetch: fetchCodexQuota }
const kimiFetcher = { provider: 'kimi' as const, fetch: fetchKimiQuota }

function makeEventSource() {
    const listeners: Array<(event: any) => void> = []
    return {
        instanceManager: { onEvent: (listener: (event: any) => void) => { listeners.push(listener) } },
        emit(event: any) { for (const listener of listeners) listener(event) },
    }
}

let home: string
let previousHome: string | undefined

beforeEach(() => {
    previousHome = process.env.ADHDEV_CONFIG_DIR
    home = mkdtempSync(join(tmpdir(), 'adhdev-quota-chain-'))
    process.env.ADHDEV_CONFIG_DIR = home
    clearQuotaCache()
    __resetQuotaBootRefreshForTests()
    __resetQuotaHydrationForTests()
    __resetQuotaAmbientEnableGateForTests()
    vi.clearAllMocks()
})

afterEach(() => {
    clearQuotaCache()
    __resetQuotaAmbientEnableGateForTests()
    vi.useRealTimers()
    if (previousHome === undefined) delete process.env.ADHDEV_CONFIG_DIR
    else process.env.ADHDEV_CONFIG_DIR = previousHome
    rmSync(home, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('idle quiet — the wakeup count, as a number', () => {
    it('an idle machine with fresh snapshots wakes per HORIZON, not per interval', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(START)
        fetchClaudeQuota.mockImplementation(async () => okQuota('claude-cli', Date.now()))
        fetchKimiQuota.mockImplementation(async () => okQuota('kimi', Date.now()))
        await refreshQuotaCacheOnce([claudeFetcher, kimiFetcher], allEnabled)
        vi.clearAllMocks()

        // The activity probe is called exactly once per wake (plus once per
        // reschedule), so its call count measures how often the daemon stirs.
        const activity = vi.fn(() => false)
        const handle = startQuotaRefreshLoop({
            hasRecentCliActivity: activity,
            intervalMs: INTERVAL_MS,
            fetchers: [claudeFetcher, kimiFetcher],
            isEnabled: allEnabled,
        })
        try {
            await vi.advanceTimersByTimeAsync(DAY_MS)

            // The pre-chain interval woke 96 times a day (24h / 15min). The
            // chain wakes at the first interval and then once per routing
            // horizon: 1 + 24 wakes, two probe calls each (~50 vs 96).
            const oldIntervalWakes = DAY_MS / INTERVAL_MS // 96
            const chainWakes = 1 + DAY_MS / QUOTA_ROUTABLE_MAX_AGE_MS // 25
            expect(activity.mock.calls.length).toBeLessThanOrEqual(chainWakes * 2 + 2)
            expect(activity.mock.calls.length).toBeLessThan(oldIntervalWakes * 0.6)

            // The backfill cadence itself is UNCHANGED: one fetch per provider
            // per horizon. Quieter must not mean staler.
            expect(fetchKimiQuota.mock.calls.length).toBe(DAY_MS / QUOTA_ROUTABLE_MAX_AGE_MS)
            expect(fetchClaudeQuota.mock.calls.length).toBe(DAY_MS / QUOTA_ROUTABLE_MAX_AGE_MS)
        } finally {
            handle.stop()
        }
    })
})

describe('safety nets survive the timer change', () => {
    it('the staleness backfill still fires at the routing horizon on an idle machine', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(START)
        fetchCodexQuota.mockImplementation(async () => okQuota('codex-cli', Date.now()))
        await refreshQuotaCacheOnce([codexFetcher], allEnabled)
        vi.clearAllMocks()

        const handle = startQuotaRefreshLoop({
            hasRecentCliActivity: () => false,
            intervalMs: INTERVAL_MS,
            fetchers: [codexFetcher],
            isEnabled: allEnabled,
        })
        try {
            // Inside the horizon: the chain wakes (first wake at the interval)
            // but does not fetch.
            await vi.advanceTimersByTimeAsync(QUOTA_ROUTABLE_MAX_AGE_MS - 60_000)
            expect(fetchCodexQuota).not.toHaveBeenCalled()

            // Crossing the horizon: the chain's computed wake lands on it and
            // the backfill fires despite the machine being idle.
            await vi.advanceTimersByTimeAsync(120_000)
            expect(fetchCodexQuota).toHaveBeenCalledTimes(1)
        } finally {
            handle.stop()
        }
    })

    it('an ACTIVE machine is refreshed no later than before — the file axis now follows its 60s TTL', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(START)
        fetchClaudeQuota.mockImplementation(async () => okQuota('claude-cli', Date.now()))
        await refreshQuotaCacheOnce([claudeFetcher], allEnabled)
        vi.clearAllMocks()

        const handle = startQuotaRefreshLoop({
            hasRecentCliActivity: () => true, // active the whole time
            intervalMs: INTERVAL_MS,
            fetchers: [claudeFetcher],
            isEnabled: allEnabled,
        })
        try {
            // First wake at the interval: the TTL-due file axis is fetched —
            // the same moment the old interval would have fetched it. NOT
            // slower.
            await vi.advanceTimersByTimeAsync(INTERVAL_MS)
            expect(fetchClaudeQuota).toHaveBeenCalledTimes(1)

            // From here the chain follows the 60s axis TTL instead of waiting
            // for the next 15-minute tick: two more fetches within two
            // minutes, where the old interval would still be sitting at one.
            await vi.advanceTimersByTimeAsync(60_000)
            expect(fetchClaudeQuota).toHaveBeenCalledTimes(2)
            await vi.advanceTimersByTimeAsync(60_000)
            expect(fetchClaudeQuota).toHaveBeenCalledTimes(3)
        } finally {
            handle.stop()
        }
    })
})

describe('a wake never fails to come', () => {
    it('a clock-skewed (future-dated) entry cannot put the chain to sleep forever', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(START)
        // updatedAt ten hours in the FUTURE: the staleness computation says
        // "due in 10h + horizon", which without a ceiling would sleep the
        // chain for half a day. The ceiling caps every sleep at the horizon.
        fetchKimiQuota.mockResolvedValue(okQuota('kimi', START + 10 * 60 * 60_000))
        await refreshQuotaCacheOnce([kimiFetcher], allEnabled)

        const activity = vi.fn(() => false)
        const handle = startQuotaRefreshLoop({
            hasRecentCliActivity: activity,
            // A huge injected interval so the pre-chain shape would NOT wake
            // inside the test window either: this isolates the ceiling.
            intervalMs: 10 * 60 * 60_000,
            fetchers: [kimiFetcher],
            isEnabled: allEnabled,
        })
        try {
            // First wake at 10h, then ceiling-capped wakes at 11h, 12h.
            await vi.advanceTimersByTimeAsync(12 * 60 * 60_000)
            expect(activity.mock.calls.length).toBeGreaterThanOrEqual(3)
        } finally {
            handle.stop()
        }
    })

    it('a mid-chain EVENT refresh recomputes the next wake — an active machine gets its TTL cadence', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(START)
        fetchClaudeQuota.mockImplementation(async () => okQuota('claude-cli', Date.now()))
        fetchKimiQuota.mockImplementation(async () => okQuota('kimi', Date.now()))
        await refreshQuotaCacheOnce([claudeFetcher, kimiFetcher], allEnabled)
        vi.clearAllMocks()

        let active = false
        const handle = startQuotaRefreshLoop({
            hasRecentCliActivity: () => active,
            intervalMs: INTERVAL_MS,
            fetchers: [claudeFetcher, kimiFetcher],
            isEnabled: allEnabled,
        })
        const source = makeEventSource()
        const eventHandle = setupQuotaEventRefresh({ instanceManager: source.instanceManager })
        try {
            // First wake: idle, everything fresh — the chain goes to sleep
            // until the backfill horizon.
            await vi.advanceTimersByTimeAsync(INTERVAL_MS)
            expect(fetchKimiQuota).not.toHaveBeenCalled()
            expect(fetchClaudeQuota).not.toHaveBeenCalled()

            // A turn ends at 20min: the event-driven refresh fires and NUDGES
            // the chain.
            await vi.advanceTimersByTimeAsync(5 * 60_000)
            source.emit({ event: 'agent:generating_completed', providerType: 'kimi' })
            await vi.advanceTimersByTimeAsync(0)
            expect(fetchKimiQuota).toHaveBeenCalledTimes(1)

            // The machine is now actively working. A second event (past the
            // debounce) refreshes kimi again, and the recomputed wake must now
            // observe active=true and schedule the file axis at its TTL —
            // seconds, not the horizon the chain was previously sleeping
            // towards.
            active = true
            await vi.advanceTimersByTimeAsync(2 * 60_000)
            source.emit({ event: 'agent:generating_completed', providerType: 'kimi' })
            await vi.advanceTimersByTimeAsync(0)
            expect(fetchKimiQuota).toHaveBeenCalledTimes(2)

            await vi.advanceTimersByTimeAsync(5_000)
            expect(fetchClaudeQuota).toHaveBeenCalledTimes(1) // TTL-due, served promptly
        } finally {
            handle.stop()
            eventHandle.stop()
        }
    })

    it('a mid-chain FORCE refresh moves the next wake to the fresh expiry — and never stacks a second chain', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(START)
        fetchKimiQuota.mockImplementation(async () => okQuota('kimi', Date.now()))
        await refreshQuotaCacheOnce([kimiFetcher], allEnabled)
        vi.clearAllMocks()

        const activity = vi.fn(() => false)
        const handle = startQuotaRefreshLoop({
            hasRecentCliActivity: activity,
            intervalMs: INTERVAL_MS,
            fetchers: [kimiFetcher],
            isEnabled: allEnabled,
        })
        try {
            await vi.advanceTimersByTimeAsync(INTERVAL_MS) // first wake → sleeps to START + horizon
            const probesAfterFirstWake = activity.mock.calls.length

            // Two force refreshes a minute apart: each recomputes the next
            // wake from the FRESH attempt clock. Two recomputes, one chain.
            await vi.advanceTimersByTimeAsync(5 * 60_000) // t = 20min
            await forceRefreshQuota(['kimi'])
            await vi.advanceTimersByTimeAsync(60_000) // t = 21min
            await forceRefreshQuota(['kimi'])
            expect(fetchKimiQuota).toHaveBeenCalledTimes(2)

            // Advance to just before the RECOMPUTED expiry (21min + horizon),
            // far past the ORIGINAL one (START + horizon): nothing may have
            // fired — a leftover timer would show up as extra probe calls and
            // a stale-timer wake would find the snapshot fresh anyway.
            await vi.advanceTimersByTimeAsync(QUOTA_ROUTABLE_MAX_AGE_MS - 60_000) // t = 81min - 60s
            expect(activity.mock.calls.length).toBe(probesAfterFirstWake + 2) // the two recomputes only
            expect(fetchKimiQuota).toHaveBeenCalledTimes(2)

            // Crossing the recomputed expiry, the backfill fires exactly once.
            await vi.advanceTimersByTimeAsync(120_000)
            expect(fetchKimiQuota).toHaveBeenCalledTimes(3)
        } finally {
            handle.stop()
        }
    })

    it('stop() kills the chain and leaves no timer behind', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(START)
        fetchKimiQuota.mockImplementation(async () => okQuota('kimi', Date.now()))
        await refreshQuotaCacheOnce([kimiFetcher], allEnabled)
        vi.clearAllMocks()

        const activity = vi.fn(() => false)
        const handle = startQuotaRefreshLoop({
            hasRecentCliActivity: activity,
            intervalMs: INTERVAL_MS,
            fetchers: [kimiFetcher],
            isEnabled: allEnabled,
        })
        await vi.advanceTimersByTimeAsync(INTERVAL_MS) // first wake, chain re-armed
        const probesAtStop = activity.mock.calls.length
        handle.stop()

        await vi.advanceTimersByTimeAsync(DAY_MS)
        expect(activity.mock.calls.length).toBe(probesAtStop)
        expect(fetchKimiQuota).not.toHaveBeenCalled()
        expect(readQuotaCache()).toBeDefined() // the cache itself is untouched
    })
})
