/**
 * Quota-aware routing — the launch GATE and fitness SPREAD bonus that consume
 * the per-provider quota snapshots riding each node's nodeFacts bundle
 * (mesh-shared MeshNodeFacts.quota), with same-daemon worktree clones falling
 * back to their clone source while their own facts are not usable yet.
 *
 * Two consumers, one judgement module (mirrors mesh-node-slots.ts: a tiny
 * standalone module so importing it never drags in the assignment engine):
 *
 *   1. GATE (evaluateProviderQuotaGate): after the auto-launch loop resolves a
 *      usable (node, provider) pair, skip the pair when a fresh snapshot shows
 *      the session or weekly window nearly exhausted. The skip is a WAIT —
 *      quota recovers when the window resets — so the reasons are deliberately
 *      NOT actionable (the coordinator is not paged; the 4s reconcile retries).
 *      rankProvidersByQuotaGate is the gate's SELECTION-LOOP form: it evaluates
 *      every usable candidate of a node and orders the survivors by weekly
 *      EXPIRY RISK (unused remainder evaporates at the window reset), so a
 *      gated first choice falls through to the node's next provider (dynamic
 *      provider priority by quota). While EVERY weekly-measured survivor has
 *      comfortable weekly headroom (sessionAxisWeeklyHeadroomPercent), the
 *      ordering axis switches to the SESSION (5h) window's expiry risk — the
 *      5h remainder evaporates permanently too, and a weekly-only ranking
 *      would let it. When any candidate's weekly window is tight, the weekly
 *      axis governs unchanged (weekly protection beats session harvest).
 *
 *   2. SPREAD (quotaSpreadBonusByProvider): a bounded 0..spreadBonusMax bonus
 *      the caller folds into task→slot fitness, proportional to remaining
 *      headroom. The default cap (30) sits below the exact-difficulty bonus
 *      (+100), so quota expresses a PREFERENCE among equally-fit slots and can
 *      never overturn a difficulty match.
 *
 * FAIL-OPEN contract (owner decision 2026-08-24 — window-boundary validity):
 * a measured window keeps gating and bonusing until ITS OWN resetsAt passes,
 * regardless of wall-clock age. Usage within a window is monotonic, so a
 * reading taken earlier in the same window is a LOWER bound on usage now — a
 * low-headroom reading can only be lower, which is exactly the safe direction
 * for a gate, and discarding it on wall-clock staleness threw away a valid
 * measurement (the all-zero "Quota +0" screen this decision reversed). What
 * still fails open: a missing entry, an unmeasurable non-'ok' status without
 * retained windows, a window whose reset has PASSED (the reading describes a
 * previous window — this is the self-healing edge that prevents a
 * permanently-stale machine from being permanently excluded), and a window
 * with no reset stamp once it ages beyond staleAfterMs (the wall-clock check
 * is the FALLBACK, not the primary rule). A non-'ok' entry participates only
 * when metadata.lastGoodWindows proves the retained windows' provenance.
 *
 * Ranking follows that same boundary rule: once a reading exists, wall-clock
 * age does not weaken it. rankProvidersByQuotaGate compares the measured risk
 * at full weight until the window resets; only a missing/unreadable reading or
 * an expired window is unknown. This avoids the self-reinforcing loop where a
 * provider whose quota refreshes only while selected becomes less selectable
 * the longer it remains idle.
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
 *
 * LIVE LOCAL READ: the nodeFacts quota bundle is a COPY restamped only on
 * git_status ingest, so routing on it lags every refresh by an unbounded
 * interval (observed 2026-08-18: a boot-time snapshot still gated — rather,
 * failed open — 165 minutes later, routing tasks onto a weekly-100% provider).
 * For a node that resolves to THIS daemon (or a worktree clone whose source
 * does), callers inject the daemon's live quota cache through
 * QuotaFactsContext.liveLocalQuota (liveLocalQuotaForRouting) and the gate
 * routes on that instead. readQuotaCache() is a synchronous in-memory Map
 * read — never a fetch — so the purity contract above is unchanged. Remote
 * nodes keep reading nodeFacts: their measurement does not exist on this
 * daemon, and no network call is made to get one.
 */
