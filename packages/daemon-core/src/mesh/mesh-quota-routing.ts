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
 *      rankProvidersByQuotaGate is the gate's SELECTION-LOOP form: it evaluates
 *      every usable candidate of a node and orders the survivors by weekly
 *      EXPIRY RISK (unused remainder evaporates at the window reset), so a
 *      gated first choice falls through to the node's next provider (dynamic
 *      provider priority by quota).
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

/** Fallback weekly-window length when a snapshot reports a weekly window
 *  without its windowMinutes (every in-tree fetcher fills it; this only
 *  guards malformed/foreign bundles). */
const DEFAULT_WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

/** Ranking metric for one candidate, or undefined when even the weekly
 *  REMAINING is unknown (no snapshot / non-'ok' / stale / no weekly window). */
interface WeeklyExpiryRisk {
    remainingPercent: number;
    /** Expiry-risk score — see rankProvidersByQuotaGate. Bounded by
     *  remainingPercent, so it can never diverge. */
    risk: number;
}

/**
 * Expiry-risk metric: how much of this provider's weekly remainder is likely
 * to EVAPORATE unused at the window reset if it is not consumed now.
 *
 *   risk = remainingPercent × elapsedFraction
 *   elapsedFraction = clamp(1 − timeLeft/windowMs, 0, 1)
 *
 * i.e. the remaining headroom weighted by how much of the window is already
 * gone. A full remainder right after a reset scores ~0 (plenty of time to
 * spend it — a big remainder alone must NOT win); the same remainder minutes
 * before the reset scores ~its full value (every unused point is a certain
 * loss). Deliberately NOT remaining/timeLeft ("required burn rate"): that
 * diverges as timeLeft → 0 and would let a 1% remainder outrank a 90% one.
 * Here risk ≤ remainingPercent by construction, so a trivial remainder can
 * never beat a substantial one except when the substantial one's window has
 * literally just reset (elapsedFraction < 1/90) — where deferring it is
 * correct anyway.
 *
 * Clock-skew: resetsAt is stamped on the REPORTER's clock, so timeLeft is
 * computed against the skew-safe reporter-now estimate (updatedAt + snapshot
 * age — the same same-clock-difference trick as isSessionResetImminent).
 *
 * resetsAt UNKNOWN (window reported, reset stamp absent): risk 0 — no
 * evidence of imminent loss means no invented urgency (the same
 * observation-without-confidence-is-inert rule as the gate's fail-open).
 * Such candidates still rank by their known remaining, above the
 * remaining-unknown group, below every candidate with positive risk.
 */
function weeklyExpiryRiskForRanking(
    node: any,
    providerType: string,
    policy?: RepoMeshQuotaRoutingPolicy | null,
    now: number = Date.now(),
): WeeklyExpiryRisk | undefined {
    const entry = quotaEntryFor(node, providerType);
    if (!entry) return undefined;
    const { facts, quota } = entry;
    if (quota.status !== 'ok') return undefined;
    if (!isQuotaSnapshotFresh(facts, quota, policy, now)) return undefined;
    const remaining = remainingPercent(quota.weekly);
    if (remaining === undefined) return undefined;
    const resetsAt = Number(quota.weekly?.resetsAt);
    if (!Number.isFinite(resetsAt) || resetsAt <= 0) return { remainingPercent: remaining, risk: 0 };
    const ageMs = quotaSnapshotAgeMs(facts, quota, now);
    if (!Number.isFinite(ageMs)) return { remainingPercent: remaining, risk: 0 };
    const reporterNowMs = Number(quota.updatedAt) + ageMs;
    const windowMinutes = Number(quota.weekly?.windowMinutes);
    const windowMs = (Number.isFinite(windowMinutes) && windowMinutes > 0
        ? windowMinutes : DEFAULT_WEEKLY_WINDOW_MINUTES) * 60 * 1000;
    const elapsedFraction = Math.min(1, Math.max(0, 1 - (resetsAt - reporterNowMs) / windowMs));
    return { remainingPercent: remaining, risk: remaining * elapsedFraction };
}

export interface ProviderQuotaGateRanking {
    /** Gate-clear providers, best first: weekly EXPIRY-RISK DESC (remaining ×
     *  elapsed window fraction), weekly remaining DESC on a risk tie,
     *  providers whose weekly reading is unknown LAST, and the caller's
     *  original order preserved within each group (stable sort). */
    clear: string[];
    /** Gate-blocked providers with their blocks, in the caller's order. */
    gated: Array<{ providerType: string; block: ProviderQuotaGateBlock }>;
}

