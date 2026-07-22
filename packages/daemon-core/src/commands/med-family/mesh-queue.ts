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
import { LOG } from '../../logging/logger.js';
import type { CancelledTaskAssignment } from '../../mesh/mesh-work-queue.js';

/**
 * CANCEL-STICKY-TERMINAL (authoritative cancel): stop the worker a just-cancelled task was
 * bound to. Mirrors the transport-aware stop mesh-event-forwarding's stopStaleMeshWorker
 * performs for reclaimed workers, but runs from the command layer using ctx.deps (which the
 * pure queue-store module lacks): local adapter → stop_cli directly; otherwise resolve the
 * worker node's daemon id from mesh config and dispatch stop_cli over P2P/relay. Fully
 * best-effort — a failed stop only loses the belt-and-suspenders; the cancelled row is already
 * terminal and cannot be resurrected (updateTaskStatus terminal guard).
 */
async function stopCancelledTaskWorker(
    ctx: MedFamilyContext,
    meshId: string,
    prior: CancelledTaskAssignment,
): Promise<void> {
    const { sessionId, nodeId, providerType } = prior;
    const stopArgs: Record<string, unknown> = {
        targetSessionId: sessionId,
        ...(providerType ? { cliType: providerType } : {}),
        mode: 'hard',
        reason: 'mesh_task_cancelled',
    };
    try {
        const cliManager = ctx.deps.cliManager as any;
        const isLocal = cliManager?.adapters?.has?.(sessionId) === true;
        if (isLocal) {
            if (!stopArgs.cliType) {
                const localType = cliManager?.adapters?.get?.(sessionId)?.cliType;
                if (localType) stopArgs.cliType = localType;
            }
            await Promise.resolve(cliManager?.handleCliCommand?.('stop_cli', stopArgs))
                .catch((e: any) => LOG.warn('MeshQueue', `Local stop of cancelled worker ${sessionId} failed: ${e?.message || e}`));
            return;
        }
        // Remote: resolve the worker node's daemon id from mesh config, then dispatch stop_cli.
        const dispatch = ctx.deps.dispatchMeshCommand;
        let daemonId: string | undefined;
        if (nodeId) {
            try {
                const [{ getMesh }, { meshNodeIdMatches }, { readMeshNodeDaemonId }] = await Promise.all([
                    import('../../config/mesh-config.js'),
                    import('@adhdev/mesh-shared'),
                    import('../../mesh/mesh-node-identity.js'),
                ]);
                const mesh = getMesh(meshId) as { nodes?: any[] } | undefined;
                const node = mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
                daemonId = node ? readMeshNodeDaemonId(node) || undefined : undefined;
            } catch { /* best-effort resolution */ }
        }
        if (daemonId && dispatch) {
            await Promise.resolve(dispatch(daemonId, 'stop_cli', stopArgs))
                .catch((e: any) => LOG.warn('MeshQueue', `Remote stop of cancelled worker ${sessionId} on daemon ${daemonId} failed: ${e?.message || e}`));
        } else {
            LOG.warn('MeshQueue', `Cannot stop cancelled worker ${sessionId}: no local adapter and no resolvable remote daemon id (node ${nodeId ?? '?'}). Row is already terminal; if the worker completes it strand-fails harmlessly.`);
        }
    } catch (e: any) {
        LOG.warn('MeshQueue', `stopCancelledTaskWorker error for ${sessionId}: ${e?.message || e}`);
    }
}

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
            const { cancelTask, takeCancelledTaskAssignment } = await import('../../mesh/mesh-work-queue.js');
            const reason = typeof args?.reason === 'string' ? args.reason : undefined;
            const task = cancelTask(meshId, taskId, { reason });
            if (!task) return { success: false, error: `Queue task '${taskId}' not found` };
            // CANCEL-STICKY-TERMINAL (authoritative cancel): stop the worker that was bound to the
            // now-cancelled task. cancelTask already cleared the queue's assignment fields (so the
            // reclaim watchdog no longer sees it as a live assignment), but a still-running worker
            // keeps emitting delivery/turn signals that re-ignite reclaim. cancelTask runs in the
            // pure queue-store module (no DaemonComponents), so the transport-aware stop is done
            // here where ctx.deps holds cliManager / dispatchMeshCommand. Best-effort: a failed
            // stop only loses the belt-and-suspenders — the row is already terminal and un-revivable
            // thanks to the updateTaskStatus terminal guard.
            const prior = takeCancelledTaskAssignment(meshId, taskId);
            if (prior?.sessionId) {
                void stopCancelledTaskWorker(ctx, meshId, prior);
            }
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
            const { requeueTask, getQueue } = await import('../../mesh/mesh-work-queue.js');
            // CANON-IDENTITY single-flight hardening (restart-safe): the in-memory in-flight
            // mark requeueTask consults is process-local and is lost across a daemon restart.
            // Independently of that mark, if the row is still 'assigned' to a session this
            // daemon hosts that is actively generating, requeueing would flip it back to
            // pending and let a SECOND session claim the SAME task (the duplicate dispatch).
            // Refuse unless force. A genuinely dead/stale session is not generating, so this
            // observation passes and a legitimate requeue proceeds. force=true (operator
            // override) bypasses BOTH this and the in-memory guard.
            // MAGI-NOTE: a future consensus group fan-out (separate mission) will exempt
            // group-tagged tasks from this guard; the exemption hook belongs here.
            if (args?.force !== true) {
                const { isSessionActivelyGenerating } = await import('../../mesh/mesh-events.js');
                const existing = getQueue(meshId).find((t: any) => t?.id === taskId) as { status?: string; assignedSessionId?: string } | undefined;
                if (existing?.status === 'assigned' && existing.assignedSessionId
                    && isSessionActivelyGenerating(ctx.deps as any, existing.assignedSessionId)) {
                    return {
                        success: false,
                        error: `Task '${taskId}' is actively dispatched/generating (live session ${existing.assignedSessionId}); requeue refused to avoid a duplicate second dispatch. Pass force:true to override, or cancel and re-enqueue.`,
                        task: existing,
                    };
                }
            }
            const task = requeueTask(meshId, taskId, {
                reason: typeof args?.reason === 'string' ? args.reason : undefined,
                targetNodeId: typeof args?.targetNodeId === 'string' ? args.targetNodeId.trim() : undefined,
                targetSessionId: typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : undefined,
                clearTargetNode: args?.clearTargetNode === true,
                clearTargetSession: args?.clearTargetSession !== false,
                // CANON-IDENTITY: an in-flight (actively-generating) task is refused by
                // default to avoid a duplicate second dispatch; an explicit operator
                // force overrides that guard (and the retry cap).
                force: args?.force === true,
            });
            if (!task) return { success: false, error: `Queue task '${taskId}' not found` };
            // The single-flight guard returns the row UNCHANGED (still 'assigned') when it
            // refuses an in-flight requeue — surface that as a clear, non-success signal so
            // the coordinator does not believe a second dispatch was opened.
            if (task.status === 'assigned' && args?.force !== true) {
                return {
                    success: false,
                    error: `Task '${taskId}' is actively dispatched/generating; requeue refused to avoid a duplicate second dispatch. Pass force:true to override, or cancel and re-enqueue.`,
                    task,
                };
            }
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
