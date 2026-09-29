/**
 * What the scheduler does with a quota ranking beyond the pick itself: the
 * recovery-relaunch provider choice, the per-candidate risk snapshot, the
 * last-ranking record surfaced to observability (with its rationale and claim
 * outcome), and the quota-headroom spread bonus the fitness ranking adds.
 */
import { evaluateProviderQuotaGate, rankProvidersByQuotaGate, expiryRiskForRanking, isWindowTrustworthy, type ProviderQuotaGateBlock, type ProviderQuotaRankingEvidence } from './mesh-quota-routing.js';
import { resolveQuotaRoutingPolicy, type RepoMeshQuotaRoutingPolicy } from '../repo-mesh-types.js';
import { cloneSourceNodeFor, quotaEntryFor, remainingPercent, classifyAbsentQuotaReason, type QuotaFactsContext } from './mesh-quota-sources.js';

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
interface RecoveryRelaunchDecision {
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
 * `axis` names the window the ranking actually used for that provider.
 * remainingPercent/risk are undefined for the same reasons
 * rankProvidersByQuotaGate's unknown group exists: no snapshot, an
 * untrustworthy window, or no readable window on that axis.
 */
export interface ProviderQuotaRiskSnapshot {
    providerType: string;
    /** Window axis used by the ranking for this provider. A provider can be
     *  weekly while session mode is active when its session window is
     *  unreadable and the comparator falls back. */
    axis: 'weekly' | 'session';
    remainingPercent?: number;
    /** Expiry risk compared directly by the ranking. */
    risk?: number;
}

export function quotaRiskSnapshotForCandidates(
    node: any,
    orderedProviderTypes: string[],
    policy?: RepoMeshQuotaRoutingPolicy | null,
    now: number = Date.now(),
    context?: QuotaFactsContext | null,
    ranking?: {
        sessionAxisActive?: boolean;
        rankingEvidence?: ProviderQuotaRankingEvidence[];
    },
): ProviderQuotaRiskSnapshot[] {
    // Reuse the decision's per-candidate evidence when the caller has it. The
    // standalone observability API computes that same decision once so it can
    // never silently label session-ranked numbers as weekly.
    const resolvedRanking = ranking
        ?? rankProvidersByQuotaGate(node, orderedProviderTypes, policy, now, context);
    const evidenceByProvider = new Map(
        (resolvedRanking.rankingEvidence ?? []).map(evidence => [evidence.providerType, evidence]),
    );
    return orderedProviderTypes.map(providerType => {
        const evidence = evidenceByProvider.get(providerType);
        const axis: 'weekly' | 'session' = evidence?.axis
            ?? (resolvedRanking.sessionAxisActive ? 'session' : 'weekly');
        const w = expiryRiskForRanking(node, providerType, axis, policy, now, context);
        return {
            providerType,
            axis,
            ...(w ? {
                remainingPercent: w.remainingPercent,
                risk: w.risk,
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
    /** ★CLAIM OUTCOME — whether the claim this record was written for actually
     *  went on to SUCCEED.
     *
     *  Why: this record is written at the TOP of tryAssignQueueTask, before a
     *  single gate has run (the adopt-path write is deliberately unconditional so
     *  a claim path that never ranks is still distinguishable from "never
     *  dispatched here"). That means a node whose claim was refused microseconds
     *  later — by the ff lease, a difficulty floor, a parallel cap — still shows a
     *  ranking here, and it reads as evidence the dispatch happened. On
     *  2026-08-20 a coordinator relied on exactly that and misjudged a node that
     *  had claimed nothing.
     *
     *  Left undefined by writers that do not know the outcome yet; set to
     *  'claimed' or 'refused' by tryAssignQueueTask once it does. A reader
     *  MUST NOT treat a ranking as proof of dispatch — check this field. */
    claimOutcome?: 'claimed' | 'refused';
    /** When claimOutcome === 'refused', the gate that refused (see
     *  MeshClaimRefusalReason). Ids/enums only — never task content. */
    claimRefusalReason?: string;
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
 * Stamp the CLAIM OUTCOME onto the ranking already recorded for this node.
 *
 * The ranking is written before any gate runs, so on its own it says only "a claim
 * was attempted here", never "a task was dispatched here". This closes that gap in
 * place — a merge, not an overwrite, so the winner/rationale a reader wants are
 * preserved while the outcome stops being an assumption. No-op when no ranking has
 * been recorded for the node (nothing to qualify).
 */
export function recordLastQuotaRankingOutcome(
    nodeId: string,
    outcome: 'claimed' | 'refused',
    refusalReason?: string,
): void {
    if (!nodeId) return;
    const existing = lastQuotaRankingByNode.get(nodeId);
    if (!existing) return;
    lastQuotaRankingByNode.set(nodeId, {
        ...existing,
        claimOutcome: outcome,
        ...(outcome === 'refused' && refusalReason ? { claimRefusalReason: refusalReason } : {}),
    });
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
        // Same window-boundary validity as the gate (owner decision
        // 2026-08-24): a measured window expresses the spread preference
        // until its own resetsAt, wall-clock age notwithstanding. The stale
        // reading's headroom is an UPPER bound (usage only grew since), so
        // it can overstate a preference but never manufacture one — an
        // acceptable trade for a bounded tie-breaker axis, versus the
        // previous behaviour where intermittent refresh zeroed the whole
        // axis. Windows still need provenance: an 'ok' reading or retained
        // lastGoodWindows; other failures carry no usable windows.
        const windowsEligible = snapshot && typeof snapshot === 'object'
            && (snapshot.status === 'ok' || (snapshot as any).metadata?.lastGoodWindows === true);
        if (windowsEligible) {
            const ratios = [
                isWindowTrustworthy(snapshot.session, facts, snapshot, policy, now) ? remainingPercent(snapshot.session) : undefined,
                isWindowTrustworthy(snapshot.weekly, facts, snapshot, policy, now) ? remainingPercent(snapshot.weekly) : undefined,
            ]
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

type QuotaSpreadBonusZeroReason =
    | 'stale'
    | 'no-data'
    | 'opted-out'
    | 'provider-disabled'
    | 'snapshot-error'
    | 'zero-headroom';

export interface ProviderQuotaBonusDiagnostic {
    providerType: string;
    value: number;
    zeroReason?: QuotaSpreadBonusZeroReason;
    snapshotStatus?: string;
    failureKind?: string;
}

/**
 * Explain the output of quotaSpreadBonusByProvider without reimplementing its
 * scoring formula. The production bonus function above remains the sole
 * calculator; this observer only classifies why its returned value is zero.
 * Everything is an in-memory facts/cache read through quotaEntryFor — no quota
 * fetch is performed.
 */
export function quotaSpreadBonusDiagnosticsByProvider(
    node: any,
    providerTypes: string[],
    policy?: RepoMeshQuotaRoutingPolicy | null,
    now: number = Date.now(),
    context?: QuotaFactsContext | null,
): ProviderQuotaBonusDiagnostic[] {
    const bonuses = quotaSpreadBonusByProvider(node, policy, now, context);
    return [...new Set(providerTypes)].map(providerType => {
        const value = bonuses[providerType] ?? 0;
        const entry = quotaEntryFor(node, providerType, context, now);
        if (!entry) {
            const absentReason = classifyAbsentQuotaReason(node, providerType, context);
            const zeroReason: QuotaSpreadBonusZeroReason = absentReason === 'probe_disabled'
                ? 'opted-out'
                : absentReason === 'provider_disabled'
                    ? 'provider-disabled'
                    : 'no-data';
            return { providerType, value, ...(value === 0 ? { zeroReason } : {}) };
        }

        const { facts, quota } = entry;
        const snapshotStatus = typeof quota.status === 'string' ? quota.status : undefined;
        const failureKind = typeof (quota as any).metadata?.failureKind === 'string'
            ? (quota as any).metadata.failureKind
            : undefined;
        let zeroReason: QuotaSpreadBonusZeroReason | undefined;
        if (value === 0) {
            // Mirrors the calculator's eligibility order: provenance first
            // (windows only count from 'ok' or retained-last-good snapshots),
            // then per-window reset-boundary trust — 'stale' now means "every
            // measured window is past its own reset (or unverifiable)", not
            // mere wall-clock age.
            const windowsEligible = quota.status === 'ok' || (quota as any).metadata?.lastGoodWindows === true;
            if (!windowsEligible) {
                zeroReason = failureKind === 'no-data' ? 'no-data' : 'snapshot-error';
            } else if (!quota.session && !quota.weekly) {
                zeroReason = 'no-data';
            } else if (!isWindowTrustworthy(quota.session, facts, quota, policy, now)
                && !isWindowTrustworthy(quota.weekly, facts, quota, policy, now)) {
                zeroReason = 'stale';
            } else {
                zeroReason = 'zero-headroom';
            }
        }
        return {
            providerType,
            value,
            ...(zeroReason ? { zeroReason } : {}),
            ...(snapshotStatus ? { snapshotStatus } : {}),
            ...(failureKind ? { failureKind } : {}),
        };
    });
}
