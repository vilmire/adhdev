/**
 * RF-ROUTER MED family — mesh work-queue commands.
 *
 * get_mesh_queue (view with dependency annotation), cancel_mesh_queue_task,
 * requeue_mesh_queue_task and trigger_mesh_queue. The mutating commands gate on
 * the Mesh Host owner check (ctx.requireMeshHostMutationOwner). trigger preflights
 * a preferred-node claim before the round-robin trigger. Extracted verbatim from
 * executeDaemonCommand.
 */
import { readStringValue } from '../router.js';
import type { MedFamilyContext, MedFamilyHandler } from './types.js';

export const meshQueueHandlers: Record<string, MedFamilyHandler> = {
    get_mesh_queue: async (_ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        if (!meshId) return { success: false, error: 'meshId required' };
        try {
            const { getMeshQueueStats, getQueue, describeTaskDependencyState } = await import('../../mesh/mesh-work-queue.js');
            const status = Array.isArray(args?.status)
                ? args.status.map((s: any) => typeof s === 'string' ? s.trim() : '').filter(Boolean)
                : undefined;
            const rawQueue = getQueue(meshId, { status: status as any });
            // M1: annotate dependency state at view time (waitingOn / dependenciesSatisfied).
            const statusById = new Map(getQueue(meshId).map(task => [task.id, task.status]));
            const queue = rawQueue.map(task =>
                Array.isArray(task.dependsOn) && task.dependsOn.length > 0
                    ? { ...task, ...describeTaskDependencyState(task, statusById) }
                    : task);
            const summary = getMeshQueueStats(meshId);
            return {
                success: true,
                queue,
                summary,
                sourceOfTruth: {
                    kind: 'mesh_work_queue_file',
                    activeStatuses: ['pending', 'assigned'],
                    historicalStatuses: ['completed', 'failed', 'cancelled'],
                    notes: 'pending/assigned are active work; completed/failed/cancelled are historical records.',
                },
            };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    cancel_mesh_queue_task: async (ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        const taskId = typeof args?.taskId === 'string' ? args.taskId.trim() : '';
        if (!meshId || !taskId) return { success: false, error: 'meshId and taskId required' };
        const ownerFailure = await ctx.requireMeshHostMutationOwner(meshId, args?.inlineMesh, 'queue cancellation');
        if (ownerFailure) return ownerFailure;
        try {
            const { cancelTask } = await import('../../mesh/mesh-work-queue.js');
            const reason = typeof args?.reason === 'string' ? args.reason : undefined;
            const task = cancelTask(meshId, taskId, { reason });
            if (!task) return { success: false, error: `Queue task '${taskId}' not found` };
            return { success: true, task };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    requeue_mesh_queue_task: async (ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        const taskId = typeof args?.taskId === 'string' ? args.taskId.trim() : '';
        if (!meshId || !taskId) return { success: false, error: 'meshId and taskId required' };
        const ownerFailure = await ctx.requireMeshHostMutationOwner(meshId, args?.inlineMesh, 'queue requeue');
        if (ownerFailure) return ownerFailure;
        try {
            const { requeueTask } = await import('../../mesh/mesh-work-queue.js');
            const task = requeueTask(meshId, taskId, {
                reason: typeof args?.reason === 'string' ? args.reason : undefined,
                targetNodeId: typeof args?.targetNodeId === 'string' ? args.targetNodeId.trim() : undefined,
                targetSessionId: typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : undefined,
                clearTargetNode: args?.clearTargetNode === true,
                clearTargetSession: args?.clearTargetSession !== false,
            });
            if (!task) return { success: false, error: `Queue task '${taskId}' not found` };
            return { success: true, task };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    trigger_mesh_queue: async (ctx: MedFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        if (!meshId) return { success: false, error: 'meshId required' };
        const ownerFailure = await ctx.requireMeshHostMutationOwner(meshId, args?.inlineMesh, 'queue trigger');
        if (ownerFailure) return ownerFailure;
        try {
            const { triggerMeshQueue, tryAssignQueueTask } = await import('../../mesh/mesh-events.js');

            // Bug A fix: when preferredNodeId is provided, attempt to claim a pending
            // task for the preferred node's idle session first, before the general
            // round-robin trigger picks a different node.
            const preferredNodeId = typeof args?.preferredNodeId === 'string' ? args.preferredNodeId.trim() : '';
            if (preferredNodeId) {
                const cliInstances = ctx.deps.instanceManager.getByCategory('cli');
                // Sort: preferred node's sessions first, others after
                const sorted = [...cliInstances].sort((a, b) => {
                    const aSettings = a.getState().settings as Record<string, unknown> || {};
                    const bSettings = b.getState().settings as Record<string, unknown> || {};
                    const aNode = readStringValue(aSettings.meshNodeId, aSettings.nodeId);
                    const bNode = readStringValue(bSettings.meshNodeId, bSettings.nodeId);
                    return (aNode === preferredNodeId ? -1 : 0) - (bNode === preferredNodeId ? -1 : 0);
                });
                for (const inst of sorted) {
                    const state = inst.getState();
                    const settings = state.settings as Record<string, unknown> || {};
                    const nodeId = readStringValue(settings.meshNodeId, settings.nodeId);
                    if (!nodeId || nodeId !== preferredNodeId) continue;
                    const meshNodeFor = readStringValue(settings.meshNodeFor);
                    if (meshNodeFor !== meshId) continue;
                    const status = (readStringValue(state.status) || '').toLowerCase();
                    if (status !== 'idle') continue;
                    const sessionId = typeof state.instanceId === 'string' ? state.instanceId : '';
                    const providerType = readStringValue(state.type, settings.providerType) || '';
                    if (sessionId && providerType) {
                        tryAssignQueueTask(ctx.deps as any, meshId, nodeId, sessionId, providerType);
                        break;
                    }
                }
            }

            const trigger = await triggerMeshQueue(ctx.deps as any, meshId);
            return { success: true, trigger };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },
};
