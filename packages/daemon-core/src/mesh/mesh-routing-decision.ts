import type { NodeCapabilitySlot } from '@adhdev/mesh-shared';
import type { RepoMeshQuotaRoutingPolicy } from '../repo-mesh-types.js';
import { LOG } from '../logging/logger.js';
import { buildQuotaRankingRationale, quotaRiskSnapshotForCandidates, quotaSpreadBonusByProvider, type ProviderQuotaRiskSnapshot, type QuotaFactsContext, type QuotaRankingRationale } from './mesh-quota-routing.js';
import { scoreSlotForTask, scoreSlotForTaskBreakdown, slotDifficultyTierForTask, slotHasCapacity, type FitnessTask } from './mesh-scheduling-fitness.js';

export interface MeshIntraNodeLoser {
    providerType: string;
    model?: string;
    fitnessScore?: number;
    quotaRisk?: number;
    reason: string;
}

export interface MeshRoutingCandidate {
    providerType: string;
    model?: string;
    fitnessScore: number;
    capacityAvailable: boolean;
    difficultyEligible: boolean;
}

export interface MeshQuotaOrderEntry {
    providerType: string;
    quotaRisk?: number;
    gated?: boolean;
}

export interface MeshSelectionTrajectory {
    /** Detected slots admitted by the hard floor, before capacity-tier/quota narrowing. */
    candidates: MeshRoutingCandidate[];
    candidatesOmitted?: number;
    /** Provider order after quota gating/risk reordering. */
    quotaOrder: MeshQuotaOrderEntry[];
    quotaOrderOmitted?: number;
    /** Provider competition winner and the slot on which it won. */
    providerWinner: { providerType: string; model?: string; fitnessScore: number; quotaRisk?: number };
    /** Final transition from the winning slot to the slot that actually launched. */
    slotFinalization?: {
        winningSlot: { providerType: string; model?: string };
        executedSlot: { providerType: string; model?: string };
        demoted: boolean;
        demotionReason?: string;
        otherProviderAvailableAtDemotion?: boolean;
    };
}

export interface ResolvedProviderSelection {
    providerType?: string;
    model?: string;
    thinkingLevel?: string;
    slot?: NodeCapabilitySlot;
    reason?: string;
    quotaRiskSnapshot?: ProviderQuotaRiskSnapshot[];
    quotaRisksOmitted?: number;
    intraNodeLosers?: MeshIntraNodeLoser[];
    intraNodeLosersOmitted?: number;
    selectionTrajectory?: MeshSelectionTrajectory;
}

interface ProviderSlotCandidate {
    slot: NodeCapabilitySlot;
    providerType: string;
}

interface ProviderQuotaRanking {
    clear: string[];
    gated: Array<{ providerType: string; block: { reason: string } }>;
}

export interface ProviderSelectionDiagnostics {
    riskSnapshot: ProviderQuotaRiskSnapshot[];
    quotaRiskSnapshot?: ProviderQuotaRiskSnapshot[];
    quotaRisksOmitted?: number;
    intraNodeLosers?: MeshIntraNodeLoser[];
    intraNodeLosersOmitted?: number;
    selectionTrajectory?: MeshSelectionTrajectory;
    /** The UNBOUNDED loser list, before `intraNodeLosers`' 2-entry durable-payload
     *  cap. Not part of any persisted payload — it exists so an in-memory reader
     *  (the mesh_status selection rationale) can apply its own, looser bound
     *  instead of inheriting a cap chosen for the ledger's byte budget. */
    allLosers?: MeshIntraNodeLoser[];
}

// Compact, durable routing rationale written into task_dispatched. Candidate arrays
// are bounded by the provider resolver before they reach this type.
export interface MeshTaskRoutingDecision {
    source: 'queue' | 'autoLaunch' | 'direct';
    fitnessScore?: number;
    selectedSlot?: { providerType: string; model?: string };
    skippedCandidates?: Array<{ nodeId: string; reason: string }>;
    skippedCandidatesOmitted?: number;
    requiredTagsResult?: { required: string[]; satisfied: boolean; missing: string[] };
    resolvedProviderType?: string;
    resolvedModel?: string;
    resolvedThinkingLevel?: string;
    resolvedDifficulty?: string;
    quotaRiskSnapshot?: ProviderQuotaRiskSnapshot[];
    quotaRisksOmitted?: number;
    intraNodeLosers?: MeshIntraNodeLoser[];
    intraNodeLosersOmitted?: number;
    selectionTrajectory?: MeshSelectionTrajectory;
    reason?: string;
}

