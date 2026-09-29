/**
 * turn-ipc — local records, queue composites and active work (C-W9a):
 * record_local, queue_query, queue_enqueue, queue_enqueue_graph, queue_cancel,
 * queue_requeue, direct_dispatch_record, graph_audit_record, active_work_query,
 * recovery_context_query. Part of the turn-ipc wire contract (./turn-ipc.ts).
 */

// ─── C-W9a: local records, queue composites, active work ────────────────────
//
// Wiring-unification Phase C, workstream C-W9a (the 2026-09-24 14:00 stamp
// "Left for C-W9"): the event ledger and its JSONL mirror are gone, and every
// mcp-server call that still reached the daemon's `mesh-runtime.db` in-process
// — record appends, queue mutations, the queue/active-work reads that fed
// `buildMeshActiveWork`, recovery hints — moves behind the commands below,
// executed in the daemon that owns the store.
//
// CONTENT BOUNDARY: like `mission_upsert`'s `goal`, `note_upsert`'s `text` and
// `ledger_query`'s entry payloads, several fields here are free text or
// unbounded JSON (a task message, a MAGI synthesis, a queue row with its
// message, an active-work record with its task summary). This is fine for the
// same reason: local IPC between the mcp-server and the daemon on the
// operator's own machine — never a cross-machine or server hop. Those fields
// are documented as passthroughs and validated only for shape (object/array),
// exactly like `LedgerQueryEntryWire.payload`. Nothing here is ever published
// to a topic: `record_local`'s topic leg is the daemon's `mesh.record`
// allow-list projection, which drops free text by construction.

import { isRecord } from './protocol/envelope';
import { isEvidenceIdentifier } from './turn-evidence';
import {
    TURN_IPC_PROTOCOL_VERSION,
    hasOnlyKeys,
    isOptionalId,
    isNonNegativeInt,
    isOptionalBoolean,
    isOptionalRecord,
    isRecordArray,
    isOptionalString,
    makeGuard,
} from './turn-ipc-guards';

/** A queue row as the daemon's `getQueue` returns it — a JSON passthrough (see the section note). */
export type QueueEntryWire = Record<string, unknown> & { id: string; status: string }

function isQueueEntryWire(value: unknown): value is QueueEntryWire {
    return isRecord(value) && isEvidenceIdentifier(value.id) && typeof value.status === 'string'
}

// ── record_local ──
//
// `meshRecord(meshId, kind, scalars, { local: true })` over IPC: the scalar
// projection goes to `mesh.<id>.events` (content-free), the FULL payload lands
// in the daemon's `mesh_local_records` (local-only). Replaces every mcp-server
// `appendLedgerEntry` (dispatch / MAGI question+synthesis / checkpoint message /
// reconcile records). `payload` is free-form JSON (see the section note).

export interface RecordLocalRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    /** A `MeshLedgerKind` (daemon-core); an identifier here (mesh-shared cannot import that union). */
    kind: string
    nodeId?: string
    sessionId?: string
    providerType?: string
    taskId?: string
    payload: Record<string, unknown>
}

export interface RecordLocalResponse {
    eventId: string
    timestamp: string
    storedLocally: boolean
    published: boolean
}

function isRecordLocalRequest(value: unknown): value is RecordLocalRequest {
    return isRecord(value) && hasOnlyKeys(value, ['v', 'meshId', 'kind', 'nodeId', 'sessionId', 'providerType', 'taskId', 'payload'])
        && value.v === TURN_IPC_PROTOCOL_VERSION
        && isEvidenceIdentifier(value.meshId)
        && isEvidenceIdentifier(value.kind)
        && isOptionalId(value.nodeId) && isOptionalId(value.sessionId) && isOptionalId(value.providerType) && isOptionalId(value.taskId)
        && isRecord(value.payload)
}

export function decodeRecordLocalRequest(value: unknown): RecordLocalRequest | null {
    return isRecordLocalRequest(value) ? value : null
}

function isRecordLocalResponse(value: unknown): value is RecordLocalResponse {
    return isRecord(value) && hasOnlyKeys(value, ['eventId', 'timestamp', 'storedLocally', 'published'])
        && isEvidenceIdentifier(value.eventId) && typeof value.timestamp === 'string'
        && typeof value.storedLocally === 'boolean' && typeof value.published === 'boolean'
}

