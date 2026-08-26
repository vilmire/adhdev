import type { NodeCapabilitySlot } from '@adhdev/mesh-shared';
import { meshNodeIdMatches } from '@adhdev/mesh-shared';
import type { RepoMeshQuotaRoutingPolicy } from '../repo-mesh-types.js';
import { resolveNodeCapabilitySlots } from './mesh-node-slots.js';
import {
    quotaSpreadBonusByProvider,
    type QuotaFactsContext,
} from './mesh-quota-routing.js';
import {
    selectProviderWithDiagnostics,
    type ProviderQuotaGateDiagnostic,
    type ProviderSelectionPreviewScore,
} from './mesh-routing-decision.js';
import {
    nodeHasActiveAssignment,
    orderEligibleNodes,
    orderSlotsForProviderSelection,
    resolveSchedulingStrategy,
    taskRequiresDifficultyFloor,
    type FitnessTask,
    type RankableNode,
} from './mesh-scheduling-fitness.js';
import {
    buildMeshNodeCapabilityTags,
    nodeSatisfiesRequiredTags,
} from './mesh-work-queue.js';

export interface MeshRoutePreviewQuery {
    difficulty: string;
    requiredTags: string[];
    readonly: boolean;
    targetNodeId?: string;
}

export interface NodeRoutePreview {
    nodeId: string;
    predictedWinner?: {
        providerType: string;
        model?: string;
        fitnessScore: number;
    };
    reason?: string;
    availabilityAssumption: string;
    stages: {
        difficultyFloor: {
            required: boolean;
            admittedSlots: Array<{ providerType: string; model?: string }>;
            excludedSlots: Array<{ providerType: string; model?: string; reason: string }>;
        };
        fitness: ProviderSelectionPreviewScore[];
        quota: {
            fitnessOrder: string[];
            clearOrder: string[];
            gated: Array<{ providerType: string; reason: string }>;
            /**
             * ★NOT the winner. This is the HEAD OF THE INPUT ORDER handed to
             * quota ranking — the fitness stage's first choice, which Stage 3
             * routinely and correctly displaces. `winner` is the winner.
             *
             * @deprecated Misleading name kept for existing readers; prefer the
             * identical `fitnessOrderHead`. Both are emitted with the same value.
             */
            fitnessWinner?: string;
            /** Unambiguous alias of `fitnessWinner`: `fitnessOrder[0]`, the
             *  input order's head. Never a selection result. */
            fitnessOrderHead?: string;
            /** Reads as prose what the field names above cannot. Always emitted
             *  so a reader of raw JSON cannot miss it. */
            note: string;
            winner?: string;
            reordered: boolean;
            displacedFitnessWinner?: string;
            /** Which window axis Stage 3 ranked on — see `sessionAxisActive`. */
            axis: 'weekly' | 'session';
            /** True when every weekly-readable candidate had weekly headroom to
             *  spare, so the SESSION (5h) expiry axis governed instead of the
             *  weekly one (mesh-quota-routing.ts, the 2′ conditional gate). */
            sessionAxisActive: boolean;
        };
    };
    quotaDiagnostics: ProviderQuotaGateDiagnostic[];
}

/**
 * ★Emitted verbatim on every quota stage. Two independent investigations
 * (553d4006 / 7267eead) read `fitnessWinner` + `selectionRank: 0` +
 * `gate.outcome: 'clear'` as "this provider won" and reached opposite
 * conclusions about a reordering that was working as designed. The names are
 * kept for compatibility; this sentence is what makes the JSON self-describing.
 */
const QUOTA_STAGE_NOTE =
    'fitnessOrder/fitnessWinner(=fitnessOrderHead) are the INPUT order to quota ranking, not a result. '
    + 'The selected provider is `winner`; per-candidate ranking numbers are in quotaDiagnostics[].ranking.';

function providerReportedDisabled(node: any, providerType: string): boolean {
    return node?.nodeFacts?.providerEnablement?.[providerType]?.enabled === false;
}

function slotIdentity(candidate: { providerType: string; slot: NodeCapabilitySlot }): { providerType: string; model?: string } {
    return {
        providerType: candidate.providerType,
        ...(candidate.slot.model ? { model: candidate.slot.model } : {}),
    };
}

/**
 * Preview one node's canonical provider-selection pipeline. The only
 * production-only step not repeated here is live CLI detection: the preview is
 * deliberately fetch-free, so configured slots are admitted unless the node's
 * already-reported facts explicitly say that provider is disabled. The shared
 * selectProviderWithDiagnostics helper owns every ranking decision after that
 * admission seam and is also called by the real router.
 */
