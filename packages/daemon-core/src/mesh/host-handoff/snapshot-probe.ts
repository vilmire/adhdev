/**
 * Cheap conflict probe, run in preflight before anything freezes. The full rehearsal
 * on the target needs the whole snapshot, which may take minutes to copy. These are the
 * collisions the importer refuses, sent as key tuples and short row digests. Other
 * primary-key collisions with another project need the whole key set; ids that include
 * the project or a UUID make them improbable, and the rehearsal still catches them.
 */

import { sha256Hex } from './snapshot-export.js';

type Db = { prepare(sql: string): { all(...a: unknown[]): unknown[] } };
type Row = Record<string, unknown>;

export interface SnapshotConflictProbe {
    /** Exposed event numbers. The same (project, seq) with different content needs an owner decision. */
    history: Record<string, { columns: string[]; rows: Array<[number, string]> }>;
    artifacts: Array<[string, string]>;
    items: Array<[string, string]>;
    memory: string[];
}

export interface ProbeConflict { table: string; key: unknown[]; reason: string }

const HISTORY_TABLES = ['mesh_mission_events', 'mesh_release_events'] as const;
const MAX_REPORTED = 5;
/** An open attempt touched this recently may belong to a session still working here; older ones are stale records the import archives. */
const LIVE_ATTEMPT_WINDOW_MS = 2 * 60 * 60_000;

const rowDigest = (row: Row, columns: string[]) => sha256Hex(JSON.stringify(columns.map(c => row[c] ?? null))).slice(0, 16);

export function buildConflictProbe(db: Db, meshId: string): SnapshotConflictProbe {
    const history: SnapshotConflictProbe['history'] = {};
    for (const table of HISTORY_TABLES) {
        const rows = db.prepare(`SELECT * FROM ${table} WHERE mesh_id=? ORDER BY seq`).all(meshId) as Row[];
        const columns = rows.length ? Object.keys(rows[0]!).filter(c => c !== 'row_id') : [];
        history[table] = { columns, rows: rows.map(r => [r.seq as number, rowDigest(r, columns)]) };
    }
    return {
        history,
        artifacts: (db.prepare('SELECT session_id, rel_path FROM session_artifacts WHERE mesh_id=?').all(meshId) as Row[]).map(r => [String(r.session_id), String(r.rel_path)]),
        items: (db.prepare('SELECT mission_id, dedupe_key FROM mesh_mission_items WHERE mesh_id=? AND dedupe_key IS NOT NULL').all(meshId) as Row[]).map(r => [String(r.mission_id), String(r.dedupe_key)]),
        memory: (db.prepare("SELECT id FROM assistant_memory_entry WHERE scope='project' AND project_ref=?").all(meshId) as Row[]).map(r => String(r.id)),
    };
}

/** Target side. Read-only. An empty answer is not a promise: the rehearsal still decides. */
export function findProbeConflicts(db: Db, meshId: string, probe: SnapshotConflictProbe, now = Date.now()): ProbeConflict[] {
    const found: ProbeConflict[] = [];
    // The host's attempt replaces a colliding row here, so a session still working under it would report into nothing.
    for (const open of db.prepare('SELECT attempt_id, session_id, updated_at FROM turn_attempts WHERE mesh_id=? AND terminal_outcome IS NULL AND updated_at>=?').all(meshId, now - LIVE_ATTEMPT_WINDOW_MS) as Row[]) {
        found.push({ table: 'turn_attempts', key: [open.attempt_id], reason: `session ${String(open.session_id)} may still be working on this machine; let it finish first` });
    }
    for (const table of HISTORY_TABLES) {
        const incoming = probe.history?.[table];
        if (!incoming?.rows?.length) continue;
        const digests = new Map(incoming.rows);
        for (const local of db.prepare(`SELECT * FROM ${table} WHERE mesh_id=?`).all(meshId) as Row[]) {
            const want = digests.get(local.seq as number);
            if (want !== undefined && want !== rowDigest(local, incoming.columns)) found.push({ table, key: [meshId, local.seq], reason: 'the same event number holds different content here' });
        }
    }
    const artifact = db.prepare('SELECT artifact_id, mesh_id FROM session_artifacts WHERE session_id=? AND rel_path=?');
    for (const [session, path] of probe.artifacts ?? []) {
        const local = artifact.all(session, path)[0] as Row | undefined;
        if (local && local.mesh_id !== null && local.mesh_id !== meshId) found.push({ table: 'session_artifacts', key: [session, path], reason: `path belongs to another project's artifact ${String(local.artifact_id)}` });
    }
    const item = db.prepare('SELECT id, mesh_id FROM mesh_mission_items WHERE mission_id=? AND dedupe_key=?');
    for (const [mission, dedupe] of probe.items ?? []) {
        const local = item.all(mission, dedupe)[0] as Row | undefined;
        if (local && local.mesh_id !== meshId) found.push({ table: 'mesh_mission_items', key: [mission, dedupe], reason: `item ${String(local.id)} belongs to another project` });
    }
    const memory = db.prepare('SELECT scope, project_ref FROM assistant_memory_entry WHERE id=?');
    for (const id of probe.memory ?? []) {
        const local = memory.all(id)[0] as Row | undefined;
        if (local && (local.scope !== 'project' || local.project_ref !== meshId)) found.push({ table: 'assistant_memory_entry', key: [id], reason: 'id is held by a global entry or another project' });
    }
    return found;
}

/** One line for the preflight check: which table and key, and how many more. */
export function describeProbeConflicts(conflicts: readonly ProbeConflict[]): string {
    const shown = conflicts.slice(0, MAX_REPORTED).map(c => `${c.table} key ${JSON.stringify(c.key)} (${c.reason})`).join('; ');
    return conflicts.length > MAX_REPORTED ? `${shown}; and ${conflicts.length - MAX_REPORTED} more` : shown;
}
