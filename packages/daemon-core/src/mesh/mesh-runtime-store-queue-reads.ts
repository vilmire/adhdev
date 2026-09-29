/**
 * MeshRuntimeStore queue / direct-dispatch reads that avoid parsing row payloads.
 * (C-W8: direct dispatches are read off the turn ledger's open `mesh_direct` attempts.)
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
 * The dependency guard (ids a pending/assigned row lists in `dependsOn`) is
 * computed by SQLite's json_each instead of parsing every live payload in JS, and the
 * status + updated_at filters are served by idx_mesh_queue_status_updated.
 *
 * ★The queue task's `mesh_task_outputs` rows (completion envelopes, keyed by the
 * queue task id) go in the SAME transaction, BEFORE the queue rows: an output has
 * no retention of its own, so the queue window is its window (measured
 * 2026-09-29: 2,046 such rows / 13 MB, oldest 2026-08-18, 755 already orphaned by
 * an earlier queue prune). An output survives while its task still has a queue
 * row that is not yet prunable or is a live `dependsOn` anchor
 * (`mesh-upstream-results` reads it), and is never younger than the window.
 */
export function pruneTerminalQueueEntriesDetailed(
    self: MeshRuntimeStore,
    olderThanMs: number,
): { queue: number; taskOutputs: number } {
    const cutoffIso = new Date(Date.now() - Math.max(0, olderThanMs)).toISOString();
    const protectedCte = `live AS (
             SELECT CASE WHEN json_valid(payload) THEN payload ELSE '{}' END AS p
             FROM mesh_queue WHERE status IN ('pending', 'assigned')
         ),
         protected AS (
             SELECT dep.value AS id
             FROM live, json_each(live.p, '$.dependsOn') AS dep
             WHERE json_type(live.p, '$.dependsOn') = 'array' AND dep.type = 'text' AND dep.value <> ''
         )`;
    return self.db.transaction(() => {
        const taskOutputs = self.db.prepare(
            `WITH ${protectedCte}
             DELETE FROM mesh_task_outputs
             WHERE created_at < ?
               AND task_id NOT IN (SELECT id FROM protected)
               AND task_id NOT IN (
                   SELECT id FROM mesh_queue
                   WHERE NOT (status IN ('completed', 'cancelled', 'failed') AND updated_at < ?)
               )`
        ).run(cutoffIso, cutoffIso).changes;
        const queue = self.db.prepare(
            `WITH ${protectedCte}
             DELETE FROM mesh_queue
             WHERE status IN ('completed', 'cancelled', 'failed') AND updated_at < ?
               AND id NOT IN (SELECT id FROM protected)`
        ).run(cutoffIso).changes;
        return { queue, taskOutputs };
    })();
}

export function pruneTerminalQueueEntries(self: MeshRuntimeStore, olderThanMs: number): number {
    return pruneTerminalQueueEntriesDetailed(self, olderThanMs).queue;
}

/**
 * One ACTIVE direct dispatch (C-W8: an open `mesh_direct` turn-ledger attempt —
 * the retired legacy direct-dispatch table row's successor). `status` keeps the old
 * vocabulary readers switch on: `dispatched` before the worker started the turn
 * (accepted / delivered), `acked` after (consumed / generating / suspended /
 * finalizing). A terminal attempt is not active, so neither appears here.
 * `message` / `taskMode` come from the materialised queue row (absent in the
 * short window before `recordDirectDispatchTask` lands it).
 */
export interface DirectDispatchView {
    taskId: string;
    meshId: string;
    attemptId: string;
    nodeId: string | null;
    sessionId: string | null;
    providerType: string | null;
    message: string;
    taskMode: string | null;
    via: string;
    status: 'dispatched' | 'acked';
    dispatchedToIdleSession: boolean;
    dispatchedAt: string;
    updatedAt: string;
}

const PRE_TURN_STATES: ReadonlySet<string> = new Set(['accepted', 'delivered']);

