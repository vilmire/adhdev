import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import { getLedgerDir } from './mesh-ledger.js';
import type { MeshTaskStatus, MeshWorkQueueEntry } from './mesh-work-queue.js';
import type BetterSqlite3 from 'better-sqlite3';
import type { Database as DatabaseHandle } from 'better-sqlite3';

let DatabaseCtor: typeof BetterSqlite3 | undefined;

function loadDatabaseCtor(): typeof BetterSqlite3 {
    if (DatabaseCtor) return DatabaseCtor;
    const runtimeRequire = typeof require === 'function'
        ? require
        : createRequire(import.meta.url);
    DatabaseCtor = runtimeRequire('better-sqlite3') as typeof BetterSqlite3;
    return DatabaseCtor;
}

function safeMeshId(meshId: string): string {
    return meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function legacyQueuePath(meshId: string): string {
    return join(getLedgerDir(), `${safeMeshId(meshId)}.queue.json`);
}

export class BeadsDB {
    private static instance: BeadsDB | undefined;
    private readonly db: DatabaseHandle;
    private readonly migratedMeshIds = new Set<string>();

    private constructor(dbPath: string) {
        const dir = dirname(dbPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

        this.db = new (loadDatabaseCtor())(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('foreign_keys = ON');
        this.db.pragma('busy_timeout = 5000');
        this.migrate();
    }

    static getInstance(): BeadsDB {
        if (!this.instance) {
            this.instance = new BeadsDB(join(getLedgerDir(), 'beads.db'));
        }
        return this.instance;
    }

    static resetForTests(): void {
        this.instance?.close();
        this.instance = undefined;
    }

    close(): void {
        this.db.close();
    }

    transaction<T>(fn: () => T): T {
        return this.db.transaction(fn).immediate();
    }

    private migrate(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS mesh_queue (
                id TEXT PRIMARY KEY,
                mesh_id TEXT NOT NULL,
                status TEXT NOT NULL,
                target_node_id TEXT,
                target_session_id TEXT,
                assigned_node_id TEXT,
                assigned_session_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                payload TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_mesh_queue_mesh_status_created
                ON mesh_queue(mesh_id, status, created_at);
            CREATE INDEX IF NOT EXISTS idx_mesh_queue_assignment
                ON mesh_queue(mesh_id, assigned_node_id, assigned_session_id, status);

            CREATE TABLE IF NOT EXISTS mesh_completion_fingerprints (
                fingerprint TEXT PRIMARY KEY,
                expires_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS mesh_direct_dispatches (
                task_id TEXT PRIMARY KEY,
                mesh_id TEXT NOT NULL,
                node_id TEXT,
                session_id TEXT,
                provider_type TEXT,
                message TEXT NOT NULL,
                task_mode TEXT,
                via TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'dispatched',
                dispatched_to_idle_session INTEGER NOT NULL DEFAULT 0,
                dispatched_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_direct_dispatches_mesh_session
                ON mesh_direct_dispatches(mesh_id, session_id, status);
        `);
    }

    hasCompletionFingerprint(fingerprint: string): boolean {
        const now = Date.now();
        const row = this.db
            .prepare('SELECT 1 FROM mesh_completion_fingerprints WHERE fingerprint = ? AND expires_at > ?')
            .get(fingerprint, now) as { 1: number } | undefined;
        return row !== undefined;
    }

    recordCompletionFingerprint(fingerprint: string, ttlMs: number): void {
        const expiresAt = Date.now() + ttlMs;
        this.db.prepare('INSERT OR REPLACE INTO mesh_completion_fingerprints (fingerprint, expires_at) VALUES (?, ?)')
            .run(fingerprint, expiresAt);
    }

    sweepExpiredFingerprints(): void {
        this.db.prepare('DELETE FROM mesh_completion_fingerprints WHERE expires_at <= ?').run(Date.now());
    }

    private ensureLegacyQueueMigrated(meshId: string): void {
        if (this.migratedMeshIds.has(meshId)) return;
        this.migratedMeshIds.add(meshId);

        const count = this.db
            .prepare('SELECT COUNT(*) AS count FROM mesh_queue WHERE mesh_id = ?')
            .get(meshId) as { count: number };
        if (count.count > 0) return;

        const path = legacyQueuePath(meshId);
        if (!existsSync(path)) return;

        try {
            const entries = JSON.parse(readFileSync(path, 'utf-8')) as MeshWorkQueueEntry[];
            if (!Array.isArray(entries)) return;
            const insert = this.db.prepare(`
                INSERT OR REPLACE INTO mesh_queue (
                    id, mesh_id, status, target_node_id, target_session_id,
                    assigned_node_id, assigned_session_id, created_at, updated_at, payload
                ) VALUES (
                    @id, @meshId, @status, @targetNodeId, @targetSessionId,
                    @assignedNodeId, @assignedSessionId, @createdAt, @updatedAt, @payload
                )
            `);
            for (const entry of entries) {
                insert.run(this.toRow(entry));
            }
        } catch {
            return;
        }
    }

    getQueueEntries(meshId: string, statuses?: MeshTaskStatus[]): MeshWorkQueueEntry[] {
        this.ensureLegacyQueueMigrated(meshId);
        if (statuses?.length) {
            const placeholders = statuses.map(() => '?').join(', ');
            const rows = this.db
                .prepare(`SELECT payload FROM mesh_queue WHERE mesh_id = ? AND status IN (${placeholders}) ORDER BY created_at ASC`)
                .all(meshId, ...statuses) as Array<{ payload: string }>;
            return rows.map(row => JSON.parse(row.payload) as MeshWorkQueueEntry);
        }
        const rows = this.db
            .prepare('SELECT payload FROM mesh_queue WHERE mesh_id = ? ORDER BY created_at ASC')
            .all(meshId) as Array<{ payload: string }>;
        return rows.map(row => JSON.parse(row.payload) as MeshWorkQueueEntry);
    }

    getQueueRevision(meshId: string): string {
        this.ensureLegacyQueueMigrated(meshId);
        const rows = this.db
            .prepare('SELECT id, status, updated_at FROM mesh_queue WHERE mesh_id = ? ORDER BY id ASC')
            .all(meshId) as Array<{ id: string; status: string; updated_at: string }>;
        // Tab as field delimiter (UUIDs and ISO timestamps never contain tabs).
        return rows.map(row => `${row.id}\t${row.status}\t${row.updated_at}`).join('\n');
    }

    replaceQueue(meshId: string, queue: MeshWorkQueueEntry[]): void {
        const deleteStmt = this.db.prepare('DELETE FROM mesh_queue WHERE mesh_id = ?');
        const insert = this.db.prepare(`
            INSERT INTO mesh_queue (
                id, mesh_id, status, target_node_id, target_session_id,
                assigned_node_id, assigned_session_id, created_at, updated_at, payload
            ) VALUES (
                @id, @meshId, @status, @targetNodeId, @targetSessionId,
                @assignedNodeId, @assignedSessionId, @createdAt, @updatedAt, @payload
            )
        `);
        deleteStmt.run(meshId);
        for (const entry of queue) insert.run(this.toRow(entry));
    }

    deleteQueue(meshId: string): void {
        this.db.prepare('DELETE FROM mesh_queue WHERE mesh_id = ?').run(meshId);
        this.migratedMeshIds.delete(meshId);
    }

    private toRow(entry: MeshWorkQueueEntry): Record<string, unknown> {
        return {
            id: entry.id,
            meshId: entry.meshId,
            status: entry.status,
            targetNodeId: entry.targetNodeId ?? null,
            targetSessionId: entry.targetSessionId ?? null,
            assignedNodeId: entry.assignedNodeId ?? null,
            assignedSessionId: entry.assignedSessionId ?? null,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            payload: JSON.stringify(entry),
        };
    }

    // ── Direct Dispatch Tracking ─────────────────────────────────────────────

    insertDirectDispatch(entry: {
        taskId: string;
        meshId: string;
        nodeId?: string;
        sessionId?: string;
        providerType?: string;
        message: string;
        taskMode?: string;
        via: string;
        dispatchedToIdleSession?: boolean;
        dispatchedAt: string;
    }): void {
        const now = new Date().toISOString();
        this.db.prepare(`
            INSERT OR REPLACE INTO mesh_direct_dispatches
                (task_id, mesh_id, node_id, session_id, provider_type, message, task_mode, via,
                 status, dispatched_to_idle_session, dispatched_at, updated_at)
            VALUES
                (@taskId, @meshId, @nodeId, @sessionId, @providerType, @message, @taskMode, @via,
                 'dispatched', @dispatchedToIdle, @dispatchedAt, @updatedAt)
        `).run({
            taskId: entry.taskId,
            meshId: entry.meshId,
            nodeId: entry.nodeId ?? null,
            sessionId: entry.sessionId ?? null,
            providerType: entry.providerType ?? null,
            message: entry.message,
            taskMode: entry.taskMode ?? null,
            via: entry.via,
            dispatchedToIdle: entry.dispatchedToIdleSession ? 1 : 0,
            dispatchedAt: entry.dispatchedAt,
            updatedAt: now,
        });
    }

    getActiveDirectDispatches(meshId: string): Array<{
        taskId: string;
        meshId: string;
        nodeId: string | null;
        sessionId: string | null;
        providerType: string | null;
        message: string;
        taskMode: string | null;
        via: string;
        status: string;
        dispatchedToIdleSession: boolean;
        dispatchedAt: string;
        updatedAt: string;
    }> {
        const rows = this.db.prepare(`
            SELECT task_id, mesh_id, node_id, session_id, provider_type, message, task_mode, via,
                   status, dispatched_to_idle_session, dispatched_at, updated_at
            FROM mesh_direct_dispatches
            WHERE mesh_id = ? AND status NOT IN ('completed', 'failed', 'stale')
            ORDER BY dispatched_at ASC
        `).all(meshId) as Array<Record<string, unknown>>;
        return rows.map(r => ({
            taskId: r.task_id as string,
            meshId: r.mesh_id as string,
            nodeId: r.node_id as string | null,
            sessionId: r.session_id as string | null,
            providerType: r.provider_type as string | null,
            message: r.message as string,
            taskMode: r.task_mode as string | null,
            via: r.via as string,
            status: r.status as string,
            dispatchedToIdleSession: (r.dispatched_to_idle_session as number) === 1,
            dispatchedAt: r.dispatched_at as string,
            updatedAt: r.updated_at as string,
        }));
    }

    updateDirectDispatchStatus(meshId: string, sessionId: string, status: 'acked' | 'completed' | 'failed' | 'stale'): void {
        if (!sessionId) return; // never update rows without a session binding
        const now = new Date().toISOString();
        this.db.prepare(`
            UPDATE mesh_direct_dispatches
            SET status = @status, updated_at = @updatedAt
            WHERE mesh_id = @meshId AND session_id = @sessionId
              AND session_id IS NOT NULL
              AND status NOT IN ('completed', 'failed')
        `).run({ status, meshId, sessionId, updatedAt: now });
    }

    cleanupTerminalDirectDispatches(olderThanMs: number): void {
        const cutoff = new Date(Date.now() - olderThanMs).toISOString();
        this.db.prepare(`
            DELETE FROM mesh_direct_dispatches
            WHERE status IN ('completed', 'failed', 'stale') AND updated_at < ?
        `).run(cutoff);
    }

    markStaleDirectDispatches(meshId: string, olderThanMs: number): void {
        const cutoff = new Date(Date.now() - olderThanMs).toISOString();
        const now = new Date().toISOString();
        this.db.prepare(`
            UPDATE mesh_direct_dispatches
            SET status = 'stale', updated_at = ?
            WHERE mesh_id = ? AND status = 'dispatched' AND dispatched_at < ?
        `).run(now, meshId, cutoff);
    }
}
