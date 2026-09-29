// Mesh work-queue writes that create rows: enqueueTask, the atomic task-graph
// enqueue (G5), and recordDirectDispatchTask (the assigned row a direct dispatch
// materialises), with the dependency / difficulty validation they share. Split
// out of mesh-work-queue.ts (re-exported there).

import { readQueue, withQueueLock, scheduleMissionCloseCandidateCheck } from './mesh-work-queue.js';
import {
    type MeshTaskDifficulty,
    MESH_TASK_DIFFICULTIES,
    isMeshTaskDifficulty,
    normalizeOwnedPaths,
    type MeshTaskMode,
} from '@adhdev/mesh-shared';
import type {
    MeshEnqueueTaskOptions,
    MeshQueueMutationOptions,
    MeshWorkQueueEntry,
    MeshTaskGraphEntrySpec,
} from './mesh-work-queue-types.js';
import { requireMeshHostQueueOwner } from './mesh-host-ownership.js';
import { validateMeshTaskModeRequest, buildMeshTaskModeViolationError } from './mesh-task-mode-guardrail.js';
import { randomUUID } from 'crypto';
import { normalizeMeshTaskPriority, resolveNotBefore, MESH_TASK_GRAPH_MAX_TASKS } from './mesh-task-predicates.js';
import { getDifficultyBrains } from '../config/mesh-config.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { normalizeMeshCapabilityTags, resolveConvergeRequiredTags } from './mesh-node-capability-tags.js';

function normalizeDependsOn(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    return value
        .map(id => typeof id === 'string' ? id.trim() : '')
        .filter(Boolean)
        .filter(id => {
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
        });
}

/**
 * M1: detect dependency cycles before enqueue. Walks the dependency graph of
 * existing queue entries plus the new task's edges. Fail-closed: a cycle
 * rejects the enqueue entirely. Synchronous and bounded by queue size.
 */
export function assertNoDependencyCycle(meshId: string, newTaskId: string, dependsOn: string[]): void {
    if (dependsOn.length === 0) return;
    if (dependsOn.includes(newTaskId)) {
        throw new Error(`dependency_cycle_detected: task '${newTaskId}' cannot depend on itself`);
    }
    const adjacency = new Map<string, string[]>();
    for (const entry of readQueue(meshId)) {
        adjacency.set(entry.id, normalizeDependsOn(entry.dependsOn));
    }
    adjacency.set(newTaskId, dependsOn);
    // DFS from the new task: if we can reach newTaskId again, the edges form a cycle.
    const stack = [...dependsOn];
    const visited = new Set<string>();
    while (stack.length > 0) {
        const current = stack.pop()!;
        if (current === newTaskId) {
            throw new Error(`dependency_cycle_detected: task '${newTaskId}' is part of a dependency cycle via '${dependsOn.join(', ')}'`);
        }
        if (visited.has(current)) continue;
        visited.add(current);
        stack.push(...(adjacency.get(current) ?? []));
    }
}

/**
 * DIFFICULTY-REQUIRED: validate the difficulty axis at a task-insertion boundary.
 *
 * Both insertion paths (enqueueTask and recordDirectDispatchTask) call this. It exists
 * as a shared helper precisely because recordDirectDispatchTask bypasses enqueueTask —
 * a guard in only one of them is not a requirement, it is a detour.
 *
 * Two distinct failures, both hard errors:
 *
 *  1. MISSING — the field was not supplied at all. The MCP tool schemas mark difficulty
 *     `required`, but that is nominal: the tool dispatcher forwards raw args without
 *     runtime schema validation (see the DELIVERY-MSG-GUARD notes on `message`, which
 *     needed exactly this same treatment). The enforcement therefore has to live here,
 *     at the store boundary every caller funnels through.
 *
 *  2. UNRECOGNIZED — e.g. 'medum', 'hard'. This previously vanished silently:
 *     `isMeshTaskDifficulty()` returned false and the value was dropped to `undefined`,
 *     so a typo'd task enqueued "successfully" and then routed as though the caller had
 *     never expressed a preference. A misclassified task is worse than a rejected one —
 *     it looks routed and is not — so a bad value is rejected as loudly as a missing one.
 *
 * The message names the offending field and enumerates the allowed values, so a caller
 * (usually an LLM) can correct without reading the source.
 */