const ROUTING_ARRAY_MAX = 5;
const ROUTING_DECISION_MAX_BYTES = 2_000;
const INTRA_NODE_LOSERS_MAX = 2;

/** Build the detailed info-log evidence and compact durable provider-selection
 * fields without making the assignment engine carry observability formatting. */
export function buildProviderSelectionDiagnostics(args: {
    node: any;
    nodeId: string;
    meshId?: string;
    task?: FitnessTask;
    taskId?: string;
    quotaRouting?: RepoMeshQuotaRoutingPolicy | null;
    quotaFactsContext?: QuotaFactsContext | null;
    quotaBonusByProvider?: Record<string, number>;
    difficultyFloorRequired: boolean;
    usableSlots: ProviderSlotCandidate[];
    candidateSlots: ProviderSlotCandidate[];
    ranked: ProviderQuotaRanking;
    winner?: ProviderSlotCandidate;
}): ProviderSelectionDiagnostics {
    const now = Date.now();
    const riskSnapshot = quotaRiskSnapshotForCandidates(args.node, args.ranked.clear, args.quotaRouting, now, args.quotaFactsContext);
    const allRisks = quotaRiskSnapshotForCandidates(args.node, args.candidateSlots.map(candidate => candidate.providerType), args.quotaRouting, now, args.quotaFactsContext);
    const riskByProvider = new Map(allRisks.map(snapshot => [snapshot.providerType, snapshot]));
    const scoreDetails = args.task ? args.usableSlots.map(candidate => ({
        providerType: candidate.providerType,
        ...(candidate.slot.model ? { model: candidate.slot.model } : {}),
        capacityAvailable: slotHasCapacity(args.meshId ?? '', args.nodeId, args.node, candidate.slot),
        difficultyEligible: !args.difficultyFloorRequired || slotDifficultyTierForTask(candidate.slot, args.task!.difficulty) !== undefined,
        ...scoreSlotForTaskBreakdown(candidate.slot, args.task!, args.quotaBonusByProvider?.[candidate.slot.provider] ?? 0),
    })) : [];
    const quotaOrder = [
        ...args.ranked.clear.map(providerType => ({ providerType, ...(riskByProvider.get(providerType)?.risk !== undefined ? { quotaRisk: riskByProvider.get(providerType)!.risk } : {}) })),
        ...args.ranked.gated.map(entry => ({ providerType: entry.providerType, ...(riskByProvider.get(entry.providerType)?.risk !== undefined ? { quotaRisk: riskByProvider.get(entry.providerType)!.risk } : {}), gated: true })),
    ];
    if (args.taskId) {
        LOG.info('MeshQueue', `ROUTING DECISION taskId=${args.taskId} nodeId=${args.nodeId} candidates=${JSON.stringify(scoreDetails)} quotaOrder=${JSON.stringify(quotaOrder)} winner=${args.ranked.clear[0] ?? 'none'}`);
    }
    if (!args.winner || !args.task) return { riskSnapshot };

    const winner = args.winner;
    const losers = args.usableSlots.filter(candidate => candidate.slot !== winner.slot).map(candidate => {
        const risk = riskByProvider.get(candidate.providerType)?.risk;
        const hasCapacity = slotHasCapacity(args.meshId ?? '', args.nodeId, args.node, candidate.slot);
        const reason = (args.difficultyFloorRequired && !hasCapacity ? 'slot_capacity_exhausted' : undefined)
            ?? (args.difficultyFloorRequired && !args.candidateSlots.includes(candidate) ? 'higher_difficulty_tier_deferred' : undefined)
            ?? args.ranked.gated.find(entry => entry.providerType === candidate.providerType)?.block.reason
            ?? (candidate.providerType === winner.providerType
                ? (hasCapacity ? 'lower_slot_fitness' : 'slot_capacity_exhausted')
                : (risk === undefined ? 'lower_slot_order' : 'lower_quota_rank'));
        return {
            providerType: candidate.providerType,
            ...(candidate.slot.model ? { model: candidate.slot.model } : {}),
            fitnessScore: scoreSlotForTask(candidate.slot, args.task!, args.quotaBonusByProvider?.[candidate.slot.provider] ?? 0),
            ...(risk !== undefined ? { quotaRisk: risk } : {}),
            reason,
        };
    });
    const candidates = scoreDetails.map(detail => ({
        providerType: detail.providerType,
        ...(detail.model ? { model: detail.model } : {}),
        fitnessScore: detail.total,
        capacityAvailable: detail.capacityAvailable,
        difficultyEligible: detail.difficultyEligible,
    }));
    const winnerRisk = riskByProvider.get(winner.providerType)?.risk;
    return {
        riskSnapshot,
        ...(losers.length ? { allLosers: losers } : {}),
        ...(riskSnapshot.length ? { quotaRiskSnapshot: riskSnapshot.slice(0, ROUTING_ARRAY_MAX) } : {}),
        ...(riskSnapshot.length > ROUTING_ARRAY_MAX ? { quotaRisksOmitted: riskSnapshot.length - ROUTING_ARRAY_MAX } : {}),
        ...(losers.length ? { intraNodeLosers: losers.slice(0, INTRA_NODE_LOSERS_MAX) } : {}),
        ...(losers.length > INTRA_NODE_LOSERS_MAX ? { intraNodeLosersOmitted: losers.length - INTRA_NODE_LOSERS_MAX } : {}),
        selectionTrajectory: {
            candidates: candidates.slice(0, ROUTING_ARRAY_MAX),
            ...(candidates.length > ROUTING_ARRAY_MAX ? { candidatesOmitted: candidates.length - ROUTING_ARRAY_MAX } : {}),
            quotaOrder: quotaOrder.slice(0, ROUTING_ARRAY_MAX),
            ...(quotaOrder.length > ROUTING_ARRAY_MAX ? { quotaOrderOmitted: quotaOrder.length - ROUTING_ARRAY_MAX } : {}),
            providerWinner: {
                providerType: winner.providerType,
                ...(winner.slot.model ? { model: winner.slot.model } : {}),
                fitnessScore: scoreSlotForTask(winner.slot, args.task, args.quotaBonusByProvider?.[winner.slot.provider] ?? 0),
                ...(winnerRisk !== undefined ? { quotaRisk: winnerRisk } : {}),
            },
        },
    };
}

