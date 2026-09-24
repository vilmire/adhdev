/**
 * mesh-graph-ipc — daemon-side responders for the graph-orchestration,
 * task/mission-stats, prune-audit and orphaned-pin IPC commands through which
 * the mcp-server reaches this daemon's `mesh-runtime.db` instead of opening
 * it in-process.
 *
 * Wiring-unification Phase C, workstream C-W9c (2026-09-24 19:00 stamp — the
 * last mcp-server in-process daemon-core paths: "graph gates/plan/patch,
 * mission reads (MAGI), task/mission stats, orphaned-pin helpers and one
 * prune audit"). Sibling of `mesh-store-ipc.ts` (C-W9a/b); same envelope and
 * registration convention — merged into `turnLedgerIpcHandlers`
 * (turn-ledger-ipc.ts) rather than adding a new router import.
 *
 * Wire contract: `@adhdev/mesh-shared` `turn-ipc.ts`. `mesh_graph_gate_release`
 * and `mesh_graph_node_patch`'s cores THROW for every rejection (the whole
 * transaction must roll back) — this file catches that and reports it as a
 * RESULT (`released: false` / `patched: false` + `refusalCode`), the same
 * success:true-carries-a-refusal shape `queue_enqueue_graph` (mesh-store-ipc.ts)
 * already uses, so a domain refusal never has to travel through the IPC
 * envelope's restricted `code` (TURN_IPC_ERROR_CODES only covers
 * daemon_required/turn_ledger_unavailable/ledger_not_owner).
 */

import {
    decodeGraphGateAbandonRequest,
    decodeGraphGateClaimRequest,
    decodeGraphGateReleaseRequest,
    decodeGraphNodePatchRequest,
    decodeGraphViewQueryRequest,
    decodeOrphanedPinNotifyRequest,
    decodePruneStaleDirectRequest,
    decodeTaskStatsQueryRequest,
    type GraphGateAbandonResponse,
    type GraphGateClaimResponse,
    type GraphGateReleaseResponse,
    type GraphNodePatchResponse,
    type GraphViewQueryResponse,
    type OrphanedPinNotifyResponse,
    type PruneStaleDirectResponse,
    type TaskStatsQueryResponse,
} from '@adhdev/mesh-shared';
import type { LowFamilyContext, LowFamilyHandler } from './types.js';
import {
    abandonMeshGraphGate,
    claimMeshGraphGate,
    releaseMeshGraphGate,
} from '../../mesh/mesh-graph-gates.js';
import { collectGateConvergenceEvidence } from '../../mesh/mesh-graph-gate-evidence.js';
import { patchGraphNodeAndRetry, MESH_NODE_PATCH_KEYS } from '../../mesh/mesh-graph-transition-runner.js';
import { buildMeshGraphViews } from '../../mesh/mesh-graph-view.js';
import {
    recordGraphGateAbandoned,
    recordGraphGateClaimed,
    recordGraphGateReleased,
    recordGraphNodePatched,
} from '../../mesh/mesh-graph-provenance.js';
import { computeMeshMissionStats, computeMeshTaskStats } from '../../mesh/mesh-task-stats.js';
import { pruneStaleDirectDispatches } from '../../mesh/mesh-active-work.js';
import { getActiveDirectDispatches, getQueue } from '../../mesh/mesh-work-queue.js';
import { readLocalRecords } from '../../mesh/mesh-local-records.js';
import { notifyCoordinatorOfOrphanedPins } from '../../mesh/mesh-orphaned-pin-notify.js';
import { triggerMeshQueue } from '../../mesh/mesh-queue-assignment.js';
import { LOG } from '../../logging/logger.js';

function badRequest(command: string): { success: false; error: string } {
    return { success: false, error: `${command}: request failed decode (bad shape)` };
}

function failure(e: unknown): { success: false; error: string } {
    return { success: false, error: (e as any)?.message ?? String(e) };
}

/**
 * Rejection codes `releaseMeshGraphGate` / `abandonMeshGraphGate` throw or return,
 * matched by prefix — the SAME classification `mesh-tools-graph.ts` used to run
 * in-process, now run here so the wire's `refusalCode` carries the identical
 * vocabulary the tool layer already documents to callers.
 */
