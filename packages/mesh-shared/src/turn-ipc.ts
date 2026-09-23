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

// H2 (mission brief, wiring-unification Phase H — docs/design/2026-09-23-wiring-
// unification.md §7c): free text, same "local IPC is inside the boundary" rationale
// as `goal` above (section note). `MissionBriefWire` is a structural mirror of
// mesh-shared's own `MissionBrief` (mission-brief.ts) rather than importing it —
// this file's guards are all hand-rolled structural checks, and importing the type
// only (not the class) would still couple this wire contract to that module's
// internal shape; a mirror keeps the two independently reviewable, same as every
// other wire type in this file.
export interface MissionBriefWire {
    goal: string
    constraints?: readonly string[]
    doneCriteria?: readonly string[]
    handoffNotes?: readonly string[]
    ownedPaths?: readonly string[]
}

function isStringArray(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function isMissionBriefWire(value: unknown): value is MissionBriefWire {
    if (!isRecord(value) || !hasOnlyKeys(value, ['goal', 'constraints', 'doneCriteria', 'handoffNotes', 'ownedPaths'])) return false
    if (typeof value.goal !== 'string' || value.goal.trim().length === 0) return false
    for (const k of ['constraints', 'doneCriteria', 'handoffNotes', 'ownedPaths'] as const) {
        if (value[k] !== undefined && !isStringArray(value[k])) return false
    }
    return true
}

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
    /**
     * H2: `undefined` = do not touch the stored brief. `null` = explicitly clear it.
     * A present object with no usable `goal` is treated by the daemon's own
     * `normalizeMissionBrief` as "no brief" (see mesh-missions.ts upsertMeshMission) —
     * this wire guard only checks SHAPE, not that decision.
     */
    brief?: MissionBriefWire | null
}

export interface MeshMissionRecordWire {
    id: string
    meshId: string
    title: string
    goal: string
    status: MeshMissionStatusValue
    source?: MeshMissionSourceValue
    /** H2: absent = no brief attached to this mission. */
    brief?: MissionBriefWire
}

export interface MissionUpsertResponse {
    mission: MeshMissionRecordWire
}

function isMeshMissionRecordWire(value: unknown): value is MeshMissionRecordWire {
    if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'meshId', 'title', 'goal', 'status', 'source', 'brief'])) return false
    if (!isEvidenceIdentifier(value.id) || !isEvidenceIdentifier(value.meshId)) return false
    if (typeof value.title !== 'string' || typeof value.goal !== 'string') return false
    if (!isMeshMissionStatusValue(value.status)) return false
    if (value.source !== undefined && !isMeshMissionSourceValue(value.source)) return false
    if (value.brief !== undefined && !isMissionBriefWire(value.brief)) return false
    return true
}

export function isMissionUpsertRequest(value: unknown): value is MissionUpsertRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'id', 'title', 'goal', 'status', 'source', 'brief'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION) return false
    if (!isEvidenceIdentifier(value.meshId)) return false
    if (value.id !== undefined && !isEvidenceIdentifier(value.id)) return false
    if (typeof value.title !== 'string' || value.title.trim().length === 0) return false
    if (value.goal !== undefined && typeof value.goal !== 'string') return false
    if (value.status !== undefined && !isMeshMissionStatusValue(value.status)) return false
    if (value.source !== undefined && !isMeshMissionSourceValue(value.source)) return false
    if (value.brief !== undefined && value.brief !== null && !isMissionBriefWire(value.brief)) return false
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

// ─── mission_list_query ─────────────────────────────────────────────────────
//
// Wiring-unification Phase C, workstream C-W9b.
//
// `mesh-tools-mission.ts`'s own file-header note (2026-09-24, C-W6) flagged
// this exact gap: `mission_query`'s landed response is `{missions:
// MeshMissionRecordWire[]}` only — no `verbose`/`includeMagi`/`withStats`/
// `limit`/`truncated`/`overflowIds`/`historyFold`, all of which
// `listMeshMissionsForTool` (daemon-core `mesh-missions.ts`) computes for the
// `mesh_mission_list` tool. Rather than widen `mission_query` itself (an
// already-landed, already-tested contract other callers rely on for its
// narrow shape), this is an ADDITIVE sibling command carrying
// `listMeshMissionsForTool`'s full output shape — request/response fields
// mirror its options/`MeshMissionListResult` one-for-one (see
// mesh-missions.ts). `goal`/`goalPreview` are free text, same local-IPC
// rationale as `mission_upsert`'s `goal` above.

export interface MissionListQueryRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    statuses?: readonly MeshMissionStatusValue[]
    verbose?: boolean
    includeMagi?: boolean
    withStats?: boolean
    limit?: number
    historyIdLimit?: number
}

export interface MeshMissionTaskAggregateWire {
    total: number
    pending: number
    assigned: number
    completed: number
    failed: number
    cancelled: number
    blocked: number
    lastActivityAt: string | null
}

