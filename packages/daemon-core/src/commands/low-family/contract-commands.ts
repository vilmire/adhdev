/**
 * Contract versioning (Cut A) — daemon commands.
 *
 *   Worker (credential = the daemon-minted wsb_/wtk_ the worker MCP presents;
 *   no taskId/attempt argument is trusted — the credential resolves them):
 *     worker_contract_read     E2 served-byte receipt + bounded unit bytes
 *     worker_contract_observe  C1 explicit "I read these exact units" claim
 *     worker_contract_current  authoritative head + durable pending notices
 *   Owner (verified owner ingress only — a source label is never a principal):
 *     contract_owner           enroll / grant / revoke_grant / policy / recover / transfer / purge / status
 *   Coordinator (a daemon-minted csb_ capability bound to its session instance):
 *     contract_coordinator     propose / review / accept / close / revoke_revision / bind_mission / revalidate / status
 *   Read-only, content-free:
 *     contract_mission_scope   is a mission strict-bound? (mesh_send_task refuses those — pins need the queue path)
 *
 * MVP limit (stated): the contract authority and its strict workers live on one
 * daemon; a worker whose task another daemon owns is refused
 * `strict_participant_unsupported` rather than forwarded.
 * Every refusal is a content-free code (F10).
 */
import type { LowFamilyContext, LowFamilyHandler } from './types.js';
import { defineCommandSpecs } from '../command-registry.js';
import { isTrustedOwnerIngress } from '../command-args.js';
import { MeshRuntimeStore } from '../../mesh/mesh-runtime-store.js';
import { getContractCtx } from '../../mesh/contract-runtime.js';
import { isContractRefusal, CONTRACT_GRANT_OPS, type ContractGrantOp } from '../../mesh/contract/contract-types.js';
import { issueOwnerPrincipal, issueWorkerPrincipal, type ContractPrincipal, type OwnerPrincipal } from '../../mesh/contract/contract-context.js';
import {
    currentHeadVector, enrollNamespace, getAuthority, mintCoordinatorGrant, recoverAuthority, revokeGrant, transferAuthority, updatePolicy,
    verifyCoordinatorCapability,
} from '../../mesh/contract/contract-authority.js';
import { acceptProposal, closeProposal, proposeRevision, reviewProposal, revokeRevision } from '../../mesh/contract/contract-proposals.js';
import { bindMissionScope, getMissionScope } from '../../mesh/contract/contract-pins.js';
import { contractCurrent, contractObserve, contractRead } from '../../mesh/contract/contract-reads.js';
import { revalidateResult } from '../../mesh/contract/contract-assessment.js';
import { legalPurgeBody } from '../../mesh/contract/contract-retention.js';

const OWNER_SOURCES = ['p2p', 'standalone', 'ws'] as const;

function refused(code: string, extra: Record<string, unknown> = {}) {
    return { success: false, error: code, code, ...extra };
}

function run<T>(fn: () => T): any {
    try {
        return { success: true, ...(fn() as object) };
    } catch (e: any) {
        if (isContractRefusal(e)) return refused(e.code, e.current ? { current: e.current } : {});
        return refused('contract_error');
    }
}

async function resolveWorker(args: any) {
    const { resolveWorkerIdentity, classifyUnresolvedWorkerCredential } = await import('../../mesh/worker-report.js');
    const credential = { token: args?.token, bind: args?.bind };
    const identity = resolveWorkerIdentity(credential);
    if (!identity) return { error: classifyUnresolvedWorkerCredential(credential).refusal } as const;
    if (!identity.attemptId || !identity.sessionId) return { error: 'binding_missing' } as const;
    const attempt = MeshRuntimeStore.getInstance().turnStore().getAttempt(identity.attemptId);
    if (!attempt) return { error: 'binding_missing' } as const;
    return {
        principal: issueWorkerPrincipal({
            meshId: identity.meshId, taskId: identity.taskId, attemptId: identity.attemptId, generation: attempt.generation, sessionId: identity.sessionId,
        }),
    } as const;
}

