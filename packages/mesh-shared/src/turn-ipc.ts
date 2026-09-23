/**
 * turn-ipc — typed IPC command contracts for the six commands that replace
 * mcp-server's direct `mesh-runtime.db` access (design §5 C2 "MCP server").
 *
 * Wiring-unification Phase C, workstream C-W6
 * (docs/design/2026-09-23-wiring-unification.md §5 C2/C3, C9 row C-W6).
 *
 * WHY THIS FILE EXISTS
 * ---------------------
 * mcp-server is a second, in-process writer of `mesh-runtime.db` (~45-69
 * direct-mutation call sites, ~54 reads, per the C-W6 brief). C2 moves every
 * one of those call sites behind IPC, executed in the daemon that owns the
 * turn ledger and the seqscribe node, so mcp-server never opens the SQLite
 * file itself. This file is the WIRE CONTRACT for that IPC surface — request/
 * response shapes, closed enums, runtime decoders — shared by the daemon-core
 * command handlers (added with C-W6 proper; NOT this file) and the mcp-server
 * client (`mcp-server/src/ipc/turn-commands.ts`, this workstream).
 *
 * The six commands (§5 C2):
 *   - turn_observe     — submit one TurnEvidence; returns the reducer verdict.
 *   - mesh_record      — append a content-free scalar record (`mesh.record`
 *                         topic entry), replacing `appendLedgerEntry`.
 *   - turn_cancel       — cancel an attempt (`cancel` evidence, source `mcp_probe`
 *                         or `operator`).
 *   - operator_status   — record a fire-and-forget operator/tool-call status
 *                         (`operator_status` evidence + the former
 *                         `recordMeshCoordinatorToolCall` log write).
 *   - turn_query        — read attempt/event rows (own or fleet scope).
 *   - mesh_index_query  — read `mesh_topic_index` rows (fleet-wide, replacing
 *                         the in-memory read model / parity reads).
 *
 * CONTENT BOUNDARY
 * -----------------
 * Every request/response field is an identifier, a closed enum, a boolean, a
 * counter or a timestamp. `turn_observe` carries a `TurnEvidence`, which is
 * content-free by construction (`turn-evidence.ts`). `mesh_record` carries a
 * `ProjectedScalars` payload restricted to the SAME allow-list keys
 * `seqscribe/mesh-event-projection.ts` already reviews and ships
 * (`PROJECTED_PAYLOAD_KEYS`, 35 keys) — this file pins a STRUCTURAL COPY of
 * that key list (`MESH_RECORD_PAYLOAD_KEYS`) so mesh-shared does not import
 * daemon-core (leaf constraint), with a test asserting the two lists agree.
 * Summaries, report bodies, progress notes and modal text never travel in any
 * of these payloads — they go to the content-class `mesh.<id>.handoff` topic
 * and are referenced by `SummaryRef {topic, writer, seq}` (already declared
 * in `./turn-evidence.ts`).
 *
 * VERSIONING
 * -----------
 * Every request carries `v: 1` so a future incompatible change can be
 * detected by the responder before it tries to interpret the args.
 */

import {
    isEvidenceIdentifier,
    isTurnEvidence,
    isTurnReason,
    type ProjectedScalars,
    type SummaryRef,
    type TurnAttemptRef,
    type TurnEvidence,
    type TurnEvidenceKind,
    type TurnOutcome,
    type TurnReason,
} from './turn-evidence'
import { isRecord } from './protocol/envelope'

// ─── shared primitives ─────────────────────────────────────────────────────

/** Every request in this file is versioned so a responder can reject a shape it predates. */
export const TURN_IPC_PROTOCOL_VERSION = 1 as const

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value)
}

function isNonNegativeInt(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0
}

function isOptionalId(value: unknown): boolean {
    return value === undefined || isEvidenceIdentifier(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) return false
    }
    return true
}

// ─── error codes ────────────────────────────────────────────────────────────

