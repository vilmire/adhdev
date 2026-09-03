/**
 * mesh-graph-commands — dashboard-transport surface for the graph control
 * plane (G5). The rich graph projection (mesh_graph_view) and the gate verbs
 * (claim/release/abandon) previously existed ONLY as coordinator MCP tools —
 * a human could not see an awaiting gate anywhere, and owner-action gates
 * (approval / publish) sat invisible for days (measured live 2026-08-24).
 *
 * These commands delegate to the SAME daemon-core engine the MCP tools use:
 *  - mesh_graph_overview → buildMeshGraphViews (read-only)
 *  - mesh_gate_claim     → claimMeshGraphGate (+ convergence evidence)
 *  - mesh_gate_release   → releaseMeshGraphGate (fenced; engine THROWS on
 *                          rejection — mapped to { success:false, code })
 *  - mesh_gate_abandon   → abandonMeshGraphGate (deny-passage terminal; NOT a
 *                          force-release — see mesh-tools-graph.ts header)
 *  - mesh_task_output    → MeshGraphStore.getLatestOutput (read-only; projects
 *                          finalSummary/providerType out of the persisted
 *                          completion envelope — see the handler's own comment)
 *
 * No auto-release exists here either; the deadline sweep still owns timeouts.
 *
 * UI exposure (owner decision 2026-08-24): the dashboard blueprint tab is
 * OBSERVE-ONLY — it calls mesh_graph_overview / mesh_route_preview but does
 * not render gate-verb controls. Acting on a gate is done by instructing the
 * coordinator (its MCP tools are the acting surface). The gate-verb commands
 * below stay registered for ops/automation callers, not for dashboard UI.
 */
import type { MedFamilyContext, MedFamilyHandler } from './types.js';
import { buildMeshGraphViews, countMeshGraphViews } from '../../mesh/mesh-graph-view.js';
import { claimMeshGraphGate, releaseMeshGraphGate, abandonMeshGraphGate } from '../../mesh/mesh-graph-gates.js';
import { collectGateConvergenceEvidence } from '../../mesh/mesh-graph-gate-evidence.js';
import { buildMeshRoutePreview } from '../../mesh/mesh-route-preview.js';
import { getMesh } from '../../config/mesh-config.js';
import { MeshRuntimeStore } from '../../mesh/mesh-runtime-store.js';

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** Machine-readable code prefix convention shared with the MCP release tool. */
function extractErrorCode(message: string): string {
    const match = /^([a-z0-9_]+):/.exec(message);
    return match ? match[1] : 'gate_operation_failed';
}

