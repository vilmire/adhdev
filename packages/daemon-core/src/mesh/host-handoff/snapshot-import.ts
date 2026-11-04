/**
 * Snapshot import (design §7.2 steps 4-5): chunks are staged OUTSIDE the live
 * tables (journal staging area), verified (chunk hashes, digest chain, row
 * counts, schema columns, referential integrity), and only an `activate`
 * applies them to the live tables in ONE transaction.
 */

import { HOST_SNAPSHOT_TABLES, readTable, manifestDigest, sha256Hex, tableColumns, type SnapshotPayload } from './snapshot-export.js';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import type { HandoffManifest } from './types.js';
import { verifyProjectApprovalFiles } from './project-files.js';
import { resolveAssistantProject } from '../../assistant/assistant-projects.js';
import { ensureProjectScopedHistory, historyIdentityColumns, PROJECT_SCOPED_HISTORY_TABLES } from './history-identity.js';
import { SnapshotReconciler, snapshotConflict } from './snapshot-reconcile.js';

export function approvalProjectResolver(config: SnapshotPayload['config'], meshId: string): (ref: string) => string | null {
    return ref => {
        if (!config || config.id !== meshId) return null;
        const resolved = resolveAssistantProject(ref, [config as { id: string }]);
        return resolved.ok ? resolved.mesh.id : null;
    };
}

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
    try { verifyProjectApprovalFiles(payload.files, manifest.meshId, approvalProjectResolver(payload.config, manifest.meshId)); }
    catch (e) { return { ok: false, code: 'verify_failed', detail: (e as Error).message }; }
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
        if (new Set(t.columns).size !== t.columns.length || t.columns.join('\0') !== m.columns.join('\0')) return { ok: false, code: 'verify_failed', detail: `${spec.table}: invalid column declaration` };
        const scopeIndex = t.columns.indexOf(spec.meshColumn);
        if (scopeIndex < 0) return { ok: false, code: 'verify_failed', detail: `${spec.table}: scope column missing` };
        if (!spec.parentTable && t.rows.some(row => row[scopeIndex] !== manifest.meshId)) return { ok: false, code: 'verify_failed', detail: `${spec.table}: row belongs to another project` };
        if (spec.table === 'assistant_memory_entry' && t.rows.some(row => row[t.columns.indexOf('scope')] !== 'project')) return { ok: false, code: 'verify_failed', detail: 'global memory cannot travel with a project' };
        rowCounts[spec.table] = t.rows.length;
    }
    for (const spec of HOST_SNAPSHOT_TABLES.filter(s => s.parentTable)) {
        const parent = payload.tables[spec.parentTable!];
        const child = payload.tables[spec.table]!;
        const parentIndex = parent?.columns.indexOf(spec.parentColumn!) ?? -1;
        const values = new Set(parentIndex >= 0 ? parent!.rows.map(row => row[parentIndex]) : []);
        if (child.rows.some(row => !values.has(row[child.columns.indexOf(spec.meshColumn)]))) return { ok: false, code: 'verify_failed', detail: `${spec.table}: child outside project snapshot` };
    }
    // Referential integrity: items and events point at missions of the snapshot.
    const col = (table: string, name: string) => payload.tables[table]!.columns.indexOf(name);
    const missionIds = new Set(payload.tables.mesh_missions!.rows.map(r => r[col('mesh_missions', 'id')]));
    for (const table of ['mesh_mission_items', 'mesh_mission_events']) {
        const i = col(table, 'mission_id');
        if (i >= 0 && payload.tables[table]!.rows.some(r => !missionIds.has(r[i]))) return { ok: false, code: 'verify_failed', detail: `${table} references a mission outside the snapshot` };
    }
    for (const [childTable, childColumn, parentTable, parentColumn] of [
        ['turn_events', 'attempt_id', 'turn_attempts', 'attempt_id'],
        ['mesh_release_events', 'release_id', 'mesh_releases', 'id'],
        ['mesh_release_missions', 'release_id', 'mesh_releases', 'id'],
        ['mesh_release_missions', 'moved_to_release_id', 'mesh_releases', 'id'],
        ['mesh_release_missions', 'mission_id', 'mesh_missions', 'id'],
    ] as const) {
        const parent = payload.tables[parentTable]!, child = payload.tables[childTable]!;
        const childIndex = child.columns.indexOf(childColumn), parentIndex = parent.columns.indexOf(parentColumn);
        if (childIndex < 0 || parentIndex < 0) return { ok: false, code: 'verify_failed', detail: `${childTable}: relation columns missing` };
        const ids = new Set(parent.rows.map(row => row[parentIndex]));
        if (child.rows.some(row => row[childIndex] !== null && !ids.has(row[childIndex]))) return { ok: false, code: 'verify_failed', detail: `${childTable}: ${childColumn} outside project snapshot` };
    }
    return { ok: true, payload, rowCounts };
}

