/**
 * Quota-aware routing — the launch GATE and fitness SPREAD bonus that consume
 * the per-provider quota snapshots riding each node's nodeFacts bundle
 * (mesh-shared MeshNodeFacts.quota).
 *
 * Two consumers, one judgement module (mirrors mesh-node-slots.ts: a tiny
 * standalone module so importing it never drags in the assignment engine):
 *
 *   1. GATE (evaluateProviderQuotaGate): after the auto-launch loop resolves a
 *      usable (node, provider) pair, skip the pair when a fresh snapshot shows
 *      the session or weekly window nearly exhausted. The skip is a WAIT —
 *      quota recovers when the window resets — so the reasons are deliberately
 *      NOT actionable (the coordinator is not paged; the 4s reconcile retries).
 *
 *   2. SPREAD (quotaSpreadBonusByProvider): a bounded 0..spreadBonusMax bonus
 *      the caller folds into task→slot fitness, proportional to remaining
 *      headroom. The default cap (30) sits below the exact-difficulty bonus
 *      (+100), so quota expresses a PREFERENCE among equally-fit slots and can
 *      never overturn a difficulty match.
 *
 * FAIL-OPEN contract: a missing entry, a non-'ok' status, or a STALE snapshot
 * yields "no gate, no bonus" — routing on an old reading would exclude nodes
 * on data that no longer describes them (the stale-quota misexclusion failure
 * mode). Observation without confidence must be inert.
 *
 * ONE hard-block exception: a FRESH 'error' snapshot whose metadata.failureKind
 * is 'quota-exhausted' (the provider's own "usage limit reached" answer, e.g.
 * Kimi's 403) blocks the pair — that is a measured fact about the account, not
 * a guess, and launching would strand the task on a provider that cannot run
 * it. Stale exhaustion readings fail open like everything else.
 *
 * ★QUOTA TRACKING TURNED OFF is one of those missing entries, and it is a
 * DELIBERATE user choice, not a failure. A provider whose probe is disabled
 * (`machineProviders[type].quotaEnabled === false`, set from the install
 * options or the machine page) is never fetched, so it reports no snapshot and
 * lands in the fail-open branch: neither gated nor bonused, routed purely on
 * the other fitness axes exactly as it was before quota routing existed.
 *
 * That is the intended meaning of the switch — "do not read my usage" — and it
 * is the reason the switch is safe to offer at install time. But it has a
 * COST that grows as scheduling gets smarter: quota is an INPUT to routing,
 * and planned work makes it a larger one. A node that opts out is invisible to
 * every quota-derived decision, so it can be handed work a quota-aware
 * scheduler would have steered elsewhere. Preserve the fail-open direction if
 * that work lands — an opted-out node must degrade to "no quota signal", never
 * to "assumed exhausted" (which would silently strand it) and never to
 * "assumed full" (which would preferentially overload the one node that
 * declined to be measured).
 *
 * CLOCK-SKEW rule: reportedAt / updatedAt / resetsAt are all stamped on the
 * REPORTER's clock, so comparing them against the coordinator's Date.now()
 * directly would misjudge age by the skew. The age computation below therefore
 * splits in two: the snapshot's age at report time (reportedAt - updatedAt) is
 * a difference of TWO SAME-CLOCK stamps — skew cancels — and only the bundle's
 * transit age (now - reportedAt) crosses clocks, clamped at 0 so a reporter
 * clock running AHEAD reads as "fresh" rather than a negative age. The default
 * 30-minute stale threshold (two refresh cycles) absorbs any residual skew.
 *
 * Everything here is pure and synchronous: the bundle is already in memory on
 * the node record, and no function in this module may trigger a quota fetch —
 * the refresh timer owns fetching (quota/refresh.ts); readers only ever read.
 */
