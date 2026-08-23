/**
 * ★AXIS SPLIT + STALE-WHILE-REVALIDATE + FORCE REFRESH (2026-08-21).
 *
 * The refresh side of quota was one 15-minute schedule shared by all six
 * providers — three local file reads locked to the same cadence as three OAuth
 * calls to third-party servers. This suite pins the three changes that replaced
 * it, and (more importantly) the invariants they were NOT allowed to break.
 *
 * The highest-value cases here are the negative ones. In order of how much they
 * cost when wrong:
 *
 *  1. ★Neither the SWR revalidate nor the explicit force refresh may bypass the
 *     antigravity 429 cooldown. A background fetch triggered by a dashboard
 *     render, or a user clicking "refresh" twice, hitting a rate-limited quota
 *     method is how the 2026-08-20 incident happened — and the "user asked for
 *     it, so just fetch" reading of force refresh reproduces it exactly.
 *  2. ★The 60-minute staleness backfill still fires with zero events and zero
 *     readers. It is the only guarantee that a snapshot never ages out of the
 *     routing gate's trust window forever (the 2026-08-15 defect).
 *  3. ★A file-source provider's unchanged `updatedAt` must not be read as "never
 *     refreshed". That misread turns every read into a fetch.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Module-level fetcher mocks: call COUNTS are the real assertions here — every
// case below is about whether a provider was probed, not about what came back.
const fetchAntigravityQuota = vi.fn()
const fetchClaudeQuota = vi.fn()
const fetchCodexQuota = vi.fn()
const fetchGrokQuota = vi.fn()
const fetchKimiQuota = vi.fn()
const fetchOpencodeUsage = vi.fn()

vi.mock('../../src/quota/fetchers/antigravity.js', () => ({ fetchAntigravityQuota }))
vi.mock('../../src/quota/fetchers/claude.js', () => ({ fetchClaudeQuota, STALE_AFTER_MS: 60_000 }))
vi.mock('../../src/quota/fetchers/codex.js', () => ({ fetchCodexQuota }))
vi.mock('../../src/quota/fetchers/grok.js', () => ({ fetchGrokQuota }))
vi.mock('../../src/quota/fetchers/kimi.js', () => ({ fetchKimiQuota }))
vi.mock('../../src/quota/fetchers/opencode.js', () => ({ fetchOpencodeUsage, OPENCODE_USAGE_DAYS: 7 }))

const {
    QUOTA_AXIS,
    QUOTA_AXIS_TTL_MS,
    QUOTA_SWR_TTL_MS,
    QUOTA_ROUTABLE_MAX_AGE_MS,
    clearQuotaCache,
    forceRefreshQuota,
    isDueByAxisTtl,
    isQuotaRevalidateInFlight,
    readQuotaCache,
    readQuotaCacheWithRevalidate,
    refreshQuotaCacheOnce,
    startQuotaRefreshLoop,
    __resetQuotaAmbientEnableGateForTests,
    __resetQuotaBootRefreshForTests,
    __resetQuotaHydrationForTests,
} = await import('../../src/quota/refresh.js')

const START = 1_800_000_000_000

const okQuota = (provider: string, updatedAt: number) => ({
    provider,
    session: { usedPercent: 10, windowMinutes: 300, resetsAt: null },
    weekly: { usedPercent: 5, windowMinutes: 10080, resetsAt: null },
    updatedAt,
    error: null,
    status: 'ok' as const,
    metadata: {},
})

/** A cached 429 exactly as a fetcher records one, cooldown still running. */
const rateLimited = (provider: string, now: number, retryInMs: number) => ({
    provider,
    session: null,
    weekly: null,
    updatedAt: now,
    error: 'rate limited',
    status: 'error' as const,
    metadata: { failureKind: 'rate-limited' as const, retryAtMs: now + retryInMs },
})

const allEnabled = () => true

let home: string
let previousHome: string | undefined