export interface MeshMissionStatsWire {
    missionId: string
    taskCount: number
    completed: number
    failed: number
    totalDurationMs: number
    wallClockMs: number | null
    retries: number
    incompleteTaskIds: readonly string[]
}

/** Verbose (full-goal) mission row. `goal` present, `goalPreview`/`goalTruncated` absent. */
export interface MissionListSummaryVerboseWire {
    id: string
    meshId: string
    title: string
    goal: string
    status: MeshMissionStatusValue
    source?: MeshMissionSourceValue
    tasks: MeshMissionTaskAggregateWire
    stats?: MeshMissionStatsWire
    /** H2: absent = no brief attached. */
    brief?: MissionBriefWire
}

/** Compact (default) mission row. `goalPreview`/`goalTruncated` present, `goal` absent. */
export interface MissionListSummarySlimWire {
    id: string
    meshId: string
    title: string
    goalPreview: string
    goalTruncated: boolean
    status: MeshMissionStatusValue
    source?: MeshMissionSourceValue
    tasks: MeshMissionTaskAggregateWire
    stats?: MeshMissionStatsWire
    /** H2: absent = no brief attached. */
    brief?: MissionBriefWire
}

export type MissionListSummaryWire = MissionListSummaryVerboseWire | MissionListSummarySlimWire

export interface MeshMissionHistoryFoldWire {
    count: number
    byStatus: Record<string, number>
    missionIds: readonly string[]
    note: string
}

export interface MissionListQueryResponse {
    missions: readonly MissionListSummaryWire[]
    historyFold: MeshMissionHistoryFoldWire | null
    truncated: boolean
    matched: number
    overflowIds?: readonly string[]
}

export function isMissionListQueryRequest(value: unknown): value is MissionListQueryRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'statuses', 'verbose', 'includeMagi', 'withStats', 'limit', 'historyIdLimit'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION) return false
    if (!isEvidenceIdentifier(value.meshId)) return false
    if (value.statuses !== undefined) {
        if (!Array.isArray(value.statuses) || value.statuses.length === 0) return false
        if (!value.statuses.every(isMeshMissionStatusValue)) return false
    }
    if (value.verbose !== undefined && typeof value.verbose !== 'boolean') return false
    if (value.includeMagi !== undefined && typeof value.includeMagi !== 'boolean') return false
    if (value.withStats !== undefined && typeof value.withStats !== 'boolean') return false
    if (value.limit !== undefined && !isNonNegativeInt(value.limit)) return false
    if (value.historyIdLimit !== undefined && !isNonNegativeInt(value.historyIdLimit)) return false
    return true
}

export function decodeMissionListQueryRequest(value: unknown): MissionListQueryRequest | null {
    return isMissionListQueryRequest(value) ? value : null
}

function isMeshMissionTaskAggregateWire(value: unknown): value is MeshMissionTaskAggregateWire {
    const keys = ['total', 'pending', 'assigned', 'completed', 'failed', 'cancelled', 'blocked', 'lastActivityAt'] as const
    if (!isRecord(value) || !hasOnlyKeys(value, keys)) return false
    for (const k of ['total', 'pending', 'assigned', 'completed', 'failed', 'cancelled', 'blocked'] as const) {
        if (!isNonNegativeInt(value[k])) return false
    }
    return value.lastActivityAt === null || typeof value.lastActivityAt === 'string'
}

function isMeshMissionStatsWire(value: unknown): value is MeshMissionStatsWire {
    const keys = ['missionId', 'taskCount', 'completed', 'failed', 'totalDurationMs', 'wallClockMs', 'retries', 'incompleteTaskIds'] as const
    if (!isRecord(value) || !hasOnlyKeys(value, keys)) return false
    if (!isEvidenceIdentifier(value.missionId)) return false
    for (const k of ['taskCount', 'completed', 'failed', 'totalDurationMs', 'retries'] as const) {
        if (!isNonNegativeInt(value[k])) return false
    }
    if (value.wallClockMs !== null && !isNonNegativeInt(value.wallClockMs)) return false
    if (!Array.isArray(value.incompleteTaskIds) || !value.incompleteTaskIds.every(isEvidenceIdentifier)) return false
    return true
}

function isMissionListSummaryWire(value: unknown): value is MissionListSummaryWire {
    if (!isRecord(value)) return false
    const hasGoal = 'goal' in value
    const hasPreview = 'goalPreview' in value && 'goalTruncated' in value
    if (hasGoal === hasPreview) return false // exactly one of the two shapes
    const baseKeys = ['id', 'meshId', 'title', 'status', 'source', 'tasks', 'stats', 'brief'] as const
    const allowed = hasGoal ? [...baseKeys, 'goal'] : [...baseKeys, 'goalPreview', 'goalTruncated']
    if (!hasOnlyKeys(value, allowed)) return false
    if (!isEvidenceIdentifier(value.id) || !isEvidenceIdentifier(value.meshId)) return false
    if (typeof value.title !== 'string') return false
    if (!isMeshMissionStatusValue(value.status)) return false
    if (value.source !== undefined && !isMeshMissionSourceValue(value.source)) return false
    if (!isMeshMissionTaskAggregateWire(value.tasks)) return false
    if (value.stats !== undefined && !isMeshMissionStatsWire(value.stats)) return false
    if (value.brief !== undefined && !isMissionBriefWire(value.brief)) return false
    if (hasGoal && typeof value.goal !== 'string') return false
    if (hasPreview && (typeof value.goalPreview !== 'string' || typeof value.goalTruncated !== 'boolean')) return false
    return true
}

