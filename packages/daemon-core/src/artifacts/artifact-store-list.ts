/**
 * Bounded list / SQL keyset helpers for ArtifactStore (file-size split).
 */

import {
    ArtifactGuardError,
    MAX_ARTIFACTS_PER_MESH,
    MAX_ARTIFACTS_PER_MISSION,
    MAX_ARTIFACTS_PER_SESSION,
    MAX_ARTIFACT_LIST_PAGE,
    type ArtifactKind,
    type ArtifactRecord,
} from './types.js';

export interface ArtifactListDatabase {
    prepare<Row = any>(sql: string): {
        get(...params: unknown[]): Row | undefined;
        all(...params: unknown[]): Row[];
    };
}

interface SessionArtifactDbRow {
    artifact_id: string;
    session_id: string;
    task_id: string | null;
    mesh_id?: string | null;
    mission_id?: string | null;
    producer_role?: string | null;
    origin_daemon_id?: string | null;
    workspace_root: string;
    rel_path: string;
    kind: ArtifactKind;
    mime: string;
    title: string;
    size_bytes: number;
    sha256: string;
    preview_text: string | null;
    created_at: number;
    updated_at: number;
}

export interface ArtifactListCursor {
    createdAt: number;
    artifactId: string;
}

export interface ListMeshArtifactsKeysetOptions {
    sessionId?: string;
    missionId?: string;
    kind?: ArtifactKind | string;
    cursor?: ArtifactListCursor | null;
    limit?: number;
}

export interface ListMeshArtifactsKeysetResult {
    records: ArtifactRecord[];
    hasMore: boolean;
    nextCursor: string | null;
}

