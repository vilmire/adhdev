/**
 * turn-ipc — graph gates, task stats and maintenance commands: graph_gate_claim,
 * graph_gate_release, graph_gate_abandon, graph_node_patch, graph_view_query,
 * task_stats_query, prune_stale_direct, orphaned_pin_notify. Part of the turn-ipc
 * wire contract (./turn-ipc.ts).
 */

import {
    TURN_IPC_PROTOCOL_VERSION,
    hasOnlyKeys,
    isFiniteNumber,
    isOptionalBoolean,
    isOptionalRecord,
    isNonNegativeInt,
    isOptionalString,
    isRecordArray,
} from './turn-ipc-guards';
import { isRecord } from './protocol/envelope';
import { isEvidenceIdentifier } from './turn-evidence';

// ─── graph_gate_claim / graph_gate_release / graph_gate_abandon / graph_node_patch / graph_view_query ──
//
// Wiring-unification Phase C, workstream C-W9c (2026-09-24 19:00 stamp
// "mcp-server graph gates/plan/patch ... still call daemon-core in-process").
//
// `mesh-tools-graph.ts`'s five graph-orchestration tools (the gate claim
// / release / abandon verbs, now `mesh_graph_gate`, `mesh_graph_node_patch`, `mesh_graph_view`) called
// daemon-core's MeshRuntimeStore-backed graph module in-process
// (`claimMeshGraphGate` / `releaseMeshGraphGate` / `abandonMeshGraphGate` /
// `patchGraphNodeAndRetry` / `buildMeshGraphViews`, all in `mesh-graph-gates.ts` /
// `mesh-graph-transition-runner.ts` / `mesh-graph-view.ts`), plus the read-only
// git-based `collectGateConvergenceEvidence` probe. These five commands move
// every one of those calls into the daemon that owns the graph rows.
//
// CONTENT BOUNDARY: a gate/node-patch result is exposed to the CALLER as
// identifiers, enums, counts and a `result`/`evidence`/`patches` passthrough
// the coordinator itself supplied on the request (release/patch echo back only
// what they were given) — never anything the daemon derives from chat content.
// `MeshGraphGateRow` / `MeshGraphView` are large, evolving daemon-core shapes;
// rather than duplicate their structure here (the same risk `active_work_query`'s
// `activeWork` avoided), the gate/graph payload is a JSON passthrough
// (`Record<string, unknown>`), exactly like `ActiveWorkQueryResponse.activeWork`.

export interface GraphGateClaimRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    gateId: string
    coordinatorSessionId: string
    leaseSeconds?: number
    extendDeadlineSeconds?: number
    /** Also collect `collectGateConvergenceEvidence` on a successful claim (mesh_graph_gate action=claim's own behavior). */
    probeConvergenceEvidence?: boolean
}

export interface GraphGateClaimResponse {
    claimed: boolean
    /** gate_not_found / gate_not_eligible / gate_not_awaiting / gate_lease_held / gate_claim_race / gate_terminal:<state> / gate_not_claimable, when `claimed: false`. */
    reason?: string
    /** `MeshGraphGateRow`, JSON passthrough; present whenever the core found the gate. */
    gate?: Record<string, unknown>
    leaseGeneration?: number
    fencingToken?: string
    leaseExpiresAt?: string
    deadlineAt?: string
    ambiguousExternalOutcome?: boolean
    previousLeaseOwnerSessionId?: string
    /** `GateConvergenceEvidence`, JSON passthrough; present only when requested and found. */
    convergenceEvidence?: Record<string, unknown>
}

function isGraphGateClaimRequest(value: unknown): value is GraphGateClaimRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'gateId', 'coordinatorSessionId', 'leaseSeconds', 'extendDeadlineSeconds', 'probeConvergenceEvidence'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION || !isEvidenceIdentifier(value.meshId) || !isEvidenceIdentifier(value.gateId) || !isEvidenceIdentifier(value.coordinatorSessionId)) return false
    if (value.leaseSeconds !== undefined && !isFiniteNumber(value.leaseSeconds)) return false
    if (value.extendDeadlineSeconds !== undefined && !isFiniteNumber(value.extendDeadlineSeconds)) return false
    return isOptionalBoolean(value.probeConvergenceEvidence)
}

export function decodeGraphGateClaimRequest(value: unknown): GraphGateClaimRequest | null {
    return isGraphGateClaimRequest(value) ? value : null
}

function isGraphGateClaimResponse(value: unknown): value is GraphGateClaimResponse {
    if (!isRecord(value) || !hasOnlyKeys(value, ['claimed', 'reason', 'gate', 'leaseGeneration', 'fencingToken', 'leaseExpiresAt', 'deadlineAt', 'ambiguousExternalOutcome', 'previousLeaseOwnerSessionId', 'convergenceEvidence'])) return false
    if (typeof value.claimed !== 'boolean') return false
    return isOptionalRecord(value.gate) && isOptionalRecord(value.convergenceEvidence) && isOptionalBoolean(value.ambiguousExternalOutcome)
}

