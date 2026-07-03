/**
 * Canonical mesh-session record normalizer shared by the cloud (web-core) mesh
 * paths. Parses an already-transit-shaped session record into a typed
 * RepoMeshSessionStatus.
 */

import { readBoolean, readRecord, readString } from './json'
import type { RepoMeshSessionStatus } from './types'

/**
 * Build a deterministic synthetic session id from a record that has no explicit
 * id. Two transit refreshes of the same logical session produce the same id so
 * downstream dedupe stays stable across refreshes (a random id would create a new
 * node every poll). Derived from the stable identifying fields available on the
 * record; prefixed "synthetic:" so callers can tell it apart from a real id.
 */
function deriveSyntheticSessionId(record: ReturnType<typeof readRecord>): string | undefined {
    const parts = [
        readString(record.workspace),
        readString(record.providerType, record.provider),
        readString(record.role),
        readString(record.state, record.status),
        readString(record.title),
        readString(record.createdAt, record.created_at),
        readString(record.startedAt, record.started_at),
    ].filter((part): part is string => Boolean(part))
    if (parts.length === 0) return undefined
    return `synthetic:${parts.join('|')}`
}

/**
 * Session-id equivalence — the sessionId counterpart of daemonIdsEquivalent /
 * meshNodeIdMatches. A session id is SINGLE-FORM: one canonical UUID minted once
 * via crypto.randomUUID() in the provider instance and carried verbatim across
 * daemons, with no node/daemon-id style serialization variants. Equivalence is
 * therefore an exact match after trimming, never matching an absent/empty id
 * against another absent/empty id. Routing every mesh comparison site through
 * this one predicate keeps that single-form policy in one place (and gives any
 * future session-id aliasing a single seam) instead of scattering raw `===`.
 */
export function sessionIdsEquivalent(a: string | null | undefined, b: string | null | undefined): boolean {
    const idA = readString(a)
    const idB = readString(b)
    if (!idA || !idB) return false
    return idA === idB
}

export function normalizeMeshSessionRecord(entry: unknown): RepoMeshSessionStatus | null {
    const record = readRecord(entry)
    // BUG FIX: cloud transit can reshape/strip the explicit id field. Fall back
    // through sessionId → session_id → id, then to a DETERMINISTIC synthetic id
    // derived from record content so the session survives the round trip instead
    // of being dropped (and so dedupe stays stable across refreshes). Return null
    // ONLY when the record carries no identifying fields at all.
    const sessionId = readString(record.sessionId, record.session_id, record.id)
        ?? deriveSyntheticSessionId(record)
    if (!sessionId) return null
    return {
        sessionId,
        ...(readString(record.providerType, record.provider) ? { providerType: readString(record.providerType, record.provider) } : {}),
        ...(readString(record.state, record.status) ? { state: readString(record.state, record.status) } : {}),
        ...(readString(record.chatStatus, record.chat_status) ? { chatStatus: readString(record.chatStatus, record.chat_status) } : {}),
        ...(readString(record.lifecycle) ? { lifecycle: readString(record.lifecycle) as RepoMeshSessionStatus['lifecycle'] } : {}),
        ...(readString(record.surfaceKind, record.surface_kind) ? { surfaceKind: readString(record.surfaceKind, record.surface_kind) as RepoMeshSessionStatus['surfaceKind'] } : {}),
        ...(readString(record.recoveryState, record.recovery_state) ? { recoveryState: readString(record.recoveryState, record.recovery_state) } : {}),
        ...(readString(record.workspace) ? { workspace: readString(record.workspace) } : {}),
        ...(readString(record.title) ? { title: readString(record.title) } : {}),
        ...(readString(record.role) ? { role: readString(record.role) } : {}),
        ...(readBoolean(record.isSelfCoordinator, record.is_self_coordinator) !== undefined ? { isSelfCoordinator: readBoolean(record.isSelfCoordinator, record.is_self_coordinator) } : {}),
        ...(readString(record.statusNote, record.status_note) ? { statusNote: readString(record.statusNote, record.status_note) } : {}),
        ...(readString(record.createdAt, record.created_at) ? { createdAt: readString(record.createdAt, record.created_at) } : {}),
        ...(readString(record.startedAt, record.started_at) ? { startedAt: readString(record.startedAt, record.started_at) } : {}),
        ...(readString(record.lastActivityAt, record.last_activity_at) ? { lastActivityAt: readString(record.lastActivityAt, record.last_activity_at) } : {}),
        ...(readBoolean(record.isCached, record.is_cached) !== undefined ? { isCached: readBoolean(record.isCached, record.is_cached) } : {}),
    }
}
