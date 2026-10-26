/** Durable exclusion shared by stop RPCs and the atomic queue claim transaction.
 * An ambiguous/failed stop keeps its reservation across retries and daemon restart.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';

export interface SessionClaimFence { taskId: string | null; attemptId: string | null; generation: number | null; dispatchNonce: number | null }
export function sessionClaimFence(state: any): SessionClaimFence {
    const s = state?.settings ?? {};
    return { taskId: s.meshActiveTaskId ?? null, attemptId: s.meshActiveAttemptId ?? null,
        generation: s.meshActiveAttemptGeneration ?? null, dispatchNonce: s.meshActiveDispatchNonce ?? null };
}
export function claimFenceMatches(expected: SessionClaimFence, state: any): boolean {
    return JSON.stringify(expected) === JSON.stringify(sessionClaimFence(state));
}
function ensure(db: Database): void {
    db.exec(`CREATE TABLE IF NOT EXISTS mesh_session_stop_fences (
        session_id TEXT PRIMARY KEY, mesh_id TEXT NOT NULL, stop_id TEXT NOT NULL, state TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS ix_session_stop_pending ON mesh_session_stop_fences(mesh_id, state)`);
}
export function sessionIsStopping(db: Database, sessionId: string): boolean {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mesh_session_stop_fences'").get()) return false;
    return !!db.prepare('SELECT 1 FROM mesh_session_stop_fences WHERE session_id = ?').get(sessionId.trim());
}
export function reserveSessionStop(db: Database, meshId: string, sessionId: string, stopId?: string): string {
    ensure(db);
    return db.transaction(() => {
        const held = db.prepare('SELECT mesh_id, stop_id FROM mesh_session_stop_fences WHERE session_id = ?').get(sessionId.trim()) as { mesh_id: string; stop_id: string } | undefined;
        if (held) {
            if (held.mesh_id !== meshId || (stopId && held.stop_id !== stopId)) throw new Error('session_stop_fence_conflict');
            return held.stop_id;
        }
        const id = stopId ?? randomUUID();
        db.prepare("INSERT INTO mesh_session_stop_fences VALUES (?, ?, ?, 'stopping')").run(sessionId.trim(), meshId, id);
        return id;
    }).immediate();
}
/** Release only before a stop can have been sent, or after an explicit no-stop refusal. */
export function releaseSessionStop(db: Database, sessionId: string, stopId: string): void {
    db.prepare('DELETE FROM mesh_session_stop_fences WHERE session_id = ? AND stop_id = ?').run(sessionId.trim(), stopId);
}
export function sessionStopPending(db: Database, sessionId: string): boolean {
    if (!sessionIsStopping(db, sessionId)) return false;
    return !!db.prepare("SELECT 1 FROM mesh_session_stop_fences WHERE session_id = ? AND state = 'stopping'").get(sessionId.trim());
}
export function hasPendingSessionStops(db: Database, meshId: string): boolean {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mesh_session_stop_fences'").get()) return false;
    return !!db.prepare("SELECT 1 FROM mesh_session_stop_fences WHERE mesh_id = ? AND state = 'stopping' LIMIT 1").get(meshId);
}
export function confirmSessionStop(db: Database, sessionId: string, stopId: string): void {
    // Keep a tombstone so a stale remote-idle row cannot claim the stopped runtime.
    db.prepare("UPDATE mesh_session_stop_fences SET state = 'stopped' WHERE session_id = ? AND stop_id = ?").run(sessionId.trim(), stopId);
}