const GATE_RELEASE_ERROR_CODES = [
    'gate_not_found', 'gate_release_conflict', 'gate_already_released', 'gate_not_claimed',
    'stale_fence', 'gate_lease_expired', 'gate_upstream_unsettled', 'gate_patch_not_downstream',
    'gate_patch_forbidden', 'task_already_claimed', 'graph_node_not_found',
] as const;

function classifyGateError(message: string): string | undefined {
    return GATE_RELEASE_ERROR_CODES.find((code) => message.startsWith(`${code}:`) || message.includes(`${code}:`));
}

const NODE_PATCH_ERROR_CODES = [
    'graph_node_not_found', 'graph_not_found', 'ambiguous_node_ref', 'node_not_patchable',
    'node_patch_forbidden', 'task_already_claimed',
] as const;

function classifyNodePatchError(e: unknown, message: string): string | undefined {
    // A rejected replacement binding is a MeshMaterializationError, whose message
    // carries NO code prefix — it exposes the code as a field instead.
    const code = (e as { code?: unknown } | undefined)?.code;
    if (typeof code === 'string' && code) return code;
    return NODE_PATCH_ERROR_CODES.find((c) => message.startsWith(`${c}:`) || message.includes(`${c}:`));
}

/** Best-effort queue nudge after a release/patch materializes downstream work — never fails the call. */
async function triggerQueueBestEffort(ctx: LowFamilyContext, meshId: string): Promise<void> {
    try {
        await triggerMeshQueue(ctx.components(), meshId);
    } catch (e: any) {
        LOG.warn('MeshGraphIpc', `post-release/patch queue trigger failed for mesh ${meshId}: ${e?.message ?? String(e)}`);
    }
}

// ─── graph_gate_claim ───────────────────────────────────────────────────────

const graphGateClaim: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeGraphGateClaimRequest(args);
    if (!req) return badRequest('graph_gate_claim');
    try {
        const result = claimMeshGraphGate({
            meshId: req.meshId,
            gateId: req.gateId,
            coordinatorSessionId: req.coordinatorSessionId,
            ...(req.leaseSeconds !== undefined ? { leaseSeconds: req.leaseSeconds } : {}),
            ...(req.extendDeadlineSeconds !== undefined ? { extendDeadlineSeconds: req.extendDeadlineSeconds } : {}),
        });
        if (!result.claimed) {
            const response: GraphGateClaimResponse = {
                claimed: false,
                ...(result.reason ? { reason: result.reason } : {}),
                ...(result.gate ? { gate: result.gate as unknown as Record<string, unknown> } : {}),
            };
            return { success: true, ...response };
        }
        try {
            recordGraphGateClaimed(req.meshId, {
                graphId: result.gate!.graphId,
                gateId: req.gateId,
                ref: result.gate!.ref,
                action: result.gate!.action,
                generation: result.leaseGeneration!,
                ownerSessionId: req.coordinatorSessionId,
                leaseExpiresAt: result.leaseExpiresAt,
                ambiguousExternalOutcome: result.ambiguousExternalOutcome,
                previousLeaseOwnerSessionId: result.previousLeaseOwnerSessionId,
            });
        } catch { /* audit is best-effort — never break the claim */ }
        let convergenceEvidence: Record<string, unknown> | undefined;
        if (req.probeConvergenceEvidence) {
            try {
                const evidence = await collectGateConvergenceEvidence(req.meshId, req.gateId);
                if (evidence) convergenceEvidence = evidence as unknown as Record<string, unknown>;
            } catch { /* evidence is an enhancement — a probe fault never fails the claim */ }
        }
        const response: GraphGateClaimResponse = {
            claimed: true,
            gate: result.gate as unknown as Record<string, unknown>,
            leaseGeneration: result.leaseGeneration,
            fencingToken: result.fencingToken,
            leaseExpiresAt: result.leaseExpiresAt,
            ...(result.deadlineAt ? { deadlineAt: result.deadlineAt } : {}),
            ...(result.ambiguousExternalOutcome ? { ambiguousExternalOutcome: true, previousLeaseOwnerSessionId: result.previousLeaseOwnerSessionId } : {}),
            ...(convergenceEvidence ? { convergenceEvidence } : {}),
        };
        return { success: true, ...response };
    } catch (e: any) {
        return failure(e);
    }
};

