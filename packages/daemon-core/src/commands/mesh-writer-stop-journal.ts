import { createHash } from 'node:crypto';
import { MeshRuntimeStore } from '../mesh/mesh-runtime-store.js';
import type { CancelDispatchRequest } from '../mesh/turn-ledger/effects.js';
import type { NativeWriterProcess } from './mesh-writer-stop.js';

export interface WriterStopCapture { requestKey: string; runtimeKey: string; startedAt: number; root: NativeWriterProcess; tree: NativeWriterProcess[]; incarnation: string }
const key = (r: CancelDispatchRequest) => JSON.stringify([r.meshId,r.taskId,r.attemptId,r.generation,r.dispatchNonce,r.sessionId,r.nodeId,r.providerType,r.ownerDaemonId,r.stopRequestId]);
function db(create = false) {
    const db = MeshRuntimeStore.getInstance().db;
    if (create) db.exec('CREATE TABLE IF NOT EXISTS mesh_writer_stop_captures (request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, capture_json TEXT NOT NULL, settled INTEGER NOT NULL DEFAULT 0)');
    return db;
}
export function readWriterStopCapture(r: CancelDispatchRequest): WriterStopCapture | null {
    if (!db().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mesh_writer_stop_captures'").get()) return null;
    const row = db().prepare('SELECT capture_json FROM mesh_writer_stop_captures WHERE request_id = ?').get(r.stopRequestId) as { capture_json: string } | undefined;
    if (!row) return null;
    const capture = JSON.parse(row.capture_json) as WriterStopCapture;
    if (capture.requestKey !== key(r)) throw new Error('writer_stop_request_identity_changed');
    return capture;
}
export function captureWriterStop(r: CancelDispatchRequest, root: NativeWriterProcess, tree: NativeWriterProcess[], runtimeKey: string, startedAt: number): WriterStopCapture {
    const requestKey = key(r);
    const capture = { requestKey, runtimeKey, startedAt, root, tree, incarnation: createHash('sha256').update(JSON.stringify([requestKey,runtimeKey,startedAt,root,tree])).digest('hex') };
    db(true).prepare('INSERT OR IGNORE INTO mesh_writer_stop_captures (request_id,session_id,capture_json) VALUES (?,?,?)').run(r.stopRequestId,r.sessionId,JSON.stringify(capture));
    return readWriterStopCapture(r)!;
}
export function isWriterStopPending(sessionId: string): boolean {
    if (!db().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mesh_writer_stop_captures'").get()) return false;
    return !!db().prepare('SELECT 1 FROM mesh_writer_stop_captures WHERE session_id = ? AND settled = 0').get(sessionId);
}
export function markWriterStopQuiescent(r: CancelDispatchRequest): void {
    readWriterStopCapture(r);
    db().prepare('UPDATE mesh_writer_stop_captures SET settled = 1 WHERE request_id = ?').run(r.stopRequestId);
}
