/**
 * turn-ipc — the turn-ledger commands: turn_observe, mesh_record, turn_cancel,
 * operator_status, turn_query, mesh_index_query. Part of the turn-ipc wire
 * contract (./turn-ipc.ts).
 */

import {
    makeGuard,
    TURN_IPC_PROTOCOL_VERSION,
    hasOnlyKeys,
    isNonNegativeInt,
    isOptionalId,
    isFiniteNumber,
} from './turn-ipc-guards';
import {
    type TurnEvidence,
    type TurnAttemptRef,
    type TurnOutcome,
    isTurnEvidence,
    isEvidenceIdentifier,
    type ProjectedScalars,
    type TurnReason,
    isTurnReason,
    type TurnEvidenceKind,
} from './turn-evidence';
import { isRecord } from './protocol/envelope';

// ─── turn_observe ───────────────────────────────────────────────────────────

/** Reducer verdict, mirrored from the C1 reducer's `reduce()` return shape. */
export const TURN_OBSERVE_VERDICTS = ['applied', 'recorded', 'rejected'] as const
export type TurnObserveVerdict = typeof TURN_OBSERVE_VERDICTS[number]
const isTurnObserveVerdict = makeGuard(TURN_OBSERVE_VERDICTS)

export interface TurnObserveRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    evidence: TurnEvidence
}

export interface TurnObserveResponse {
    verdict: TurnObserveVerdict
    attemptRef: TurnAttemptRef
    /** Present only when the evidence committed the attempt (verdict 'applied' + a terminal-class kind). */
    outcome?: TurnOutcome
}

function isTurnObserveRequest(value: unknown): value is TurnObserveRequest {
    return isRecord(value) && hasOnlyKeys(value, ['v', 'evidence'])
        && value.v === TURN_IPC_PROTOCOL_VERSION
        && isTurnEvidence(value.evidence)
}

export function decodeTurnObserveRequest(value: unknown): TurnObserveRequest | null {
    return isTurnObserveRequest(value) ? value : null
}

function isTurnAttemptRefValue(value: unknown): value is TurnAttemptRef {
    return isRecord(value) && hasOnlyKeys(value, ['attemptId', 'generation'])
        && isEvidenceIdentifier(value.attemptId) && isNonNegativeInt(value.generation)
}

function isTurnObserveResponse(value: unknown): value is TurnObserveResponse {
    return isRecord(value) && hasOnlyKeys(value, ['verdict', 'attemptRef', 'outcome'])
        && isTurnObserveVerdict(value.verdict)
        && isTurnAttemptRefValue(value.attemptRef)
        && (value.outcome === undefined || isTurnOutcomeValue(value.outcome))
}

const TURN_OUTCOMES_LOCAL = ['completed', 'failed', 'cancelled'] as const
function isTurnOutcomeValue(value: unknown): value is TurnOutcome {
    return typeof value === 'string' && (TURN_OUTCOMES_LOCAL as readonly string[]).includes(value)
}

export function decodeTurnObserveResponse(value: unknown): TurnObserveResponse | null {
    return isTurnObserveResponse(value) ? value : null
}

// ─── mesh_record ────────────────────────────────────────────────────────────

/**
 * Structural pin of `seqscribe/mesh-event-projection.ts` `PROJECTED_PAYLOAD_KEYS`
 * (daemon-core; this leaf cannot import it). A test in this package's test
 * suite AND a daemon-core test each assert their list equals this one — see
 * `mesh-shared/test/turn-ipc.test.ts` and the C-W6 report's break-once table.
 * Adding a key here is the SAME assertion as adding it there: non-content
 * (identifier, enum, boolean, or counter), never free text.
 */
export const MESH_RECORD_PAYLOAD_KEYS = [
    // Identifiers
    'taskId', 'deliveryId', 'attemptId', 'missionId', 'checkpointId', 'promptId', 'providerSessionId', 'targetNoteId',
    // Routing / addressing
    'nodeId', 'sessionId', 'providerType', 'transport', 'attemptedSessionId', 'holderSessionId',
    // Outcome enums
    'reason', 'status', 'outcome', 'terminalKind', 'event',
    'source', 'intentionalStopReason',
    // Booleans
    'retryable', 'rebound', 'forced', 'fallback', 'membershipRemoved', 'requestedForce', 'removedByRemoteDaemon',
    'completedViaReady', 'intentional', 'weak',
    // Counters
    'attempt', 'attemptCount', 'count',
] as const

