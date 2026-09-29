/**
 * turn-ipc — mission, note, tool-call and ledger commands: mission_upsert,
 * mission_query, mission_list_query, note_upsert, note_forget, tool_call_record,
 * ledger_query. Part of the turn-ipc wire contract (./turn-ipc.ts).
 */

import {
    makeGuard,
    hasOnlyKeys,
    isStringArray,
    TURN_IPC_PROTOCOL_VERSION,
    isNonNegativeInt,
    isOptionalShortString,
    isOptionalId,
} from './turn-ipc-guards';
import { isRecord } from './protocol/envelope';
import { isEvidenceIdentifier } from './turn-evidence';

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
    /** H2: absent = no brief attached to this mission. */
    brief?: MissionBriefWire
}

export interface MissionUpsertResponse {
    mission: MeshMissionRecordWire
}

function isMeshMissionRecordWire(value: unknown): value is MeshMissionRecordWire {
    if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'meshId', 'title', 'goal', 'status', 'brief'])) return false
    if (!isEvidenceIdentifier(value.id) || !isEvidenceIdentifier(value.meshId)) return false
    if (typeof value.title !== 'string' || typeof value.goal !== 'string') return false
    if (!isMeshMissionStatusValue(value.status)) return false
    if (value.brief !== undefined && !isMissionBriefWire(value.brief)) return false
    return true
}

function isMissionUpsertRequest(value: unknown): value is MissionUpsertRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'id', 'title', 'goal', 'status', 'brief'])) return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION) return false
    if (!isEvidenceIdentifier(value.meshId)) return false
    if (value.id !== undefined && !isEvidenceIdentifier(value.id)) return false
    if (typeof value.title !== 'string' || value.title.trim().length === 0) return false
    if (value.goal !== undefined && typeof value.goal !== 'string') return false
    if (value.status !== undefined && !isMeshMissionStatusValue(value.status)) return false
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

function isMissionQueryRequest(value: unknown): value is MissionQueryRequest {
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

function isMissionQueryResponse(value: unknown): value is MissionQueryResponse {
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
// MeshMissionRecordWire[]}` only — no `verbose`/`withStats`/
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
    withStats?: boolean
    limit?: number
    historyIdLimit?: number
    /**
     * The mesh_status mission projection, computed in the daemon (the MCP no longer
     * opens the daemon's store for it): 'compact' = `getMeshStatusMissionsCompact`
     * (live missions goal-elided + folded history), 'verbose' =
     * `getMeshStatusMissionSummaries({verbose: true})` (live + capped history, full
     * goal, no stats — stats ride one batched `task_stats_query`). Rows then also
     * carry `createdAt`/`updatedAt`/`closeCandidateEmittedAt`. When set, every other
     * option except `historyIdLimit` is ignored. An older daemon rejects the key.
     */
    meshStatusView?: 'compact' | 'verbose'
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
    tasks: MeshMissionTaskAggregateWire
    stats?: MeshMissionStatsWire
    /** H2: absent = no brief attached. */
    brief?: MissionBriefWire
    /** `meshStatusView` rows only. */
    createdAt?: string
    updatedAt?: string
    closeCandidateEmittedAt?: string | null
}

/** Compact (default) mission row. `goalPreview`/`goalTruncated` present, `goal` absent. */
export interface MissionListSummarySlimWire {
    id: string
    meshId: string
    title: string
    goalPreview: string
    goalTruncated: boolean
    status: MeshMissionStatusValue
    tasks: MeshMissionTaskAggregateWire
    stats?: MeshMissionStatsWire
    /** H2: absent = no brief attached. */
    brief?: MissionBriefWire
    /** `meshStatusView` rows only. */
    createdAt?: string
    updatedAt?: string
    closeCandidateEmittedAt?: string | null
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

function isMissionListQueryRequest(value: unknown): value is MissionListQueryRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'meshId', 'statuses', 'verbose', 'withStats', 'limit', 'historyIdLimit', 'meshStatusView'])) return false
    if (value.meshStatusView !== undefined && value.meshStatusView !== 'compact' && value.meshStatusView !== 'verbose') return false
    if (value.v !== TURN_IPC_PROTOCOL_VERSION) return false
    if (!isEvidenceIdentifier(value.meshId)) return false
    if (value.statuses !== undefined) {
        if (!Array.isArray(value.statuses) || value.statuses.length === 0) return false
        if (!value.statuses.every(isMeshMissionStatusValue)) return false
    }
    if (value.verbose !== undefined && typeof value.verbose !== 'boolean') return false
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
    const baseKeys = ['id', 'meshId', 'title', 'status', 'tasks', 'stats', 'brief', 'createdAt', 'updatedAt', 'closeCandidateEmittedAt'] as const
    const allowed = hasGoal ? [...baseKeys, 'goal'] : [...baseKeys, 'goalPreview', 'goalTruncated']
    if (!hasOnlyKeys(value, allowed)) return false
    if (!isEvidenceIdentifier(value.id) || !isEvidenceIdentifier(value.meshId)) return false
    if (typeof value.title !== 'string') return false
    if (!isMeshMissionStatusValue(value.status)) return false
    if (!isMeshMissionTaskAggregateWire(value.tasks)) return false
    if (value.stats !== undefined && !isMeshMissionStatsWire(value.stats)) return false
    if (value.brief !== undefined && !isMissionBriefWire(value.brief)) return false
    if (hasGoal && typeof value.goal !== 'string') return false
    if (hasPreview && (typeof value.goalPreview !== 'string' || typeof value.goalTruncated !== 'boolean')) return false
    if (value.createdAt !== undefined && typeof value.createdAt !== 'string') return false
    if (value.updatedAt !== undefined && typeof value.updatedAt !== 'string') return false
    if (value.closeCandidateEmittedAt !== undefined && value.closeCandidateEmittedAt !== null && typeof value.closeCandidateEmittedAt !== 'string') return false
    return true
}