export const meshGraphCommandHandlers: Record<string, MedFamilyHandler> = {
    // Dashboard twin of the coordinator's mesh_route_preview MCP tool — the
    // scheduling "what would routing do" projection (per-node predicted winner
    // + slot admission stages), surfaced in the blueprint tab's scheduling
    // panel. Read-only: it never assigns or launches anything.
    mesh_route_preview: async (_ctx: MedFamilyContext, args: any) => {
        const meshId = readString(args?.meshId);
        if (!meshId) return { success: false, error: 'meshId is required' };
        const mesh = getMesh(meshId);
        if (!mesh) return { success: false, error: `unknown mesh: ${meshId}` };
        try {
            const preview = buildMeshRoutePreview({
                mesh,
                difficulty: readString(args?.difficulty) ?? 'medium',
                requiredTags: Array.isArray(args?.requiredTags) ? args.requiredTags : [],
                readonly: args?.readonly === true,
                ...(readString(args?.targetNodeId) ? { targetNodeId: readString(args?.targetNodeId) } : {}),
            });
            return { success: true, meshId, preview };
        } catch (e: any) {
            return { success: false, error: `route preview failed: ${e?.message || e}` };
        }
    },

    // Task-detail completion info (docs/design/2026-09-02-blueprint-followups.md
    // §1): finalSummary is fully persisted per terminal in mesh_task_outputs
    // (persistOutputVersion, mesh-graph-transition-runner.ts) but had no read
    // path — getLatestOutput's only caller was collectUpstreamOutputs for
    // inputs_from bindings. This is that read path: taskId → the latest
    // envelope, projected to the fields the task-detail panel needs. Never the
    // raw envelope blob — worker_result/artifacts/evidence stay server-side
    // until a UI actually needs them, same "narrow DTO" discipline as
    // list_mesh_notes.
    mesh_task_output: async (_ctx: MedFamilyContext, args: any) => {
        const meshId = readString(args?.meshId);
        const taskId = readString(args?.taskId);
        if (!meshId || !taskId) return { success: false, error: 'meshId and taskId are required' };
        const mesh = getMesh(meshId);
        if (!mesh) return { success: false, error: `unknown mesh: ${meshId}` };
        try {
            const graphStore = MeshRuntimeStore.getInstance().graphStore();
            const row = graphStore.getLatestOutput(taskId);
            if (!row) return { success: true, meshId, taskId, output: null };
            let envelope: Record<string, unknown> | null = null;
            try {
                envelope = JSON.parse(row.envelopeJson) as Record<string, unknown>;
            } catch { /* corrupt/legacy row — surface what the queue row has instead */ }
            const source = (envelope?.source ?? {}) as Record<string, unknown>;
            return {
                success: true,
                meshId,
                taskId,
                output: {
                    version: row.version,
                    status: row.status,
                    finalSummary: typeof envelope?.final_summary === 'string' ? envelope.final_summary : undefined,
                    providerType: typeof source.provider_type === 'string' ? source.provider_type : undefined,
                    completedAt: typeof envelope?.completed_at === 'string' ? envelope.completed_at : row.createdAt,
                },
            };
        } catch (e: any) {
            return { success: false, error: `task output fetch failed: ${e?.message || e}` };
        }
    },

    mesh_graph_overview: async (_ctx: MedFamilyContext, args: any) => {
        const meshId = readString(args?.meshId);
        if (!meshId) return { success: false, error: 'meshId is required' };
        const includeTerminal = args?.includeTerminal === true;
        try {
            const viewOptions = {
                activeOnly: !includeTerminal,
                ...(typeof args?.limit === 'number' && args.limit > 0 ? { limit: Math.min(100, args.limit) } : {}),
            };
            const graphs = buildMeshGraphViews(meshId, viewOptions);
            const totalGraphCount = countMeshGraphViews(meshId, viewOptions);
            const pendingCoordinatorActions = graphs.flatMap(g =>
                (g.nextCoordinatorAction ?? []).map(a => ({ graphId: g.graphId, ...a })));
            return { success: true, meshId, graphCount: graphs.length, totalGraphCount, graphs, pendingCoordinatorActions };
        } catch (e: any) {
            return { success: false, error: `graph overview failed: ${e?.message || e}` };
        }
    },

    mesh_gate_claim: async (_ctx: MedFamilyContext, args: any) => {
        const meshId = readString(args?.meshId);
        const gateId = readString(args?.gateId);
        if (!meshId || !gateId) return { success: false, error: 'meshId and gateId are required' };
        // Dashboard claims are attributed to a synthetic operator session so the
        // lease owner is auditable and distinct from any coordinator LLM session.
        const coordinatorSessionId = readString(args?.coordinatorSessionId) || 'dashboard_operator';
        try {
            const result = claimMeshGraphGate({
                meshId,
                gateId,
                coordinatorSessionId,
                ...(typeof args?.leaseSeconds === 'number' ? { leaseSeconds: args.leaseSeconds } : {}),
            });
            if (!result.claimed) {
                return {
                    success: false,
                    claimed: false,
                    code: result.reason ?? 'gate_not_claimable',
                    ...(result.gate ? { gateState: result.gate.state } : {}),
                    error: `gate not claimable (${result.reason ?? 'unknown'})`,
                };
            }
            let convergenceEvidence = null;
            try { convergenceEvidence = await collectGateConvergenceEvidence(meshId, gateId); } catch { /* enhancement only */ }
            return {
                success: true,
                claimed: true,
                gateId,
                graphId: result.gate!.graphId,
                action: result.gate!.action,
                ...(result.gate!.instructions ? { instructions: result.gate!.instructions } : {}),
                leaseGeneration: result.leaseGeneration,
                fencingToken: result.fencingToken,
                leaseExpiresAt: result.leaseExpiresAt,
                ...(convergenceEvidence ? { convergenceEvidence } : {}),
            };
        } catch (e: any) {
            return { success: false, error: `gate claim failed: ${e?.message || e}` };
        }
    },

    mesh_gate_release: async (_ctx: MedFamilyContext, args: any) => {
        const meshId = readString(args?.meshId);
        const gateId = readString(args?.gateId);
        const fencingToken = readString(args?.fencingToken);
        const outcome = readString(args?.outcome);
        const leaseGeneration = typeof args?.leaseGeneration === 'number' ? args.leaseGeneration : undefined;
        if (!meshId || !gateId || !fencingToken || leaseGeneration === undefined || !outcome) {
            return { success: false, error: 'meshId, gateId, leaseGeneration, fencingToken and outcome are required' };
        }
        try {
            const result = releaseMeshGraphGate({
                meshId,
                gateId,
                leaseGeneration,
                fencingToken,
                outcome,
                // Deterministic per-lease key: retrying the same dashboard release
                // replays as a duplicate success instead of a conflict.
                idempotencyKey: readString(args?.idempotencyKey) || `dashboard_${gateId}_${leaseGeneration}`,
                ...(readString(args?.evidence) ? { evidence: { note: args.evidence } } : {}),
            });
            return { success: true, released: true, gateId, ...(result && typeof result === 'object' ? result : {}) };
        } catch (e: any) {
            const message = String(e?.message || e);
            return { success: false, released: false, code: extractErrorCode(message), error: message };
        }
    },

    mesh_gate_abandon: async (_ctx: MedFamilyContext, args: any) => {
        const meshId = readString(args?.meshId);
        const gateId = readString(args?.gateId);
        if (!meshId || !gateId) return { success: false, error: 'meshId and gateId are required' };
        try {
            const result = abandonMeshGraphGate({
                meshId,
                gateId,
                reason: readString(args?.reason) || 'abandoned from dashboard',
                coordinatorSessionId: readString(args?.coordinatorSessionId) || 'dashboard_operator',
                ...(args?.force === true ? { force: true } : {}),
            });
            if (!result.abandoned) {
                return { success: false, abandoned: false, code: result.reason ?? 'gate_not_abandonable', error: `gate not abandonable (${result.reason ?? 'unknown'})` };
            }
            return { success: true, abandoned: true, gateId, ...(result && typeof result === 'object' ? result : {}) };
        } catch (e: any) {
            const message = String(e?.message || e);
            return { success: false, abandoned: false, code: extractErrorCode(message), error: message };
        }
    },
};