function ownerFrom(args: any): OwnerPrincipal | null {
    if (isTrustedOwnerIngress(args, 'p2p')) return issueOwnerPrincipal('p2p');
    if (isTrustedOwnerIngress(args, 'standalone')) return issueOwnerPrincipal('standalone');
    return null;
}

const COORDINATOR_ACTION_OPS: Record<string, ContractGrantOp> = {
    propose: 'propose', review: 'review', accept: 'accept', close: 'review', revoke_revision: 'revoke',
    bind_mission: 'assign', revalidate: 'assess', status: 'assess',
};

function statusView(namespaceId: string) {
    const ctx = getContractCtx();
    if (!ctx) return { scoped: false };
    const auth = getAuthority(ctx, namespaceId);
    if (!auth) return refused('not_found');
    return {
        namespaceId,
        meshId: auth.meshId,
        status: auth.status,
        head: currentHeadVector(ctx, namespaceId),
        policy: auth.policy,
        openProposals: (ctx.db.prepare(`SELECT proposal_id, proposal_version, candidate_revision_id, impact, created_at FROM contract_proposals
            WHERE namespace_id = ? AND status = 'open' ORDER BY created_at`).all(namespaceId) as any[]).map(p => ({
                proposalId: p.proposal_id, proposalVersion: p.proposal_version, candidateRevisionId: p.candidate_revision_id, impact: p.impact,
            })),
        budgets: ctx.budgets,
    };
}