/**
 * Reduce a completed selection to the compact "why this provider won" summary
 * mesh_status surfaces (LastQuotaRankingRecord.rationale).
 *
 * Derived from the trajectory that was ALREADY computed rather than recomputed
 * from the slots, so the per-node rationale a coordinator reads can never
 * disagree with the per-dispatch trajectory the ledger stores. Returns
 * undefined when no provider competition happened (no winner, no task) — an
 * absent rationale is honest about that; a synthesized one would not be.
 */
export function selectionRationaleFrom(
    trajectory: MeshSelectionTrajectory | undefined,
    allLosers: MeshIntraNodeLoser[] | undefined,
): QuotaRankingRationale | undefined {
    const winner = trajectory?.providerWinner;
    if (!winner) return undefined;
    return buildQuotaRankingRationale(
        {
            providerType: winner.providerType,
            ...(winner.model ? { model: winner.model } : {}),
            fitnessScore: winner.fitnessScore,
        },
        (allLosers ?? []).map(loser => ({
            providerType: loser.providerType,
            ...(loser.model ? { model: loser.model } : {}),
            ...(loser.fitnessScore !== undefined ? { fitnessScore: loser.fitnessScore } : {}),
            reason: loser.reason,
        })),
    );
}

function serializedBytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** Keep the durable rationale below its established 2KB budget. The trajectory
 * is last to shrink: loser/skipped/duplicate quota tails pay the space cost first. */