const MESH_RECORD_PAYLOAD_KEY_SET: ReadonlySet<string> = new Set(MESH_RECORD_PAYLOAD_KEYS)

/** Maximum length of any string value in a `mesh_record` payload (mirrors `MAX_PROJECTED_STRING`). */
export const MAX_MESH_RECORD_STRING = 200

export interface MeshRecordRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    /** The original ledger `kind` string (daemon-core `MeshLedgerKind`; mesh-shared cannot import that union, so it is an identifier here). */
    ledgerKind: string
    nodeId?: string
    sessionId?: string
    taskId?: string
    /** Restricted to `MESH_RECORD_PAYLOAD_KEYS` — an unknown key is a decode failure, not a silently dropped field. */
    payload: ProjectedScalars
}

export interface MeshRecordResponse {
    /** `mesh.<id>.events` append coordinates, for callers that need to reference the entry (e.g. a `ref`'d handoff). */
    eventId: string
    seq: number
}

function isProjectedScalarsValue(value: unknown): value is ProjectedScalars {
    if (!isRecord(value)) return false
    for (const v of Object.values(value)) {
        if (v === null) continue
        if (typeof v === 'boolean' || typeof v === 'number') continue
        if (typeof v === 'string') { if (v.length > MAX_MESH_RECORD_STRING) return false; continue }
        return false
    }
    return true
}

/** Every payload key must be a member of `MESH_RECORD_PAYLOAD_KEYS` — the allow-list boundary at the wire. */
export function isMeshRecordPayload(value: unknown): value is ProjectedScalars {
    if (!isProjectedScalarsValue(value)) return false
    for (const key of Object.keys(value as Record<string, unknown>)) {
        if (!MESH_RECORD_PAYLOAD_KEY_SET.has(key)) return false
    }
    return true
}

function isMeshRecordRequest(value: unknown): value is MeshRecordRequest {
    return isRecord(value) && hasOnlyKeys(value, ['v', 'meshId', 'ledgerKind', 'nodeId', 'sessionId', 'taskId', 'payload'])
        && value.v === TURN_IPC_PROTOCOL_VERSION
        && isEvidenceIdentifier(value.meshId)
        && isEvidenceIdentifier(value.ledgerKind)
        && isOptionalId(value.nodeId) && isOptionalId(value.sessionId) && isOptionalId(value.taskId)
        && isMeshRecordPayload(value.payload)
}

export function decodeMeshRecordRequest(value: unknown): MeshRecordRequest | null {
    return isMeshRecordRequest(value) ? value : null
}

function isMeshRecordResponse(value: unknown): value is MeshRecordResponse {
    return isRecord(value) && hasOnlyKeys(value, ['eventId', 'seq'])
        && isEvidenceIdentifier(value.eventId) && isNonNegativeInt(value.seq)
}

export function decodeMeshRecordResponse(value: unknown): MeshRecordResponse | null {
    return isMeshRecordResponse(value) ? value : null
}

// ─── turn_cancel ────────────────────────────────────────────────────────────

export interface TurnCancelRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    /** Exactly one of the two must be present — the decoder rejects both-or-neither. */
    attemptId?: string
    taskId?: string
    reason: TurnReason
}

export interface TurnCancelResponse {
    attemptRef: TurnAttemptRef
    verdict: TurnObserveVerdict
}

function isTurnCancelRequest(value: unknown): value is TurnCancelRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'attemptId', 'taskId', 'reason'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION) return false
    const hasAttempt = value.attemptId !== undefined
    const hasTask = value.taskId !== undefined
    if (hasAttempt === hasTask) return false // exactly one of the two
    if (hasAttempt && !isEvidenceIdentifier(value.attemptId)) return false
    if (hasTask && !isEvidenceIdentifier(value.taskId)) return false
    return isTurnReason(value.reason)
}

export function decodeTurnCancelRequest(value: unknown): TurnCancelRequest | null {
    return isTurnCancelRequest(value) ? value : null
}