/** Source canonical state is merged without deleting target-only local state.
 * Original target rows and the incoming snapshot are retained transactionally.
 * Global INTEGER rowids are storage coordinates, not public identities: explicit
 * provenance maps a colliding source coordinate to its target coordinate. */
export function applySnapshotTables(db: Db, meshId: string, payload: SnapshotPayload,
    provenance?: { handoffId: string; sourceDaemonId: string; snapshotDigest: string; epoch?: number },
    historyIdentity: 'preserve-exact' | 'origin-qualified-prototype' = 'preserve-exact'): Record<string, number> {
    const digest = provenance?.snapshotDigest ?? sha256Hex(JSON.stringify(payload));
    const handoffId = provenance?.handoffId ?? digest;
    const source = provenance?.sourceDaemonId ?? 'snapshot';
    /** The host's history decides project state, so its version replaces a differing local row of this project.
     * The local version stays in the `target-before` archive. */
    const mutable = new Set(['mesh_queue', 'mesh_missions', 'mesh_mission_items', 'mesh_handoff_note_text', 'mesh_idle_reminder',
        'assistant_threads', 'mesh_operating_notes', 'mesh_scheduler_cursor', 'mesh_releases', 'mesh_release_missions',
        'assistant_decision_answer_log', 'assistant_metric_daily',
        'turn_attempts', 'turn_holds', 'mesh_task_outputs', 'mesh_mission_ref_evals', 'assistant_attempt_bodies', 'assistant_relays', 'assistant_relay_coverage']);
    const surrogate: Record<string, string> = { mesh_mission_events: 'seq', mesh_release_events: 'seq', ...(historyIdentity === 'preserve-exact' ? {} : { mesh_tool_call_log: 'id', assistant_procedure_signals: 'id' }) };
    /** Per-daemon logs whose integer id is a private rowid no API exposes: they append, identified by content. */
    const appendOnly = historyIdentity === 'preserve-exact' ? new Set(['mesh_tool_call_log', 'assistant_procedure_signals']) : new Set<string>();
    /** Rows this daemon observed for itself as a worker. Same id with different local delivery
     * bookkeeping is expected, not a divergence: the local row stays, and the incoming one is archived above. */
    const observed = new Set(['mesh_topic_index', 'mesh_local_records', 'session_artifacts', 'turn_events']);
    const sourceWins = (table: string, row: unknown[], columns: string[], existing: Record<string, unknown>): boolean =>
        (table === 'turn_events' && row[columns.indexOf('publish_state')] === 'pending')
        || (table === 'session_artifacts' && (existing.origin_daemon_id === source || daemonIdsEquivalent(String(existing.origin_daemon_id ?? ''), source)));
    const apply = db.transaction(() => {
        const counts: Record<string, number> = {};
        const retained = db.prepare('SELECT snapshot_digest FROM mesh_host_handoff_archive WHERE handoff_id=? AND side=?').all(handoffId, 'source-snapshot')[0] as { snapshot_digest: string } | undefined;
        if (retained && retained.snapshot_digest !== digest) throw new Error('handoff snapshot identity changed');
        const before = Object.fromEntries(HOST_SNAPSHOT_TABLES.map(spec => [spec.table, readTable(db as never, spec, meshId)]));
        db.prepare('INSERT OR IGNORE INTO mesh_host_handoff_archive (handoff_id,side,mesh_id,snapshot_digest,payload_json) VALUES (?,?,?,?,?)')
            .run(handoffId, 'target-before', meshId, digest, JSON.stringify(before));
        db.prepare('INSERT OR IGNORE INTO mesh_host_handoff_archive (handoff_id,side,mesh_id,snapshot_digest,payload_json) VALUES (?,?,?,?,?)')
            .run(handoffId, 'source-snapshot', meshId, digest, JSON.stringify(payload));
        const reconciler = new SnapshotReconciler(db, { meshId, sourceDaemonId: source, digest, payload });
        for (const spec of HOST_SNAPSHOT_TABLES) {
            const t = payload.tables[spec.table]!;
            if (spec.table === 'assistant_memory_entry') {
                reconciler.applyMemoryRows(t.columns, t.rows);
                counts[spec.table] = t.rows.length;
                continue;
            }
            if (appendOnly.has(spec.table)) {
                const keep = t.columns.filter(c => c !== surrogateIdOf(spec.table));
                const at = keep.map(c => t.columns.indexOf(c));
                const held = db.prepare(`SELECT 1 FROM ${spec.table} WHERE ${keep.map(c => `${c} IS ?`).join(' AND ')} LIMIT 1`);
                const add = db.prepare(`INSERT INTO ${spec.table} (${keep.join(', ')}) VALUES (${keep.map(() => '?').join(', ')})`);
                for (const row of t.rows) {
                    const values = at.map(i => row[i]);
                    if (!held.all(...values).length) add.run(...values);
                }
                counts[spec.table] = t.rows.length;
                continue;
            }
            // Mission and release event seqs are exposed per project. Another project's event
            // with the same number is not a collision: both keep their exact id.
            if (historyIdentity === 'preserve-exact' && PROJECT_SCOPED_HISTORY_TABLES.has(spec.table)) {
                const seqAt = t.columns.indexOf('seq');
                const foreign = db.prepare(`SELECT 1 FROM ${spec.table} WHERE seq = ? AND mesh_id != ? LIMIT 1`);
                if (t.rows.some(row => foreign.all(row[seqAt], meshId).length)) ensureProjectScopedHistory(db as never, spec.table);
            }
            const pk = historyIdentityColumns(db as never, spec.table);
            if (!pk.length) throw new Error(`snapshot table has no identity: ${spec.table}`);
            const select = db.prepare(`SELECT * FROM ${spec.table} WHERE ${pk.map(k => `${k} = ?`).join(' AND ')}`);
            const insert = db.prepare(`INSERT INTO ${spec.table} (${t.columns.join(', ')}) VALUES (${t.columns.map(() => '?').join(', ')})`);
            const coordinate = surrogate[spec.table];
            const collided = coordinate ? t.rows.find(row => {
                const key = JSON.stringify(pk.map(k => row[t.columns.indexOf(k)]));
                if (db.prepare('SELECT target_key FROM mesh_host_handoff_row_map WHERE mesh_id=? AND table_name=? AND source_daemon_id=? AND source_key=?').all(meshId, spec.table, source, key).length) return true;
                const existing = select.all(...pk.map(k => row[t.columns.indexOf(k)]))[0] as Record<string, unknown> | undefined;
                return existing && !t.columns.every((c, i) => existing[c] === row[i]);
            }) : undefined;
            const needsRemap = !!collided;
            if (collided && historyIdentity !== 'origin-qualified-prototype') throw new Error(`history identity collision requires owner compatibility decision: ${spec.table} key ${JSON.stringify(pk.map(k => collided[t.columns.indexOf(k)]))}`);
            let nextCoordinate = coordinate ? Number((db.prepare(`SELECT COALESCE(MAX(${coordinate}),0) AS n FROM ${spec.table}`).all()[0] as { n: number }).n) : 0;
            let lastCoordinate = -1;
            for (const original of t.rows) {
                const row = [...original];
                const key = JSON.stringify(pk.map(k => original[t.columns.indexOf(k)]));
                const mapped = db.prepare('SELECT target_key FROM mesh_host_handoff_row_map WHERE mesh_id=? AND table_name=? AND source_daemon_id=? AND source_key=?').all(meshId, spec.table, source, key)[0] as { target_key: string } | undefined;
                if (mapped) {
                    const values = JSON.parse(mapped.target_key) as unknown[];
                    pk.forEach((k, i) => { row[t.columns.indexOf(k)] = values[i]; });
                }
                let existing = select.all(...pk.map(k => row[t.columns.indexOf(k)]))[0] as Record<string, unknown> | undefined;
                const same = () => existing && t.columns.every((c, i) => existing![c] === row[i]);
                if (same()) {
                    if (coordinate && needsRemap && Number(row[t.columns.indexOf(coordinate)]) <= lastCoordinate) throw new Error('retained event stream has incompatible ordering');
                    if (coordinate) lastCoordinate = Number(row[t.columns.indexOf(coordinate)]);
                    continue;
                }
                if (reconciler.resolve(spec.table, t.columns, row) === 'skip') continue;
                existing = select.all(...pk.map(k => row[t.columns.indexOf(k)]))[0] as Record<string, unknown> | undefined;
                if (coordinate && needsRemap && !mapped) {
                    row[t.columns.indexOf(coordinate)] = ++nextCoordinate;
                    db.prepare('INSERT INTO mesh_host_handoff_row_map (mesh_id,table_name,source_daemon_id,source_key,target_key,snapshot_digest) VALUES (?,?,?,?,?,?)')
                        .run(meshId, spec.table, source, key, JSON.stringify(pk.map(k => row[t.columns.indexOf(k)])), digest);
                    existing = undefined;
                }
                if (coordinate && needsRemap) {
                    const value = Number(row[t.columns.indexOf(coordinate)]);
                    if (value <= lastCoordinate) throw new Error('retained event stream has incompatible ordering');
                    lastCoordinate = value;
                }
                if (existing) {
                    // Never overwrite another project or a conflicting local
                    // attempt/event/artifact. Reconciliation must settle it first.
                    const scopeMatches = spec.parentTable
                        ? before[spec.table]!.rows.some(r => pk.every(k => r[before[spec.table]!.columns.indexOf(k)] === row[t.columns.indexOf(k)]))
                        // An observation with no project yet is this session's own row, not another project's.
                        : existing[spec.meshColumn] === meshId || (observed.has(spec.table) && existing[spec.meshColumn] === null);
                    const rowKey = pk.map(k => row[t.columns.indexOf(k)]);
                    if (!scopeMatches) throw snapshotConflict(spec.table, rowKey, 'the row belongs to another project');
                    if (observed.has(spec.table) && !sourceWins(spec.table, row, t.columns, existing)) continue;
                    if (!observed.has(spec.table) && !mutable.has(spec.table)) throw snapshotConflict(spec.table, rowKey, 'host-only history differs');
                    try {
                        db.prepare(`UPDATE ${spec.table} SET ${t.columns.map(c => `${c}=?`).join(',')} WHERE ${pk.map(k => `${k}=?`).join(' AND ')}`)
                            .run(...row, ...rowKey);
                    } catch (e) { throw snapshotConflict(spec.table, rowKey, (e as Error).message); }
                } else {
                    try { insert.run(...row); }
                    catch (e) { throw snapshotConflict(spec.table, pk.map(k => row[t.columns.indexOf(k)]), (e as Error).message); }
                }
            }
            counts[spec.table] = t.rows.length;
        }
        reconciler.archive(handoffId);
        return counts;
    });
    return apply();
}

function surrogateIdOf(table: string): string { return table === 'mesh_tool_call_log' || table === 'assistant_procedure_signals' ? 'id' : ''; }

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