function isMeshMissionHistoryFoldWire(value: unknown): value is MeshMissionHistoryFoldWire {
    if (!isRecord(value) || !hasOnlyKeys(value, ['count', 'byStatus', 'missionIds', 'note'])) return false
    if (!isNonNegativeInt(value.count)) return false
    if (!isRecord(value.byStatus) || !Object.values(value.byStatus).every((n) => isNonNegativeInt(n))) return false
    if (!Array.isArray(value.missionIds) || !value.missionIds.every(isEvidenceIdentifier)) return false
    return typeof value.note === 'string'
}

export function isMissionListQueryResponse(value: unknown): value is MissionListQueryResponse {
    if (!isRecord(value) || !hasOnlyKeys(value, ['missions', 'historyFold', 'truncated', 'matched', 'overflowIds'])) return false
    if (!Array.isArray(value.missions) || !value.missions.every(isMissionListSummaryWire)) return false
    if (value.historyFold !== null && !isMeshMissionHistoryFoldWire(value.historyFold)) return false
    if (typeof value.truncated !== 'boolean') return false
    if (!isNonNegativeInt(value.matched)) return false
    if (value.overflowIds !== undefined && (!Array.isArray(value.overflowIds) || !value.overflowIds.every(isEvidenceIdentifier))) return false
    return true
}

export function decodeMissionListQueryResponse(value: unknown): MissionListQueryResponse | null {
    return isMissionListQueryResponse(value) ? value : null
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

// ─── tool_call_record ───────────────────────────────────────────────────────
//
// Wiring-unification Phase C, workstream C-W9b
// (docs/design/2026-09-23-wiring-unification.md §5 C2 "MCP server" paragraph,
// 2026-09-24 14:00 stamp "C-W9").
//
// Replaces `recordMeshToolCall`/`recordMeshCoordinatorToolCall`
// (`daemon-core/src/mesh/mesh-direct-dispatch.ts`) — an in-process,
// per-mesh-tool-call rate-limit/advisory bump mcp-server called directly
// against its own store handle. Every field is an identifier, a closed enum,
// a boolean or a counter — squarely inside `mesh_record`'s content boundary,
// but this is its own command (not a `mesh_record` payload) because it is a
// COUNTER MUTATION with a computed return value (`rateLimitExceeded`,
// `callsInWindow`, `advisory`), not an append-only scalar record.

export const TOOL_CALLER_ROLES = ['coordinator', 'unknown'] as const
export type ToolCallerRole = typeof TOOL_CALLER_ROLES[number]
export const isToolCallerRole = makeGuard(TOOL_CALLER_ROLES)

export interface ToolCallRecordRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    /** The mesh tool name, e.g. `mesh_status` (identifier, not free text — always a fixed tool-name string). */
    tool: string
    sessionId?: string
    callerRole: ToolCallerRole
}

export interface ToolCallRecordResponse {
    rateLimitExceeded: boolean
    callsInWindow: number
    /** Short machine-oriented advisory string, or null. Never free text describing content. */
    advisory: string | null
}

export function isToolCallRecordRequest(value: unknown): value is ToolCallRecordRequest {
    return isRecord(value) && hasOnlyKeys(value, ['v', 'meshId', 'tool', 'sessionId', 'callerRole'])
        && value.v === TURN_IPC_PROTOCOL_VERSION
        && isEvidenceIdentifier(value.meshId)
        && isEvidenceIdentifier(value.tool)
        && isOptionalId(value.sessionId)
        && isToolCallerRole(value.callerRole)
}

export function decodeToolCallRecordRequest(value: unknown): ToolCallRecordRequest | null {
    return isToolCallRecordRequest(value) ? value : null
}

export function isToolCallRecordResponse(value: unknown): value is ToolCallRecordResponse {
    return isRecord(value) && hasOnlyKeys(value, ['rateLimitExceeded', 'callsInWindow', 'advisory'])
        && typeof value.rateLimitExceeded === 'boolean'
        && isNonNegativeInt(value.callsInWindow)
        && (value.advisory === null || typeof value.advisory === 'string')
}

export function decodeToolCallRecordResponse(value: unknown): ToolCallRecordResponse | null {
    return isToolCallRecordResponse(value) ? value : null
}