import { type MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared';
import {
    resolveQuotaRoutingPolicy,
    type RepoMeshQuotaRoutingPolicy,
} from '../repo-mesh-types.js';
import {
    quotaEntryFor,
    quotaSnapshotAgeMs,
    isQuotaSnapshotFresh,
    remainingPercent,
    logStaleQuotaFailOpen,
    logAbsentQuotaFailOpen,
    type QuotaFactsContext,
} from './mesh-quota-sources.js';

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

/** Skip reason reported when a node HAS usable provider candidates but EVERY
 *  one of them is quota-gated. Kept distinct from 'provider_priority_unusable'
 *  on purpose: that reason means a slot/CONFIGURATION problem (actionable —
 *  the coordinator is paged), while an all-gated node is a quota WAIT — the
 *  window resets on its own, the task stays pending, and re-driving the task
 *  to another node is pointless when every node shares the same provider
 *  accounts. Deliberately NOT listed in ACTIONABLE_SKIP_REASON_PREFIXES
 *  (mesh-skip-notify.ts), same WAIT semantics as the per-provider gate
 *  reasons above. */
export const ALL_PROVIDERS_QUOTA_GATED_SKIP_REASON = 'all_providers_quota_gated';

export interface ProviderQuotaGateBlock {
    reason: string;
    /** 'unknown' when the block comes from an explicit exhaustion signal that
     *  does not name a window (PROVIDER_QUOTA_EXHAUSTED_SKIP_REASON). */
    window: 'session' | 'weekly' | 'unknown';
    remainingPercent: number;
    thresholdPercent: number;
}

/** The concrete slot the gate is deciding for. Model is optional because
 * idle-session and legacy callers know only the provider; absence deliberately
 * preserves the provider headline gate rather than guessing a bucket. */
interface ProviderQuotaGateTarget {
    model?: string | null;
}

type QuotaGateWindow = {
    usedPercent: number;
    windowMinutes: number;
    resetsAt?: number | null;
};

type AntigravityQuotaPool = 'gemini' | 'claude-gpt';

function antigravityPoolFromLeadingLabel(value: string | null | undefined): AntigravityQuotaPool | undefined {
    const label = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (/^gemini(?:[\s/_-]|$)/.test(label)) return 'gemini';
    if (/^(?:claude|gpt)(?:[\s/_-]|$)/.test(label)) return 'claude-gpt';
    return undefined;
}

function worstBucketWindow(
    buckets: QuotaGateWindow[],
    targetMinutes: number,
): QuotaGateWindow | null {
    const tolerance = targetMinutes * 0.1;
    const matches = buckets.filter(bucket => {
        const windowMinutes = Number(bucket.windowMinutes);
        return Number.isFinite(windowMinutes)
            && windowMinutes > 0
            && Math.abs(windowMinutes - targetMinutes) <= tolerance;
    });
    if (!matches.length) return null;
    return matches.reduce((worst, bucket) => (
        Number(bucket.usedPercent) > Number(worst.usedPercent) ? bucket : worst
    ));
}

/**
 * Resolve the normalized axes for the Antigravity pool used by one concrete
 * slot model. The fetcher intentionally keeps `session`/`weekly` as the worst
 * pool headline; this routing-only projection reads the already-preserved
 * buckets without changing that contract for any other consumer.
 *
 * Mapping is admitted only for the labels verified on both sides of the
 * provider contract: Antigravity models lead with Gemini / Claude / GPT, and
 * grouped bucket names lead with Gemini Models / Claude/GPT. Every bucket must
 * be classifiable and every headline axis must have a matching selected-pool
 * bucket. Anything else returns undefined, which makes the caller retain the
 * existing worst-headline decision (fail closed; never guess a pool).
 */
function quotaWindowsForGateTarget(
    providerType: string,
    quota: MeshNodeFactsProviderQuota,
    target?: ProviderQuotaGateTarget | null,
): { session: QuotaGateWindow | null; weekly: QuotaGateWindow | null } | undefined {
    if (providerType !== 'antigravity-cli' || quota.status !== 'ok') return undefined;
    const selectedPool = antigravityPoolFromLeadingLabel(target?.model);
    if (!selectedPool || !Array.isArray(quota.buckets) || !quota.buckets.length) return undefined;

    const classified: Array<{ bucket: QuotaGateWindow; pool: AntigravityQuotaPool }> = [];
    for (const bucket of quota.buckets) {
        const pool = antigravityPoolFromLeadingLabel(bucket?.name);
        const usedPercent = Number(bucket?.usedPercent);
        const windowMinutes = Number(bucket?.windowMinutes);
        if (!pool || !Number.isFinite(usedPercent) || !Number.isFinite(windowMinutes)) return undefined;
        classified.push({
            pool,
            bucket: { usedPercent, windowMinutes, resetsAt: bucket.resetsAt },
        });
    }
    const selectedBuckets = classified
        .filter(entry => entry.pool === selectedPool)
        .map(entry => entry.bucket);
    if (!selectedBuckets.length) return undefined;

    const session = worstBucketWindow(selectedBuckets, DEFAULT_SESSION_WINDOW_MINUTES);
    const weekly = worstBucketWindow(selectedBuckets, DEFAULT_WEEKLY_WINDOW_MINUTES);
    // A provider headline proves that axis exists somewhere. If the selected
    // pool has no corresponding readable bucket, the decomposition is partial;
    // retain the headline rather than treating the missing selected window as
    // unlimited.
    if ((quota.session && !session) || (quota.weekly && !weekly)) return undefined;
    return { session, weekly };
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
 * A measured window remains authoritative until that SAME window resets —
 * for 'ok' snapshots and retained last-good windows alike (owner decision
 * 2026-08-24; previously only the retained path used this rule and 'ok'
 * snapshots were discarded wholesale at staleAfterMs). This is deliberately
 * per-window: session and weekly reset on different schedules. A valid reset
 * stamp supersedes snapshot age in both directions — future means the
 * observed low-water mark still applies, past means the old window is gone.
 * If the reset stamp cannot be read, preserve the existing staleAfterMs
 * fail-open fallback.
 *
 * resetsAt and updatedAt are reporter-clock stamps, so compare resetsAt with
 * the same skew-safe reporter-now estimate used by the reset-imminent logic.
 */
export function isWindowTrustworthy(
    window: { resetsAt?: number | null } | null | undefined,
    facts: { reportedAt: number },
    quota: { updatedAt: number },
    policy: RepoMeshQuotaRoutingPolicy | null | undefined,
    now: number,
): boolean {
    return !isWindowExpired(window, facts, quota, now)
        && isWindowBoundaryKnown(window, facts, quota, policy, now);
}

function isWindowBoundaryKnown(
    window: { resetsAt?: number | null } | null | undefined,
    facts: { reportedAt: number },
    quota: { updatedAt: number },
    policy: RepoMeshQuotaRoutingPolicy | null | undefined,
    now: number,
): boolean {
    const resetsAt = Number(window?.resetsAt);
    if (!Number.isFinite(resetsAt) || resetsAt <= 0) {
        return isQuotaSnapshotFresh(facts, quota, policy, now);
    }
    return true;
}

/**
 * Has a measured window's own reset boundary already passed? Used directly by
 * the gate layer: a window whose reset is in the past describes a previous
 * window and must never be used as a reason to block a claim. The same
 * clock-skew-safe reporter-now estimate as isWindowTrustworthy is used.
 *
 * A missing or unparseable resetsAt stamp is NOT considered expired by this
 * boundary check; it falls back to wall-clock freshness via isWindowBoundaryKnown.
 */
function isWindowExpired(
    window: { resetsAt?: number | null } | null | undefined,
    facts: { reportedAt: number },
    quota: { updatedAt: number },
    now: number,
): boolean {
    const resetsAt = Number(window?.resetsAt);
    if (!Number.isFinite(resetsAt) || resetsAt <= 0) return false;
    const ageMs = quotaSnapshotAgeMs(facts, quota, now);
    if (!Number.isFinite(ageMs)) return false;
    const reporterNowMs = Number(quota.updatedAt) + ageMs;
    if (!Number.isFinite(reporterNowMs)) return false;
    return reporterNowMs >= resetsAt;
}

/**
 * The launch GATE: should this (node, provider) pair be skipped because the
 * provider's reported quota is nearly exhausted? Returns null (launch may
 * proceed) when the quota is unknown, unmeasurable, past every window's reset
 * boundary, or above every threshold. The gate blocks in exactly three
 * situations:
 *   1. an 'ok' snapshot with a trustworthy window below its threshold, and
 *   2. a FRESH 'error' snapshot with failureKind 'quota-exhausted' — the
 *      provider's own exhaustion verdict (no window breakdown, so window is
 *      'unknown'; the one remaining wall-clock-fresh-only block),
 *   3. a non-'ok' snapshot marked lastGoodWindows whose retained window is
 *      below its threshold.
 * Every other non-'ok' reading fails open. Trust is per window
 * (isWindowTrustworthy): a measured window governs until its own resetsAt —
 * wall-clock staleness alone no longer discards it (owner decision
 * 2026-08-24) — and a missing/unparseable resetsAt uses the staleAfterMs
 * fallback because carry-forward preserves the ORIGINAL updatedAt.
 *
 * Thresholds are judged per window against the node's session/weekly axes. An
 * Antigravity slot with a verified model-to-pool mapping projects those axes
 * from its buckets; absent or uncertain detail retains the headline axes. A
 * window the provider does not report (null) is simply not gated on.
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
    context?: QuotaFactsContext | null,
    target?: ProviderQuotaGateTarget | null,
): ProviderQuotaGateBlock | null {
    const entry = quotaEntryFor(node, providerType, context, now);
    if (!entry) {
        logAbsentQuotaFailOpen(node, providerType, policy, now, context);
        return null; // never reported → unknown, not blocked
    }
    const { facts, quota } = entry;
    const targetWindows = quotaWindowsForGateTarget(providerType, quota, target);
    const sessionWindow = targetWindows ? targetWindows.session : quota.session;
    const weeklyWindow = targetWindows ? targetWindows.weekly : quota.weekly;
    let sessionTrustworthy = true;
    let weeklyTrustworthy = true;
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
        // A transient probe failure may retain the last successfully observed
        // windows. Provenance is mandatory; trust is then decided per window
        // by that window's own reset boundary. Missing reset stamps retain the
        // prior updatedAt freshness fallback.
        if ((quota as any).metadata?.lastGoodWindows !== true) return null;
        sessionTrustworthy = isWindowTrustworthy(sessionWindow, facts, quota, policy, now);
        weeklyTrustworthy = isWindowTrustworthy(weeklyWindow, facts, quota, policy, now);
    } else {
        // 'ok' snapshots: each window keeps gating until its own resetsAt
        // (owner decision 2026-08-24) — a wall-clock-stale reading still
        // describes the CURRENT window while its reset lies ahead, and usage
        // is monotonic within a window, so a low reading can only be lower
        // now. A window whose reset has passed, or that carries no reset
        // stamp once the snapshot ages beyond staleAfterMs, drops out; when
        // BOTH drop out the snapshot fails open exactly as before.
        sessionTrustworthy = isWindowTrustworthy(sessionWindow, facts, quota, policy, now);
        weeklyTrustworthy = isWindowTrustworthy(weeklyWindow, facts, quota, policy, now);
    }
    // GATE-LEVEL DEFENSE: isWindowTrustworthy already discards windows whose
    // own resetsAt has passed, but re-assert the invariant here so a boundary
    // regression cannot turn an expired reading into a block reason. A session
    // or weekly window whose reset boundary is behind the reporter's clock
    // describes a previous window and must never be used to deny a claim.
    if (sessionTrustworthy && isWindowExpired(sessionWindow, facts, quota, now)) sessionTrustworthy = false;
    if (weeklyTrustworthy && isWindowExpired(weeklyWindow, facts, quota, now)) weeklyTrustworthy = false;
    if (quota.status === 'ok' && !sessionTrustworthy && !weeklyTrustworthy) {
        if (!isQuotaSnapshotFresh(facts, quota, policy, now)) {
            logStaleQuotaFailOpen(node, providerType, facts, quota, policy, now, context);
        }
        return null; // no window survives its own boundary → fail open
    }
    const resolved = resolveQuotaRoutingPolicy(policy);
    const session = remainingPercent(sessionWindow);
    if (sessionTrustworthy && session !== undefined && session < resolved.sessionMinRemainingPercent
        && !isSessionResetImminent(sessionWindow, facts, quota, resolved.sessionResetImminentMs, now)) {
        return {
            reason: PROVIDER_QUOTA_SESSION_LOW_SKIP_REASON,
            window: 'session',
            remainingPercent: session,
            thresholdPercent: resolved.sessionMinRemainingPercent,
        };
    }
    const weekly = remainingPercent(weeklyWindow);
    if (weeklyTrustworthy && weekly !== undefined && weekly < resolved.weeklyMinRemainingPercent) {
        return {
            reason: PROVIDER_QUOTA_WEEKLY_LOW_SKIP_REASON,
            window: 'weekly',
            remainingPercent: weekly,
            thresholdPercent: resolved.weeklyMinRemainingPercent,
        };
    }
    return null;
}

/** Fallback weekly-window length when a snapshot reports a weekly window
 *  without its windowMinutes (every in-tree fetcher fills it; this only
 *  guards malformed/foreign bundles). */
const DEFAULT_WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

/** Fallback session-window length (~5h), same malformed-bundle guard as the
 *  weekly one. */
const DEFAULT_SESSION_WINDOW_MINUTES = 5 * 60;

/**
 * The expiry-risk score itself, split out so the formula is testable in
 * isolation from snapshot plumbing (clock skew, window authority, fail-open).
 *
 *   risk = remaining² / (remaining + 100 × timeLeftFraction)
 *
 * = remaining × the share of it that even-pace consumption cannot clear in the
 * time left. HIGHER = spend this provider SOONER. See expiryRiskForRanking for
 * the full rationale, the biases this replaced, and the divergence guard.
 *
 * @param remainingPercent 0..100 headroom left on the axis.
 * @param timeLeftFraction 0..1 share of the window still to run — time
 *        REMAINING, not elapsed. 1 = just reset, 0 = at the reset edge.
 * @returns 0..remainingPercent, monotone increasing in remainingPercent and
 *          monotone decreasing in timeLeftFraction.
 */
function expiryRiskScore(remainingPercent: number, timeLeftFraction: number): number {
    // remaining = 0 zeroes the denominator too; nothing left to lose ⇒ no risk.
    if (!(remainingPercent > 0)) return 0;
    return (remainingPercent * remainingPercent)
        / (remainingPercent + 100 * timeLeftFraction);
}

/** Ranking metric for one candidate on one window axis, or undefined when even
 *  the axis's REMAINING is unknown (no snapshot, no such window, unreadable
 *  measurement, or a window whose resetsAt has passed). */
interface ExpiryRisk {
    remainingPercent: number;
    /** Expiry-risk score — see rankProvidersByQuotaGate. Bounded by
     *  remainingPercent, so it can never diverge. */
    risk: number;
}

/**
 * Expiry-risk metric: how much of this provider's remainder on one window axis
 * ('weekly' or 'session') is likely to EVAPORATE unused at the window reset if
 * it is not consumed now.
 *
 *   risk = remaining² / (remaining + 100 × timeLeftFraction)
 *   timeLeftFraction = clamp((resetsAt − reporterNow) / windowMs, 0, 1)
 *
 * Read it as remaining × the UNSPENDABLE SHARE of that remainder:
 *
 *   risk = remaining × [ remaining / (remaining + 100 × timeLeftFraction) ]
 *
 * The bracket is the fraction of the remainder that EVEN-PACE consumption
 * cannot clear in the time left. "Even pace" is the only pace this module can
 * assume — it has no burn-rate history and deliberately acquires none (see the
 * DIVERGENCE GUARD below) — so it compares each provider's remainder against
 * the 100 × timeLeftFraction points an evenly-paced consumer would still get
 * through. A provider holding more than that is over-supplied and its excess
 * is on track to evaporate; the more lopsided the ratio, the higher the risk.
 *
 * ★REPLACED remaining × elapsedFraction (73f3146d) 2026-08-28 — owner-directed,
 * on measured fleet data. That formula was use-it-or-lose-it in intent but
 * produced two biases, and they were two faces of ONE error: it treated a
 * distant reset as evidence of SAFETY, when a distant reset on a large
 * remainder is exactly what predicts loss.
 *
 *   STARVATION. elapsedFraction is small early in a window, so a provider with
 *   a far reset scored near zero no matter how much it was holding. Measured
 *   2026-08-28: codex at 66% weekly remaining with 6.4 days to reset scored
 *   5.66 — dead last behind claude (31%/2d → 22.14) and kimi (50%/4d → 21.43)
 *   — and took ZERO dispatches all day while claude, already the most consumed,
 *   kept winning and drained first.
 *
 *   CLIFF. The same shape deferred a large remainder until its window was
 *   nearly gone, at which point risk finally spiked but no time remained to
 *   burn it. The formula meant to prevent evaporation was CAUSING it.
 *
 * The new form fixes both from one change of variable — it is driven by time
 * REMAINING against the remainder, not time ELAPSED. codex's 66%/6.4d now
 * scores 27.67 and leads (66%/6.4d needs ~10.3 points/day of attention to
 * clear; claude's 31%/2d needs ~15.5 but is a far smaller total loss if
 * missed), so the over-supplied provider is spread into EARLY, not left to
 * expire late.
 *
 * ★DIVERGENCE GUARD (the reason this is not plain "required burn rate").
 * remaining/timeLeft — the model rejected when 73f3146d was written, and still
 * rejected — diverges as timeLeft → 0, letting a 1% remainder at the reset
 * edge outrank a 90% one. This form is its SATURATING counterpart: the same
 * urgency signal, bounded. Because the denominator carries `remaining` as its
 * own floor, risk ≤ remaining identically (equality only at timeLeft = 0), so
 * a trivial remainder can never beat a substantial one — a 1% remainder at the
 * literal reset edge tops out at 1.0, far below a 90% remainder's 55.1 with
 * days to spare. Verified across the full (remaining, timeLeft) grid: zero
 * bound violations, monotone increasing in remaining, monotone decreasing in
 * time left. No parameter, no tuning knob, no burn-rate history.
 *
 * ★WHAT THIS INTENTIONALLY CHANGED: a large remainder right after a reset is
 * no longer deferred behind a small one near its reset (99%/7d now leads
 * 20%/2h, 49.25 vs 18.88). That inversion IS the cliff fix — deferring the big
 * remainder is precisely what strands it — and is owner-ratified, not
 * incidental. A 7-day window clears ~14 points/day at even pace, so a 99%
 * remainder is already behind schedule the moment the window opens, while the
 * 20% one can lose at most 20 points. Do not "restore" the old ordering here
 * without reopening that decision.
 *
 * ONE formula, both axes: the session (~5h) and weekly (~7d) windows report
 * the same shape (usedPercent/windowMinutes/resetsAt), so the axis selects
 * only which window is read — the math is not duplicated.
 *
 * Clock-skew: resetsAt is stamped on the REPORTER's clock, so timeLeft is
 * computed against the skew-safe reporter-now estimate (updatedAt + snapshot
 * age — the same same-clock-difference trick as isSessionResetImminent).
 *
 * Window authority is exactly the gate/bonus authority: a window only ranks
 * while isWindowTrustworthy says it still describes the current reset
 * period. A past reset, an unusable reporter clock, or an aged window without
 * a reset stamp is therefore unreadable on this axis. A fresh window without
 * a reset stamp remains readable with risk 0 — no evidence of imminent loss
 * means no invented urgency.
 *
 * Retained readings are admitted here rather than rejected: once a snapshot
 * carries a real window, its measured risk is trusted at the same weight as a
 * freshly fetched reading until that window resets. Only a snapshot with NO
 * readable window at all — never measured, opted out, a failure that erased
 * its numbers, or a window past resetsAt — returns undefined.
 *
 * ★What is NOT admitted: this function never invents a reading. Every number
 * it returns was measured by the provider at some point.
 */
export function expiryRiskForRanking(
    node: any,
    providerType: string,
    axis: 'session' | 'weekly',
    policy?: RepoMeshQuotaRoutingPolicy | null,
    now: number = Date.now(),
    context?: QuotaFactsContext | null,
): ExpiryRisk | undefined {
    const entry = quotaEntryFor(node, providerType, context, now);
    if (!entry) return undefined;
    const { facts, quota } = entry;
    const window = axis === 'session' ? quota.session : quota.weekly;
    // Keep ranking on the same per-window authority boundary as the launch
    // gate and spread bonus. In particular, an already-reset window is not
    // "fully elapsed" risk; it no longer says anything about the new window.
    if (!isWindowTrustworthy(window, facts, quota, policy, now)) return undefined;
    const remaining = remainingPercent(window);
    if (remaining === undefined) return undefined;
    const resetsAt = Number(window?.resetsAt);
    if (!Number.isFinite(resetsAt) || resetsAt <= 0) return { remainingPercent: remaining, risk: 0 };
    const ageMs = quotaSnapshotAgeMs(facts, quota, now);
    if (!Number.isFinite(ageMs)) return { remainingPercent: remaining, risk: 0 };
    const reporterNowMs = Number(quota.updatedAt) + ageMs;
    const windowMinutes = Number(window?.windowMinutes);
    const fallbackMinutes = axis === 'session' ? DEFAULT_SESSION_WINDOW_MINUTES : DEFAULT_WEEKLY_WINDOW_MINUTES;
    const windowMs = (Number.isFinite(windowMinutes) && windowMinutes > 0
        ? windowMinutes : fallbackMinutes) * 60 * 1000;
    const timeLeftFraction = Math.min(1, Math.max(0, (resetsAt - reporterNowMs) / windowMs));
    return { remainingPercent: remaining, risk: expiryRiskScore(remaining, timeLeftFraction) };
}

/**
 * The per-candidate numbers the sort in rankProvidersByQuotaGate actually
 * compared, on the axis it actually used.
 *
 * ★OBSERVABILITY ONLY. These are reported, never re-decided: nothing reads
 * them back to influence selection. They exist because the ranking used to
 * compute all of this and then throw it away, leaving a reader able to see
 * THAT the fitness order was reordered but not by how much or on which axis —
 * which is how two independent investigations (553d4006 vs 7267eead) reached
 * opposite conclusions about whether the reordering was a bug.
 */
export interface ProviderQuotaRankingEvidence {
    providerType: string;
    /** The window axis this candidate's `risk` was measured on — the axis the
     *  sort used, not a per-candidate preference. `sessionAxisActive` on the
     *  ranking says which one governed overall; a candidate can still report
     *  'weekly' while session mode is active if its session window is
     *  unreadable (the fail-open fallback in the comparator). */
    axis: 'weekly' | 'session';
    /** Expiry-risk score on `axis`: remaining² / (remaining + 100 ×
     *  timeLeftFraction) — see expiryRiskScore. HIGHER = spend SOONER, and the
     *  sort is DESC, so the largest risk is `clear[0]`.
     *
     *  ★Direction changed 2026-08-28: this used to be remaining ×
     *  ELAPSED-fraction, which scored a far reset LOW. It is now driven by time
     *  REMAINING, so a big remainder with a distant reset scores HIGH (it is
     *  over-supplied and on track to expire). A reading taken across that
     *  boundary is not comparable with an older one.
     *
     *  Absent when the axis has no readable reading (this candidate sorts last
     *  on the unknown rule). */
    risk?: number;
    /** Remaining headroom on `axis`, the risk tie-break. */
    remainingPercent?: number;
}

export interface ProviderQuotaGateRanking {
    /** Gate-clear providers, best first: weekly EXPIRY-RISK DESC (remaining² /
     *  (remaining + 100 × time-left fraction)) — or SESSION (5h)
     *  expiry-risk DESC while every weekly-readable candidate clears
     *  sessionAxisWeeklyHeadroomPercent — then remaining DESC on a risk tie,
     *  providers with NO readable reading LAST, and the
     *  caller's original order preserved within each group (stable sort). */
    clear: string[];
    /** Gate-blocked providers with their blocks, in the caller's order. */
    gated: Array<{ providerType: string; block: ProviderQuotaGateBlock }>;
    /** Did the SESSION (5h) axis govern this ranking? True only while every
     *  weekly-readable candidate is strictly above
     *  sessionAxisWeeklyHeadroomPercent — see the 2′ conditional gate below. */
    sessionAxisActive: boolean;
    /** Per-candidate ranking evidence for the gate-clear set, in `clear`'s
     *  final order. Observability only (see ProviderQuotaRankingEvidence). */
    rankingEvidence: ProviderQuotaRankingEvidence[];
}

/**
 * The SELECTION-LOOP form of the gate: evaluate every usable provider
 * candidate of a node (not just the first one selection would have picked)
 * and split them into gate-clear vs gate-blocked, so a gated first-choice
 * provider falls through to the node's NEXT provider instead of skipping the
 * whole node. Owner-confirmed sort: gate-clear candidates are ordered by
 * weekly EXPIRY RISK, descending (expiryRiskForRanking) — an unused
 * weekly remainder EVAPORATES at the window reset, so the provider to spend
 * first is the one whose remainder is least likely to be consumable in the
 * time left, not merely the largest. Equal reset time ⇒ the larger remainder
 * wins (risk is monotone increasing in remaining at equal time left, verified
 * across the grid, and remaining is the explicit risk-tie breaker), so the
 * original "spread the 7-day budget evenly" axis is preserved as a special
 * case.
 *
 * ★The risk formula was REBALANCED 2026-08-28 (owner-directed) from remaining ×
 * elapsed-fraction to remaining² / (remaining + 100 × time-left-fraction). The
 * old shape starved providers with distant resets (measured: codex at 66%/6.4d
 * ranked last and took zero dispatches for a day) and created a CLIFF by
 * deferring large remainders until too late to burn them. The full derivation,
 * the two biases, and the divergence guard live on expiryRiskScore /
 * expiryRiskForRanking — read those before changing the ordering. Nothing else
 * in this function changed: the gate layer, the unknown-last rule, the session
 * axis gate and the stable-sort tie-break are all untouched.
 *
 * SESSION-AXIS CONDITIONAL GATE (owner-confirmed 2′ design): the weekly axis
 * governs only while the weekly budget is the binding constraint. When EVERY
 * weekly-measured candidate has more than sessionAxisWeeklyHeadroomPercent
 * (default 40) of its weekly window left, the ranking axis switches to the
 * SESSION (5h) expiry risk — the same formula on the session window — because
 * an unused 5h remainder evaporates permanently at the session reset and a
 * weekly-only ranking would let it. The moment any measured candidate's
 * weekly remaining is at or below the threshold, the weekly axis governs
 * unchanged: chasing session expiry there would drain a tight weekly budget
 * early. This is deliberately NOT a weekly-risk tie-break — risk is a
 * continuous float, so weekly ties effectively never occur and a tie-break
 * would be dead code; the axis switch is an all-measured-candidates gate.
 * Session-unreadable candidates in session-axis mode sort below every
 * session-measured one (the same unknown-last rule as the weekly axis) and
 * fall back to the weekly order among themselves — an unreadable 5h axis
 * never blocks or promotes anyone (fail-open).
 *
 * RETAINED READINGS RANK, THEY ARE NOT PARTITIONED OUT (2026-08-20).
 *
 * ★This replaced an unconditional unknown-last partition, whose reasoning was
 * that "unknown-last does NOT strand anyone: unknown candidates stay
 * gate-CLEAR, so they are picked whenever every measured provider is gated."
 * That argument is TRUE and still insufficient, and the gap is worth stating
 * precisely because it is not obvious:
 *
 *   Being gate-clear only makes a candidate REACHABLE. It does not make it
 *   REACHED. This function's caller (mesh-queue-assignment.ts) takes
 *   `ranked.clear[0]` — the single best — so a candidate that is last in a
 *   total order is selected only when every candidate above it is GATED, not
 *   merely when they are busy. One healthy measured provider on the node is
 *   therefore enough to make every unmeasured candidate deterministically
 *   unreachable, forever. Not unlikely — unreachable.
 *
 *   Observed 2026-08-20, and observed FLEET-WIDE rather than on one machine:
 *   a node offering claude/opus (stale), kimi (stale) and grok (fresh) sent
 *   every untagged `difficult` task to grok, because grok was the only
 *   candidate with a current reading. Stage 1 fitness had all three at a
 *   near-tie (101/101/112 — quota's +30 cap cannot overturn difficulty's
 *   +100, by design), and then stage 2 discarded that near-tie entirely.
 *
 *   For claude specifically the partition also CLOSED A LOOP: its quota only
 *   refreshes while a Claude Code session is open, so "never selected" and
 *   "never measured" are each other's cause. Nothing in the old ordering
 *   could break that cycle from the inside.
 *
 * The fix keeps the partition's real insight — a measured reading must beat an
 * unmeasured one — and drops only its absoluteness. A candidate carrying REAL
 * measured windows that are no longer fresh ranks on the SAME expiry-risk
 * axis at full weight until resetsAt passes. Staleness describes the refresh
 * surface; it does not reduce trust in the last successful measurement.
 *
 * The two original rejections still hold and are still rejected:
 *   - unknown-first ("assumed full") would let an unmeasurable provider win
 *     every contest — the sort becomes meaningless AND it preferentially
 *     overloads the one provider that declined to be measured, the exact
 *     failure mode the module header bans. Ranking is still bounded by a REAL
 *     measurement, so it can never behave this way.
 *   - treating unknown as blocked would silently strand opted-out providers
 *     (quotaEnabled === false), violating the fail-open contract.
 *
 * NO-READING-AT-ALL candidates (never measured, opted out, or a failure that
 * erased the numbers) are still sorted LAST, unchanged: there is nothing to
 * compare, so there is nothing to rank. They remain gate-CLEAR and are picked
 * when everything above them is gated, exactly as before.
 *
 * ★What this deliberately does NOT do: it never promotes a candidate over a
 * MEASURED-AND-GATED one. Gating is decided by evaluateProviderQuotaGate and is
 * untouched here — a provider whose fresh reading says 'quota-exhausted', or
 * whose window is genuinely below threshold, stays in `gated` and out of this
 * sort entirely. Ranking decides who goes first among candidates that may all
 * legitimately run; it never overrides a measured "cannot run".
 *
 * Tie-break: the caller's candidate order (capacity → task fitness → slot/
 * providerPriority order) is preserved within both the known and the unknown
 * group by the stable sort, so whenever quota has nothing to add the
 * selection is byte-identical to what it was before.
 *
 * Being out-ranked and being BLOCKED are different things: a candidate with
 * no readable window is never blocked — it only lands in the unknown group. A
 * transient error with retained last-good windows may still be blocked by
 * those measured windows until their reset boundary. The fail-open contract
 * of evaluateProviderQuotaGate is inherited unchanged.
 */
export function rankProvidersByQuotaGate(
    node: any,
    orderedProviderTypes: string[],
    policy?: RepoMeshQuotaRoutingPolicy | null,
    now: number = Date.now(),
    context?: QuotaFactsContext | null,
    targetsByProvider?: ReadonlyMap<string, ProviderQuotaGateTarget>,
): ProviderQuotaGateRanking {
    const clear: string[] = [];
    const gated: ProviderQuotaGateRanking['gated'] = [];
    for (const providerType of orderedProviderTypes) {
        const block = evaluateProviderQuotaGate(
            node, providerType, policy, now, context, targetsByProvider?.get(providerType),
        );
        if (block) gated.push({ providerType, block });
        else clear.push(providerType);
    }
    const weeklyByProvider = new Map(clear.map(p => [p, expiryRiskForRanking(node, p, 'weekly', policy, now, context)]));
    // 2′ conditional gate: the session (5h) axis ranks ONLY while every
    // weekly-readable candidate has weekly headroom to spare (strictly above
    // the threshold — a candidate AT it stays weekly-protected). With no
    // weekly-readable candidate at all there is nothing to rank on either
    // axis and the caller order survives untouched.
    //
    // Retained readings participate in this gate on their measured
    // remainingPercent: staleness does not change what the reading says, and
    // the same full-trust rule applies to both protection and ordering.
    const headroomPercent = resolveQuotaRoutingPolicy(policy).sessionAxisWeeklyHeadroomPercent;
    const weeklyMeasured = [...weeklyByProvider.values()].filter((w): w is ExpiryRisk => w !== undefined);
    const sessionAxisActive = weeklyMeasured.length > 0
        && weeklyMeasured.every(w => w.remainingPercent > headroomPercent);
    const sessionByProvider = sessionAxisActive
        ? new Map(clear.map(p => [p, expiryRiskForRanking(node, p, 'session', policy, now, context)]))
        : undefined;
    clear.sort((a, b) => {
        const wa = weeklyByProvider.get(a);
        const wb = weeklyByProvider.get(b);
        // NO reading at all still sorts last — nothing to rank on. A retained
        // reading is NOT in this branch: it has real numbers and competes
        // below at the same weight as a fresh reading.
        if (wa === undefined && wb === undefined) return 0; // both unreadable: keep caller order
        if (wa === undefined) return 1;
        if (wb === undefined) return -1;
        if (sessionByProvider) {
            const sa = sessionByProvider.get(a);
            const sb = sessionByProvider.get(b);
            if (sa !== undefined && sb !== undefined) {
                if (sb.risk !== sa.risk) return sb.risk - sa.risk; // session expiry risk DESC
                if (sb.remainingPercent !== sa.remainingPercent) {
                    return sb.remainingPercent - sa.remainingPercent; // session remaining tie-break
                }
            } else if (sa !== undefined) return -1; // session-unreadable sorts below session-readable
            else if (sb !== undefined) return 1;
            // Both session-unreadable (or a full session tie): the weekly order
            // below is the fail-open fallback — an unreadable 5h axis never
            // changes what the weekly axis would have decided.
        }
        if (wb.risk !== wa.risk) return wb.risk - wa.risk; // expiry risk DESC
        // Risk tie (e.g. equal reset time, or two zero-risk readings): the
        // larger weekly remainder is the original even-spend axis. A further
        // tie keeps the caller order (stable sort), regardless of reading age.
        return wb.remainingPercent - wa.remainingPercent;
    });
    // Ranking evidence is derived AFTER the sort, from the same maps the
    // comparator read. It reports; it decides nothing. Per candidate the axis
    // is the one the comparator actually applied to it: session only where
    // session mode is on AND that candidate has a readable session reading —
    // otherwise the comparator fell back to weekly for it.
    const rankingEvidence: ProviderQuotaRankingEvidence[] = clear.map(providerType => {
        const session = sessionByProvider?.get(providerType);
        const reading = session ?? weeklyByProvider.get(providerType);
        const axis: 'weekly' | 'session' = session ? 'session' : 'weekly';
        return {
            providerType,
            axis,
            ...(reading ? {
                risk: reading.risk,
                remainingPercent: reading.remainingPercent,
            } : {}),
        };
    });
    return { clear, gated, sessionAxisActive, rankingEvidence };
}
