/**
 * mesh_task_outputs — one immutable, versioned completion envelope per task
 * terminal (append-only: a later terminal is a NEW (task_id, version) row,
 * never a mutation). Written by the terminal choke point (mesh-task-terminal.ts)
 * and read by:
 *   - the "Upstream results" dispatch appendix of a `depends_on` task
 *     (mesh-upstream-results.ts),
 *   - the dashboard task-detail completion summary (`mesh_task_output`),
 *   - the queue dependency notice's dedupe generation.
 *
 * Retention rides the terminal-queue prune (mesh-runtime-store-queue-reads.ts):
 * an output has no window of its own.
 *
 * This module also owns the one-way removal of the retired graph-orchestration
 * control plane (graphs / nodes / edges / gates / workspace intents / outbox and
 * the queue rows' graph-owned `blockedReason` holds). Queue tasks with
 * `dependsOn` replaced it; old rows are discarded on boot.
 */

import type { Database as DatabaseHandle } from 'better-sqlite3';

export interface MeshTaskOutputRow {
    taskId: string;
    version: number;
    meshId: string;
    attempt: number;
    status: string;
    /** The normalized completion envelope JSON. */
    envelopeJson: string;
    digest: string;
    createdAt: string;
}

/** The retired graph-orchestration tables, dropped once on the next boot. */
const RETIRED_GRAPH_TABLES = [
    'mesh_graph_outbox',
    'mesh_graph_workspace_intents',
    'mesh_graph_gates',
    'mesh_task_graph_edges',
    'mesh_task_graph_nodes',
    'mesh_task_graphs',
] as const;

/**
 * Create mesh_task_outputs and drop the retired graph tables. Idempotent: every
 * statement is IF [NOT] EXISTS or guarded by a column probe, so it runs on every
 * boot like the rest of MeshRuntimeStore.migrate().
 *
 * The graph drop is irreversible by design (owner decision 2026-09-30: graph
 * orchestration simplified to queue `dependsOn`); nothing reads those rows any
 * more, and a graph-backed queue row keeps working as a plain queue task because
 * its `dependsOn` projection was always written onto the queue row itself.
 */
export function migrateMeshTaskOutputs(db: DatabaseHandle): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS mesh_task_outputs (
            task_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            mesh_id TEXT NOT NULL,
            attempt INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL,
            envelope_json TEXT NOT NULL,
            digest TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (task_id, version)
        );

        CREATE INDEX IF NOT EXISTS idx_mesh_task_outputs_mesh
            ON mesh_task_outputs(mesh_id);
    `);
    db.transaction(() => {
        for (const table of RETIRED_GRAPH_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
        // `blockedReason` was written only by the graph engine (materialization /
        // coordinator-gate / workspace holds). A still-pending row held that way
        // was waiting on a gate or a graph step that no longer exists: it is
        // cancelled rather than released, because releasing would run work a gate
        // was holding back (e.g. an approval). Every other row just sheds the key.
        const nowIso = new Date().toISOString();
        db.prepare(`
            UPDATE mesh_queue SET
                status = 'cancelled',
                updated_at = @now,
                payload = json_remove(
                    json_set(payload, '$.status', 'cancelled', '$.cancelledAt', @now,
                        '$.cancelReason', 'graph_orchestration_retired', '$.updatedAt', @now),
                    '$.blockedReason')
            WHERE status = 'pending' AND json_valid(payload)
              AND json_extract(payload, '$.blockedReason') IS NOT NULL
        `).run({ now: nowIso });
        db.exec(`
            UPDATE mesh_queue SET payload = json_remove(payload, '$.blockedReason')
            WHERE json_valid(payload) AND json_extract(payload, '$.blockedReason') IS NOT NULL
        `);
        // An upgraded DB carries the graph columns on mesh_task_outputs. The index
        // over them must go first (SQLite refuses to drop an indexed column).
        db.exec(`DROP INDEX IF EXISTS idx_mesh_task_outputs_graph_node`);
        const columns = new Set(
            (db.prepare(`PRAGMA table_info(mesh_task_outputs)`).all() as Array<{ name: string }>).map(c => c.name),
        );
        if (columns.has('graph_id')) db.exec(`ALTER TABLE mesh_task_outputs DROP COLUMN graph_id`);
        if (columns.has('node_id')) db.exec(`ALTER TABLE mesh_task_outputs DROP COLUMN node_id`);
    })();
}

/** Append-only: a later terminal is a NEW (task_id, version) row. */
export function insertTaskOutput(db: DatabaseHandle, row: MeshTaskOutputRow): void {
    db.prepare(`
        INSERT INTO mesh_task_outputs (
            task_id, version, mesh_id, attempt, status, envelope_json, digest, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        row.taskId, row.version, row.meshId, row.attempt,
        row.status, row.envelopeJson, row.digest, row.createdAt,
    );
}

export function getLatestTaskOutput(db: DatabaseHandle, taskId: string): MeshTaskOutputRow | null {
    const r = db.prepare(
        `SELECT task_id, version, mesh_id, attempt, status, envelope_json, digest, created_at
         FROM mesh_task_outputs WHERE task_id = ? ORDER BY version DESC LIMIT 1`,
    ).get(taskId) as {
        task_id: string; version: number; mesh_id: string; attempt: number; status: string;
        envelope_json: string; digest: string; created_at: string;
    } | undefined;
    if (!r) return null;
    return {
        taskId: r.task_id,
        version: r.version,
        meshId: r.mesh_id,
        attempt: r.attempt,
        status: r.status,
        envelopeJson: r.envelope_json,
        digest: r.digest,
        createdAt: r.created_at,
    };
}
