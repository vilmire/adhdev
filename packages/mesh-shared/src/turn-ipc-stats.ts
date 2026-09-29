/**
 * turn-ipc — task stats and maintenance commands: task_stats_query,
 * prune_stale_direct, orphaned_pin_notify. Part of the turn-ipc wire contract
 * (./turn-ipc.ts).
 */

import {
    TURN_IPC_PROTOCOL_VERSION,
    hasOnlyKeys,
    isOptionalBoolean,
    isOptionalRecord,
    isNonNegativeInt,
    isRecordArray,
} from './turn-ipc-guards';
import { isRecord } from './protocol/envelope';
import { isEvidenceIdentifier } from './turn-evidence';

// ─── task_stats_query ───────────────────────────────────────────────────────
//
// C-W9c: replaces the in-process `computeMeshTaskStats` / `computeMeshMissionStats`
// (daemon-core `mesh-task-stats.ts`) — both scan the daemon's queue + local
// records, so both move behind one command. Exactly one of `taskIds` /
// `missionId` selects the per-task mode; `missionId` alone with `rollup: true`
// additionally returns the mission-level aggregate.

export interface TaskStatsQueryRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    taskIds?: readonly string[]
    missionId?: string
    tail?: number
    /** Also compute `computeMeshMissionStats` — requires `missionId`. */
    rollup?: boolean
    /**
     * Batch rollups: `computeMeshMissionStats` for every id, over ONE queue read and
     * ONE record read (answers `missions`, `tasks` empty). Exclusive with
     * `taskIds`/`missionId`. An older daemon rejects the key.
     */
    missionIds?: readonly string[]
}

export interface TaskStatsQueryResponse {
    /** `MeshTaskStats[]`, JSON passthrough. */
    tasks: readonly Record<string, unknown>[]
    /** `MeshMissionStats`, JSON passthrough; present only when `rollup: true` was requested and satisfiable. */
    mission?: Record<string, unknown>
    /** Batch mode: `MeshMissionStats` per requested mission id, JSON passthrough. */
    missions?: Record<string, Record<string, unknown>>
}

function isTaskStatsQueryRequest(value: unknown): value is TaskStatsQueryRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'taskIds', 'missionId', 'tail', 'rollup', 'missionIds'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION || !isEvidenceIdentifier(value.meshId)) return false
    if (value.taskIds !== undefined) {
        if (!Array.isArray(value.taskIds) || value.taskIds.length === 0 || !value.taskIds.every(isEvidenceIdentifier)) return false
    }
    if (value.missionId !== undefined && !isEvidenceIdentifier(value.missionId)) return false
    if (value.tail !== undefined && !isNonNegativeInt(value.tail)) return false
    if (value.missionIds !== undefined) {
        if (!Array.isArray(value.missionIds) || value.missionIds.length === 0 || !value.missionIds.every(isEvidenceIdentifier)) return false
        if (value.taskIds !== undefined || value.missionId !== undefined) return false
    }
    if (value.rollup === true && value.missionId === undefined) return false
    return isOptionalBoolean(value.rollup)
}

export function decodeTaskStatsQueryRequest(value: unknown): TaskStatsQueryRequest | null {
    return isTaskStatsQueryRequest(value) ? value : null
}

function isTaskStatsQueryResponse(value: unknown): value is TaskStatsQueryResponse {
    return isRecord(value) && hasOnlyKeys(value, ['tasks', 'mission', 'missions']) && isRecordArray(value.tasks) && isOptionalRecord(value.mission)
        && (value.missions === undefined || (isRecord(value.missions) && Object.values(value.missions).every(isRecord)))
}

export function decodeTaskStatsQueryResponse(value: unknown): TaskStatsQueryResponse | null {
    return isTaskStatsQueryResponse(value) ? value : null
}

// ─── prune_stale_direct ─────────────────────────────────────────────────────
//
// C-W9c: replaces the in-process `pruneStaleDirectDispatches` call
// (`mesh_cleanup_sessions` mode=prune_stale_direct, `mesh-tools-session.ts`). Unlike the other
// C-W9 commands this one does NOT take its inputs (queue/records/direct
// dispatches) on the wire — the daemon already reads them itself
// (`getQueue`/`readLocalRecords`/`getActiveDirectDispatches`), so the request
// carries only the decision knobs. `closeDispatches` (the C-W8 `turn_cancel`
// callback) also runs daemon-side now, since it is the same process.

export interface PruneStaleDirectRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    execute?: boolean
    includeTerminal?: boolean
    source?: string
}

export interface PruneStaleDirectResponse {
    mode: 'execute' | 'dry_run'
    includeTerminal: boolean
    candidateCount: number
    /** `MeshActiveWorkRecord[]`, JSON passthrough. */
    prunable: readonly Record<string, unknown>[]
    prunedCount: number
    preservedUnacknowledged: readonly Record<string, unknown>[]
    preservedLedgerOnly: readonly Record<string, unknown>[]
    preservedNotOrphan: readonly Record<string, unknown>[]
}