/**
 * The SELECTION-LOOP form of the gate: evaluate every usable provider
 * candidate of a node (not just the first one selection would have picked)
 * and split them into gate-clear vs gate-blocked, so a gated first-choice
 * provider falls through to the node's NEXT provider instead of skipping the
 * whole node. Owner-confirmed sort: gate-clear candidates are ordered by
 * weekly EXPIRY RISK, descending (weeklyExpiryRiskForRanking) — an unused
 * weekly remainder EVAPORATES at the window reset, so the provider to spend
 * first is the one whose remainder is least likely to be consumable in the
 * time left, not merely the largest. Equal reset time ⇒ the larger remainder
 * wins (risk is proportional to remaining at equal elapsed fraction, and
 * remaining is the explicit risk-tie breaker), so the original
 * "spread the 7-day budget evenly" axis is preserved as a special case.
 *
 * UNKNOWN-WEEKLY PLACEMENT (deliberate): candidates whose weekly remaining
 * cannot be read sort BELOW every measured candidate, never above. Two
 * directions were rejected:
 *   - unknown-first ("assumed full") would let an unmeasurable provider win
 *     every contest — the sort becomes meaningless AND it preferentially
 *     overloads the one provider that declined to be measured, the exact
 *     failure mode the module header bans.
 *   - treating unknown as blocked would silently strand opted-out providers
 *     (quotaEnabled === false), violating the fail-open contract.
 * Unknown-last does NOT strand anyone: unknown candidates stay gate-CLEAR,
 * so they are picked whenever every measured provider is gated — or whenever
 * nothing on the node is measured at all (pre-feature behaviour preserved).
 * It also matches the SPREAD bonus precedent, which scores unmeasured
 * providers 0 — measured-with-headroom already outranked unknown there.
 *
 * Tie-break: the caller's candidate order (capacity → task fitness → slot/
 * providerPriority order) is preserved within both the known and the unknown
 * group by the stable sort, so whenever quota has nothing to add the
 * selection is byte-identical to what it was before.
 *
 * Being out-ranked and being BLOCKED are different things: a fail-open
 * candidate (missing / stale / expired-token / any transient reading) is
 * never blocked — it only lands in the unknown group. The fail-open contract
 * of evaluateProviderQuotaGate is inherited unchanged.
 */
export function rankProvidersByQuotaGate(
    node: any,
    orderedProviderTypes: string[],
    policy?: RepoMeshQuotaRoutingPolicy | null,
    now: number = Date.now(),
): ProviderQuotaGateRanking {
    const clear: string[] = [];
    const gated: ProviderQuotaGateRanking['gated'] = [];
    for (const providerType of orderedProviderTypes) {
        const block = evaluateProviderQuotaGate(node, providerType, policy, now);
        if (block) gated.push({ providerType, block });
        else clear.push(providerType);
    }
    const weeklyByProvider = new Map(clear.map(p => [p, weeklyExpiryRiskForRanking(node, p, policy, now)]));
    clear.sort((a, b) => {
        const wa = weeklyByProvider.get(a);
        const wb = weeklyByProvider.get(b);
        if (wa === undefined && wb === undefined) return 0; // both unknown: keep caller order
        if (wa === undefined) return 1;  // unknown sorts below every measured candidate
        if (wb === undefined) return -1;
        if (wb.risk !== wa.risk) return wb.risk - wa.risk; // expiry risk DESC
        // Risk tie (e.g. equal reset time): the larger weekly remainder wins —
        // the original even-spend axis, preserved as the tie-break. A further
        // tie keeps the caller order (stable sort).
        return wb.remainingPercent - wa.remainingPercent;
    });
    return { clear, gated };
}

/**
 * OBSERVABILITY (quota-ranking): per-provider expiry-risk snapshot for every
 * candidate the ranking loop considered, clear or gated. Order-preserving
 * (caller's candidate order, not the sorted rank) so a log line or a
 * mesh_status reader can show "here is what each candidate looked like"
 * without re-deriving weeklyExpiryRiskForRanking itself (kept module-private
 * — this is the one sanctioned way to read it from outside the module).
 * remainingPercent/risk are undefined for the same reasons rankProvidersByQuotaGate's
 * unknown group exists: no snapshot, non-'ok', stale, or no weekly window.
 */
export interface ProviderQuotaRiskSnapshot {
    providerType: string;
    remainingPercent?: number;
    risk?: number;
}

export function quotaRiskSnapshotForCandidates(
    node: any,
    orderedProviderTypes: string[],
    policy?: RepoMeshQuotaRoutingPolicy | null,
    now: number = Date.now(),
): ProviderQuotaRiskSnapshot[] {
    return orderedProviderTypes.map(providerType => {
        const w = weeklyExpiryRiskForRanking(node, providerType, policy, now);
        return {
            providerType,
            ...(w ? { remainingPercent: w.remainingPercent, risk: w.risk } : {}),
        };
    });
}

/**
 * OBSERVABILITY (quota-ranking): the mesh's last quota-ranking decision per
 * node, overwritten on every write — ONE entry per node, never accumulating,
 * so this cannot grow unbounded across a long-lived daemon process. Exists so
 * a caller who was not tailing logs at the moment a routing decision was made
 * (e.g. mesh_status, queried minutes later) can still see WHY the winner won.
 *
 * Two shapes: a real ranking (the selection loop ran rankProvidersByQuotaGate)
 * carries `clear`/`gated`/`winner`; an ADOPT record (an idle-session claim path
 * that never runs the ranking loop — it adopts whatever provider the already-
 * running session already has) carries only `adopted: true` and the provider,
 * making the "no ranking ran here" gap itself visible instead of silently
 * absent. See mesh-queue-assignment.ts tryAssignQueueTask for the write side.
 */
export interface LastQuotaRankingRecord {
    decidedAt: number;
    winner?: string;
    clear?: ProviderQuotaRiskSnapshot[];
    gated?: Array<{ providerType: string; reason: string }>;
    /** True when this record documents an ADOPT (idle-session claim that
     *  never ran the ranking loop) rather than a fresh ranking. */
    adopted?: boolean;
}

const lastQuotaRankingByNode = new Map<string, LastQuotaRankingRecord>();

export function recordLastQuotaRanking(nodeId: string, record: LastQuotaRankingRecord): void {
    if (!nodeId) return;
    lastQuotaRankingByNode.set(nodeId, record);
}

export function getLastQuotaRanking(nodeId: string): LastQuotaRankingRecord | undefined {
    return lastQuotaRankingByNode.get(nodeId);
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
