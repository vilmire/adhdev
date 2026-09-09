import { LOG } from '../logging/logger.js';
import { getQueue, recordTaskAutoLaunch, type MeshWorkQueueEntry } from './mesh-work-queue.js';
// One-way import: mesh-autolaunch-integrity deliberately imports nothing from this module
// (its old isDifficultyFloorWaitReason dependency moved here with the wait-clock guard),
// so this edge cannot cycle.
import { AUTO_LAUNCH_AWAIT_CLAIM_MS, autoLaunchWriteWouldClobberWinner } from './mesh-autolaunch-integrity.js';
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

// LAUNCH-SIDE DIFFICULTY FLOOR PARITY: re-check the FINAL (provider, model) pair the launch
// is about to spawn against the exact predicate the claim side will apply
// (allowedClassifiedDifficultiesForSession — the same function, deliberately co-located here,
// not a reimplementation, so the two verdicts cannot drift apart again). The earlier launch
// floor gates only prove SOME slot covers the task's difficulty; resolveLaunchAxis then lets
// an explicit task.model override the covering slot's model, landing the launch on a slot
// whose difficulty ceiling is BELOW the task (observed: slots fable[difficult]+opus[medium],
// task difficulty=difficult with explicit model=opus). The claim side judges the spawned
// session by its model and refuses 'difficulty_floor_unmet' forever while the launch side
// kept passing — the spawn→refuse→orphan→respawn runaway of 2026-09-08 (task 53fc7bff,
// ~300 launches in 8.8h). Returns the floor-wait skip reason on a mismatch (routing the
// caller's markSkip through handleDifficultyFloorSkip and the existing 10-minute pager),
// undefined when the launch may proceed. An undefined model (no axis value, or the CODEX-400
// drop) mirrors the claim side's unknown-model conservative slot intersection.
export function launchSideDifficultyFloorMismatch(
    node: any,
    slots: NodeCapabilitySlot[],
    providerType: string,
    model: string | undefined,
    task: Pick<MeshWorkQueueEntry, 'id' | 'difficulty'>,
    nodeId: string,
): string | undefined {
    const allowed = allowedClassifiedDifficultiesForSession(node, slots, providerType, model);
    if (taskMeetsSessionDifficultyFloor(task, allowed)) return undefined;
    LOG.info('MeshQueue', `LAUNCH-SIDE DIFFICULTY FLOOR: not launching '${providerType}'${model ? ` (model '${model}')` : ''} on node ${nodeId} for task ${task.id} — the resolved launch model only covers [${(allowed || []).join(', ')}], below the task's '${task.difficulty}' floor; the claim side would refuse it identically (difficulty_floor_unmet), so spawning would only orphan a session`);
    return `task_difficulty_floor_launch_model_mismatch:${task.difficulty || 'classified'}`;
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

// LEDGER-AUTOLAUNCH-RETRY-SPAM ⑤ clobber guard, same shape as the winner guard in
// mesh-autolaunch-integrity.ts: a session-pinned task is re-skipped
// 'target_session_constraint' by the auto-launch scanner on EVERY tick, which — being a
// non-floor reason — would otherwise unconditionally reset the difficulty-floor wait
// clock's `updatedAt` each time, starving the claim path's bounded-wait pager
// (mesh-queue-assignment.ts tryAssignQueueTask) of the elapsed time it needs.
// (Moved here from mesh-autolaunch-integrity.ts: it is floor-domain logic, and the move
// frees that module of its only import from this one so handleDifficultyFloorSkip can
// import the winner guard back without a cycle.)
export function autoLaunchWriteWouldClobberDifficultyFloorWaitClock(meshId: string, taskId: string, status: string): boolean {
    if (status !== 'skipped') return false;
    let existing: MeshWorkQueueEntry['autoLaunch'] | undefined;
    try { existing = getQueue(meshId).find(t => t.id === taskId)?.autoLaunch; } catch { return false; }
    return existing?.status === 'skipped' && isDifficultyFloorWaitReason(existing.reason);
}

// LEDGER-AUTOLAUNCH-RETRY-SPAM ⑤: the claim path (tryAssignQueueTask) refuses an
// already-running session with the store's 'difficulty_floor_unmet' literal — a case
// markAutoLaunch's handleDifficultyFloorSkip call never covers, since that path is never
// reached for a session that already exists. One-line call site in the frozen
// mesh-queue-assignment.ts; the actual logic lives here instead.
export function handleClaimPathDifficultyFloorRefusal(args: {
    meshId: string; nodeId: string; refusalReason: string;
    claimRefusal: { taskId?: string; difficulty?: string }; coordinatorDaemonId?: string;
}): void {
    if (args.refusalReason !== 'difficulty_floor_unmet' || !args.claimRefusal.taskId) return;
    handleDifficultyFloorSkip({
        meshId: args.meshId, taskId: args.claimRefusal.taskId, nodeId: args.nodeId,
        coordinatorDaemonId: args.coordinatorDaemonId,
        reason: `task_difficulty_floor_unavailable:${args.claimRefusal.difficulty || 'classified'}`,
    });
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
    // AUTOLAUNCH-WINNER-CLOBBER (floor branch): the `continuing` check above only prevents
    // skipped-over-skipped rewrites — it does NOT protect an in-window `completed` winner
    // record. Both routes into this function bypassed markAutoLaunch's winner guard (the
    // floor branch short-circuits before it; the claim path calls in here directly), so a
    // claim-side 'difficulty_floor_unmet' refusal arriving right after a launch overwrote
    // the winner record with `skipped`, disarming the 90s await-claim guard (which requires
    // status==='completed') and resetting the 10-min pager clock every tick — the
    // spawn→refuse→orphan→respawn runaway of 2026-09-08 (task 53fc7bff, ~300 launches).
    // When the write is suppressed the pager clock below still runs: it reads `updatedAt`
    // status-agnostically, so it counts from the surviving winner record instead.
    if (!continuing && !autoLaunchWriteWouldClobberWinner(args.meshId, args.taskId, {
        status: 'skipped',
        nodeId: args.nodeId,
    }, AUTO_LAUNCH_AWAIT_CLAIM_MS)) {
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
