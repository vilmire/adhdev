/** SQLite enforces the project cut across every MeshRuntimeStore connection.
 * The import permit is connection-local, synchronous and scoped to one project;
 * it is never persisted or accepted from command arguments. */
import { HOST_SNAPSHOT_TABLES } from './snapshot-export.js';

interface FenceDb {
    exec(sql: string): unknown;
    function(name: string, fn: () => string): unknown;
    prepare(sql: string): { get(...args: unknown[]): any; run(...args: unknown[]): unknown };
}
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
    )`);
    for (const spec of HOST_SNAPSHOT_TABLES) {
        const mesh = (row: string) => spec.parentTable
            ? `(SELECT mesh_id FROM ${spec.parentTable} WHERE ${spec.parentColumn} = ${row}.${spec.meshColumn})`
            : `${row}.${spec.meshColumn}`;
        const blocked = (row: string) => `EXISTS (SELECT 1 FROM mesh_host_write_fences f WHERE f.mesh_id = ${mesh(row)} AND f.mesh_id != adhdev_handoff_import_mesh())`;
        for (const [operation, condition] of [['INSERT', blocked('NEW')], ['DELETE', blocked('OLD')], ['UPDATE', `(${blocked('OLD')} OR ${blocked('NEW')})`]]) {
            db.exec(`CREATE TRIGGER IF NOT EXISTS handoff_fence_${spec.table}_${operation.toLowerCase()} BEFORE ${operation} ON ${spec.table}
                WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'mesh_host_handoff_fenced'); END`);
        }
    }
}

export function acquireHandoffWriteFence(db: FenceDb, meshId: string, handoffId: string, epoch: number): void {
    const current = db.prepare('SELECT * FROM mesh_host_write_fences WHERE mesh_id = ?').get(meshId);
    if (current && current.handoff_id !== handoffId && !(current.mode === 'history' && epoch > current.epoch)) throw new Error('project write fence belongs to another handoff');
    db.prepare('INSERT INTO mesh_host_write_fences (mesh_id,handoff_id,epoch,mode) VALUES (?,?,?,?) ON CONFLICT(mesh_id) DO UPDATE SET handoff_id=excluded.handoff_id,epoch=excluded.epoch,mode=excluded.mode')
        .run(meshId, handoffId, epoch, 'transfer');
}

export function releaseHandoffWriteFence(db: FenceDb, meshId: string, handoffId: string, history: boolean): void {
    const current = db.prepare('SELECT * FROM mesh_host_write_fences WHERE mesh_id = ?').get(meshId);
    if (!current) return;
    if (current.handoff_id !== handoffId) throw new Error('project write fence identity changed');
    if (history) db.prepare("UPDATE mesh_host_write_fences SET mode='history' WHERE mesh_id=? AND handoff_id=?").run(meshId, handoffId);
    else db.prepare('DELETE FROM mesh_host_write_fences WHERE mesh_id=? AND handoff_id=?').run(meshId, handoffId);
}

export function withHandoffImport<T>(db: object, meshId: string, operation: () => T): T {
    const state = permits.get(db);
    if (!state || state.meshId) throw new Error('handoff import permit unavailable');
    state.meshId = meshId;
    try { return operation(); } finally { state.meshId = ''; }
}
