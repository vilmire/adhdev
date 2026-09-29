/**
 * Where quota-routing facts come from: the local daemon's live quota cache and
 * provider enablement, a node's reported quota (or its clone source's), snapshot
 * age / freshness, and the rate-limited fail-open logging when a snapshot is stale
 * or absent. Pure lookups — the gate and ranking decide what the facts mean.
 */
import { meshNodeIdMatches, type MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared';
import { readQuotaCache } from '../quota/refresh.js';
import { resolveQuotaRoutingPolicy, type RepoMeshQuotaRoutingPolicy } from '../repo-mesh-types.js';
import { LOG } from '../logging/logger.js';

interface LiveLocalQuotaSource {
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
interface LiveLocalProviderEnablementSource {
    isMachineProviderEnabled(providerType: string): boolean;
    isMachineQuotaEnabled(providerType: string): boolean;
    /** Same locality contract as LiveLocalQuotaSource.isLocalNode — true only
     *  for a node that resolves to THIS daemon (or its worktree-clone source).
     *  A remote node's enablement lives on a config this daemon never reads. */
    isLocalNode(node: any): boolean;
}

export interface QuotaFactsContext {
    nodes?: any[];
    /** Observation-only callers (mesh_route_preview) must not consume the
     * production fail-open log rate limit or emit routing logs. */
    suppressObservabilityLogs?: boolean;
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
interface QuotaEnablementLoader {
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
export function quotaEntryFor(
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

export function cloneSourceNodeFor(node: any, context?: QuotaFactsContext | null): any | undefined {
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
export function remainingPercent(window: { usedPercent: number } | null | undefined): number | undefined {
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
export function logStaleQuotaFailOpen(
    node: any,
    providerType: string,
    facts: { reportedAt: number },
    quota: { updatedAt: number },
    policy: RepoMeshQuotaRoutingPolicy | null | undefined,
    now: number,
    context?: QuotaFactsContext | null,
): void {
    if (context?.suppressObservabilityLogs === true) return;
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
type AbsentQuotaReason = 'not_measured' | 'probe_disabled' | 'provider_disabled' | 'unclassified_remote';

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
export function classifyAbsentQuotaReason(
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
export function logAbsentQuotaFailOpen(
    node: any,
    providerType: string,
    policy: RepoMeshQuotaRoutingPolicy | null | undefined,
    now: number,
    context?: QuotaFactsContext | null,
): void {
    if (context?.suppressObservabilityLogs === true) return;
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