// ─── ledger_query ───────────────────────────────────────────────────────────
//
// Wiring-unification Phase C, workstream C-W9b.
//
// Replaces the remaining bare `readLedgerEntries(meshId, opts)` /
// `getLedgerSummary(meshId)` in-process reads that `turn_query` cannot serve
// (§5 C2's `mesh-tools-mission.ts` file-header note, 2026-09-24: "general
// ledger browsing by arbitrary `kind`/`since`/`node` filters —
// `turn_query`'s shape... has no free-form kind-list or node filter, so this
// is a real API mismatch, not a mechanical rename"). `turn_query` stays
// scoped to the turn-ledger's own attempt/event rows; `ledger_query` is the
// general record browse surface (C-W9a: the daemon's `mesh_local_records` plus
// the turn ledger's task outcomes, `readLocalRecords`) `meshTaskHistory` /
// `meshLedgerQuery` / the MAGI ledger-scan helpers need.
//
// CONTENT BOUNDARY: `MeshLedgerEntry.payload` (daemon-core `mesh-ledger.ts`)
// is `Record<string, unknown>` — genuinely unbounded JSON (a MAGI synthesis
// object, a graph plan, a free-text checkpoint message), NOT constrained to
// `mesh_record`'s scalar allow-list. This is fine for the SAME reason
// `mission_upsert`'s `goal` and `note_upsert`'s `text` are fine (see that
// section's note above): this is local IPC between mcp-server and the
// daemon that owns the ledger, both on the operator's own machine — never a
// cross-machine or server hop. `entryPayload` below is therefore an
// intentionally-unvalidated `Record<string, unknown>` passthrough, exactly
// like `MissionUpsertRequest.goal` is unvalidated free text.

export interface LedgerQueryRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    /** One or more ledger `kind` strings (daemon-core `MeshLedgerKind`; mesh-shared cannot import that union, so these are identifiers here). Omitted = every kind. */
    kind?: readonly string[]
    /** ISO-8601 or epoch-ms-as-string — passed through to `readLedgerEntries`'s `since` (parsed via `new Date()`). */
    since?: string
    /** Filter to entries whose nodeId is equivalent to this daemon id (matched via `daemonIdsEquivalent` daemon-side, not raw `===`). */
    node?: string
    tail?: number
    /** Also return `getLedgerSummary(meshId)` alongside the entries — saves a second round trip for callers that want both (the common case: every existing call site fetches both together). */
    includeSummary?: boolean
}

export interface LedgerQueryEntryWire {
    id: string
    meshId: string
    timestamp: string
    kind: string
    nodeId?: string
    sessionId?: string
    providerType?: string
    taskId?: string
    /** Unbounded JSON passthrough — see file section's CONTENT BOUNDARY note. */
    payload: Record<string, unknown>
}

export interface LedgerQuerySummaryWire {
    meshId: string
    totalEntries: number
    taskDispatched: number
    taskCompleted: number
    taskFailed: number
    taskStalled: number
    sessionLaunched: number
    checkpointCreated: number
    lastActivityAt: string | null
    recentFailures: number
}

export interface LedgerQueryResponse {
    entries: readonly LedgerQueryEntryWire[]
    summary?: LedgerQuerySummaryWire
}

export function isLedgerQueryRequest(value: unknown): value is LedgerQueryRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'kind', 'since', 'node', 'tail', 'includeSummary'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION) return false
    if (!isEvidenceIdentifier(value.meshId)) return false
    if (value.kind !== undefined && (!Array.isArray(value.kind) || value.kind.length === 0 || !value.kind.every(isEvidenceIdentifier))) return false
    if (value.since !== undefined && typeof value.since !== 'string') return false
    if (!isOptionalId(value.node)) return false
    if (value.tail !== undefined && !isNonNegativeInt(value.tail)) return false
    if (value.includeSummary !== undefined && typeof value.includeSummary !== 'boolean') return false
    return true
}

export function decodeLedgerQueryRequest(value: unknown): LedgerQueryRequest | null {
    return isLedgerQueryRequest(value) ? value : null
}

const LEDGER_QUERY_ENTRY_KEYS = ['id', 'meshId', 'timestamp', 'kind', 'nodeId', 'sessionId', 'providerType', 'taskId', 'payload'] as const

function isLedgerQueryEntryWire(value: unknown): value is LedgerQueryEntryWire {
    if (!isRecord(value) || !hasOnlyKeys(value, LEDGER_QUERY_ENTRY_KEYS)) return false
    if (!isEvidenceIdentifier(value.id) || !isEvidenceIdentifier(value.meshId)) return false
    if (typeof value.timestamp !== 'string' || typeof value.kind !== 'string') return false
    if (!isOptionalId(value.nodeId) || !isOptionalId(value.sessionId) || !isOptionalId(value.providerType) || !isOptionalId(value.taskId)) return false
    if (!isRecord(value.payload)) return false
    return true
}

