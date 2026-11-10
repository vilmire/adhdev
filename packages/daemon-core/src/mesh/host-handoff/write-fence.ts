/** SQLite enforces the project cut across every MeshRuntimeStore connection.
 * The import permit is connection-local, synchronous and scoped to one project;
 * it is never persisted or accepted from command arguments. */
import { HOST_SNAPSHOT_TABLES } from './snapshot-export.js';

interface FenceDb {
    exec(sql: string): unknown;
    function(name: string, fn: () => string): unknown;
    prepare(sql: string): { get(...args: unknown[]): any; all(...args: unknown[]): any[]; run(...args: unknown[]): unknown };
    transaction<T>(operation: () => T): () => T;
}
/** True for the abort a write fence raises (a project mid- or post-handoff on this machine). */
export function isHostMoveFencedError(error: unknown): boolean {
    return String((error as Error)?.message ?? error).includes('mesh_host_handoff_fenced');
}
const LOCAL_MEMBER_TABLES = new Set(['turn_attempts', 'turn_events', 'turn_holds', 'mesh_topic_index', 'mesh_local_records', 'mesh_task_outputs', 'session_artifacts', 'mesh_tool_call_log']);
const permits = new WeakMap<object, { meshId: string }>();

/** Must run immediately after opening a connection: persisted triggers can be
 * compiled by migrations before the fence schema initializer is reached. */
export function registerHandoffImportFunction(db: Pick<FenceDb, 'function'>): void {
    if (!permits.has(db)) {
        const state = { meshId: '' }; permits.set(db, state);
        db.function('adhdev_handoff_import_mesh', () => state.meshId);
    }
}

export function initializeHandoffWriteFences(db: FenceDb): void {
    registerHandoffImportFunction(db);
    db.exec(`CREATE TABLE IF NOT EXISTS mesh_host_write_fences (
        mesh_id TEXT PRIMARY KEY, handoff_id TEXT NOT NULL, epoch INTEGER NOT NULL, mode TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mesh_host_frozen_rows (
        mesh_id TEXT NOT NULL, table_name TEXT NOT NULL, row_key TEXT NOT NULL,
        PRIMARY KEY(mesh_id,table_name,row_key)
    )`);
    db.transaction(() => {
    for (const spec of HOST_SNAPSHOT_TABLES) {
        const mesh = (row: string) => spec.table === 'assistant_memory_entry'
            ? `(CASE WHEN ${row}.scope='project' THEN ${row}.project_ref ELSE NULL END)`
            : spec.parentTable
            ? `(SELECT mesh_id FROM ${spec.parentTable} WHERE ${spec.parentColumn} = ${row}.${spec.meshColumn})`
            : `${row}.${spec.meshColumn}`;
        const keys = db.prepare(`PRAGMA table_info(${spec.table})`).all().filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name as string);
        const frozen = (row: string) => `EXISTS (SELECT 1 FROM mesh_host_frozen_rows r WHERE r.mesh_id=${mesh(row)} AND r.table_name='${spec.table}' AND r.row_key=json_array(${keys.map(k => `${row}.${k}`).join(',')}))`;
        const oldAttempt = (row: string) => spec.table === 'turn_events' || spec.table === 'turn_holds'
            ? ` OR EXISTS (SELECT 1 FROM mesh_host_frozen_rows r WHERE r.mesh_id=${mesh(row)} AND r.table_name='turn_attempts' AND r.row_key=json_array(${row}.attempt_id))` : '';
        const blocked = (row: string) => `EXISTS (SELECT 1 FROM mesh_host_write_fences f WHERE f.mesh_id = ${mesh(row)} AND f.mesh_id != adhdev_handoff_import_mesh()
            ${LOCAL_MEMBER_TABLES.has(spec.table) ? `AND (f.mode!='history' OR ${frozen(row)}${oldAttempt(row)})` : ''})`;
        for (const [operation, condition] of [['INSERT', blocked('NEW')], ['DELETE', blocked('OLD')], ['UPDATE', `(${blocked('OLD')} OR ${blocked('NEW')})`]]) {
            // Replace only our generated trigger definition, retaining all rows.
            const name = `handoff_fence_${spec.table}_${operation.toLowerCase()}`;
            db.exec(`DROP TRIGGER IF EXISTS ${name}; CREATE TRIGGER ${name} BEFORE ${operation} ON ${spec.table}
                WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'mesh_host_handoff_fenced'); END`);
        }
    }
    })();
}

export function acquireHandoffWriteFence(db: FenceDb, meshId: string, handoffId: string, epoch: number): void {
    db.transaction(() => {
        const current = db.prepare('SELECT * FROM mesh_host_write_fences WHERE mesh_id = ?').get(meshId);
        if (current && current.handoff_id !== handoffId && !(current.mode === 'history' && epoch > current.epoch)) throw new Error('project write fence belongs to another handoff');
        db.prepare('INSERT INTO mesh_host_write_fences (mesh_id,handoff_id,epoch,mode) VALUES (?,?,?,?) ON CONFLICT(mesh_id) DO UPDATE SET handoff_id=excluded.handoff_id,epoch=excluded.epoch,mode=excluded.mode')
            .run(meshId, handoffId, epoch, 'transfer');
        const capture = db.prepare('INSERT OR IGNORE INTO mesh_host_frozen_rows (mesh_id,table_name,row_key) VALUES (?,?,?)');
        for (const spec of HOST_SNAPSHOT_TABLES.filter(s => LOCAL_MEMBER_TABLES.has(s.table))) {
            const keys = db.prepare(`PRAGMA table_info(${spec.table})`).all().filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name as string);
            const rows = db.prepare(`SELECT ${keys.join(',')} FROM ${spec.table} WHERE ${spec.scopeSql ?? `${spec.meshColumn} = ?`}`).all(meshId);
            for (const row of rows) capture.run(meshId, spec.table, JSON.stringify(keys.map(k => row[k])));
        }
    })();
}

export function releaseHandoffWriteFence(db: FenceDb, meshId: string, handoffId: string, history: boolean): void {
    const current = db.prepare('SELECT * FROM mesh_host_write_fences WHERE mesh_id = ?').get(meshId);
    if (!current) return;
    if (current.handoff_id !== handoffId) throw new Error('project write fence identity changed');
    if (history) db.prepare("UPDATE mesh_host_write_fences SET mode='history' WHERE mesh_id=? AND handoff_id=?").run(meshId, handoffId);
    else {
        db.prepare('DELETE FROM mesh_host_write_fences WHERE mesh_id=? AND handoff_id=?').run(meshId, handoffId);
        db.prepare('DELETE FROM mesh_host_frozen_rows WHERE mesh_id=?').run(meshId);
    }
}

export function withHandoffImport<T>(db: object, meshId: string, operation: () => T): T {
    const state = permits.get(db);
    if (!state || state.meshId) throw new Error('handoff import permit unavailable');
    state.meshId = meshId;
    try { return operation(); } finally { state.meshId = ''; }
}