// ─── graph_gate_release ─────────────────────────────────────────────────────

const graphGateRelease: LowFamilyHandler = async (ctx: LowFamilyContext, args: any) => {
    const req = decodeGraphGateReleaseRequest(args);
    if (!req) return badRequest('graph_gate_release');
    try {
        const result = releaseMeshGraphGate({
            meshId: req.meshId,
            gateId: req.gateId,
            fencingToken: req.fencingToken,
            leaseGeneration: req.leaseGeneration,
            idempotencyKey: req.idempotencyKey,
            outcome: req.outcome,
            ...(req.result !== undefined ? { result: req.result } : {}),
            ...(req.evidence !== undefined ? { evidence: req.evidence } : {}),
            ...(req.patches && req.patches.length > 0 ? { patches: req.patches.map((p) => ({ node: p.node, baseSpecPatch: p.baseSpecPatch })) } : {}),
        });
        try {
            recordGraphGateReleased(req.meshId, {
                graphId: result.gate!.graphId,
                gateId: req.gateId,
                ref: result.gate!.ref,
                action: result.gate!.action,
                outcome: req.outcome,
                generation: req.leaseGeneration,
                releaseDigest: result.gate!.releaseEvidenceDigest,
                materializedNodeIds: result.materializedNodeIds,
                duplicate: result.duplicate,
            });
        } catch { /* audit is best-effort — never break the release */ }
        if (result.materializedNodeIds.length > 0) await triggerQueueBestEffort(ctx, req.meshId);
        const response: GraphGateReleaseResponse = {
            released: true,
            duplicate: result.duplicate,
            ...(result.gate ? { gate: result.gate as unknown as Record<string, unknown> } : {}),
            materializedNodeIds: result.materializedNodeIds,
            ...(result.downstreamNodeCount !== undefined ? { downstreamNodeCount: result.downstreamNodeCount } : {}),
            ...(result.graphCompleted !== undefined ? { graphCompleted: result.graphCompleted } : {}),
        };
        return { success: true, ...response };
    } catch (e: any) {
        const message = e?.message || String(e);
        const response: GraphGateReleaseResponse = { released: false, message, ...(classifyGateError(message) ? { refusalCode: classifyGateError(message) } : {}) };
        return { success: true, ...response };
    }
};

// ─── graph_gate_abandon ─────────────────────────────────────────────────────

const graphGateAbandon: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeGraphGateAbandonRequest(args);
    if (!req) return badRequest('graph_gate_abandon');
    try {
        const result = abandonMeshGraphGate({
            meshId: req.meshId,
            gateId: req.gateId,
            reason: req.reason,
            ...(req.coordinatorSessionId ? { coordinatorSessionId: req.coordinatorSessionId } : {}),
            ...(req.force === true ? { force: true } : {}),
        });
        if (!result.abandoned) {
            const response: GraphGateAbandonResponse = {
                abandoned: false,
                ...(result.reason ? { reason: result.reason } : {}),
                ...(result.gate ? { gate: result.gate as unknown as Record<string, unknown> } : {}),
                cancelledNodeIds: [],
                cancelledTaskIds: [],
            };
            return { success: true, ...response };
        }
        const duplicate = result.reason === 'gate_already_abandoned';
        if (!duplicate) {
            try {
                recordGraphGateAbandoned(req.meshId, {
                    graphId: result.gate!.graphId,
                    gateId: req.gateId,
                    ref: result.gate!.ref,
                    action: result.gate!.action,
                    priorState: result.gate!.state,
                    reason: req.reason,
                    ...(req.coordinatorSessionId ? { coordinatorSessionId: req.coordinatorSessionId } : {}),
                    ...(req.force === true ? { force: true } : {}),
                    cancelledNodeIds: result.cancelledNodeIds,
                    ...(result.graphStatus ? { graphStatus: result.graphStatus } : {}),
                });
            } catch { /* audit is best-effort — never break the abandon */ }
        }
        const response: GraphGateAbandonResponse = {
            abandoned: true,
            ...(duplicate ? { reason: result.reason } : {}),
            gate: result.gate as unknown as Record<string, unknown>,
            cancelledNodeIds: result.cancelledNodeIds,
            cancelledTaskIds: result.cancelledTaskIds,
            ...(result.graphStatus ? { graphStatus: result.graphStatus } : {}),
        };
        return { success: true, ...response };
    } catch (e: any) {
        return failure(e);
    }
};