function isLedgerQuerySummaryWire(value: unknown): value is LedgerQuerySummaryWire {
    const keys = ['meshId', 'totalEntries', 'taskDispatched', 'taskCompleted', 'taskFailed', 'taskStalled', 'sessionLaunched', 'checkpointCreated', 'lastActivityAt', 'recentFailures'] as const
    if (!isRecord(value) || !hasOnlyKeys(value, keys)) return false
    if (!isEvidenceIdentifier(value.meshId)) return false
    for (const k of ['totalEntries', 'taskDispatched', 'taskCompleted', 'taskFailed', 'taskStalled', 'sessionLaunched', 'checkpointCreated', 'recentFailures'] as const) {
        if (!isNonNegativeInt(value[k])) return false
    }
    if (value.lastActivityAt !== null && typeof value.lastActivityAt !== 'string') return false
    return true
}

export function isLedgerQueryResponse(value: unknown): value is LedgerQueryResponse {
    if (!isRecord(value) || !hasOnlyKeys(value, ['entries', 'summary'])) return false
    if (!Array.isArray(value.entries) || !value.entries.every(isLedgerQueryEntryWire)) return false
    if (value.summary !== undefined && !isLedgerQuerySummaryWire(value.summary)) return false
    return true
}

export function decodeLedgerQueryResponse(value: unknown): LedgerQueryResponse | null {
    return isLedgerQueryResponse(value) ? value : null
}

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

function isRecordArray(value: unknown): value is readonly Record<string, unknown>[] {
    return Array.isArray(value) && value.every(isRecord)
}

function isOptionalRecord(value: unknown): boolean {
    return value === undefined || isRecord(value)
}

function isOptionalBoolean(value: unknown): boolean {
    return value === undefined || typeof value === 'boolean'
}

function isOptionalString(value: unknown): boolean {
    return value === undefined || typeof value === 'string'
}

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

export function isRecordLocalRequest(value: unknown): value is RecordLocalRequest {
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

export function isRecordLocalResponse(value: unknown): value is RecordLocalResponse {
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
}

export interface QueueQueryResponse {
    entries: readonly QueueEntryWire[]
}

export function isQueueQueryRequest(value: unknown): value is QueueQueryRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'statuses', 'taskId', 'view'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION || !isEvidenceIdentifier(value.meshId)) return false
    if (value.statuses !== undefined && (!Array.isArray(value.statuses) || !value.statuses.every(isEvidenceIdentifier))) return false
    return isOptionalId(value.taskId) && isOptionalBoolean(value.view)
}

export function decodeQueueQueryRequest(value: unknown): QueueQueryRequest | null {
    return isQueueQueryRequest(value) ? value : null
}

export function isQueueQueryResponse(value: unknown): value is QueueQueryResponse {
    return isRecord(value) && hasOnlyKeys(value, ['entries']) && Array.isArray(value.entries) && value.entries.every(isQueueEntryWire)
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

export function isQueueEnqueueRequest(value: unknown): value is QueueEnqueueRequest {
    return isRecord(value) && hasOnlyKeys(value, ['v', 'meshId', 'message', 'options', 'decision'])
        && value.v === TURN_IPC_PROTOCOL_VERSION && isEvidenceIdentifier(value.meshId)
        && typeof value.message === 'string'
        && isOptionalRecord(value.options) && isOptionalRecord(value.decision)
}

export function decodeQueueEnqueueRequest(value: unknown): QueueEnqueueRequest | null {
    return isQueueEnqueueRequest(value) ? value : null
}

export function isQueueEnqueueResponse(value: unknown): value is QueueEnqueueResponse {
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

export function isQueueEnqueueGraphRequest(value: unknown): value is QueueEnqueueGraphRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'mode', 'specs', 'plan', 'audit'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION || !isEvidenceIdentifier(value.meshId)) return false
    if (value.mode === 'compat') return isRecordArray(value.specs) && value.plan === undefined && isOptionalRecord(value.audit)
    if (value.mode === 'graph') return isRecord(value.plan) && value.specs === undefined && isOptionalRecord(value.audit)
    return false
}

export function decodeQueueEnqueueGraphRequest(value: unknown): QueueEnqueueGraphRequest | null {
    return isQueueEnqueueGraphRequest(value) ? value : null
}

