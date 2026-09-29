import { requireMeshHostQueueOwner } from './mesh-host-ownership.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import type { MeshClaimRefusal } from './mesh-runtime-store.js';
import type { MeshQueueHead } from './mesh-runtime-store-queue-reads.js';
export type { MeshQueueHead } from './mesh-runtime-store-queue-reads.js';
import { getMesh } from '../config/mesh-config.js';
import { LOG } from '../logging/logger.js';
import { isTaskDispatchInFlight, endTaskDispatchInFlight } from './mesh-task-inflight.js';
// GRAPH-ORCHESTRATION Phase B: THE single terminal choke point (design :311-334).
// updateTaskStatus / updateSessionTaskStatus delegate every terminal flip to it.
import {
    commitTaskTerminalAndAdvanceGraph,
    drainMeshGraphOutbox,
    type MeshTerminalCommitSource,
    type MeshTerminalCommitStatus,
    type MeshTerminalCompletionEnvelope,
} from './mesh-graph-transition-runner.js';
import {
    resolveOnDependencyFailurePolicy,
} from './mesh-graph-derived-failure.js';
import {
    sessionIdsEquivalent,
    MESH_TERMINAL_TASK_STATUSES as TERMINAL_TASK_STATUS_LIST,
    type MeshTaskDifficulty,
    type MeshTaskStatus,
} from '@adhdev/mesh-shared';
// Type-only: the queue carries the multipart input envelope a task was dispatched
// with. A VALUE import across the mesh → providers boundary is forbidden
// (check:boundaries); a type import is the contract this field is typed against.
import { validateMeshTaskModeRequest, buildMeshTaskModeViolationError } from './mesh-task-mode-guardrail.js';
import {
    PARK_REASON_PIN_EXPIRED,
    PARK_RETENTION_EXPIRED_REASON,
    PARKED_TASK_RETENTION_MS,
    buildParkingRecord,
    logTaskParked,
    parkedTaskRetentionExpired,
    taskIsParked,
} from './mesh-task-parking.js';

// ── Vocabulary (wiring-unification A3) ────────────────────────────────────────
// Every mesh enum is declared ONCE in @adhdev/mesh-shared (mesh-vocabulary.ts).
// This file re-exports the names its ~100 importers and the daemon-core barrel
// already use, so the queue, the MCP schemas and the dashboard cannot drift.
// `MeshTaskPriority` is the TASK-level scheduling priority (G6: which task a node
// pulls first, created_at tie-break) — distinct from a node's schedulingPriority.
export {
    MESH_TASK_STATUSES,
    MESH_TERMINAL_TASK_STATUSES,
    MESH_TASK_MODES,
    MESH_TASK_PRIORITIES,
    isMeshTaskStatus,
    isMeshTerminalTaskStatus,
    isMeshTaskMode,
    isMeshTaskPriority,
} from '@adhdev/mesh-shared';
export type { MeshTaskStatus, MeshTaskMode, MeshTaskPriority, MeshTerminalTaskStatus } from '@adhdev/mesh-shared';
// C-W9a: the pure task predicates live in a leaf so the mcp-server can use them
// without value-importing this (DB-backed) module; re-exported for every
// existing `from './mesh-work-queue.js'` importer.
import {
    isTaskReadonly,
    summarizeQueueEntryInputForView,
    taskDependenciesSatisfied,
    describeTaskDependencyState,
    MESH_TASK_GRAPH_MAX_TASKS,
    meshTaskPriorityRank,
    normalizeMeshTaskPriority,
    resolveNotBefore,
    meshTaskNotBeforeReady,
    NOT_BEFORE_RELATIVE_THRESHOLD_MS,
} from './mesh-task-predicates.js';
export {
    MESH_TASK_GRAPH_MAX_TASKS,
    meshTaskPriorityRank,
    normalizeMeshTaskPriority,
    resolveNotBefore,
    meshTaskNotBeforeReady,
    NOT_BEFORE_RELATIVE_THRESHOLD_MS,
    isTaskReadonly,
    summarizeQueueEntryInputForView,
    taskDependenciesSatisfied,
    describeTaskDependencyState,
};
export type { MeshTaskInputSummary } from './mesh-task-predicates.js';

// summarizeQueueEntryInputForView / MeshTaskInputSummary moved to ./mesh-task-predicates.ts
// (C-W9a pure leaf); re-exported below.

// meshTaskPriorityRank / normalizeMeshTaskPriority / resolveNotBefore /
// meshTaskNotBeforeReady / NOT_BEFORE_RELATIVE_THRESHOLD_MS moved to the pure leaf
// ./mesh-task-predicates.ts (C-W9a); re-exported above.

// isTaskReadonly moved to ./mesh-task-predicates.ts (C-W9a: pure leaf the mcp-server
// may import without importing this module); re-exported below.

// ── Read-only task-mode guardrail ──────────────────────────────────────
// Moved to mesh-task-mode-guardrail.ts (pure move, no behavior change).
// Re-exported here so the ~107 modules importing these names from
// './mesh-work-queue.js' keep working unchanged.
export {
    formatMeshTaskModeViolations,
    normalizeMeshTaskMode,
} from './mesh-task-mode-guardrail.js';
// These two are also used locally below, so they are imported at the top and
// re-exported from that binding rather than re-declared here.
export { validateMeshTaskModeRequest, buildMeshTaskModeViolationError };
export type {
    MeshTaskModeViolationDetail,
    MeshTaskModeValidationResult,
} from './mesh-task-mode-guardrail.js';

// ── Node capability tags ──────────────────────────────────────────────────────
// Moved to ./mesh-node-capability-tags.ts (FILE-SIZE-HEADROOM); imported for the
// call sites below and re-exported so external importers are unchanged.
import {
    buildMeshNodeCapabilityTags,
    normalizeMeshCapabilityTags,
    nodeSatisfiesRequiredTags,
    resolveConvergeRequiredTags,
    providerPinsFromRequiredTags,
    filterProvidersByRequiredTags,
} from './mesh-node-capability-tags.js';
export {
    buildMeshNodeCapabilityTags,
    normalizeMeshCapabilityTags,
    nodeSatisfiesRequiredTags,
    resolveConvergeRequiredTags,
    providerPinsFromRequiredTags,
    filterProvidersByRequiredTags,
};

// Used by the cancel / requeue / stranded-reclaim paths below, and re-exported
// with the rest of the direct-dispatch surface at the bottom of this file.
import { terminalizeSiblingDispatch } from './mesh-direct-dispatch.js';
export { terminalizeSiblingDispatch };
import { insertQueueDependencyNoticeInTxn } from './mesh-queue-dependency-notice.js';
import { type MeshWorkQueueEntry, type MeshQueueMutationOptions, type MeshWorkQueueStats } from './mesh-work-queue-types.js';
export { assertNoDependencyCycle, enqueueTask, enqueueTaskGraph, recordDirectDispatchTask } from './mesh-work-queue-enqueue.js';
export type { MeshActiveTaskStatus, MeshHistoricalTaskStatus, MeshTaskInputEnvelope, MeshTaskParking, MeshWorkQueueEntry, MeshQueueMutationOptions, MeshEnqueueTaskOptions, MeshTaskGraphEntrySpec, MeshWorkQueueStats } from './mesh-work-queue-types.js';

export function withQueueLock<T>(_meshId: string, fn: () => T): T {
    return MeshRuntimeStore.getInstance().transaction(fn);
}

export function readQueue(meshId: string): MeshWorkQueueEntry[] {
    return MeshRuntimeStore.getInstance().getQueueEntries(meshId);
}

/**
 * Get all tasks in the queue, optionally filtered by status.
 */
