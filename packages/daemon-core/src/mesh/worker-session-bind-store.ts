/**
 * Durable worker session bind registry over `mesh-runtime.db`
 * (the persistence port of `../worker-session-bind-registry.ts`).
 *
 * Why it exists: with session-host restore a daemon restart does not kill the
 * worker, and the worker's MCP server holds the bind in its process env from
 * spawn. An in-memory-only registry refused every report/drain/progress call
 * from a restored worker (`origin=restore`). This table lets the restarted
 * daemon recognise the bind again.
 *
 * ★Only SHA-256(bind) is stored — never the secret. Ids and times otherwise.
 * Local-only: no seqscribe topic, never projected to the cloud status path.
 */

import type { Database as DatabaseHandle } from 'better-sqlite3';
import type { PersistedWorkerSessionBind, WorkerSessionBindPersistence } from '../worker-session-bind-registry.js';

/** Additive, idempotent (run by `MeshRuntimeStore.migrate`). */
export function ensureWorkerSessionBindSchema(db: DatabaseHandle): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS worker_session_binds (
            bind_hash TEXT PRIMARY KEY,
            mesh_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            node_id TEXT,
            spawned_for_task_id TEXT,
            minted_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_worker_session_binds_session
            ON worker_session_binds(session_id);
    `);
}

interface BindDbRow {
    bind_hash: string;
    mesh_id: string;
    session_id: string;
    node_id: string | null;
    spawned_for_task_id: string | null;
    minted_at: number;
}

function toRow(r: BindDbRow): PersistedWorkerSessionBind {
    return {
        bindHash: r.bind_hash,
        meshId: r.mesh_id,
        sessionId: r.session_id,
        ...(r.node_id ? { nodeId: r.node_id } : {}),
        ...(r.spawned_for_task_id ? { spawnedForTaskId: r.spawned_for_task_id } : {}),
        mintedAtMs: r.minted_at,
    };
}

export class SqliteWorkerSessionBindStore implements WorkerSessionBindPersistence {
    constructor(private readonly db: DatabaseHandle) {}

    put(row: PersistedWorkerSessionBind): void {
        this.db.prepare(`
            INSERT OR REPLACE INTO worker_session_binds
                (bind_hash, mesh_id, session_id, node_id, spawned_for_task_id, minted_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(row.bindHash, row.meshId, row.sessionId, row.nodeId ?? null, row.spawnedForTaskId ?? null, row.mintedAtMs);
    }

    get(bindHash: string): PersistedWorkerSessionBind | null {
        const r = this.db.prepare('SELECT * FROM worker_session_binds WHERE bind_hash = ?').get(bindHash) as BindDbRow | undefined;
        return r ? toRow(r) : null;
    }

    delete(bindHash: string): void {
        this.db.prepare('DELETE FROM worker_session_binds WHERE bind_hash = ?').run(bindHash);
    }

    deleteForSession(sessionId: string): number {
        return this.db.prepare('DELETE FROM worker_session_binds WHERE session_id = ?').run(sessionId).changes;
    }

    list(): PersistedWorkerSessionBind[] {
        return (this.db.prepare('SELECT * FROM worker_session_binds').all() as BindDbRow[]).map(toRow);
    }
}