function isTurnCancelResponse(value: unknown): value is TurnCancelResponse {
    return isRecord(value) && hasOnlyKeys(value, ['attemptRef', 'verdict'])
        && isTurnAttemptRefValue(value.attemptRef) && isTurnObserveVerdict(value.verdict)
}

export function decodeTurnCancelResponse(value: unknown): TurnCancelResponse | null {
    return isTurnCancelResponse(value) ? value : null
}

// ─── operator_status ────────────────────────────────────────────────────────

/**
 * Fire-and-forget operator/tool-call status record — replaces
 * `recordMeshCoordinatorToolCall` (10 sites, `mesh_tool_call_log`) and doubles
 * as the `operator_status` evidence kind's wire shape.
 *
 * NAMING NOTE (flagged for the C-W6 implementer, see report §"mismatch"):
 * the C-W6 brief's DELIVERABLES describes this request as
 * `{taskId, status: MeshTaskStatus, reason}`, but C1's `operator_status`
 * evidence kind (`turn-evidence.ts` `OPERATOR_STATUSES`) is the closed
 * 2-value set `'completed' | 'failed'` — a verdict on an operator ACTION, not
 * a `MeshTaskStatus` (5-value queue-row status: pending/assigned/completed/
 * failed/cancelled). This contract follows `turn-evidence.ts` because that is
 * what the C1 reducer actually consumes for this evidence kind; using the
 * 5-value `MeshTaskStatus` here would let this request carry `pending` or
 * `assigned`, which the reducer has no transition for.
 */
export const OPERATOR_STATUS_VALUES = ['completed', 'failed'] as const
export type OperatorStatusValue = typeof OPERATOR_STATUS_VALUES[number]
const isOperatorStatusValue = makeGuard(OPERATOR_STATUS_VALUES)

export const OPERATOR_STATUS_REASON_VALUES = ['operator_update', 'refine_terminal', 'validation_terminal'] as const
export type OperatorStatusReasonValue = typeof OPERATOR_STATUS_REASON_VALUES[number]
const isOperatorStatusReasonValue = makeGuard(OPERATOR_STATUS_REASON_VALUES)

export interface OperatorStatusRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    taskId: string
    status: OperatorStatusValue
    reason: OperatorStatusReasonValue
}

/** Acknowledgement only — this command is fire-and-forget by design (the daemon owns rate-limiting the underlying log). */
export interface OperatorStatusResponse {
    accepted: true
}

function isOperatorStatusRequest(value: unknown): value is OperatorStatusRequest {
    return isRecord(value) && hasOnlyKeys(value, ['v', 'taskId', 'status', 'reason'])
        && value.v === TURN_IPC_PROTOCOL_VERSION
        && isEvidenceIdentifier(value.taskId)
        && isOperatorStatusValue(value.status)
        && isOperatorStatusReasonValue(value.reason)
}

export function decodeOperatorStatusRequest(value: unknown): OperatorStatusRequest | null {
    return isOperatorStatusRequest(value) ? value : null
}

function isOperatorStatusResponse(value: unknown): value is OperatorStatusResponse {
    return isRecord(value) && hasOnlyKeys(value, ['accepted']) && value.accepted === true
}

export function decodeOperatorStatusResponse(value: unknown): OperatorStatusResponse | null {
    return isOperatorStatusResponse(value) ? value : null
}

// ─── turn_query ─────────────────────────────────────────────────────────────

/** Row shape returned by `turn_query` — scalar projection of a `turn_attempts` row (C3 schema), never `data_json`/`payload_json` content. */
export interface TurnQueryAttemptRow {
    attemptId: string
    generation: number
    meshId?: string
    taskId?: string
    sessionId: string
    nodeId?: string
    providerType?: string
    state: string
    terminalOutcome?: TurnOutcome
    terminalReason?: TurnReason
    acceptedAt: number
    terminalAt?: number
}

/** Row shape returned by `turn_query` for the event stream — scalar projection of a `turn_events` row, `payload_json` NEVER included. */
export interface TurnQueryEventRow {
    eventId: string
    attemptId?: string
    generation?: number
    sessionId: string
    kind: TurnEvidenceKind
    source: string
    verdict: TurnObserveVerdict | 'forwarded'
    atMs: number
}

