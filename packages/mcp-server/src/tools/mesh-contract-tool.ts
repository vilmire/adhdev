/**
 * `mesh_contract` — the coordinator's contract-versioning (Cut A) surface.
 *
 * Published ONLY when this coordinator's MCP env carries a daemon-minted
 * contract capability (`ADHDEV_CONTRACT_CAPABILITY`, `csb_…`, issued by the
 * owner through `contract_owner grant` for this coordinator session). Without
 * it the ListTools response is byte-identical to before, and the daemon would
 * refuse the call anyway: authority comes from the capability the DAEMON
 * verifies (bound to namespace + this coordinator session instance), never
 * from `ADHDEV_COORDINATOR_SESSION_ID` or a claimed role.
 *
 * The capability is forwarded to the daemon only; it is never echoed.
 */
import type { MeshContext } from './mesh-tools-internal.js';

export const CONTRACT_CAPABILITY_ENV = 'ADHDEV_CONTRACT_CAPABILITY';

export function readContractCapability(env: NodeJS.ProcessEnv = process.env): string | null {
    const v = typeof env[CONTRACT_CAPABILITY_ENV] === 'string' ? env[CONTRACT_CAPABILITY_ENV]!.trim() : '';
    return v.startsWith('csb_') ? v : null;
}

const HEAD = {
    type: 'object',
    description: 'Expected contract head: { authorityEpoch, headGeneration, revisionId, policyRevision } exactly as `status` returned it.',
};

export const MESH_CONTRACT_TOOL = {
    name: 'mesh_contract',
    description: 'Contract versioning (strict pilot). Actions: `status` (current head/proposals), `propose` (a new revision from '
        + 'committed repository blobs), `review` (independent approve/reject of an exact candidate), `accept` (CAS on the expected '
        + 'head; breaking changes need the owner), `close` (reject/withdraw), `revoke_revision`, `bind_mission` (NEW tasks enqueued '
        + 'into the mission are pinned to exact accepted units; enqueue them with mesh_enqueue_task), `revalidate` (assess one exact '
        + 'held result for one purpose against the current head). Every refusal is a content-free code.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            action: { type: 'string', enum: ['status', 'propose', 'review', 'accept', 'close', 'revoke_revision', 'bind_mission', 'revalidate'] },
            namespace_id: { type: 'string', description: 'Contract namespace your capability is bound to.' },
            base_head: { ...HEAD },
            expected_head: { ...HEAD },
            impact: { type: 'string', enum: ['nonbreaking', 'breaking'] },
            units: {
                type: 'array',
                description: 'propose: [{ unitId, source: { repoBindingId, commitOid, gitlinks?: [{ path, childRepoBindingId }], path }, roles?, dependsOn?, mediaType?, normativeType?, applicationApiVersion? }] or [{ unitId, carryForward: true }]. bind_mission: unit ids (empty = all).',
                items: {},
            },
            proposal_id: { type: 'string' },
            proposal_version: { type: 'integer' },
            candidate_revision_id: { type: 'string' },
            verdict: { type: 'string', enum: ['approve', 'reject'] },
            rationale: { type: 'string' },
            idempotency_key: { type: 'string', description: 'accept: 8–128 chars; retries with the same key and request replay one result.' },
            status: { type: 'string', enum: ['rejected', 'withdrawn'] },
            revision_id: { type: 'string' },
            mission_id: { type: 'string' },
            mode: { type: 'string', enum: ['strict', 'advisory'] },
            result_key: { type: 'string' },
            purpose: { type: 'string', enum: ['dependency', 'handoff', 'context', 'integration_admission', 'integration_landing', 'mission_close'] },
            expected_vector: { type: 'object', description: 'revalidate: the full current vector from `status`.' },
            decision: { type: 'string', enum: ['compatible', 'waiver'] },
            reason: { type: 'string' },
            expires_at: { type: 'integer', description: 'waiver: epoch ms, within the policy maximum.' },
        },
        required: ['action', 'namespace_id'],
    },
};

export async function meshContract(ctx: MeshContext, args: Record<string, any>): Promise<string> {
    const capability = readContractCapability();
    if (!capability) return JSON.stringify({ success: false, code: 'capability_invalid', error: 'no contract capability configured for this coordinator' });
    const result = await ctx.transport.command('contract_coordinator', {
        action: args.action,
        namespaceId: args.namespace_id,
        capability,
        coordinatorSessionId: ctx.coordinatorSessionId ?? '',
        meshId: ctx.mesh.id,
        ...(args.base_head !== undefined ? { baseHead: args.base_head } : {}),
        ...(args.expected_head !== undefined ? { expectedHead: args.expected_head } : {}),
        ...(args.impact !== undefined ? { impact: args.impact } : {}),
        ...(args.units !== undefined ? { units: args.units } : {}),
        ...(args.proposal_id !== undefined ? { proposalId: args.proposal_id } : {}),
        ...(args.proposal_version !== undefined ? { proposalVersion: args.proposal_version } : {}),
        ...(args.candidate_revision_id !== undefined ? { candidateRevisionId: args.candidate_revision_id } : {}),
        ...(args.verdict !== undefined ? { verdict: args.verdict } : {}),
        ...(args.rationale !== undefined ? { rationale: args.rationale } : {}),
        ...(args.idempotency_key !== undefined ? { idempotencyKey: args.idempotency_key } : {}),
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.revision_id !== undefined ? { revisionId: args.revision_id } : {}),
        ...(args.mission_id !== undefined ? { missionId: args.mission_id } : {}),
        ...(args.mode !== undefined ? { mode: args.mode } : {}),
        ...(args.result_key !== undefined ? { resultKey: args.result_key } : {}),
        ...(args.purpose !== undefined ? { purpose: args.purpose } : {}),
        ...(args.expected_vector !== undefined ? { expectedVector: args.expected_vector } : {}),
        ...(args.decision !== undefined ? { decision: args.decision } : {}),
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
        ...(args.expires_at !== undefined ? { expiresAt: args.expires_at } : {}),
    }).catch((e: any) => ({ success: false, code: 'unavailable', error: String(e?.message || e) }));
    return JSON.stringify(result);
}