function compactRoutingDecision(decision: MeshTaskRoutingDecision): MeshTaskRoutingDecision {
    while (serializedBytes(decision) >= ROUTING_DECISION_MAX_BYTES) {
        if ((decision.intraNodeLosers?.length ?? 0) > 1) {
            decision.intraNodeLosers!.pop();
            decision.intraNodeLosersOmitted = (decision.intraNodeLosersOmitted ?? 0) + 1;
            continue;
        }
        if ((decision.skippedCandidates?.length ?? 0) > 1) {
            decision.skippedCandidates!.pop();
            decision.skippedCandidatesOmitted = (decision.skippedCandidatesOmitted ?? 0) + 1;
            continue;
        }
        if ((decision.quotaRiskSnapshot?.length ?? 0) > 1) {
            decision.quotaRiskSnapshot!.pop();
            decision.quotaRisksOmitted = (decision.quotaRisksOmitted ?? 0) + 1;
            continue;
        }
        if ((decision.intraNodeLosers?.length ?? 0) > 0) {
            decision.intraNodeLosers!.pop();
            decision.intraNodeLosersOmitted = (decision.intraNodeLosersOmitted ?? 0) + 1;
            delete decision.intraNodeLosers;
            continue;
        }
        // Pathological identifiers/reasons can still exhaust the budget. Preserve
        // winner/finalization first, then trim only trajectory tails with an omitted count.
        if ((decision.selectionTrajectory?.candidates.length ?? 0) > 1) {
            decision.selectionTrajectory!.candidates.pop();
            decision.selectionTrajectory!.candidatesOmitted = (decision.selectionTrajectory!.candidatesOmitted ?? 0) + 1;
            continue;
        }
        if ((decision.selectionTrajectory?.quotaOrder.length ?? 0) > 1) {
            decision.selectionTrajectory!.quotaOrder.pop();
            decision.selectionTrajectory!.quotaOrderOmitted = (decision.selectionTrajectory!.quotaOrderOmitted ?? 0) + 1;
            continue;
        }
        break;
    }
    return decision;
}