export function decodeRecordLocalResponse(value: unknown): RecordLocalResponse | null {
    return isRecordLocalResponse(value) ? value : null
}

// ── queue_query ──

export interface QueueQueryRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    /** Status filter (queue statuses); omitted = every row. */
    statuses?: readonly string[]
    /** One row by id (returns 0 or 1 entries). */
    taskId?: string
    /** Project for a VIEW surface: the persisted input envelope → `inputSummary` (summarizeQueueEntryInputForView). */
    view?: boolean
    /**
     * Also return the per-status row counts of the WHOLE mesh queue (columns only,
     * no payload parse) — lets a view read only the rows it shows yet report
     * mesh-wide counts. An older daemon rejects the key.
     */
    withCounts?: boolean
    /** With `withCounts`: also count terminal rows whose `updated_at` is older than this age. */
    historicalOlderThanMs?: number
    /**
     * Also return `dependencyHeads`: id/status/blockedReason/cancelReason of every
     * row the returned entries list in `dependsOn` that is not itself returned —
     * enough to annotate dependency state without reading the whole queue.
     */
    withDependencyHeads?: boolean
}

/** A dependency row reduced to the fields dependency-state annotation reads. */
export interface QueueDependencyHeadWire {
    id: string
    status: string
    blockedReason?: string
    cancelReason?: string
}

export interface QueueQueryResponse {
    entries: readonly QueueEntryWire[]
    /** `withCounts`: row count per status over the whole mesh queue. */
    counts?: Record<string, number>
    /** `withCounts` + `historicalOlderThanMs`: terminal rows older than that age. */
    oldHistoricalCount?: number
    /** `withDependencyHeads`. */
    dependencyHeads?: readonly QueueDependencyHeadWire[]
}

function isQueueQueryRequest(value: unknown): value is QueueQueryRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'statuses', 'taskId', 'view', 'withCounts', 'historicalOlderThanMs', 'withDependencyHeads'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION || !isEvidenceIdentifier(value.meshId)) return false
    if (value.statuses !== undefined && (!Array.isArray(value.statuses) || !value.statuses.every(isEvidenceIdentifier))) return false
    if (value.historicalOlderThanMs !== undefined && !isNonNegativeInt(value.historicalOlderThanMs)) return false
    return isOptionalId(value.taskId) && isOptionalBoolean(value.view)
        && isOptionalBoolean(value.withCounts) && isOptionalBoolean(value.withDependencyHeads)
}

export function decodeQueueQueryRequest(value: unknown): QueueQueryRequest | null {
    return isQueueQueryRequest(value) ? value : null
}

function isQueueDependencyHeadWire(value: unknown): value is QueueDependencyHeadWire {
    return isRecord(value) && hasOnlyKeys(value, ['id', 'status', 'blockedReason', 'cancelReason'])
        && typeof value.id === 'string' && typeof value.status === 'string'
        && (value.blockedReason === undefined || typeof value.blockedReason === 'string')
        && (value.cancelReason === undefined || typeof value.cancelReason === 'string')
}

function isQueueQueryResponse(value: unknown): value is QueueQueryResponse {
    if (!isRecord(value) || !hasOnlyKeys(value, ['entries', 'counts', 'oldHistoricalCount', 'dependencyHeads'])) return false
    if (!Array.isArray(value.entries) || !value.entries.every(isQueueEntryWire)) return false
    if (value.counts !== undefined && (!isRecord(value.counts) || !Object.values(value.counts).every(isNonNegativeInt))) return false
    if (value.oldHistoricalCount !== undefined && !isNonNegativeInt(value.oldHistoricalCount)) return false
    if (value.dependencyHeads !== undefined && (!Array.isArray(value.dependencyHeads) || !value.dependencyHeads.every(isQueueDependencyHeadWire))) return false
    return true
}

export function decodeQueueQueryResponse(value: unknown): QueueQueryResponse | null {
    return isQueueQueryResponse(value) ? value : null
}

// ── queue_enqueue ──
//
// `enqueueTask(meshId, message, options)` + (when `decision` is given) the
// single-surface `recordSingleEnqueueDecision` for the new task id, in the
// daemon. `options` is `MeshEnqueueTaskOptions` (daemon-core) as a JSON
// passthrough; the daemon's enqueue guards (message, task-mode, difficulty,
// dependency cycle) run unchanged and a refusal comes back as the error.

