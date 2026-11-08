/**
 * Worker identity for driver calls on a MEMBER daemon.
 *
 * A driver action must run on the machine whose screen/keyboard it drives, but the worker's attempt and task token
 * live on the task OWNER. When the local credential does not resolve (live 2026-11-08: `worker_credential_required`
 * on a member for a task the mesh host dispatched), the member asks the owner to VERIFY the claim and executes locally with
 * the identity it returns. The owner executes nothing and returns ids only, never a secret. Every driver gate
 * (activation, grants, risk, staging, leases) still runs on the member.
 */
import { readMeshSender } from '../mesh-sender.js';
import { unwrapMeshRelayResult } from '../mesh-relay-result.js';
import { resolveWorkerIdentity } from '../../mesh/worker-report.js';
import { MeshRuntimeStore } from '../../mesh/mesh-runtime-store.js';
import type { DriverWorkerIdentity } from '../../drivers/staged-action.js';
import type { MedFamilyContext, MedFamilyHandler } from './types.js';

export const DRIVER_IDENTITY_VERIFY_COMMAND = 'driver_worker_identity_forwarded';
/** A verified identity is reused this long (and only while the local assignment stamp names the same attempt). */
export const VERIFIED_IDENTITY_TTL_MS = 60_000;

const cache = new Map<string, { identity: DriverWorkerIdentity; expiresAt: number }>();
export function invalidateVerifiedDriverIdentities(sessionId?: string): void {
    if (!sessionId) { cache.clear(); return; }
    for (const key of [...cache.keys()]) if (key.split('\u0000')[1] === sessionId) cache.delete(key);
}

type Ctx = Pick<MedFamilyContext, 'deps' | 'getMeshForCommand'>;

export type DriverIdentityResult = { identity: DriverWorkerIdentity } | { error: string; detail?: string };

export async function resolveDriverWorkerIdentity(ctx: Ctx, args: any, now = Date.now()): Promise<DriverIdentityResult> {
    const local = resolveWorkerIdentity({ token: args?.token, bind: args?.bind });
    if (local) return { identity: local };
    const { resolveRemoteWorker } = await import('../low-family/worker-report.js');
    const remote = await resolveRemoteWorker(ctx as any, args);
    if (!remote) return { error: 'worker_credential_required' };
    const key = [remote.meshId, remote.sessionId, remote.taskId ?? '', remote.attemptId ?? '', remote.generation ?? ''].join('\u0000');
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) return { identity: hit.identity };
    cache.delete(key);
    const dispatch = ctx.deps.dispatchMeshCommand;
    if (!dispatch) return { error: 'worker_credential_required', detail: `task owned by daemon ${remote.ownerDaemonId}; no mesh transport` };
    let answer: any;
    try {
        answer = unwrapMeshRelayResult(await dispatch(remote.ownerDaemonId, DRIVER_IDENTITY_VERIFY_COMMAND, {
            meshId: remote.meshId, sessionId: remote.sessionId,
            ...(remote.taskId ? { taskId: remote.taskId } : {}),
            ...(remote.attemptId ? { attemptId: remote.attemptId } : {}),
            ...(remote.generation !== undefined ? { generation: remote.generation } : {}),
            ...(remote.nodeId ? { nodeId: remote.nodeId } : {}),
        }), { command: DRIVER_IDENTITY_VERIFY_COMMAND, peerDaemonId: remote.ownerDaemonId });
    } catch (e: any) {
        return { error: 'forward_failed', detail: e?.message || String(e) };
    }
    const v = answer?.identity;
    if (!answer?.success || !v?.meshId || !v?.taskId || !v?.sessionId
        || v.meshId !== remote.meshId || v.sessionId !== remote.sessionId) {
        return { error: 'worker_credential_required', detail: typeof answer?.detail === 'string' ? answer.detail : undefined };
    }
    const identity: DriverWorkerIdentity = { meshId: v.meshId, taskId: v.taskId, sessionId: v.sessionId,
        ...(v.attemptId ? { attemptId: v.attemptId } : {}), ...(v.nodeId ? { nodeId: v.nodeId } : {}) };
    cache.set(key, { identity, expiresAt: now + VERIFIED_IDENTITY_TTL_MS });
    return { identity };
}

export const driverIdentityHandlers: Record<string, MedFamilyHandler> = {
    /** Owner side: verify only. Sender must own the assigned node; only a LIVE attempt qualifies. */
    [DRIVER_IDENTITY_VERIFY_COMMAND]: async (ctx, args) => {
        const { decodeForwardedClaim, CLAIM_KEYS, ownerRosterNodeDaemonLookup, selfDaemonPredicate } = await import('../low-family/worker-report.js');
        const decoded = decodeForwardedClaim(args, new Set<string>(CLAIM_KEYS));
        if (!decoded) return { success: false, code: 'invalid_input' };
        const { resolveForwardedWorkerIdentity } = await import('../../mesh/worker-report-forwarded.js');
        const resolved = resolveForwardedWorkerIdentity(decoded.claim, {
            senderDaemonId: readMeshSender(args), nodeDaemonId: await ownerRosterNodeDaemonLookup(ctx as any, decoded.claim.meshId),
        }, Date.now(), selfDaemonPredicate(ctx as any));
        if ('refused' in resolved) return { success: false, code: 'unauthenticated', detail: resolved.refused };
        if (!('live' in resolved) || !resolved.live.attemptId) return { success: false, code: 'binding_missing' };
        const attempt = MeshRuntimeStore.getInstance().turnStore().getAttempt(resolved.live.attemptId);
        if (!attempt || attempt.terminal) return { success: false, code: 'binding_missing' };
        const l = resolved.live;
        return { success: true, identity: { meshId: l.meshId, taskId: l.taskId, attemptId: l.attemptId, generation: attempt.generation,
            sessionId: l.sessionId, ...(l.nodeId ? { nodeId: l.nodeId } : {}) } };
    },
};
