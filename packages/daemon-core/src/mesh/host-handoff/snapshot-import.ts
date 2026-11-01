/**
 * Snapshot import (design §7.2 steps 4-5): chunks are staged OUTSIDE the live
 * tables (journal staging area), verified (chunk hashes, digest chain, row
 * counts, schema columns, referential integrity), and only an `activate`
 * applies them to the live tables in ONE transaction.
 */

import { HOST_SNAPSHOT_TABLES, manifestDigest, sha256Hex, tableColumns, type SnapshotPayload } from './snapshot-export.js';
import type { HandoffManifest } from './types.js';

type Db = {
    prepare(sql: string): { all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown };
    transaction<T>(fn: () => T): () => T;
};

export type VerifyResult =
    | { ok: true; payload: SnapshotPayload; rowCounts: Record<string, number> }
    | { ok: false; code: 'chunk_hash_mismatch' | 'manifest_mismatch' | 'verify_failed'; detail: string };

/** Pure verification of staged chunks against the manifest and the local schema. */
export function verifyStagedSnapshot(
    manifest: HandoffManifest,
    chunks: ReadonlyArray<{ seq: number; sha256: string; data: string }>,
    localColumns: (table: string) => string[],
): VerifyResult {
    const { digest, ...header } = manifest;
    if (manifestDigest(header) !== digest) return { ok: false, code: 'manifest_mismatch', detail: 'manifest digest does not match its fields' };
    if (chunks.length !== manifest.chunks.length) return { ok: false, code: 'manifest_mismatch', detail: `expected ${manifest.chunks.length} chunks, staged ${chunks.length}` };
    for (const want of manifest.chunks) {
        const got = chunks.find(c => c.seq === want.seq);
        if (!got) return { ok: false, code: 'manifest_mismatch', detail: `chunk ${want.seq} missing` };
        if (sha256Hex(got.data) !== want.sha256 || got.sha256 !== want.sha256) return { ok: false, code: 'chunk_hash_mismatch', detail: `chunk ${want.seq}` };
    }
    let payload: SnapshotPayload;
    try { payload = JSON.parse([...chunks].sort((a, b) => a.seq - b.seq).map(c => c.data).join('')) as SnapshotPayload; }
    catch { return { ok: false, code: 'verify_failed', detail: 'staged snapshot is not valid JSON' }; }
    if (payload?.version !== 1 || !payload.tables) return { ok: false, code: 'verify_failed', detail: 'unknown snapshot version' };
    if (sha256Hex(JSON.stringify(payload.config)) !== manifest.configDigest) return { ok: false, code: 'manifest_mismatch', detail: 'config digest' };
    const rowCounts: Record<string, number> = {};
    for (const spec of HOST_SNAPSHOT_TABLES) {
        const t = payload.tables[spec.table];
        const m = manifest.tables[spec.table];
        if (!t || !m) return { ok: false, code: 'manifest_mismatch', detail: `table ${spec.table} missing` };
        if (t.rows.length !== m.rows) return { ok: false, code: 'manifest_mismatch', detail: `${spec.table}: ${t.rows.length} rows, manifest ${m.rows}` };
        const local = new Set(localColumns(spec.table));
        const missing = t.columns.filter(c => !local.has(c));
        if (missing.length) return { ok: false, code: 'verify_failed', detail: `${spec.table}: local schema lacks ${missing.join(', ')}` };
        if (t.rows.some(r => r.length !== t.columns.length)) return { ok: false, code: 'verify_failed', detail: `${spec.table}: ragged row` };
        rowCounts[spec.table] = t.rows.length;
    }
    // Referential integrity: items and events point at missions of the snapshot.
    const col = (table: string, name: string) => payload.tables[table]!.columns.indexOf(name);
    const missionIds = new Set(payload.tables.mesh_missions!.rows.map(r => r[col('mesh_missions', 'id')]));
    for (const table of ['mesh_mission_items', 'mesh_mission_events']) {
        const i = col(table, 'mission_id');
        if (i >= 0 && payload.tables[table]!.rows.some(r => !missionIds.has(r[i]))) return { ok: false, code: 'verify_failed', detail: `${table} references a mission outside the snapshot` };
    }
    return { ok: true, payload, rowCounts };
}

/**
 * Replace the live host-owned rows of `meshId` with the snapshot, in one
 * transaction (all-or-nothing). Returns per-table row counts now live.
 */
export function applySnapshotTables(db: Db, meshId: string, payload: SnapshotPayload): Record<string, number> {
    const apply = db.transaction(() => {
        const counts: Record<string, number> = {};
        for (const spec of [...HOST_SNAPSHOT_TABLES].reverse()) db.prepare(`DELETE FROM ${spec.table} WHERE ${spec.meshColumn} = ?`).run(meshId);
        for (const spec of HOST_SNAPSHOT_TABLES) {
            const t = payload.tables[spec.table]!;
            if (t.rows.length) {
                const stmt = db.prepare(`INSERT OR REPLACE INTO ${spec.table} (${t.columns.join(', ')}) VALUES (${t.columns.map(() => '?').join(', ')})`);
                for (const row of t.rows) stmt.run(...row);
            }
            counts[spec.table] = t.rows.length;
        }
        return counts;
    });
    return apply();
}

export function localTableColumns(db: Db): (table: string) => string[] {
    return (table) => tableColumns(db as never, table);
}

/** Does this mesh own any host data (missions / queue / decisions)? Used by the `set_mesh_host force` guard. */
export function meshHasHostData(db: { prepare(sql: string): { all(...a: unknown[]): unknown[] } }, meshId: string): boolean {
    for (const table of ['mesh_queue', 'mesh_missions', 'mesh_mission_items']) {
        const row = db.prepare(`SELECT 1 AS present FROM ${table} WHERE mesh_id = ? LIMIT 1`).all(meshId);
        if (row.length) return true;
    }
    return false;
}
