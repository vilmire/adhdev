/**
 * MeshRuntimeStore queue / direct-dispatch reads that avoid parsing row payloads.
 *
 * IPC load audit 2026-09-23 (Phase P). Queue payloads carry the whole task, including a
 * task `input` envelope (base64 image parts) for the row's 30-day life, so any read that
 * `JSON.parse`s every row in a status is O(bytes in the mesh), not O(rows it needs):
 *   - findAssignedBySession ran on every worker tool call (bind-path identity) and
 *     parsed every assigned row of the mesh to match one session (audit #9);
 *   - pruneTerminalQueueEntries parsed every pending/assigned row of EVERY mesh and
 *     full-scanned the table (audit table row 8);
 *   - trigger_mesh_queue parsed the whole queue twice just to diff statuses (audit #10).
 * These now decide on columns (id / status / assigned_session_id) and parse at most the
 * one row they return. Same `self`-passing extraction pattern as the other
 * mesh-runtime-store-*.ts modules; the class keeps thin delegators.
 */

import { sessionIdsEquivalent } from '@adhdev/mesh-shared';
import type { MeshRuntimeStore } from './mesh-runtime-store.js';
import type { MeshTaskStatus, MeshWorkQueueEntry } from './mesh-work-queue.js';

/** Column-only view of a queue row: enough to count, diff and route, never the payload. */
export interface MeshQueueHead {
    id: string;
    status: MeshTaskStatus;
    assignedNodeId?: string;
    assignedSessionId?: string;
}

function parseQueuePayloadByRowid(self: MeshRuntimeStore, rowid: number): MeshWorkQueueEntry | null {
    const row = self.db.prepare('SELECT payload FROM mesh_queue WHERE rowid = ?').get(rowid) as { payload: string } | undefined;
    if (!row) return null;
    try { return JSON.parse(row.payload) as MeshWorkQueueEntry; } catch { return null; }
}

/**
 * Resolve the `assigned` queue row a completion event / worker bind belongs to. Contract and
 * clock-skew rules are documented on MeshRuntimeStore.findAssignedBySession.
 *
 * Session membership is decided on the `assigned_session_id` COLUMN, which every assignment
 * writer sets from the same value it stores in `payload.assignedSessionId` (toRow, and the
 * claim UPDATE that writes both in one statement). Only the returned row is parsed; the
 * dispatch-time ordering keys are extracted in SQL for the rare multi-row case.
 */
export function findAssignedBySession(
    self: MeshRuntimeStore,
    meshId: string,
    sessionId: string,
    occurredAtIso?: string,
    taskId?: string,
): MeshWorkQueueEntry | null {
    self.ensureLegacyQueueMigrated(meshId);
    // WRITE/READ PREDICATE SYMMETRY (COMPLETION-PROPAGATION F1): session membership is
    // filtered in JS with sessionIdsEquivalent (trimming), never a raw `= ?`, so an
    // equivalent-but-not-byte-identical session id still matches its row.
    const heads = self.db.prepare(
        `SELECT rowid AS rid, id, assigned_session_id FROM mesh_queue WHERE mesh_id = ? AND status = 'assigned'`
    ).all(meshId) as Array<{ rid: number; id: string; assigned_session_id: string | null }>;
    const matches = heads.filter(h => sessionIdsEquivalent(h.assigned_session_id ?? undefined, sessionId));

    // 1. Exact taskId match — robust against clock skew and stale rows.
    if (taskId) {
        const byId = matches.find(h => h.id === taskId);
        const entry = byId ? parseQueuePayloadByRowid(self, byId.rid) : null;
        if (entry) return entry;
        // Fall through to session-based matching if the id didn't line up.
    }

    // 2. Session-based match WITHOUT the mutable updated_at filter.
    if (matches.length === 0) return null;
    if (matches.length === 1) return parseQueuePayloadByRowid(self, matches[0].rid);

    // Several assigned rows for one session: ORDER (never filter) by the immutable
    // dispatchTimestamp, falling back to payload.updatedAt for legacy rows. A row whose
    // payload is not valid JSON is skipped, as the full-parse implementation did.
    const keyRows = self.db.prepare(
        `SELECT rowid AS rid,
                CASE WHEN json_valid(payload) THEN json_extract(payload, '$.dispatchTimestamp', '$.updatedAt') END AS k
         FROM mesh_queue WHERE rowid IN (${matches.map(() => '?').join(', ')})`
    ).all(...matches.map(m => m.rid)) as Array<{ rid: number; k: string | null }>;
    const keyed: Array<{ rid: number; key: string }> = [];
    for (const row of keyRows) {
        if (row.k === null) continue;
        let parts: unknown;
        try { parts = JSON.parse(row.k); } catch { continue; }
        const [dispatchTs, updatedAt] = Array.isArray(parts) ? parts : [];
        const key = typeof dispatchTs === 'string' ? dispatchTs : typeof updatedAt === 'string' ? updatedAt : '';
        keyed.push({ rid: row.rid, key });
    }
    if (keyed.length === 0) return null;
    keyed.sort((a, b) => b.key.localeCompare(a.key));
    if (occurredAtIso) {
        const atOrBefore = keyed.find(k => k.key <= occurredAtIso);
        if (atOrBefore) return parseQueuePayloadByRowid(self, atOrBefore.rid);
    }
    // Skew made every dispatch later than occurredAt — the most recent dispatch wins.
    return parseQueuePayloadByRowid(self, keyed[0].rid);
}

