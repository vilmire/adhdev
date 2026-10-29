/** Durable exclusion shared by stop RPCs and the atomic queue claim transaction.
 * An ambiguous/failed stop keeps its reservation across retries and daemon restart.
 * Expected assignment is captured with the reservation and carried to the host stop
 * critical section — a last-read CAS before async stop is not sufficient alone.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { SessionCleanupExpectedAssignment } from '@adhdev/session-host-core';

export interface SessionClaimFence { taskId: string | null; attemptId: string | null; generation: number | null; dispatchNonce: number | null }
export type SessionCleanupExpected = SessionCleanupExpectedAssignment;

export function sessionClaimFence(state: any): SessionClaimFence {
    const s = state?.settings ?? {};
    return { taskId: s.meshActiveTaskId ?? null, attemptId: s.meshActiveAttemptId ?? null,
        generation: s.meshActiveAttemptGeneration ?? null, dispatchNonce: s.meshActiveDispatchNonce ?? null };
}
export function claimFenceMatches(expected: SessionClaimFence, state: any): boolean {
    return JSON.stringify(expected) === JSON.stringify(sessionClaimFence(state));
}

export function captureCleanupExpected(args: {
    sessionId: string;
    hostBootId: string;
    runtimeKey: string;
    startedAt: number;
    state: any;
}): SessionCleanupExpected | null {
    if (!args.hostBootId || !args.runtimeKey || !Number.isSafeInteger(args.startedAt) || args.startedAt <= 0) return null;
    return { sessionId: args.sessionId, hostBootId: args.hostBootId, runtimeKey: args.runtimeKey,
        startedAt: args.startedAt, ...sessionClaimFence(args.state) };
}

/** Capture expected from the host session record (operator cleanup selection). */
export function claimFenceFromHostRecord(record: { meta?: any } | null | undefined): SessionClaimFence {
    const active = record?.meta?.meshActiveAssignment;
    if (active && typeof active.taskId === 'string' && active.taskId) {
        return {
            taskId: active.taskId,
            attemptId: typeof active.attemptId === 'string' ? active.attemptId : null,
            generation: Number.isSafeInteger(active.generation) ? Number(active.generation) : null,
            dispatchNonce: Number.isSafeInteger(active.dispatchNonce) ? Number(active.dispatchNonce) : null,
        };
    }
    return { taskId: null, attemptId: null, generation: null, dispatchNonce: null };
}

export function captureCleanupExpectedFromHostRecord(args: {
    sessionId: string;
    hostBootId: string;
    record: { runtimeKey?: string; startedAt?: number; meta?: any };
}): SessionCleanupExpected | null {
    if (!args.hostBootId || !args.record.runtimeKey
        || !Number.isSafeInteger(args.record.startedAt) || (args.record.startedAt ?? 0) <= 0) {
        return null;
    }
    return {
        sessionId: args.sessionId,
        hostBootId: args.hostBootId,
        runtimeKey: args.record.runtimeKey,
        startedAt: args.record.startedAt as number,
        ...claimFenceFromHostRecord(args.record),
    };
}

export function expectedAssignmentUnchanged(expected: SessionCleanupExpected, state: any, record: {
    sessionId: string; runtimeKey?: string; startedAt?: number;
}): boolean {
    if (expected.sessionId !== record.sessionId || expected.runtimeKey !== record.runtimeKey
        || expected.startedAt !== record.startedAt) return false;
    return claimFenceMatches({
        taskId: expected.taskId, attemptId: expected.attemptId,
        generation: expected.generation, dispatchNonce: expected.dispatchNonce,
    }, state);
}