import type { MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared';
import {
    resolveQuotaRoutingPolicy,
    type RepoMeshQuotaRoutingPolicy,
} from '../repo-mesh-types.js';

/** Skip reasons emitted by the quota gate. Deliberately NOT listed in
 *  ACTIONABLE_SKIP_REASON_PREFIXES (mesh-queue-assignment.ts): an exhausted
 *  window RESETS, so the block clears on its own and paging the coordinator
 *  every 4s would be pure noise — the same wait-semantics precedent as the
 *  SLOT MODEL GUARD's busy outcome. */
export const PROVIDER_QUOTA_SESSION_LOW_SKIP_REASON = 'provider_quota_session_low';
export const PROVIDER_QUOTA_WEEKLY_LOW_SKIP_REASON = 'provider_quota_weekly_low';
/** Hard-block reason: the provider itself reported its plan exhausted (a fresh
 *  'error' snapshot with metadata.failureKind 'quota-exhausted'). Same WAIT
 *  semantics as the window gates — the quota resets on its own — so this is
 *  deliberately NOT actionable either. */
export const PROVIDER_QUOTA_EXHAUSTED_SKIP_REASON = 'provider_quota_exhausted';

/** Read the reported quota entry for a provider off a node's facts bundle. */
function quotaEntryFor(node: any, providerType: string): { facts: { reportedAt: number }; quota: MeshNodeFactsProviderQuota } | null {
    const facts = node?.nodeFacts;
    if (!facts || typeof facts !== 'object') return null;
    const reportedAt = Number(facts.reportedAt);
    if (!Number.isFinite(reportedAt) || reportedAt <= 0) return null;
    const quota = facts.quota?.[providerType];
    if (!quota || typeof quota !== 'object') return null;
    return { facts: { reportedAt }, quota };
}

/**
 * Age of a quota snapshot in ms, clock-skew-safe (see the module header):
 *   age = max(0, now - reportedAt)          // bundle transit, cross-clock, clamped
 *       + max(0, reportedAt - updatedAt)    // snapshot age at report, same-clock
 */
export function quotaSnapshotAgeMs(
    facts: { reportedAt: number },
    quota: { updatedAt: number },
    now: number = Date.now(),
): number {
    const updatedAt = Number(quota.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, now - facts.reportedAt) + Math.max(0, facts.reportedAt - updatedAt);
}

/** Fresh = young enough to route on. Anything older fails OPEN (callers treat
 *  stale exactly like absent). */
export function isQuotaSnapshotFresh(
    facts: { reportedAt: number },
    quota: { updatedAt: number },
    policy?: RepoMeshQuotaRoutingPolicy | null,
    now: number = Date.now(),
): boolean {
    return quotaSnapshotAgeMs(facts, quota, now) <= resolveQuotaRoutingPolicy(policy).staleAfterMs;
}

/** Remaining headroom of one window, 0–100. */
function remainingPercent(window: { usedPercent: number } | null | undefined): number | undefined {
    if (!window) return undefined;
    const used = Number(window.usedPercent);
    if (!Number.isFinite(used)) return undefined;
    return Math.min(100, Math.max(0, 100 - used));
}

export interface ProviderQuotaGateBlock {
    reason: string;
    /** 'unknown' when the block comes from an explicit exhaustion signal that
     *  does not name a window (PROVIDER_QUOTA_EXHAUSTED_SKIP_REASON). */
    window: 'session' | 'weekly' | 'unknown';
    remainingPercent: number;
    thresholdPercent: number;
}

/**
 * RESET-IMMINENT relaxation (session window only): should a session-low block
 * be WAIVED because the window resets within `imminentMs`? The session window
 * is short (~5h) and a task claimed just before the reset runs on quota that
 * reappears mid-turn, so holding the claim would idle the mesh for no benefit.
 * The weekly window gets no such relaxation — its reset is days away by
 * construction, so "imminent" never legitimately applies there.
 *
 * Clock-skew: resetsAt is stamped on the REPORTER's clock, so it is compared
 * against a reporter-clock estimate of now — the snapshot's own updatedAt aged
 * forward by the skew-safe snapshot age (the same same-clock-difference trick
 * as quotaSnapshotAgeMs). Conservative on missing data: no resetsAt stamp or
 * no usable reference time keeps the block.
 */
function isSessionResetImminent(
    session: { resetsAt?: number | null } | null | undefined,
    facts: { reportedAt: number },
    quota: { updatedAt: number },
    imminentMs: number,
    now: number,
): boolean {
    const resetsAt = Number(session?.resetsAt);
    if (!Number.isFinite(resetsAt) || resetsAt <= 0) return false; // no reset stamp → keep the block
    const ageMs = quotaSnapshotAgeMs(facts, quota, now);
    if (!Number.isFinite(ageMs)) return false; // no usable reference time → keep the block
    const reporterNowMs = Number(quota.updatedAt) + ageMs;
    return resetsAt - reporterNowMs < imminentMs;
}

/**
 * The launch GATE: should this (node, provider) pair be skipped because the
 * provider's reported quota is nearly exhausted? Returns null (launch may
 * proceed) when the quota is unknown, unmeasurable, stale, or above every
 * threshold. The gate blocks in exactly two situations, both on FRESH
 * snapshots only:
 *   1. an 'ok' snapshot with a window below its threshold, and
 *   2. an 'error' snapshot with failureKind 'quota-exhausted' — the provider's
 *      own exhaustion verdict (no window breakdown, so window is 'unknown').
 * Every other non-'ok' reading fails open.
 *
 * Thresholds are judged per window against the node's session/weekly axes —
 * the provider-agnostic vocabulary every fetcher normalizes into, so no
 * provider-specific schema is needed. A window the provider does not report
 * (null) is simply not gated on.
 *
 * One relaxation: a session-low block is WAIVED when the session window's
 * reset is imminent (within sessionResetImminentMs, default 5 min) — the
 * quota reappears on its own momentarily, so holding the claim would just
 * idle the mesh (isSessionResetImminent). The weekly gate never relaxes.
 */
export function evaluateProviderQuotaGate(
    node: any,
    providerType: string,
    policy?: RepoMeshQuotaRoutingPolicy | null,
    now: number = Date.now(),
): ProviderQuotaGateBlock | null {
    const entry = quotaEntryFor(node, providerType);
    if (!entry) return null; // never reported → unknown, not blocked
    const { facts, quota } = entry;
    if (quota.status !== 'ok') {
        // HARD BLOCK, the single exception to fail-open: a FRESH 'error'
        // snapshot whose failureKind is 'quota-exhausted' is the provider
        // itself saying "no quota until the reset" — measured fact, not a
        // guess — so launching here would burn a task slot on a provider that
        // cannot run it. Every other failure kind (unauthorized, network,
        // parse, stale, ...) still fails OPEN: looked-and-could-not-tell is
        // not a routing signal.
        if (quota.status === 'error'
            && (quota as any).metadata?.failureKind === 'quota-exhausted'
            && isQuotaSnapshotFresh(facts, quota, policy, now)) {
            return {
                reason: PROVIDER_QUOTA_EXHAUSTED_SKIP_REASON,
                window: 'unknown',
                remainingPercent: 0,
                thresholdPercent: 0,
            };
        }
        return null;
    }
    if (!isQuotaSnapshotFresh(facts, quota, policy, now)) return null; // fail-open on stale
    const resolved = resolveQuotaRoutingPolicy(policy);
    const session = remainingPercent(quota.session);
    if (session !== undefined && session < resolved.sessionMinRemainingPercent
        && !isSessionResetImminent(quota.session, facts, quota, resolved.sessionResetImminentMs, now)) {
        return {
            reason: PROVIDER_QUOTA_SESSION_LOW_SKIP_REASON,
            window: 'session',
            remainingPercent: session,
            thresholdPercent: resolved.sessionMinRemainingPercent,
        };
    }
    const weekly = remainingPercent(quota.weekly);
    if (weekly !== undefined && weekly < resolved.weeklyMinRemainingPercent) {
        return {
            reason: PROVIDER_QUOTA_WEEKLY_LOW_SKIP_REASON,
            window: 'weekly',
            remainingPercent: weekly,
            thresholdPercent: resolved.weeklyMinRemainingPercent,
        };
    }
    return null;
}

/**
 * The SPREAD input: per-provider quota-headroom bonus (0..spreadBonusMax) for
 * every provider with a fresh, usable snapshot on this node. The bonus is
 * proportional to the TIGHTEST reported window's remaining headroom (the
 * window that would gate first governs the preference). Providers with no
 * usable reading simply appear with 0 — identical to the pre-feature scoring.
 *
 * Returned as a plain map keyed by provider id so the fitness scorer stays
 * pure: its callers pass `map[slot.provider]` down as a number and the scorer
 * itself never touches node facts.
 */
export function quotaSpreadBonusByProvider(
    node: any,
    policy?: RepoMeshQuotaRoutingPolicy | null,
    now: number = Date.now(),
): Record<string, number> {
    const resolved = resolveQuotaRoutingPolicy(policy);
    const facts = node?.nodeFacts;
    const quota = facts?.quota;
    const out: Record<string, number> = {};
    if (!quota || typeof quota !== 'object') return out;
    const reportedAt = Number(facts.reportedAt);
    if (!Number.isFinite(reportedAt) || reportedAt <= 0) return out;
    for (const [provider, snapshot] of Object.entries(quota as Record<string, MeshNodeFactsProviderQuota>)) {
        let bonus = 0;
        if (snapshot && typeof snapshot === 'object' && snapshot.status === 'ok'
            && isQuotaSnapshotFresh({ reportedAt }, snapshot, policy, now)) {
            const ratios = [remainingPercent(snapshot.session), remainingPercent(snapshot.weekly)]
                .filter((r): r is number => r !== undefined)
                .map(r => r / 100);
            if (ratios.length) {
                bonus = Math.round(resolved.spreadBonusMax * Math.min(...ratios));
            }
        }
        out[provider] = bonus;
    }
    return out;
}