// ─── graph_node_patch ───────────────────────────────────────────────────────

const graphNodePatch: LowFamilyHandler = async (ctx: LowFamilyContext, args: any) => {
    const req = decodeGraphNodePatchRequest(args);
    if (!req) return badRequest('graph_node_patch');
    try {
        const result = patchGraphNodeAndRetry({
            meshId: req.meshId,
            node: req.node,
            ...(req.graphId ? { graphId: req.graphId } : {}),
            baseSpecPatch: req.baseSpecPatch,
        });
        const recovered = result.outcome.kind === 'materialized';
        try {
            recordGraphNodePatched(req.meshId, {
                graphId: result.graphId,
                nodeId: result.nodeId,
                ...(result.ref ? { ref: result.ref } : {}),
                ...(result.queueTaskId ? { queueTaskId: result.queueTaskId } : {}),
                patchedKeys: Object.keys(req.baseSpecPatch),
                outcome: result.outcome.kind,
                state: result.state,
                ...(result.blockedReason ? { blockedReason: result.blockedReason } : {}),
                materializationVersion: result.materializationVersion,
            });
        } catch { /* audit is best-effort — never break the patch */ }
        if (recovered) await triggerQueueBestEffort(ctx, req.meshId);
        const response: GraphNodePatchResponse = {
            patched: true,
            graphId: result.graphId,
            nodeId: result.nodeId,
            ...(result.ref ? { ref: result.ref } : {}),
            ...(result.queueTaskId ? { queueTaskId: result.queueTaskId } : {}),
            materializationVersion: result.materializationVersion,
            state: result.state,
            outcomeKind: result.outcome.kind,
            ...(result.outcome.kind === 'skipped' ? { skippedReason: (result.outcome as { reason?: string }).reason } : {}),
            ...(result.blockedReason ? { blockedReason: result.blockedReason } : {}),
        };
        return { success: true, ...response };
    } catch (e: any) {
        const message = e?.message || String(e);
        const response: GraphNodePatchResponse = { patched: false, message, ...(classifyNodePatchError(e, message) ? { refusalCode: classifyNodePatchError(e, message) } : {}) };
        return { success: true, ...response };
    }
};

// ─── graph_view_query ───────────────────────────────────────────────────────

const MAX_GATE_EVIDENCE_PROBES = 5;

const graphViewQuery: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeGraphViewQueryRequest(args);
    if (!req) return badRequest('graph_view_query');
    try {
        const graphs = buildMeshGraphViews(req.meshId, {
            ...(req.graphId ? { graphId: req.graphId } : {}),
            ...(req.batchId ? { batchId: req.batchId } : {}),
            activeOnly: req.activeOnly !== false,
            ...(req.limit !== undefined ? { limit: req.limit } : {}),
        });
        if (req.probeGateEvidence) {
            let probesLeft = MAX_GATE_EVIDENCE_PROBES;
            for (const graph of graphs) {
                for (const gate of graph.gates ?? []) {
                    if (probesLeft <= 0) break;
                    if (gate.state !== 'awaiting_coordinator' && gate.state !== 'expired') continue;
                    probesLeft -= 1;
                    try {
                        const evidence = await collectGateConvergenceEvidence(req.meshId, gate.gateId);
                        if (evidence) (gate as any).convergenceEvidence = evidence;
                    } catch { /* fail-soft: the view never breaks on a probe fault */ }
                }
            }
        }
        const response: GraphViewQueryResponse = { graphs: graphs as unknown as Record<string, unknown>[] };
        return { success: true, ...response };
    } catch (e) {
        return failure(e);
    }
};

// ─── task_stats_query ───────────────────────────────────────────────────────