export function getQueue(meshId: string, opts?: { status?: MeshTaskStatus[] }): MeshWorkQueueEntry[] {
    return MeshRuntimeStore.getInstance().getQueueEntries(meshId, opts?.status?.length ? opts.status : undefined);
}

/**
 * One queue row by id, or null. Use this instead of `getQueue(meshId).find(t => t.id === id)`,
 * which parses every row of the mesh (5.6 MB on the preview daemon; IPC load audit #10).
 */
export function getQueueEntryById(meshId: string, taskId: string): MeshWorkQueueEntry | null {
    return MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
}

/**
 * Column-only queue rows (id / status / assigned node+session), optionally by status —
 * for counting and before/after status diffs without parsing payloads (IPC load audit #10).
 */
export function getQueueHeads(meshId: string, opts?: { status?: MeshTaskStatus[] }): MeshQueueHead[] {
    return MeshRuntimeStore.getInstance().getQueueHeads(meshId, opts?.status?.length ? opts.status : undefined);
}

export function getMeshQueueRevision(meshId: string): string {
    return MeshRuntimeStore.getInstance().getQueueRevision(meshId);
}

/**
 * Find the next pending task that this node is allowed to claim, and mark it as assigned.
 *
 * `opts.providerType` is stamped onto the claimed entry (assignedProviderType) so
 * per-(node, provider) caps can be counted. `opts.providerMaxParallel`, when set,
 * is the enforced per-(node, provider) cap (summed slots[].maxParallel):
 * a task is not assigned to this (node, provider) once it already has that many
 * active assignments. This composes with the global/taskMode caps (stricter wins).
 */
export function claimNextTask(
    meshId: string,
    nodeId: string,
    sessionId: string,
    capabilityTags?: string[],
    opts?: {
        providerType?: string;
        providerMaxParallel?: number;
        /** Model the claiming session launched with — stamped so per-slot caps can be counted. */
        assignedModel?: string;
        /** Enforced cap of the SLOT (provider, model) this claim belongs to. */
        slotMaxParallel?: number;
        /** Every nodeId sharing this node's DAEMON MACHINE — the scope the provider
         *  and slot maxParallel caps are counted over, so sibling worktrees on one
         *  machine share a budget instead of multiplying it. Omit to count the single
         *  node (prior behavior; never widens a cap). */
        daemonNodeIds?: readonly string[];
        nodeIsWorktree?: boolean;
        assignedTranscriptProfile?: MeshWorkQueueEntry['assignedTranscriptProfile'];
        /** Classified task grades this concrete/unknown-model session can safely run. */
        allowedTaskDifficulties?: readonly MeshTaskDifficulty[];
        /** GIT-GATE: the claiming node's git telemetry verdict (dirty / stale-behind),
         *  resolved by the caller — see MeshRuntimeStore.claimNextQueueTask's own doc. */
        nodeGitGate?: { dirty: boolean; staleBehind: boolean; behind?: number; maxBehind?: number };
        /** A6-SILENT-REFUSAL: optional sink naming WHICH gate refused when this returns
         *  null. Diagnostic only — omitting it preserves the exact prior behavior. */
        outRefusal?: MeshClaimRefusal;
    },
): MeshWorkQueueEntry | null {
    return MeshRuntimeStore.getInstance().claimNextQueueTask(meshId, nodeId, sessionId, capabilityTags, opts);
}

// ─── M1: Dependency Failure Propagation ─────────

export type DependencyFailurePolicy = 'block' | 'cancel';

function resolveDependencyFailurePolicy(meshId: string): DependencyFailurePolicy {
    try {
        const policy = (getMesh(meshId)?.policy ?? {}) as Record<string, unknown>;
        return resolveOnDependencyFailurePolicy(policy.onDependencyFailure ?? policy.on_dependency_failure);
    } catch {
        return 'block';
    }
}

/**
 * Apply the mesh's onDependencyFailure policy to pending dependents of a task
 * that just reached a failed/cancelled terminal state (design :522-538).
 *
 * - 'block' (default): derive the hold from current predecessor statuses.
 *   Do NOT write `blockedReason`. The unchanged predicate stays false until
 *   every dependsOn id is `completed`. Predecessor retry unblocks automatically.
 * - 'cancel': explicit transactional cancellation cascade. Terminal; not
 *   revived by predecessor retry.
 *
 * Must be called inside the queue lock of the triggering transition.
 */
/**
 * Cascade a dependency failure. Returns the dependents whose status was flipped to
 * `cancelled` (the 'cancel' policy) so the caller can trigger mission_close_candidate
 * detection for their missions too — a cascade can be the very transition that leaves
 * a *different* mission all-terminal. Under the 'block' policy nothing is mutated
 * (and nothing goes terminal), so the returned list is empty.
 */
function propagateDependencyFailure(meshId: string, failedTaskId: string, machineReason?: string): MeshWorkQueueEntry[] {
    const policy = resolveDependencyFailurePolicy(meshId);
    // C3 (design :522-529): `block` is derived. Do not mutate dependents — but
    // TELL the coordinator (queue chains have no graph notice): which task
    // ended, which tasks now wait on it, what to do. Once per root terminal.
    if (policy !== 'cancel') {
        tellCoordinatorQueueDependency(meshId, failedTaskId, 'block', [], machineReason);
        return [];
    }
    const store = MeshRuntimeStore.getInstance();
    const cancelled: MeshWorkQueueEntry[] = [];
    const frontier = [failedTaskId];
    const seen = new Set<string>(frontier);
    while (frontier.length > 0) {
        const currentId = frontier.pop()!;
        const dependents = store.getQueueEntries(meshId, ['pending'])
            .filter(entry => Array.isArray(entry.dependsOn) && entry.dependsOn.includes(currentId));
        for (const dependent of dependents) {
            if (seen.has(dependent.id)) continue;
            seen.add(dependent.id);
            dependent.cancelledAt = new Date().toISOString();
            dependent.cancelReason = `dependency_failed:${currentId}`;
            store.updateQueueEntry(dependent);
            // F1: through the runner, so a graph-backed dependent's node goes
            // terminal with its row (it used to stay `blocked` under a cancelled row).
            const committed = commitQueueTerminalThroughRunner(meshId, dependent.id, 'cancelled', 'cancellation', dependent.cancelReason);
            cancelled.push(committed ?? dependent);
            frontier.push(dependent.id); // cascade to transitive dependents
        }
    }
    tellCoordinatorQueueDependency(meshId, failedTaskId, 'cancel', cancelled, machineReason);
    return cancelled;
}

/**
 * Queue-chain stopped-work notice (mesh-queue-dependency-notice.ts): the row
 * joins this queue transaction, then the graph outbox is drained so it pages
 * now rather than on the next graph event. Best-effort — a notice failure must
 * never undo the terminal it describes.
 */
function tellCoordinatorQueueDependency(
    meshId: string,
    rootId: string,
    policy: 'block' | 'cancel',
    cancelled: MeshWorkQueueEntry[],
    machineReason?: string,
): void {
    try {
        if (insertQueueDependencyNoticeInTxn(meshId, rootId, policy, cancelled, machineReason)) {
            drainMeshGraphOutbox(meshId);
        }
    } catch (e: any) {
        LOG.warn('MeshQueue', `Queue dependency notice for ${rootId} failed (mesh ${meshId}): ${e?.message || e}`);
    }
}

