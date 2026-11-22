/**
 * SQLite-backed session artifact metadata store & read-time content verifier (Task A).
 *
 * Layering & boundary invariants:
 * - Zero value imports from `../mesh/**` (enforced by import-boundary checks).
 * - Takes a minimal structural SQLite database interface (`ArtifactStoreDatabase`)
 *   compatible with `better-sqlite3` and `MeshRuntimeStore['db']`.
 * - Stores ONLY metadata and bounded 600-char text previews in `session_artifacts`;
 *   raw file bytes are never persisted in SQLite or sent over cloud status paths.
 * - Upserts on `(session_id, rel_path)` inside an immediate transaction so
 *   re-registering the same path retains its `art_<16hex>` ID and updates metadata
 *   even when the session is at the 50-artifact cap.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import {
    assertNotSecretContent,
    assertNotSecretPath,
    resolveArtifactFile,
    sanitizeArtifactTitle,
    type ArtifactTestRaceHooks,
} from './artifact-path-guard.js';

/** Attribution no-op when both empty or both resolve to the same machine core. */
function originDaemonAttributionUnchanged(
    existing: string | null | undefined,
    next: string | null | undefined,
): boolean {
    const a = typeof existing === 'string' && existing.trim() ? existing.trim() : null;
    const b = typeof next === 'string' && next.trim() ? next.trim() : null;
    if (!a && !b) return true;
    if (!a || !b) return false;
    return daemonIdsEquivalent(a, b);
}

/** True when both ids are set and are different machines (alias forms still count as same). */
function originDaemonAttributionConflict(
    existing: string | null | undefined,
    next: string | null | undefined,
): boolean {
    const a = typeof existing === 'string' && existing.trim() ? existing.trim() : null;
    const b = typeof next === 'string' && next.trim() ? next.trim() : null;
    return !!(a && b && !daemonIdsEquivalent(a, b));
}
import {
    assertArtifactAdmissionAllows,
    estimateArtifactMetadataBytes,
    mapStorageErrnoToArtifactError,
    readArtifactAdmissionTotals,
} from './artifact-admission.js';
import {
    listArtifactsByMesh,
    listArtifactsByMeshKeyset,
    listArtifactsByMission,
    listArtifactsBySession,
    type ArtifactListCursor,
    type ListMeshArtifactsKeysetOptions,
    type ListMeshArtifactsKeysetResult,
} from './artifact-store-list.js';
import {
    buildFetchArtifactContentResult,
    readArtifactRecordPaged,
    type FetchArtifactContentOptions,
    type FetchArtifactContentResult,
    type ReadArtifactContentOptions,
    type ReadArtifactContentResult,
} from './artifact-store-read.js';
import {
    ARTIFACT_KINDS,
    ARTIFACT_RETENTION_MS,
    ArtifactGuardError,
    MAX_ARTIFACT_BYTES,
    MAX_PREVIEW_TEXT_CHARS,
    MIME_BY_KIND,
    toChatAttachmentMeta,
    type ArtifactKind,
    type ArtifactProducerRole,
    type ArtifactRecord,
    type ChatAttachmentMeta,
} from './types.js';

export type {
    ArtifactListCursor,
    ListMeshArtifactsKeysetOptions,
    ListMeshArtifactsKeysetResult,
};
export type {
    FetchArtifactContentOptions,
    FetchArtifactContentResult,
    ReadArtifactContentOptions,
    ReadArtifactContentResult,
};

export interface ArtifactStoreStatement<Row = unknown> {
    run(...params: unknown[]): { changes: number; lastInsertRowid?: number | bigint };
    get(...params: unknown[]): Row | undefined;
    all(...params: unknown[]): Row[];
}

export interface ArtifactStoreTransactionFn<T extends (...args: any[]) => any = (...args: any[]) => any> {
    (...args: any[]): ReturnType<T>;
    immediate?: (...args: any[]) => ReturnType<T>;
}

export interface ArtifactStoreDatabase {
    exec(sql: string): unknown;
    prepare<Row = any>(sql: string): ArtifactStoreStatement<Row>;
    transaction?<T extends (...args: any[]) => any>(fn: T): ArtifactStoreTransactionFn<T>;
}

export type ArtifactDatabaseInput =
    | ArtifactStoreDatabase
    | { readonly db: ArtifactStoreDatabase };

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

export interface RegisterArtifactInput {
    sessionId: string;
    workspaceRoot: string;
    /** Workspace-relative or workspace-contained absolute file path. */
    path?: string;
    /** Alias for `path`. */
    relPath?: string;
    /** Alias for `path`. */
    rawPath?: string;
    /** Alias for `path`. */
    filePath?: string;
    taskId?: string | null;
    meshId?: string | null;
    missionId?: string | null;
    producerRole?: ArtifactProducerRole | string | null;
    originDaemonId?: string | null;
    kind?: ArtifactKind;
    declaredKind?: ArtifactKind;
    mime?: string;
    declaredMime?: string;
    title?: string;
    now?: number;
    _testHooks?: ArtifactTestRaceHooks;
}

export interface UpsertForwardedArtifactInput {
    artifactId: string;
    sessionId: string;
    taskId?: string | null;
    meshId?: string | null;
    missionId?: string | null;
    producerRole?: ArtifactProducerRole | string | null;
    originDaemonId?: string | null;
    workspaceRoot: string;
    relPath: string;
    kind: ArtifactKind;
    mime: string;
    title?: string | null;
    sizeBytes: number;
    sha256: string;
    previewText?: string | null;
    createdAt?: number;
    updatedAt?: number;
}