export function buildAutoLaunchRoutingDecision(args: {
    node: any;
    meshId: string;
    task: FitnessTask;
    resolved: ResolvedProviderSelection & { providerType: string; slot: NodeCapabilitySlot };
    quotaRouting?: RepoMeshQuotaRoutingPolicy | null;
    quotaFactsContext?: QuotaFactsContext | null;
    skippedCandidates: Array<{ nodeId: string; reason: string }>;
    requiredTagsResult: { required: string[]; satisfied: boolean; missing: string[] };
    effectiveModel?: string;
    effectiveThinkingLevel?: string;
    executedSlot?: NodeCapabilitySlot;
    demotionReason?: string;
    otherProviderAvailableAtDemotion?: boolean;
}): MeshTaskRoutingDecision {
    const bonus = quotaSpreadBonusByProvider(args.node, args.quotaRouting, Date.now(), args.quotaFactsContext);
    const winningSlot = args.resolved.slot;
    const executedSlot = args.executedSlot ?? winningSlot;
    const winningProvider = args.resolved.providerType;
    // executedSlot is the SOLE source of what actually ran. The previous form —
    // `winningSlot.provider === executedSlot.provider ? winningProvider : executedSlot.provider`
    // — reported the WINNING provider whenever the two slots merely agreed on the
    // provider field, which is exactly the model-only demote case: `demoted` went
    // true while executedSlot.providerType still named the winner, so a reader
    // could not tell which half of the pair had moved. It also assumed provider
    // and model always move together, and it is the model-only branch that
    // disproves that. Derive both halves from the same slot so the record cannot
    // contradict itself.
    const executedProvider = executedSlot.provider;
    const sameDeclaredProvider = winningSlot.provider === executedSlot.provider;
    const winningModel = winningSlot.model?.trim() || undefined;
    const executedModel = executedSlot.model?.trim() || undefined;
    const demoted = !sameDeclaredProvider || winningModel !== executedModel;
    const baseTrajectory = args.resolved.selectionTrajectory;
    const boundedCandidates = baseTrajectory?.candidates.slice(0, ROUTING_ARRAY_MAX) ?? [];
    const boundedQuotaOrder = baseTrajectory?.quotaOrder.slice(0, ROUTING_ARRAY_MAX) ?? [];
    const selectionTrajectory: MeshSelectionTrajectory | undefined = baseTrajectory ? {
        ...baseTrajectory,
        candidates: boundedCandidates,
        ...(baseTrajectory.candidates.length > boundedCandidates.length
            ? { candidatesOmitted: (baseTrajectory.candidatesOmitted ?? 0) + baseTrajectory.candidates.length - boundedCandidates.length }
            : {}),
        quotaOrder: boundedQuotaOrder,
        ...(baseTrajectory.quotaOrder.length > boundedQuotaOrder.length
            ? { quotaOrderOmitted: (baseTrajectory.quotaOrderOmitted ?? 0) + baseTrajectory.quotaOrder.length - boundedQuotaOrder.length }
            : {}),
        slotFinalization: {
            winningSlot: {
                providerType: winningProvider,
                ...(winningModel ? { model: winningModel } : {}),
            },
            executedSlot: {
                providerType: executedProvider,
                ...(executedModel ? { model: executedModel } : {}),
            },
            demoted,
            ...(demoted ? {
                demotionReason: args.demotionReason ?? 'slot_reselected_during_launch',
                otherProviderAvailableAtDemotion: args.otherProviderAvailableAtDemotion
                    ?? baseTrajectory.candidates.some(candidate =>
                        candidate.providerType !== winningProvider
                        && candidate.capacityAvailable
                        && candidate.difficultyEligible),
            } : {}),
        },
    } : undefined;
    const boundedSkipped = args.skippedCandidates.slice(0, ROUTING_ARRAY_MAX);
    const boundedRisk = args.resolved.quotaRiskSnapshot?.slice(0, ROUTING_ARRAY_MAX);
    const boundedLosers = args.resolved.intraNodeLosers?.slice(0, ROUTING_ARRAY_MAX);
    const decision: MeshTaskRoutingDecision = {
        source: 'autoLaunch',
        fitnessScore: scoreSlotForTask(winningSlot, args.task, bonus[winningSlot.provider] ?? 0),
        selectedSlot: {
            providerType: executedProvider,
            ...(executedModel ? { model: executedModel } : {}),
        },
        ...(boundedSkipped.length ? { skippedCandidates: boundedSkipped } : {}),
        ...(args.skippedCandidates.length > boundedSkipped.length ? { skippedCandidatesOmitted: args.skippedCandidates.length - boundedSkipped.length } : {}),
        requiredTagsResult: args.requiredTagsResult,
        resolvedProviderType: args.resolved.providerType,
        ...(args.effectiveModel ? { resolvedModel: args.effectiveModel } : {}),
        ...(args.effectiveThinkingLevel ? { resolvedThinkingLevel: args.effectiveThinkingLevel } : {}),
        ...(args.task.difficulty ? { resolvedDifficulty: String(args.task.difficulty) } : {}),
        ...(boundedRisk?.length ? { quotaRiskSnapshot: boundedRisk } : {}),
        ...((args.resolved.quotaRisksOmitted ?? 0) + Math.max(0, (args.resolved.quotaRiskSnapshot?.length ?? 0) - (boundedRisk?.length ?? 0))
            ? { quotaRisksOmitted: (args.resolved.quotaRisksOmitted ?? 0) + Math.max(0, (args.resolved.quotaRiskSnapshot?.length ?? 0) - (boundedRisk?.length ?? 0)) }
            : {}),
        ...(boundedLosers?.length ? { intraNodeLosers: boundedLosers } : {}),
        ...((args.resolved.intraNodeLosersOmitted ?? 0) + Math.max(0, (args.resolved.intraNodeLosers?.length ?? 0) - (boundedLosers?.length ?? 0))
            ? { intraNodeLosersOmitted: (args.resolved.intraNodeLosersOmitted ?? 0) + Math.max(0, (args.resolved.intraNodeLosers?.length ?? 0) - (boundedLosers?.length ?? 0)) }
            : {}),
        ...(selectionTrajectory ? { selectionTrajectory } : {}),
        ...(args.resolved.reason ? { reason: args.resolved.reason } : {}),
    };
    return compactRoutingDecision(decision);
}