export const contractCommandHandlers: Record<string, LowFamilyHandler> = {
    worker_contract_read: async (_ctx: LowFamilyContext, args: any) => {
        const ctx = getContractCtx();
        if (!ctx) return refused('unavailable');
        const w = await resolveWorker(args);
        if ('error' in w) return refused(w.error as string);
        return run(() => contractRead(ctx, w.principal, {
            bindingId: args?.bindingId, unitId: args?.unitId,
            ...(Number.isSafeInteger(args?.rangeStart) ? { rangeStart: args.rangeStart } : {}),
            ...(Number.isSafeInteger(args?.rangeEnd) ? { rangeEnd: args.rangeEnd } : {}),
            ...(typeof args?.requestId === 'string' ? { requestId: args.requestId } : {}),
        }));
    },

    worker_contract_observe: async (_ctx: LowFamilyContext, args: any) => {
        const ctx = getContractCtx();
        if (!ctx) return refused('unavailable');
        const w = await resolveWorker(args);
        if ('error' in w) return refused(w.error as string);
        return run(() => contractObserve(ctx, w.principal, { bindingId: args?.bindingId, units: Array.isArray(args?.units) ? args.units : [] }));
    },

    worker_contract_current: async (_ctx: LowFamilyContext, args: any) => {
        const ctx = getContractCtx();
        if (!ctx) return refused('unavailable');
        const w = await resolveWorker(args);
        if ('error' in w) return refused(w.error as string);
        return run(() => contractCurrent(ctx, w.principal));
    },

    contract_owner: async (_ctx: LowFamilyContext, args: any) => {
        const owner = ownerFrom(args);
        if (!owner) return refused('not_owner');
        const ctx = getContractCtx();
        if (!ctx) return refused('unavailable');
        const a = args ?? {};
        switch (a.action) {
            case 'enroll':
                return run(() => enrollNamespace(ctx, owner, { meshId: a.meshId, repositories: Array.isArray(a.repositories) ? a.repositories : [], ...(a.policy ? { policy: a.policy } : {}) }));
            case 'grant':
                return run(() => mintCoordinatorGrant(ctx, owner, {
                    namespaceId: a.namespaceId, coordinatorSessionId: a.coordinatorSessionId,
                    ops: (Array.isArray(a.ops) ? a.ops : []).filter((o: unknown): o is ContractGrantOp => (CONTRACT_GRANT_OPS as readonly unknown[]).includes(o)),
                    ...(a.maxImpact === 'breaking' ? { maxImpact: 'breaking' as const } : {}),
                    ...(Number.isSafeInteger(a.ttlMs) ? { ttlMs: a.ttlMs } : {}),
                    ...(a.overlapPrevious === true ? { overlapPrevious: true } : {}),
                }));
            case 'revoke_grant':
                return run(() => ({ revoked: revokeGrant(ctx, owner, String(a.grantId || ''), 'owner_revoked') }));
            case 'policy':
                return run(() => ({ vector: updatePolicy(ctx, owner, a.namespaceId, a.policy ?? {}) }));
            case 'recover':
                return run(() => ({ vector: recoverAuthority(ctx, owner, a.namespaceId) }));
            case 'transfer':
                return run(() => ({ authority: transferAuthority(ctx, owner, { namespaceId: a.namespaceId, newDaemonId: a.newDaemonId, oldWriterFenced: a.oldWriterFenced === true }) }));
            case 'purge':
                return run(() => ({ purged: legalPurgeBody(ctx, owner, a.digest, a.reason === 'privacy' || a.reason === 'owner_request' ? a.reason : 'legal') }));
            case 'accept':
                return run(() => acceptProposal(ctx, owner, { proposalId: a.proposalId, proposalVersion: a.proposalVersion, expectedHead: a.expectedHead, idempotencyKey: a.idempotencyKey }));
            case 'revalidate':
                return run(() => revalidateResult(ctx, owner, a));
            case 'status':
                return run(() => statusView(a.namespaceId));
            default:
                return refused('invalid_input');
        }
    },

    contract_coordinator: async (_ctx: LowFamilyContext, args: any) => {
        const ctx = getContractCtx();
        if (!ctx) return refused('unavailable');
        const a = args ?? {};
        const op = COORDINATOR_ACTION_OPS[a.action];
        if (!op) return refused('invalid_input');
        let principal: ContractPrincipal;
        try {
            principal = verifyCoordinatorCapability(ctx, a.capability, { namespaceId: a.namespaceId, sessionId: a.coordinatorSessionId, op });
        } catch (e: any) {
            return refused(isContractRefusal(e) ? e.code : 'unauthenticated');
        }
        switch (a.action) {
            case 'propose':
                return run(() => proposeRevision(ctx, principal, { namespaceId: a.namespaceId, baseHead: a.baseHead, impact: a.impact, units: Array.isArray(a.units) ? a.units : [], ...(a.proposalId ? { proposalId: a.proposalId } : {}) }));
            case 'review':
                return run(() => reviewProposal(ctx, principal, a));
            case 'accept':
                return run(() => acceptProposal(ctx, principal, { proposalId: a.proposalId, proposalVersion: a.proposalVersion, expectedHead: a.expectedHead, idempotencyKey: a.idempotencyKey }));
            case 'close':
                return run(() => { closeProposal(ctx, principal, a); return {}; });
            case 'revoke_revision':
                return run(() => ({ vector: revokeRevision(ctx, principal, { namespaceId: a.namespaceId, revisionId: a.revisionId }) }));
            case 'bind_mission':
                return run(() => { bindMissionScope(ctx, principal, { meshId: a.meshId, missionId: a.missionId, namespaceId: a.namespaceId, units: a.units, mode: a.mode === 'advisory' ? 'advisory' : 'strict' }); return {}; });
            case 'revalidate':
                return run(() => revalidateResult(ctx, principal, a));
            case 'status':
                return run(() => statusView(a.namespaceId));
            default:
                return refused('invalid_input');
        }
    },

    contract_mission_scope: async (_ctx: LowFamilyContext, args: any) => {
        const ctx = getContractCtx();
        if (!ctx) return { success: true, strict: false };
        try {
            const scope = getMissionScope(ctx, String(args?.meshId || ''), String(args?.missionId || ''));
            return { success: true, strict: scope?.mode === 'strict', advisory: scope?.mode === 'advisory' };
        } catch {
            return { success: true, strict: false };
        }
    },
};

export const contractCommandSpecs = defineCommandSpecs('low', contractCommandHandlers, {
    contract_owner: { sources: [...OWNER_SOURCES] },
    worker_contract_read: { sources: ['ipc', 'standalone'] },
    worker_contract_observe: { sources: ['ipc', 'standalone'] },
    worker_contract_current: { sources: ['ipc', 'standalone'] },
    contract_coordinator: { sources: ['ipc', 'standalone', 'p2p', 'ws'] },
    contract_mission_scope: { sources: ['ipc', 'standalone', 'p2p', 'ws'] },
});
