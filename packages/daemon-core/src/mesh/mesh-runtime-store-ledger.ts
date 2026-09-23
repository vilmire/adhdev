/**
 * MeshRuntimeStore G2 event-ledger persistence — extracted from
 * mesh-runtime-store.ts (behavior-preserving code move, file-size gate).
 *
 * Same contract as the sibling mesh-runtime-store-turn-attempts.ts: these were
 * `MeshRuntimeStore` methods and now take the store as `self`; the class keeps
 * thin delegating wrappers so every call site is unchanged. No SQL string,
 * WAL-checkpoint order, error handling, or result shape was changed — only
 * physical location + `this.` -> `self.`.
 */

import { LOG } from '../logging/logger.js';
import type { MeshRuntimeStore } from './mesh-runtime-store.js';

// ── G2: Event Ledger ────────────────────────────────────────────────────

export function appendLedgerEntry(self: MeshRuntimeStore, entry: {
    id: string;
    meshId: string;
    timestamp: string;
    kind: string;
    nodeId?: string | null;
    sessionId?: string | null;
    providerType?: string | null;
    taskId?: string | null;
    payload?: unknown;
}): void {
    // Ledger `kind` is a mandatory schema invariant (mesh_event_ledger.kind is
    // NOT NULL; every MeshLedgerKind is a non-empty tag). A blank kind would be a
    // structurally-broken entry — reject it here rather than write an unqueryable
    // row. NOTE: pending-event JSONL files (`*.pending-events.jsonl`) are a
    // SEPARATE shape that intentionally has NO `kind` field (they key off `.event`);
    // a generic audit that scans the whole ledger DIRECTORY and reads `.kind` off
    // those rows sees "kind=None", which is an artifact of mixing the two files, not
    // a ledger defect. This guard makes the ledger-side invariant explicit.
    if (!entry.kind || !String(entry.kind).trim()) {
        LOG.warn('MeshRuntimeStore', `Refusing to append ledger entry with empty kind for mesh ${entry.meshId} (id ${entry.id})`);
        return;
    }
    self.db.prepare(
        `INSERT OR IGNORE INTO mesh_event_ledger
         (id, mesh_id, timestamp, kind, node_id, session_id, provider_type, task_id, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        entry.id,
        entry.meshId,
        entry.timestamp,
        entry.kind,
        entry.nodeId ?? null,
        entry.sessionId ?? null,
        entry.providerType ?? null,
        entry.taskId ?? null,
        JSON.stringify(entry.payload ?? {}),
    );
    self.maybeCheckpointWal();
}


export function readLedgerEntries(self: MeshRuntimeStore, meshId: string, opts?: {
    tail?: number;
    since?: string;
    kind?: string;
    limit?: number;
}): Array<{ id: string; meshId: string; timestamp: string; kind: string; nodeId: string | null; sessionId: string | null; providerType: string | null; taskId: string | null; payload: unknown }> {
    const limit = opts?.tail ?? opts?.limit ?? 200;
    let query: string;
    const params: unknown[] = [meshId];
    if (opts?.kind && opts?.since) {
        query = `SELECT * FROM mesh_event_ledger WHERE mesh_id = ? AND kind = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT ?`;
        params.push(opts.kind, opts.since, limit);
    } else if (opts?.kind) {
        query = `SELECT * FROM mesh_event_ledger WHERE mesh_id = ? AND kind = ? ORDER BY timestamp DESC LIMIT ?`;
        params.push(opts.kind, limit);
    } else if (opts?.since) {
        query = `SELECT * FROM mesh_event_ledger WHERE mesh_id = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT ?`;
        params.push(opts.since, limit);
    } else {
        query = `SELECT * FROM mesh_event_ledger WHERE mesh_id = ? ORDER BY timestamp DESC LIMIT ?`;
        params.push(limit);
    }
    const rows = self.db.prepare(query).all(...params) as Array<Record<string, unknown>>;
    return rows.map(r => ({
        id: r.id as string,
        meshId: r.mesh_id as string,
        timestamp: r.timestamp as string,
        kind: r.kind as string,
        nodeId: r.node_id as string | null,
        sessionId: r.session_id as string | null,
        providerType: r.provider_type as string | null,
        taskId: (r.task_id as string | null) ?? null,
        payload: (() => { try { return JSON.parse(r.payload as string); } catch { return {}; } })(),
    }));
}


/**
 * G2 read cutover: read ledger entries in append order (oldest first),
 * matching legacy JSONL file-order semantics. Ties on the same timestamp
 * are broken by rowid (insertion order), preserving the positional
 * guarantee that mesh-events relies on for same-millisecond entries.
 */
export function readLedgerEntriesOrdered(self: MeshRuntimeStore, meshId: string, opts?: {
    since?: string;
    kinds?: string[];
    tail?: number;
}): Array<{ id: string; meshId: string; timestamp: string; kind: string; nodeId: string | null; sessionId: string | null; providerType: string | null; taskId: string | null; payload: unknown }> {
    const params: unknown[] = [meshId];
    let whereClause = 'mesh_id = ?';
    if (opts?.since) {
        whereClause += ' AND timestamp >= ?';
        params.push(opts.since);
    }
    const kinds = Array.isArray(opts?.kinds) ? opts.kinds.filter(k => typeof k === 'string' && k.trim()) : [];
    if (kinds.length > 0) {
        whereClause += ` AND kind IN (${kinds.map(() => '?').join(', ')})`;
        params.push(...kinds);
    }
    let query: string;
    if (opts?.tail && opts.tail > 0) {
        // Tail: newest N in append order — inner DESC limit, outer re-sort ASC.
        query = `SELECT * FROM (
            SELECT rowid AS rid, * FROM mesh_event_ledger WHERE ${whereClause}
            ORDER BY timestamp DESC, rowid DESC LIMIT ?
        ) ORDER BY timestamp ASC, rid ASC`;
        params.push(Math.floor(opts.tail));
    } else {
        query = `SELECT rowid AS rid, * FROM mesh_event_ledger WHERE ${whereClause} ORDER BY timestamp ASC, rowid ASC`;
    }
    const rows = self.db.prepare(query).all(...params) as Array<Record<string, unknown>>;
    return rows.map(r => ({
        id: r.id as string,
        meshId: r.mesh_id as string,
        timestamp: r.timestamp as string,
        kind: r.kind as string,
        nodeId: r.node_id as string | null,
        sessionId: r.session_id as string | null,
        providerType: r.provider_type as string | null,
        taskId: (r.task_id as string | null) ?? null,
        payload: (() => { try { return JSON.parse(r.payload as string); } catch { return {}; } })(),
    }));
}


/**
 * Projection read (IPC load audit 2026-09-23, #2): the entry columns plus ONLY the named
 * payload fields, never the whole `payload` text. The kind-filtered active-work reads
 * (auto-prune, idle reminder, notification status line, mesh_status) used to pull 64 MB
 * of payload per call — 46 MB of it `task_completed` bodies — and JSON.parse all of it to
 * look at ids, kinds, timestamps and a handful of flags.
 *
 * `payloadPaths` are JSON paths (`$.a` / `$.a.b`); the returned `payload` object holds
 * just those fields, nested as in the original (JSON null / missing fields are omitted).
 * All paths are pulled with ONE multi-path json_extract (one SQLite JSON parse per row;
 * the result is a small JSON array). A row whose payload is not valid JSON yields `{}`,
 * matching the full read's parse-failure fallback.
 *
 * Ordering is (timestamp ASC, rowid ASC) — the same order readLedgerEntriesOrdered
 * returns — applied in JS rather than SQL: with an `ORDER BY timestamp` the planner
 * picks idx_mesh_event_ledger_mesh_time and walks every row of the mesh to filter kind;
 * without it it seeks idx_mesh_event_ledger_mesh_kind, and sorting the few thousand
 * matches in JS is cheaper than that walk.
 */
export function readLedgerEntryHeads(self: MeshRuntimeStore, meshId: string, opts: {
    kinds: string[];
    since?: string;
    payloadPaths: readonly string[];
}): Array<{ id: string; meshId: string; timestamp: string; kind: string; nodeId: string | null; sessionId: string | null; providerType: string | null; taskId: string | null; payload: Record<string, unknown> }> {
    const kinds = opts.kinds.filter(k => typeof k === 'string' && k.trim());
    if (kinds.length === 0) return [];
    // json_extract with ONE path returns the bare value, with two or more a JSON array;
    // always pass >= 2 so the row shape is uniform.
    const paths = opts.payloadPaths.length >= 2 ? [...opts.payloadPaths] : [...opts.payloadPaths, '$.__projection_pad'];
    const params: unknown[] = [...paths, meshId, ...kinds];
    let where = `mesh_id = ? AND kind IN (${kinds.map(() => '?').join(', ')})`;
    if (opts.since) {
        where += ' AND timestamp >= ?';
        params.push(opts.since);
    }
    const rows = self.db.prepare(
        `SELECT rowid AS rid, id, mesh_id, timestamp, kind, node_id, session_id, provider_type, task_id,
                CASE WHEN json_valid(payload) THEN json_extract(payload, ${paths.map(() => '?').join(', ')}) END AS proj
         FROM mesh_event_ledger WHERE ${where}`
    ).all(...params) as Array<Record<string, unknown>>;
    rows.sort((a, b) => {
        const ta = a.timestamp as string;
        const tb = b.timestamp as string;
        if (ta !== tb) return ta < tb ? -1 : 1;
        return (a.rid as number) - (b.rid as number);
    });
    const splitPaths = paths.map(p => p.replace(/^\$\.?/, '').split('.').filter(Boolean));
    return rows.map(r => {
        const payload: Record<string, unknown> = {};
        if (typeof r.proj === 'string') {
            let values: unknown;
            try { values = JSON.parse(r.proj); } catch { values = undefined; }
            if (Array.isArray(values)) {
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
            }
        }
        return {
            id: r.id as string,
            meshId: r.mesh_id as string,
            timestamp: r.timestamp as string,
            kind: r.kind as string,
            nodeId: r.node_id as string | null,
            sessionId: r.session_id as string | null,
            providerType: r.provider_type as string | null,
            taskId: (r.task_id as string | null) ?? null,
            payload,
        };
    });
}


/**
 * Per-kind row counts and the newest timestamp for a mesh — the aggregate half of
 * getLedgerSummary, served by idx_mesh_event_ledger_mesh_kind without reading a payload.
 */
export function readLedgerKindCounts(self: MeshRuntimeStore, meshId: string): Array<{ kind: string; count: number; lastTimestamp: string | null }> {
    const rows = self.db.prepare(
        `SELECT kind, COUNT(*) AS n, MAX(timestamp) AS last FROM mesh_event_ledger WHERE mesh_id = ? GROUP BY kind`
    ).all(meshId) as Array<{ kind: string; n: number; last: string | null }>;
    return rows.map(r => ({ kind: r.kind, count: r.n, lastTimestamp: r.last }));
}


/** Remove all ledger entries for a mesh (mesh deletion / test cleanup). */
export function clearLedgerForMesh(self: MeshRuntimeStore, meshId: string): number {
    return self.db.prepare('DELETE FROM mesh_event_ledger WHERE mesh_id = ?').run(meshId).changes;
}


/** G2: remove entries moved to the JSONL archive so the SQLite runtime set mirrors the active ledger. */
export function deleteLedgerEntries(self: MeshRuntimeStore, meshId: string, ids: string[]): number {
    if (!ids.length) return 0;
    let deleted = 0;
    const stmt = self.db.prepare('DELETE FROM mesh_event_ledger WHERE mesh_id = ? AND id = ?');
    self.db.transaction(() => {
        for (const id of ids) {
            deleted += stmt.run(meshId, id).changes;
        }
    })();
    return deleted;
}


export function hasLedgerEntry(self: MeshRuntimeStore, meshId: string, id: string): boolean {
    const row = self.db.prepare(
        'SELECT 1 FROM mesh_event_ledger WHERE mesh_id = ? AND id = ? LIMIT 1'
    ).get(meshId, id);
    return row !== undefined;
}


export function ledgerEntryCount(self: MeshRuntimeStore, meshId: string): number {
    const row = self.db.prepare(
        'SELECT COUNT(*) as cnt FROM mesh_event_ledger WHERE mesh_id = ?'
    ).get(meshId) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
}


export function importLedgerEntries(self: MeshRuntimeStore, entries: Array<{
    id: string; meshId: string; timestamp: string; kind: string;
    nodeId?: string | null; sessionId?: string | null; providerType?: string | null; taskId?: string | null; payload?: unknown;
}>): number {
    let imported = 0;
    const stmt = self.db.prepare(
        `INSERT OR IGNORE INTO mesh_event_ledger
         (id, mesh_id, timestamp, kind, node_id, session_id, provider_type, task_id, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    self.db.transaction(() => {
        for (const e of entries) {
            // Skip structurally-broken entries with a blank kind (see appendLedgerEntry):
            // mesh_event_ledger.kind is NOT NULL and every kind is a non-empty tag, so an
            // empty-kind row is unqueryable noise. Mirrors readLedgerFile's `entry.id && entry.kind`
            // JSONL guard, keeping the import path from re-introducing what the read path filters.
            if (!e.kind || !String(e.kind).trim()) continue;
            const result = stmt.run(
                e.id, e.meshId, e.timestamp, e.kind,
                e.nodeId ?? null, e.sessionId ?? null, e.providerType ?? null, e.taskId ?? null,
                JSON.stringify(e.payload ?? {}),
            );
            if (result.changes > 0) imported++;
        }
    })();
    return imported;
}


/**
 * G4: Read a bounded, cursor-addressable ledger slice directly from the SQLite
 * mesh_event_ledger table. This is the P2P reconcile read path; JSONL files are
 * retained as export/import/debug/legacy artifacts only.
 *
 * The return shape is structurally compatible with MeshLedgerSlice so callers
 * in mesh-tools.ts can pass it directly to buildMeshLedgerReplicaEvidence.
 */
export function readLedgerSlice(self: MeshRuntimeStore, meshId: string, opts?: {
    afterId?: string;
    since?: string;
    kind?: string;
    limit?: number;
}): {
    protocol: 'adhdev.mesh.ledger.slice.v1';
    meshId: string;
    entries: Array<{ id: string; meshId: string; timestamp: string; kind: string; nodeId: string | null; sessionId: string | null; providerType: string | null; payload: unknown }>;
    cursor: { afterId: string | null; nextAfterId: string | null; limit: number; hasMore: boolean };
    sourceOfTruth: { kind: 'local_sqlite'; table: 'mesh_event_ledger'; bounded: true; maxLimit: number };
} {
    // Protocol maximum of 500, default 100 — mirrors mesh-ledger.ts constants.
    const MAX_LIMIT = 500;
    const DEFAULT_LIMIT = 100;
    const limit = (typeof opts?.limit === 'number' && Number.isFinite(opts.limit))
        ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(opts.limit)))
        : DEFAULT_LIMIT;

    const afterId = typeof opts?.afterId === 'string' && opts.afterId.trim() ? opts.afterId.trim() : null;

    // Build query: fetch limit+1 rows so we can detect hasMore without a COUNT(*).
    const params: unknown[] = [meshId];
    let whereClause = 'mesh_id = ?';

    if (opts?.kind) {
        whereClause += ' AND kind = ?';
        params.push(opts.kind);
    }
    if (opts?.since) {
        whereClause += ' AND timestamp >= ?';
        params.push(opts.since);
    }
    if (afterId) {
        // afterId: return entries with timestamp strictly after the referenced entry's timestamp,
        // or with the same timestamp but id > afterId (stable pagination).
        whereClause += ` AND (timestamp > (SELECT timestamp FROM mesh_event_ledger WHERE id = ? AND mesh_id = ?) OR (timestamp = (SELECT timestamp FROM mesh_event_ledger WHERE id = ? AND mesh_id = ?) AND id > ?))`;
        params.push(afterId, meshId, afterId, meshId, afterId);
    }

    // Fetch limit+1 to detect hasMore
    const query = `SELECT * FROM mesh_event_ledger WHERE ${whereClause} ORDER BY timestamp ASC, id ASC LIMIT ?`;
    params.push(limit + 1);

    const rows = self.db.prepare(query).all(...params) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const bounded = hasMore ? rows.slice(0, limit) : rows;

    const entries = bounded.map(r => ({
        id: r.id as string,
        meshId: r.mesh_id as string,
        timestamp: r.timestamp as string,
        kind: r.kind as string,
        nodeId: r.node_id as string | null,
        sessionId: r.session_id as string | null,
        providerType: r.provider_type as string | null,
        payload: (() => { try { return JSON.parse(r.payload as string); } catch { return {}; } })(),
    }));

    return {
        protocol: 'adhdev.mesh.ledger.slice.v1',
        meshId,
        entries,
        cursor: {
            afterId,
            nextAfterId: entries.length ? entries[entries.length - 1].id : afterId,
            limit,
            hasMore,
        },
        sourceOfTruth: {
            kind: 'local_sqlite',
            table: 'mesh_event_ledger',
            bounded: true,
            maxLimit: MAX_LIMIT,
        },
    };
}