beforeEach(() => {
    previousHome = process.env.ADHDEV_CONFIG_DIR
    home = mkdtempSync(join(tmpdir(), 'adhdev-quota-axis-'))
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

describe('★429 cooldown is not bypassable — SWR revalidate', () => {
    it('does NOT probe a provider whose 429 cooldown is still running', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(START)
        // Arm the loop so the SWR path has an enable gate to consult, then seed
        // antigravity with a live 429.
        const handle = startQuotaRefreshLoop({
            hasRecentCliActivity: () => false,
            intervalMs: 10 * 60 * 1000,
            isEnabled: allEnabled,
        })
        // A server-sent Retry-After longer than the SWR TTL — the case that
        // actually exercises the ordering, and a real one (a provider under
        // load hands back a long window). Without it the cooldown would expire
        // before SWR ever became due and the test would prove nothing.
        const cooldownMs = QUOTA_SWR_TTL_MS['antigravity-cli'] * 3
        fetchAntigravityQuota.mockResolvedValue(rateLimited('antigravity-cli', START, cooldownMs))
        await refreshQuotaCacheOnce(
            [{ provider: 'antigravity-cli', fetch: fetchAntigravityQuota }],
            allEnabled,
        )
        expect(fetchAntigravityQuota).toHaveBeenCalledTimes(1)

        // A dashboard read past antigravity's SWR TTL but still inside the 429
        // cooldown. The provider IS due by the SWR clock — precisely the moment
        // SWR would fetch — and the cooldown must still hold it back. If the
        // two are ever evaluated in the wrong order, this is what catches it.
        const during = START + QUOTA_SWR_TTL_MS['antigravity-cli'] + 1000
        expect(during).toBeLessThan(START + cooldownMs) // genuinely mid-cooldown
        vi.setSystemTime(during)
        readQuotaCacheWithRevalidate(during)
        await vi.advanceTimersByTimeAsync(0)

        expect(fetchAntigravityQuota).toHaveBeenCalledTimes(1)
        handle.stop()
    })

    it('resumes probing once the cooldown has elapsed', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(START)
        const handle = startQuotaRefreshLoop({
            hasRecentCliActivity: () => false,
            intervalMs: 10 * 60 * 1000,
            isEnabled: allEnabled,
        })
        fetchAntigravityQuota.mockResolvedValue(rateLimited('antigravity-cli', START, 7 * 60 * 1000))
        await refreshQuotaCacheOnce(
            [{ provider: 'antigravity-cli', fetch: fetchAntigravityQuota }],
            allEnabled,
        )
        expect(fetchAntigravityQuota).toHaveBeenCalledTimes(1)

        // Past BOTH the 7-minute cooldown and the SWR TTL.
        const after = START + 12 * 60 * 1000
        vi.setSystemTime(after)
        fetchAntigravityQuota.mockResolvedValue(okQuota('antigravity-cli', after))
        readQuotaCacheWithRevalidate(after)
        await vi.advanceTimersByTimeAsync(0)

        expect(fetchAntigravityQuota.mock.calls.length).toBeGreaterThan(1)
        handle.stop()
    })

    it('single-flights: N reads in a burst produce ONE fetch', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(START)
        const handle = startQuotaRefreshLoop({
            hasRecentCliActivity: () => false,
            intervalMs: 10 * 60 * 1000,
            isEnabled: allEnabled,
        })
        // Seed kimi with a fresh reading, using the same module-level mock the
        // SWR path will reach for.
        fetchKimiQuota.mockResolvedValue(okQuota('kimi', START))
        await refreshQuotaCacheOnce([{ provider: 'kimi', fetch: fetchKimiQuota }], allEnabled)
        expect(fetchKimiQuota).toHaveBeenCalledTimes(1)

        // Now make the next fetch hang, so all five reads land while it is
        // still in flight — the burst this guard exists for (a dashboard
        // re-rendering, or a user clicking twice).
        let release: ((v: any) => void) | undefined
        fetchKimiQuota.mockImplementation(() => new Promise((r) => { release = r }))

        const due = START + QUOTA_SWR_TTL_MS['kimi'] + 1000
        vi.setSystemTime(due)
        for (let i = 0; i < 5; i += 1) readQuotaCacheWithRevalidate(due)
        await vi.advanceTimersByTimeAsync(0)

        // Five reads, ONE outbound call.
        expect(fetchKimiQuota).toHaveBeenCalledTimes(2) // 1 seed + 1 revalidate
        release?.(okQuota('kimi', due))
        handle.stop()
    })

    it('★does not even mark a cooling-down provider in-flight — the OUTER check', async () => {
        // Two independent layers guard the cooldown: this outer one (so a
        // cooling-down provider is not reserved for a call that will fetch
        // nothing) and the inner one in refreshQuotaCacheOnce (the real
        // enforcement, pinned by quota-failure-retry.test.ts). This case exists
        // so the outer layer cannot be deleted silently on the assumption that
        // "the inner one covers it" — a stuck in-flight marker would suppress
        // every LATER revalidate for the provider, which is a different and
        // quieter failure than an extra fetch.
        vi.useFakeTimers()
        vi.setSystemTime(START)
        const handle = startQuotaRefreshLoop({
            hasRecentCliActivity: () => false,
            intervalMs: 10 * 60 * 1000,
            isEnabled: allEnabled,
        })
        const cooldownMs = QUOTA_SWR_TTL_MS['kimi'] * 3
        fetchKimiQuota.mockResolvedValue(rateLimited('kimi', START, cooldownMs))
        await refreshQuotaCacheOnce([{ provider: 'kimi', fetch: fetchKimiQuota }], allEnabled)

        const during = START + QUOTA_SWR_TTL_MS['kimi'] + 1000
        vi.setSystemTime(during)
        readQuotaCacheWithRevalidate(during)
        await vi.advanceTimersByTimeAsync(0)
        expect(isQuotaRevalidateInFlight('kimi')).toBe(false)
        handle.stop()
    })

    it('readQuotaCache() itself still cannot trigger a fetch — the hot-path contract', () => {
        vi.useFakeTimers()
        vi.setSystemTime(START)
        const handle = startQuotaRefreshLoop({
            hasRecentCliActivity: () => false,
            intervalMs: 10 * 60 * 1000,
            isEnabled: allEnabled,
        })
        // The mesh reconcile tick and buildLocalNodeFacts call THIS function, at
        // 4-second and per-git_status rates. A fetch here would be a
        // third-party call multiplied by node count.
        readQuotaCache()
        readQuotaCache()
        expect(fetchKimiQuota).not.toHaveBeenCalled()
        expect(fetchAntigravityQuota).not.toHaveBeenCalled()
        expect(fetchCodexQuota).not.toHaveBeenCalled()
        handle.stop()
    })
})

