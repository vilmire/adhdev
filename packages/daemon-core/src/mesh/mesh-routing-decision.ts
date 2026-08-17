import type { NodeCapabilitySlot } from '@adhdev/mesh-shared';
import type { RepoMeshQuotaRoutingPolicy } from '../repo-mesh-types.js';
import { quotaSpreadBonusByProvider, type ProviderQuotaRiskSnapshot, type QuotaFactsContext } from './mesh-quota-routing.js';
import { scoreSlotForTask, type FitnessTask } from './mesh-scheduling-fitness.js';

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
    const sameDeclaredProvider = winningSlot.provider === executedSlot.provider;
    const executedProvider = sameDeclaredProvider ? winningProvider : executedSlot.provider;
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