function isMeshMissionHistoryFoldWire(value: unknown): value is MeshMissionHistoryFoldWire {
    if (!isRecord(value) || !hasOnlyKeys(value, ['count', 'byStatus', 'missionIds', 'note'])) return false
    if (!isNonNegativeInt(value.count)) return false
    if (!isRecord(value.byStatus) || !Object.values(value.byStatus).every((n) => isNonNegativeInt(n))) return false
    if (!Array.isArray(value.missionIds) || !value.missionIds.every(isEvidenceIdentifier)) return false
    return typeof value.note === 'string'
}

function isMissionListQueryResponse(value: unknown): value is MissionListQueryResponse {
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
const isOperatingNoteCategory = makeGuard(OPERATING_NOTE_CATEGORIES)

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

function isNoteUpsertRequest(value: unknown): value is NoteUpsertRequest {
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

function isNoteUpsertResponse(value: unknown): value is NoteUpsertResponse {
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

function isNoteForgetRequest(value: unknown): value is NoteForgetRequest {
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

function isNoteForgetResponse(value: unknown): value is NoteForgetResponse {
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
const isToolCallerRole = makeGuard(TOOL_CALLER_ROLES)

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

function isToolCallRecordRequest(value: unknown): value is ToolCallRecordRequest {
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

function isToolCallRecordResponse(value: unknown): value is ToolCallRecordResponse {
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
// `meshLedgerQuery` need.
//
// CONTENT BOUNDARY: `MeshLedgerEntry.payload` (daemon-core `mesh-ledger.ts`)
// is `Record<string, unknown>` — genuinely unbounded JSON (a graph plan, a free-text checkpoint message), NOT constrained to
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

function isLedgerQueryRequest(value: unknown): value is LedgerQueryRequest {
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

function isLedgerQueryResponse(value: unknown): value is LedgerQueryResponse {
    if (!isRecord(value) || !hasOnlyKeys(value, ['entries', 'summary'])) return false
    if (!Array.isArray(value.entries) || !value.entries.every(isLedgerQueryEntryWire)) return false
    if (value.summary !== undefined && !isLedgerQuerySummaryWire(value.summary)) return false
    return true
}

export function decodeLedgerQueryResponse(value: unknown): LedgerQueryResponse | null {
    return isLedgerQueryResponse(value) ? value : null
}