const taskStatsQuery: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeTaskStatsQueryRequest(args);
    if (!req) return badRequest('task_stats_query');
    try {
        const tasks = computeMeshTaskStats(req.meshId, {
            ...(req.taskIds ? { taskIds: [...req.taskIds] } : {}),
            ...(req.missionId ? { missionId: req.missionId } : {}),
            ...(req.tail !== undefined ? { tail: req.tail } : {}),
        });
        const response: TaskStatsQueryResponse = { tasks: tasks as unknown as Record<string, unknown>[] };
        if (req.rollup && req.missionId) {
            try {
                response.mission = computeMeshMissionStats(req.meshId, req.missionId) as unknown as Record<string, unknown>;
            } catch { /* rollup is an enhancement — the per-task stats still return */ }
        }
        return { success: true, ...response };
    } catch (e) {
        return failure(e);
    }
};

// ─── prune_stale_direct ─────────────────────────────────────────────────────

const pruneStaleDirect: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodePruneStaleDirectRequest(args);
    if (!req) return badRequest('prune_stale_direct');
    try {
        const queue = getQueue(req.meshId);
        const directDispatches = getActiveDirectDispatches(req.meshId);
        const ledgerEntries = readLocalRecords(req.meshId, { tail: 500 });
        const result = await pruneStaleDirectDispatches({
            meshId: req.meshId,
            queue,
            ledgerEntries,
            directDispatches,
            nodes: [],
            execute: req.execute === true,
            includeTerminal: req.includeTerminal === true,
            source: req.source || 'mesh_prune_stale_direct',
            // No closeDispatches override: this handler runs IN the daemon that owns
            // the turn ledger, so the default `cancelDirectDispatchAttempts` (this
            // process's ledger — the same core the daemon reconcile-loop auto-prune
            // already uses) is exactly right; the mcp-server's own closure existed
            // only to reach that ledger over `turn_cancel` IPC, which is now moot.
        });
        const response: PruneStaleDirectResponse = {
            mode: result.mode,
            includeTerminal: result.includeTerminal,
            candidateCount: result.candidateCount,
            prunable: result.prunable as unknown as Record<string, unknown>[],
            prunedCount: result.prunedCount,
            preservedUnacknowledged: result.preservedUnacknowledged as unknown as Record<string, unknown>[],
            preservedLedgerOnly: result.preservedLedgerOnly as unknown as Record<string, unknown>[],
            preservedNotOrphan: result.preservedNotOrphan as unknown as Record<string, unknown>[],
        };
        return { success: true, ...response };
    } catch (e) {
        return failure(e);
    }
};

// ─── orphaned_pin_notify ────────────────────────────────────────────────────

const orphanedPinNotify: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeOrphanedPinNotifyRequest(args);
    if (!req) return badRequest('orphaned_pin_notify');
    try {
        const orphans = notifyCoordinatorOfOrphanedPins(req.meshId, req.stoppedSessionId, {
            ...(req.excludeTaskId ? { excludeTaskId: req.excludeTaskId } : {}),
            ...(req.cause ? { cause: req.cause } : {}),
            ...(req.nodeId ? { nodeId: req.nodeId } : {}),
            ...(req.coordinatorSessionId ? { coordinatorSessionId: req.coordinatorSessionId } : {}),
        });
        const response: OrphanedPinNotifyResponse = { orphans: orphans as unknown as OrphanedPinNotifyResponse['orphans'] };
        return { success: true, ...response };
    } catch (e) {
        return failure(e);
    }
};

// ─── registration (merged into turnLedgerIpcHandlers by turn-ledger-ipc.ts) ─

export const meshGraphIpcHandlers: Record<string, LowFamilyHandler> = {
    graph_gate_claim: graphGateClaim,
    graph_gate_release: graphGateRelease,
    graph_gate_abandon: graphGateAbandon,
    graph_node_patch: graphNodePatch,
    graph_view_query: graphViewQuery,
    task_stats_query: taskStatsQuery,
    prune_stale_direct: pruneStaleDirect,
    orphaned_pin_notify: orphanedPinNotify,
};

// Re-exported so a caller that only wants the patch-key allow-list (e.g. an
// error hint) does not have to import mesh-graph-transition-runner.js directly.
export { MESH_NODE_PATCH_KEYS };