export function isQueueEnqueueGraphResponse(value: unknown): value is QueueEnqueueGraphResponse {
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

export function isQueueCancelRequest(value: unknown): value is QueueCancelRequest {
    return isRecord(value) && hasOnlyKeys(value, ['v', 'meshId', 'taskId', 'reason'])
        && value.v === TURN_IPC_PROTOCOL_VERSION && isEvidenceIdentifier(value.meshId) && isEvidenceIdentifier(value.taskId)
        && isOptionalString(value.reason)
}

export function decodeQueueCancelRequest(value: unknown): QueueCancelRequest | null {
    return isQueueCancelRequest(value) ? value : null
}

export function isQueueCancelResponse(value: unknown): value is QueueCancelResponse {
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

export function isQueueRequeueRequest(value: unknown): value is QueueRequeueRequest {
    return isRecord(value) && hasOnlyKeys(value, ['v', 'meshId', 'taskId', 'options'])
        && value.v === TURN_IPC_PROTOCOL_VERSION && isEvidenceIdentifier(value.meshId) && isEvidenceIdentifier(value.taskId)
        && isOptionalRecord(value.options)
}

export function decodeQueueRequeueRequest(value: unknown): QueueRequeueRequest | null {
    return isQueueRequeueRequest(value) ? value : null
}

export function isQueueRequeueResponse(value: unknown): value is QueueRequeueResponse {
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

export function isDirectDispatchRecordRequest(value: unknown): value is DirectDispatchRecordRequest {
    return isRecord(value) && hasOnlyKeys(value, ['v', 'meshId', 'taskId', 'message', 'task', 'decision'])
        && value.v === TURN_IPC_PROTOCOL_VERSION && isEvidenceIdentifier(value.meshId) && isEvidenceIdentifier(value.taskId)
        && typeof value.message === 'string' && isOptionalRecord(value.task) && isOptionalRecord(value.decision)
}

export function decodeDirectDispatchRecordRequest(value: unknown): DirectDispatchRecordRequest | null {
    return isDirectDispatchRecordRequest(value) ? value : null
}

export function isDirectDispatchRecordResponse(value: unknown): value is DirectDispatchRecordResponse {
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
export const isGraphAuditEvent = makeGuard(GRAPH_AUDIT_EVENTS)

export interface GraphAuditRecordRequest {
    v: typeof TURN_IPC_PROTOCOL_VERSION
    meshId: string
    event: GraphAuditEvent
    fields: Record<string, unknown>
}

export interface GraphAuditRecordResponse {
    recorded: boolean
}

export function isGraphAuditRecordRequest(value: unknown): value is GraphAuditRecordRequest {
    return isRecord(value) && hasOnlyKeys(value, ['v', 'meshId', 'event', 'fields'])
        && value.v === TURN_IPC_PROTOCOL_VERSION && isEvidenceIdentifier(value.meshId)
        && isGraphAuditEvent(value.event) && isRecord(value.fields)
}

export function decodeGraphAuditRecordRequest(value: unknown): GraphAuditRecordRequest | null {
    return isGraphAuditRecordRequest(value) ? value : null
}

export function isGraphAuditRecordResponse(value: unknown): value is GraphAuditRecordResponse {
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
    /** The caller's mesh snapshot (required for the scheduling runtime), JSON passthrough. */
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

export function isActiveWorkQueryRequest(value: unknown): value is ActiveWorkQueryRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'nodes', 'queue', 'recordTail', 'includeTerminalDirect', 'compute', 'includeInputs', 'includeSummary', 'includeSchedulingRuntime', 'mesh'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION || !isEvidenceIdentifier(value.meshId)) return false
    if (value.nodes !== undefined && !isRecordArray(value.nodes)) return false
    if (value.queue !== undefined && !isRecordArray(value.queue)) return false
    if (value.recordTail !== undefined && !isNonNegativeInt(value.recordTail)) return false
    if (value.includeSchedulingRuntime === true && !isRecord(value.mesh)) return false
    return isOptionalBoolean(value.includeTerminalDirect) && isOptionalBoolean(value.compute) && isOptionalBoolean(value.includeInputs)
        && isOptionalBoolean(value.includeSummary) && isOptionalBoolean(value.includeSchedulingRuntime) && isOptionalRecord(value.mesh)
}

export function decodeActiveWorkQueryRequest(value: unknown): ActiveWorkQueryRequest | null {
    return isActiveWorkQueryRequest(value) ? value : null
}

export function isActiveWorkQueryResponse(value: unknown): value is ActiveWorkQueryResponse {
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
}

export interface RecoveryContextQueryResponse {
    context: Record<string, unknown>
}

export function isRecoveryContextQueryRequest(value: unknown): value is RecoveryContextQueryRequest {
    return isRecord(value) && hasOnlyKeys(value, ['v', 'meshId', 'nodeId', 'sessionId', 'maxRetries'])
        && value.v === TURN_IPC_PROTOCOL_VERSION && isEvidenceIdentifier(value.meshId)
        && isOptionalId(value.nodeId) && isOptionalId(value.sessionId)
        && (value.maxRetries === undefined || isNonNegativeInt(value.maxRetries))
        && (value.nodeId !== undefined || value.sessionId !== undefined)
}

export function decodeRecoveryContextQueryRequest(value: unknown): RecoveryContextQueryRequest | null {
    return isRecoveryContextQueryRequest(value) ? value : null
}

export function isRecoveryContextQueryResponse(value: unknown): value is RecoveryContextQueryResponse {
    return isRecord(value) && hasOnlyKeys(value, ['context']) && isRecord(value.context)
        && typeof value.context.consecutiveNodeFailures === 'number'
}

export function decodeRecoveryContextQueryResponse(value: unknown): RecoveryContextQueryResponse | null {
    return isRecoveryContextQueryResponse(value) ? value : null
}

// ─── graph_gate_claim / graph_gate_release / graph_gate_abandon / graph_node_patch / graph_view_query ──
//
// Wiring-unification Phase C, workstream C-W9c (2026-09-24 19:00 stamp
// "mcp-server graph gates/plan/patch ... still call daemon-core in-process").
//
// `mesh-tools-graph.ts`'s five graph-orchestration tools (`mesh_graph_gate_claim`
// / `_release` / `_abandon`, `mesh_graph_node_patch`, `mesh_graph_view`) called
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
    /** Also collect `collectGateConvergenceEvidence` on a successful claim (mesh_graph_gate_claim's own behavior). */
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

export function isGraphGateClaimRequest(value: unknown): value is GraphGateClaimRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'gateId', 'coordinatorSessionId', 'leaseSeconds', 'extendDeadlineSeconds', 'probeConvergenceEvidence'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION || !isEvidenceIdentifier(value.meshId) || !isEvidenceIdentifier(value.gateId) || !isEvidenceIdentifier(value.coordinatorSessionId)) return false
    if (value.leaseSeconds !== undefined && !isFiniteNumber(value.leaseSeconds)) return false
    if (value.extendDeadlineSeconds !== undefined && !isFiniteNumber(value.extendDeadlineSeconds)) return false
    return isOptionalBoolean(value.probeConvergenceEvidence)
}

export function decodeGraphGateClaimRequest(value: unknown): GraphGateClaimRequest | null {
    return isGraphGateClaimRequest(value) ? value : null
}

export function isGraphGateClaimResponse(value: unknown): value is GraphGateClaimResponse {
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
// `mesh_graph_gate_release`'s tool layer classifies `refusalCode` by prefix
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

export function isGraphGateReleaseRequest(value: unknown): value is GraphGateReleaseRequest {
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

export function isGraphGateReleaseResponse(value: unknown): value is GraphGateReleaseResponse {
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

export function isGraphGateAbandonRequest(value: unknown): value is GraphGateAbandonRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'gateId', 'reason', 'coordinatorSessionId', 'force'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION || !isEvidenceIdentifier(value.meshId) || !isEvidenceIdentifier(value.gateId)) return false
    if (typeof value.reason !== 'string' || !value.reason) return false
    if (value.coordinatorSessionId !== undefined && !isEvidenceIdentifier(value.coordinatorSessionId)) return false
    return isOptionalBoolean(value.force)
}

export function decodeGraphGateAbandonRequest(value: unknown): GraphGateAbandonRequest | null {
    return isGraphGateAbandonRequest(value) ? value : null
}

export function isGraphGateAbandonResponse(value: unknown): value is GraphGateAbandonResponse {
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

export function isGraphNodePatchRequest(value: unknown): value is GraphNodePatchRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'node', 'graphId', 'baseSpecPatch'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION || !isEvidenceIdentifier(value.meshId)) return false
    if (typeof value.node !== 'string' || !value.node) return false
    if (value.graphId !== undefined && !isEvidenceIdentifier(value.graphId)) return false
    return isRecord(value.baseSpecPatch) && Object.keys(value.baseSpecPatch).length > 0
}

export function decodeGraphNodePatchRequest(value: unknown): GraphNodePatchRequest | null {
    return isGraphNodePatchRequest(value) ? value : null
}

export function isGraphNodePatchResponse(value: unknown): value is GraphNodePatchResponse {
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

export function isGraphViewQueryResponse(value: unknown): value is GraphViewQueryResponse {
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
}

export interface TaskStatsQueryResponse {
    /** `MeshTaskStats[]`, JSON passthrough. */
    tasks: readonly Record<string, unknown>[]
    /** `MeshMissionStats`, JSON passthrough; present only when `rollup: true` was requested and satisfiable. */
    mission?: Record<string, unknown>
}

export function isTaskStatsQueryRequest(value: unknown): value is TaskStatsQueryRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'taskIds', 'missionId', 'tail', 'rollup'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION || !isEvidenceIdentifier(value.meshId)) return false
    if (value.taskIds !== undefined) {
        if (!Array.isArray(value.taskIds) || value.taskIds.length === 0 || !value.taskIds.every(isEvidenceIdentifier)) return false
    }
    if (value.missionId !== undefined && !isEvidenceIdentifier(value.missionId)) return false
    if (value.tail !== undefined && !isNonNegativeInt(value.tail)) return false
    if (value.rollup === true && value.missionId === undefined) return false
    return isOptionalBoolean(value.rollup)
}

