import { getQueue, recordTaskAutoLaunch, type MeshWorkQueueEntry } from './mesh-work-queue.js';
import { queuePendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import { isModelAllowedBySlot, SLOT_MODEL_BUSY_SKIP_REASON } from './slot-model-enforcement.js';
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
        || reason.startsWith(ALL_PROVIDERS_QUOTA_GATED_SKIP_REASON)
        || BOUNDED_WAIT_SKIP_REASONS.some(prefix => reason.startsWith(prefix)));
}

// LEDGER-AUTOLAUNCH-RETRY-SPAM (④ claim-stall notification): back-pressure skips that
// genuinely DO self-resolve — so they must never join ACTIONABLE_SKIP_REASON_PREFIXES,
// which pages the coordinator on the FIRST occurrence (a slot that is busy for one tick
// is not a blocker). But "self-resolving" is a statement about the mechanism, not a
// guarantee about the clock: when one of these persists past the bounded wait below,
// nobody is coming, and until now nothing told the coordinator.
//
// Measured live 2026-09-02: task 208f0a38 sat unclaimable with node_0b39db59 reporting
// `slot_for_model_busy` and node_695e6d07 reporting a difficulty-floor miss. Only the
// latter node's reason had a timeout pager; had the fleet been Mac-only, the task would
// have waited silently and indefinitely. The owner noticed before the coordinator did.
//
// Routing these through handleDifficultyFloorSkip reuses its whole safety envelope: the
// durable `updatedAt` wait clock (not an in-memory timer, so it survives restarts and
// does not reset per tick), the in-memory + durable double debounce, and the single
// `mesh:dispatch_blocked` page. Crucially it does NOT touch the retry loop — the task
// stays queued and is still claimed the instant a slot frees.
const BOUNDED_WAIT_SKIP_REASONS = [
    SLOT_MODEL_BUSY_SKIP_REASON,
    'max_concurrent_sessions_reached',
    'max_provider_parallel_reached',
];

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
    const waitedMinutes = Math.round(waitedMs / 60_000);
    // The capacity reasons and the difficulty-floor reasons need different advice: a busy
    // slot resolves by waiting or by moving the task, whereas a floor miss will never
    // resolve on its own and needs an explicit task-scoped downgrade decision.
    const capacityStall = BOUNDED_WAIT_SKIP_REASONS.some(prefix => args.reason.startsWith(prefix));
    const coordinatorMessage = capacityStall
        ? `[System] Queued task ${args.taskId} has waited ${waitedMinutes} minutes because every capable slot has stayed at capacity (${args.reason}). It remains pending and will still be claimed automatically the moment a slot frees. Check whether the occupying sessions are genuinely working or stuck; consider re-targeting the task to another node rather than widening a mesh-wide cap.`
        : `[System] Queued task ${args.taskId} has waited ${waitedMinutes} minutes because no available slot meets its ${difficulty} difficulty floor. It remains pending and was not downgraded. Ask the user whether to grant an explicit task-scoped downgrade; do not change a mesh-wide policy.`;
    const queued = queuePendingMeshCoordinatorEvent({
        event: 'mesh:dispatch_blocked',
        meshId: args.meshId,
        nodeLabel: args.nodeId || args.meshId,
        ...(args.nodeId ? { nodeId: args.nodeId } : {}),
        metadataEvent: {
            source: capacityStall ? 'mesh_queue_capacity_stall_timeout' : 'mesh_queue_difficulty_floor_timeout',
            taskId: args.taskId,
            reason: capacityStall ? 'task_claim_capacity_stall_timeout' : 'task_difficulty_floor_timeout',
            ...(capacityStall ? { skipReason: args.reason } : {}),
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