export interface QueueEnqueueRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    /** Free text (the task message — see the section note). */
    message: string
    options?: Record<string, unknown>
    /** `recordSingleEnqueueDecision` args minus `taskId` (the daemon fills it). */
    decision?: Record<string, unknown>
}

export interface QueueEnqueueResponse {
    entry: QueueEntryWire
}

function isQueueEnqueueRequest(value: unknown): value is QueueEnqueueRequest {
    return isRecord(value) && hasOnlyKeys(value, ['v', 'meshId', 'message', 'options', 'decision'])
        && value.v === TURN_IPC_PROTOCOL_VERSION && isEvidenceIdentifier(value.meshId)
        && typeof value.message === 'string'
        && isOptionalRecord(value.options) && isOptionalRecord(value.decision)
}

export function decodeQueueEnqueueRequest(value: unknown): QueueEnqueueRequest | null {
    return isQueueEnqueueRequest(value) ? value : null
}

function isQueueEnqueueResponse(value: unknown): value is QueueEnqueueResponse {
    return isRecord(value) && hasOnlyKeys(value, ['entry']) && isQueueEntryWire(value.entry)
}

export function decodeQueueEnqueueResponse(value: unknown): QueueEnqueueResponse | null {
    return isQueueEnqueueResponse(value) ? value : null
}

// ── queue_enqueue_graph ──
//
// The atomic batch enqueue, both paths, with its audit trail — in the daemon:
//   - `mode: 'compat'` → `enqueueTaskGraph(meshId, specs)`;
//   - `mode: 'graph'`  → `commitMeshGraphPlan(plan)` + `recordGraphEnqueueCommitted`.
// A failure records `recordGraphEnqueueRolledBack` (graph) or
// `recordGraphEnqueueValidationFailed` (compat) from the catch — the daemon
// writes the audit AFTER the failed transaction, exactly as design :752-753
// requires — and answers `{ ok: false, refusalCode?, message, extra? }` (a
// domain refusal is a RESULT here, not a transport error, so the caller keeps
// its code/extra for the tool response). NOT `code`/`error`: those two keys
// belong to the command envelope (`{ success, error, code }`) the client
// unwraps, so a result must never reuse them.

export interface QueueEnqueueGraphRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    mode: 'compat' | 'graph'
    /** compat: `MeshTaskGraphEntrySpec[]` (JSON passthrough). */
    specs?: readonly Record<string, unknown>[]
    /** graph: `commitMeshGraphPlan` input minus `meshId` (JSON passthrough). */
    plan?: Record<string, unknown>
    /** Audit context: batchId / missionId / coordinatorSessionId / onDependencyFailure / orchestrationDecision / taskCount. */
    audit?: Record<string, unknown>
}

export type QueueEnqueueGraphResponse =
    | { ok: true; tasks: readonly QueueEntryWire[]; graph?: Record<string, unknown> }
    | { ok: false; refusalCode?: string; message: string; extra?: Record<string, unknown> }

function isQueueEnqueueGraphRequest(value: unknown): value is QueueEnqueueGraphRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'mode', 'specs', 'plan', 'audit'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION || !isEvidenceIdentifier(value.meshId)) return false
    if (value.mode === 'compat') return isRecordArray(value.specs) && value.plan === undefined && isOptionalRecord(value.audit)
    if (value.mode === 'graph') return isRecord(value.plan) && value.specs === undefined && isOptionalRecord(value.audit)
    return false
}

export function decodeQueueEnqueueGraphRequest(value: unknown): QueueEnqueueGraphRequest | null {
    return isQueueEnqueueGraphRequest(value) ? value : null
}

function isQueueEnqueueGraphResponse(value: unknown): value is QueueEnqueueGraphResponse {
    if (!isRecord(value)) return false
    if (value.ok === true) {
        return hasOnlyKeys(value, ['ok', 'tasks', 'graph']) && Array.isArray(value.tasks) && value.tasks.every(isQueueEntryWire)
            && isOptionalRecord(value.graph)
    }
    if (value.ok === false) {
        return hasOnlyKeys(value, ['ok', 'refusalCode', 'message', 'extra']) && typeof value.message === 'string'
            && isOptionalString(value.refusalCode) && isOptionalRecord(value.extra)
    }
    return false
}

