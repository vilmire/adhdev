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
import {
    readVerifiedArtifactFile,
    resolveArtifactFile,
    type ArtifactTestRaceHooks,
} from './artifact-path-guard.js';
import {
    ArtifactGuardError,
    MAX_ARTIFACTS_PER_SESSION,
    toChatAttachmentMeta,
    type ArtifactKind,
    type ArtifactRecord,
    type ChatAttachmentMeta,
} from './types.js';

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
    kind?: ArtifactKind;
    declaredKind?: ArtifactKind;
    mime?: string;
    declaredMime?: string;
    title?: string;
    now?: number;
    _testHooks?: ArtifactTestRaceHooks;
}

export interface RegisterArtifactResult {
    record: ArtifactRecord;
    isUpdate: boolean;
    attachment: ChatAttachmentMeta;
}

export interface ListSessionArtifactsOptions {
    limit?: number;
}

export interface FetchArtifactContentOptions {
    /** Optional caller-verified session ID to enforce session ownership at read time. */
    sessionId?: string;
    /** Optional trusted workspace root to cross-check against the stored workspaceRoot. */
    trustedWorkspaceRoot?: string;
    _testHooks?: ArtifactTestRaceHooks;
}

export interface FetchArtifactContentResult {
    artifactId: string;
    sessionId: string;
    relPath: string;
    kind: ArtifactKind;
    mime: string;
    title: string;
    content: string;
    encoding: 'utf8' | 'base64';
    sizeBytes: number;
    sha256: string;
    registeredSha256: string;
    sha256Changed: boolean;
    hashChanged: boolean;
}