export function buildNodeRoutePreview(args: {
    meshId: string;
    nodeId: string;
    node: any;
    meshNodes?: readonly unknown[];
    task: FitnessTask;
    quotaRouting?: RepoMeshQuotaRoutingPolicy | null;
    quotaFactsContext?: QuotaFactsContext | null;
    readonly?: boolean;
    now?: number;
}): NodeRoutePreview {
    const now = args.now ?? Date.now();
    const quotaFactsContext: QuotaFactsContext = {
        ...(args.quotaFactsContext ?? {}),
        suppressObservabilityLogs: true,
    };
    const slots = resolveNodeCapabilitySlots(args.node, args.meshId);
    const quotaBonusByProvider = quotaSpreadBonusByProvider(
        args.node, args.quotaRouting, now, quotaFactsContext,
    );
    const orderedSlots = orderSlotsForProviderSelection(
        slots,
        args.meshId,
        args.nodeId,
        args.node,
        args.task,
        quotaBonusByProvider,
        args.meshNodes,
    );
    const difficultyFloorRequired = taskRequiresDifficultyFloor(args.node, args.task);
    const requiredTags = args.task.requiredTags?.filter(Boolean) ?? [];
    const usableSlots = orderedSlots
        .filter(slot => !providerReportedDisabled(args.node, slot.provider))
        .filter(slot => !requiredTags.length || nodeSatisfiesRequiredTags(
            requiredTags,
            buildMeshNodeCapabilityTags(args.node, slot.provider),
        ))
        .map(slot => ({ slot, providerType: slot.provider }));

    if (!usableSlots.length) {
        return {
            nodeId: args.nodeId,
            reason: difficultyFloorRequired
                ? `task_difficulty_floor_unavailable:${args.task.difficulty}`
                : 'provider_priority_unusable',
            availabilityAssumption: 'Configured slots only; no CLI detection or network/quota fetch was performed.',
            stages: {
                difficultyFloor: { required: difficultyFloorRequired, admittedSlots: [], excludedSlots: [] },
                fitness: [],
                quota: {
                    fitnessOrder: [], clearOrder: [], gated: [], reordered: false,
                    note: QUOTA_STAGE_NOTE, axis: 'weekly', sessionAxisActive: false,
                },
            },
            quotaDiagnostics: [],
        };
    }

    const selection = selectProviderWithDiagnostics({
        node: args.node,
        nodeId: args.nodeId,
        meshId: args.meshId,
        task: args.task,
        quotaRouting: args.quotaRouting,
        quotaFactsContext,
        quotaBonusByProvider,
        difficultyFloorRequired,
        usableSlots,
        unbounded: true,
        now,
        meshNodes: args.meshNodes,
        forReadonlyTask: args.readonly === true,
    });
    const scores = selection.diagnostics.previewScores ?? [];
    const admitted = new Set(selection.candidateSlots);
    const excludedSlots = usableSlots
        .filter(candidate => !admitted.has(candidate))
        .map(candidate => {
            const score = scores[usableSlots.indexOf(candidate)];
            const reason = score && !score.capacityAvailable
                ? 'slot_capacity_exhausted'
                : score?.difficultyEligible
                    ? 'higher_difficulty_tier_deferred'
                    : 'difficulty_floor_unavailable';
            return { ...slotIdentity(candidate), reason };
        });
    const fitnessOrder = selection.candidates.map(candidate => candidate.providerType);
    const fitnessOrderHead = fitnessOrder[0];
    const winner = selection.winner?.providerType;
    const winnerIndex = selection.winner ? usableSlots.indexOf(selection.winner) : -1;
    const winnerScore = winnerIndex >= 0 ? scores[winnerIndex] : undefined;
    const reason = selection.reason
        ?? (!winner
            ? `all_providers_quota_gated:${selection.ranked.gated.map(entry => `${entry.providerType}:${entry.block.reason}`).join(';')}`
            : undefined);

    return {
        nodeId: args.nodeId,
        ...(selection.winner && winnerScore ? {
            predictedWinner: {
                providerType: selection.winner.providerType,
                ...(selection.winner.slot.model ? { model: selection.winner.slot.model } : {}),
                fitnessScore: winnerScore.total,
            },
        } : {}),
        ...(reason ? { reason } : {}),
        availabilityAssumption: 'Configured slots are treated as usable unless existing node facts explicitly mark a provider disabled. No CLI detection, network call, write, or quota fetch was performed.',
        stages: {
            difficultyFloor: {
                required: difficultyFloorRequired,
                admittedSlots: selection.candidateSlots.map(slotIdentity),
                excludedSlots,
            },
            fitness: scores,
            quota: {
                fitnessOrder,
                clearOrder: selection.ranked.clear,
                gated: selection.ranked.gated.map(entry => ({
                    providerType: entry.providerType,
                    reason: entry.block.reason,
                })),
                ...(fitnessOrderHead ? { fitnessWinner: fitnessOrderHead, fitnessOrderHead } : {}),
                note: QUOTA_STAGE_NOTE,
                ...(winner ? { winner } : {}),
                reordered: !!winner && !!fitnessOrderHead && winner !== fitnessOrderHead,
                ...(winner && fitnessOrderHead && winner !== fitnessOrderHead
                    ? { displacedFitnessWinner: fitnessOrderHead }
                    : {}),
                axis: selection.ranked.sessionAxisActive ? 'session' : 'weekly',
                sessionAxisActive: selection.ranked.sessionAxisActive === true,
            },
        },
        quotaDiagnostics: selection.diagnostics.quotaDiagnostics ?? [],
    };
}