function rowToArtifactRecord(row: SessionArtifactDbRow): ArtifactRecord {
    return {
        artifactId: row.artifact_id,
        sessionId: row.session_id,
        taskId: row.task_id ?? null,
        ...(row.mesh_id != null ? { meshId: row.mesh_id } : {}),
        ...(row.mission_id != null ? { missionId: row.mission_id } : {}),
        ...(row.producer_role != null ? { producerRole: row.producer_role } : {}),
        ...(row.origin_daemon_id != null ? { originDaemonId: row.origin_daemon_id } : {}),
        workspaceRoot: row.workspace_root,
        relPath: row.rel_path,
        kind: row.kind,
        mime: row.mime,
        title: row.title,
        sizeBytes: row.size_bytes,
        sha256: row.sha256,
        previewText: row.preview_text ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function newestWindowSql(filteredSelect: string): string {
    return `SELECT * FROM (${filteredSelect}
                 ORDER BY created_at DESC, window_rowid DESC
                 LIMIT ?)
             ORDER BY created_at ASC, window_rowid ASC`;
}

export function listArtifactsBySession(
    db: ArtifactListDatabase,
    sessionId: string,
    options?: { limit?: number },
): ArtifactRecord[] {
    if (typeof sessionId !== 'string' || !sessionId) return [];
    const rawLimit = options?.limit;
    const limit =
        typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
            ? Math.min(Math.trunc(rawLimit), MAX_ARTIFACTS_PER_SESSION)
            : MAX_ARTIFACTS_PER_SESSION;
    const rows = db
        .prepare<SessionArtifactDbRow>(
            `SELECT * FROM session_artifacts
             WHERE session_id = ?
             ORDER BY created_at ASC, rowid ASC
             LIMIT ?`,
        )
        .all(sessionId, limit);
    return rows.map(rowToArtifactRecord);
}

export function listArtifactsByMesh(
    db: ArtifactListDatabase,
    meshId: string,
    options?: { sessionId?: string; missionId?: string; limit?: number },
): ArtifactRecord[] {
    if (typeof meshId !== 'string' || !meshId.trim()) return [];
    const rawLimit = options?.limit;
    const limit =
        typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
            ? Math.min(Math.trunc(rawLimit), MAX_ARTIFACTS_PER_MESH)
            : MAX_ARTIFACTS_PER_MESH;
    const clauses: string[] = ['mesh_id = ?'];
    const params: unknown[] = [meshId.trim()];
    if (typeof options?.sessionId === 'string' && options.sessionId.trim()) {
        clauses.push('session_id = ?');
        params.push(options.sessionId.trim());
    }
    if (typeof options?.missionId === 'string' && options.missionId.trim()) {
        clauses.push('mission_id = ?');
        params.push(options.missionId.trim());
    }
    params.push(limit);
    const rows = db
        .prepare<SessionArtifactDbRow>(
            newestWindowSql(`SELECT rowid AS window_rowid, * FROM session_artifacts
             WHERE ${clauses.join(' AND ')}`),
        )
        .all(...params);
    return rows.map(rowToArtifactRecord);
}

export function listArtifactsByMission(
    db: ArtifactListDatabase,
    missionId: string,
    options?: { artifactIds?: readonly string[]; limit?: number; meshId?: string },
): ArtifactRecord[] {
    if (typeof missionId !== 'string' || !missionId.trim()) return [];
    const meshFilter = typeof options?.meshId === 'string' && options.meshId.trim() ? options.meshId.trim() : '';
    const meshClause = meshFilter ? ' AND mesh_id = ?' : '';
    const meshParams: string[] = meshFilter ? [meshFilter] : [];
    const rawLimit = options?.limit;
    const limit =
        typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
            ? Math.min(Math.trunc(rawLimit), MAX_ARTIFACTS_PER_MISSION)
            : MAX_ARTIFACTS_PER_MISSION;
    if (options?.artifactIds !== undefined) {
        const ids = options.artifactIds.filter((id) => typeof id === 'string' && id.trim().length > 0);
        if (ids.length === 0) return [];
        const placeholders = ids.map(() => '?').join(', ');
        const rows = db
            .prepare<SessionArtifactDbRow>(
                newestWindowSql(`SELECT rowid AS window_rowid, * FROM session_artifacts
                 WHERE mission_id = ?${meshClause} AND artifact_id IN (${placeholders})`),
            )
            .all(missionId.trim(), ...meshParams, ...ids, limit);
        return rows.map(rowToArtifactRecord);
    }
    const rows = db
        .prepare<SessionArtifactDbRow>(
            newestWindowSql(`SELECT rowid AS window_rowid, * FROM session_artifacts
             WHERE mission_id = ?${meshClause}`),
        )
        .all(missionId.trim(), ...meshParams, limit);
    return rows.map(rowToArtifactRecord);
}

export function listArtifactsByMeshKeyset(
    db: ArtifactListDatabase,
    meshId: string,
    options?: ListMeshArtifactsKeysetOptions,
): ListMeshArtifactsKeysetResult {
    if (typeof meshId !== 'string' || !meshId.trim()) {
        return { records: [], hasMore: false, nextCursor: null };
    }
    const rawLimit = options?.limit;
    const limit =
        typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
            ? Math.min(Math.trunc(rawLimit), MAX_ARTIFACT_LIST_PAGE)
            : Math.min(MAX_ARTIFACT_LIST_PAGE, MAX_ARTIFACTS_PER_MESH);
    const clauses: string[] = ['mesh_id = ?'];
    const params: unknown[] = [meshId.trim()];
    if (typeof options?.sessionId === 'string' && options.sessionId.trim()) {
        clauses.push('session_id = ?');
        params.push(options.sessionId.trim());
    }
    if (typeof options?.missionId === 'string' && options.missionId.trim()) {
        clauses.push('mission_id = ?');
        params.push(options.missionId.trim());
    }
    if (typeof options?.kind === 'string' && options.kind.trim()) {
        clauses.push('kind = ?');
        params.push(options.kind.trim());
    }
    const cursor = options?.cursor ?? null;
    if (cursor) {
        const cursorRow = db
            .prepare<{ artifact_id: string; mesh_id: string | null; created_at: number }>(
                `SELECT artifact_id, mesh_id, created_at FROM session_artifacts WHERE artifact_id = ?`,
            )
            .get(cursor.artifactId);
        if (
            !cursorRow ||
            cursorRow.mesh_id !== meshId.trim() ||
            cursorRow.created_at !== cursor.createdAt
        ) {
            throw new ArtifactGuardError(
                'stale_cursor',
                `Artifact list cursor is stale or out of scope (stale_cursor)`,
                { cursor, preserved: true, retryable: false },
            );
        }
        clauses.push('(created_at < ? OR (created_at = ? AND artifact_id < ?))');
        params.push(cursor.createdAt, cursor.createdAt, cursor.artifactId);
    }
    params.push(limit + 1);
    const newestFirst = db
        .prepare<SessionArtifactDbRow>(
            `SELECT * FROM session_artifacts
             WHERE ${clauses.join(' AND ')}
             ORDER BY created_at DESC, artifact_id DESC
             LIMIT ?`,
        )
        .all(...params);
    const hasMore = newestFirst.length > limit;
    const pageNewestFirst = hasMore ? newestFirst.slice(0, limit) : newestFirst;
    const page = pageNewestFirst.slice().reverse().map(rowToArtifactRecord);
    return {
        records: page,
        hasMore,
        nextCursor: hasMore && page.length > 0 ? `${page[0]!.createdAt}:${page[0]!.artifactId}` : null,
    };
}