export interface TurnQueryRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    taskId?: string
    attemptId?: string
    sessionId?: string
    state?: string
    since?: number
    tail?: number
}

export interface TurnQueryResponse {
    attempts: readonly TurnQueryAttemptRow[]
    events: readonly TurnQueryEventRow[]
    /** C7-5: set while `mesh.<id>.events` replication is behind for this mesh — the caller must not treat a fleet-scope answer as complete. */
    replicationPending?: boolean
}

function isTurnQueryRequest(value: unknown): value is TurnQueryRequest {
    return isRecord(value) && hasOnlyKeys(value, ['v', 'meshId', 'taskId', 'attemptId', 'sessionId', 'state', 'since', 'tail'])
        && value.v === TURN_IPC_PROTOCOL_VERSION
        && isEvidenceIdentifier(value.meshId)
        && isOptionalId(value.taskId) && isOptionalId(value.attemptId) && isOptionalId(value.sessionId)
        && (value.state === undefined || isEvidenceIdentifier(value.state))
        && (value.since === undefined || isFiniteNumber(value.since))
        && (value.tail === undefined || isNonNegativeInt(value.tail))
}

export function decodeTurnQueryRequest(value: unknown): TurnQueryRequest | null {
    return isTurnQueryRequest(value) ? value : null
}

const TURN_QUERY_ATTEMPT_ROW_KEYS = [
    'attemptId', 'generation', 'meshId', 'taskId', 'sessionId', 'nodeId', 'providerType',
    'state', 'terminalOutcome', 'terminalReason', 'acceptedAt', 'terminalAt',
] as const

function isTurnQueryAttemptRow(value: unknown): value is TurnQueryAttemptRow {
    if (!isRecord(value) || !hasOnlyKeys(value, TURN_QUERY_ATTEMPT_ROW_KEYS)) return false
    if (!isEvidenceIdentifier(value.attemptId) || !isNonNegativeInt(value.generation)) return false
    if (!isOptionalId(value.meshId) || !isOptionalId(value.taskId)) return false
    if (!isEvidenceIdentifier(value.sessionId)) return false
    if (!isOptionalId(value.nodeId) || !isOptionalId(value.providerType)) return false
    if (typeof value.state !== 'string') return false
    if (value.terminalOutcome !== undefined && !isTurnOutcomeValue(value.terminalOutcome)) return false
    if (value.terminalReason !== undefined && !isTurnReason(value.terminalReason)) return false
    if (!isFiniteNumber(value.acceptedAt)) return false
    if (value.terminalAt !== undefined && !isFiniteNumber(value.terminalAt)) return false
    return true
}

const TURN_QUERY_EVENT_VERDICTS = ['applied', 'recorded', 'rejected', 'forwarded'] as const
const TURN_QUERY_EVENT_ROW_KEYS = ['eventId', 'attemptId', 'generation', 'sessionId', 'kind', 'source', 'verdict', 'atMs'] as const

function isTurnQueryEventRow(value: unknown): value is TurnQueryEventRow {
    if (!isRecord(value) || !hasOnlyKeys(value, TURN_QUERY_EVENT_ROW_KEYS)) return false
    if (!isEvidenceIdentifier(value.eventId)) return false
    if (!isOptionalId(value.attemptId)) return false
    if (value.generation !== undefined && !isNonNegativeInt(value.generation)) return false
    if (!isEvidenceIdentifier(value.sessionId)) return false
    if (typeof value.kind !== 'string') return false
    if (typeof value.source !== 'string') return false
    if (!(TURN_QUERY_EVENT_VERDICTS as readonly string[]).includes(value.verdict as string)) return false
    if (!isFiniteNumber(value.atMs)) return false
    return true
}

function isTurnQueryResponse(value: unknown): value is TurnQueryResponse {
    if (!isRecord(value) || !hasOnlyKeys(value, ['attempts', 'events', 'replicationPending'])) return false
    if (!Array.isArray(value.attempts) || !value.attempts.every(isTurnQueryAttemptRow)) return false
    if (!Array.isArray(value.events) || !value.events.every(isTurnQueryEventRow)) return false
    if (value.replicationPending !== undefined && typeof value.replicationPending !== 'boolean') return false
    return true
}

