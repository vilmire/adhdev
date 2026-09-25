/**
 * mesh-graph-gate-commands — the dashboard-callable gate verbs
 * (docs/design/2026-09-25-graph-orchestration-simplification.md D3(c)).
 *
 *   mesh_graph_gate_claim   {mesh_id, gate_id, deadline_seconds?}
 *   mesh_graph_gate_release {mesh_id, gate_id, outcome, evidence?, release_idempotency_key?}
 *   mesh_graph_gate_abandon {mesh_id, gate_id, reason}
 *   mesh_graph_gate_extend  {mesh_id, gate_id, extend_seconds}
 *
 * Every verb delegates to the SAME engine the coordinator's MCP tools reach
 * through the `graph_gate_*` IPC responders (mesh-graph-ipc.ts) — there is no
 * second gate implementation here, only argument mapping and the operator
 * convenience of a one-step release (below). Those IPC responders keep their
 * strict mesh-shared wire contract (camelCase, fencing token required); these
 * are the snake_case, human-operator shapes.
 *
 * ★ Sources = ipc · standalone · p2p — the owner's local and P2P transports.
 * Never `mesh` (a peer daemon must not operate this daemon's gates), never
 * `ws`/`api`/`ext`. Owner authorization on p2p is enforced by the cloud
 * daemon's share-permission gate (`canPeerUsePrivilegedShareCommand` refuses
 * every non-allow-listed command for a share peer; only the owner's own
 * connection carries no share permission). Standalone is the local owner.
 *
 * ★ ONE-STEP RELEASE. A human has no fencing token. `mesh_graph_gate_release`
 * therefore claims the gate as the operator (unless the operator already holds
 * a live lease on it) and releases with that fresh fence. A LIVE foreign lease
 * is refused (`gate_lease_held`) — the coordinator holding it may be mid-action.
 * The default idempotency key is per gate (`operator_release:<gateId>`), so a
 * retried click with the same outcome/evidence replays as a duplicate success
 * and a DIFFERENT outcome is a conflict, never a second release. Elapsed time is
 * still never evidence: release is always an explicit act with an outcome.
 */
import type { MedFamilyContext, MedFamilyHandler } from './types.js';
import type { CommandSource } from '../command-registry.js';
import { defineCommandSpecs } from '../command-registry.js';
import {
    abandonMeshGraphGate,
    claimMeshGraphGate,
    extendMeshGraphGateDeadline,
    releaseMeshGraphGate,
} from '../../mesh/mesh-graph-gates.js';
import { MeshRuntimeStore } from '../../mesh/mesh-runtime-store.js';
import {
    recordGraphGateAbandoned,
    recordGraphGateClaimed,
    recordGraphGateReleased,
} from '../../mesh/mesh-graph-provenance.js';

/** The transports these verbs accept — see the file header. */
export const MESH_GRAPH_GATE_COMMAND_SOURCES: readonly CommandSource[] = ['ipc', 'standalone', 'p2p'];

/** The synthetic lease owner a dashboard/operator action is attributed to. */
export const MESH_GATE_OPERATOR_SESSION_ID = 'dashboard_operator';