/**
 * Closed error-code union every command response may carry instead of (or in
 * addition to, for the client-side wrapper) a result.
 *
 *   daemon_required      — no daemon reachable (no IPC/local transport
 *                           connection could be established). Distinct from
 *                           every other failure: it means "there is nobody to
 *                           ask", not "the ask failed."
 *   turn_ledger_unavailable — a daemon answered but its turn ledger is not
 *                           armed yet (mid-boot, mid-migration).
 *   ledger_not_owner     — the daemon that answered does not own the
 *                           attempt/mesh addressed by the request (routing
 *                           mistake, or the owner changed after a reclaim).
 */
export const TURN_IPC_ERROR_CODES = ['daemon_required', 'turn_ledger_unavailable', 'ledger_not_owner'] as const
export type TurnIpcErrorCode = typeof TURN_IPC_ERROR_CODES[number]

function makeGuard<T extends readonly string[]>(values: T): (value: unknown) => value is T[number] {
    const set: ReadonlySet<string> = new Set(values)
    return (value: unknown): value is T[number] => typeof value === 'string' && set.has(value)
}

export const isTurnIpcErrorCode = makeGuard(TURN_IPC_ERROR_CODES)

/** Structured failure shape a responder returns instead of a result. Never thrown across the wire — the client maps it to a typed error (see mcp-server/src/ipc/turn-commands.ts). */
export interface TurnIpcError {
    code: TurnIpcErrorCode
    /** Short machine-oriented detail, e.g. which daemon was expected. Never free text describing content. */
    detail?: string
}

export function isTurnIpcError(value: unknown): value is TurnIpcError {
    return isRecord(value) && hasOnlyKeys(value, ['code', 'detail']) && isTurnIpcErrorCode(value.code)
        && (value.detail === undefined || typeof value.detail === 'string')
}

// ─── turn_observe ───────────────────────────────────────────────────────────

/** Reducer verdict, mirrored from the C1 reducer's `reduce()` return shape. */
export const TURN_OBSERVE_VERDICTS = ['applied', 'recorded', 'rejected'] as const
export type TurnObserveVerdict = typeof TURN_OBSERVE_VERDICTS[number]
export const isTurnObserveVerdict = makeGuard(TURN_OBSERVE_VERDICTS)

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