function assertMeshTaskDifficulty(value: unknown, callerLabel: string): MeshTaskDifficulty {
    if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
        throw new Error(
            `missing_task_difficulty: ${callerLabel} requires a 'difficulty'. `
            + `Allowed values: ${MESH_TASK_DIFFICULTIES.join(' | ')}. `
            + `Classify the task by how hard the work actually is.`,
        );
    }
    if (!isMeshTaskDifficulty(value)) {
        throw new Error(
            `invalid_task_difficulty: ${callerLabel} received an unrecognized 'difficulty' `
            + `value ${JSON.stringify(value)}. Allowed values: ${MESH_TASK_DIFFICULTIES.join(' | ')}.`,
        );
    }
    return value;
}

/**
 * Add a new task to the mesh queue.
 */
export function enqueueTask(
    meshId: string,
    message: string,
    opts?: MeshEnqueueTaskOptions & MeshQueueMutationOptions,
): MeshWorkQueueEntry {
    requireMeshHostQueueOwner(opts);
    // DELIVERY-MSG-GUARD (upstream defence): a task whose message is undefined /
    // non-string / blank must never reach the queue. Left unchecked it persists a
    // message-less payload that later crashes insertSessionDelivery's NOT NULL at
    // claim/dispatch time (the DB-level `message ?? ''` fallback still exists as
    // depth-in-defence, but silently dispatching an empty prompt is itself a bug).
    // Normalise and hard-reject at the single entry point so no caller can slip a
    // blank task past the schema's nominal `required`.
    message = String(message ?? '').trim();
    if (!message) {
        throw new Error('mesh task message must be a non-empty string');
    }
    const readonly = opts?.readonly === true;
    const modeValidation = validateMeshTaskModeRequest(opts?.taskMode, message, readonly);
    if (!modeValidation.valid) {
        throw new Error(buildMeshTaskModeViolationError(modeValidation));
    }
    const id = typeof opts?.id === 'string' && opts.id.trim() ? opts.id.trim() : randomUUID();
    const dependsOn = normalizeDependsOn(opts?.dependsOn);
    // H1: normalize path ownership once, at the single enqueue choke point (mirrors
    // dependsOn above). An absent/empty declaration stores nothing on the entry —
    // opt-in only, per normalizeOwnedPaths's own backward-compat contract.
    const ownedPathsResult = normalizeOwnedPaths(opts?.ownedPaths);
    const ownedPaths = ownedPathsResult.declaration.paths.length > 0 ? ownedPathsResult.declaration : undefined;
    const priority = normalizeMeshTaskPriority(opts?.priority);
    const notBefore = resolveNotBefore(opts?.notBefore);
    const maxRetries = typeof opts?.maxRetries === 'number' && Number.isFinite(opts.maxRetries) && opts.maxRetries >= 0
        ? Math.floor(opts.maxRetries)
        : undefined;
    // BRAIN-ROUTING: resolve the difficulty preset into effective model / thinking
    // level. An explicit opts.model / opts.thinkingLevel always wins; the preset only
    // fills what the caller left blank. Best-effort — a missing/invalid difficulty or
    // an unconfigured preset just leaves the explicit values (or none) in place.
    let effectiveModel = typeof opts?.model === 'string' && opts.model.trim() ? opts.model.trim() : undefined;
    let effectiveThinkingLevel = typeof opts?.thinkingLevel === 'string' && opts.thinkingLevel.trim() ? opts.thinkingLevel.trim() : undefined;
    // MODEL-SOURCE: record WHO supplied each value so the assignment path can
    // tell a user's choice (never overridden by a slot) from a preset default
    // (a difficulty-matched slot's own model wins over it). A value the caller
    // passed is 'explicit' until proven preset-filled below.
    let modelSource: 'explicit' | 'preset' | undefined = effectiveModel ? 'explicit' : undefined;
    let thinkingLevelSource: 'explicit' | 'preset' | undefined = effectiveThinkingLevel ? 'explicit' : undefined;
    // SLOT-ROUTING: persist the difficulty class on the entry so the scheduler can
    // match it against node capability slots at assignment time (not just resolve
    // model/thinking here). Always present — a missing or unrecognized value is a hard
    // error (see assertMeshTaskDifficulty), so this no longer silently degrades to
    // undefined the way it did when difficulty was optional.
    const taskDifficulty = assertMeshTaskDifficulty(opts?.difficulty, 'enqueueTask');
    try {
        // Scoped to the mesh the task is being enqueued into: these presets pick
        // the MODEL the task runs on, so reading another mesh's map would stamp a
        // model this mesh never chose (and the slot-model guard would then block
        // or wait on it at launch).
        const preset = getDifficultyBrains(meshId)[taskDifficulty];
        if (preset) {
            if (!effectiveModel && preset.model) { effectiveModel = preset.model; modelSource = 'preset'; }
            if (!effectiveThinkingLevel && preset.thinkingLevel) { effectiveThinkingLevel = preset.thinkingLevel; thinkingLevelSource = 'preset'; }
        }
    } catch { /* preset read is best-effort — never block enqueue */ }
    const result = withQueueLock(meshId, () => {
        if (MeshRuntimeStore.getInstance().findQueueEntryById(meshId, id)) {
            throw new Error(`duplicate_task_id: task '${id}' already exists in mesh '${meshId}'`);
        }
        assertNoDependencyCycle(meshId, id, dependsOn);
        const callerTags = normalizeMeshCapabilityTags(opts?.requiredTags);
        // Convergence routing (opt-in): auto-inject converge=refine for code_change
        // tasks so they hard-filter onto refine-capable worktree nodes. No-op unless
        // the mesh opts in; explicit target_node_id / required_tags are preserved.
        // Routing is otherwise governed solely by the caller's required_tags (hard
        // filter through nodeSatisfiesRequiredTags) — no role/taskMode auto-routing.
        const resolvedRequiredTags = resolveConvergeRequiredTags(
            meshId,
            modeValidation.taskMode,
            callerTags,
            { targetNodeId: opts?.targetNodeId },
        );
        const entry: MeshWorkQueueEntry = {
            id,
            meshId,
            message,
            status: 'pending',
            taskMode: modeValidation.taskMode,
            ...(readonly ? { readonly: true } : {}),
            targetNodeId: opts?.targetNodeId,
            targetSessionId: opts?.targetSessionId,
            requiredTags: resolvedRequiredTags,
            ...(ownedPaths ? { ownedPaths } : {}),
            ...(dependsOn.length > 0 ? { dependsOn } : {}),
            // G6: only persist a non-default priority so legacy/normal rows stay minimal.
            ...(priority && priority !== 'normal' ? { priority } : {}),
            // G7: hold-until gate (stored ISO). Omitted when absent/immediate.
            ...(notBefore ? { notBefore } : {}),
            // P3: explicit retry cap. Omitted → requeue path falls back to policy default.
            ...(maxRetries !== undefined ? { maxRetries } : {}),
            ...(typeof opts?.missionId === 'string' && opts.missionId.trim() ? { missionId: opts.missionId.trim() } : {}),
            ...(typeof opts?.consensusGroupId === 'string' && opts.consensusGroupId.trim() ? { consensusGroupId: opts.consensusGroupId.trim() } : {}),
            ...(effectiveModel && modelSource ? { model: effectiveModel, modelSource } : {}),
            ...(effectiveThinkingLevel && thinkingLevelSource ? { thinkingLevel: effectiveThinkingLevel, thinkingLevelSource } : {}),
            difficulty: taskDifficulty,
            ...(typeof opts?.sourceCoordinatorSessionId === 'string' && opts.sourceCoordinatorSessionId.trim()
                ? { sourceCoordinatorSessionId: opts.sourceCoordinatorSessionId.trim() }
                : {}),
            // MESH-IMAGE-DISPATCH: persist the envelope only when it carries parts, so a
            // text-only task's payload is byte-identical to what it was before this field.
            ...(Array.isArray(opts?.input?.parts) && opts.input.parts.length > 0 ? { input: opts.input } : {}),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        MeshRuntimeStore.getInstance().insertQueueEntry(entry);
        return entry;
    });
    // A fresh pending task returns its mission to a non-terminal state — reset any
    // stale close-candidate marker so a later re-completion can nudge again.
    scheduleMissionCloseCandidateCheck(meshId, [result]);
    return result;
}

// G5: MESH_TASK_GRAPH_MAX_TASKS moved to the pure leaf ./mesh-task-predicates.ts (C-W9a); imported above.

/**
 * G5: enqueue a dependency-wired set of tasks ATOMICALLY — either every task in
 * `specs` is inserted or none is. Closes the half-registered-chain failure mode of
 * building a graph via N sequential enqueueTask calls, where a mid-batch error
 * (cycle, invalid difficulty, guardrail violation) left the earlier tasks live.
 *
 * Atomicity rides on the store transaction: the outer withQueueLock opens ONE
 * better-sqlite3 transaction and each inner enqueueTask call nests as a savepoint,
 * so any per-task throw rolls back the whole batch. Per-task validation is NOT
 * duplicated here — every entry goes through the real enqueueTask (message guard,
 * task-mode guardrail, difficulty assert, duplicate-id check, cycle check), so the
 * batch and single-enqueue paths can never drift. Intra-batch cycles are caught by
 * that same per-task assertNoDependencyCycle: ids are pre-generated, so by the time
 * the last member of a cycle inserts, every edge of the cycle is visible to its DFS.
 */
export function enqueueTaskGraph(
    meshId: string,
    specs: MeshTaskGraphEntrySpec[],
    opts?: MeshQueueMutationOptions,
): MeshWorkQueueEntry[] {
    requireMeshHostQueueOwner(opts);
    if (!Array.isArray(specs) || specs.length === 0) {
        throw new Error('empty_task_graph: enqueueTaskGraph requires at least one task spec');
    }
    if (specs.length > MESH_TASK_GRAPH_MAX_TASKS) {
        throw new Error(`task_graph_too_large: ${specs.length} tasks exceeds the ${MESH_TASK_GRAPH_MAX_TASKS}-task cap for one atomic enqueue`);
    }
    // Pre-generate every task id up front so refs resolve regardless of array order.
    const ids = specs.map(() => randomUUID());
    const idByRef = new Map<string, string>();
    specs.forEach((spec, i) => {
        const ref = typeof spec.ref === 'string' ? spec.ref.trim() : '';
        if (!ref) return;
        if (idByRef.has(ref)) {
            throw new Error(`duplicate_task_ref: ref '${ref}' is used by more than one task in this batch`);
        }
        idByRef.set(ref, ids[i]);
    });
    const store = MeshRuntimeStore.getInstance();
    return withQueueLock(meshId, () => {
        const inserted: MeshWorkQueueEntry[] = [];
        specs.forEach((spec, i) => {
            const { ref, message, ...taskOpts } = spec;
            const label = ref ? `'${ref}'` : `#${i}`;
            // A batch ref shadows a same-string existing task id (refs are short
            // human labels, ids are UUIDs/template ids — a collision is a ref).
            const dependsOn = normalizeDependsOn(spec.dependsOn).map(dep => {
                const mapped = idByRef.get(dep);
                if (mapped) return mapped;
                if (store.findQueueEntryById(meshId, dep)) return dep;
                throw new Error(
                    `unknown_dependency: task ${label} depends on '${dep}', which is neither a ref in this batch nor an existing task id`
                    + (idByRef.size ? ` (batch refs: ${[...idByRef.keys()].join(', ')})` : ''),
                );
            });
            inserted.push(enqueueTask(meshId, message, {
                ...taskOpts,
                dependsOn,
                id: ids[i],
                ...(opts?.ownerRole ? { ownerRole: opts.ownerRole } : {}),
            }));
        });
        return inserted;
    });
}

/**
 * Record a direct-dispatch task (mesh_send_task) as an already-assigned queue
 * entry so it is attributable to a mission.
 *
 * Direct dispatch normally bypasses the queue entirely — the task lives only in
 * the ledger + the legacy direct-dispatch table, neither of which carries a
 * missionId, so {@link summarizeMissionTasks}/{@link computeMeshTaskStats}
 * (which both scan the queue for `task.missionId`) count it as 0. When a
 * mission is attached, we materialise the same queue entry shape an enqueued
 * task would have, but pre-assigned to the dispatched node/session and stamped
 * with the dispatch timestamp. The terminal event path (updateSessionTaskStatus
 * → findAssignedBySession) then flips it to completed/failed exactly like a
 * pulled task, so mission total + completed aggregates work with no extra wiring.
 *
 * Intentionally separate from {@link enqueueTask}: enqueue creates `pending`
 * work for the queue to assign, whereas this records work already dispatched
 * out-of-band. They share the mode validation; missionId is stamped when present.
 *
 * MISSIONLESS-DIRECT-DISPATCH-NO-ATTEMPT: `missionId` is deliberately OPTIONAL.
 * It once gated this whole function, because the function's only job was mission
 * ATTRIBUTION. The delivery record and the attempt correlation below have nothing
 * to do with missions and must not inherit that gate — a `mesh_send_task` without
 * a mission once lost both terminal-state convergence and redrive protection.
 * (C-W8: the attempt itself is the turn ledger's `mesh_direct` attempt, opened by
 * the caller; see the note at the stamp below.)
 */
export function recordDirectDispatchTask(
    meshId: string,
    message: string,
    opts: {
        id: string;
        /** Optional: stamped for mission attribution when present. Never gates
         *  attempt-opening or delivery recording — see the note above. */
        missionId?: string;
        assignedNodeId?: string;
        assignedSessionId?: string;
        taskMode?: MeshTaskMode | string;
        /** QUEUE-NODE-SERIALIZATION: explicit read-only axis (orthogonal to taskMode). */
        readonly?: boolean;
        /**
         * DIFFICULTY-REQUIRED: task execution difficulty, same fixed axis as
         * {@link enqueueTask}. A direct dispatch has ALREADY picked its node+session, so
         * unlike the queue path this value never routes anything — it is recorded so the
         * task row carries the same axis a queued task does. That matters concretely for
         * failure recovery: the relaunch path re-reads the difficulty off the ledger's
         * task_dispatched entry, so an unclassified direct dispatch would silently
         * downgrade its own retry to no-difficulty routing. Required — see the guard below.
         */
        difficulty?: string;
        /**
         * H1 (path ownership): same raw-input shape and semantics as
         * {@link MeshEnqueueTaskOptions.ownedPaths}. A direct dispatch already targets a
         * specific node/session, so this is recorded for the same code_change overlap
         * check against OTHER in-flight tasks (queued or direct) sharing this node, and
         * for the report_completion.touched_files comparison — never a routing input.
         */
        ownedPaths?: string[];
        dispatchedAt?: string;
        /**
         * C2/C-W7: the attempt this dispatch delivers, opened by the CALLER before
         * this is invoked (mcp-server's `openDirectDispatchAttempt` → `turn_observe`
         * IPC, `dispatch_accepted`/`scope:'mesh_direct'` — C-W6c). This function no
         * longer opens the attempt itself (the legacy `openTurnAttempt`/
         * `recordTurnAck` Stage-5 reducer calls are retired); it only stamps the
         * already-open attempt id on the materialised row so the worker's evidence
         * and this task correlate. Absent when the caller could not open one
         * (turn ledger not yet armed) — the row still materialises, uncorrelated,
         * exactly like the pre-ledger fallback.
         */
        attemptId?: string;
    },
): MeshWorkQueueEntry | null {
    // A missing missionId only means "not attributable to a mission" — it must not
    // skip the row or the attempt correlation (see the note above).
    const missionId = typeof opts.missionId === 'string' ? opts.missionId.trim() : '';
    const taskId = typeof opts.id === 'string' ? opts.id.trim() : '';
    if (!taskId) return null;
    // DELIVERY-MSG-GUARD (upstream defence): the direct-dispatch path materialises the
    // same message-carrying queue entry, so a blank/undefined message would hit the same
    // NOT NULL crash. Normalise and hard-reject before we record anything — consistent
    // with enqueueTask.
    message = String(message ?? '').trim();
    if (!message) {
        throw new Error('mesh task message must be a non-empty string');
    }
    // DIFFICULTY-REQUIRED: recordDirectDispatchTask writes to the store WITHOUT going
    // through enqueueTask, so enqueueTask's guard does not cover it — the two insertion
    // paths must each enforce this or the requirement is trivially bypassable by using
    // mesh_send_task instead of mesh_enqueue_task.
    const taskDifficulty = assertMeshTaskDifficulty(opts.difficulty, 'recordDirectDispatchTask');
    const readonly = opts.readonly === true;
    const modeValidation = validateMeshTaskModeRequest(opts.taskMode, message, readonly);
    if (!modeValidation.valid) {
        throw new Error(buildMeshTaskModeViolationError(modeValidation));
    }
    const now = opts.dispatchedAt && opts.dispatchedAt.trim() ? opts.dispatchedAt : new Date().toISOString();
    // H1: same normalization as enqueueTask (see the note on MeshEnqueueTaskOptions.ownedPaths).
    const directOwnedPathsResult = normalizeOwnedPaths(opts.ownedPaths);
    const directOwnedPaths = directOwnedPathsResult.declaration.paths.length > 0 ? directOwnedPathsResult.declaration : undefined;
    return withQueueLock(meshId, () => {
        if (MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId)) {
            // Already materialised (e.g. retry of the same dispatch) — leave it untouched.
            return null;
        }
        const entry: MeshWorkQueueEntry = {
            id: taskId,
            meshId,
            message,
            status: 'assigned',
            ...(modeValidation.taskMode ? { taskMode: modeValidation.taskMode } : {}),
            ...(readonly ? { readonly: true } : {}),
            ...(missionId ? { missionId } : {}),
            ...(directOwnedPaths ? { ownedPaths: directOwnedPaths } : {}),
            difficulty: taskDifficulty,
            ...(opts.assignedNodeId ? { targetNodeId: opts.assignedNodeId, assignedNodeId: opts.assignedNodeId } : {}),
            ...(opts.assignedSessionId ? { targetSessionId: opts.assignedSessionId, assignedSessionId: opts.assignedSessionId } : {}),
            dispatchTimestamp: now,
            createdAt: now,
            updatedAt: now,
        };
        MeshRuntimeStore.getInstance().insertQueueEntry(entry);
        // C2/C-W8: the attempt this dispatch delivers lives on the TURN LEDGER
        // (`turn_attempts`, scope `mesh_direct`), opened by the caller before
        // this runs (mcp-server `openDirectDispatchAttempt` → `turn_observe`
        // `dispatch_accepted`). Stage 6 presentation reads that table, and the
        // worker-MCP token is minted daemon-side when the ledger opens the
        // attempt (turn-ledger-ipc `turn_observe`), so this row only carries the
        // attempt id for correlation. Absent when the ledger could not open one —
        // the row still materialises, uncorrelated.
        if (opts.attemptId) {
            entry.attemptId = opts.attemptId;
            MeshRuntimeStore.getInstance().updateQueueEntry(entry);
        }
        // (C-W8) The confirmed-delivery record is the turn ledger attempt's
        // `delivered` evidence (mcp-server `recordDirectDispatchEvidence` after the
        // transport confirmed the send) — the legacy session-delivery table row
        // this block used to write is retired with its table.
        // NOTE (LEDGER-TASK-TRACEABILITY A): the direct-dispatch (mesh_send_task) path
        // appends its own task_dispatched ledger entry at the MCP layer (mesh-tools-session.ts
        // via buildDirectTaskPayload → routingDecision source:'direct') BEFORE calling this.
        // Do NOT append task_dispatched here — it would double-record the same dispatch.
        return entry;
    });
}
