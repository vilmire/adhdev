/**
 * Host-only IPC: `light_continue_integration` — versioned light source → integration
 * successor that reuses the existing light workspace (Contract A).
 */
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { getMachineId } from '../../config/config.js';
import { resolveMeshHostStatus } from '../../mesh/mesh-host-ownership.js';
import { continueLightSourceToIntegration } from '../../mesh/light-source-continuation.js';
import { MeshRuntimeStore } from '../../mesh/mesh-runtime-store.js';
import type { LowFamilyHandler } from './types.js';

const fail = (code: string, error: string, extra: Record<string, unknown> = {}) => ({ success: false as const, code, error, ...extra });
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

const lightContinueIntegration: LowFamilyHandler = async (ctx, args) => {
    const meshId = text(args?.meshId);
    const sourceTaskId = text(args?.sourceTaskId ?? args?.taskId);
    // The older IPC requires a top-level ownerDecisionId. Keep the answer in
    // one object so forwarding to that runtime fails before it can apply.
    const ownerAnswer = args?.ownerAnswer;
    const ownerDecisionId = text(ownerAnswer?.decisionId);
    const ownerOptionId = text(ownerAnswer?.optionId);
    const ownerAnswerRevision = ownerAnswer?.revision;
    const expectedRevision = args?.expectedRevision;
    const dryRun = args?.dryRun === true;
    if (!meshId || !sourceTaskId || typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
        || (args?.dryRun !== undefined && typeof args.dryRun !== 'boolean')) {
        return fail('bad_request', 'meshId, sourceTaskId and expectedRevision are required');
    }
    if (!ownerAnswer || typeof ownerAnswer !== 'object' || Array.isArray(ownerAnswer)
        || Object.keys(ownerAnswer).some(key => !['decisionId', 'optionId', 'revision'].includes(key))
        || !ownerDecisionId || !ownerOptionId || typeof ownerAnswerRevision !== 'number'
        || !Number.isSafeInteger(ownerAnswerRevision) || ownerAnswerRevision < 1) {
        return fail('owner_decision_required', 'ownerAnswer with decisionId, optionId and revision is required');
    }
    try {
        const record = await ctx.getMeshForCommand?.(meshId, undefined, { preferInline: true });
        const self = ctx.deps.statusInstanceId;
        if (!record?.mesh) return fail('mesh_not_found', `mesh '${meshId}' not found`);
        const status = resolveMeshHostStatus(record.mesh, { localDaemonId: self });
        if (!self || status.role !== 'host' || !status.hostDaemonId || !daemonIdsEquivalent(status.hostDaemonId, self)) {
            return fail('authenticated_mesh_host_required', 'light continuation runs on the mesh host only');
        }
        const machineId = getMachineId();
        const mesh = record.mesh;
        if (!machineId || !mesh.repoIdentity) return fail('authenticated_repo_machine_required', 'repoIdentity and machineId required');
        const store = MeshRuntimeStore.getInstance();
        const task = store.findQueueEntryById(meshId, sourceTaskId);
        const node = mesh.nodes?.find((n: { id?: string }) => n.id === (task?.targetNodeId ?? task?.lightBaseNodeId));
        const localNode = node && daemonIdsEquivalent(node.daemonId, self) ? node : undefined;
        if (!localNode?.workspace || !localNode.id) {
            return fail('local_pinned_physical_context_required', 'source task must target a local registered node');
        }
        const result = await continueLightSourceToIntegration(
            { meshId, sourceTaskId, expectedRevision },
            {
                actor: self, repoIdentity: mesh.repoIdentity, machineId,
                nodeId: localNode.id, workspace: localNode.workspace,
                dryRun, ownerDecisionId, ownerOptionId, ownerAnswerRevision,
            },
        );
        return {
            success: true,
            dryRun,
            plan: result.plan,
            sourceTaskId: result.source.id,
            successorTaskId: result.successor.id,
            sourceRevision: result.source.revision ?? 0,
            successorPhase: result.successor.phase,
            lightWorkspaceId: result.plan.lightWorkspaceId,
        };
    } catch (e: any) {
        const code = e?.refusal?.code || (typeof e?.message === 'string' ? e.message.split(':')[0] : 'light_continue_failed');
        return fail(code, e?.message || String(e), e?.refusal ? { refusal: e.refusal } : {});
    }
};

export const lightContinuationIpcHandlers: Record<string, LowFamilyHandler> = {
    light_continue_integration: lightContinueIntegration,
};