export function decodeQueueEnqueueGraphResponse(value: unknown): QueueEnqueueGraphResponse | null {
    return isQueueEnqueueGraphResponse(value) ? value : null
}

// ── queue_cancel ──

export interface QueueCancelRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    taskId: string
    /** Operator reason (free text, local IPC). */
    reason?: string
}

export interface QueueCancelResponse {
    /** The cancelled row, or null when no such task. */
    task: QueueEntryWire | null
    /** The row as it was BEFORE the cancel (its assignment is what a caller stops). */
    before: QueueEntryWire | null
}

function isQueueCancelRequest(value: unknown): value is QueueCancelRequest {
    return isRecord(value) && hasOnlyKeys(value, ['v', 'meshId', 'taskId', 'reason'])
        && value.v === TURN_IPC_PROTOCOL_VERSION && isEvidenceIdentifier(value.meshId) && isEvidenceIdentifier(value.taskId)
        && isOptionalString(value.reason)
}

export function decodeQueueCancelRequest(value: unknown): QueueCancelRequest | null {
    return isQueueCancelRequest(value) ? value : null
}

function isQueueCancelResponse(value: unknown): value is QueueCancelResponse {
    return isRecord(value) && hasOnlyKeys(value, ['task', 'before'])
        && (value.task === null || isQueueEntryWire(value.task))
        && (value.before === null || isQueueEntryWire(value.before))
}

export function decodeQueueCancelResponse(value: unknown): QueueCancelResponse | null {
    return isQueueCancelResponse(value) ? value : null
}

// ── queue_requeue ──

export interface QueueRequeueRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    taskId: string
    /** `requeueTask` options (reason / targetNodeId / targetSessionId / clear* / force / message / maxRetries / notBefore), JSON passthrough. */
    options?: Record<string, unknown>
}

export interface QueueRequeueResponse {
    task: QueueEntryWire | null
}

function isQueueRequeueRequest(value: unknown): value is QueueRequeueRequest {
    return isRecord(value) && hasOnlyKeys(value, ['v', 'meshId', 'taskId', 'options'])
        && value.v === TURN_IPC_PROTOCOL_VERSION && isEvidenceIdentifier(value.meshId) && isEvidenceIdentifier(value.taskId)
        && isOptionalRecord(value.options)
}

export function decodeQueueRequeueRequest(value: unknown): QueueRequeueRequest | null {
    return isQueueRequeueRequest(value) ? value : null
}

function isQueueRequeueResponse(value: unknown): value is QueueRequeueResponse {
    return isRecord(value) && hasOnlyKeys(value, ['task']) && (value.task === null || isQueueEntryWire(value.task))
}

export function decodeQueueRequeueResponse(value: unknown): QueueRequeueResponse | null {
    return isQueueRequeueResponse(value) ? value : null
}

// ── direct_dispatch_record ──
//
// The post-dispatch bookkeeping of `mesh_send_task`'s direct arms, in the
// daemon: `recordDirectDispatchTask` (materialise the queue row, stamped with
// the already-open `mesh_direct` attempt) and `recordDirectDispatchDecision`
// (GRAPH-MEASUREMENT-DIRECT). Each step is best-effort and reported separately
// — a dispatch that already happened must never fail on its bookkeeping.

export interface DirectDispatchRecordRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    taskId: string
    /** Free text (the authored task message — the materialised row keeps it). */
    message: string
    /** `recordDirectDispatchTask` options minus `id` (JSON passthrough). */
    task?: Record<string, unknown>
    /** `recordDirectDispatchDecision` args minus `taskId` (JSON passthrough). */
    decision?: Record<string, unknown>
}

export interface DirectDispatchRecordResponse {
    taskRecorded: boolean
    decisionRecorded: boolean
}

function isDirectDispatchRecordRequest(value: unknown): value is DirectDispatchRecordRequest {
    return isRecord(value) && hasOnlyKeys(value, ['v', 'meshId', 'taskId', 'message', 'task', 'decision'])
        && value.v === TURN_IPC_PROTOCOL_VERSION && isEvidenceIdentifier(value.meshId) && isEvidenceIdentifier(value.taskId)
        && typeof value.message === 'string' && isOptionalRecord(value.task) && isOptionalRecord(value.decision)
}

export function decodeDirectDispatchRecordRequest(value: unknown): DirectDispatchRecordRequest | null {
    return isDirectDispatchRecordRequest(value) ? value : null
}

