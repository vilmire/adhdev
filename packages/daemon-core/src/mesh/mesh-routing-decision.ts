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
}

// Compact, durable routing rationale written into task_dispatched. Candidate arrays
// are bounded by the provider resolver before they reach this type.
export interface MeshTaskRoutingDecision {
    source: 'queue' | 'autoLaunch' | 'direct';
    fitnessScore?: number;
    selectedSlot?: { providerType: string; model?: string };
    skippedCandidates?: Array<{ nodeId: string; reason: string }>;
    requiredTagsResult?: { required: string[]; satisfied: boolean; missing: string[] };
    resolvedProviderType?: string;
    resolvedModel?: string;
    resolvedThinkingLevel?: string;
    resolvedDifficulty?: string;
    quotaRiskSnapshot?: ProviderQuotaRiskSnapshot[];
    quotaRisksOmitted?: number;
    intraNodeLosers?: MeshIntraNodeLoser[];
    intraNodeLosersOmitted?: number;
    reason?: string;
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
}): MeshTaskRoutingDecision {
    const bonus = quotaSpreadBonusByProvider(args.node, args.quotaRouting, Date.now(), args.quotaFactsContext);
    return {
        source: 'autoLaunch',
        fitnessScore: scoreSlotForTask(args.resolved.slot, args.task, bonus[args.resolved.slot.provider] ?? 0),
        selectedSlot: {
            providerType: args.resolved.providerType,
            ...(args.resolved.slot.model ? { model: args.resolved.slot.model } : {}),
        },
        ...(args.skippedCandidates.length ? { skippedCandidates: args.skippedCandidates } : {}),
        requiredTagsResult: args.requiredTagsResult,
        resolvedProviderType: args.resolved.providerType,
        ...(args.effectiveModel ? { resolvedModel: args.effectiveModel } : {}),
        ...(args.effectiveThinkingLevel ? { resolvedThinkingLevel: args.effectiveThinkingLevel } : {}),
        ...(args.task.difficulty ? { resolvedDifficulty: String(args.task.difficulty) } : {}),
        ...(args.resolved.quotaRiskSnapshot?.length ? { quotaRiskSnapshot: args.resolved.quotaRiskSnapshot } : {}),
        ...(args.resolved.quotaRisksOmitted ? { quotaRisksOmitted: args.resolved.quotaRisksOmitted } : {}),
        ...(args.resolved.intraNodeLosers?.length ? { intraNodeLosers: args.resolved.intraNodeLosers } : {}),
        ...(args.resolved.intraNodeLosersOmitted ? { intraNodeLosersOmitted: args.resolved.intraNodeLosersOmitted } : {}),
        ...(args.resolved.reason ? { reason: args.resolved.reason } : {}),
    };
}