export function decodeGraphGateClaimResponse(value: unknown): GraphGateClaimResponse | null {
    return isGraphGateClaimResponse(value) ? value : null
}

export interface GraphGateReleaseRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    gateId: string
    fencingToken: string
    leaseGeneration: number
    idempotencyKey: string
    outcome: string
    /** Action-specific structured result/evidence the CALLER supplied — JSON passthrough, echoed back unmodified. */
    result?: unknown
    evidence?: unknown
    patches?: readonly { node: string, baseSpecPatch: Record<string, unknown> }[]
}

// `releaseMeshGraphGate` THROWS for every rejection (its whole transaction must
// roll back — mesh-graph-gates.ts file header). The daemon handler catches
// that and reports it as a RESULT, not an IPC-level failure (the same
// success:true-carries-a-refusal shape `queue_enqueue_graph` already uses) —
// `mesh_graph_gate` action=release's tool layer classifies `refusalCode` by prefix
// exactly as it did the in-process thrown message.
export type GraphGateReleaseResponse =
    | {
        released: true
        duplicate: boolean
        gate?: Record<string, unknown>
        materializedNodeIds: readonly string[]
        downstreamNodeCount?: number
        graphCompleted?: boolean
    }
    | { released: false, refusalCode?: string, message: string }

function isGraphGateReleaseRequest(value: unknown): value is GraphGateReleaseRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'gateId', 'fencingToken', 'leaseGeneration', 'idempotencyKey', 'outcome', 'result', 'evidence', 'patches'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION || !isEvidenceIdentifier(value.meshId) || !isEvidenceIdentifier(value.gateId)) return false
    if (typeof value.fencingToken !== 'string' || !value.fencingToken) return false
    if (!isFiniteNumber(value.leaseGeneration)) return false
    if (typeof value.idempotencyKey !== 'string' || !value.idempotencyKey) return false
    if (typeof value.outcome !== 'string' || !value.outcome) return false
    if (value.patches !== undefined) {
        if (!Array.isArray(value.patches)) return false
        for (const p of value.patches) {
            if (!isRecord(p) || typeof p.node !== 'string' || !p.node || !isRecord(p.baseSpecPatch)) return false
        }
    }
    return true
}

export function decodeGraphGateReleaseRequest(value: unknown): GraphGateReleaseRequest | null {
    return isGraphGateReleaseRequest(value) ? value : null
}

function isGraphGateReleaseResponse(value: unknown): value is GraphGateReleaseResponse {
    if (!isRecord(value)) return false
    if (value.released === true) {
        if (!hasOnlyKeys(value, ['released', 'duplicate', 'gate', 'materializedNodeIds', 'downstreamNodeCount', 'graphCompleted'])) return false
        if (typeof value.duplicate !== 'boolean') return false
        if (!Array.isArray(value.materializedNodeIds) || !value.materializedNodeIds.every((n) => typeof n === 'string')) return false
        if (value.downstreamNodeCount !== undefined && !isNonNegativeInt(value.downstreamNodeCount)) return false
        return isOptionalRecord(value.gate) && isOptionalBoolean(value.graphCompleted)
    }
    if (value.released === false) {
        return hasOnlyKeys(value, ['released', 'refusalCode', 'message']) && typeof value.message === 'string' && isOptionalString(value.refusalCode)
    }
    return false
}

export function decodeGraphGateReleaseResponse(value: unknown): GraphGateReleaseResponse | null {
    return isGraphGateReleaseResponse(value) ? value : null
}

export interface GraphGateAbandonRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    gateId: string
    reason: string
    coordinatorSessionId?: string
    force?: boolean
}

export interface GraphGateAbandonResponse {
    abandoned: boolean
    /** gate_not_found / gate_lease_held / gate_abandon_race / gate_terminal:<state> / gate_not_abandonable, when `abandoned: false`. */
    reason?: string
    gate?: Record<string, unknown>
    cancelledNodeIds: readonly string[]
    cancelledTaskIds: readonly string[]
    graphStatus?: string
}

function isGraphGateAbandonRequest(value: unknown): value is GraphGateAbandonRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'gateId', 'reason', 'coordinatorSessionId', 'force'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION || !isEvidenceIdentifier(value.meshId) || !isEvidenceIdentifier(value.gateId)) return false
    if (typeof value.reason !== 'string' || !value.reason) return false
    if (value.coordinatorSessionId !== undefined && !isEvidenceIdentifier(value.coordinatorSessionId)) return false
    return isOptionalBoolean(value.force)
}

export function decodeGraphGateAbandonRequest(value: unknown): GraphGateAbandonRequest | null {
    return isGraphGateAbandonRequest(value) ? value : null
}