export function decodeTaskStatsQueryRequest(value: unknown): TaskStatsQueryRequest | null {
    return isTaskStatsQueryRequest(value) ? value : null
}

export function isTaskStatsQueryResponse(value: unknown): value is TaskStatsQueryResponse {
    return isRecord(value) && hasOnlyKeys(value, ['tasks', 'mission']) && isRecordArray(value.tasks) && isOptionalRecord(value.mission)
}

export function decodeTaskStatsQueryResponse(value: unknown): TaskStatsQueryResponse | null {
    return isTaskStatsQueryResponse(value) ? value : null
}

// ─── prune_stale_direct ─────────────────────────────────────────────────────
//
// C-W9c: replaces the in-process `pruneStaleDirectDispatches` call
// (`mesh_prune_stale_direct` tool, `mesh-tools-session.ts`). Unlike the other
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

export function isPruneStaleDirectRequest(value: unknown): value is PruneStaleDirectRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'execute', 'includeTerminal', 'source'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION || !isEvidenceIdentifier(value.meshId)) return false
    if (value.source !== undefined && typeof value.source !== 'string') return false
    return isOptionalBoolean(value.execute) && isOptionalBoolean(value.includeTerminal)
}

export function decodePruneStaleDirectRequest(value: unknown): PruneStaleDirectRequest | null {
    return isPruneStaleDirectRequest(value) ? value : null
}

