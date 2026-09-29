import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { getLatestTaskOutput, insertTaskOutput, migrateMeshTaskOutputs } from '../../src/mesh/mesh-task-outputs.js';

// The retired graph-orchestration control plane is dropped on the next boot:
// its tables go, the graph columns leave mesh_task_outputs (rows kept), and a
// queue row still held by a graph-owned `blockedReason` is cancelled rather
// than released (a gate may have been holding it back).

function legacyDb(): Database.Database {
    const db = new Database(':memory:');
    db.exec(`
        CREATE TABLE mesh_queue (
            id TEXT PRIMARY KEY, mesh_id TEXT NOT NULL, status TEXT NOT NULL,
            target_node_id TEXT, target_session_id TEXT, assigned_node_id TEXT, assigned_session_id TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL
        );
        CREATE TABLE mesh_task_graphs (graph_id TEXT PRIMARY KEY, mesh_id TEXT NOT NULL);
        CREATE TABLE mesh_task_graph_nodes (graph_id TEXT, node_id TEXT);
        CREATE TABLE mesh_task_graph_edges (graph_id TEXT, from_node_id TEXT, to_node_id TEXT);
        CREATE TABLE mesh_graph_gates (gate_id TEXT PRIMARY KEY);
        CREATE TABLE mesh_graph_workspace_intents (graph_id TEXT, workspace_ref TEXT);
        CREATE TABLE mesh_graph_outbox (id TEXT PRIMARY KEY);
        CREATE TABLE mesh_task_outputs (
            task_id TEXT NOT NULL, version INTEGER NOT NULL, mesh_id TEXT NOT NULL,
            graph_id TEXT, node_id TEXT, attempt INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL,
            envelope_json TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL,
            PRIMARY KEY (task_id, version)
        );
        CREATE INDEX idx_mesh_task_outputs_graph_node ON mesh_task_outputs(graph_id, node_id);
        INSERT INTO mesh_task_outputs VALUES ('t-old', 1, 'm', 'g1', 'n1', 1, 'completed', '{"final_summary":"ok"}', 'd', '2026-09-01T00:00:00.000Z');
    `);
    const row = (id: string, status: string, payload: Record<string, unknown>) => db.prepare(
        `INSERT INTO mesh_queue (id, mesh_id, status, created_at, updated_at, payload) VALUES (?, 'm', ?, 'c', 'u', ?)`,
    ).run(id, status, JSON.stringify({ id, meshId: 'm', status, ...payload }));
    row('held', 'pending', { blockedReason: 'coordinator_gate:g1:n2' });
    row('done', 'completed', { blockedReason: 'graph_materialization_pending:n3:1' });
    row('plain', 'pending', {});
    return db;
}

const tables = (db: Database.Database) =>
    (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map(r => r.name);
const payload = (db: Database.Database, id: string) =>
    JSON.parse((db.prepare('SELECT payload FROM mesh_queue WHERE id = ?').get(id) as { payload: string }).payload);

describe('migrateMeshTaskOutputs — graph orchestration retirement', () => {
    it('drops every graph table and the graph columns, keeping the output rows', () => {
        const db = legacyDb();
        migrateMeshTaskOutputs(db);
        const names = tables(db);
        for (const t of ['mesh_task_graphs', 'mesh_task_graph_nodes', 'mesh_task_graph_edges', 'mesh_graph_gates', 'mesh_graph_workspace_intents', 'mesh_graph_outbox']) {
            expect(names).not.toContain(t);
        }
        const columns = (db.prepare('PRAGMA table_info(mesh_task_outputs)').all() as Array<{ name: string }>).map(c => c.name);
        expect(columns).not.toContain('graph_id');
        expect(columns).not.toContain('node_id');
        expect(getLatestTaskOutput(db, 't-old')).toMatchObject({ taskId: 't-old', version: 1, status: 'completed' });
    });

    it('cancels a pending row held by a graph block and strips the key everywhere else', () => {
        const db = legacyDb();
        migrateMeshTaskOutputs(db);
        const held = payload(db, 'held');
        expect(held.status).toBe('cancelled');
        expect(held.cancelReason).toBe('graph_orchestration_retired');
        expect(held.blockedReason).toBeUndefined();
        expect((db.prepare('SELECT status FROM mesh_queue WHERE id = ?').get('held') as { status: string }).status).toBe('cancelled');
        expect(payload(db, 'done')).toMatchObject({ status: 'completed' });
        expect(payload(db, 'done').blockedReason).toBeUndefined();
        expect(payload(db, 'plain')).toMatchObject({ status: 'pending' });
    });

    it('is idempotent and creates the table fresh on a new database', () => {
        const legacy = legacyDb();
        migrateMeshTaskOutputs(legacy);
        expect(() => migrateMeshTaskOutputs(legacy)).not.toThrow();

        const fresh = new Database(':memory:');
        fresh.exec(`CREATE TABLE mesh_queue (id TEXT PRIMARY KEY, mesh_id TEXT, status TEXT, created_at TEXT, updated_at TEXT, payload TEXT)`);
        migrateMeshTaskOutputs(fresh);
        insertTaskOutput(fresh, {
            taskId: 't1', version: 1, meshId: 'm', attempt: 1, status: 'completed',
            envelopeJson: '{}', digest: 'd', createdAt: '2026-09-30T00:00:00.000Z',
        });
        expect(getLatestTaskOutput(fresh, 't1')?.version).toBe(1);
    });
});