/** Build the mesh-wide read-only route snapshot used by mesh_route_preview. */
export function buildMeshRoutePreview(args: {
    mesh: any;
    difficulty: string;
    requiredTags?: string[];
    readonly?: boolean;
    targetNodeId?: string;
    now?: number;
}): Record<string, unknown> {
    const now = args.now ?? Date.now();
    const meshId = typeof args.mesh?.id === 'string' ? args.mesh.id : '';
    const meshNodes = Array.isArray(args.mesh?.nodes) ? args.mesh.nodes : [];
    const requiredTags = (args.requiredTags ?? []).filter(tag => typeof tag === 'string' && tag.trim()).map(tag => tag.trim());
    const targetNodeId = typeof args.targetNodeId === 'string' && args.targetNodeId.trim()
        ? args.targetNodeId.trim()
        : undefined;
    const task: FitnessTask = { difficulty: args.difficulty, requiredTags };
    const quotaFactsContext: QuotaFactsContext = { nodes: meshNodes, suppressObservabilityLogs: true };
    const candidateNodes = meshNodes.filter((node: any) => {
        if (targetNodeId && !meshNodeIdMatches(node, targetNodeId)) return false;
        if (!requiredTags.length) return true;
        const providers = resolveNodeCapabilitySlots(node, meshId).map(slot => slot.provider).filter(Boolean);
        return providers.some(provider => nodeSatisfiesRequiredTags(
            requiredTags,
            buildMeshNodeCapabilityTags(node, provider),
        ));
    });
    const strategy = resolveSchedulingStrategy(args.mesh);
    const orderedNodes: any[] = strategy === 'first_eligible'
        ? candidateNodes
        : orderEligibleNodes(
            meshId,
            strategy,
            candidateNodes.map((node: any, index: number) => ({
                nodeId: String(node?.id ?? node?.nodeId ?? node?.node_id ?? ''),
                node,
                index,
            })).filter((entry: RankableNode) => !!entry.nodeId),
            {
                task,
                quotaRouting: args.mesh?.policy?.quotaRouting ?? null,
                quotaFactsContext,
            },
        ).map(entry => entry.node);
    const nodePreviews: NodeRoutePreview[] = orderedNodes.map((node: any) => buildNodeRoutePreview({
        meshId,
        nodeId: String(node?.id ?? node?.nodeId ?? node?.node_id ?? ''),
        node,
        meshNodes,
        task,
        quotaRouting: args.mesh?.policy?.quotaRouting ?? null,
        quotaFactsContext,
        readonly: args.readonly === true,
        now,
    }));
    const predicted = nodePreviews.find((nodePreview, index) => {
        if (!nodePreview.predictedWinner) return false;
        const node = orderedNodes[index];
        if (args.readonly !== true && nodeHasActiveAssignment(meshId, nodePreview.nodeId)) return false;
        const winnerScore = nodePreview.stages.fitness.find(score =>
            score.providerType === nodePreview.predictedWinner!.providerType
            && score.model === nodePreview.predictedWinner!.model);
        return winnerScore?.capacity.available !== false;
    });
    const targetMatched = !targetNodeId || meshNodes.some((node: any) => meshNodeIdMatches(node, targetNodeId));

    return {
        success: true,
        tool: 'mesh_route_preview',
        snapshot: {
            observedAt: new Date(now).toISOString(),
            pointInTime: true,
            warning: 'Point-in-time routing snapshot: slot capacity reads the live queue and may become stale immediately when a slot is claimed or released.',
            writesPerformed: false,
            quotaFetchPerformed: false,
        },
        query: {
            difficulty: args.difficulty,
            requiredTags,
            readonly: args.readonly === true,
            ...(targetNodeId ? { targetNodeId } : {}),
        } satisfies MeshRoutePreviewQuery,
        schedulingStrategy: strategy,
        targetMatched,
        nodeOrder: nodePreviews.map(preview => preview.nodeId),
        ...(predicted?.predictedWinner ? {
            predictedWinner: {
                nodeId: predicted.nodeId,
                ...predicted.predictedWinner,
            },
        } : {}),
        nodes: nodePreviews,
        limitations: [
            'Preview is fetch-free: configured slots are assumed usable unless cached node facts explicitly mark a provider disabled; live CLI detection can still reject a configured provider at dispatch time.',
            'Dynamic launch gates outside provider selection (node health, dirty/stale workspace, cooldown, and live-session count) are not probed by this tool.',
        ],
    };
}