/**
 * F1 — the ONE way a queue-side writer puts a row terminal: through the graph
 * runner's terminal transition (commitTaskTerminalAndAdvanceGraph), exactly like
 * the ledger path. The row flip, the graph node transition, the failure policy
 * (graph cancel cascade + dead-upstream gate closure), the runner-end gate
 * auto-close and the stopped-downstream notice all commit together — before
 * this, retry-cap / dispatch-failure / park-retention failures and the queue
 * dependency cascade flipped only the row, leaving the graph node live and the
 * graph `active` forever.
 *
 * MUST run inside the caller's queue lock (the runner nests as a savepoint). The
 * caller persists its own bookkeeping (cancelReason, counters) BEFORE calling:
 * the runner re-reads the row. `reason` should lead with a machine code — it is
 * the node's failureReason and the notice's reason code.
 */
function commitQueueTerminalThroughRunner(
    meshId: string,
    taskId: string,
    status: 'failed' | 'cancelled',
    source: MeshTerminalCommitSource,
    reason: string,
): MeshWorkQueueEntry | null {
    const commit = commitTaskTerminalAndAdvanceGraph({ meshId, taskId, status, source, reason });
    return commit.entry ?? MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
}

const DEPENDENCY_FAILURE_TERMINALS = new Set<MeshTaskStatus>(['failed', 'cancelled']);

/**
 * CANCEL-STICKY-TERMINAL: the terminal task statuses. A row in one of these states is a
 * historical record — no live dispatch owns it — and must NEVER be flipped back to an
 * active (`pending`/`assigned`) state by a late writer. The canonical live example is a
 * cancel that races the dispatch-failure `.catch` (mesh-queue-assignment.ts): that catch
 * fires-and-forgets an unconditional `updateTaskStatus(...,'pending')`, resolving AFTER
 * the cancel commits, which resurrected the cancelled row → it got re-claimed and the
 * reclaim watchdog re-drove the same prompt. Guarding the write side (see
 * {@link updateTaskStatus}) applies the same terminal-row protection
 * {@link reclaimStrandedAssignedTask} already enforces to EVERY status writer at once.
 */
/** Terminal queue statuses — mesh-shared's one list (MESH_TERMINAL_TASK_STATUSES). */
const TERMINAL_TASK_STATUSES = new Set<MeshTaskStatus>(TERMINAL_TASK_STATUS_LIST);

/**
 * G3 (step ①) — fire-and-forget mission_close_candidate detection for the missions of
 * the given task ids. Called after any task-status mutation (completion / failure /
 * cancel / dependency-cascade / new-task enqueue) so a mission whose tasks all just
 * became terminal gets a one-shot "consider closing" nudge, and a mission that just
 * gained a non-terminal task has its idempotency marker reset.
 *
 * Loaded via a lazy dynamic import to break the static queue↔missions import cycle
 * (mesh-missions statically imports getQueue from here): the resolve happens off the
 * mutation's critical path, and any failure is swallowed — this is a best-effort hint,
 * never allowed to affect the task write that triggered it.
 */
export function scheduleMissionCloseCandidateCheck(meshId: string, entries: Array<MeshWorkQueueEntry | null | undefined>): void {
    const missionIds = new Set<string>();
    for (const entry of entries) {
        const missionId = entry?.missionId;
        if (typeof missionId === 'string' && missionId.trim()) missionIds.add(missionId.trim());
    }
    if (missionIds.size === 0) return;
    void import('./mesh-missions.js')
        .then(({ maybeEmitMissionCloseCandidate }) => {
            for (const missionId of missionIds) {
                try { maybeEmitMissionCloseCandidate(meshId, missionId); } catch { /* best-effort per mission */ }
            }
        })
        .catch(() => { /* best-effort: never break a task mutation on the hint path */ });
}

/**
 * Update the status of a specific task.
 * Used when a session completes, fails, or stalls.
 */
export function updateTaskStatus(
    meshId: string,
    taskId: string,
    status: MeshTaskStatus,
    opts?: {
        /**
         * CANCEL-STICKY-TERMINAL: operator/system override to permit a terminal→non-terminal
         * transition (e.g. an explicit operator reopen). Without this, a write that would flip
         * a `completed`/`failed`/`cancelled` row back to `pending`/`assigned` is refused as a
         * no-op. Terminal→terminal and any transition FROM a non-terminal state are unaffected.
         */
        force?: boolean;
        /**
         * GRAPH-ORCHESTRATION Phase C1: the normalized completion envelope this
         * terminal carries, persisted as the task's next immutable output version
         * and read by downstream `inputs_from` bindings / `run_if` conditions
         * (design :145-171, :192-370). Symmetrical with updateSessionTaskStatus —
         * a completion path that resolves the task by ID rather than by session
         * (redrive, reconcile, native-signal reconciliation) must be able to carry
         * its result too, or a graph consumer would bind against an empty envelope.
         */
        envelope?: MeshTerminalCompletionEnvelope;
    } & MeshQueueMutationOptions,
): MeshWorkQueueEntry | null {
    requireMeshHostQueueOwner(opts);
    // C3: a terminal queue status is an EFFECT of a turn-ledger commit, never a
    // direct write — submit evidence (`ledger.observe`) instead.
    if (TERMINAL_TASK_STATUSES.has(status)) throw new TerminalStatusIsLedgerEffect(meshId, taskId, status);
    return writeTaskStatusUnchecked(meshId, taskId, status, opts);
}

/**
 * @internal Test fixtures only: drive a queue row terminal through the graph
 * choke point without a ledger (the legacy commit path the runner tests
 * exercise). Production code must submit evidence; `updateTaskStatus` throws.
 */
export function __writeTaskStatusForTests(
    meshId: string,
    taskId: string,
    status: MeshTaskStatus,
    opts?: Parameters<typeof updateTaskStatus>[3],
): MeshWorkQueueEntry | null {
    return writeTaskStatusUnchecked(meshId, taskId, status, opts);
}

function writeTaskStatusUnchecked(
    meshId: string,
    taskId: string,
    status: MeshTaskStatus,
    opts?: Parameters<typeof updateTaskStatus>[3],
): MeshWorkQueueEntry | null {
    const result = withQueueLock(meshId, () => {
        const entry = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
        if (!entry) return null;
        // CANCEL-STICKY-TERMINAL: never resurrect a terminal row into an active state. A late
        // fire-and-forget writer (canonically the dispatch-failure `.catch` requeue to
        // 'pending' in mesh-queue-assignment.ts, which resolves AFTER a cancel commits) must
        // not undo a cancel/completion/failure — that revival let the row be re-claimed and the
        // reclaim watchdog re-drive the same prompt. Refuse the transition as a no-op unless an
        // explicit operator override is passed. This is the write-side sibling of the
        // status!=='assigned' guard reclaimStrandedAssignedTask already applies.
        if (!opts?.force
            && TERMINAL_TASK_STATUSES.has(entry.status)
            && !TERMINAL_TASK_STATUSES.has(status)) {
            LOG.debug('MeshQueue', `Refusing updateTaskStatus(${taskId} → ${status}) on mesh ${meshId}: row is terminal (${entry.status}). A late writer (e.g. dispatch-failure requeue) must not resurrect a cancelled/completed/failed task. Pass force to override.`);
            return { entry, cascaded: [] as MeshWorkQueueEntry[] };
        }
        // GRAPH-ORCHESTRATION Phase B (design :311-334): EVERY terminal acceptance routes
        // through the single transactional choke point. commitTaskTerminalAndAdvanceGraph
        // owns, inside the one queue transaction: the attempt fence+settle, the normalized
        // output version, the row flip, graph advancement, and the wake outbox.
        //
        // SETTLE OWNERSHIP (supersedes the d18e9838 inline block that used to live here):
        // the proposeTurnCompletion settle is now performed INSIDE the runner as step 1 —
        // exactly once per terminal transition, never twice. This function neither settles
        // before delegating nor after; the runner's proposal is the same idempotent reducer
        // call (an identical repeat returns committed+duplicate without mutating), so the
        // call sites that pre-propose before invoking us (markSessionTerminal) are unaffected.
        if (TERMINAL_TASK_STATUSES.has(status)) {
            const commit = commitTaskTerminalAndAdvanceGraph({
                meshId,
                taskId,
                status: status as MeshTerminalCommitStatus,
                sessionId: entry.assignedSessionId,
                source: 'stall_reconcile',
                reason: `task_status_terminal:${status}`,
                envelope: opts?.envelope,
            });
            const cascaded = DEPENDENCY_FAILURE_TERMINALS.has(status) ? propagateDependencyFailure(meshId, taskId, `task_status_terminal:${status}`) : [];
            return { entry: commit.entry ?? entry, cascaded };
        }
        entry.status = status;
        MeshRuntimeStore.getInstance().updateQueueEntry(entry);
        // Any transition OFF `assigned` ends the single-flight dispatch window (the
        // dispatch-failure requeue to `pending`).
        if (status !== 'assigned') endTaskDispatchInFlight(meshId, taskId);
        const cascaded: MeshWorkQueueEntry[] = [];
        return { entry, cascaded };
    });
    if (result) scheduleMissionCloseCandidateCheck(meshId, [result.entry, ...result.cascaded]);
    return result ? result.entry : null;
}