export const SESSION_ARTIFACTS_SCHEMA_DDL = `
    CREATE TABLE IF NOT EXISTS session_artifacts (
        artifact_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_id TEXT,
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

/** Ensure `session_artifacts` table and indexes exist on the given SQLite handle. */
export function ensureArtifactStoreSchema(dbInput: ArtifactDatabaseInput): void {
    const db = unwrapDatabase(dbInput);
    db.exec(SESSION_ARTIFACTS_SCHEMA_DDL);
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
     * - Enforces `MAX_ARTIFACTS_PER_SESSION = 50` on NEW records per session;
     *   updates to an already-registered `(sessionId, relPath)` at cap 50 remain valid.
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

        const resolved = resolveArtifactFile(input.workspaceRoot, rawPath, {
            declaredKind,
            declaredMime,
            title: input.title,
            pinnedCanonicalWorkspaceRoot: prePriorRootRow
                ? path.resolve(prePriorRootRow.workspace_root)
                : undefined,
            _testHooks: input._testHooks,
        });

        const now = typeof input.now === 'number' && Number.isFinite(input.now) ? Math.trunc(input.now) : Date.now();

        return runInImmediateTransaction(this.db, () => {
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
                const updatedAt = Math.max(now, existing.updated_at);
                const nextTaskId = input.taskId !== undefined ? (input.taskId ?? null) : existing.task_id;
                const nextTitle =
                    input.title !== undefined && input.title.trim().length > 0
                        ? resolved.title
                        : existing.title || resolved.title;

                this.db
                    .prepare(
                        `UPDATE session_artifacts
                         SET task_id = ?,
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

            const countRow = this.db
                .prepare<{ count: number }>(
                    `SELECT COUNT(*) AS count FROM session_artifacts WHERE session_id = ?`,
                )
                .get(sessionId);
            const currentCount = countRow?.count ?? 0;
            if (currentCount >= MAX_ARTIFACTS_PER_SESSION) {
                throw new ArtifactGuardError(
                    'session_artifact_limit_reached',
                    `Session "${sessionId}" has reached the maximum of ${MAX_ARTIFACTS_PER_SESSION} artifacts (session_artifact_limit_reached)`,
                );
            }

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

            const taskId = input.taskId ?? null;
            this.db
                .prepare(
                    `INSERT INTO session_artifacts (
                        artifact_id,
                        session_id,
                        task_id,
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
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                    artifactId,
                    sessionId,
                    taskId,
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
        if (typeof sessionId !== 'string' || !sessionId) {
            return [];
        }
        const rawLimit = options?.limit;
        const limit =
            typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
                ? Math.min(Math.trunc(rawLimit), MAX_ARTIFACTS_PER_SESSION)
                : MAX_ARTIFACTS_PER_SESSION;

        const rows = this.db
            .prepare<SessionArtifactDbRow>(
                `SELECT * FROM session_artifacts
                 WHERE session_id = ?
                 ORDER BY created_at ASC, rowid ASC
                 LIMIT ?`,
            )
            .all(sessionId, limit);

        return rows.map(rowToArtifactRecord);
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

    /** Delete all artifact metadata rows for a session. */
    deleteBySession(sessionId: string): number {
        if (typeof sessionId !== 'string' || !sessionId) {
            return 0;
        }
        const res = this.db
            .prepare(`DELETE FROM session_artifacts WHERE session_id = ?`)
            .run(sessionId);
        return res.changes;
    }

    /**
     * Re-validate and read the artifact file from disk at fetch time.
     *
     * Re-checks canonical workspace root, symlink/traversal containment,
     * regular-file status, extension/kind/MIME allowlist, and 4 MiB size cap
     * via descriptor-verified bounded reads, returning `encoding: 'utf8'` for
     * text kinds and `encoding: 'base64'` for images, plus `sha256Changed`
     * (`hashChanged`) comparing current bytes against the registered `sha256`.
     */
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

        if (options?.sessionId !== undefined && record.sessionId !== options.sessionId) {
            throw new ArtifactGuardError(
                'artifact_session_mismatch',
                `Artifact "${artifactId}" does not belong to session "${options.sessionId}" (artifact_session_mismatch)`,
            );
        }

        const pinnedCanonicalRoot = path.resolve(record.workspaceRoot);
        let storedRootLstat: fs.Stats;
        let currentRealStoredRoot: string;
        try {
            storedRootLstat = fs.lstatSync(pinnedCanonicalRoot);
            currentRealStoredRoot = fs.realpathSync(pinnedCanonicalRoot);
        } catch {
            throw new ArtifactGuardError(
                'path_outside_workspace',
                'Stored canonical workspace root is missing or inaccessible (path_outside_workspace)',
            );
        }
        if (
            storedRootLstat.isSymbolicLink() ||
            !storedRootLstat.isDirectory() ||
            currentRealStoredRoot !== pinnedCanonicalRoot
        ) {
            throw new ArtifactGuardError(
                'path_outside_workspace',
                'Stored canonical workspace root was redirected or replaced by a symbolic link (path_outside_workspace)',
            );
        }

        if (options?.trustedWorkspaceRoot !== undefined) {
            let realTrustedRoot: string;
            try {
                realTrustedRoot = fs.realpathSync(options.trustedWorkspaceRoot);
            } catch {
                throw new ArtifactGuardError(
                    'invalid_workspace_root',
                    'Trusted workspace root cannot be resolved (invalid_workspace_root)',
                );
            }
            if (realTrustedRoot !== pinnedCanonicalRoot) {
                throw new ArtifactGuardError(
                    'path_outside_workspace',
                    `Artifact workspace root does not match trusted workspace root (path_outside_workspace)`,
                );
            }
        }

        const verified = readVerifiedArtifactFile(pinnedCanonicalRoot, record.relPath, {
            declaredKind: record.kind,
            declaredMime: record.mime,
            title: record.title,
            pinnedCanonicalWorkspaceRoot: pinnedCanonicalRoot,
            _testHooks: options?._testHooks,
        });

        const encoding: 'utf8' | 'base64' = record.kind === 'image' ? 'base64' : 'utf8';
        const content =
            encoding === 'base64'
                ? verified.buffer.toString('base64')
                : verified.buffer.toString('utf8');
        const sha256Changed = verified.sha256 !== record.sha256;

        return {
            artifactId: record.artifactId,
            sessionId: record.sessionId,
            relPath: record.relPath,
            kind: record.kind,
            mime: record.mime,
            title: record.title,
            content,
            encoding,
            sizeBytes: verified.sizeBytes,
            sha256: verified.sha256,
            registeredSha256: record.sha256,
            sha256Changed,
            hashChanged: sha256Changed,
        };
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