export function isTurnObserveRequest(value: unknown): value is TurnObserveRequest {
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

export function isTurnObserveResponse(value: unknown): value is TurnObserveResponse {
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
export type MeshRecordPayloadKey = typeof MESH_RECORD_PAYLOAD_KEYS[number]

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

export function isMeshRecordRequest(value: unknown): value is MeshRecordRequest {
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

export function isMeshRecordResponse(value: unknown): value is MeshRecordResponse {
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

export function isTurnCancelRequest(value: unknown): value is TurnCancelRequest {
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

export function isTurnCancelResponse(value: unknown): value is TurnCancelResponse {
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
export const isOperatorStatusValue = makeGuard(OPERATOR_STATUS_VALUES)

export const OPERATOR_STATUS_REASON_VALUES = ['operator_update', 'refine_terminal', 'validation_terminal'] as const
export type OperatorStatusReasonValue = typeof OPERATOR_STATUS_REASON_VALUES[number]
export const isOperatorStatusReasonValue = makeGuard(OPERATOR_STATUS_REASON_VALUES)

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

export function isOperatorStatusRequest(value: unknown): value is OperatorStatusRequest {
    return isRecord(value) && hasOnlyKeys(value, ['v', 'taskId', 'status', 'reason'])
        && value.v === TURN_IPC_PROTOCOL_VERSION
        && isEvidenceIdentifier(value.taskId)
        && isOperatorStatusValue(value.status)
        && isOperatorStatusReasonValue(value.reason)
}

export function decodeOperatorStatusRequest(value: unknown): OperatorStatusRequest | null {
    return isOperatorStatusRequest(value) ? value : null
}

export function isOperatorStatusResponse(value: unknown): value is OperatorStatusResponse {
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

export function isTurnQueryRequest(value: unknown): value is TurnQueryRequest {
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

export function isTurnQueryResponse(value: unknown): value is TurnQueryResponse {
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
export const isMeshIndexQueryWriterScope = makeGuard(MESH_INDEX_QUERY_WRITER_SCOPES)

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

export function isMeshIndexQueryRequest(value: unknown): value is MeshIndexQueryRequest {
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

// ─── mission_upsert / mission_query ────────────────────────────────────────
//
// Decision (2026-09-23, design doc §5 C2 update): missions and graph gates
// have no home in the original six commands — `upsertMeshMission`/
// `listMeshMissionsForTool` write/read structured state with a free-text
// `goal`/`title` that cannot fit `mesh_record`'s scalar `ProjectedScalars`
// allow-list (§ "MESH_RECORD_PAYLOAD_KEYS" above has no text field, on
// purpose). Two more commands, not a widened allow-list:
//
//   - mission_upsert — create/update a mission (mesh-missions.ts
//     `upsertMeshMission`'s shape).
//   - mission_query  — list missions for a mesh, optionally filtered by
//     status (`getMeshMissions`'s shape).
//
// WHY FREE TEXT IS FINE HERE, UNLIKE mesh_record's payload: this is LOCAL
// IPC between mcp-server and the daemon that owns the mission table — both
// processes run on the operator's own machine. The content boundary this
// program protects is "the SERVER never receives chat content" (CLAUDE.md);
// IPC between two local processes was never inside that boundary, the same
// way a direct in-process function call wasn't. Cross-machine mission text
// (a worker learning about a mission a coordinator defined) travels as a
// `mesh.<id>.handoff` ref per C10-1's precedent — mission_upsert/query never
// themselves cross a machine boundary.

export const MESH_MISSION_STATUSES = ['active', 'paused', 'completed', 'abandoned'] as const
export type MeshMissionStatusValue = typeof MESH_MISSION_STATUSES[number]
export const isMeshMissionStatusValue = makeGuard(MESH_MISSION_STATUSES)

export const MESH_MISSION_SOURCES = ['magi', 'coordinator'] as const
export type MeshMissionSourceValue = typeof MESH_MISSION_SOURCES[number]
export const isMeshMissionSourceValue = makeGuard(MESH_MISSION_SOURCES)

export interface MissionUpsertRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    /** Omitted = create a new mission; present = update (must resolve to an existing mission — see mesh-missions.ts MISSION-UPSERT-SILENT-CREATE). */
    id?: string
    title: string
    /** Free text — see file-header note on why this is fine over local IPC. */
    goal?: string
    status?: MeshMissionStatusValue
    source?: MeshMissionSourceValue
}

export interface MeshMissionRecordWire {
    id: string
    meshId: string
    title: string
    goal: string
    status: MeshMissionStatusValue
    source?: MeshMissionSourceValue
}

export interface MissionUpsertResponse {
    mission: MeshMissionRecordWire
}

function isMeshMissionRecordWire(value: unknown): value is MeshMissionRecordWire {
    if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'meshId', 'title', 'goal', 'status', 'source'])) return false
    if (!isEvidenceIdentifier(value.id) || !isEvidenceIdentifier(value.meshId)) return false
    if (typeof value.title !== 'string' || typeof value.goal !== 'string') return false
    if (!isMeshMissionStatusValue(value.status)) return false
    if (value.source !== undefined && !isMeshMissionSourceValue(value.source)) return false
    return true
}

export function isMissionUpsertRequest(value: unknown): value is MissionUpsertRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'id', 'title', 'goal', 'status', 'source'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION) return false
    if (!isEvidenceIdentifier(value.meshId)) return false
    if (value.id !== undefined && !isEvidenceIdentifier(value.id)) return false
    if (typeof value.title !== 'string' || value.title.trim().length === 0) return false
    if (value.goal !== undefined && typeof value.goal !== 'string') return false
    if (value.status !== undefined && !isMeshMissionStatusValue(value.status)) return false
    if (value.source !== undefined && !isMeshMissionSourceValue(value.source)) return false
    return true
}

export function decodeMissionUpsertRequest(value: unknown): MissionUpsertRequest | null {
    return isMissionUpsertRequest(value) ? value : null
}

export function isMissionUpsertResponse(value: unknown): value is MissionUpsertResponse {
    return isRecord(value) && hasOnlyKeys(value, ['mission']) && isMeshMissionRecordWire(value.mission)
}

export function decodeMissionUpsertResponse(value: unknown): MissionUpsertResponse | null {
    return isMissionUpsertResponse(value) ? value : null
}

export interface MissionQueryRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    /** Omitted = every status. */
    statuses?: readonly MeshMissionStatusValue[]
    /** Single-mission lookup (mesh-missions.ts `getMeshMission`'s shape) — mutually exclusive with `statuses`. */
    id?: string
}

export interface MissionQueryResponse {
    missions: readonly MeshMissionRecordWire[]
}

export function isMissionQueryRequest(value: unknown): value is MissionQueryRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'statuses', 'id'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION) return false
    if (!isEvidenceIdentifier(value.meshId)) return false
    if (value.id !== undefined && !isEvidenceIdentifier(value.id)) return false
    if (value.statuses !== undefined) {
        if (!Array.isArray(value.statuses) || value.statuses.length === 0) return false
        if (!value.statuses.every(isMeshMissionStatusValue)) return false
    }
    return true
}

export function decodeMissionQueryRequest(value: unknown): MissionQueryRequest | null {
    return isMissionQueryRequest(value) ? value : null
}

export function isMissionQueryResponse(value: unknown): value is MissionQueryResponse {
    return isRecord(value) && hasOnlyKeys(value, ['missions'])
        && Array.isArray(value.missions) && value.missions.every(isMeshMissionRecordWire)
}

export function decodeMissionQueryResponse(value: unknown): MissionQueryResponse | null {
    return isMissionQueryResponse(value) ? value : null
}

// ─── note_upsert / note_forget ──────────────────────────────────────────────
//
// Decision (2026-09-24, C-W6b; implemented C-W8): coordinator operating notes
// get their own two local-IPC commands. A note's text is coordinator-authored
// free text, so — exactly like mission_upsert's `goal` — it cannot ride
// `mesh_record`'s scalar allow-list, and it never needs to: notes live in the
// owning daemon's `mesh_operating_notes` table (local-only; never on
// `mesh.<id>.events`). The same "local IPC is inside the boundary" rationale as
// the mission commands above applies.

export const OPERATING_NOTE_CATEGORIES = ['provider_quirk', 'pattern_to_avoid', 'recovery_lesson'] as const
export type OperatingNoteCategory = typeof OPERATING_NOTE_CATEGORIES[number]
export const isOperatingNoteCategory = makeGuard(OPERATING_NOTE_CATEGORIES)

export interface NoteUpsertRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    /** Free text (local IPC — see the section note). */
    text: string
    category?: OperatingNoteCategory
    pinned?: boolean
    /** Explicit expiry, ISO-8601. */
    expiresAt?: string
    /** Note id (or subject key) this note supersedes. */
    supersedes?: string
    subjectKey?: string
    /** Best-effort identity of the recording coordinator (session id / daemon id / host). */
    sourceCoordinator?: string
}