// SPAWN-CAP-TRANSPORT-AWARE: the auto-launch record writer and the two durable spawn-cap
// counter mutators live together in mesh-autolaunch-spawn-budget.ts — a leaf needing only the
// store and this file's entry type (import type, so no cycle). They moved there because this
// file sits at the 2,400-line file-size gate, and they belong together: the counters are
// deliberately NOT routed through recordTaskAutoLaunch's clobber-guarded `autoLaunch` write.
// Re-exported here so every existing importer (and test) is unaffected by the move.
export { recordTaskAutoLaunch } from './mesh-autolaunch-spawn-budget.js';

/**
 * Mark a queue task as manually cancelled without deleting audit history.
 */
export function cancelTask(
    meshId: string,
    taskId: string,
    opts?: { reason?: string } & MeshQueueMutationOptions,
): MeshWorkQueueEntry | null {
    requireMeshHostQueueOwner(opts);
    const result = withQueueLock(meshId, () => {
        const entry = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
        if (!entry) return null;
        const now = new Date().toISOString();
        // CANCEL-STICKY-TERMINAL (authoritative cancel): capture the prior assignment BEFORE
        // clearing it, so the caller can stop the bound live worker. Leaving assignedNodeId/
        // SessionId/ProviderType on the cancelled row let the still-running worker keep emitting
        // delivery/turn signals that re-ignited the reclaim watchdog (observed: nonce 6→9,
        // needing two cancels + a manual session stop). Clearing them also drops this row from
        // the status==='assigned' counters so it can never be treated as live again.
        const priorAssignment: CancelledTaskAssignment | undefined = entry.assignedSessionId
            ? {
                sessionId: entry.assignedSessionId,
                nodeId: entry.assignedNodeId,
                providerType: entry.assignedProviderType,
            }
            : undefined;
        entry.cancelledAt = now;
        if (opts?.reason) entry.cancelReason = opts.reason;
        // PIN-PARKING: cancelling a parked task IS a coordinator decision — the "it is
        // no longer wanted" exit — so the row stops being parked. Without this the
        // cancelled row would keep matching taskIsParked and go on being listed as
        // awaiting a decision that has already been made. (The parked→cancelled
        // transition needs no other guard: cancelTask is status-agnostic by design and
        // a parked row is an ordinary 'pending' row to it.)
        delete entry.parked;
        delete entry.assignedNodeId;
        delete entry.assignedSessionId;
        delete entry.assignedProviderType;
        delete entry.assignedModel;
        delete entry.dispatchTimestamp;
        // Belt-and-suspenders: bump the dispatch nonce so any in-flight inject the
        // now-orphaned worker later echoes carries a stale nonce and is rejected by the
        // coordinator's stale-nonce guard — same mechanism reclaimStrandedAssignedTask uses.
        entry.dispatchNonce = (entry.dispatchNonce || 0) + 1;
        delete entry.attemptId;
        // Persist the cancel-specific bookkeeping ABOVE (cancelledAt/cancelReason, the
        // cleared assignment, the bumped nonce) BEFORE the choke point runs: the runner
        // re-reads the row inside its own transaction, so anything not yet written would
        // be clobbered by its flip. The row is still non-terminal at this point, which is
        // exactly what the runner's replay fence expects for a first terminal.
        MeshRuntimeStore.getInstance().updateQueueEntry(entry);
        // SIBLING-DISPATCH-ORPHAN: a direct-dispatched task carries a second row in
        // the legacy direct-dispatch table. Clearing the assignment above drops this task from every
        // queue-side counter, but that row would survive with status 'acked' — which
        // buildMeshActiveWork renders as `generating`, so the cancelled task would keep
        // showing up as live work with no sweeper to ever collect it.
        terminalizeSiblingDispatch(meshId, taskId, 'queue_task_cancelled');
        // GRAPH-ORCHESTRATION Phase B: a cancel is a terminal acceptance like any other,
        // so it routes through the SAME choke point as completion/failure rather than
        // writing `status = 'cancelled'` inline. Before this, a cancelled task left its
        // graph node stuck in `declared`/`materialized` and the graph itself `active`
        // forever: `classifyGraphRollup` never saw a settled node, so the graph could
        // reach no terminal state, and `cleanupOnGraphFailure` (which keys on
        // `graph.status === 'cancelled'`) was structurally unreachable — the workspace of
        // a cancelled branch was never collected.
        //
        // Routing here also SUBSUMES the standalone proposeTurnCompletion this function
        // used to make: the runner's step-1 settle issues the identical `cancellation`
        // proposal inside the transaction, so the attempt fence and the row can no longer
        // disagree, and a cancel racing a late worker completion still commits exactly one
        // terminal outcome. It is one settle, not two — the reducer is idempotent, but the
        // point is that the row flip and the settle are now the same transaction.
        //
        // Downstream policy is UNCHANGED by design: the runner applies the graph-side
        // cancel cascade only under `on_dependency_failure: 'cancel'`, and under the
        // default `block` it merely records a derived-failure outbox row — dependents stay
        // pending and a retry of the cancelled task still recovers them.
        const commit = commitTaskTerminalAndAdvanceGraph({
            meshId,
            taskId,
            status: 'cancelled',
            sessionId: priorAssignment?.sessionId,
            source: 'cancellation',
            reason: opts?.reason ?? 'operator_cancel',
        });
        // The queue-side dependent cascade is the pre-graph sibling of the runner's
        // graph-node cascade and is still required: it terminalizes dependents that have
        // NO backing graph node (the legacy/ad-hoc enqueue path). Like the graph cascade
        // it is a no-op unless the policy is `cancel`.
        const cascaded = propagateDependencyFailure(meshId, taskId);
        // D3(a) gate auto-close (a gate whose downstream this cancel left all
        // terminal) runs INSIDE the choke point above — the runner owns it for
        // every terminal writer, and its post-commit drain delivers the rows.
        return { entry: commit.entry ?? entry, cascaded, priorAssignment };
    });
    if (result) scheduleMissionCloseCandidateCheck(meshId, [result.entry, ...result.cascaded]);
    // Surface the prior binding to the caller (out-of-band from the persisted row, so it is
    // never serialized) so the cancel command handler — which holds DaemonComponents — can
    // stop the now-orphaned worker via the transport-aware stopStaleMeshWorker helper.
    if (result?.priorAssignment) lastCancelledTaskAssignment.set(`${meshId}::${taskId}`, result.priorAssignment);
    return result ? result.entry : null;
}

