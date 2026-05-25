import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { LOG } from '../logging/logger';
import { getLedgerDir } from './mesh-ledger.js';
import type { MeshWorkQueueEntry, MeshTaskStatus } from './mesh-work-queue.js';

export class BeadsDB {
    private db: Database.Database;
    private static instance: BeadsDB | null = null;

    private constructor(dbPath: string) {
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        this.db = new Database(dbPath, {
            fileMustExist: false,
        });
        
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('foreign_keys = ON');
        
        this.migrate();
    }

    public static getInstance(): BeadsDB {
        if (!BeadsDB.instance) {
            // Store beads.db in the mesh ledger dir
            const dbPath = path.join(getLedgerDir(), 'beads.db');
            BeadsDB.instance = new BeadsDB(dbPath);
        }
        return BeadsDB.instance;
    }

    private migrate() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS mesh_queue (
                id TEXT PRIMARY KEY,
                mesh_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                target_node_id TEXT,
                target_session_id TEXT,
                assigned_node_id TEXT,
                assigned_session_id TEXT,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_mesh_queue_mesh_id_status ON mesh_queue(mesh_id, status);
        `);
        LOG.info('BeadsDB', 'Database initialized and migrated.');
    }

    // --- Queue Methods ---
    
    public upsertQueueEntry(entry: MeshWorkQueueEntry): void {
        const stmt = this.db.prepare(`
            INSERT INTO mesh_queue (id, mesh_id, status, target_node_id, target_session_id, assigned_node_id, assigned_session_id, payload, created_at, updated_at)
            VALUES (@id, @mesh_id, @status, @target_node_id, @target_session_id, @assigned_node_id, @assigned_session_id, @payload, @created_at, @updated_at)
            ON CONFLICT(id) DO UPDATE SET
                status = excluded.status,
                target_node_id = excluded.target_node_id,
                target_session_id = excluded.target_session_id,
                assigned_node_id = excluded.assigned_node_id,
                assigned_session_id = excluded.assigned_session_id,
                payload = excluded.payload,
                updated_at = excluded.updated_at
        `);
        
        stmt.run({
            id: entry.id,
            mesh_id: entry.meshId,
            status: entry.status,
            target_node_id: entry.targetNodeId || null,
            target_session_id: entry.targetSessionId || null,
            assigned_node_id: entry.assignedNodeId || null,
            assigned_session_id: entry.assignedSessionId || null,
            payload: JSON.stringify(entry),
            created_at: entry.createdAt,
            updated_at: entry.updatedAt,
        });
    }

    public getQueueEntries(meshId: string, statuses?: MeshTaskStatus[]): MeshWorkQueueEntry[] {
        let stmt;
        let rows;
        if (statuses && statuses.length > 0) {
            const placeholders = statuses.map(() => '?').join(',');
            stmt = this.db.prepare(`SELECT payload FROM mesh_queue WHERE mesh_id = ? AND status IN (${placeholders}) ORDER BY created_at ASC`);
            rows = stmt.all(meshId, ...statuses);
        } else {
            stmt = this.db.prepare(`SELECT payload FROM mesh_queue WHERE mesh_id = ? ORDER BY created_at ASC`);
            rows = stmt.all(meshId);
        }
        
        return rows.map((r: any) => JSON.parse(r.payload));
    }
    
    public deleteQueueEntry(id: string): void {
        this.db.prepare('DELETE FROM mesh_queue WHERE id = ?').run(id);
    }
}