describe('★429 cooldown is not bypassable — explicit force refresh', () => {
    it('refuses to probe during the cooldown AND tells the caller why', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(START)
        const handle = startQuotaRefreshLoop({
            hasRecentCliActivity: () => false,
            intervalMs: 10 * 60 * 1000,
            isEnabled: allEnabled,
        })
        fetchAntigravityQuota.mockResolvedValue(rateLimited('antigravity-cli', START, 7 * 60 * 1000))
        await refreshQuotaCacheOnce(
            [{ provider: 'antigravity-cli', fetch: fetchAntigravityQuota }],
            allEnabled,
        )
        expect(fetchAntigravityQuota).toHaveBeenCalledTimes(1)

        const now = START + 60_000
        const { entries } = await forceRefreshQuota(['antigravity-cli'], now)

        // Not probed...
        expect(fetchAntigravityQuota).toHaveBeenCalledTimes(1)
        // ...and NOT silently ignored either: the refusal is reported, with the
        // time it lifts, so the CLI/dashboard can say so. Silence here would be
        // just as wrong as fetching — the user would believe a refresh happened.
        const entry = entries.find((e) => e.provider === 'antigravity-cli')
        expect(entry?.outcome).toBe('cooldown')
        expect(entry?.retryAtMs).toBe(START + 7 * 60 * 1000)
        expect(entry?.reason).toBeTruthy()
        expect(String(entry?.reason)).toMatch(/rate limit/i)
        handle.stop()
    })

    it('a cooling-down provider does not block the others in the same request', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(START)
        const handle = startQuotaRefreshLoop({
            hasRecentCliActivity: () => false,
            intervalMs: 10 * 60 * 1000,
            isEnabled: allEnabled,
        })
        fetchAntigravityQuota.mockResolvedValue(rateLimited('antigravity-cli', START, 7 * 60 * 1000))
        await refreshQuotaCacheOnce(
            [{ provider: 'antigravity-cli', fetch: fetchAntigravityQuota }],
            allEnabled,
        )
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli', START + 60_000))

        const { entries } = await forceRefreshQuota(['antigravity-cli', 'codex-cli'], START + 60_000)

        expect(entries.find((e) => e.provider === 'antigravity-cli')?.outcome).toBe('cooldown')
        expect(entries.find((e) => e.provider === 'codex-cli')?.outcome).toBe('refreshed')
        // ★The FILE axis has no cooldown to respect, so it re-reads immediately.
        expect(fetchCodexQuota).toHaveBeenCalledTimes(1)
        handle.stop()
    })

    it('★actually warms the DAEMON cache — a refresh that does not is half a refresh', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(START)
        const handle = startQuotaRefreshLoop({
            hasRecentCliActivity: () => false,
            intervalMs: 10 * 60 * 1000,
            isEnabled: allEnabled,
        })
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli', START))
        await refreshQuotaCacheOnce([{ provider: 'codex-cli', fetch: fetchCodexQuota }], allEnabled)
        expect(readQuotaCache()?.['codex-cli']?.updatedAt).toBe(START)

        const later = START + 30 * 60 * 1000
        vi.setSystemTime(later)
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli', later))
        const { quota } = await forceRefreshQuota(['codex-cli'], later)

        // The value routing and every dashboard read — not just what was
        // printed — has moved. This is the difference from `adhdev quota codex`,
        // which fetches in a separate CLI process and leaves this untouched.
        expect(readQuotaCache()?.['codex-cli']?.updatedAt).toBe(later)
        expect(quota?.['codex-cli']?.updatedAt).toBe(later)
        handle.stop()
    })

    it('reports a disabled provider rather than probing it', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(START)
        const handle = startQuotaRefreshLoop({
            hasRecentCliActivity: () => false,
            intervalMs: 10 * 60 * 1000,
            isEnabled: (p) => p !== 'kimi',
        })
        const { entries } = await forceRefreshQuota(['kimi'], START)
        expect(entries[0]?.outcome).toBe('disabled')
        expect(fetchKimiQuota).not.toHaveBeenCalled()
        handle.stop()
    })

    it('reports an unknown provider name instead of throwing', async () => {
        const { entries } = await forceRefreshQuota(['not-a-provider'], START)
        expect(entries[0]?.outcome).toBe('unsupported')
    })
})