function ensure(db: Database): void {
    db.exec(`CREATE TABLE IF NOT EXISTS mesh_session_stop_fences (
        session_id TEXT PRIMARY KEY, mesh_id TEXT NOT NULL, stop_id TEXT NOT NULL, state TEXT NOT NULL,
        expected_json TEXT);
        CREATE INDEX IF NOT EXISTS ix_session_stop_pending ON mesh_session_stop_fences(mesh_id, state)`);
    const cols = db.prepare("PRAGMA table_info(mesh_session_stop_fences)").all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'expected_json')) {
        db.exec('ALTER TABLE mesh_session_stop_fences ADD COLUMN expected_json TEXT');
    }
}
export function sessionIsStopping(db: Database, sessionId: string): boolean {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mesh_session_stop_fences'").get()) return false;
    return !!db.prepare('SELECT 1 FROM mesh_session_stop_fences WHERE session_id = ?').get(sessionId.trim());
}
export function reserveSessionStop(db: Database, meshId: string, sessionId: string, stopId?: string, expected?: SessionCleanupExpected): string {
    ensure(db);
    return db.transaction(() => {
        const held = db.prepare('SELECT mesh_id, stop_id, expected_json FROM mesh_session_stop_fences WHERE session_id = ?')
            .get(sessionId.trim()) as { mesh_id: string; stop_id: string; expected_json?: string | null } | undefined;
        if (held) {
            if (held.mesh_id !== meshId || (stopId && held.stop_id !== stopId)) throw new Error('session_stop_fence_conflict');
            if (expected && held.expected_json && held.expected_json !== JSON.stringify(expected)) {
                throw new Error('session_stop_expected_conflict');
            }
            if (expected && !held.expected_json) {
                db.prepare('UPDATE mesh_session_stop_fences SET expected_json = ? WHERE session_id = ? AND stop_id = ?')
                    .run(JSON.stringify(expected), sessionId.trim(), held.stop_id);
            }
            return held.stop_id;
        }
        const id = stopId ?? randomUUID();
        db.prepare("INSERT INTO mesh_session_stop_fences(session_id, mesh_id, stop_id, state, expected_json) VALUES (?, ?, ?, 'reserved', ?)")
            .run(sessionId.trim(), meshId, id, expected ? JSON.stringify(expected) : null);
        return id;
    }).immediate();
}
export function readReservedCleanupExpected(db: Database, sessionId: string, stopId: string): SessionCleanupExpected | null {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mesh_session_stop_fences'").get()) return null;
    const row = db.prepare('SELECT expected_json FROM mesh_session_stop_fences WHERE session_id = ? AND stop_id = ?')
        .get(sessionId.trim(), stopId) as { expected_json?: string | null } | undefined;
    if (!row?.expected_json) return null;
    try { return JSON.parse(row.expected_json) as SessionCleanupExpected; } catch { return null; }
}
/** Mark before invoking a stop: a thrown/lost RPC response is ambiguous forever. */
export function markSessionStopSent(db: Database, sessionId: string, stopId: string): void {
    const changed = db.prepare("UPDATE mesh_session_stop_fences SET state = 'stopping' WHERE session_id = ? AND stop_id = ? AND state IN ('reserved', 'stopping')").run(sessionId.trim(), stopId);
    if (changed.changes !== 1) throw new Error('session_stop_reservation_lost');
}
/** Release only a never-sent reservation; retries cannot unlock an ambiguous stop. */
export function releaseSessionStop(db: Database, sessionId: string, stopId: string): void {
    db.prepare("DELETE FROM mesh_session_stop_fences WHERE session_id = ? AND stop_id = ? AND state = 'reserved'").run(sessionId.trim(), stopId);
}
/** Clear a stopping fence only when the host returned a refuse-before-stop code (no mutation). */
export function abortSessionStopAfterHostRefusal(db: Database, sessionId: string, stopId: string): void {
    db.prepare("DELETE FROM mesh_session_stop_fences WHERE session_id = ? AND stop_id = ? AND state = 'stopping'").run(sessionId.trim(), stopId);
}
export function sessionStopPending(db: Database, sessionId: string): boolean {
    if (!sessionIsStopping(db, sessionId)) return false;
    return !!db.prepare("SELECT 1 FROM mesh_session_stop_fences WHERE session_id = ? AND state IN ('reserved', 'stopping')").get(sessionId.trim());
}
export function hasPendingSessionStops(db: Database, meshId: string): boolean {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mesh_session_stop_fences'").get()) return false;
    return !!db.prepare("SELECT 1 FROM mesh_session_stop_fences WHERE mesh_id = ? AND state IN ('reserved', 'stopping') LIMIT 1").get(meshId);
}
export function confirmSessionStop(db: Database, sessionId: string, stopId: string): void {
    // Keep a tombstone so a stale remote-idle row cannot claim the stopped runtime.
    db.prepare("UPDATE mesh_session_stop_fences SET state = 'stopped' WHERE session_id = ? AND stop_id = ?").run(sessionId.trim(), stopId);
}

/** Host refusal codes that prove the runtime was not mutated. */
export const CLEANUP_HOST_REFUSAL_CODES = new Set([
    'cleanup_expected_malformed',
    'cleanup_host_boot_unknown',
    'cleanup_host_boot_mismatch',
    'cleanup_session_not_running',
    'cleanup_native_incarnation_mismatch',
    'cleanup_expected_unbound_now_bound',
    'cleanup_expected_bound_now_unbound',
    'cleanup_assignment_mismatch',
]);