function isDirectDispatchRecordResponse(value: unknown): value is DirectDispatchRecordResponse {
    return isRecord(value) && hasOnlyKeys(value, ['taskRecorded', 'decisionRecorded'])
        && typeof value.taskRecorded === 'boolean' && typeof value.decisionRecorded === 'boolean'
}

export function decodeDirectDispatchRecordResponse(value: unknown): DirectDispatchRecordResponse | null {
    return isDirectDispatchRecordResponse(value) ? value : null
}

// ── graph_audit_record ──
//
// The coordinator-gate / node-patch provenance records the `mesh_graph_*`
// tools write after a gate action (design :740-750), written by the daemon's
// allow-listed recorders (mesh-graph-provenance.ts) — the mcp-server never
// builds the record payload itself. `fields` is the recorder's argument object.

export const GRAPH_AUDIT_EVENTS = ['gate_claimed', 'gate_released', 'gate_abandoned', 'node_patched'] as const
export type GraphAuditEvent = typeof GRAPH_AUDIT_EVENTS[number]
const isGraphAuditEvent = makeGuard(GRAPH_AUDIT_EVENTS)

export interface GraphAuditRecordRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    event: GraphAuditEvent
    fields: Record<string, unknown>
}

export interface GraphAuditRecordResponse {
    recorded: boolean
}

function isGraphAuditRecordRequest(value: unknown): value is GraphAuditRecordRequest {
    return isRecord(value) && hasOnlyKeys(value, ['v', 'meshId', 'event', 'fields'])
        && value.v === TURN_IPC_PROTOCOL_VERSION && isEvidenceIdentifier(value.meshId)
        && isGraphAuditEvent(value.event) && isRecord(value.fields)
}

export function decodeGraphAuditRecordRequest(value: unknown): GraphAuditRecordRequest | null {
    return isGraphAuditRecordRequest(value) ? value : null
}

function isGraphAuditRecordResponse(value: unknown): value is GraphAuditRecordResponse {
    return isRecord(value) && hasOnlyKeys(value, ['recorded']) && typeof value.recorded === 'boolean'
}

export function decodeGraphAuditRecordResponse(value: unknown): GraphAuditRecordResponse | null {
    return isGraphAuditRecordResponse(value) ? value : null
}

// ── active_work_query ──
//
// The active-work view, COMPUTED in the daemon: it reads the queue, the open
// direct dispatches (`mesh_direct` attempts) and its local records (+ turn
// outcomes), and runs `buildMeshActiveWork` over them with the caller's live
// node probe results. `includeInputs` also returns the records + dispatches it
// used (the transcript-reconcile pass and the stale-direct prune read them);
// `compute: false` returns only those inputs. `includeSchedulingRuntime` adds
// `buildMeshSchedulingRuntime(mesh, queue)` for the caller's `mesh` snapshot.
// `queue` lets a caller substitute its own annotated queue view.

export interface ActiveWorkQueryRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    /** Live node probe results (`buildMeshActiveWork`'s `nodes`), JSON passthrough. */
    nodes?: readonly Record<string, unknown>[]
    /** Substitute queue rows (default: the daemon's `getQueue`). */
    queue?: readonly Record<string, unknown>[]
    /** Record tail fed to active work (default 200). */
    recordTail?: number
    includeTerminalDirect?: boolean
    /** Default true. */
    compute?: boolean
    includeInputs?: boolean
    includeSummary?: boolean
    includeSchedulingRuntime?: boolean
    /**
     * The caller's mesh snapshot for the scheduling runtime, JSON passthrough.
     * Optional since the daemon resolves its own mesh record when it is absent;
     * an older daemon rejects `includeSchedulingRuntime` without it (the caller's
     * feature-detect signal to resend with the mesh).
     */
    mesh?: Record<string, unknown>
}

export interface ActiveWorkQueryResponse {
    /** `MeshActiveWorkEvidence` (daemon-core), JSON passthrough; absent when `compute: false`. */
    activeWork?: Record<string, unknown>
    records?: readonly Record<string, unknown>[]
    directDispatches?: readonly Record<string, unknown>[]
    /** `MeshLedgerSummary`-shaped record summary. */
    summary?: Record<string, unknown>
    schedulingRuntime?: Record<string, unknown>
}