export function decodeTurnQueryResponse(value: unknown): TurnQueryResponse | null {
    return isTurnQueryResponse(value) ? value : null
}

// ─── mesh_index_query ───────────────────────────────────────────────────────

export const MESH_INDEX_QUERY_WRITER_SCOPES = ['own', 'fleet'] as const
export type MeshIndexQueryWriterScope = typeof MESH_INDEX_QUERY_WRITER_SCOPES[number]
const isMeshIndexQueryWriterScope = makeGuard(MESH_INDEX_QUERY_WRITER_SCOPES)

export interface MeshIndexQueryRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    ledgerKind?: string
    sessionId?: string
    taskId?: string
    writer?: MeshIndexQueryWriterScope
    since?: number
    tail?: number
}

/** Row shape returned by `mesh_index_query` — a `mesh_topic_index` row (C3 schema). */
export interface MeshTopicIndexRow {
    writer: string
    seq: number
    meshId: string
    eventId: string
    kind: string
    ledgerKind?: string
    taskId?: string
    sessionId?: string
    nodeId?: string
    atMs: number
    payload: ProjectedScalars
}

export interface MeshIndexQueryResponse {
    rows: readonly MeshTopicIndexRow[]
    /** C7-5: true while `mesh.<id>.events` replication is behind for this mesh. */
    replicationPending?: boolean
}

function isMeshIndexQueryRequest(value: unknown): value is MeshIndexQueryRequest {
    return isRecord(value) && hasOnlyKeys(value, ['v', 'meshId', 'ledgerKind', 'sessionId', 'taskId', 'writer', 'since', 'tail'])
        && value.v === TURN_IPC_PROTOCOL_VERSION
        && isEvidenceIdentifier(value.meshId)
        && isOptionalId(value.ledgerKind) && isOptionalId(value.sessionId) && isOptionalId(value.taskId)
        && (value.writer === undefined || isMeshIndexQueryWriterScope(value.writer))
        && (value.since === undefined || isFiniteNumber(value.since))
        && (value.tail === undefined || isNonNegativeInt(value.tail))
}

export function decodeMeshIndexQueryRequest(value: unknown): MeshIndexQueryRequest | null {
    return isMeshIndexQueryRequest(value) ? value : null
}

const MESH_TOPIC_INDEX_ROW_KEYS = [
    'writer', 'seq', 'meshId', 'eventId', 'kind', 'ledgerKind', 'taskId', 'sessionId', 'nodeId', 'atMs', 'payload',
] as const

function isMeshTopicIndexRow(value: unknown): value is MeshTopicIndexRow {
    if (!isRecord(value) || !hasOnlyKeys(value, MESH_TOPIC_INDEX_ROW_KEYS)) return false
    if (!isEvidenceIdentifier(value.writer) || !isNonNegativeInt(value.seq)) return false
    if (!isEvidenceIdentifier(value.meshId) || !isEvidenceIdentifier(value.eventId)) return false
    if (typeof value.kind !== 'string') return false
    if (!isOptionalId(value.ledgerKind) || !isOptionalId(value.taskId) || !isOptionalId(value.sessionId) || !isOptionalId(value.nodeId)) return false
    if (!isFiniteNumber(value.atMs)) return false
    // Rows replay mesh.record entries, so the payload is held to the SAME
    // allow-list as a mesh_record request — not just "any scalar map" — to
    // stop a fleet-wide read from surfacing a key that was never reviewed.
    if (!isMeshRecordPayload(value.payload)) return false
    return true
}

export function isMeshIndexQueryResponse(value: unknown): value is MeshIndexQueryResponse {
    if (!isRecord(value) || !hasOnlyKeys(value, ['rows', 'replicationPending'])) return false
    if (!Array.isArray(value.rows) || !value.rows.every(isMeshTopicIndexRow)) return false
    if (value.replicationPending !== undefined && typeof value.replicationPending !== 'boolean') return false
    return true
}

export function decodeMeshIndexQueryResponse(value: unknown): MeshIndexQueryResponse | null {
    return isMeshIndexQueryResponse(value) ? value : null
}
