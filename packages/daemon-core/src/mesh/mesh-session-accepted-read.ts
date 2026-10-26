/** Indexed, content-free audit reads and version-cached legacy output fallback.
 * Work scales with live session candidates, never the terminal queue history.
 */
import type { Database } from 'better-sqlite3';
import type { MeshRuntimeStore } from './mesh-runtime-store.js';

const indexed = new WeakSet<Database>();
const outputs = new WeakMap<Database, Map<string, { version: number; envelope: any }>>();
export function readAcceptedSessionEvents(db: Database, meshId: string, sessionId: string, kind: string): Array<{ sessionId: string; generation: number; taskId: string }> {
    if (!indexed.has(db)) {
        db.exec('CREATE INDEX IF NOT EXISTS ix_lifetime_accepted_session ON turn_events(mesh_id, kind, session_id, at_ms)');
        indexed.add(db);
    }
    return db.prepare(`SELECT e.session_id AS sessionId, e.generation, a.task_id AS taskId
        FROM turn_events e INDEXED BY ix_lifetime_accepted_session JOIN turn_attempts a ON a.attempt_id = e.attempt_id
        WHERE e.mesh_id = ? AND e.kind = ? AND e.session_id = ?`).all(meshId, kind, sessionId.trim()) as Array<{ sessionId: string; generation: number; taskId: string }>;
}
export function readAcceptedOutput(store: MeshRuntimeStore, taskId: string): any {
    const version = store.db.prepare('SELECT version FROM mesh_task_outputs WHERE task_id = ? ORDER BY version DESC LIMIT 1').get(taskId) as { version: number } | undefined;
    if (!version) return null;
    let cache = outputs.get(store.db);
    if (!cache) { cache = new Map(); outputs.set(store.db, cache); }
    const cached = cache.get(taskId);
    if (cached?.version === version.version) return cached.envelope;
    const output = store.getLatestTaskOutput(taskId);
    if (!output) throw new Error('lifetime_output_version_disappeared');
    const envelope = JSON.parse(output.envelopeJson);
    if (cache.size >= 2048) cache.delete(cache.keys().next().value!);
    cache.set(taskId, { version: output.version, envelope });
    return envelope;
}