function isActiveWorkQueryRequest(value: unknown): value is ActiveWorkQueryRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'nodes', 'queue', 'recordTail', 'includeTerminalDirect', 'compute', 'includeInputs', 'includeSummary', 'includeSchedulingRuntime', 'mesh'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION || !isEvidenceIdentifier(value.meshId)) return false
    if (value.nodes !== undefined && !isRecordArray(value.nodes)) return false
    if (value.queue !== undefined && !isRecordArray(value.queue)) return false
    if (value.recordTail !== undefined && !isNonNegativeInt(value.recordTail)) return false
    return isOptionalBoolean(value.includeTerminalDirect) && isOptionalBoolean(value.compute) && isOptionalBoolean(value.includeInputs)
        && isOptionalBoolean(value.includeSummary) && isOptionalBoolean(value.includeSchedulingRuntime) && isOptionalRecord(value.mesh)
}

export function decodeActiveWorkQueryRequest(value: unknown): ActiveWorkQueryRequest | null {
    return isActiveWorkQueryRequest(value) ? value : null
}

function isActiveWorkQueryResponse(value: unknown): value is ActiveWorkQueryResponse {
    if (!isRecord(value) || !hasOnlyKeys(value, ['activeWork', 'records', 'directDispatches', 'summary', 'schedulingRuntime'])) return false
    if (value.records !== undefined && !isRecordArray(value.records)) return false
    if (value.directDispatches !== undefined && !isRecordArray(value.directDispatches)) return false
    return isOptionalRecord(value.activeWork) && isOptionalRecord(value.summary) && isOptionalRecord(value.schedulingRuntime)
}

export function decodeActiveWorkQueryResponse(value: unknown): ActiveWorkQueryResponse | null {
    return isActiveWorkQueryResponse(value) ? value : null
}

// ── recovery_context_query ──
//
// `getSessionRecoveryContext` (daemon-core `mesh-local-records.ts`) in the
// daemon. `lastTaskMessage` / `advice` are free text (local IPC).

export interface RecoveryContextQueryRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    nodeId?: string
    sessionId?: string
    maxRetries?: number
    /**
     * Batch: one context per node id, computed over ONE record read (answers
     * `contexts`). Exclusive with `nodeId`/`sessionId`. An older daemon rejects it.
     */
    nodeIds?: readonly string[]
}

export interface RecoveryContextQueryResponse {
    /** Single mode (nodeId/sessionId). */
    context?: Record<string, unknown>
    /** Batch mode (`nodeIds`): context per node id. */
    contexts?: Record<string, Record<string, unknown>>
}

function isRecoveryContextQueryRequest(value: unknown): value is RecoveryContextQueryRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'nodeId', 'sessionId', 'maxRetries', 'nodeIds'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION || !isEvidenceIdentifier(value.meshId)) return false
    if (!isOptionalId(value.nodeId) || !isOptionalId(value.sessionId)) return false
    if (value.maxRetries !== undefined && !isNonNegativeInt(value.maxRetries)) return false
    if (value.nodeIds !== undefined) {
        if (!Array.isArray(value.nodeIds) || value.nodeIds.length === 0 || !value.nodeIds.every(isEvidenceIdentifier)) return false
        return value.nodeId === undefined && value.sessionId === undefined
    }
    return value.nodeId !== undefined || value.sessionId !== undefined
}

export function decodeRecoveryContextQueryRequest(value: unknown): RecoveryContextQueryRequest | null {
    return isRecoveryContextQueryRequest(value) ? value : null
}

function isRecoveryContextWire(value: unknown): boolean {
    return isRecord(value) && typeof value.consecutiveNodeFailures === 'number'
}

function isRecoveryContextQueryResponse(value: unknown): value is RecoveryContextQueryResponse {
    if (!isRecord(value) || !hasOnlyKeys(value, ['context', 'contexts'])) return false
    if (value.context === undefined && value.contexts === undefined) return false
    if (value.context !== undefined && !isRecoveryContextWire(value.context)) return false
    if (value.contexts !== undefined && (!isRecord(value.contexts) || !Object.values(value.contexts).every(isRecoveryContextWire))) return false
    return true
}

export function decodeRecoveryContextQueryResponse(value: unknown): RecoveryContextQueryResponse | null {
    return isRecoveryContextQueryResponse(value) ? value : null
}