function isGraphGateAbandonResponse(value: unknown): value is GraphGateAbandonResponse {
    if (!isRecord(value) || !hasOnlyKeys(value, ['abandoned', 'reason', 'gate', 'cancelledNodeIds', 'cancelledTaskIds', 'graphStatus'])) return false
    if (typeof value.abandoned !== 'boolean') return false
    if (!Array.isArray(value.cancelledNodeIds) || !value.cancelledNodeIds.every((n) => typeof n === 'string')) return false
    if (!Array.isArray(value.cancelledTaskIds) || !value.cancelledTaskIds.every((n) => typeof n === 'string')) return false
    return isOptionalRecord(value.gate)
}

export function decodeGraphGateAbandonResponse(value: unknown): GraphGateAbandonResponse | null {
    return isGraphGateAbandonResponse(value) ? value : null
}

export interface GraphNodePatchRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    node: string
    graphId?: string
    /** Only {@link MESH_NODE_PATCH_KEYS}-shaped keys are permitted; the daemon enforces the allow-list. */
    baseSpecPatch: Record<string, unknown>
}

// `patchGraphNodeAndRetry` THROWS for every rejection (mesh-graph-transition-runner.ts) —
// same released:false treatment as `GraphGateReleaseResponse` above.
export type GraphNodePatchResponse =
    | {
        patched: true
        graphId: string
        nodeId: string
        ref?: string
        queueTaskId?: string
        materializationVersion: number
        state: string
        /** `SettleOutcome['kind']` — materialized / deferred / skipped / error. */
        outcomeKind: string
        /** Present when `outcomeKind === 'skipped'`. */
        skippedReason?: string
        blockedReason?: string
    }
    | { patched: false, refusalCode?: string, message: string }

function isGraphNodePatchRequest(value: unknown): value is GraphNodePatchRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'node', 'graphId', 'baseSpecPatch'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION || !isEvidenceIdentifier(value.meshId)) return false
    if (typeof value.node !== 'string' || !value.node) return false
    if (value.graphId !== undefined && !isEvidenceIdentifier(value.graphId)) return false
    return isRecord(value.baseSpecPatch) && Object.keys(value.baseSpecPatch).length > 0
}

export function decodeGraphNodePatchRequest(value: unknown): GraphNodePatchRequest | null {
    return isGraphNodePatchRequest(value) ? value : null
}

function isGraphNodePatchResponse(value: unknown): value is GraphNodePatchResponse {
    if (!isRecord(value)) return false
    if (value.patched === true) {
        if (!hasOnlyKeys(value, ['patched', 'graphId', 'nodeId', 'ref', 'queueTaskId', 'materializationVersion', 'state', 'outcomeKind', 'skippedReason', 'blockedReason'])) return false
        if (!isEvidenceIdentifier(value.graphId) || !isEvidenceIdentifier(value.nodeId)) return false
        if (!isNonNegativeInt(value.materializationVersion)) return false
        return typeof value.state === 'string' && typeof value.outcomeKind === 'string'
    }
    if (value.patched === false) {
        return hasOnlyKeys(value, ['patched', 'refusalCode', 'message']) && typeof value.message === 'string' && isOptionalString(value.refusalCode)
    }
    return false
}

export function decodeGraphNodePatchResponse(value: unknown): GraphNodePatchResponse | null {
    return isGraphNodePatchResponse(value) ? value : null
}

export interface GraphViewQueryRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    graphId?: string
    batchId?: string
    /** Default true: only graphs that still need attention. */
    activeOnly?: boolean
    limit?: number
    /** Attach `collectGateConvergenceEvidence` to the first few waiting gates (mesh_graph_view's G4 opt-in probe). */
    probeGateEvidence?: boolean
}

export interface GraphViewQueryResponse {
    /** `MeshGraphView[]`, JSON passthrough — see this section's content-boundary note. */
    graphs: readonly Record<string, unknown>[]
}

export function isGraphViewQueryRequest(value: unknown): value is GraphViewQueryRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'graphId', 'batchId', 'activeOnly', 'limit', 'probeGateEvidence'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION || !isEvidenceIdentifier(value.meshId)) return false
    if (value.graphId !== undefined && !isEvidenceIdentifier(value.graphId)) return false
    if (value.batchId !== undefined && !isEvidenceIdentifier(value.batchId)) return false
    if (value.limit !== undefined && !isNonNegativeInt(value.limit)) return false
    return isOptionalBoolean(value.activeOnly) && isOptionalBoolean(value.probeGateEvidence)
}

export function decodeGraphViewQueryRequest(value: unknown): GraphViewQueryRequest | null {
    return isGraphViewQueryRequest(value) ? value : null
}

function isGraphViewQueryResponse(value: unknown): value is GraphViewQueryResponse {
    return isRecord(value) && hasOnlyKeys(value, ['graphs']) && isRecordArray(value.graphs)
}

export function decodeGraphViewQueryResponse(value: unknown): GraphViewQueryResponse | null {
    return isGraphViewQueryResponse(value) ? value : null
}

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
