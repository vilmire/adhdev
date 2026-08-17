import { getQueue, recordTaskAutoLaunch, type MeshWorkQueueEntry } from './mesh-work-queue.js';
import { queuePendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import { isModelAllowedBySlot } from './slot-model-enforcement.js';
import { ALL_PROVIDERS_QUOTA_GATED_SKIP_REASON } from './mesh-quota-routing.js';
import { isMeshTaskDifficulty, normalizeNodeCapabilitySlots, type MeshTaskDifficulty, type NodeCapabilitySlot } from '@adhdev/mesh-shared';

export const DIFFICULTY_FLOOR_REPORT_AFTER_MS = 10 * 60_000;
const TASK_DIFFICULTY_FLOOR_REASON_PREFIX = 'task_difficulty_floor_';
const TASK_DIFFICULTY_FLOOR_REPORTED_PREFIX = 'task_difficulty_floor_reported:';
const difficultyFloorTimeoutReported = new Set<string>();
const DIFFICULTY_FLOOR_REPORT_DEDUP_MAX = 2_000;
const CLASSIFIED_DIFFICULTIES: MeshTaskDifficulty[] = ['easy', 'medium', 'difficult'];

function classifiedDifficultiesForSlot(slot: NodeCapabilitySlot): MeshTaskDifficulty[] {
    const highest = slot.difficulty?.reduce((rank, value) => {
        const candidate = CLASSIFIED_DIFFICULTIES.indexOf(value);
        return Math.max(rank, candidate);
    }, -1) ?? -1;
    return highest < 0 ? [] : CLASSIFIED_DIFFICULTIES.slice(0, highest + 1);
}

/**
 * Classified task grades that an already-running session can safely claim.
 * A known model uses the union of its matching slots. When the model is not
 * observable, use the intersection of every possible provider slot so a mixed
 * opus/sonnet provider can never silently claim difficult work as sonnet.
 * Undefined means the node has no explicit slots and keeps legacy behavior.
 */
export function allowedClassifiedDifficultiesForSession(
    node: any,
    slots: NodeCapabilitySlot[],
    providerType: string,
    model?: string,
): MeshTaskDifficulty[] | undefined {
    if (normalizeNodeCapabilitySlots(node?.policy?.slots).length === 0) return undefined;
    const providerSlots = slots.filter(slot => slot.provider?.trim() === providerType);
    const possibleSlots = model
        ? providerSlots.filter(slot => isModelAllowedBySlot(model, slot))
        : providerSlots;
    if (possibleSlots.length === 0) return [];
    const supported = possibleSlots.map(slot => new Set(classifiedDifficultiesForSlot(slot)));
    return CLASSIFIED_DIFFICULTIES.filter(difficulty => model
        ? supported.some(grades => grades.has(difficulty))
        : supported.every(grades => grades.has(difficulty)));
}

export function taskMeetsSessionDifficultyFloor(
    task: Pick<MeshWorkQueueEntry, 'difficulty'>,
    allowed: readonly MeshTaskDifficulty[] | undefined,
): boolean {
    if (!allowed || !isMeshTaskDifficulty(task.difficulty) || task.difficulty === 'freeform') return true;
    return allowed.includes(task.difficulty);
}

export function readSessionModel(state: any): string | undefined {
    const controlModel = typeof state?.controlValues?.model === 'string' ? state.controlValues.model.trim() : '';
    if (controlModel) return controlModel;
    const modelItem = Array.isArray(state?.summaryMetadata?.items)
        ? state.summaryMetadata.items.find((item: any) => item?.id === 'model')
        : undefined;
    const summaryModel = typeof modelItem?.shortValue === 'string' && modelItem.shortValue.trim()
        ? modelItem.shortValue.trim()
        : typeof modelItem?.value === 'string' ? modelItem.value.trim() : '';
    return summaryModel || undefined;
}

export function isDifficultyFloorWaitReason(reason?: string): boolean {
    return typeof reason === 'string' && (reason.startsWith(TASK_DIFFICULTY_FLOOR_REASON_PREFIX)
        || reason.startsWith(ALL_PROVIDERS_QUOTA_GATED_SKIP_REASON));
}

export function resetDifficultyFloorReportsForTests(): void {
    difficultyFloorTimeoutReported.clear();
}

/** Persist the first floor-wait timestamp and page once after the bounded wait. */
export function handleDifficultyFloorSkip(args: {
    meshId: string;
    taskId: string;
    reason: string;
    nodeId?: string;
    coordinatorDaemonId?: string;
}): void {
    let previousTask: MeshWorkQueueEntry | undefined;
    try { previousTask = getQueue(args.meshId).find(task => task.id === args.taskId); } catch { /* best-effort */ }
    if (previousTask?.autoLaunch?.reason?.startsWith(TASK_DIFFICULTY_FLOOR_REPORTED_PREFIX)) return;
    const continuing = previousTask?.autoLaunch?.status === 'skipped'
        && isDifficultyFloorWaitReason(previousTask.autoLaunch.reason);
    if (!continuing) {
        recordTaskAutoLaunch(args.meshId, args.taskId, {
            status: 'skipped',
            reason: args.reason,
            nodeId: args.nodeId,
        });
    }
    const waitStartedAt = Date.parse(previousTask?.autoLaunch?.updatedAt || new Date().toISOString());
    const waitedMs = Number.isFinite(waitStartedAt) ? Date.now() - waitStartedAt : 0;
    const reportKey = `${args.meshId}:${args.taskId}`;
    if (waitedMs < DIFFICULTY_FLOOR_REPORT_AFTER_MS || difficultyFloorTimeoutReported.has(reportKey)) return;

    const task = previousTask ?? getQueue(args.meshId).find(candidate => candidate.id === args.taskId);
    const difficulty = task?.difficulty || args.reason.split(':')[1] || 'classified';
    const coordinatorMessage = `[System] Queued task ${args.taskId} has waited ${Math.round(waitedMs / 60_000)} minutes because no available slot meets its ${difficulty} difficulty floor. It remains pending and was not downgraded. Ask the user whether to grant an explicit task-scoped downgrade; do not change a mesh-wide policy.`;
    const queued = queuePendingMeshCoordinatorEvent({
        event: 'mesh:dispatch_blocked',
        meshId: args.meshId,
        nodeLabel: args.nodeId || args.meshId,
        ...(args.nodeId ? { nodeId: args.nodeId } : {}),
        metadataEvent: {
            source: 'mesh_queue_difficulty_floor_timeout',
            taskId: args.taskId,
            reason: 'task_difficulty_floor_timeout',
            difficulty,
            waitedMs,
            coordinatorMessage,
        },
        coordinatorMessage,
        queuedAt: Date.now(),
        ...(args.coordinatorDaemonId ? { targetCoordinatorDaemonId: args.coordinatorDaemonId } : {}),
        ...(task?.sourceCoordinatorSessionId ? { targetCoordinatorSessionId: task.sourceCoordinatorSessionId } : {}),
    });
    if (queued) {
        if (difficultyFloorTimeoutReported.size >= DIFFICULTY_FLOOR_REPORT_DEDUP_MAX) {
            const oldest = difficultyFloorTimeoutReported.values().next().value;
            if (oldest) difficultyFloorTimeoutReported.delete(oldest);
        }
        difficultyFloorTimeoutReported.add(reportKey);
        // Durable debounce: survives daemon restart and a drained coordinator inbox.
        recordTaskAutoLaunch(args.meshId, args.taskId, {
            status: 'skipped', reason: `${TASK_DIFFICULTY_FLOOR_REPORTED_PREFIX}${difficulty}`, nodeId: args.nodeId,
        });
    }
}