/** Column-only queue rows for a mesh, optionally by status, in created_at order. */
export function getQueueHeads(self: MeshRuntimeStore, meshId: string, statuses?: MeshTaskStatus[]): MeshQueueHead[] {
    self.ensureLegacyQueueMigrated(meshId);
    const statusClause = statuses?.length ? ` AND status IN (${statuses.map(() => '?').join(', ')})` : '';
    const rows = self.db.prepare(
        `SELECT id, status, assigned_node_id, assigned_session_id FROM mesh_queue
         WHERE mesh_id = ?${statusClause} ORDER BY created_at ASC`
    ).all(meshId, ...(statuses ?? [])) as Array<{ id: string; status: MeshTaskStatus; assigned_node_id: string | null; assigned_session_id: string | null }>;
    return rows.map(r => ({
        id: r.id,
        status: r.status,
        ...(r.assigned_node_id ? { assignedNodeId: r.assigned_node_id } : {}),
        ...(r.assigned_session_id ? { assignedSessionId: r.assigned_session_id } : {}),
    }));
}

/**
 * Retention prune for TERMINAL queue rows (contract on MeshRuntimeStore.pruneTerminalQueueEntries).
 * One statement: the dependency guard (ids a pending/assigned row lists in `dependsOn`) is
 * computed by SQLite's json_each instead of parsing every live payload in JS, and the
 * status + updated_at filters are served by idx_mesh_queue_status_updated.
 */
export function pruneTerminalQueueEntries(self: MeshRuntimeStore, olderThanMs: number): number {
    const cutoffIso = new Date(Date.now() - Math.max(0, olderThanMs)).toISOString();
    return self.db.prepare(
        `WITH live AS (
             SELECT CASE WHEN json_valid(payload) THEN payload ELSE '{}' END AS p
             FROM mesh_queue WHERE status IN ('pending', 'assigned')
         ),
         protected AS (
             SELECT dep.value AS id
             FROM live, json_each(live.p, '$.dependsOn') AS dep
             WHERE json_type(live.p, '$.dependsOn') = 'array' AND dep.type = 'text' AND dep.value <> ''
         )
         DELETE FROM mesh_queue
         WHERE status IN ('completed', 'cancelled', 'failed') AND updated_at < ?
           AND id NOT IN (SELECT id FROM protected)`
    ).run(cutoffIso).changes;
}

/**
 * IPC load audit #1: expire direct-dispatch rows that are still `dispatched`/`acked` but have
 * had no lifecycle update (ack / terminal) for `olderThanMs`. Such a row never resolves by
 * itself — the only live one in the audit had been `acked` since 2026-08-09 — yet it kept
 * the auto-prune loop from taking its O(1) "nothing active" exit, costing a status snapshot
 * per node plus a 64 MB ledger read every minute. Flipped to 'stale' (not deleted, not
 * completed/failed): stale says "will never resolve itself" without asserting an outcome,
 * and a late completion can still move it to completed. Returns the rows it flipped.
 */
export function expireAgedDirectDispatches(
    self: MeshRuntimeStore,
    meshId: string,
    olderThanMs: number,
    nowMs: number = Date.now(),
): Array<{ taskId: string; sessionId: string | null; status: string; updatedAt: string }> {
    const cutoffIso = new Date(nowMs - Math.max(0, olderThanMs)).toISOString();
    return self.transaction(() => {
        const rows = self.db.prepare(
            `SELECT task_id, session_id, status, updated_at FROM mesh_direct_dispatches
             WHERE mesh_id = ? AND status IN ('dispatched', 'acked') AND updated_at < ?`
        ).all(meshId, cutoffIso) as Array<{ task_id: string; session_id: string | null; status: string; updated_at: string }>;
        if (rows.length === 0) return [];
        const flip = self.db.prepare(
            `UPDATE mesh_direct_dispatches SET status = 'stale', updated_at = ?
             WHERE mesh_id = ? AND task_id = ? AND status IN ('dispatched', 'acked')`
        );
        const nowIso = new Date(nowMs).toISOString();
        for (const row of rows) flip.run(nowIso, meshId, row.task_id);
        return rows.map(r => ({ taskId: r.task_id, sessionId: r.session_id, status: r.status, updatedAt: r.updated_at }));
    });
}