export function selectActiveDirectDispatches(self: MeshRuntimeStore, meshId: string): DirectDispatchView[] {
    const rows = self.db.prepare(
        `SELECT a.attempt_id, a.task_id, a.mesh_id, a.node_id, a.session_id, a.provider_type, a.via, a.state,
                a.accepted_at, a.updated_at, json_extract(q.payload, '$.message') AS message, json_extract(q.payload, '$.taskMode') AS task_mode
         FROM turn_attempts a LEFT JOIN mesh_queue q ON q.mesh_id = a.mesh_id AND q.id = a.task_id
         WHERE a.scope = 'mesh_direct' AND a.mesh_id = ? AND a.task_id IS NOT NULL AND a.terminal_outcome IS NULL
         ORDER BY a.accepted_at, a.attempt_id`
    ).all(meshId) as Array<{
        attempt_id: string; task_id: string; mesh_id: string; node_id: string | null; session_id: string | null; provider_type: string | null;
        via: string | null; state: string; accepted_at: number; updated_at: number; message: string | null; task_mode: string | null;
    }>;
    return rows.map((r) => ({
        taskId: r.task_id,
        meshId: r.mesh_id,
        attemptId: r.attempt_id,
        nodeId: r.node_id,
        sessionId: r.session_id || null,
        providerType: r.provider_type,
        message: typeof r.message === 'string' ? r.message : '',
        taskMode: r.task_mode,
        via: r.via ?? 'direct',
        status: PRE_TURN_STATES.has(r.state) ? 'dispatched' : 'acked',
        dispatchedToIdleSession: false,
        dispatchedAt: new Date(r.accepted_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
    }));
}

/**
 * MESH-DISPATCH-MISROUTE (fix 3, consumer residual): the task id of the ONE
 * active direct dispatch a session holds — unambiguous by construction now (the
 * ledger allows ≤1 open attempt per session), so a taskId-less lifecycle event
 * resolves to it; null when the session holds none.
 */
export function selectSoleActiveDirectDispatchTaskId(self: MeshRuntimeStore, meshId: string, sessionId: string): string | null {
    if (!sessionId) return null;
    const row = self.db.prepare(
        `SELECT task_id FROM turn_attempts
         WHERE scope = 'mesh_direct' AND mesh_id = ? AND session_id = ? AND terminal_outcome IS NULL AND task_id IS NOT NULL`
    ).get(meshId, sessionId) as { task_id: string } | undefined;
    const taskId = typeof row?.task_id === 'string' ? row.task_id.trim() : '';
    return taskId || null;
}

// ── Slim queue facts (MCP read-latency pass, 2026-09-27) ────────────────────
//
// Mission aggregates, mission/task stats, and view-side dependency annotation used
// to `getQueue(meshId)` — JSON.parse every payload of the mesh (5 MB on the preview
// daemon) — once PER MISSION. These reads decide on columns and pull the handful
// of payload scalars they need with SQLite's json_extract (no JS object per row).

/** The payload scalars mission aggregation + task stats read, per queue row. */
export interface MeshQueueFacts {
    id: string;
    status: MeshTaskStatus;
    missionId?: string;
    dependsOn?: string[];
    cancelReason?: string;
    updatedAt?: string;
    dispatchTimestamp?: string;
    requeueCount?: number;
}

const FACT_PATHS = "'$.missionId', '$.dependsOn', '$.cancelReason', '$.updatedAt', '$.dispatchTimestamp', '$.requeueCount'";

function readFactsRow(row: { id: string; status: MeshTaskStatus; f: string | null }): MeshQueueFacts {
    const facts: MeshQueueFacts = { id: row.id, status: row.status };
    if (row.f === null) return facts;
    let parts: unknown;
    try { parts = JSON.parse(row.f); } catch { return facts; }
    if (!Array.isArray(parts)) return facts;
    const [missionId, dependsOn, cancelReason, updatedAt, dispatchTimestamp, requeueCount] = parts;
    if (typeof missionId === 'string') facts.missionId = missionId;
    if (Array.isArray(dependsOn)) facts.dependsOn = dependsOn.filter((d): d is string => typeof d === 'string');
    if (typeof cancelReason === 'string') facts.cancelReason = cancelReason;
    if (typeof updatedAt === 'string') facts.updatedAt = updatedAt;
    if (typeof dispatchTimestamp === 'string') facts.dispatchTimestamp = dispatchTimestamp;
    if (typeof requeueCount === 'number') facts.requeueCount = requeueCount;
    return facts;
}

/**
 * Every queue row of a mesh as `MeshQueueFacts`, in created_at order (the same
 * order getQueueEntries returns). A row whose payload is not valid JSON keeps its
 * column facts only.
 */
export function getQueueFacts(self: MeshRuntimeStore, meshId: string): MeshQueueFacts[] {
    self.ensureLegacyQueueMigrated(meshId);
    const rows = self.db.prepare(
        `SELECT id, status, CASE WHEN json_valid(payload) THEN json_extract(payload, ${FACT_PATHS}) END AS f
         FROM mesh_queue WHERE mesh_id = ? ORDER BY created_at ASC`
    ).all(meshId) as Array<{ id: string; status: MeshTaskStatus; f: string | null }>;
    return rows.map(readFactsRow);
}

/** Row count per status over the whole mesh queue, plus terminal rows last updated before `olderThanIso`. */
export function getQueueStatusCounts(
    self: MeshRuntimeStore,
    meshId: string,
    olderThanIso?: string,
): { counts: Record<string, number>; oldHistoricalCount: number } {
    self.ensureLegacyQueueMigrated(meshId);
    const rows = self.db.prepare(
        `SELECT status, COUNT(*) AS n,
                SUM(CASE WHEN ? IS NOT NULL AND status IN ('completed', 'failed', 'cancelled') AND updated_at < ? THEN 1 ELSE 0 END) AS old
         FROM mesh_queue WHERE mesh_id = ? GROUP BY status`
    ).all(olderThanIso ?? null, olderThanIso ?? null, meshId) as Array<{ status: string; n: number; old: number | null }>;
    const counts: Record<string, number> = {};
    let oldHistoricalCount = 0;
    for (const row of rows) {
        counts[row.status] = row.n;
        oldHistoricalCount += row.old ?? 0;
    }
    return { counts, oldHistoricalCount };
}

/** id / status / cancelReason for the given row ids (missing ids are absent). */
export function getQueueDependencyHeads(
    self: MeshRuntimeStore,
    meshId: string,
    ids: readonly string[],
): Array<{ id: string; status: MeshTaskStatus; cancelReason?: string }> {
    const unique = [...new Set(ids.filter(id => typeof id === 'string' && id))];
    if (unique.length === 0) return [];
    self.ensureLegacyQueueMigrated(meshId);
    const out: Array<{ id: string; status: MeshTaskStatus; cancelReason?: string }> = [];
    // Chunked: SQLite's bound-parameter limit.
    for (let i = 0; i < unique.length; i += 500) {
        const chunk = unique.slice(i, i + 500);
        const rows = self.db.prepare(
            `SELECT id, status,
                    CASE WHEN json_valid(payload) THEN json_extract(payload, '$.cancelReason') END AS cancel
             FROM mesh_queue WHERE mesh_id = ? AND id IN (${chunk.map(() => '?').join(', ')})`
        ).all(meshId, ...chunk) as Array<{ id: string; status: MeshTaskStatus; cancel: unknown }>;
        for (const row of rows) {
            out.push({
                id: row.id,
                status: row.status,
                ...(typeof row.cancel === 'string' ? { cancelReason: row.cancel } : {}),
            });
        }
    }
    return out;
}