function isPruneStaleDirectRequest(value: unknown): value is PruneStaleDirectRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'execute', 'includeTerminal', 'source'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION || !isEvidenceIdentifier(value.meshId)) return false
    if (value.source !== undefined && typeof value.source !== 'string') return false
    return isOptionalBoolean(value.execute) && isOptionalBoolean(value.includeTerminal)
}

export function decodePruneStaleDirectRequest(value: unknown): PruneStaleDirectRequest | null {
    return isPruneStaleDirectRequest(value) ? value : null
}

function isPruneStaleDirectResponse(value: unknown): value is PruneStaleDirectResponse {
    if (!isRecord(value) || !hasOnlyKeys(value, ['mode', 'includeTerminal', 'candidateCount', 'prunable', 'prunedCount', 'preservedUnacknowledged', 'preservedLedgerOnly', 'preservedNotOrphan'])) return false
    if (value.mode !== 'execute' && value.mode !== 'dry_run') return false
    if (typeof value.includeTerminal !== 'boolean') return false
    if (!isNonNegativeInt(value.candidateCount) || !isNonNegativeInt(value.prunedCount)) return false
    return isRecordArray(value.prunable) && isRecordArray(value.preservedUnacknowledged)
        && isRecordArray(value.preservedLedgerOnly) && isRecordArray(value.preservedNotOrphan)
}

export function decodePruneStaleDirectResponse(value: unknown): PruneStaleDirectResponse | null {
    return isPruneStaleDirectResponse(value) ? value : null
}

// ─── orphaned_pin_notify ────────────────────────────────────────────────────
//
// C-W9c: replaces the in-process `notifyCoordinatorOfOrphanedPins` call
// (`mesh_queue_cancel` tool, `mesh-tools-queue.ts`, CANCEL-ORPHANS-PINNED-TASK).
// The core reads the daemon's live queue (`getQueue`) and, when it finds
// orphans, calls `notifyMeshCoordinator` to page the coordinator — both are
// daemon-only concerns, so the whole call moves, not just its queue read.
// `title` is a task-message-derived label (first line, truncated) — free text,
// hence local IPC only, same rationale as `record_local`'s payload.

export interface OrphanedPinNotifyRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    stoppedSessionId: string
    excludeTaskId?: string
    cause?: string
    nodeId?: string
    coordinatorSessionId?: string
}

export interface OrphanedPinnedTaskWire {
    taskId: string
    title: string
    targetSessionId: string
    targetNodeId?: string
    missionId?: string
}

export interface OrphanedPinNotifyResponse {
    orphans: readonly OrphanedPinnedTaskWire[]
}

function isOrphanedPinnedTaskWire(value: unknown): value is OrphanedPinnedTaskWire {
    if (!isRecord(value) || !hasOnlyKeys(value, ['taskId', 'title', 'targetSessionId', 'targetNodeId', 'missionId'])) return false
    if (!isEvidenceIdentifier(value.taskId) || !isEvidenceIdentifier(value.targetSessionId)) return false
    if (typeof value.title !== 'string') return false
    if (value.targetNodeId !== undefined && !isEvidenceIdentifier(value.targetNodeId)) return false
    return value.missionId === undefined || isEvidenceIdentifier(value.missionId)
}

function isOrphanedPinNotifyRequest(value: unknown): value is OrphanedPinNotifyRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'stoppedSessionId', 'excludeTaskId', 'cause', 'nodeId', 'coordinatorSessionId'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION || !isEvidenceIdentifier(value.meshId) || !isEvidenceIdentifier(value.stoppedSessionId)) return false
    if (value.excludeTaskId !== undefined && !isEvidenceIdentifier(value.excludeTaskId)) return false
    if (value.cause !== undefined && typeof value.cause !== 'string') return false
    if (value.nodeId !== undefined && !isEvidenceIdentifier(value.nodeId)) return false
    return value.coordinatorSessionId === undefined || isEvidenceIdentifier(value.coordinatorSessionId)
}

export function decodeOrphanedPinNotifyRequest(value: unknown): OrphanedPinNotifyRequest | null {
    return isOrphanedPinNotifyRequest(value) ? value : null
}

function isOrphanedPinNotifyResponse(value: unknown): value is OrphanedPinNotifyResponse {
    return isRecord(value) && hasOnlyKeys(value, ['orphans']) && Array.isArray(value.orphans) && value.orphans.every(isOrphanedPinnedTaskWire)
}

export function decodeOrphanedPinNotifyResponse(value: unknown): OrphanedPinNotifyResponse | null {
    return isOrphanedPinNotifyResponse(value) ? value : null
}