export interface NoteUpsertResponse {
    noteId: string
    /** True when the same text was already among the recent live notes (no new note). */
    deduped: boolean
    createdAt: string
}

function isOptionalShortString(value: unknown, max = 512): boolean {
    return value === undefined || (typeof value === 'string' && value.trim().length > 0 && value.length <= max)
}

export function isNoteUpsertRequest(value: unknown): value is NoteUpsertRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'text', 'category', 'pinned', 'expiresAt', 'supersedes', 'subjectKey', 'sourceCoordinator'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION) return false
    if (!isEvidenceIdentifier(value.meshId)) return false
    if (typeof value.text !== 'string' || value.text.trim().length === 0) return false
    if (value.category !== undefined && !isOperatingNoteCategory(value.category)) return false
    if (value.pinned !== undefined && typeof value.pinned !== 'boolean') return false
    if (value.expiresAt !== undefined && (typeof value.expiresAt !== 'string' || Number.isNaN(Date.parse(value.expiresAt)))) return false
    return isOptionalShortString(value.supersedes) && isOptionalShortString(value.subjectKey) && isOptionalShortString(value.sourceCoordinator)
}

export function decodeNoteUpsertRequest(value: unknown): NoteUpsertRequest | null {
    return isNoteUpsertRequest(value) ? value : null
}

