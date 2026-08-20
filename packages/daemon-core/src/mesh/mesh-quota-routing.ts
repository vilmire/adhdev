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
 * FAIL-OPEN contract: a missing entry, an unmeasurable non-'ok' status, or a
 * STALE snapshot yields "no gate, no bonus" — routing on an old reading would
 * exclude nodes on data that no longer describes them (the stale-quota
 * misexclusion failure mode). A non-'ok' entry may gate from retained windows
 * only when metadata.lastGoodWindows proves their provenance and each low
 * window has not reset yet. A missing/unparseable reset stamp falls back to
 * the ORIGINAL updatedAt freshness check. Observation without confidence is
 * inert.
 *
 * ★"Inert" is about GATING and BONUSING, not about ORDERING. An old reading
 * still may not exclude anyone and still contributes no fitness bonus — that
 * is unchanged. But rankProvidersByQuotaGate does ORDER on it, at a confidence
 * discount, because ordering is a comparison among candidates that will all
 * run: refusing to compare does not avoid a decision, it just makes the
 * decision "always last" (see the RETAINED READINGS section there, and the
 * fleet-wide claude stranding it fixes).
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
import { meshNodeIdMatches, type MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared';
import { LOG } from '../logging/logger.js';
import { readQuotaCache } from '../quota/refresh.js';
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

export interface LiveLocalQuotaSource {
    /** Snapshot of THIS daemon's live quota cache, taken by the caller when it
     *  built the routing context (readQuotaCache() — an in-memory Map read,
     *  never a fetch; the refresh timer in quota/refresh.ts owns fetching). */
    entries: Record<string, MeshNodeFactsProviderQuota>;
    /** Caller-supplied locality verdict (queue-assignment's
     *  isLocalAutoLaunchNode), memoized per node object by
     *  liveLocalQuotaForRouting so a ranking pass pays one verdict per node. */
    isLocalNode(node: any): boolean;
}

/** Caller-supplied local-machine provider-enablement oracle, injected the same
 *  way as LiveLocalQuotaSource (optional, local-node-only, additive): the two
 *  INDEPENDENT axes quota/refresh.ts already distinguishes —
 *  isMachineProviderEnabled ("this machine uses provider X") and
 *  isMachineQuotaEnabled ("...and its quota is probed") — read straight off
 *  the caller's ProviderLoader. Absent (no loader injected, or the node is not
 *  this daemon's) means the absent-entry log cannot classify further and must
 *  say so rather than guess — see logAbsentQuotaFailOpen's remote branch. */
export interface LiveLocalProviderEnablementSource {
    isMachineProviderEnabled(providerType: string): boolean;
    isMachineQuotaEnabled(providerType: string): boolean;
    /** Same locality contract as LiveLocalQuotaSource.isLocalNode — true only
     *  for a node that resolves to THIS daemon (or its worktree-clone source).
     *  A remote node's enablement lives on a config this daemon never reads. */
    isLocalNode(node: any): boolean;
}

export interface QuotaFactsContext {
    nodes?: any[];
    /** Present only when the caller runs on the quota-OWNING daemon and had a
     *  live cache to inject. Absent → the nodeFacts copies are read exactly as
     *  before (remote nodes, tests, pre-measurement boot). */
    liveLocalQuota?: LiveLocalQuotaSource | null;
    /** Present only when the caller injected a local ProviderLoader — see
     *  LiveLocalProviderEnablementSource. Absent → the absent-entry log falls
     *  back to the unclassified-remote reason. */
    providerEnablement?: LiveLocalProviderEnablementSource | null;
}

/**
 * Build the live-local-quota injection for one routing pass. Returns null when
 * this daemon has measured nothing yet — callers then read the nodeFacts
 * copies unchanged, preserving the pre-cache fail-open behaviour. The locality
 * verdict is deliberately a PARAMETER (the caller's isLocalAutoLaunchNode):
 * resolving it here would import config — a disk read — into a module whose
 * contract is pure in-memory reads.
 */
export function liveLocalQuotaForRouting(
    isLocalNode: (node: any) => boolean,
): LiveLocalQuotaSource | null {
    const entries = readQuotaCache();
    if (!entries) return null;
    const verdicts = new Map<any, boolean>();
    return {
        entries,
        isLocalNode(node: any): boolean {
            let verdict = verdicts.get(node);
            if (verdict === undefined) {
                verdict = !!node && isLocalNode(node) === true;
                verdicts.set(node, verdict);
            }
            return verdict;
        },
    };
}

/** Minimal shape this module needs from a ProviderLoader — the same two
 *  methods quota/refresh.ts's quotaProviderEnabledFromLoader consults, kept
 *  structural (not an import of the loader type) so this module's dependency
 *  graph stays leaf-shaped. isMachineQuotaEnabled is optional because older
 *  structural callers/test doubles predate that axis (quota/refresh.ts
 *  documents the same absent-means-enabled default). */
export interface QuotaEnablementLoader {
    isMachineProviderEnabled(providerType: string): boolean;
    isMachineQuotaEnabled?(providerType: string): boolean;
}

/**
 * Build the live-local-provider-enablement injection for one routing pass,
 * mirroring liveLocalQuotaForRouting exactly: returns null when the caller has
 * no loader to inject (remote-only mesh view, tests, pre-loader boot), and
 * memoizes the locality verdict per node object.
 */
export function liveLocalProviderEnablementForRouting(
    loader: QuotaEnablementLoader | null | undefined,
    isLocalNode: (node: any) => boolean,
): LiveLocalProviderEnablementSource | null {
    if (!loader) return null;
    const verdicts = new Map<any, boolean>();
    return {
        isMachineProviderEnabled: (providerType: string) => loader.isMachineProviderEnabled(providerType),
        isMachineQuotaEnabled: (providerType: string) =>
            loader.isMachineQuotaEnabled ? loader.isMachineQuotaEnabled(providerType) : true,
        isLocalNode(node: any): boolean {
            let verdict = verdicts.get(node);
            if (verdict === undefined) {
                verdict = !!node && isLocalNode(node) === true;
                verdicts.set(node, verdict);
            }
            return verdict;
        },
    };
}

/** The context the quota-routing callers pass for one routing pass over
 *  `mesh`: the node list plus the live local cache when this daemon has one.
 *  `isLocalNode` is the caller's locality oracle (isLocalAutoLaunchNode) —
 *  see liveLocalQuotaForRouting. `providerLoader` is optional (additive): pass
 *  the caller's ProviderLoader to let the absent-entry log classify a local
 *  node's reason (not_measured / probe_disabled / provider_disabled); omit it
 *  and that classification falls back to unclassified-remote, exactly as
 *  before this parameter existed. */
export function quotaFactsContextForLiveRouting(
    mesh: any,
    isLocalNode: (node: any) => boolean,
    providerLoader?: QuotaEnablementLoader | null,
): QuotaFactsContext {
    return {
        nodes: mesh?.nodes,
        liveLocalQuota: liveLocalQuotaForRouting(isLocalNode),
        providerEnablement: liveLocalProviderEnablementForRouting(providerLoader, isLocalNode),
    };
}

/** Read one provider entry directly from a node's facts bundle. */
function directQuotaEntryFor(node: any, providerType: string): { facts: { reportedAt: number }; quota: MeshNodeFactsProviderQuota } | null {
    const facts = node?.nodeFacts;
    if (!facts || typeof facts !== 'object') return null;
    const reportedAt = Number(facts.reportedAt);
    if (!Number.isFinite(reportedAt) || reportedAt <= 0) return null;
    const quota = facts.quota?.[providerType];
    if (!quota || typeof quota !== 'object') return null;
    return { facts: { reportedAt }, quota };
}

/**
 * Read the reported quota entry for a provider. A worktree clone shares the
 * source node's owning daemon and upstream accounts, so during its pre-probe
 * facts gap (or when an early facts bundle has no quota yet) use the source
 * node's entry. No source/entry still means unknown and therefore fail-open.
 */
function quotaEntryFor(
    node: any,
    providerType: string,
    context?: QuotaFactsContext | null,
    now: number = Date.now(),
): { facts: { reportedAt: number }; quota: MeshNodeFactsProviderQuota } | null {
    // LIVE LOCAL READ (see the module header): when the caller injected this
    // daemon's live cache and the node — or its worktree-clone source, which
    // shares the source's daemon — resolves to this daemon, route on the live
    // measurement instead of the stale-able nodeFacts copy. A provider absent
    // from the live cache (never measured, opted out) falls through to the
    // copy below, and a remote node (no live source) always uses the copy.
    const live = context?.liveLocalQuota;
    if (live) {
        const sourceNode = cloneSourceNodeFor(node, context);
        if (live.isLocalNode(node) || (sourceNode !== undefined && live.isLocalNode(sourceNode))) {
            const quota = live.entries[providerType];
            if (quota && typeof quota === 'object') {
                // Same daemon, same clock: no transit and no skew, so stamp
                // reportedAt = now — quotaSnapshotAgeMs then reduces to
                // now − updatedAt, and a cache entry that is itself old still
                // fails open exactly like a stale copy.
                return { facts: { reportedAt: now }, quota };
            }
        }
    }
    const direct = directQuotaEntryFor(node, providerType);
    if (direct) return direct;
    const sourceNode = cloneSourceNodeFor(node, context);
    return sourceNode ? directQuotaEntryFor(sourceNode, providerType) : null;
}

function cloneSourceNodeFor(node: any, context?: QuotaFactsContext | null): any | undefined {
    const sourceNodeId = typeof node?.clonedFromNodeId === 'string' ? node.clonedFromNodeId.trim() : '';
    if (!sourceNodeId || !Array.isArray(context?.nodes)) return undefined;
    return context.nodes.find(candidate => candidate !== node && meshNodeIdMatches(candidate, sourceNodeId));
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

/** Rate limiter for the stale fail-open log below: at most one line per
 *  (node, provider) per freshness window. Routing runs on every reconcile
 *  tick, so an unthrottled line here would be pure polling spam. Bounded by
 *  mesh size × provider count — it cannot grow unboundedly. */
const staleFailOpenLoggedAt = new Map<string, number>();

/** OBSERVABILITY: the stale fail-open branch is otherwise SILENT — a stale
 *  snapshot gates nobody, so the only evidence used to be the ABSENCE of
 *  quota-ranking output, which the 2026-08-18 copy-lag investigation had to
 *  reverse-infer. One concise line per freshness window: provider, age, and
 *  the threshold it exceeded. */
function logStaleQuotaFailOpen(
    node: any,
    providerType: string,
    facts: { reportedAt: number },
    quota: { updatedAt: number },
    policy: RepoMeshQuotaRoutingPolicy | null | undefined,
    now: number,
): void {
    const staleAfterMs = resolveQuotaRoutingPolicy(policy).staleAfterMs;
    const nodeId = typeof node?.nodeId === 'string' && node.nodeId ? node.nodeId
        : typeof node?.id === 'string' && node.id ? node.id : 'unknown';
    const key = `${nodeId} ${providerType}`;
    const last = staleFailOpenLoggedAt.get(key);
    if (last !== undefined && now - last < staleAfterMs) return;
    staleFailOpenLoggedAt.set(key, now);
    const ageMs = quotaSnapshotAgeMs(facts, quota, now);
    const ageText = Number.isFinite(ageMs) ? `${Math.round(ageMs / 60_000)}m` : 'unparseable';
    LOG.info('MeshQuota', `QUOTA GATE: provider '${providerType}' on node ${nodeId} fails open — snapshot age ${ageText} exceeds the ${Math.round(staleAfterMs / 60_000)}m freshness threshold`);
}

/** Reasons the absent-entry fail-open log can attribute to a missing
 *  snapshot. 'probe_disabled' is a DELIBERATE user opt-out (quotaEnabled ===
 *  false — "do not read my usage", see the module header) and must never be
 *  worded or treated as a defect. 'unclassified_remote' is now the residual
 *  case only: a node that reported no enablement facts (a daemon too old to
 *  send them) and that this daemon cannot read the config of either. A remote
 *  node that DOES ship MeshNodeFacts.providerEnablement gets a real
 *  classification from its own report. */
export type AbsentQuotaReason = 'not_measured' | 'probe_disabled' | 'provider_disabled' | 'unclassified_remote';

/** Classify why a provider has no quota entry, from two sources in priority
 *  order:
 *
 *   1. the LOCAL provider-enablement oracle (QuotaFactsContext.providerEnablement)
 *      for a node this daemon owns the config of — live config beats any copy;
 *   2. the node's OWN reported facts (MeshNodeFacts.providerEnablement), which
 *      is what makes a remote node classifiable at all.
 *
 *  Anything else stays 'unclassified_remote' — an explicit not-a-guess, never
 *  a config value this daemon does not have. This function is observation-only:
 *  no caller routes on its verdict. */
function classifyAbsentQuotaReason(
    node: any,
    providerType: string,
    context?: QuotaFactsContext | null,
): AbsentQuotaReason {
    const enablement = context?.providerEnablement;
    const sourceNode = cloneSourceNodeFor(node, context);
    if (enablement) {
        // LOCAL path (authoritative): this daemon reads the live config, so it
        // beats any reported copy — the copy is a stamp from the last
        // git_status, the config is what is true right now.
        if (enablement.isLocalNode(node) || (sourceNode !== undefined && enablement.isLocalNode(sourceNode))) {
            if (!enablement.isMachineProviderEnabled(providerType)) return 'provider_disabled';
            if (!enablement.isMachineQuotaEnabled(providerType)) return 'probe_disabled';
            return 'not_measured';
        }
    }
    // REMOTE path: the owning node ships its own switches on the facts bundle
    // (MeshNodeFacts.providerEnablement), which is the only way this daemon can
    // tell an opt-out from a not-yet-measured provider for a config it never
    // reads. Worktree clones fall back to their source node's bundle, the same
    // way the snapshot lookup does.
    const reported = reportedEnablementFor(node, providerType)
        ?? (sourceNode !== undefined ? reportedEnablementFor(sourceNode, providerType) : undefined);
    // ★Absence is NOT "disabled". A daemon too old to send the field, a
    // provider missing from the map, or a malformed entry all mean "this node
    // did not tell us" — inventing a disabled verdict there would be a
    // fail-closed guess derived from a missing field.
    if (!reported) return 'unclassified_remote';
    if (reported.enabled === false) return 'provider_disabled';
    if (reported.quotaEnabled === false) return 'probe_disabled';
    return 'not_measured';
}

/** Read one provider's reported enablement off a node's facts bundle. Returns
 *  undefined for anything that is not a well-formed entry with BOTH booleans
 *  present — a partial entry is treated as no report at all, so a half-written
 *  bundle can never be read as an opt-out. */
function reportedEnablementFor(
    node: any,
    providerType: string,
): { enabled: boolean; quotaEnabled: boolean } | undefined {
    const map = node?.nodeFacts?.providerEnablement;
    if (!map || typeof map !== 'object') return undefined;
    const entry = (map as Record<string, unknown>)[providerType];
    if (!entry || typeof entry !== 'object') return undefined;
    const { enabled, quotaEnabled } = entry as { enabled?: unknown; quotaEnabled?: unknown };
    if (typeof enabled !== 'boolean' || typeof quotaEnabled !== 'boolean') return undefined;
    return { enabled, quotaEnabled };
}

/** Rate limiter for the absent-entry fail-open log below, same shape and
 *  reasoning as staleFailOpenLoggedAt: at most one line per (node, provider)
 *  per freshness window. A separate map from the stale one — the two branches
 *  are mutually exclusive per call, but keeping them independent avoids one
 *  branch's throttle window suppressing the other's first line. */
const absentFailOpenLoggedAt = new Map<string, number>();

/** OBSERVABILITY: the absent-entry fail-open branch was, until this change,
 *  the ONE consumer of quotaEntryFor with zero logging — see the module
 *  header's 2026-08-18 note and CLAUDE.md's M-QUOTA-STALE-FAILOPEN-ROUTING ②.
 *  A missing entry gates nobody (same fail-open contract as the stale branch
 *  above), so without this line the only evidence was the absence of
 *  quota-ranking output — indistinguishable from "never asked". One concise
 *  line per freshness window: provider, reason, and — for probe_disabled —
 *  an explicit note that this is an intended opt-out, not a fault. Uses the
 *  policy's staleAfterMs as the throttle window, the same cadence the stale
 *  branch throttles on, so neither branch floods a reconcile-tick loop. */
function logAbsentQuotaFailOpen(
    node: any,
    providerType: string,
    policy: RepoMeshQuotaRoutingPolicy | null | undefined,
    now: number,
    context?: QuotaFactsContext | null,
): void {
    const staleAfterMs = resolveQuotaRoutingPolicy(policy).staleAfterMs;
    const nodeId = typeof node?.nodeId === 'string' && node.nodeId ? node.nodeId
        : typeof node?.id === 'string' && node.id ? node.id : 'unknown';
    const key = `${nodeId} ${providerType}`;
    const last = absentFailOpenLoggedAt.get(key);
    if (last !== undefined && now - last < staleAfterMs) return;
    absentFailOpenLoggedAt.set(key, now);
    const reason = classifyAbsentQuotaReason(node, providerType, context);
    const reasonText = reason === 'probe_disabled'
        ? 'quota probing is disabled for this provider on that node (quotaEnabled: false — an intended opt-out, not a fault)'
        : reason === 'provider_disabled'
            ? 'this provider is not enabled on that node'
            : reason === 'not_measured'
                ? 'no snapshot has been measured yet'
                : 'that node reported no provider-enablement facts (a daemon predating them, or no loader injected here) — cannot tell not-yet-measured from an opt-out; check the owning node\'s config directly';
    LOG.info('MeshQuota', `QUOTA GATE: provider '${providerType}' on node ${nodeId} fails open — no quota entry (${reason}: ${reasonText})`);
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
 * A retained last-good window remains authoritative until that SAME window
 * resets. This is deliberately per-window: session and weekly reset on
 * different schedules. A valid reset stamp supersedes snapshot age in both
 * directions — future means the observed low-water mark still applies, past
 * means the old window is gone. If the reset stamp cannot be read, preserve
 * the existing staleAfterMs fail-open fallback.
 *
 * resetsAt and updatedAt are reporter-clock stamps, so compare resetsAt with
 * the same skew-safe reporter-now estimate used by the reset-imminent logic.
 */
function isRetainedWindowTrustworthy(
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
    const ageMs = quotaSnapshotAgeMs(facts, quota, now);
    if (!Number.isFinite(ageMs)) return false;
    const reporterNowMs = Number(quota.updatedAt) + ageMs;
    if (!Number.isFinite(reporterNowMs)) return false;
    return resetsAt > reporterNowMs;
}

/**
 * The launch GATE: should this (node, provider) pair be skipped because the
 * provider's reported quota is nearly exhausted? Returns null (launch may
 * proceed) when the quota is unknown, unmeasurable, stale, or above every
 * threshold. The gate blocks in exactly three situations, all on FRESH
 * snapshots only:
 *   1. an 'ok' snapshot with a window below its threshold, and
 *   2. an 'error' snapshot with failureKind 'quota-exhausted' — the provider's
 *      own exhaustion verdict (no window breakdown, so window is 'unknown'),
 *   3. a non-'ok' snapshot marked lastGoodWindows whose retained window is
 *      below its threshold.
 * Every other non-'ok' reading fails open. Each retained window remains
 * trustworthy until its own resetsAt; a missing/unparseable resetsAt uses the
 * existing staleAfterMs fallback because carry-forward preserves the ORIGINAL
 * updatedAt.
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
    context?: QuotaFactsContext | null,
): ProviderQuotaGateBlock | null {
    const entry = quotaEntryFor(node, providerType, context, now);
    if (!entry) {
        logAbsentQuotaFailOpen(node, providerType, policy, now, context);
        return null; // never reported → unknown, not blocked
    }
    const { facts, quota } = entry;
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
        sessionTrustworthy = isRetainedWindowTrustworthy(quota.session, facts, quota, policy, now);
        weeklyTrustworthy = isRetainedWindowTrustworthy(quota.weekly, facts, quota, policy, now);
    } else if (!isQuotaSnapshotFresh(facts, quota, policy, now)) {
        logStaleQuotaFailOpen(node, providerType, facts, quota, policy, now);
        return null; // fail-open on stale
    }
    const resolved = resolveQuotaRoutingPolicy(policy);
    const session = remainingPercent(quota.session);
    if (sessionTrustworthy && session !== undefined && session < resolved.sessionMinRemainingPercent
        && !isSessionResetImminent(quota.session, facts, quota, resolved.sessionResetImminentMs, now)) {
        return {
            reason: PROVIDER_QUOTA_SESSION_LOW_SKIP_REASON,
            window: 'session',
            remainingPercent: session,
            thresholdPercent: resolved.sessionMinRemainingPercent,
        };
    }
    const weekly = remainingPercent(quota.weekly);
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

/** Ranking metric for one candidate on one window axis, or undefined when even
 *  the axis's REMAINING is unknown (no snapshot / non-'ok' / no retained
 *  reading / no such window reported). */
interface ExpiryRisk {
    remainingPercent: number;
    /** Expiry-risk score — see rankProvidersByQuotaGate. Bounded by
     *  remainingPercent, so it can never diverge. */
    risk: number;
    /** How much this reading is trusted as a description of the provider RIGHT
     *  NOW, 0..1. 1 = a fresh 'ok' snapshot. Below 1 = a RETAINED reading (the
     *  numbers were really measured, they are just no longer current), which
     *  ranks on the same axis at a discount rather than being partitioned out.
     *  See CONFIDENCE below and the RETAINED-READING section of
     *  rankProvidersByQuotaGate. */
    confidence: number;
}

/**
 * CONFIDENCE tiers for a ranking reading.
 *
 * A reading is either CURRENT (a fresh 'ok' snapshot — full confidence) or
 * RETAINED: real measured numbers whose freshness window has passed. Retained
 * readings used to be indistinguishable from "never measured" and were sorted
 * unconditionally last; they are now ranked on the same expiry-risk axis at a
 * discount, which is what lets a structurally-unmeasurable provider compete.
 *
 * The two retained tiers differ by whether WAITING would help:
 *
 *  - STRUCTURAL (`no-data`): the provider exposes no outbound quota interface,
 *    so a reading only exists while a session is open — Claude Code's
 *    statusline bridge is the canonical case (quota/fetchers/claude.ts), and
 *    Antigravity's empty-bucket answer is the other. This is a STEADY STATE,
 *    not a transient one. Waiting produces nothing; only being SELECTED does,
 *    which is precisely the self-reinforcing loop this tier exists to break:
 *    a session must run to measure it → it is never picked while unmeasured →
 *    no session runs. Discounted the LEAST of the retained tiers, because the
 *    alternative is a provider that can never be measured at all.
 *
 *  - AGED (everything else — a transient carry-forward, an 'ok' snapshot past
 *    staleAfterMs): the channel works and the next refresh tick genuinely will
 *    produce a current number. Discounted MORE, because deferring to a
 *    measured candidate costs nothing here — the reading repairs itself.
 *
 * Both sit strictly below 1, so a CURRENT reading always outranks a retained
 * one of equal raw risk. Neither is 0, so a retained reading always outranks a
 * candidate with no reading at all. That total order — current > structural >
 * aged > nothing — is the whole of the policy, and it is derived from the
 * snapshot's own machine-readable fields, never from a provider name.
 */
const CONFIDENCE_CURRENT = 1;
const CONFIDENCE_RETAINED_STRUCTURAL = 0.7;
const CONFIDENCE_RETAINED_AGED = 0.4;

/**
 * Failure kinds meaning "the capture channel is healthy but holds no CURRENT
 * reading, and only a SESSION produces one" — see the STRUCTURAL tier above and
 * the 'no-data' documentation in quota/types.ts.
 *
 * ★Deliberately a FAILURE-KIND test, never a provider-name list. Any fetcher
 * that reports 'no-data' is declaring this property about itself, so a new
 * provider with the same shape is classified correctly the day it lands, with
 * no edit here. A hardcoded ['claude-cli', ...] would have to be found and
 * updated by whoever adds the next one — which is exactly how the fleet-wide
 * claude stranding went unnoticed.
 */
const STRUCTURALLY_UNMEASURABLE_FAILURE_KINDS: ReadonlySet<string> = new Set(['no-data']);

/**
 * Is this snapshot's inability to report a CURRENT reading structural (only a
 * session refreshes it) rather than a transient gap the refresh timer closes?
 */
function isStructurallyUnmeasurable(quota: MeshNodeFactsProviderQuota): boolean {
    const kind = (quota as any).metadata?.failureKind;
    return typeof kind === 'string' && STRUCTURALLY_UNMEASURABLE_FAILURE_KINDS.has(kind);
}

/**
 * Expiry-risk metric: how much of this provider's remainder on one window axis
 * ('weekly' or 'session') is likely to EVAPORATE unused at the window reset if
 * it is not consumed now.
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
 * ONE formula, both axes: the session (~5h) and weekly (~7d) windows report
 * the same shape (usedPercent/windowMinutes/resetsAt), so the axis selects
 * only which window is read — the math is not duplicated.
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
 *
 * RETAINED readings (see CONFIDENCE above) are admitted here rather than
 * rejected: a snapshot that carries real windows but is no longer current
 * yields its measured risk with a confidence below 1, which the sort applies
 * as a discount. Only a snapshot with NO readable window at all — never
 * measured, opted out, or a failure that erased its numbers — still returns
 * undefined, because there is genuinely nothing to rank it on.
 *
 * ★What is NOT admitted: this function never invents a reading. Every number
 * it returns was measured by the provider at some point. The confidence tier
 * describes how long ago, not how much was guessed.
 */
function expiryRiskForRanking(
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
    // CONFIDENCE resolution. A fresh 'ok' snapshot is current; anything else
    // that still carries a readable window is a RETAINED reading, tiered by
    // whether waiting would repair it. A non-'ok' snapshot with no window
    // survives to the `remaining === undefined` bail below.
    const fresh = isQuotaSnapshotFresh(facts, quota, policy, now);
    const confidence = quota.status === 'ok' && fresh
        ? CONFIDENCE_CURRENT
        : isStructurallyUnmeasurable(quota)
            ? CONFIDENCE_RETAINED_STRUCTURAL
            : CONFIDENCE_RETAINED_AGED;
    const window = axis === 'session' ? quota.session : quota.weekly;
    const remaining = remainingPercent(window);
    if (remaining === undefined) return undefined;
    const resetsAt = Number(window?.resetsAt);
    if (!Number.isFinite(resetsAt) || resetsAt <= 0) return { remainingPercent: remaining, risk: 0, confidence };
    const ageMs = quotaSnapshotAgeMs(facts, quota, now);
    if (!Number.isFinite(ageMs)) return { remainingPercent: remaining, risk: 0, confidence };
    const reporterNowMs = Number(quota.updatedAt) + ageMs;
    const windowMinutes = Number(window?.windowMinutes);
    const fallbackMinutes = axis === 'session' ? DEFAULT_SESSION_WINDOW_MINUTES : DEFAULT_WEEKLY_WINDOW_MINUTES;
    const windowMs = (Number.isFinite(windowMinutes) && windowMinutes > 0
        ? windowMinutes : fallbackMinutes) * 60 * 1000;
    const elapsedFraction = Math.min(1, Math.max(0, 1 - (resetsAt - reporterNowMs) / windowMs));
    return { remainingPercent: remaining, risk: remaining * elapsedFraction, confidence };
}

/** The ranking score for one reading: its expiry risk scaled by how much the
 *  reading is trusted to still describe the provider (see CONFIDENCE). This is
 *  the ONE place the discount is applied, so both window axes and every
 *  observability reader agree on what "rank" means. */
function rankedRisk(reading: ExpiryRisk): number {
    return reading.risk * reading.confidence;
}

export interface ProviderQuotaGateRanking {
    /** Gate-clear providers, best first: weekly EXPIRY-RISK DESC (remaining ×
     *  elapsed window fraction × reading CONFIDENCE) — or SESSION (5h)
     *  expiry-risk DESC while every weekly-readable candidate clears
     *  sessionAxisWeeklyHeadroomPercent — then confidence DESC and remaining
     *  DESC on a risk tie, providers with NO readable reading LAST, and the
     *  caller's original order preserved within each group (stable sort). */
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
 * measured windows that are no longer current now ranks on the SAME expiry-risk
 * axis, scaled by a CONFIDENCE factor below 1 (see the CONFIDENCE tiers). So:
 *
 *   - a current reading still outranks a retained one of equal raw risk;
 *   - a retained reading with substantial risk CAN outrank a current reading
 *     with little — which is the competition that was missing;
 *   - a structurally-unmeasurable provider is discounted less than a merely
 *     aged one, because waiting repairs the second and never the first.
 *
 * The two original rejections still hold and are still rejected:
 *   - unknown-first ("assumed full") would let an unmeasurable provider win
 *     every contest — the sort becomes meaningless AND it preferentially
 *     overloads the one provider that declined to be measured, the exact
 *     failure mode the module header bans. The confidence discount is bounded
 *     by a REAL past measurement, so it can never behave this way.
 *   - treating unknown as blocked would silently strand opted-out providers
 *     (quotaEnabled === false), violating the fail-open contract.
 *
 * NO-READING-AT-ALL candidates (never measured, opted out, or a failure that
 * erased the numbers) are still sorted LAST, unchanged: there is nothing to
 * discount, so there is nothing to rank. They remain gate-CLEAR and are picked
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
 * Being out-ranked and being BLOCKED are different things: a fail-open
 * candidate (missing / stale / an unmarked transient reading) is never blocked
 * — it only lands in the unknown group. A transient error with fresh retained
 * last-good windows may still be blocked by those measured windows. The
 * fail-open contract of evaluateProviderQuotaGate is inherited unchanged.
 */
export function rankProvidersByQuotaGate(
    node: any,
    orderedProviderTypes: string[],
    policy?: RepoMeshQuotaRoutingPolicy | null,
    now: number = Date.now(),
    context?: QuotaFactsContext | null,
): ProviderQuotaGateRanking {
    const clear: string[] = [];
    const gated: ProviderQuotaGateRanking['gated'] = [];
    for (const providerType of orderedProviderTypes) {
        const block = evaluateProviderQuotaGate(node, providerType, policy, now, context);
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
    // RETAINED readings participate in this gate on their remainingPercent,
    // undiscounted, and that is deliberate: the gate asks "is anyone's weekly
    // budget tight?", which is a question about the MEASUREMENT, not about how
    // current it is. Discounting here would let an aged reading of a nearly
    // exhausted weekly window read as roomy and unlock session-axis harvesting
    // against a budget that is actually tight — the confidence discount
    // belongs on the ordering, not on the protection.
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
        // NO reading at all still sorts last — nothing to rank on. A RETAINED
        // reading is NOT in this branch: it has real numbers and competes
        // below via its confidence-discounted risk.
        if (wa === undefined && wb === undefined) return 0; // both unreadable: keep caller order
        if (wa === undefined) return 1;
        if (wb === undefined) return -1;
        if (sessionByProvider) {
            const sa = sessionByProvider.get(a);
            const sb = sessionByProvider.get(b);
            if (sa !== undefined && sb !== undefined) {
                const ra = rankedRisk(sa);
                const rb = rankedRisk(sb);
                if (rb !== ra) return rb - ra; // session expiry risk DESC (confidence-discounted)
                if (sb.remainingPercent !== sa.remainingPercent) {
                    return sb.remainingPercent - sa.remainingPercent; // session remaining tie-break
                }
            } else if (sa !== undefined) return -1; // session-unreadable sorts below session-readable
            else if (sb !== undefined) return 1;
            // Both session-unreadable (or a full session tie): the weekly order
            // below is the fail-open fallback — an unreadable 5h axis never
            // changes what the weekly axis would have decided.
        }
        const ra = rankedRisk(wa);
        const rb = rankedRisk(wb);
        if (rb !== ra) return rb - ra; // expiry risk DESC (confidence-discounted)
        // Risk tie (e.g. equal reset time, or two zero-risk readings): the more
        // TRUSTED reading wins first — a current reading beats a retained one
        // that happens to score the same — then the larger weekly remainder,
        // the original even-spend axis. A further tie keeps the caller order
        // (stable sort).
        if (wb.confidence !== wa.confidence) return wb.confidence - wa.confidence;
        return wb.remainingPercent - wa.remainingPercent;
    });
    return { clear, gated };
}

/**
 * RECOVERY RELAUNCH resolution: after a worker session DIES, the recovery path
 * re-queues the task and immediately relaunches the SAME provider that just
 * died. When the death was caused by an exhausted quota, that relaunch dies
 * again for the identical reason — the observed "죽음 1회는 claim 이 만들었지만,
 * 2·3회는 relaunch 가 만들었다" loop. This resolves what the relaunch should
 * actually do instead.
 *
 * ★THE DECIDING INPUT IS THE QUOTA SNAPSHOT, NEVER THE DEATH ITSELF.
 * This function is not told, and deliberately cannot ask, WHY the session died.
 * It re-uses evaluateProviderQuotaGate verbatim, which blocks on measured quota
 * readings (a fresh 'quota-exhausted' error, or fresh current/retained windows
 * below a threshold) and fails OPEN on everything else. So a
 * death with a healthy quota — the kimi trust-prompt case, where six
 * consecutive sessions exited 0 within ~20ms in a fresh worktree while quota was
 * perfectly fine — reads `keep` and relaunches exactly as before. Inferring
 * "died repeatedly ⇒ out of quota" would have quota-blacklisted a provider over
 * an environment problem; that inference is not made anywhere here, which is why
 * no consecutive-death counter is introduced (see the module-level note on the
 * commit).
 *
 * ★DEADLOCK SAFETY. The self-healing deadlock that got the CLAIM-path gate
 * debated — token expires → claim blocked → CLI never runs → token never
 * refreshes, because the CLI owns its own token lifecycle (quota/fetchers/
 * kimi.ts) — cannot arise here for the same structural reason it cannot arise
 * in the launch gate: an 'expired-token' entry without trustworthy windows
 * still fails OPEN. If it carries fresh last-good windows already showing
 * exhaustion, those measured windows may block, but only until staleAfterMs;
 * after that it fails open, so the gate cannot create a permanent refresh
 * deadlock. A single-provider node with only an expired token therefore still
 * relaunches and can refresh it.
 *
 * ★BLOCKING IS NEVER A DEAD END. The recovery path re-queues the task BEFORE it
 * relaunches, and this resolver never touches the queue: a blocked relaunch
 * leaves a PENDING task that the ordinary drain re-claims — through the claim
 * gate, another node, or this same node once the window resets. `fallbackTo`
 * additionally lets the caller relaunch the node's NEXT gate-clear provider
 * rather than nothing at all, so a node that has somewhere else to go goes
 * there immediately instead of waiting for a reset.
 */
export interface RecoveryRelaunchDecision {
    /** 'keep': relaunch the failed provider (the pre-gate behaviour, and the
     *  outcome for every non-quota death). 'fallback': relaunch a DIFFERENT,
     *  gate-clear provider on the same node. 'block': do not relaunch; the
     *  re-queued task waits for the drain. */
    action: 'keep' | 'fallback' | 'block';
    /** The provider to launch. Set for 'keep' and 'fallback' only. */
    providerType?: string;
    /** Why the failed provider was gated — set whenever the failed provider
     *  was blocked (i.e. for 'fallback' and 'block'). */
    block?: ProviderQuotaGateBlock;
}

/**
 * Decide whether a recovery relaunch may reuse the provider that just died.
 *
 * `nodeProviderTypes` is the node's other candidate providers in the caller's
 * preferred order; pass an empty list when the node has no alternative (a
 * single-provider node then resolves to 'block', never to a phantom provider).
 * Fall-through candidates are ordered by rankProvidersByQuotaGate, the same
 * weekly-expiry-risk ranking the auto-launch selection loop uses, so recovery
 * and normal dispatch agree on which provider to spend next.
 *
 * Deliberately synchronous and side-effect free: it reads in-memory nodeFacts
 * (including clone-source facts from the supplied context), never triggers a
 * fetch, and never mutates the queue.
 */
export function resolveRecoveryRelaunchProvider(
    node: any,
    failedProviderType: string,
    nodeProviderTypes: string[] = [],
    policy?: RepoMeshQuotaRoutingPolicy | null,
    now: number = Date.now(),
    context?: QuotaFactsContext | null,
): RecoveryRelaunchDecision {
    if (!failedProviderType) return { action: 'block' };
    // The ONLY quota question asked: is the failed provider's own snapshot
    // blocking RIGHT NOW? Fail-open covers unknown/stale/transient/opted-out.
    const block = evaluateProviderQuotaGate(node, failedProviderType, policy, now, context);
    if (!block) return { action: 'keep', providerType: failedProviderType };

    // The failed provider is measurably out of quota. Prefer another provider
    // on the same node over stalling — ranked by the same expiry-risk order as
    // the auto-launch loop, and gate-checked so we never trade one exhausted
    // provider for another.
    const alternatives = nodeProviderTypes.filter(p => p && p !== failedProviderType);
    if (alternatives.length) {
        const ranked = rankProvidersByQuotaGate(node, alternatives, policy, now, context);
        if (ranked.clear.length) {
            return { action: 'fallback', providerType: ranked.clear[0], block };
        }
    }
    // Nowhere to fall through to. The task was already re-queued by the caller
    // and stays pending — the drain re-claims it when a window resets or
    // another node picks it up. Not actionable (a quota WAIT), same semantics
    // as the launch/claim gates.
    return { action: 'block', block };
}

/**
 * OBSERVABILITY (recovery-relaunch): the log line for a gate decision that
 * DIVERTED, or null for 'keep' (the overwhelmingly common outcome — every
 * non-quota death — which must stay silent so the recovery path does not
 * gain a log line per session death). Lives here rather than at the call site
 * so mesh-event-forwarding.ts carries only the branch, not the formatting.
 */
export function describeRecoveryRelaunchDecision(
    decision: RecoveryRelaunchDecision,
    nodeId: string,
    failedProviderType: string,
    taskId?: string,
): string | null {
    if (decision.action === 'keep') return null;
    const cause = `provider '${failedProviderType}' is quota-blocked (${decision.block?.reason ?? 'unknown'})`;
    if (decision.action === 'fallback') {
        return `QUOTA GATE: recovery relaunch for node ${nodeId} falls through — ${cause} — relaunching '${decision.providerType}' instead`;
    }
    return `QUOTA GATE: skipping recovery relaunch for node ${nodeId} — ${cause} and the node has no gate-clear alternative${taskId ? `; task ${taskId}` : ''} stays queued until a quota window resets`;
}

/**
 * OBSERVABILITY (quota-ranking): per-provider expiry-risk snapshot for every
 * candidate the ranking loop considered, clear or gated. Order-preserving
 * (caller's candidate order, not the sorted rank) so a log line or a
 * mesh_status reader can show "here is what each candidate looked like"
 * without re-deriving expiryRiskForRanking itself (kept module-private — this
 * is the one sanctioned way to read it from outside the module).
 * remainingPercent/risk are undefined for the same reasons rankProvidersByQuotaGate's
 * unknown group exists: no snapshot, non-'ok', stale, or no weekly window.
 */
export interface ProviderQuotaRiskSnapshot {
    providerType: string;
    remainingPercent?: number;
    /** Raw expiry risk, BEFORE the confidence discount. */
    risk?: number;
    /** Reading confidence 0..1 (see the CONFIDENCE tiers). Emitted only when
     *  it is NOT 1, i.e. only for a RETAINED reading — a current reading needs
     *  no annotation, and omitting it keeps the common case's payload
     *  byte-identical to before this field existed. */
    confidence?: number;
    /** `risk × confidence` — what the sort actually compared. Emitted only
     *  alongside `confidence`, for the same reason: when confidence is 1 this
     *  equals `risk` and repeating it would be pure payload. */
    rankedRisk?: number;
}

export function quotaRiskSnapshotForCandidates(
    node: any,
    orderedProviderTypes: string[],
    policy?: RepoMeshQuotaRoutingPolicy | null,
    now: number = Date.now(),
    context?: QuotaFactsContext | null,
): ProviderQuotaRiskSnapshot[] {
    return orderedProviderTypes.map(providerType => {
        const w = expiryRiskForRanking(node, providerType, 'weekly', policy, now, context);
        return {
            providerType,
            ...(w ? {
                remainingPercent: w.remainingPercent,
                risk: w.risk,
                ...(w.confidence !== CONFIDENCE_CURRENT
                    ? { confidence: w.confidence, rankedRisk: rankedRisk(w) }
                    : {}),
            } : {}),
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
    /** The TASK this decision routed, when one was in play. Without it a
     *  reader can see the ranking but not what it was ranking FOR. */
    taskId?: string;
    /** ★SELECTION RATIONALE — the stage-1 fitness half of the decision.
     *
     *  Why this exists: the rich `selectionTrajectory` is written only into the
     *  `task_dispatched` LEDGER payload, readable by exactly one tool
     *  (mesh_task_history). `mesh_status` — where a coordinator actually looks
     *  when asked "why did this provider win?" — carried the quota order and
     *  nothing else. On 2026-08-20 an owner asked precisely that question and
     *  the coordinator, having no per-slot scores to read, back-derived an
     *  estimate and stated it as fact twice. Both times it was wrong.
     *
     *  Deliberately a SUMMARY, not a copy of the trajectory: winner plus the
     *  beaten candidates with their fitness scores and one reason each,
     *  bounded by RATIONALE_LOSERS_MAX. Enough to answer the question without
     *  turning a per-node status field into a per-dispatch record. */
    rationale?: QuotaRankingRationale;
}

/** Compact "why this provider won" summary — see LastQuotaRankingRecord.rationale. */
export interface QuotaRankingRationale {
    winner: { providerType: string; model?: string; fitnessScore?: number };
    /** Beaten candidates, best-first, each with the reason it lost. */
    losers: Array<{ providerType: string; model?: string; fitnessScore?: number; reason: string }>;
    /** How many losers were dropped to stay within the bound. */
    losersOmitted?: number;
}

/** Bound on `rationale.losers`. A node's slot count is small, so this is a
 *  guard against a pathological config rather than a routine truncation. */
const RATIONALE_LOSERS_MAX = 4;

/** Build the compact rationale, bounding the loser list. Lives here beside the
 *  record it populates so every writer produces the same shape. */
export function buildQuotaRankingRationale(
    winner: { providerType: string; model?: string; fitnessScore?: number },
    losers: Array<{ providerType: string; model?: string; fitnessScore?: number; reason: string }>,
): QuotaRankingRationale {
    return {
        winner,
        losers: losers.slice(0, RATIONALE_LOSERS_MAX),
        ...(losers.length > RATIONALE_LOSERS_MAX ? { losersOmitted: losers.length - RATIONALE_LOSERS_MAX } : {}),
    };
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
    context?: QuotaFactsContext | null,
): Record<string, number> {
    const resolved = resolveQuotaRoutingPolicy(policy);
    const out: Record<string, number> = {};
    const directQuota = node?.nodeFacts?.quota;
    const sourceQuota = cloneSourceNodeFor(node, context)?.nodeFacts?.quota;
    const providers = new Set<string>([
        ...Object.keys(sourceQuota && typeof sourceQuota === 'object' ? sourceQuota : {}),
        ...Object.keys(directQuota && typeof directQuota === 'object' ? directQuota : {}),
    ]);
    for (const provider of providers) {
        const entry = quotaEntryFor(node, provider, context, now);
        if (!entry) continue;
        const { facts, quota: snapshot } = entry;
        let bonus = 0;
        if (snapshot && typeof snapshot === 'object' && snapshot.status === 'ok'
            && isQuotaSnapshotFresh(facts, snapshot, policy, now)) {
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