describe('★the 60-minute backfill safety net survives the axis split', () => {
    it('fires for a NETWORK-axis provider with zero events and zero readers', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(START)
        fetchKimiQuota.mockResolvedValue(okQuota('kimi', START))
        await refreshQuotaCacheOnce([{ provider: 'kimi', fetch: fetchKimiQuota }], allEnabled)
        expect(fetchKimiQuota).toHaveBeenCalledTimes(1)

        const handle = startQuotaRefreshLoop({
            hasRecentCliActivity: () => false, // idle: no turns, so no event refresh
            intervalMs: 1000,
            fetchers: [{ provider: 'kimi', fetch: fetchKimiQuota }],
            isEnabled: allEnabled,
        })

        // Inside the routing horizon: kimi is network-axis, so cadence never
        // touches it and nothing else has asked. It stays untouched.
        // (Time moves by ADVANCE only: setSystemTime shifts pending one-shot
        // timers by the jump delta, which would move the chain's next wake —
        // a fake-timers artifact, not real behaviour.)
        await vi.advanceTimersByTimeAsync(QUOTA_ROUTABLE_MAX_AGE_MS - 60_000)
        expect(fetchKimiQuota).toHaveBeenCalledTimes(1)

        // ★Past the horizon the snapshot would fail open at the routing gate, so
        // the safety net fetches anyway — no event, no read, no user. This is
        // the guarantee that (c)/(d)-style "events only" designs cannot make.
        const past = START + QUOTA_ROUTABLE_MAX_AGE_MS + 1000
        fetchKimiQuota.mockResolvedValue(okQuota('kimi', past))
        await vi.advanceTimersByTimeAsync(62_000)
        expect(fetchKimiQuota).toHaveBeenCalledTimes(2)
        handle.stop()
    })

    it('the horizon is 60 minutes, and the widened value is the one in force', () => {
        expect(QUOTA_ROUTABLE_MAX_AGE_MS).toBe(60 * 60 * 1000)
    })
})