export function isNoteUpsertResponse(value: unknown): value is NoteUpsertResponse {
    return isRecord(value) && hasOnlyKeys(value, ['noteId', 'deduped', 'createdAt'])
        && isEvidenceIdentifier(value.noteId) && typeof value.deduped === 'boolean' && typeof value.createdAt === 'string'
}

export function decodeNoteUpsertResponse(value: unknown): NoteUpsertResponse | null {
    return isNoteUpsertResponse(value) ? value : null
}

export interface NoteForgetRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    /** At least one of `noteId` / `text` (a text forget retracts every note with that exact text, and any recorded later). */
    noteId?: string
    text?: string
    reason?: string
}

export interface NoteForgetResponse {
    /** Live notes this forget hid. */
    matched: number
    tombstoneId: string
}

export function isNoteForgetRequest(value: unknown): value is NoteForgetRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'noteId', 'text', 'reason'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION) return false
    if (!isEvidenceIdentifier(value.meshId)) return false
    if (value.noteId !== undefined && !isEvidenceIdentifier(value.noteId)) return false
    if (value.text !== undefined && (typeof value.text !== 'string' || value.text.trim().length === 0)) return false
    if (value.noteId === undefined && value.text === undefined) return false
    return value.reason === undefined || typeof value.reason === 'string'
}

export function decodeNoteForgetRequest(value: unknown): NoteForgetRequest | null {
    return isNoteForgetRequest(value) ? value : null
}

export function isNoteForgetResponse(value: unknown): value is NoteForgetResponse {
    return isRecord(value) && hasOnlyKeys(value, ['matched', 'tombstoneId'])
        && typeof value.matched === 'number' && Number.isInteger(value.matched) && value.matched >= 0
        && isEvidenceIdentifier(value.tombstoneId)
}

export function decodeNoteForgetResponse(value: unknown): NoteForgetResponse | null {
    return isNoteForgetResponse(value) ? value : null
}

// ─── command registry ───────────────────────────────────────────────────────

/** The complete, closed set of IPC command names this contract defines. */
export const TURN_IPC_COMMANDS = [
    'turn_observe',
    'mesh_record',
    'turn_cancel',
    'operator_status',
    'turn_query',
    'mesh_index_query',
    'mission_upsert',
    'mission_query',
    'note_upsert',
    'note_forget',
] as const
export type TurnIpcCommand = typeof TURN_IPC_COMMANDS[number]
export const isTurnIpcCommand = makeGuard(TURN_IPC_COMMANDS)

/** Request type keyed by command name — for a generically-typed dispatcher on either end. */
export interface TurnIpcRequestByCommand {
    turn_observe: TurnObserveRequest
    mesh_record: MeshRecordRequest
    turn_cancel: TurnCancelRequest
    operator_status: OperatorStatusRequest
    turn_query: TurnQueryRequest
    mesh_index_query: MeshIndexQueryRequest
    mission_upsert: MissionUpsertRequest
    mission_query: MissionQueryRequest
    note_upsert: NoteUpsertRequest
    note_forget: NoteForgetRequest
}

/** Response type keyed by command name — for a generically-typed dispatcher on either end. */
export interface TurnIpcResponseByCommand {
    turn_observe: TurnObserveResponse
    mesh_record: MeshRecordResponse
    turn_cancel: TurnCancelResponse
    operator_status: OperatorStatusResponse
    turn_query: TurnQueryResponse
    mission_upsert: MissionUpsertResponse
    mission_query: MissionQueryResponse
    mesh_index_query: MeshIndexQueryResponse
    note_upsert: NoteUpsertResponse
    note_forget: NoteForgetResponse
}