function readString(args: any, snake: string, camel: string): string | undefined {
    const value = args?.[snake] ?? args?.[camel];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(args: any, snake: string, camel: string): number | undefined {
    const value = args?.[snake] ?? args?.[camel];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function actorOf(args: any): string {
    return readString(args, 'coordinator_session_id', 'coordinatorSessionId') ?? MESH_GATE_OPERATOR_SESSION_ID;
}

function refusal(code: string, error: string, extra: Record<string, unknown> = {}) {
    return { success: false as const, code, error, ...extra };
}

/** Machine-readable code prefix convention shared with the engine's throws. */
function extractErrorCode(message: string): string {
    const match = /^([a-z0-9_]+):/.exec(message);
    return match ? match[1] : 'gate_operation_failed';
}

function requireIds(args: any): { meshId: string; gateId: string } | null {
    const meshId = readString(args, 'mesh_id', 'meshId');
    const gateId = readString(args, 'gate_id', 'gateId');
    return meshId && gateId ? { meshId, gateId } : null;
}

export const meshGraphGateCommandHandlers: Record<string, MedFamilyHandler> = {
    mesh_graph_gate_claim: async (_ctx: MedFamilyContext, args: any) => {
        const ids = requireIds(args);
        if (!ids) return refusal('bad_request', 'mesh_id and gate_id are required');
        const deadlineSeconds = readNumber(args, 'deadline_seconds', 'deadlineSeconds');
        const actor = actorOf(args);
        try {
            const result = claimMeshGraphGate({
                ...ids,
                coordinatorSessionId: actor,
                ...(deadlineSeconds !== undefined && deadlineSeconds > 0 ? { extendDeadlineSeconds: deadlineSeconds } : {}),
            });
            if (!result.claimed) {
                return refusal(result.reason ?? 'gate_not_claimable', `gate not claimable (${result.reason ?? 'unknown'})`, {
                    claimed: false,
                    ...(result.gate ? { gateState: result.gate.state } : {}),
                });
            }
            try {
                recordGraphGateClaimed(ids.meshId, {
                    graphId: result.gate!.graphId, gateId: ids.gateId, ref: result.gate!.ref,
                    action: result.gate!.action, generation: result.leaseGeneration!, ownerSessionId: actor,
                    leaseExpiresAt: result.leaseExpiresAt, ambiguousExternalOutcome: result.ambiguousExternalOutcome,
                    previousLeaseOwnerSessionId: result.previousLeaseOwnerSessionId,
                });
            } catch { /* audit is best-effort */ }
            return {
                success: true,
                claimed: true,
                gateId: ids.gateId,
                graphId: result.gate!.graphId,
                action: result.gate!.action,
                leaseGeneration: result.leaseGeneration,
                fencingToken: result.fencingToken,
                leaseExpiresAt: result.leaseExpiresAt,
                ...(result.deadlineAt ? { deadlineAt: result.deadlineAt } : {}),
                ...(result.ambiguousExternalOutcome ? { ambiguousExternalOutcome: true } : {}),
            };
        } catch (e: any) {
            const message = String(e?.message || e);
            return refusal(extractErrorCode(message), message);
        }
    },

    mesh_graph_gate_release: async (_ctx: MedFamilyContext, args: any) => {
        const ids = requireIds(args);
        const outcome = readString(args, 'outcome', 'outcome');
        if (!ids || !outcome) return refusal('bad_request', 'mesh_id, gate_id and outcome are required');
        const actor = actorOf(args);
        const idempotencyKey = readString(args, 'release_idempotency_key', 'releaseIdempotencyKey')
            ?? `operator_release:${ids.gateId}`;
        const rawEvidence = args?.evidence;
        const evidence = typeof rawEvidence === 'string'
            ? (rawEvidence.trim() ? { note: rawEvidence.trim() } : undefined)
            : (rawEvidence && typeof rawEvidence === 'object' ? rawEvidence : undefined);
        try {
            const gate = MeshRuntimeStore.getInstance().graphStore().getGate(ids.gateId);
            if (!gate || gate.meshId !== ids.meshId) return refusal('gate_not_found', `no gate '${ids.gateId}'`, { released: false });

            let fence: { leaseGeneration: number; fencingToken: string } | null = null;
            const nowIso = new Date().toISOString();
            if (gate.state === 'released' && gate.fencingToken) {
                // Replay path: the engine answers duplicate (same key+digest) or conflict.
                fence = { leaseGeneration: gate.leaseGeneration, fencingToken: gate.fencingToken };
            } else if (gate.state === 'claimed' && gate.leaseOwnerSessionId === actor && gate.fencingToken
                && gate.leaseExpiresAt && gate.leaseExpiresAt > nowIso) {
                fence = { leaseGeneration: gate.leaseGeneration, fencingToken: gate.fencingToken };
            } else {
                const claim = claimMeshGraphGate({ ...ids, coordinatorSessionId: actor });
                if (!claim.claimed) {
                    return refusal(claim.reason ?? 'gate_not_claimable', `gate not releasable (${claim.reason ?? 'unknown'})`, {
                        released: false,
                        ...(claim.gate ? { gateState: claim.gate.state } : {}),
                    });
                }
                fence = { leaseGeneration: claim.leaseGeneration!, fencingToken: claim.fencingToken! };
            }
            const result = releaseMeshGraphGate({
                ...ids,
                ...fence,
                idempotencyKey,
                outcome,
                ...(evidence !== undefined ? { evidence } : {}),
            });
            try {
                recordGraphGateReleased(ids.meshId, {
                    graphId: result.gate!.graphId, gateId: ids.gateId, ref: result.gate!.ref,
                    action: result.gate!.action, outcome, generation: fence.leaseGeneration,
                    releaseDigest: result.gate!.releaseEvidenceDigest,
                    materializedNodeIds: result.materializedNodeIds, duplicate: result.duplicate,
                });
            } catch { /* audit is best-effort */ }
            return {
                success: true,
                released: true,
                duplicate: result.duplicate,
                gateId: ids.gateId,
                materializedNodeIds: result.materializedNodeIds,
                ...(result.downstreamNodeCount !== undefined ? { downstreamNodeCount: result.downstreamNodeCount } : {}),
                ...(result.graphCompleted !== undefined ? { graphCompleted: result.graphCompleted } : {}),
            };
        } catch (e: any) {
            const message = String(e?.message || e);
            return refusal(extractErrorCode(message), message, { released: false });
        }
    },

    mesh_graph_gate_abandon: async (_ctx: MedFamilyContext, args: any) => {
        const ids = requireIds(args);
        const reason = readString(args, 'reason', 'reason');
        if (!ids || !reason) return refusal('bad_request', 'mesh_id, gate_id and reason are required');
        const actor = actorOf(args);
        try {
            const result = abandonMeshGraphGate({
                ...ids,
                reason,
                coordinatorSessionId: actor,
                ...(args?.force === true ? { force: true } : {}),
            });
            if (!result.abandoned) {
                return refusal(result.reason ?? 'gate_not_abandonable', `gate not abandonable (${result.reason ?? 'unknown'})`, {
                    abandoned: false,
                    ...(result.gate ? { gateState: result.gate.state } : {}),
                });
            }
            const duplicate = result.reason === 'gate_already_abandoned';
            if (!duplicate) {
                try {
                    recordGraphGateAbandoned(ids.meshId, {
                        graphId: result.gate!.graphId, gateId: ids.gateId, ref: result.gate!.ref,
                        action: result.gate!.action, priorState: result.gate!.state, reason,
                        coordinatorSessionId: actor, ...(args?.force === true ? { force: true } : {}),
                        cancelledNodeIds: result.cancelledNodeIds,
                        ...(result.graphStatus ? { graphStatus: result.graphStatus } : {}),
                    });
                } catch { /* audit is best-effort */ }
            }
            return {
                success: true,
                abandoned: true,
                ...(duplicate ? { duplicate: true } : {}),
                gateId: ids.gateId,
                cancelledNodeIds: result.cancelledNodeIds,
                cancelledTaskIds: result.cancelledTaskIds,
                ...(result.graphStatus ? { graphStatus: result.graphStatus } : {}),
            };
        } catch (e: any) {
            const message = String(e?.message || e);
            return refusal(extractErrorCode(message), message, { abandoned: false });
        }
    },

    mesh_graph_gate_extend: async (_ctx: MedFamilyContext, args: any) => {
        const ids = requireIds(args);
        const extendSeconds = readNumber(args, 'extend_seconds', 'extendSeconds');
        if (!ids || extendSeconds === undefined) return refusal('bad_request', 'mesh_id, gate_id and extend_seconds are required');
        try {
            const result = extendMeshGraphGateDeadline({ ...ids, extendSeconds, actorSessionId: actorOf(args) });
            if (!result.extended) {
                return refusal(result.reason ?? 'gate_not_extendable', `gate not extendable (${result.reason ?? 'unknown'})`, {
                    extended: false,
                    ...(result.gate ? { gateState: result.gate.state } : {}),
                });
            }
            return {
                success: true,
                extended: true,
                gateId: ids.gateId,
                gateState: result.gate!.state,
                deadlineAt: result.deadlineAt,
                ...(result.previousDeadlineAt ? { previousDeadlineAt: result.previousDeadlineAt } : {}),
                ...(result.reopened ? { reopened: true } : {}),
            };
        } catch (e: any) {
            const message = String(e?.message || e);
            return refusal(extractErrorCode(message), message, { extended: false });
        }
    },
};

export const meshGraphGateCommandSpecs = defineCommandSpecs(
    'med',
    meshGraphGateCommandHandlers,
    {},
    { sources: MESH_GRAPH_GATE_COMMAND_SOURCES },
);