export interface RegisterArtifactResult {
    record: ArtifactRecord;
    isUpdate: boolean;
    attachment: ChatAttachmentMeta;
}

export interface ListSessionArtifactsOptions {
    limit?: number;
}

export const SESSION_ARTIFACTS_SCHEMA_DDL = `
    CREATE TABLE IF NOT EXISTS session_artifacts (
        artifact_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_id TEXT,
        mesh_id TEXT,
        mission_id TEXT,
        producer_role TEXT,
        origin_daemon_id TEXT,
        workspace_root TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        kind TEXT NOT NULL,
        mime TEXT NOT NULL,
        title TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        preview_text TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_artifacts_unique_path
        ON session_artifacts(session_id, rel_path);

    CREATE INDEX IF NOT EXISTS idx_session_artifacts_session
        ON session_artifacts(session_id, created_at);
`;

const SESSION_ARTIFACTS_SHARING_INDEXES_DDL = `
    CREATE INDEX IF NOT EXISTS idx_session_artifacts_mesh
        ON session_artifacts(mesh_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_session_artifacts_mission
        ON session_artifacts(mission_id, created_at);
`;

function unwrapDatabase(input: ArtifactDatabaseInput): ArtifactStoreDatabase {
    if (
        input &&
        typeof input === 'object' &&
        'db' in input &&
        input.db &&
        typeof input.db.prepare === 'function'
    ) {
        return input.db;
    }
    if (input && typeof input === 'object' && typeof (input as ArtifactStoreDatabase).prepare === 'function') {
        return input as ArtifactStoreDatabase;
    }
    throw new TypeError('Invalid ArtifactStoreDatabase: expected SQLite database with prepare() and exec()');
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

/** Generate a stable `art_<16hex>` identifier. */
export function generateArtifactId(): string {
    return `art_${crypto.randomBytes(8).toString('hex')}`;
}

/** Ensure `session_artifacts` table, sharing columns, and indexes exist on the given SQLite handle. */
export function ensureArtifactStoreSchema(dbInput: ArtifactDatabaseInput): void {
    const db = unwrapDatabase(dbInput);
    db.exec(SESSION_ARTIFACTS_SCHEMA_DDL);
    const cols = new Set(
        (db.prepare(`PRAGMA table_info(session_artifacts)`).all() as Array<{ name: string }>).map(
            (r) => r.name,
        ),
    );
    for (const col of ['mesh_id', 'mission_id', 'producer_role', 'origin_daemon_id'] as const) {
        if (!cols.has(col)) {
            db.exec(`ALTER TABLE session_artifacts ADD COLUMN ${col} TEXT`);
        }
    }
    db.exec(SESSION_ARTIFACTS_SHARING_INDEXES_DDL);
}

function runInImmediateTransaction<T>(db: ArtifactStoreDatabase, fn: () => T): T {
    if (typeof db.transaction === 'function') {
        const tx = db.transaction(fn);
        if (typeof tx.immediate === 'function') {
            return tx.immediate();
        }
        return tx();
    }
    db.exec('BEGIN IMMEDIATE');
    try {
        const result = fn();
        db.exec('COMMIT');
        return result;
    } catch (err) {
        try {
            db.exec('ROLLBACK');
        } catch {
            // Ignore rollback error when transaction already aborted.
        }
        throw err;
    }
}

export class ArtifactStore {
    readonly db: ArtifactStoreDatabase;

    constructor(dbInput: ArtifactDatabaseInput) {
        this.db = unwrapDatabase(dbInput);
        ensureArtifactStoreSchema(this.db);
    }

    /**
     * Register or update a workspace file as a session artifact.
     *
     * - Re-registering the same `(sessionId, relPath)` retains the existing
     *   `artifactId` (`art_<16hex>`) and `createdAt`, updates `sizeBytes`, `sha256`,
     *   `previewText`, `title`, `mime`, `kind`, and `updatedAt`, and reports
     *   `isUpdate: true`.
     * - Soft list windows (50/200/500) are advisory; NEW rows are gated by the
     *   daemon-wide hard byte budget. Same `(sessionId, relPath)` upserts keep
     *   their ID; identical source bytes are an idempotent no-op.
     */
    register(input: RegisterArtifactInput): RegisterArtifactResult {
        if (typeof input?.sessionId !== 'string' || input.sessionId.trim().length === 0) {
            throw new Error('sessionId must be a non-empty string');
        }
        const sessionId = input.sessionId.trim();
        const rawPath = input.path ?? input.relPath ?? input.rawPath ?? input.filePath ?? '';
        const declaredKind = input.declaredKind ?? input.kind;
        const declaredMime = input.declaredMime ?? input.mime;

        const prePriorRootRow = this.db
            .prepare<{ workspace_root: string }>(
                `SELECT workspace_root FROM session_artifacts WHERE session_id = ? LIMIT 1`,
            )
            .get(sessionId);

        let resolved;
        try {
            resolved = resolveArtifactFile(input.workspaceRoot, rawPath, {
                declaredKind,
                declaredMime,
                title: input.title,
                pinnedCanonicalWorkspaceRoot: prePriorRootRow
                    ? path.resolve(prePriorRootRow.workspace_root)
                    : undefined,
                _testHooks: input._testHooks,
            });
        } catch (err) {
            const mapped = mapStorageErrnoToArtifactError(err);
            if (mapped) throw mapped;
            throw err;
        }

        const now = typeof input.now === 'number' && Number.isFinite(input.now) ? Math.trunc(input.now) : Date.now();
        const meshId = typeof input.meshId === 'string' && input.meshId.trim() ? input.meshId.trim() : null;
        const missionId = typeof input.missionId === 'string' && input.missionId.trim() ? input.missionId.trim() : null;
        const producerRole =
            typeof input.producerRole === 'string' && input.producerRole.trim()
                ? input.producerRole.trim()
                : null;
        const originDaemonId =
            typeof input.originDaemonId === 'string' && input.originDaemonId.trim()
                ? input.originDaemonId.trim()
                : null;

        try {
            return runInImmediateTransaction(this.db, () => {
                // Preservation policy: age-based DELETE is a no-op (see pruneExpired).
                if (now >= 100_000_000_000) {
                    this.pruneExpired(now, ARTIFACT_RETENTION_MS, 100_000_000_000);
                }
                const priorRootRow = this.db
                    .prepare<{ workspace_root: string }>(
                        `SELECT workspace_root FROM session_artifacts WHERE session_id = ? LIMIT 1`,
                    )
                    .get(sessionId);
                if (priorRootRow) {
                    const pinnedSessionRoot = path.resolve(priorRootRow.workspace_root);
                    let currentPinnedReal: string | null = null;
                    try {
                        const rootLstat = fs.lstatSync(pinnedSessionRoot);
                        if (!rootLstat.isSymbolicLink() && rootLstat.isDirectory()) {
                            currentPinnedReal = fs.realpathSync(pinnedSessionRoot);
                        }
                    } catch {
                        currentPinnedReal = null;
                    }
                    if (
                        currentPinnedReal !== pinnedSessionRoot ||
                        resolved.workspaceRoot !== pinnedSessionRoot
                    ) {
                        throw new ArtifactGuardError(
                            'path_outside_workspace',
                            'Session canonical workspace root was redirected or replaced (path_outside_workspace)',
                        );
                    }
                }

                const existing = this.db
                    .prepare<SessionArtifactDbRow>(
                        `SELECT * FROM session_artifacts WHERE session_id = ? AND rel_path = ?`,
                    )
                    .get(sessionId, resolved.relPath);

                if (existing) {
                    const nextTitle =
                        input.title !== undefined && input.title.trim().length > 0
                            ? resolved.title
                            : existing.title || resolved.title;
                    const sameBytes =
                        existing.sha256 === resolved.sha256 &&
                        existing.kind === resolved.kind &&
                        existing.mime === resolved.mime &&
                        existing.size_bytes === resolved.sizeBytes &&
                        (existing.title || '') === (nextTitle || '');
                    const nextTaskId = input.taskId !== undefined ? (input.taskId ?? null) : existing.task_id;
                    const nextMeshId = meshId ?? existing.mesh_id ?? null;
                    const nextMissionId = missionId ?? existing.mission_id ?? null;
                    const nextProducerRole = producerRole ?? existing.producer_role ?? null;
                    const nextOriginDaemonId = originDaemonId ?? existing.origin_daemon_id ?? null;
                    const attributionUnchanged =
                        (existing.task_id || null) === (nextTaskId || null) &&
                        (existing.mesh_id || null) === (nextMeshId || null) &&
                        (existing.mission_id || null) === (nextMissionId || null) &&
                        (existing.producer_role || null) === (nextProducerRole || null) &&
                        originDaemonAttributionUnchanged(existing.origin_daemon_id, nextOriginDaemonId);
                    if (sameBytes && attributionUnchanged) {
                        const record = rowToArtifactRecord(existing);
                        return {
                            record,
                            isUpdate: true,
                            attachment: toChatAttachmentMeta(record),
                        };
                    }
                    // Same bytes may still need attribution fill-in (null→mesh/mission/task) for list/grant paths.
                    // Changing an already-set attribution field to a different value is an explicit conflict.
                    if (sameBytes) {
                        const conflictField =
                            (existing.task_id && nextTaskId && existing.task_id !== nextTaskId && 'task_id') ||
                            (existing.mesh_id && nextMeshId && existing.mesh_id !== nextMeshId && 'mesh_id') ||
                            (existing.mission_id && nextMissionId && existing.mission_id !== nextMissionId && 'mission_id') ||
                            (existing.producer_role && nextProducerRole && existing.producer_role !== nextProducerRole && 'producer_role') ||
                            (originDaemonAttributionConflict(existing.origin_daemon_id, nextOriginDaemonId) && 'origin_daemon_id') ||
                            null;
                        if (conflictField) {
                            throw new ArtifactGuardError(
                                'artifact_revision_conflict',
                                `Artifact "${existing.artifact_id}" attribution ${conflictField} conflict (artifact_revision_conflict)`,
                                {
                                    artifactId: existing.artifact_id,
                                    preserved: true,
                                    retryable: false,
                                },
                            );
                        }
                    } else if ((producerRole ?? existing.producer_role) === 'pipeline') {
                        throw new ArtifactGuardError(
                            'artifact_revision_conflict',
                            `Pipeline artifact "${existing.artifact_id}" source changed; register a new path (artifact_revision_conflict)`,
                            {
                                artifactId: existing.artifact_id,
                                preserved: true,
                                retryable: false,
                            },
                        );
                    }

                    const updatedAt = Math.max(now, existing.updated_at + 1);
                    const metaDelta =
                        estimateArtifactMetadataBytes({
                            artifactId: existing.artifact_id,
                            sessionId,
                            taskId: nextTaskId,
                            meshId: nextMeshId,
                            missionId: nextMissionId,
                            producerRole: nextProducerRole,
                            originDaemonId: nextOriginDaemonId,
                            workspaceRoot: resolved.workspaceRoot,
                            relPath: resolved.relPath,
                            kind: resolved.kind,
                            mime: resolved.mime,
                            title: nextTitle,
                            sha256: resolved.sha256,
                            previewText: resolved.previewText,
                        }) -
                        estimateArtifactMetadataBytes({
                            artifactId: existing.artifact_id,
                            sessionId: existing.session_id,
                            taskId: existing.task_id,
                            meshId: existing.mesh_id,
                            missionId: existing.mission_id,
                            producerRole: existing.producer_role,
                            originDaemonId: existing.origin_daemon_id,
                            workspaceRoot: existing.workspace_root,
                            relPath: existing.rel_path,
                            kind: existing.kind,
                            mime: existing.mime,
                            title: existing.title,
                            sha256: existing.sha256,
                            previewText: existing.preview_text,
                        });
                    const payloadDelta = resolved.sizeBytes - existing.size_bytes;
                    if (metaDelta > 0 || payloadDelta > 0) {
                        assertArtifactAdmissionAllows(readArtifactAdmissionTotals(this.db), {
                            metadataBytes: Math.max(0, metaDelta),
                            payloadBytes: Math.max(0, payloadDelta),
                        });
                    }

                    this.db
                        .prepare(
                            `UPDATE session_artifacts
                             SET task_id = ?,
                                 mesh_id = ?,
                                 mission_id = ?,
                                 producer_role = ?,
                                 origin_daemon_id = ?,
                                 workspace_root = ?,
                                 kind = ?,
                                 mime = ?,
                                 title = ?,
                                 size_bytes = ?,
                                 sha256 = ?,
                                 preview_text = ?,
                                 updated_at = ?
                             WHERE artifact_id = ?`,
                        )
                        .run(
                            nextTaskId,
                            nextMeshId,
                            nextMissionId,
                            nextProducerRole,
                            nextOriginDaemonId,
                            resolved.workspaceRoot,
                            resolved.kind,
                            resolved.mime,
                            nextTitle,
                            resolved.sizeBytes,
                            resolved.sha256,
                            resolved.previewText,
                            updatedAt,
                            existing.artifact_id,
                        );

                    const record: ArtifactRecord = {
                        artifactId: existing.artifact_id,
                        sessionId,
                        taskId: nextTaskId ?? null,
                        ...(nextMeshId != null ? { meshId: nextMeshId } : {}),
                        ...(nextMissionId != null ? { missionId: nextMissionId } : {}),
                        ...(nextProducerRole != null ? { producerRole: nextProducerRole } : {}),
                        ...(nextOriginDaemonId != null ? { originDaemonId: nextOriginDaemonId } : {}),
                        workspaceRoot: resolved.workspaceRoot,
                        relPath: resolved.relPath,
                        kind: resolved.kind,
                        mime: resolved.mime,
                        title: nextTitle,
                        sizeBytes: resolved.sizeBytes,
                        sha256: resolved.sha256,
                        previewText: resolved.previewText,
                        createdAt: existing.created_at,
                        updatedAt,
                    };

                    return {
                        record,
                        isUpdate: true,
                        attachment: toChatAttachmentMeta(record),
                    };
                }

                const taskId = input.taskId ?? null;
                assertArtifactAdmissionAllows(readArtifactAdmissionTotals(this.db), {
                    metadataBytes: estimateArtifactMetadataBytes({
                        artifactId: 'art_0123456789abcdef',
                        sessionId,
                        taskId,
                        meshId,
                        missionId,
                        producerRole,
                        originDaemonId,
                        workspaceRoot: resolved.workspaceRoot,
                        relPath: resolved.relPath,
                        kind: resolved.kind,
                        mime: resolved.mime,
                        title: resolved.title,
                        sha256: resolved.sha256,
                        previewText: resolved.previewText,
                    }),
                    payloadBytes: resolved.sizeBytes,
                });

                let artifactId = generateArtifactId();
                while (
                    this.db
                        .prepare<{ one: number }>(
                            `SELECT 1 AS one FROM session_artifacts WHERE artifact_id = ?`,
                        )
                        .get(artifactId)
                ) {
                    artifactId = generateArtifactId();
                }

                this.db
                    .prepare(
                        `INSERT INTO session_artifacts (
                            artifact_id,
                            session_id,
                            task_id,
                            mesh_id,
                            mission_id,
                            producer_role,
                            origin_daemon_id,
                            workspace_root,
                            rel_path,
                            kind,
                            mime,
                            title,
                            size_bytes,
                            sha256,
                            preview_text,
                            created_at,
                            updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    )
                    .run(
                        artifactId,
                        sessionId,
                        taskId,
                        meshId,
                        missionId,
                        producerRole,
                        originDaemonId,
                        resolved.workspaceRoot,
                        resolved.relPath,
                        resolved.kind,
                        resolved.mime,
                        resolved.title,
                        resolved.sizeBytes,
                        resolved.sha256,
                        resolved.previewText,
                        now,
                        now,
                    );

                const record: ArtifactRecord = {
                    artifactId,
                    sessionId,
                    taskId,
                    ...(meshId != null ? { meshId } : {}),
                    ...(missionId != null ? { missionId } : {}),
                    ...(producerRole != null ? { producerRole } : {}),
                    ...(originDaemonId != null ? { originDaemonId } : {}),
                    workspaceRoot: resolved.workspaceRoot,
                    relPath: resolved.relPath,
                    kind: resolved.kind,
                    mime: resolved.mime,
                    title: resolved.title,
                    sizeBytes: resolved.sizeBytes,
                    sha256: resolved.sha256,
                    previewText: resolved.previewText,
                    createdAt: now,
                    updatedAt: now,
                };

                return {
                    record,
                    isUpdate: false,
                    attachment: toChatAttachmentMeta(record),
                };
            });
        } catch (err) {
            const mapped = mapStorageErrnoToArtifactError(err);
            if (mapped) throw mapped;
            throw err;
        }
    }

    /** Alias for `register`. */
    registerArtifact(input: RegisterArtifactInput): RegisterArtifactResult {
        return this.register(input);
    }

    /** Alias for `register`. */
    upsert(input: RegisterArtifactInput): RegisterArtifactResult {
        return this.register(input);
    }

    /** Retrieve a single artifact record by `artifactId`. */
    get(artifactId: string): ArtifactRecord | null {
        if (typeof artifactId !== 'string' || !artifactId) {
            return null;
        }
        const row = this.db
            .prepare<SessionArtifactDbRow>(
                `SELECT * FROM session_artifacts WHERE artifact_id = ?`,
            )
            .get(artifactId);
        return row ? rowToArtifactRecord(row) : null;
    }

    /** Alias for `get`. */
    getArtifact(artifactId: string): ArtifactRecord | null {
        return this.get(artifactId);
    }

    /** Alias for `get`. */
    getById(artifactId: string): ArtifactRecord | null {
        return this.get(artifactId);
    }

    /** Retrieve a single artifact record by `(sessionId, relPath)`. */
    getByPath(sessionId: string, relPath: string): ArtifactRecord | null {
        if (typeof sessionId !== 'string' || typeof relPath !== 'string') {
            return null;
        }
        const normalizedRel = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
        const row = this.db
            .prepare<SessionArtifactDbRow>(
                `SELECT * FROM session_artifacts WHERE session_id = ? AND rel_path = ?`,
            )
            .get(sessionId, normalizedRel);
        return row ? rowToArtifactRecord(row) : null;
    }

    /** List artifacts for a session in deterministic creation order. */
    listBySession(sessionId: string, options?: ListSessionArtifactsOptions): ArtifactRecord[] {
        return listArtifactsBySession(this.db, sessionId, options);
    }

    /** Alias for `listBySession`. */
    listSessionArtifacts(sessionId: string, options?: ListSessionArtifactsOptions): ArtifactRecord[] {
        return this.listBySession(sessionId, options);
    }

    /** Alias for `listBySession`. */
    listArtifacts(sessionId: string, options?: ListSessionArtifactsOptions): ArtifactRecord[] {
        return this.listBySession(sessionId, options);
    }

    /** Count registered artifacts for a session. */
    countBySession(sessionId: string): number {
        if (typeof sessionId !== 'string' || !sessionId) {
            return 0;
        }
        const row = this.db
            .prepare<{ count: number }>(
                `SELECT COUNT(*) AS count FROM session_artifacts WHERE session_id = ?`,
            )
            .get(sessionId);
        return row?.count ?? 0;
    }

    /**
     * Explicit session-wide artifact metadata DELETE is refused under the
     * reference-safe preservation policy. Callers must not use this to reclaim
     * quota; existing IDs/grants/evidence stay readable.
     */
    deleteBySession(sessionId: string): number {
        if (typeof sessionId !== 'string' || !sessionId) {
            return 0;
        }
        const count = this.countBySession(sessionId);
        if (count > 0) {
            throw new ArtifactGuardError(
                'artifact_preserved_refuse_delete',
                `Refusing to delete ${count} artifact row(s) for session "${sessionId}" (artifact_preserved_refuse_delete)`,
                { sessionId, count, preserved: true, retryable: false },
            );
        }
        return 0;
    }

    /**
     * Upsert a metadata-only record forwarded from a remote worker daemon
     * (`artifact_index_forwarded`). Never opens the remote path locally; instead
     * persists `origin_daemon_id` so subsequent reads fetch over P2P from the
     * origin daemon.
     */
    upsertForwarded(input: UpsertForwardedArtifactInput): RegisterArtifactResult {
        const artifactId = typeof input?.artifactId === 'string' ? input.artifactId.trim() : '';
        const sessionId = typeof input?.sessionId === 'string' ? input.sessionId.trim() : '';
        const originDaemonId =
            typeof input?.originDaemonId === 'string' ? input.originDaemonId.trim() : '';
        const workspaceRoot =
            typeof input?.workspaceRoot === 'string' ? input.workspaceRoot.trim() : '';
        const rawRel = typeof input?.relPath === 'string' ? input.relPath.trim() : '';
        if (!/^art_[0-9a-f]{16}$/.test(artifactId)) {
            throw new Error(`Invalid forwarded artifactId "${artifactId}"`);
        }
        if (!sessionId || !originDaemonId || !workspaceRoot || !rawRel) {
            throw new Error('Forwarded artifact metadata requires sessionId, originDaemonId, workspaceRoot, and relPath');
        }
        const relPath = rawRel.replace(/\\/g, '/').replace(/^\.\//, '');
        assertNotSecretPath(relPath);
        if (
            relPath.startsWith('/') ||
            relPath === '..' ||
            relPath.startsWith('../') ||
            relPath.includes('/../')
        ) {
            throw new ArtifactGuardError(
                'path_outside_workspace',
                `Forwarded relPath "${relPath}" is invalid (path_outside_workspace)`,
            );
        }
        const kind = input.kind;
        if (!(ARTIFACT_KINDS as readonly string[]).includes(kind)) {
            throw new ArtifactGuardError(
                'unsupported_mime_or_kind',
                `Unsupported forwarded artifact kind "${String(kind)}" (unsupported_mime_or_kind)`,
            );
        }
        const mime = typeof input.mime === 'string' ? input.mime.trim().toLowerCase() : '';
        if (!MIME_BY_KIND[kind]?.includes(mime)) {
            throw new ArtifactGuardError(
                'unsupported_mime_or_kind',
                `Unsupported forwarded artifact mime "${mime}" for kind "${kind}" (unsupported_mime_or_kind)`,
            );
        }
        const sizeBytes = Math.trunc(Number(input.sizeBytes));
        if (!Number.isFinite(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_ARTIFACT_BYTES) {
            throw new ArtifactGuardError(
                'artifact_too_large',
                `Forwarded artifact size ${sizeBytes} exceeds ${MAX_ARTIFACT_BYTES} bytes (artifact_too_large)`,
            );
        }
        const sha256 = typeof input.sha256 === 'string' ? input.sha256.trim().toLowerCase() : '';
        if (!/^[0-9a-f]{64}$/.test(sha256)) {
            throw new Error('Forwarded artifact sha256 must be 64 lowercase hex characters');
        }
        const filename = path.posix.basename(relPath) || relPath;
        const title = sanitizeArtifactTitle(input.title ?? undefined, filename);
        const previewText = typeof input.previewText === 'string'
            ? Array.from(input.previewText).slice(0, MAX_PREVIEW_TEXT_CHARS).join('')
            : null;
        if (typeof input.previewText === 'string' && input.previewText.length > 0) {
            assertNotSecretContent(Buffer.from(input.previewText, 'utf8'), kind);
        }
        if (previewText) assertNotSecretContent(Buffer.from(previewText, 'utf8'), kind);
        const now = Date.now();
        const maxClockSkewMs = 60_000;
        const maxAllowedTimestamp = now + maxClockSkewMs;
        const rawCreatedAt =
            typeof input.createdAt === 'number' && Number.isFinite(input.createdAt) && input.createdAt > 0
                ? Math.trunc(input.createdAt)
                : now;
        const createdAt = Math.min(rawCreatedAt, maxAllowedTimestamp);
        const rawUpdatedAt =
            typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt) && input.updatedAt > 0
                ? Math.trunc(input.updatedAt)
                : createdAt;
        const updatedAt = Math.max(createdAt, Math.min(rawUpdatedAt, maxAllowedTimestamp));
        const taskId = typeof input.taskId === 'string' && input.taskId.trim() ? input.taskId.trim() : null;
        const meshId = typeof input.meshId === 'string' && input.meshId.trim() ? input.meshId.trim() : null;
        const missionId = typeof input.missionId === 'string' && input.missionId.trim() ? input.missionId.trim() : null;
        const producerRole = typeof input.producerRole === 'string' && input.producerRole.trim() ? input.producerRole.trim() : 'worker';

        try {
            return runInImmediateTransaction(this.db, () => {
                if (now >= 100_000_000_000) this.pruneExpired(now, ARTIFACT_RETENTION_MS, 100_000_000_000);
                const existing = this.db
                    .prepare<SessionArtifactDbRow>(`SELECT * FROM session_artifacts WHERE session_id = ? AND rel_path = ?`)
                    .get(sessionId, relPath);

                if (existing) {
                    const sameBytes =
                        existing.sha256 === sha256 &&
                        existing.kind === kind &&
                        existing.mime === mime &&
                        existing.size_bytes === sizeBytes &&
                        (existing.title || '') === (title || '');
                    const nextTaskId = taskId ?? existing.task_id;
                    const nextMeshId = meshId ?? existing.mesh_id ?? null;
                    const nextMissionId = missionId ?? existing.mission_id ?? null;
                    const nextProducerRole = producerRole ?? existing.producer_role ?? null;
                    const nextOriginDaemonId = originDaemonId || existing.origin_daemon_id || null;
                    const attributionUnchanged =
                        (existing.task_id || null) === (nextTaskId || null) &&
                        (existing.mesh_id || null) === (nextMeshId || null) &&
                        (existing.mission_id || null) === (nextMissionId || null) &&
                        (existing.producer_role || null) === (nextProducerRole || null) &&
                        originDaemonAttributionUnchanged(existing.origin_daemon_id, nextOriginDaemonId);
                    if (sameBytes && attributionUnchanged) {
                        const record = rowToArtifactRecord(existing);
                        return {
                            record,
                            isUpdate: true,
                            attachment: toChatAttachmentMeta(record),
                        };
                    }
                    if (sameBytes) {
                        const conflictField =
                            (existing.task_id && nextTaskId && existing.task_id !== nextTaskId && 'task_id') ||
                            (existing.mesh_id && nextMeshId && existing.mesh_id !== nextMeshId && 'mesh_id') ||
                            (existing.mission_id && nextMissionId && existing.mission_id !== nextMissionId && 'mission_id') ||
                            (existing.producer_role && nextProducerRole && existing.producer_role !== nextProducerRole && 'producer_role') ||
                            (originDaemonAttributionConflict(existing.origin_daemon_id, nextOriginDaemonId) && 'origin_daemon_id') ||
                            null;
                        if (conflictField) {
                            throw new ArtifactGuardError(
                                'artifact_revision_conflict',
                                `Forwarded artifact "${existing.artifact_id}" attribution ${conflictField} conflict (artifact_revision_conflict)`,
                                { artifactId: existing.artifact_id, preserved: true, retryable: false },
                            );
                        }
                    } else if ((producerRole ?? existing.producer_role) === 'pipeline') {
                        throw new ArtifactGuardError(
                            'artifact_revision_conflict',
                            `Pipeline forwarded artifact "${existing.artifact_id}" source changed (artifact_revision_conflict)`,
                            { artifactId: existing.artifact_id, preserved: true, retryable: false },
                        );
                    }
                    const nextUpdatedAt = Math.max(updatedAt, existing.updated_at);
                    const metaDelta =
                        estimateArtifactMetadataBytes({
                            artifactId: existing.artifact_id,
                            sessionId,
                            taskId: nextTaskId,
                            meshId: nextMeshId,
                            missionId: nextMissionId,
                            producerRole: nextProducerRole,
                            originDaemonId: nextOriginDaemonId,
                            workspaceRoot,
                            relPath,
                            kind,
                            mime,
                            title,
                            sha256,
                            previewText,
                        }) -
                        estimateArtifactMetadataBytes({
                            artifactId: existing.artifact_id,
                            sessionId: existing.session_id,
                            taskId: existing.task_id,
                            meshId: existing.mesh_id,
                            missionId: existing.mission_id,
                            producerRole: existing.producer_role,
                            originDaemonId: existing.origin_daemon_id,
                            workspaceRoot: existing.workspace_root,
                            relPath: existing.rel_path,
                            kind: existing.kind,
                            mime: existing.mime,
                            title: existing.title,
                            sha256: existing.sha256,
                            previewText: existing.preview_text,
                        });
                    const payloadDelta = sizeBytes - existing.size_bytes;
                    if (metaDelta > 0 || payloadDelta > 0) {
                        assertArtifactAdmissionAllows(readArtifactAdmissionTotals(this.db), {
                            metadataBytes: Math.max(0, metaDelta),
                            payloadBytes: Math.max(0, payloadDelta),
                        });
                    }
                    this.db
                        .prepare(
                            `UPDATE session_artifacts
                             SET task_id = ?, mesh_id = ?, mission_id = ?, producer_role = ?, origin_daemon_id = ?,
                                 workspace_root = ?, kind = ?, mime = ?, title = ?, size_bytes = ?, sha256 = ?,
                                 preview_text = ?, updated_at = ?
                             WHERE artifact_id = ?`,
                        )
                        .run(
                            nextTaskId, nextMeshId, nextMissionId, nextProducerRole,
                            nextOriginDaemonId, workspaceRoot, kind, mime, title, sizeBytes, sha256, previewText,
                            nextUpdatedAt, existing.artifact_id,
                        );

                    const record: ArtifactRecord = {
                        artifactId: existing.artifact_id,
                        sessionId,
                        taskId: nextTaskId ?? null,
                        ...(nextMeshId ? { meshId: nextMeshId } : {}),
                        ...(nextMissionId ? { missionId: nextMissionId } : {}),
                        ...(nextProducerRole ? { producerRole: nextProducerRole } : {}),
                        ...(nextOriginDaemonId ? { originDaemonId: nextOriginDaemonId } : {}),
                        workspaceRoot,
                        relPath,
                        kind,
                        mime,
                        title,
                        sizeBytes,
                        sha256,
                        previewText,
                        createdAt: existing.created_at,
                        updatedAt: nextUpdatedAt,
                    };
                    return {
                        record,
                        isUpdate: true,
                        attachment: toChatAttachmentMeta(record),
                    };
                }

                assertArtifactAdmissionAllows(readArtifactAdmissionTotals(this.db), {
                    metadataBytes: estimateArtifactMetadataBytes({
                        artifactId,
                        sessionId,
                        taskId,
                        meshId,
                        missionId,
                        producerRole,
                        originDaemonId,
                        workspaceRoot,
                        relPath,
                        kind,
                        mime,
                        title,
                        sha256,
                        previewText,
                    }),
                    payloadBytes: sizeBytes,
                });

                this.db
                    .prepare(
                        `INSERT INTO session_artifacts (
                            artifact_id,
                            session_id,
                            task_id,
                            mesh_id,
                            mission_id,
                            producer_role,
                            origin_daemon_id,
                            workspace_root,
                            rel_path,
                            kind,
                            mime,
                            title,
                            size_bytes,
                            sha256,
                            preview_text,
                            created_at,
                            updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    )
                    .run(
                        artifactId,
                        sessionId,
                        taskId,
                        meshId,
                        missionId,
                        producerRole,
                        originDaemonId,
                        workspaceRoot,
                        relPath,
                        kind,
                        mime,
                        title,
                        sizeBytes,
                        sha256,
                        previewText,
                        createdAt,
                        updatedAt,
                    );

                const record: ArtifactRecord = {
                    artifactId,
                    sessionId,
                    taskId,
                    ...(meshId != null ? { meshId } : {}),
                    ...(missionId != null ? { missionId } : {}),
                    ...(producerRole != null ? { producerRole } : {}),
                    originDaemonId,
                    workspaceRoot,
                    relPath,
                    kind,
                    mime,
                    title,
                    sizeBytes,
                    sha256,
                    previewText,
                    createdAt,
                    updatedAt,
                };

                return {
                    record,
                    isUpdate: false,
                    attachment: toChatAttachmentMeta(record),
                };
            });
        } catch (err) {
            const mapped = mapStorageErrnoToArtifactError(err);
            if (mapped) throw mapped;
            throw err;
        }
    }

    /** Alias for `upsertForwarded`. */
    upsertForwardedArtifact(input: UpsertForwardedArtifactInput): RegisterArtifactResult {
        return this.upsertForwarded(input);
    }

    /**
     * List artifacts across a mesh (optionally filtered by sessionId or missionId).
     * A `limit` keeps the newest records; the result stays in creation order.
     */
    listByMesh(
        meshId: string,
        options?: { sessionId?: string; missionId?: string; limit?: number },
    ): ArtifactRecord[] {
        return listArtifactsByMesh(this.db, meshId, options);
    }

    /**
     * List artifacts in a mission (optionally restricted to an allowlist of artifactIds for OD-4).
     * A `limit` keeps the newest records; the result stays in creation order.
     */
    listByMission(
        missionId: string,
        options?: { artifactIds?: readonly string[]; limit?: number; meshId?: string },
    ): ArtifactRecord[] {
        return listArtifactsByMission(this.db, missionId, options);
    }

    /**
     * Age-based metadata DELETE is disabled: referenced evidence (active/held
     * review inputs, grants, mission/handoff refs) cannot be proven safe to drop
     * from this layer alone. Returns 0 and leaves all rows intact.
     */
    pruneExpired(
        _now: number = Date.now(),
        _retentionMs: number = ARTIFACT_RETENTION_MS,
        _minTimestamp: number = 0,
    ): number {
        return 0;
    }

    /**
     * Owner/SQL keyset listing over the full canonical table (not a preloaded
     * 500-row window). Filters and cursor predicates are applied in SQL so
     * archive-window rows remain reachable page-by-page. Direct get-by-id is
     * unchanged and does not require paging through this window.
     */
    listByMeshKeyset(
        meshId: string,
        options?: ListMeshArtifactsKeysetOptions,
    ): ListMeshArtifactsKeysetResult {
        return listArtifactsByMeshKeyset(this.db, meshId, options);
    }

    /** Read and page an artifact's content at 256 KiB boundaries (OD-7). */
    readArtifactContent(
        artifactId: string,
        options?: ReadArtifactContentOptions,
    ): ReadArtifactContentResult {
        const record = this.get(artifactId);
        if (!record) {
            throw new ArtifactGuardError(
                'artifact_not_found',
                `Artifact "${artifactId}" not found (artifact_not_found)`,
            );
        }
        return readArtifactRecordPaged(record, options);
    }

    /** Re-validate and read the artifact file from disk at fetch time. */
    fetchArtifactContent(
        artifactId: string,
        options?: FetchArtifactContentOptions,
    ): FetchArtifactContentResult {
        const record = this.get(artifactId);
        if (!record) {
            throw new ArtifactGuardError(
                'artifact_not_found',
                `Artifact "${artifactId}" not found (artifact_not_found)`,
            );
        }
        return buildFetchArtifactContentResult(record, options);
    }

    /** Alias for `fetchArtifactContent`. */
    fetchContent(
        artifactId: string,
        options?: FetchArtifactContentOptions,
    ): FetchArtifactContentResult {
        return this.fetchArtifactContent(artifactId, options);
    }
}

/** Functional helper to register/upsert a session artifact against a store or DB. */
export function registerSessionArtifact(
    storeOrDb: ArtifactStore | ArtifactDatabaseInput,
    input: RegisterArtifactInput,
): RegisterArtifactResult {
    const store = storeOrDb instanceof ArtifactStore ? storeOrDb : new ArtifactStore(storeOrDb);
    return store.register(input);
}

/** Functional helper to list artifacts for a session. */
export function listSessionArtifacts(
    storeOrDb: ArtifactStore | ArtifactDatabaseInput,
    sessionId: string,
    options?: ListSessionArtifactsOptions,
): ArtifactRecord[] {
    const store = storeOrDb instanceof ArtifactStore ? storeOrDb : new ArtifactStore(storeOrDb);
    return store.listBySession(sessionId, options);
}

/** Functional helper to fetch and re-verify artifact content by `artifactId`. */
export function fetchArtifactContent(
    storeOrDb: ArtifactStore | ArtifactDatabaseInput,
    artifactId: string,
    options?: FetchArtifactContentOptions,
): FetchArtifactContentResult {
    const store = storeOrDb instanceof ArtifactStore ? storeOrDb : new ArtifactStore(storeOrDb);
    return store.fetchArtifactContent(artifactId, options);
}

/**
 * Functional helper to read and page an artifact at 256 KiB boundaries (OD-7).
 * Accepts either `(record, options?)` or `(storeOrDb, artifactId, options?)`.
 */
export function readArtifactContent(
    recordOrStore: ArtifactRecord | ArtifactStore | ArtifactDatabaseInput,
    optionsOrArtifactId?: ReadArtifactContentOptions | string,
    maybeOptions?: ReadArtifactContentOptions,
): ReadArtifactContentResult {
    if (
        recordOrStore &&
        typeof recordOrStore === 'object' &&
        'artifactId' in recordOrStore &&
        'workspaceRoot' in recordOrStore &&
        'relPath' in recordOrStore
    ) {
        return readArtifactRecordPaged(
            recordOrStore as ArtifactRecord,
            typeof optionsOrArtifactId === 'object' ? optionsOrArtifactId : undefined,
        );
    }
    const store =
        recordOrStore instanceof ArtifactStore
            ? recordOrStore
            : new ArtifactStore(recordOrStore as ArtifactDatabaseInput);
    const artifactId = typeof optionsOrArtifactId === 'string' ? optionsOrArtifactId : '';
    return store.readArtifactContent(artifactId, maybeOptions);
}
