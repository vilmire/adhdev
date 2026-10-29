import { comparePhysicalOwnership, currentPhysicalScope } from './mesh-physical-ownership.js';
import { findOwnershipConflicts, meshNodeIdMatches } from '@adhdev/mesh-shared';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';
import { pendingLaunchReservation } from './mesh-task-routing-contract.js';

/** Codes are the existing claim/auto-launch refusal codes, including their diagnostic suffixes. */
export interface MeshQueueHold {
    reason: string;
    since: string;
    blockingTaskIds: string[];
    detail: {
        message?: string;
        overlappingPaths?: Array<{ taskId: string; ownedPath: string; blockingPath: string }>;
    };
}

export interface MeshQueueHoldView extends MeshQueueHold {
    ageMs: number;
    blockingTasks: Array<{ taskId: string; title: string }>;
}

export const QUEUE_HOLD_NOTICE_AFTER_MS = 3 * 60_000;

/** Explicit marker when an admission/hold reason is known but no blocking task/attempt/node identity is evidenced. */
export const UNKNOWN_BLOCKER_NO_EVIDENCE = 'unknown_blocker_no_evidence';

export function queueTaskShortTitle(task: Pick<MeshWorkQueueEntry, 'message'>): string {
    return (task.message || '').trim().split('\n')[0].slice(0, 100);
}

/**
 * Active writers for hold projection: the caller supplies the ownership/capacity set
 * (typically assignedRowsMeshWide payloads + pending launch reservations). Do NOT
 * re-filter to status==='assigned' — stopping writers remain exclusive after a
 * terminal queue status and must still name the blocker.
 */
export function holdActiveWriters(
    task: Pick<MeshWorkQueueEntry, 'id'>,
    queue: readonly MeshWorkQueueEntry[],
): MeshWorkQueueEntry[] {
    return queue.filter(other =>
        other.id !== task.id
        && (other.status !== 'pending' || pendingLaunchReservation(other)));
}

/**
 * Project owned_paths_conflict hold identity from the same conflict list admission uses.
 * Empty conflicts → explicit unknown/no-evidence marker (never fabricate a blocker id).
 */
export function ownedPathsHoldFromConflicts(
    conflicts: ReadonlyArray<{ taskId: string; overlappingPaths: readonly string[] }>,
): Pick<MeshQueueHold, 'blockingTaskIds' | 'detail'> {
    if (!conflicts.length) {
        return { blockingTaskIds: [], detail: { message: UNKNOWN_BLOCKER_NO_EVIDENCE } };
    }
    const blockingTaskIds = [...new Set(conflicts.map(c => c.taskId))].sort();
    const overlappingPaths = conflicts.flatMap(c =>
        c.overlappingPaths.map(path => ({
            taskId: c.taskId,
            ownedPath: path,
            blockingPath: path,
        })),
    );
    return { blockingTaskIds, detail: { overlappingPaths } };
}

export function queueHoldContext(task: MeshWorkQueueEntry, reason: string, queue: readonly MeshWorkQueueEntry[], nodeId?: string): Pick<MeshQueueHold, 'blockingTaskIds' | 'detail'> {
    const active = holdActiveWriters(task, queue);
    const overlaps: NonNullable<MeshQueueHold['detail']['overlappingPaths']> = [];
    if (reason === 'owned_paths_conflict' && task.ownedPaths) {
        for (const other of active) {
            const isReadonly = other.readonly || other.taskMode === 'live_debug_readonly';
            const blockingScope = isReadonly ? other.reviewInputScope : other.ownershipScope;
            const blockingPaths = isReadonly && blockingScope ? { paths: blockingScope.declaration } : other.ownedPaths;
            if (!blockingPaths || (isReadonly && !blockingScope)) continue;
            const physical = comparePhysicalOwnership(task.ownedPaths, currentPhysicalScope(task.ownershipScope, task.ownedPaths), blockingPaths, currentPhysicalScope(blockingScope, blockingPaths));
            if (!physical.physicalConflict) continue;
            if (!physical.logicalOverlap) overlaps.push({ taskId: other.id, ownedPath: 'physical_workspace_or_shared_resource', blockingPath: 'physical_workspace_or_shared_resource' });
            for (const owned of task.ownedPaths.paths) for (const blocking of blockingPaths.paths) {
                if (findOwnershipConflicts({ paths: [owned] }, [{ taskId: other.id, paths: { paths: [blocking] } }]).length) {
                    overlaps.push({ taskId: other.id, ownedPath: owned.path + (owned.subtree ? '/**' : ''), blockingPath: blocking.path + (blocking.subtree ? '/**' : '') });
                }
            }
        }
    }
    if (reason === 'owned_paths_conflict') {
        const blockingTaskIds = [...new Set(overlaps.map(pair => pair.taskId))].sort();
        if (!blockingTaskIds.length) {
            return { blockingTaskIds: [], detail: { message: UNKNOWN_BLOCKER_NO_EVIDENCE } };
        }
        return { blockingTaskIds, detail: { overlappingPaths: overlaps } };
    }
    const blockingTaskIds = reason === 'dependencies_unsatisfied'
        ? (task.dependsOn || []).filter(id => !queue.some(other => other.id === id && other.status === 'completed'))
        : reason === 'node_busy_with_active_assignment' || reason === 'node_has_active_assignment'
            ? active.filter(other => !other.readonly && other.taskMode !== 'live_debug_readonly' && nodeId && meshNodeIdMatches({ id: other.assignedNodeId }, nodeId)).map(other => other.id)
            : [];
    return { blockingTaskIds, detail: overlaps.length ? { overlappingPaths: overlaps } : {} };
}

/** Mutate only the diagnostic payload; never bump updatedAt (pin/reclaim clocks use it). */
export function setQueueTaskHold(task: MeshWorkQueueEntry, reason: string, context: Pick<MeshQueueHold, 'blockingTaskIds' | 'detail'>, now = Date.now()): void {
    if (task.status !== 'pending') return;
    const blockers = [...new Set(context.blockingTaskIds)].sort();
    const same = task.hold?.reason === reason && JSON.stringify(task.hold.blockingTaskIds) === JSON.stringify(blockers);
    task.hold = { reason, since: same ? task.hold!.since : new Date(now).toISOString(), blockingTaskIds: blockers, detail: context.detail };
    if (!same) delete task.holdNoticeId;
}

export function queueTaskHoldView(task: Pick<MeshWorkQueueEntry, 'status' | 'hold'>, queue: readonly Pick<MeshWorkQueueEntry, 'id' | 'message'>[], now = Date.now()): MeshQueueHoldView | undefined {
    if (task.status !== 'pending' || !task.hold) return undefined;
    return {
        ...task.hold,
        ageMs: Math.max(0, now - Date.parse(task.hold.since)) || 0,
        blockingTasks: task.hold.blockingTaskIds.map(taskId => ({ taskId, title: queueTaskShortTitle(queue.find(other => other.id === taskId) || { message: taskId }) })),
    };
}