/**
 * CANCEL-STICKY-TERMINAL: the assignment a task carried at cancel time, handed to the cancel
 * command handler so it can stop the bound worker. cancelTask runs in the pure queue-store
 * module (no DaemonComponents), so it records the binding here and the handler drains it.
 */
export interface CancelledTaskAssignment {
    sessionId: string;
    nodeId?: string;
    providerType?: string;
}

const lastCancelledTaskAssignment = new Map<string, CancelledTaskAssignment>();

/**
 * Read-and-clear the assignment a just-cancelled task was bound to. Returns undefined when the
 * cancelled task had no live assignment (nothing to stop). One-shot: the entry is deleted on read.
 */
export function takeCancelledTaskAssignment(meshId: string, taskId: string): CancelledTaskAssignment | undefined {
    const key = `${meshId}::${taskId}`;
    const value = lastCancelledTaskAssignment.get(key);
    if (value) lastCancelledTaskAssignment.delete(key);
    return value;
}

/**
 * DISPATCH-BOOT-RACE: max consecutive dispatch failures (transport reject / adapter not
 * found — the worker never started the task) before a task is auto-failed on the
 * dispatch-failure axis. Independent of (and more generous than) maxTaskRetries: a
 * dispatch failure is cheap and fast to retry — commonly a session still booting, which
 * self-resolves within seconds — unlike a worker crash mid-task, so it earns its own,
 * larger budget rather than sharing/exhausting the worker-failure retry cap.
 */
const MAX_DISPATCH_FAILURES = 5;

/**
 * DISPATCH-BOOT-RACE: base backoff before the first dispatch-failure retry, doubled per
 * consecutive failure (1st retry: 3s, 2nd: 6s, 3rd: 12s, …) up to
 * DISPATCH_RETRY_BACKOFF_MAX_MS. Chosen to comfortably clear a booting CLI session's
 * typical interactive-readiness window (waitForLocalSessionReady's own budget is up to
 * 15s) without making a genuinely transient failure wait an unreasonably long time.
 */
const DISPATCH_RETRY_BACKOFF_BASE_MS = 3_000;

/** DISPATCH-BOOT-RACE: ceiling on the escalating dispatch-failure backoff. */
const DISPATCH_RETRY_BACKOFF_MAX_MS = 30_000;

/**
 * PIN-PARKING (edit): apply a requeue's optional instruction rewrite in place.
 *
 * Blank-guarded rather than "set whatever was passed": an omitted field and an
 * empty string arrive indistinguishably through the MCP tool boundary, and
 * blanking a task's only instruction would leave a dispatchable row that tells
 * its worker nothing. Absent/blank ⇒ the message is left exactly as it was.
 */
function applyRequeueMessageEdit(entry: MeshWorkQueueEntry, message?: string): void {
    if (typeof message !== 'string') return;
    const next = message.trim();
    if (!next || next === entry.message) return;
    entry.message = next;
}

/**
 * Return a queue task to pending for retry. By default, dead session targeting
 * and assigned ownership are cleared so stale assignments do not strand again.
 */
