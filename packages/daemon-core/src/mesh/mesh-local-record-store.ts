// ---------------------------------------------------------------------------
// mesh-local-record-store — row CRUD over `mesh_local_records` (C-W9a)
// ---------------------------------------------------------------------------
// The LOCAL half of `meshRecord(meshId, kind, scalars, { local })`
// (mesh-record.ts): the full nested payload of a non-turn mesh record, which
// the content-free `mesh.<id>.events` projection drops by construction. It
// replaces the retired event-ledger table + its JSONL mirror, read
// cache, rotation/compaction/archive and P2P import path — one SQL table on
// the `mesh-runtime.db` handle, written by one API.
//
// Pure persistence bound to one better-sqlite3 handle (the DDL lives in
// turn-ledger/schema.ts next to the other C3 tables; migrate-v3.ts folds the
// legacy rows in). No clock of its own beyond `Date.now()` defaults, no
// publish. The ONLY writer of the table (gate `check:turn-single-emitter`,
// rule `local-record-write`) besides schema.ts / migrate-v3.ts.
//
// CONTENT BOUNDARY: rows are local-only and may hold agent/user text (refine
// validation output, MAGI synthesis, dispatch error strings). Nothing here is
// ever published to a topic or sent to the server; cross-machine readers use
// the owner daemon's P2P `get_mesh_ledger_slice` or a `mesh.<id>.handoff` ref.
// ---------------------------------------------------------------------------

import type { Database as DatabaseHandle, Statement } from 'better-sqlite3';
import type { MeshLedgerEntry, MeshLedgerKind } from './mesh-ledger.js';

/** One row to insert. `payload` is stored verbatim as JSON (nested values allowed). */
export interface LocalRecordInsert {
    eventId: string;
    meshId: string;
    kind: string;
    nodeId?: string | null;
    sessionId?: string | null;
    providerType?: string | null;
    taskId?: string | null;
    atMs: number;
    payload: Record<string, unknown>;
}

/** Filter for {@link LocalRecordStore.query}. Every filter is applied in SQL before `tail`. */
export interface LocalRecordQuery {
    kinds?: readonly string[];
    /** Inclusive lower bound, epoch ms. */
    sinceMs?: number;
    taskId?: string;
    sessionId?: string;
    /** Most recent N rows after every filter, returned in ascending order. */
    tail?: number;
}

/** A payload projection: JSON paths (`$.a` / `$.a.b`) — rows come back carrying only those fields. */
export interface LocalRecordProjection {
    name: string;
    paths: readonly string[];
}

interface RowRaw {
    rid?: number;
    event_id: string;
    mesh_id: string;
    kind: string;
    node_id: string | null;
    session_id: string | null;
    provider_type: string | null;
    task_id: string | null;
    at_ms: number;
    payload_json?: string;
    proj?: string | null;
}

