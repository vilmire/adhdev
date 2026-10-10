import { describe, expect, it } from 'vitest'
import { assessQuotaFreshness, QUOTA_BACKFILL_HORIZON_MS, QUOTA_RETRY_INFLIGHT_GRACE_MS, minutesUntilQuotaCheck } from '@adhdev/mesh-shared'
import type { MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared'
import { QUOTA_ROUTABLE_MAX_AGE_MS } from '../../src/quota/refresh.js'

// The one cue decision behind web-core, `adhdev quota` and the mesh_status fold.
const NOW = 1_800_000_000_000
const MIN = 60_000
const win = (usedPercent: number) => ({ usedPercent, windowMinutes: 300, resetsAt: null })

const retained = (provider: string, metadata: Record<string, unknown>, extra: Partial<MeshNodeFactsProviderQuota> = {}): MeshNodeFactsProviderQuota => ({
    provider,
    status: 'error',
    session: win(40),
    weekly: win(20),
    updatedAt: NOW - 10 * MIN,
    error: 'x',
    metadata: { fetchedAt: NOW - 2 * MIN, lastGoodWindows: true, ...metadata },
    ...extra,
} as MeshNodeFactsProviderQuota)

describe('assessQuotaFreshness', () => {
    it('keeps the backfill horizon equal to the daemon refresh loop\'s', () => {
        expect(QUOTA_BACKFILL_HORIZON_MS).toBe(QUOTA_ROUTABLE_MAX_AGE_MS)
    })

    it('refreshing while a transient retry is pending (retryAtMs ahead)', () => {
        const q = retained('kimi', { failureKind: 'expired-token', retryAtMs: NOW + 4 * MIN })
        expect(assessQuotaFreshness(q, NOW)).toEqual({ cue: 'refreshing', userMustAct: false })
    })

    it('still refreshing while the retry probe is in flight (retryAtMs just passed)', () => {
        const q = retained('kimi', { failureKind: 'network', retryAtMs: NOW - 5_000 })
        expect(assessQuotaFreshness(q, NOW).cue).toBe('refreshing')
    })

    it('legacy snapshot with no retry bookkeeping at all keeps the old "refreshing"', () => {
        const q = retained('kimi', { failureKind: 'expired-token' })
        expect(assessQuotaFreshness(q, NOW).cue).toBe('refreshing')
    })

    it('★retry budget spent -> stale with the next scheduled check, not "refreshing" for an hour', () => {
        const q = retained('kimi', { failureKind: 'expired-token', retryAtMs: NOW - 20 * MIN, retryExhausted: true })
        const f = assessQuotaFreshness(q, NOW)
        expect(f.cue).toBe('stale')
        expect(f.userMustAct).toBe(false)
        // attempt clock (fetchedAt NOW-2m) + 60m, data clock (NOW-10m) + 60m -> the later: 58m away.
        expect(f.nextCheckAt).toBe(NOW - 2 * MIN + QUOTA_BACKFILL_HORIZON_MS)
        expect(minutesUntilQuotaCheck(f.nextCheckAt!, NOW)).toBe(58)
    })

    it('a retryAtMs long past with no newer attempt reads stale even without the exhausted flag (lost timer)', () => {
        const q = retained('kimi', { failureKind: 'network', retryAtMs: NOW - QUOTA_RETRY_INFLIGHT_GRACE_MS - 1 })
        expect(assessQuotaFreshness(q, NOW).cue).toBe('stale')
    })

    it('stale with no nextCheckAt once the backfill is already due', () => {
        const q = retained('kimi', { failureKind: 'network', retryExhausted: true, fetchedAt: NOW - 90 * MIN }, { updatedAt: NOW - 120 * MIN })
        expect(assessQuotaFreshness(q, NOW)).toEqual({ cue: 'stale', userMustAct: false })
    })

    it('claude no-data (statusline aged out) needs the USER: stale, no nextCheckAt', () => {
        const q = retained('claude-cli', { failureKind: 'no-data' })
        expect(assessQuotaFreshness(q, NOW)).toEqual({ cue: 'stale', userMustAct: true })
    })

    it('★codex no-data is the daemon re-reading rollouts itself: stale WITHOUT userMustAct, with a next check', () => {
        const q = retained('codex-cli', { failureKind: 'no-data' })
        const f = assessQuotaFreshness(q, NOW)
        expect(f.cue).toBe('stale')
        expect(f.userMustAct).toBe(false)
        expect(f.nextCheckAt).toBeGreaterThan(NOW)
    })

    it('antigravity expired token needs the USER, even though the failure kind is transient', () => {
        const q = retained('antigravity-cli', { failureKind: 'expired-token', retryAtMs: NOW + 2 * MIN })
        expect(assessQuotaFreshness(q, NOW)).toEqual({ cue: 'stale', userMustAct: true })
    })

    it('a snapshot with no lastGoodWindows and no user action has no cue', () => {
        expect(assessQuotaFreshness(retained('kimi', { failureKind: 'network', lastGoodWindows: false }), NOW)).toEqual({ userMustAct: false })
    })
})
