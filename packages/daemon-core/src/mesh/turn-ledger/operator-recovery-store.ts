import { readFileSync } from 'node:fs';
import { getMeshConfigPath, inRecoveryMeshOwnershipFence } from '../../config/mesh-config-store.js';
import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { OPERATOR_RECOVERY_TARGET as target } from '@adhdev/session-host-core';
import type { RecoveryCurrentAssignment } from './operator-recovery.js';

/** Real owner/latest-attempt/queue CAS read on the ledger's exact SQLite handle.
 * Never uses an inline roster, caller tuple, or a previously read attempt. */
export function readRecoveryCurrentAssignment(db: Database, selfDaemonId: string): RecoveryCurrentAssignment {
    if (!db.inTransaction || selfDaemonId !== target.ownerDaemonId) throw new Error('recovery_owner_transaction_required');
    if (!inRecoveryMeshOwnershipFence()) throw new Error('recovery_physical_owner_fence_required');
    const currentMesh = JSON.parse(readFileSync(getMeshConfigPath(), 'utf8')).meshes?.find((m: any) => m.id === target.meshId);
    if (currentMesh?.meshHost?.role !== 'host' || currentMesh.meshHost.hostDaemonId !== selfDaemonId) throw new Error('recovery_current_mesh_owner_mismatch');
    const a = db.prepare(`SELECT * FROM turn_attempts WHERE mesh_id=? AND task_id=?
        ORDER BY attempt_no DESC, accepted_at DESC LIMIT 1`).get(target.meshId, target.taskId) as Record<string, any> | undefined;
    const q = db.prepare('SELECT * FROM mesh_queue WHERE id=? AND mesh_id=?').get(target.taskId, target.meshId) as Record<string, any> | undefined;
    if (!a || !q || a.owner_daemon_id !== selfDaemonId || a.terminal_outcome !== null) throw new Error('recovery_current_assignment_missing');
    const payload = JSON.parse(q.payload);
    if (payload.id !== target.taskId || payload.dispatchNonce !== target.dispatchNonce ||
        payload.assignedNodeId !== q.assigned_node_id || payload.assignedSessionId !== q.assigned_session_id ||
        payload.status !== q.status) throw new Error('recovery_queue_payload_mismatch');
    const hash = (s: unknown) => createHash('sha256').update(JSON.stringify(s)).digest('hex');
    return { ownerDaemonId: a.owner_daemon_id, meshId: a.mesh_id, taskId: a.task_id,
        attemptId: a.attempt_id, generation: a.generation, dispatchNonce: a.dispatch_nonce,
        sessionId: a.session_id, nodeId: a.node_id, deliveryId: a.message_id, state: a.state,
        queueStatus: q.status, queueNodeId: q.assigned_node_id, queueSessionId: q.assigned_session_id,
        ownerRevision: hash([a.owner_daemon_id, a.attempt_id, a.updated_at, a.data_json, currentMesh.meshHost]),
        queueRevision: hash(q) };
}