export function isPruneStaleDirectResponse(value: unknown): value is PruneStaleDirectResponse {
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

export function isOrphanedPinNotifyRequest(value: unknown): value is OrphanedPinNotifyRequest {
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

export function isOrphanedPinNotifyResponse(value: unknown): value is OrphanedPinNotifyResponse {
    return isRecord(value) && hasOnlyKeys(value, ['orphans']) && Array.isArray(value.orphans) && value.orphans.every(isOrphanedPinnedTaskWire)
}

export function decodeOrphanedPinNotifyResponse(value: unknown): OrphanedPinNotifyResponse | null {
    return isOrphanedPinNotifyResponse(value) ? value : null
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
    // C-W9b additions (2026-09-24 14:00 stamp "C-W9"):
    'tool_call_record',
    'ledger_query',
    'mission_list_query',
    // C-W9a additions (the event ledger retired; the queue behind IPC):
    'record_local',
    'queue_query',
    'queue_enqueue',
    'queue_enqueue_graph',
    'queue_cancel',
    'queue_requeue',
    'direct_dispatch_record',
    'graph_audit_record',
    'active_work_query',
    'recovery_context_query',
    // C-W9c additions (2026-09-24 19:00 stamp — the last mcp-server in-process
    // daemon-core paths: graph gates/plan/patch, mission reads (MAGI), task/
    // mission stats, orphaned-pin helpers, one prune audit):
    'graph_gate_claim',
    'graph_gate_release',
    'graph_gate_abandon',
    'graph_node_patch',
    'graph_view_query',
    'task_stats_query',
    'prune_stale_direct',
    'orphaned_pin_notify',
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
    tool_call_record: ToolCallRecordRequest
    ledger_query: LedgerQueryRequest
    mission_list_query: MissionListQueryRequest
    record_local: RecordLocalRequest
    queue_query: QueueQueryRequest
    queue_enqueue: QueueEnqueueRequest
    queue_enqueue_graph: QueueEnqueueGraphRequest
    queue_cancel: QueueCancelRequest
    queue_requeue: QueueRequeueRequest
    direct_dispatch_record: DirectDispatchRecordRequest
    graph_audit_record: GraphAuditRecordRequest
    active_work_query: ActiveWorkQueryRequest
    recovery_context_query: RecoveryContextQueryRequest
    graph_gate_claim: GraphGateClaimRequest
    graph_gate_release: GraphGateReleaseRequest
    graph_gate_abandon: GraphGateAbandonRequest
    graph_node_patch: GraphNodePatchRequest
    graph_view_query: GraphViewQueryRequest
    task_stats_query: TaskStatsQueryRequest
    prune_stale_direct: PruneStaleDirectRequest
    orphaned_pin_notify: OrphanedPinNotifyRequest
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
    tool_call_record: ToolCallRecordResponse
    ledger_query: LedgerQueryResponse
    mission_list_query: MissionListQueryResponse
    record_local: RecordLocalResponse
    queue_query: QueueQueryResponse
    queue_enqueue: QueueEnqueueResponse
    queue_enqueue_graph: QueueEnqueueGraphResponse
    queue_cancel: QueueCancelResponse
    queue_requeue: QueueRequeueResponse
    direct_dispatch_record: DirectDispatchRecordResponse
    graph_audit_record: GraphAuditRecordResponse
    active_work_query: ActiveWorkQueryResponse
    recovery_context_query: RecoveryContextQueryResponse
    graph_gate_claim: GraphGateClaimResponse
    graph_gate_release: GraphGateReleaseResponse
    graph_gate_abandon: GraphGateAbandonResponse
    graph_node_patch: GraphNodePatchResponse
    graph_view_query: GraphViewQueryResponse
    task_stats_query: TaskStatsQueryResponse
    prune_stale_direct: PruneStaleDirectResponse
    orphaned_pin_notify: OrphanedPinNotifyResponse
}