function parsePayload(text: string | undefined): Record<string, unknown> {
    if (!text) return {};
    try {
        const value = JSON.parse(text);
        return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

function entryFromRow(row: RowRaw, payload: Record<string, unknown>): MeshLedgerEntry {
    return {
        id: row.event_id,
        meshId: row.mesh_id,
        timestamp: new Date(row.at_ms).toISOString(),
        kind: row.kind as MeshLedgerKind,
        ...(row.node_id ? { nodeId: row.node_id } : {}),
        ...(row.session_id ? { sessionId: row.session_id } : {}),
        ...(row.provider_type ? { providerType: row.provider_type } : {}),
        ...(row.task_id ? { taskId: row.task_id } : {}),
        payload,
    };
}

/** Rebuild the nested payload object from a multi-path json_extract result. */
function projectedPayload(proj: string | null | undefined, splitPaths: string[][]): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    if (typeof proj !== 'string') return payload;
    let values: unknown;
    try { values = JSON.parse(proj); } catch { return payload; }
    if (!Array.isArray(values)) return payload;
    for (let i = 0; i < splitPaths.length; i++) {
        const value = values[i];
        const segments = splitPaths[i];
        if (value === null || value === undefined || segments.length === 0) continue;
        let target = payload;
        for (let s = 0; s < segments.length - 1; s++) {
            const next = target[segments[s]];
            if (next && typeof next === 'object' && !Array.isArray(next)) {
                target = next as Record<string, unknown>;
            } else {
                const created: Record<string, unknown> = {};
                target[segments[s]] = created;
                target = created;
            }
        }
        target[segments[segments.length - 1]] = value;
    }
    return payload;
}

/** `mesh_local_records` bound to one `mesh-runtime.db` handle. */
export class LocalRecordStore {
    private readonly stmts = new Map<string, Statement>();

    constructor(readonly db: DatabaseHandle) {}

    private stmt(sql: string): Statement {
        let s = this.stmts.get(sql);
        if (!s) {
            s = this.db.prepare(sql);
            this.stmts.set(sql, s);
        }
        return s;
    }

    /** Insert one record. Idempotent on `event_id`: true only when a row was inserted. A blank kind is refused. */
    insert(rec: LocalRecordInsert): boolean {
        if (!rec.kind || !String(rec.kind).trim()) return false;
        const info = this.stmt(`INSERT OR IGNORE INTO mesh_local_records
                (event_id, mesh_id, kind, node_id, session_id, provider_type, task_id, at_ms, payload_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            rec.eventId, rec.meshId, rec.kind, rec.nodeId ?? null, rec.sessionId ?? null, rec.providerType ?? null,
            rec.taskId ?? null, Math.floor(rec.atMs), JSON.stringify(rec.payload ?? {}),
        );
        return info.changes > 0;
    }

    private where(meshId: string, q: LocalRecordQuery): { where: string; args: unknown[] } {
        const where: string[] = ['mesh_id = ?'];
        const args: unknown[] = [meshId];
        const kinds = (q.kinds ?? []).filter((k) => typeof k === 'string' && k.trim());
        if (kinds.length > 0) {
            where.push(`kind IN (${kinds.map(() => '?').join(', ')})`);
            args.push(...kinds);
        }
        if (q.sinceMs !== undefined && Number.isFinite(q.sinceMs)) { where.push('at_ms >= ?'); args.push(Math.floor(q.sinceMs)); }
        if (q.taskId) { where.push('task_id = ?'); args.push(q.taskId); }
        if (q.sessionId) { where.push('session_id = ?'); args.push(q.sessionId); }
        return { where: where.join(' AND '), args };
    }

    /**
     * Filtered read in append order (at_ms, then insertion order). Every filter
     * is applied in SQL before the tail (LEDGER-KIND-TAIL-BLINDSPOT).
     */
    query(meshId: string, q: LocalRecordQuery = {}): MeshLedgerEntry[] {
        const { where, args } = this.where(meshId, q);
        const tail = q.tail && q.tail > 0 ? Math.floor(q.tail) : null;
        const sql = tail
            ? `SELECT * FROM (SELECT rowid AS rid, * FROM mesh_local_records WHERE ${where} ORDER BY at_ms DESC, rowid DESC LIMIT ${tail}) ORDER BY at_ms ASC, rid ASC`
            : `SELECT rowid AS rid, * FROM mesh_local_records WHERE ${where} ORDER BY at_ms ASC, rowid ASC`;
        return (this.db.prepare(sql).all(...args) as RowRaw[]).map((row) => entryFromRow(row, parsePayload(row.payload_json)));
    }

    /**
     * Projection read (IPC load audit #2, carried over from the event ledger):
     * the entry columns plus ONLY the named payload paths — one multi-path
     * json_extract per row instead of parsing the whole payload.
     */
    heads(meshId: string, q: LocalRecordQuery & { projection: LocalRecordProjection }): MeshLedgerEntry[] {
        const { where, args } = this.where(meshId, q);
        // json_extract with ONE path returns the bare value, with two or more a JSON array.
        const paths = q.projection.paths.length >= 2 ? [...q.projection.paths] : [...q.projection.paths, '$.__projection_pad'];
        const splitPaths = paths.map((p) => p.replace(/^\$\.?/, '').split('.').filter(Boolean));
        const rows = this.db.prepare(
            `SELECT rowid AS rid, event_id, mesh_id, kind, node_id, session_id, provider_type, task_id, at_ms,
                    CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, ${paths.map(() => '?').join(', ')}) END AS proj
             FROM mesh_local_records WHERE ${where} ORDER BY at_ms ASC, rowid ASC`,
        ).all(...paths, ...args) as RowRaw[];
        return rows.map((row) => entryFromRow(row, projectedPayload(row.proj, splitPaths)));
    }

    /**
     * Cursor slice: rows strictly after `afterEventId` (in append order; a
     * missing cursor starts at the beginning), at most `limit`, plus `hasMore`.
     */
    slice(meshId: string, q: LocalRecordQuery & { afterEventId?: string | null; limit: number }): { entries: MeshLedgerEntry[]; hasMore: boolean } {
        const { where, args } = this.where(meshId, q);
        let cursorClause = '';
        const cursorArgs: unknown[] = [];
        if (q.afterEventId) {
            const anchor = this.stmt('SELECT rowid AS rid, at_ms FROM mesh_local_records WHERE mesh_id = ? AND event_id = ?')
                .get(meshId, q.afterEventId) as { rid: number; at_ms: number } | undefined;
            if (anchor) {
                cursorClause = ' AND (at_ms > ? OR (at_ms = ? AND rowid > ?))';
                cursorArgs.push(anchor.at_ms, anchor.at_ms, anchor.rid);
            }
        }
        const limit = Math.max(1, Math.floor(q.limit));
        const rows = this.db.prepare(
            `SELECT rowid AS rid, * FROM mesh_local_records WHERE ${where}${cursorClause} ORDER BY at_ms ASC, rowid ASC LIMIT ${limit + 1}`,
        ).all(...args, ...cursorArgs) as RowRaw[];
        const hasMore = rows.length > limit;
        return { entries: (hasMore ? rows.slice(0, limit) : rows).map((row) => entryFromRow(row, parsePayload(row.payload_json))), hasMore };
    }

    /** Per-kind counts + newest time for one mesh (no payload read). */
    kindCounts(meshId: string): Array<{ kind: string; count: number; lastAtMs: number | null }> {
        const rows = this.stmt('SELECT kind, COUNT(*) AS n, MAX(at_ms) AS last FROM mesh_local_records WHERE mesh_id = ? GROUP BY kind')
            .all(meshId) as Array<{ kind: string; n: number; last: number | null }>;
        return rows.map((r) => ({ kind: r.kind, count: r.n, lastAtMs: r.last }));
    }

    /** Retention: delete every row older than `olderThanMs` (all meshes). Returns rows deleted. */
    prune(olderThanMs: number, nowMs: number = Date.now()): number {
        return this.stmt('DELETE FROM mesh_local_records WHERE at_ms < ?').run(nowMs - Math.max(0, olderThanMs)).changes;
    }

    /** Remove every record of one mesh (mesh deletion / test cleanup). */
    clear(meshId: string): number {
        return this.stmt('DELETE FROM mesh_local_records WHERE mesh_id = ?').run(meshId).changes;
    }
}