export function requeueTask(
    meshId: string,
    taskId: string,
    opts?: {
        reason?: string;
        targetNodeId?: string;
        targetSessionId?: string;
        clearTargetNode?: boolean;
        clearTargetSession?: boolean;
        /**
         * Override the retry cap for this call. Use only for explicit operator actions.
         * If true, the task is requeued even when requeueCount >= maxRetries.
         */
        force?: boolean;
        /** Per-task retry cap override. Falls back to mesh policy maxTaskRetries (default 1). */
        maxRetries?: number;
        /**
         * DISPATCH-BOOT-RACE: hold the requeued row pending until this time (same G7
         * gate enforced by claimNextQueueTask and the auto-launch scan) instead of
         * making it immediately re-claimable. Used to back off a dispatch-failure
         * retry so it does not race the same boot window that failed the first
         * attempt. ISO string, absolute epoch-ms, or relative-ms offset from now.
         * Ignored when `dispatchFailure` is true — that path computes its own backoff.
         */
        notBefore?: string | number;
        /**
         * DISPATCH-BOOT-RACE: this requeue is for a dispatch that never reached the
         * worker (transport reject / adapter not found before the task started
         * running) — as opposed to every other requeue reason, which all spend the
         * SAME requeueCount/maxRetries budget a worker-side failure spends. Routes
         * through dispatchFailureCount/MAX_DISPATCH_FAILURES instead: its own,
         * more generous cap (these failures are cheap/fast — commonly a session
         * still booting) and an escalating backoff delay computed here, so a tight
         * mesh policy (maxTaskRetries:1, meant to bound genuine worker failures)
         * cannot be exhausted by a single dispatch failure the worker never saw.
         */
        dispatchFailure?: boolean;
        /**
         * PIN-PARKING (edit): REWRITE the task's instruction as part of the requeue.
         *
         * This exists because "the situation changed while the task waited" is the
         * normal case for a parked delta, not an edge case — the observed instance
         * being a worker that had already finished the very part the delta was
         * written to correct. Before this, the queue had NO message mutator at all
         * (requeueTask could re-target but not re-word), so a coordinator whose delta
         * had gone stale could only cancel and re-enqueue, losing the row's identity,
         * its mission linkage, and everything that depends on its id.
         *
         * Placed on requeue rather than on a new tool because requeue is already the
         * "put this task back with different addressing" mutator; re-wording is the
         * same operation on a different field, and every caller that must not be
         * surprised by it (the dispatch-failure retry, the dead-target self-heal)
         * simply never passes it. An empty/blank string is ignored — clearing a task's
         * only instruction would produce a row that can be dispatched but says nothing.
         */
        message?: string;
    } & MeshQueueMutationOptions,
): MeshWorkQueueEntry | null {
    requireMeshHostQueueOwner(opts);
    const result = withQueueLock(meshId, () => {
        const entry = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
        if (!entry) return null;
        // CANON-IDENTITY single-flight: refuse (no-op) to reopen a task whose dispatch
        // is still in-flight — the worker is actively generating on it. Requeueing it
        // here would flip the row back to `pending` and let a SECOND session claim the
        // SAME task (the live `ade8586d` requeue-while-generating double-dispatch). A
        // STALE assigned row (dead session, dispatch never confirmed) is NOT in-flight
        // — its mark was cleared on the dispatch failure — so it still requeues as
        // before. An explicit operator override (`force`) bypasses this guard.
        // MAGI-NOTE: the future consensus group fan-out (separate mission) intentionally
        // re-dispatches a group-tagged task into multiple sessions and must be exempted
        // from this single-flight guard; the exemption hook (group-id check) belongs here.
        if (!opts?.force && isTaskDispatchInFlight(meshId, taskId)) {
            LOG.warn('MeshQueue', `Refusing to requeue task ${taskId} on mesh ${meshId}: it is actively dispatched/generating (single-flight in-flight). Requeueing now would open a duplicate second dispatch into another session. Pass force to override.`);
            // No status change → no mission aggregate change; nothing to re-check.
            return { entry, cascaded: [] as MeshWorkQueueEntry[], missionAffected: false };
        }
        // Proceeding to requeue (or force-override): the prior dispatch is being abandoned,
        // so end the single-flight window for this task id.
        endTaskDispatchInFlight(meshId, taskId);
        // SIBLING-DISPATCH-ORPHAN: same abandonment as cancelTask, and strictly worse here
        // — the task is going back to `pending` to be dispatched AGAIN, so leaving the old
        // direct-dispatch row live would let the stale row and the new dispatch both render
        // as active work for one task. Reason is refined to 'queue_task_dispatch_failed' in
        // the dispatch-failure branch below, which is the same abandonment on its own axis.
        terminalizeSiblingDispatch(
            meshId,
            taskId,
            opts?.dispatchFailure && !opts?.force ? 'queue_task_dispatch_failed' : 'queue_task_requeued',
        );

        // DISPATCH-BOOT-RACE: a dispatch failure spends its OWN budget
        // (dispatchFailureCount/MAX_DISPATCH_FAILURES), never requeueCount — see the
        // `dispatchFailure` option doc. The worker never started the task, so this is
        // not a "retry" in the requeueCount sense (an execution attempt that ran and
        // failed); it is the coordinator re-offering a task delivery that never landed.
        if (opts?.dispatchFailure && !opts?.force) {
            const dispatchFailures = (entry.dispatchFailureCount || 0) + 1;
            if (dispatchFailures > MAX_DISPATCH_FAILURES) {
                entry.cancelReason = `dispatch_never_started: ${dispatchFailures - 1} consecutive dispatch failure(s) before the worker started the task, limit is ${MAX_DISPATCH_FAILURES}`;
                entry.dispatchFailureCount = dispatchFailures;
                entry.updatedAt = new Date().toISOString();
                MeshRuntimeStore.getInstance().updateQueueEntry(entry);
                const failed = commitQueueTerminalThroughRunner(meshId, taskId, 'failed', 'queue_policy', entry.cancelReason);
                const cascaded = propagateDependencyFailure(meshId, taskId);
                return { entry: failed ?? entry, cascaded, missionAffected: true };
            }
            entry.status = 'pending';
            delete entry.blockedReason;
            delete entry.assignedNodeId;
            delete entry.assignedSessionId;
            delete entry.cancelledAt;
            delete entry.cancelReason;
            if (opts?.clearTargetNode) delete entry.targetNodeId;
            if (typeof opts?.targetNodeId === 'string') entry.targetNodeId = opts.targetNodeId;
            if (opts?.clearTargetSession !== false) delete entry.targetSessionId;
            if (typeof opts?.targetSessionId === 'string') entry.targetSessionId = opts.targetSessionId;
            entry.requeuedAt = new Date().toISOString();
            entry.dispatchFailureCount = dispatchFailures;
            if (opts?.reason) entry.requeueReason = opts.reason;
            applyRequeueMessageEdit(entry, opts?.message);
            // PIN-PARKING: any requeue is an explicit coordinator decision about this
            // row's addressing — which is exactly what parking was waiting for. Unpark.
            delete entry.parked;
            // AUTOLAUNCH-SPAWN-CAP (P3): same explicit decision → fresh spawn budget.
            delete entry.autoLaunchUnclaimedCount;
            // SPAWN-CAP-TRANSPORT-AWARE: the dispatch-failure tally describes the run that
            // just ended, so it resets on the same explicit decision — otherwise a stale
            // tally would keep re-labelling later, unrelated parks as transport failures.
            delete entry.autoLaunchDispatchFailedCount;
            // Escalating backoff (dispatch attempt 1→2: DISPATCH_RETRY_BACKOFF_BASE_MS,
            // 2→3: ×2, …), so a re-dispatch lands after the session has had more time to
            // finish booting rather than racing the same window that just failed —
            // exactly the gap an immediate re-claim (the pre-fix behavior) could not
            // cover: local CLI readiness alone (waitForLocalSessionReady) budgets up to
            // 15s, so a fixed short delay would still frequently lose the race.
            const backoffMs = DISPATCH_RETRY_BACKOFF_BASE_MS * Math.pow(2, dispatchFailures - 1);
            entry.notBefore = resolveNotBefore(Math.min(backoffMs, DISPATCH_RETRY_BACKOFF_MAX_MS));
            MeshRuntimeStore.getInstance().updateQueueEntry(entry);
            return { entry, cascaded: [] as MeshWorkQueueEntry[], missionAffected: true };
        }

        const currentCount = entry.requeueCount || 0;
        const maxRetries = opts?.maxRetries ?? entry.maxRetries ?? 1;
        if (!opts?.force && currentCount >= maxRetries) {
            // Auto-fail: cap exceeded without explicit force override.
            // (failTaskAsUndeliverable reaches this with maxRetries:0.)
            entry.cancelReason = `max_retries_exceeded: requeued ${currentCount} time(s), limit is ${maxRetries}`;
            entry.updatedAt = new Date().toISOString();
            MeshRuntimeStore.getInstance().updateQueueEntry(entry);
            const failed = commitQueueTerminalThroughRunner(meshId, taskId, 'failed', 'queue_policy', entry.cancelReason);
            const cascaded = propagateDependencyFailure(meshId, taskId);
            // Terminal (failed) → mission may now be all-terminal.
            return { entry: failed ?? entry, cascaded, missionAffected: true };
        }
        entry.status = 'pending';
        // Operator requeue clears a dependency-failure block — the operator is
        // explicitly overriding the held-back state.
        delete entry.blockedReason;
        delete entry.assignedNodeId;
        delete entry.assignedSessionId;
        delete entry.cancelledAt;
        delete entry.cancelReason;
        if (opts?.clearTargetNode) delete entry.targetNodeId;
        if (typeof opts?.targetNodeId === 'string') entry.targetNodeId = opts.targetNodeId;
        if (opts?.clearTargetSession !== false) delete entry.targetSessionId;
        if (typeof opts?.targetSessionId === 'string') entry.targetSessionId = opts.targetSessionId;
        entry.requeuedAt = new Date().toISOString();
        entry.requeueCount = currentCount + 1;
        if (opts?.reason) entry.requeueReason = opts.reason;
        applyRequeueMessageEdit(entry, opts?.message);
        // PIN-PARKING: an explicit requeue IS the coordinator decision parking waits
        // for, whatever the new addressing is — so it always unparks. Note this runs
        // on the ordinary requeue path too (not only for parked rows), which is
        // harmless: `delete` on an absent field is a no-op for every normal task.
        delete entry.parked;
        // AUTOLAUNCH-SPAWN-CAP (P3): a requeue is the sanctioned exit from a spawn-cap
        // park — it must also restore the durable launch budget, or the unparked row
        // would re-park on its very next launch attempt (a dead exit).
        delete entry.autoLaunchUnclaimedCount;
        // SPAWN-CAP-TRANSPORT-AWARE: reset the dispatch-failure tally on the same decision.
        delete entry.autoLaunchDispatchFailedCount;
        // DISPATCH-BOOT-RACE: a caller-supplied backoff holds the row pending until the
        // session has had time to finish booting, instead of an immediate re-claim that
        // races the exact window that failed the first attempt. Absent → immediately
        // claimable (prior behavior; every existing caller is unaffected).
        const notBefore = resolveNotBefore(opts?.notBefore);
        if (notBefore) entry.notBefore = notBefore;
        else delete entry.notBefore;
        MeshRuntimeStore.getInstance().updateQueueEntry(entry);
        // Non-terminal (back to pending) → mission left the all-terminal state; the
        // close-candidate check resets any stale idempotency marker so a later
        // re-completion can nudge again.
        return { entry, cascaded: [] as MeshWorkQueueEntry[], missionAffected: true };
    });
    if (result?.missionAffected) scheduleMissionCloseCandidateCheck(meshId, [result.entry, ...result.cascaded]);
    return result ? result.entry : null;
}