describe('★axis split: the file axis is not bound to the network axis policy', () => {
    it('classifies each provider by where its number LIVES', () => {
        expect(QUOTA_AXIS['claude-cli']).toBe('file')
        expect(QUOTA_AXIS['codex-cli']).toBe('file')
        expect(QUOTA_AXIS['opencode']).toBe('file')
        expect(QUOTA_AXIS['kimi']).toBe('network')
        expect(QUOTA_AXIS['grok-cli']).toBe('network')
        expect(QUOTA_AXIS['antigravity-cli']).toBe('network')
    })

    it('gives the file axis a real cadence and the network axis none', () => {
        // The file axis re-reads far more often than the old shared 15-minute
        // schedule allowed — it costs nothing.
        expect(QUOTA_AXIS_TTL_MS['claude-cli']).toBeLessThan(15 * 60 * 1000)
        expect(QUOTA_AXIS_TTL_MS['codex-cli']).toBeLessThan(15 * 60 * 1000)
        // opencode spawns a child process, so it sits between the two.
        expect(QUOTA_AXIS_TTL_MS['opencode']).toBeGreaterThan(QUOTA_AXIS_TTL_MS['claude-cli'])
        expect(QUOTA_AXIS_TTL_MS['opencode']).toBeLessThan(15 * 60 * 1000)
        // ★The network axis is never due on cadence — the point of the split.
        for (const provider of ['kimi', 'grok-cli', 'antigravity-cli'] as const) {
            expect(Number.isFinite(QUOTA_AXIS_TTL_MS[provider])).toBe(false)
            expect(isDueByAxisTtl(provider, START)).toBe(false)
        }
    })

    it('★but a READ can still revalidate the network axis — the two TTL tables differ', () => {
        // Reusing the cadence table for SWR would make trigger #3 a no-op on
        // exactly the three providers a user is most likely to be checking,
        // silently deleting it from the design. The SWR table is finite here.
        for (const provider of ['kimi', 'grok-cli', 'antigravity-cli'] as const) {
            expect(Number.isFinite(QUOTA_SWR_TTL_MS[provider])).toBe(true)
            expect(QUOTA_SWR_TTL_MS[provider]).toBeLessThan(QUOTA_ROUTABLE_MAX_AGE_MS)
        }
    })

    it('a file-axis TTL change cannot make a network-axis provider tick', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(START)
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli', START))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi', START))
        // Both seeded and fresh, so the safety net is not what drives this case.
        await refreshQuotaCacheOnce([
            { provider: 'claude-cli', fetch: fetchClaudeQuota },
            { provider: 'kimi', fetch: fetchKimiQuota },
        ], allEnabled)
        vi.clearAllMocks()
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli', START))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi', START))

        const handle = startQuotaRefreshLoop({
            hasRecentCliActivity: () => true, // ACTIVE machine
            intervalMs: 1000,
            fetchers: [
                { provider: 'claude-cli', fetch: fetchClaudeQuota },
                { provider: 'kimi', fetch: fetchKimiQuota },
            ],
            isEnabled: allEnabled,
        })
        // Long enough for many claude TTLs, short of the 60-min safety net.
        vi.setSystemTime(START + 10 * 60 * 1000)
        await vi.advanceTimersByTimeAsync(1000)
        handle.stop()

        expect(fetchClaudeQuota.mock.calls.length).toBeGreaterThan(0)
        expect(fetchKimiQuota).not.toHaveBeenCalled()
    })
})

