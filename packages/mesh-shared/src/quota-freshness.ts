/**
 * Quota snapshot freshness — the ONE decision every display surface shares.
 *
 * Why this lives in the leaf package: the dashboard chips (web-core
 * `quotaWindowCue`), the `adhdev quota` CLI (daemon-core `quota/cli.ts`) and the
 * coordinator-facing `mesh_status` fold (mcp-server `summarizeNodeQuota`) each
 * carried a hand-copied version of this rule, and a fix to one left the other
 * two telling a different story about the same snapshot. They all call
 * `assessQuotaFreshness` now; only the WORDING stays per-surface.
 *
 * Pure: plain objects in, plain object out, no clock except the `now` argument.
 */
import type { MeshNodeFactsProviderQuota } from './node-facts'

export type QuotaFreshnessCue = 'refreshing' | 'stale'

export interface QuotaFreshness {
    /** Undefined = nothing to say (a fresh reading, or no retained numbers). */
    cue?: QuotaFreshnessCue
    /**
     * Only the USER can produce a new reading (aged-out Claude statusline;
     * antigravity expired token — the daemon never redeems it). The surface
     * should say what to run, not promise a self-heal.
     */
    userMustAct: boolean
    /**
     * Unix ms by which the daemon will have looked again, for a `stale` reading
     * the daemon re-checks on its own. Absent when the user must act, when the
     * reading is `refreshing` (a retry is already scheduled), or when the check
     * is already due.
     */
    nextCheckAt?: number
}

/**
 * How long past `metadata.retryAtMs` a retry still reads as "in flight". The
 * retry timer fires at retryAtMs and the probe itself takes a few seconds; a
 * retryAtMs well in the past with no newer attempt means no retry is coming.
 */
export const QUOTA_RETRY_INFLIGHT_GRACE_MS = 60_000

/**
 * The daemon's backfill horizon: a snapshot is re-probed once it is this old
 * even on an idle machine. Mirrors daemon-core `QUOTA_ROUTABLE_MAX_AGE_MS`
 * (quota/refresh.ts); daemon-core's quota-freshness test pins the two equal.
 */
export const QUOTA_BACKFILL_HORIZON_MS = 60 * 60 * 1000

function hasUsableWindow(window: { usedPercent?: unknown } | null | undefined): boolean {
    return !!window && typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)
}

/** Does the snapshot carry any renderable number — windows OR per-pool buckets? */
function hasReading(quota: MeshNodeFactsProviderQuota): boolean {
    if (hasUsableWindow(quota.session) || hasUsableWindow(quota.weekly)) return true
    return Array.isArray(quota.buckets) && quota.buckets.some((b) => !!b && typeof b.usedPercent === 'number' && Number.isFinite(b.usedPercent))
}

function finiteMs(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * When the daemon will next look, from the snapshot alone — the same
 * "both clocks" rule the refresh loop's backfill uses (data age AND attempt
 * age must both pass the horizon). Undefined when that moment has passed.
 */
function backfillCheckAt(quota: MeshNodeFactsProviderQuota, now: number): number | undefined {
    const dataDue = finiteMs(quota.updatedAt)
    const attempted = finiteMs(quota.metadata?.fetchedAt)
    const dueAt = Math.max(
        dataDue === undefined ? Number.NEGATIVE_INFINITY : dataDue + QUOTA_BACKFILL_HORIZON_MS,
        attempted === undefined ? Number.NEGATIVE_INFINITY : attempted + QUOTA_BACKFILL_HORIZON_MS,
    )
    return Number.isFinite(dueAt) && dueAt > now ? dueAt : undefined
}

/**
 * Which freshness cue a snapshot's retained numbers should carry.
 *
 *  - `stale` + `userMustAct` — nothing will refresh it without the user:
 *      · `no-data` on any provider EXCEPT codex (Claude's statusline aged out —
 *        a session must run). Codex's `no-data` is the daemon re-reading the
 *        rollout files itself (≈60s while a CLI is active, ≤60 min idle), so it
 *        is `stale` WITHOUT userMustAct;
 *      · antigravity `expired-token` — the daemon deliberately does not redeem
 *        the refresh token. Kimi's expired-token is NOT here: its CLI refreshes
 *        the token on its own cadence.
 *  - `refreshing` — retained numbers after a transient failure with a retry
 *    actually pending. ★Honest about the end of the retry budget: once the
 *    daemon has stopped retrying (`metadata.retryExhausted`, or `retryAtMs`
 *    long past with no newer attempt) the numbers are `stale` with the next
 *    scheduled check, not "refreshing" for the up-to-60 minutes until the
 *    hourly backfill. A snapshot with NO retry bookkeeping at all (a daemon
 *    predating the stamp) keeps the old `refreshing` reading.
 */
export function assessQuotaFreshness(quota: MeshNodeFactsProviderQuota, now: number = Date.now()): QuotaFreshness {
    const meta = quota.metadata
    const kind = meta?.failureKind
    const userMustAct = (kind === 'no-data' && quota.provider !== 'codex-cli')
        || (kind === 'expired-token' && quota.provider === 'antigravity-cli')
    // Order matters: the aged-out Claude shape and the retained antigravity
    // shape both ALSO mark lastGoodWindows (mesh routing trusts retained numbers
    // until their reset), so they must be classified before the generic branch.
    if (userMustAct && hasReading(quota)) return { cue: 'stale', userMustAct: true }
    if (meta?.lastGoodWindows !== true) return { userMustAct }

    const retryAtMs = finiteMs(meta?.retryAtMs)
    const retryStopped = meta?.retryExhausted === true
        || (retryAtMs !== undefined && retryAtMs + QUOTA_RETRY_INFLIGHT_GRACE_MS < now)
    // A `no-data` retained reading (codex) has no retry at all — it is a
    // snapshot the daemon will simply look at again, never an in-flight refresh.
    if (kind !== 'no-data' && !retryStopped) return { cue: 'refreshing', userMustAct: false }
    const nextCheckAt = backfillCheckAt(quota, now)
    return nextCheckAt === undefined
        ? { cue: 'stale', userMustAct: false }
        : { cue: 'stale', userMustAct: false, nextCheckAt }
}

/** Whole minutes (min 1) until `nextCheckAt`, for the "next check ~Nm" wording. */
export function minutesUntilQuotaCheck(nextCheckAt: number, now: number = Date.now()): number {
    return Math.max(1, Math.round((nextCheckAt - now) / 60_000))
}