/**
 * PIN-PARKING (replaces the RC.20 pin CLEAR): a stale target pin PARKS the task —
 * it is held, still addressed, for an explicit coordinator decision — instead of
 * being cleared so any compatible session can claim it.
 *
 * The behaviour change and its rationale are documented in mesh-task-parking.ts.
 * In short: a `targetSessionId` pin marks a DELTA written for one session's
 * context, and re-homing it onto an arbitrary session is not a late delivery but
 * an incorrect one. The session-stop path already refused to auto-retarget for
 * exactly this reason; this makes the TTL path agree with it.
 *
 * What parking does NOT do, deliberately:
 *  - it does not clear `targetSessionId`. Keeping the pin is what keeps the row
 *    invisible to every other session through the tier-1 claim SELECT, so no new
 *    gate has to hold the line (see mesh-task-parking.ts).
 *  - it does not consume the retry budget. Parking is an un-wedging/holding
 *    operation, not an execution attempt — `requeueCount` is untouched, exactly
 *    as the pin expiry it replaces was.
 *  - it does not go terminal. The task is still `pending` and still recoverable
 *    by requeue; only the retention sweep can turn a forgotten park into a
 *    (notified) failure.
 *
 * Guarded to 'pending' rows only — an assigned/completed/cancelled row is never
 * mutated (explicit operator cancellation stays terminal) — and idempotent: an
 * already-parked row returns null so a re-park cannot restamp `parkedAt` and
 * reset the retention clock on every reconcile tick.
 */
export function parkTaskTargetPin(
    meshId: string,
    taskId: string,
    // AUTOLAUNCH-SPAWN-CAP (P3) reuses this mutator: `allowUntargeted` lifts the
    // pin requirement below, because a spawn-cap runaway usually has no target pin
    // at all. Every other parking semantic (pending-only, idempotent, claim-gate
    // invisibility, requeue unparks, retention sweep) is shared unchanged.
    opts?: { reason?: string; allowUntargeted?: boolean } & MeshQueueMutationOptions,
): MeshWorkQueueEntry | null {
    requireMeshHostQueueOwner(opts);
    return withQueueLock(meshId, () => {
        const entry = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
        if (!entry) return null;
        if (entry.status !== 'pending') return null;
        if (!opts?.allowUntargeted && !entry.targetSessionId && !entry.targetNodeId) return null;
        // Idempotent: never restamp an existing park (that would reset the
        // retention clock every tick and make a forgotten row immortal).
        if (taskIsParked(entry)) return null;
        const reason = opts?.reason || PARK_REASON_PIN_EXPIRED;
        const now = new Date().toISOString();
        entry.parked = buildParkingRecord(entry, reason, now);
        entry.updatedAt = now;
        entry.requeueReason = reason;
        MeshRuntimeStore.getInstance().updateQueueEntry(entry);
        logTaskParked(meshId, taskId, reason, entry.targetSessionId);
        return entry;
    });
}

/**
 * PIN-PARKING retention: fail a parked task the coordinator never came back for.
 *
 * The owner's constraint on this sweep is that cleanup must not reintroduce the
 * silent drop parking exists to prevent, so this is deliberately NOT a delete: the
 * row goes to `failed` with a stated reason, stays in the queue as an auditable
 * record, propagates dependency failure like any other terminal transition (so
 * dependents unblock instead of waiting forever), and the caller pairs it with a
 * coordinator notification. Returns the entry when it swept, null otherwise.
 */
export function failRetentionExpiredParkedTask(
    meshId: string,
    taskId: string,
    opts?: { retentionMs?: number } & MeshQueueMutationOptions,
): MeshWorkQueueEntry | null {
    requireMeshHostQueueOwner(opts);
    const result = withQueueLock(meshId, () => {
        const entry = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
        if (!entry) return null;
        if (entry.status !== 'pending' || !taskIsParked(entry)) return null;
        if (!parkedTaskRetentionExpired(entry, Date.now(), opts?.retentionMs)) return null;
        const hours = Math.round((opts?.retentionMs ?? PARKED_TASK_RETENTION_MS) / 3_600_000);
        entry.cancelReason = `${PARK_RETENTION_EXPIRED_REASON}: parked for over ${hours}h `
            + `(addressed to session ${entry.parked?.targetSessionId || 'unknown'}) with no coordinator decision`;
        entry.updatedAt = new Date().toISOString();
        MeshRuntimeStore.getInstance().updateQueueEntry(entry);
        const failed = commitQueueTerminalThroughRunner(meshId, taskId, 'failed', 'queue_policy', entry.cancelReason);
        const cascaded = propagateDependencyFailure(meshId, taskId);
        LOG.warn('MeshQueue', `PIN-PARKING retention: task ${taskId} (mesh ${meshId}) stayed parked past ${hours}h with no coordinator decision; failed it (dependents unblocked). This is reported to the coordinator, never a silent drop.`);
        return { entry: failed ?? entry, cascaded, missionAffected: true };
    });
    if (result?.missionAffected) scheduleMissionCloseCandidateCheck(meshId, [result.entry, ...result.cascaded]);
    return result ? result.entry : null;
}

/** Every currently-parked pending task on the mesh (for views + the retention sweep). */
export function getParkedTasks(meshId: string): MeshWorkQueueEntry[] {
    return getQueue(meshId, { status: ['pending'] }).filter(taskIsParked);
}


/**
 * Update the status of the task currently assigned to a specific session.
 */
export function updateSessionTaskStatus(
    meshId: string,
    sessionId: string,
    status: MeshTaskStatus,
    opts?: { occurredAt?: string; taskId?: string; envelope?: MeshTerminalCompletionEnvelope },
): MeshWorkQueueEntry | null {
    const result = withQueueLock(meshId, () => {
        const store = MeshRuntimeStore.getInstance();
        const occurredAtIso = opts?.occurredAt ? new Date(opts.occurredAt).toISOString() : undefined;
        const entry = store.findAssignedBySession(meshId, sessionId, occurredAtIso, opts?.taskId);
        if (!entry) {
            // C2: the silent null here is exactly what stranded a finished task as
            // `assigned` for 19 minutes. If the session still has an assigned row we
            // failed to resolve, surface it loudly instead of dropping the completion.
            const assignedRows = store.getActiveAssignmentDetails(meshId)
                .filter(r => sessionIdsEquivalent(r.sessionId, sessionId));
            if (assignedRows.length > 0) {
                LOG.warn('MeshQueue', `No assigned queue row matched completion for mesh ${meshId} session ${sessionId} `
                    + `(taskId=${opts?.taskId ?? 'none'}, occurredAt=${occurredAtIso ?? 'none'}); `
                    + `${assignedRows.length} assigned row(s) exist: ${assignedRows.map(r => r.id).join(',')}`);
            }
            return null;
        }
        // GRAPH-ORCHESTRATION Phase B (design :311-334): the terminal branch delegates to
        // the single choke point, exactly like updateTaskStatus. markSessionTerminal
        // pre-proposes to the turn reducer BEFORE calling us as its accept/reject gate;
        // the runner's step-1 settle is the idempotent duplicate of that proposal — one
        // logical settle, never a double mutation.
        if (TERMINAL_TASK_STATUSES.has(status)) {
            const commit = commitTaskTerminalAndAdvanceGraph({
                meshId,
                taskId: entry.id,
                status: status as MeshTerminalCommitStatus,
                sessionId,
                occurredAtMs: occurredAtIso ? Date.parse(occurredAtIso) : undefined,
                source: 'provider_event',
                envelope: opts?.envelope,
            });
            const cascaded = DEPENDENCY_FAILURE_TERMINALS.has(status) ? propagateDependencyFailure(meshId, entry.id) : [];
            return { entry: commit.entry ?? entry, cascaded };
        }
        entry.status = status;
        store.updateQueueEntry(entry);
        // The worker reported a terminal/non-assigned outcome — the dispatch is over;
        // release the single-flight mark so the task id can be re-dispatched later.
        if (status !== 'assigned') endTaskDispatchInFlight(meshId, entry.id);
        return { entry, cascaded: [] as MeshWorkQueueEntry[] };
    });
    if (result) scheduleMissionCloseCandidateCheck(meshId, [result.entry, ...result.cascaded]);
    return result ? result.entry : null;
}

