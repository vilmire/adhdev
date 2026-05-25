import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { getLedgerDir } from './mesh-ledger.js';
import type { MeshTaskStatus, MeshWorkQueueEntry } from './mesh-work-queue.js';

function safeMeshId(meshId: string): string {
    return meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function legacyQueuePath(meshId: string): string {
    return join(getLedgerDir(), `${safeMeshId(meshId)}.queue.json`);
}

export class BeadsDB {
    private static instance: BeadsDB | undefined;
    private readonly db: Database.Database;
    private readonly migratedMeshIds = new Set<string>();

    private constructor(dbPath: string) {
        const dir = dirname(dbPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

        this.db = new Database(dbPath);
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
        `);
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
        return rows.map(row => `${row.id}:${row.status}:${row.updated_at}`).join('|');
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
}
