import { pinnedMeshNodeIdMatches } from '../mesh/mesh-pinned-node-identity.js';
/** Source half of duplicate-holder reconciliation. The owner receives proof
 * only after the exact running holder's native metadata acknowledges its ref. */
import { randomUUID } from 'node:crypto';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { MeshRuntimeStore } from '../mesh/mesh-runtime-store.js';
import type { CliAgentCommandHost } from './cli-manager-agent-command.js';
import type { AgentCommandArgs } from './command-args.js';
import type { CliProviderInstance } from '../providers/cli-provider-instance.js';
import { nativeMeshAssignmentMeta, type MeshAssignmentSnapshot } from '../providers/cli-provider-mesh-assignment.js';
import { liveWorkingStatus } from '../providers/provider-instance-manager.js';
import { isWriterStopPending } from './mesh-writer-stop-journal.js';

const BOOT = randomUUID();
interface AttachRow { identity_json: string; snapshot_json: string; phase: string; prepared_json: string; runtime_json: string; boot_nonce: string }
function journal(create = false) {
    const db = MeshRuntimeStore.getInstance().db;
    if (create) db.exec('CREATE TABLE IF NOT EXISTS mesh_holder_attaches (operation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, identity_json TEXT NOT NULL, snapshot_json TEXT NOT NULL, phase TEXT NOT NULL, prepared_json TEXT NOT NULL, runtime_json TEXT NOT NULL, boot_nonce TEXT NOT NULL)');
    return db;
}
function hasJournal(): boolean { return !!journal().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mesh_holder_attaches'").get(); }
function runtime(instance: CliProviderInstance): string {
    const m = instance.getAdapter()?.getRuntimeMetadata?.() as Record<string, unknown> | undefined;
    if (m?.runtimeId !== instance.instanceId || typeof m.runtimeKey !== 'string' || !m.runtimeKey
        || !Number.isSafeInteger(m.osPid) || Number(m.osPid) <= 0 || !Number.isSafeInteger(m.startedAt) || Number(m.startedAt) <= 0) return '';
    return JSON.stringify([m.runtimeId, m.runtimeKey, m.osPid, m.startedAt]);
}
function meta(snapshot: MeshAssignmentSnapshot): Record<string, unknown> {
    return nativeMeshAssignmentMeta(snapshot.settings);
}
export function isHolderAttachPending(sessionId: string): boolean {
    return hasJournal() && !!journal().prepare("SELECT 1 FROM mesh_holder_attaches WHERE session_id=? AND phase IN ('preparing','prepared','rollback_pending','checkpoint_pending')").get(sessionId);
}

/** A failed native acknowledgement never moved the owner. Restore the paired
 * logical source claim before a restored worker forwards another MCP call.
 * The same native incarnation and task/ref fences prevent touching a new task. */
export function recoverHolderAttachRollback(instance: CliProviderInstance): void {
    if (!hasJournal() || !instance?.captureMeshAssignment || !instance.restoreMeshAssignment) return;
    const rows = journal().prepare("SELECT * FROM mesh_holder_attaches WHERE session_id=? AND phase='rollback_pending'").all(instance.instanceId) as AttachRow[];
    for (const row of rows) {
        if (!runtime(instance) || runtime(instance) !== row.runtime_json) continue;
        const current = instance.getState().settings, before = JSON.parse(row.snapshot_json) as MeshAssignmentSnapshot;
        const prepared = JSON.parse(row.prepared_json) as MeshAssignmentSnapshot;
        if (current?.assistant || current?.meshCoordinatorFor || current?.meshNodeFor !== before.settings.meshNodeFor
            || current?.meshNodeId !== before.settings.meshNodeId || typeof current?.meshCoordinatorDaemonId !== 'string'
            || !daemonIdsEquivalent(current.meshCoordinatorDaemonId, before.settings.meshCoordinatorDaemonId)
            || (current?.meshActiveDispatchNonce ?? 0) > Math.max(before.settings.meshActiveDispatchNonce ?? 0, prepared.settings.meshActiveDispatchNonce ?? 0)
            || (current?.meshActiveTaskId && current.meshActiveTaskId !== before.settings.meshActiveTaskId)
            || (current?.meshActiveAttemptId && current.meshActiveAttemptId !== before.settings.meshActiveAttemptId)
            || ![before.settings.meshActiveAttemptGeneration ?? 0, prepared.settings.meshActiveAttemptGeneration ?? 0].includes(current?.meshActiveAttemptGeneration ?? 0)) continue;
        // A live process already holding the original snapshot needs no re-stamp.
        if (JSON.stringify(instance.captureMeshAssignment()) !== row.snapshot_json) instance.restoreMeshAssignment(before);
    }
}

export async function reconcileMeshHolder(host: CliAgentCommandHost, args: AgentCommandArgs) {
    const mc = args.meshContext, op = args.holderReconcile;
    const refuse = (reason: string) => ({ success: false, code: 'mesh_holder_attach_refused', reason });
    if (!mc?.meshId || !mc.taskId || !mc.nodeId || !mc.attemptId || !Number.isSafeInteger(mc.attemptGeneration)
        || mc.attemptGeneration! < 0 || !Number.isSafeInteger(mc.dispatchNonce) || mc.dispatchNonce! < 0 || !mc.coordinatorDaemonId
        || !args.targetSessionId || !op?.operationId || op.operationId.length > 512
        || !['prepare','commit','rollback'].includes(op.phase)) return refuse('identity_required');
    const instance = host.deps.getInstanceManager()?.getInstance(args.targetSessionId) as CliProviderInstance | undefined;
    if (!instance?.captureMeshAssignment || !instance.restoreMeshAssignment) return refuse('holder_unavailable');
    if (!runtime(instance) || !instance.getAdapter()?.verifyRuntimeMeta) return refuse('native_attach_ack_unavailable');
    const launch = host.deps.getSessionRegistry?.()?.get(args.targetSessionId)?.launch;
    if (launch?.launchedBy === 'assistant' || launch?.roleLaunch || isWriterStopPending(args.targetSessionId)) return refuse('protected_or_stopping_holder');
    const db = journal(true), identity = JSON.stringify([args.targetSessionId,args.agentType,mc]);
    const row = db.prepare('SELECT * FROM mesh_holder_attaches WHERE operation_id=?').get(op.operationId) as AttachRow | undefined;
    if (row && row.identity_json !== identity) return refuse('operation_identity_changed');
    recoverHolderAttachRollback(instance);
    const state = instance.getState(), s = state.settings;
    if (instance.getAdapter()?.cliType !== args.agentType || (op.phase === 'prepare' && !liveWorkingStatus(state))) return refuse('holder_not_currently_working');
    if (s?.assistant || s?.meshCoordinatorFor || s?.meshNodeFor !== mc.meshId || !pinnedMeshNodeIdMatches(s?.meshNodeId, mc.nodeId)
        || (s?.meshActiveTaskId !== mc.taskId && !(row && row.boot_nonce !== BOOT && !s?.meshActiveTaskId))
        || s?.meshActiveAttemptId !== mc.attemptId || typeof s?.meshCoordinatorDaemonId !== 'string'
        || !daemonIdsEquivalent(s.meshCoordinatorDaemonId, mc.coordinatorDaemonId)
        || (s.meshActiveAttemptGeneration ?? 0) > mc.attemptGeneration! || (s.meshActiveDispatchNonce ?? 0) > mc.dispatchNonce!) return refuse('foreign_or_stale_holder');
    const current = () => {
        const v = instance.getState().settings;
        return v?.meshActiveTaskId === mc.taskId && v?.meshActiveAttemptId === mc.attemptId
            && (v?.meshActiveAttemptGeneration ?? 0) === mc.attemptGeneration && v?.meshActiveDispatchNonce === mc.dispatchNonce;
    };
    const verify = async (snapshot: MeshAssignmentSnapshot) => {
        try { return await instance.getAdapter()?.verifyRuntimeMeta?.(meta(snapshot)) === true; } catch { return false; }
    };
    const proof = () => ({ success: true, attached: true, operationId: op.operationId, sessionId: args.targetSessionId, ...mc });
    if (op.phase === 'prepare') {
        if (row) {
            if (!['preparing','prepared'].includes(row.phase) || runtime(instance) !== row.runtime_json) return refuse('prepare_no_longer_current');
            if (row.boot_nonce !== BOOT && !current() && await verify(JSON.parse(row.prepared_json))) {
                instance.attachMeshAssignment({ ...mc, meshId: mc.meshId });
                db.prepare('UPDATE mesh_holder_attaches SET prepared_json=?,boot_nonce=? WHERE operation_id=?')
                    .run(JSON.stringify(instance.captureMeshAssignment()), BOOT, op.operationId);
            }
            const snapshot = instance.captureMeshAssignment();
            const owns = row.boot_nonce !== BOOT || JSON.stringify(snapshot) === row.prepared_json;
            return current() && owns && await verify(snapshot) ? proof() : refuse('native_attach_unconfirmed');
        }
        const before = instance.captureMeshAssignment();
        let prepared: MeshAssignmentSnapshot | undefined;
        try {
            db.transaction(() => {
                const stamped = host.deps.getInstanceManager()!.attachMeshAssignmentToInstance(args.targetSessionId!, { ...mc, meshId: mc.meshId! });
                if (!stamped.stamped || !current()) throw new Error('holder_attach_failed');
                prepared = instance.captureMeshAssignment();
                db.prepare('INSERT INTO mesh_holder_attaches VALUES (?,?,?,?,?,?,?,?)')
                    .run(op.operationId,args.targetSessionId,identity,JSON.stringify(before),'preparing',JSON.stringify(prepared),runtime(instance),BOOT);
            }).immediate();
            if (!await verify(prepared!) || !current() || JSON.stringify(instance.captureMeshAssignment()) !== JSON.stringify(prepared)) throw new Error('native_attach_unconfirmed');
            db.prepare("UPDATE mesh_holder_attaches SET phase='prepared' WHERE operation_id=?").run(op.operationId);
            return proof();
        } catch {
            if (!prepared || JSON.stringify(instance.captureMeshAssignment()) === JSON.stringify(prepared)) {
                instance.restoreMeshAssignment(before);
                if (prepared) db.prepare('UPDATE mesh_holder_attaches SET phase=? WHERE operation_id=?')
                    .run(await verify(before) ? 'rolled_back' : 'rollback_pending',op.operationId);
            }
            return refuse('holder_attach_failed_checkpoint_pending');
        }
    }
    if (!row || !['prepared','preparing','committed'].includes(row.phase) || !current()
        || runtime(instance) !== row.runtime_json || (row.boot_nonce === BOOT && JSON.stringify(instance.captureMeshAssignment()) !== row.prepared_json)) return refuse('late_claim_changed');
    if (op.phase === 'rollback') {
        if (row.phase === 'committed') return refuse('already_committed');
        const before = JSON.parse(row.snapshot_json) as MeshAssignmentSnapshot;
        instance.restoreMeshAssignment(before);
        const confirmed = await verify(before);
        db.prepare('UPDATE mesh_holder_attaches SET phase=? WHERE operation_id=?').run(confirmed ? 'rolled_back' : 'rollback_pending',op.operationId);
        return { success: confirmed, rolledBack: confirmed };
    }
    if (!await verify(instance.captureMeshAssignment())) return refuse('native_attach_unconfirmed');
    db.prepare("UPDATE mesh_holder_attaches SET phase='committed' WHERE operation_id=?").run(op.operationId);
    return { success: true, committed: true };
}