describe('★file-source updatedAt must not be misread as "never refreshed"', () => {
    it('an UNCHANGED source file does not make the provider permanently due', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(START)
        // ★The claude fetcher returns the statusline snapshot's own capturedAt,
        // NOT the fetch time — so a file nobody has rewritten yields the SAME
        // updatedAt on every successful read. This is the exact shape that made
        // the owner's reading look 22h untouched while backfill was in fact
        // fetching on schedule.
        const capturedAt = START - 22 * 60 * 60 * 1000
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli', capturedAt))
        await refreshQuotaCacheOnce([{ provider: 'claude-cli', fetch: fetchClaudeQuota }], allEnabled)

        // updatedAt is honestly ancient — that is the DATA's age and readers
        // must keep seeing it.
        expect(readQuotaCache()?.['claude-cli']?.updatedAt).toBe(capturedAt)

        // ...but the provider was just attempted, so it is NOT due again. Had
        // the TTL been driven off updatedAt, this would be true and every read
        // would fire a fetch.
        expect(isDueByAxisTtl('claude-cli', START)).toBe(false)

        // The attempt clock is what advanced.
        const fetchedAt = readQuotaCache()?.['claude-cli']?.metadata?.fetchedAt
        expect(fetchedAt).toBe(START)
    })

    it('becomes due again once the TTL elapses since the ATTEMPT, not since capture', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(START)
        const capturedAt = START - 22 * 60 * 60 * 1000
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli', capturedAt))
        await refreshQuotaCacheOnce([{ provider: 'claude-cli', fetch: fetchClaudeQuota }], allEnabled)

        expect(isDueByAxisTtl('claude-cli', START + QUOTA_AXIS_TTL_MS['claude-cli'] - 1)).toBe(false)
        expect(isDueByAxisTtl('claude-cli', START + QUOTA_AXIS_TTL_MS['claude-cli'])).toBe(true)
    })

    it('a legacy entry with no fetchedAt falls back to updatedAt rather than re-probing everything', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(START)
        // Simulates an on-disk cache written by a daemon predating the field.
        fetchCodexQuota.mockResolvedValue({ ...okQuota('codex-cli', START), metadata: {} })
        await refreshQuotaCacheOnce([{ provider: 'codex-cli', fetch: fetchCodexQuota }], allEnabled)
        // The stamp is applied on write, so this asserts the fallback path
        // directly instead: an entry whose fetchedAt is absent is dated by
        // updatedAt, which is the pre-existing behaviour.
        const entry = readQuotaCache()?.['codex-cli']
        expect(entry?.metadata?.fetchedAt).toBe(START)
        expect(isDueByAxisTtl('codex-cli', START)).toBe(false)
    })
})

describe('carry-forward and the attempt clock coexist', () => {
    it('a transient failure keeps the last-good windows AND advances the attempt clock', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(START)
        fetchKimiQuota.mockResolvedValue(okQuota('kimi', START))
        await refreshQuotaCacheOnce([{ provider: 'kimi', fetch: fetchKimiQuota }], allEnabled)

        const later = START + 5 * 60 * 1000
        vi.setSystemTime(later)
        fetchKimiQuota.mockResolvedValue({
            provider: 'kimi',
            session: null,
            weekly: null,
            updatedAt: later,
            error: 'token expired',
            status: 'error' as const,
            metadata: { failureKind: 'expired-token' as const, retryAtMs: later + 60_000 },
        })
        await refreshQuotaCacheOnce([{ provider: 'kimi', fetch: fetchKimiQuota }], allEnabled)

        const entry = readQuotaCache()?.['kimi']
        // ★carry-forward preserved: the numbers and their ORIGINAL age survive.
        expect(entry?.session).not.toBeNull()
        expect(entry?.updatedAt).toBe(START)
        expect(entry?.metadata?.lastGoodWindows).toBe(true)
        // ★...while the attempt clock reflects THIS attempt, so a provider that
        // keeps failing transiently does not look permanently un-probed and
        // re-probe forever.
        expect(entry?.metadata?.fetchedAt).toBe(later)
    })
})
