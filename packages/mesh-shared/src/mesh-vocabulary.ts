/**
 * mesh-vocabulary — the ONE declaration of every mesh enum.
 *
 * Wiring-unification Phase A3 (docs/design/2026-09-23-wiring-unification.md).
 *
 * Before this file `MeshTaskStatus` was declared twice in daemon-core with
 * different members (one carried `in_progress`, which no task row ever held),
 * a third time in `repo-mesh-types.ts`, and loosened to `| string` in web-core;
 * the MCP tool schemas hand-copied the task-mode list six times. Every enum a
 * mesh tool, ledger row, queue entry or dashboard view branches on is declared
 * here once, as a `const` tuple, and the type is derived from it. JSON-schema
 * producers use `enumOf()` so the published schema cannot drift from the code.
 *
 * `MeshTaskDifficulty` / `MESH_TASK_DIFFICULTIES` already live in
 * ./brain-routing.ts and are re-exported here for one-stop discovery.
 */

export { MESH_TASK_DIFFICULTIES, type MeshTaskDifficulty } from './brain-routing'

export const MESH_TASK_STATUSES = ['pending', 'assigned', 'completed', 'failed', 'cancelled'] as const
export type MeshTaskStatus = typeof MESH_TASK_STATUSES[number]

export const MESH_TERMINAL_TASK_STATUSES = ['completed', 'failed', 'cancelled'] as const
export type MeshTerminalTaskStatus = typeof MESH_TERMINAL_TASK_STATUSES[number]

export const MESH_TASK_MODES = ['code_change', 'validation', 'live_debug_readonly', 'launch_app', 'convergence'] as const
export type MeshTaskMode = typeof MESH_TASK_MODES[number]

export const MESH_TASK_PRIORITIES = ['low', 'normal', 'high'] as const
export type MeshTaskPriority = typeof MESH_TASK_PRIORITIES[number]

export const MESH_THINKING_LEVELS = ['low', 'medium', 'high'] as const
export type MeshThinkingLevel = typeof MESH_THINKING_LEVELS[number]

/**
 * How a message is delivered to a session that may be busy.
 *
 *   'when_idle'  — DEFAULT. Never disturbs a running turn; a busy session's task
 *                  is queued and auto-delivered on its next idle transition.
 *   'interrupt'  — Abort the in-flight turn (the provider's own stop control),
 *                  then deliver once the session settles to idle. The name is
 *                  deliberately blunt: the unfinished work is LOST. `immediate`
 *                  was rejected as a name because it reads like a gentle overlay.
 */
export const MESH_DELIVERY_MODES = ['when_idle', 'interrupt'] as const
export type MeshDeliveryMode = typeof MESH_DELIVERY_MODES[number]

/**
 * What to do with a node's sessions when the node is removed or a MAGI fan-out
 * settles. Declared here so daemon-core (`RepoMeshSessionCleanupMode`), the
 * web dashboard picker and the MCP schemas all read one list.
 */
export const MESH_SESSION_CLEANUP_MODES = ['preserve', 'stop', 'delete_stopped', 'stop_and_delete'] as const
export type MeshSessionCleanupMode = typeof MESH_SESSION_CLEANUP_MODES[number]

/** Outcome a delegated worker may report through `report_completion`. */
export const WORKER_REPORT_OUTCOMES = ['completed', 'blocked', 'failed'] as const
export type WorkerReportOutcome = typeof WORKER_REPORT_OUTCOMES[number]

/** Final branch state a worker reports (see coordinator convergence rules). */
export const WORKER_BRANCH_STATES = [
    'merged_to_main',
    'pushed_feature_branch_needs_merge',
    'blocked_review',
    'cleanup_candidate',
    'not_mergeable',
] as const
export type WorkerBranchState = typeof WORKER_BRANCH_STATES[number]

function makeGuard<T extends readonly string[]>(values: T): (value: unknown) => value is T[number] {
    const set: ReadonlySet<string> = new Set(values)
    return (value: unknown): value is T[number] => typeof value === 'string' && set.has(value)
}

export const isMeshTaskStatus = makeGuard(MESH_TASK_STATUSES)
export const isMeshTerminalTaskStatus = makeGuard(MESH_TERMINAL_TASK_STATUSES)
export const isMeshTaskMode = makeGuard(MESH_TASK_MODES)
export const isMeshTaskPriority = makeGuard(MESH_TASK_PRIORITIES)
export const isMeshThinkingLevel = makeGuard(MESH_THINKING_LEVELS)
export const isMeshDeliveryMode = makeGuard(MESH_DELIVERY_MODES)
export const isMeshSessionCleanupMode = makeGuard(MESH_SESSION_CLEANUP_MODES)
export const isWorkerReportOutcome = makeGuard(WORKER_REPORT_OUTCOMES)
export const isWorkerBranchState = makeGuard(WORKER_BRANCH_STATES)

/**
 * JSON-schema fragment for a string enum, derived from the tuple. Use this in
 * every MCP tool schema instead of spelling the member list again.
 */
export function enumOf<T extends readonly string[]>(
    values: T,
    description?: string,
): { type: 'string'; enum: T[number][]; description?: string } {
    return {
        type: 'string',
        enum: [...values] as T[number][],
        ...(description ? { description } : {}),
    }
}