/**
 * M1-3: true when at least one pending task is waiting on the given task.
 * Used by the completion event path to decide whether to wake the queue.
 */
export function hasPendingDependents(meshId: string, taskId: string): boolean {
    return MeshRuntimeStore.getInstance().getQueueEntries(meshId, ['pending'])
        .some(entry => Array.isArray(entry.dependsOn) && entry.dependsOn.includes(taskId));
}

/**
 * Return aggregate queue statistics for the given mesh.
 */
export function getMeshQueueStats(meshId: string): MeshWorkQueueStats {
    const rows = MeshRuntimeStore.getInstance().getQueueStatsByStatus(meshId);
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.status] = r.count;
    const pending = counts['pending'] ?? 0;
    const assigned = counts['assigned'] ?? 0;
    const completed = counts['completed'] ?? 0;
    const failed = counts['failed'] ?? 0;
    const cancelled = counts['cancelled'] ?? 0;
    return {
        total: pending + assigned + completed + failed + cancelled,
        active: pending + assigned,
        historical: completed + failed + cancelled,
        pending,
        assigned,
        completed,
        failed,
        cancelled,
        activeCounts: { pending, assigned },
        historicalCounts: { completed, failed, cancelled },
        activeAssignments: MeshRuntimeStore.getInstance().getActiveAssignmentDetails(meshId),
    };
}

export function __replaceMeshQueueForTests(meshId: string, queue: MeshWorkQueueEntry[]): void {
    MeshRuntimeStore.getInstance().transaction(() => {
        MeshRuntimeStore.getInstance().replaceQueue(meshId, queue);
    });
}

export function __clearMeshQueueForTests(meshId: string): void {
    MeshRuntimeStore.getInstance().deleteQueue(meshId);
}

export function __resetMeshRuntimeStoreForTests(): void {
    MeshRuntimeStore.resetForTests();
}

// ── Direct dispatch tracking ──────────────────────────────────────────────────
// Moved to ./mesh-direct-dispatch.ts (FILE-SIZE-HEADROOM). Re-exported so every
// existing `from './mesh-work-queue.js'` import keeps resolving.
export {
    getActiveDirectDispatches,
    cancelDirectDispatchAttempts,
    recordMeshToolCall,
} from './mesh-direct-dispatch.js';
export type { DirectDispatchRecord, SiblingDispatchTerminalizeReason, MeshToolCallRateResult } from './mesh-direct-dispatch.js';

// ── Turn ledger (wiring-unification C2/C3, C-W2) ─────────────────────────────
// `mesh_queue.status` is an EFFECT of a turn commit, never the reverse (C3). The
// two entry points below are what the ledger's in-txn effect host calls; they
// run inside the ledger's transaction on this store's handle (withQueueLock is
// a better-sqlite3 immediate transaction, so it nests as a savepoint).
//
// `TerminalStatusIsLedgerEffect` is the refusal `updateTaskStatus` raises for a
// terminal status (design C3 "updateTaskStatus throws TerminalStatusIsLedgerEffect
// on terminal statuses"). ARMED 2026-09-23 (C-W4): the reconcile/stranded-dispatch
// writers and the queue-claim terminal skip are deleted; a terminal queue status
// is written only by a ledger commit (meshRuntimeTxnHost.graphAdvance) or by the
// explicit cancel/session paths that own their own commit.

/** Refusal: a terminal queue status can only be written by a turn-ledger commit. */
export class TerminalStatusIsLedgerEffect extends Error {
    readonly code = 'terminal_status_is_ledger_effect';
    constructor(readonly meshId: string, readonly taskId: string, readonly status: MeshTaskStatus) {
        super(`mesh_queue ${meshId}/${taskId} → ${status}: terminal queue statuses are an effect of a turn-ledger commit; submit evidence (ledger.observe) instead`);
        this.name = 'TerminalStatusIsLedgerEffect';
    }
}


/** Dependency cascade for a ledger-committed failed/cancelled task (same policy as updateTaskStatus). */
export function propagateLedgerDependencyFailure(meshId: string, taskId: string, status: MeshTaskStatus, reason?: string): MeshWorkQueueEntry[] {
    return DEPENDENCY_FAILURE_TERMINALS.has(status) ? withQueueLock(meshId, () => propagateDependencyFailure(meshId, taskId, reason)) : [];
}

/**
 * The `queue_status: 'pending'` effect of a ledger reclaim (generation + 1):
 * the row goes back to `pending` with its assignment ownership cleared and the
 * dispatch nonce bumped, exactly like reclaimStrandedAssignedTask's requeue
 * branch — minus the budget (the reducer owns RECLAIM_BUDGET) and minus the
 * legacy attempt close (the ledger IS the attempt). A terminal row is never
 * resurrected (CANCEL-STICKY-TERMINAL).
 */
export function requeueTaskForLedgerReclaim(meshId: string, taskId: string, reason: string, nowIso: string): MeshWorkQueueEntry | null {
    return withQueueLock(meshId, () => {
        const store = MeshRuntimeStore.getInstance();
        const entry = store.findQueueEntryById(meshId, taskId);
        if (!entry || TERMINAL_TASK_STATUSES.has(entry.status)) return entry;
        delete entry.assignedNodeId;
        delete entry.assignedSessionId;
        delete entry.assignedProviderType;
        delete entry.assignedModel;
        delete entry.dispatchTimestamp;
        delete entry.autoLaunch;
        delete entry.attemptId;
        entry.dispatchNonce = (entry.dispatchNonce || 0) + 1;
        entry.status = 'pending';
        entry.requeuedAt = nowIso;
        entry.requeueReason = reason;
        entry.updatedAt = nowIso;
        store.updateQueueEntry(entry);
        endTaskDispatchInFlight(meshId, taskId);
        terminalizeSiblingDispatch(meshId, taskId, 'queue_task_stranded_reclaimed');
        return entry;
    });
}

/**
 * DISPATCH-BOOT-RACE backoff for a row the ledger just reclaimed after a
 * dispatch failure (C-W4): bump `dispatchFailureCount` and hold the pending row
 * until the escalating `notBefore`, so the re-claim does not race the same boot
 * window. Queue METADATA only — it never fails the row (the reducer's reclaim
 * budget owns that) and it is a no-op on a non-pending row.
 */
export function applyDispatchFailureBackoff(meshId: string, taskId: string): MeshWorkQueueEntry | null {
    return withQueueLock(meshId, () => {
        const store = MeshRuntimeStore.getInstance();
        const entry = store.findQueueEntryById(meshId, taskId);
        if (!entry || entry.status !== 'pending') return entry;
        const dispatchFailures = (entry.dispatchFailureCount || 0) + 1;
        entry.dispatchFailureCount = dispatchFailures;
        const backoffMs = DISPATCH_RETRY_BACKOFF_BASE_MS * Math.pow(2, dispatchFailures - 1);
        entry.notBefore = resolveNotBefore(Math.min(backoffMs, DISPATCH_RETRY_BACKOFF_MAX_MS));
        entry.updatedAt = new Date().toISOString();
        store.updateQueueEntry(entry);
        return entry;
    });
}
