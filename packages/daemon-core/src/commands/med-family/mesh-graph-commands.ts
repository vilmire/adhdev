/**
 * mesh-graph-commands — dashboard-transport surface for the graph control
 * plane (G5). The rich graph projection (mesh_graph_view) previously existed
 * ONLY as a coordinator MCP tool — a human could not see an awaiting gate
 * anywhere, and owner-action gates (approval / publish) sat invisible for
 * days (measured live 2026-08-24).
 *
 * These commands delegate to the SAME daemon-core engine the MCP tools use:
 *  - mesh_graph_overview → buildMeshGraphViews (read-only)
 *  - mesh_route_preview  → buildMeshRoutePreview (read-only)
 *  - mesh_task_output    → MeshGraphStore.getLatestOutput (read-only; projects
 *                          finalSummary/providerType out of the persisted
 *                          completion envelope — see the handler's own comment)
 *
 * ★ REMOVED (2026-09-25, graph-orchestration-simplification D3(c)): this file
 * used to also define `mesh_gate_claim` / `mesh_gate_release` /
 * `mesh_gate_abandon` — a G5 MVP (9c00d805) that shipped with no `sources`
 * restriction (reachable from every CommandSource, including a peer `mesh`
 * connection) and no caller: the dashboard blueprint tab was deliberately
 * kept OBSERVE-ONLY (owner decision 2026-08-24, see the old revision of this
 * comment), the MCP coordinator tools were always named `mesh_graph_gate_*`
 * and dispatch over IPC (`graph_gate_claim` & co. in
 * ../low-family/mesh-graph-ipc.ts), never these command names, and no
 * web-cloud/web-core/web-standalone/daemon-cloud/server code ever referenced
 * `mesh_gate_claim/release/abandon` either. A full-repo sweep (including the
 * oss submodule, which `git grep` does not descend into — use `command grep`
 * or `git -C oss log`/`grep`) turned up zero callers outside this file's own
 * unit tests. The replacement, dashboard-callable gate verbs
 * (`mesh_graph_gate_claim/release/abandon/extend`) now live in
 * ./mesh-graph-gate-commands.ts, with `sources: ['ipc','standalone','p2p']`
 * (never `mesh` — a peer daemon must not operate this daemon's gates).
 *
 * No auto-release exists here either; the deadline sweep still owns timeouts.
 */
import type { MedFamilyContext, MedFamilyHandler } from './types.js';
import { buildMeshGraphViews, countMeshGraphViews } from '../../mesh/mesh-graph-view.js';
import { buildMeshRoutePreview } from '../../mesh/mesh-route-preview.js';
import { getMesh } from '../../config/mesh-config.js';
import { MeshRuntimeStore } from '../../mesh/mesh-runtime-store.js';
import { defineCommandSpecs } from '../command-registry.js';

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
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
};

export const meshGraphCommandSpecs = defineCommandSpecs('med', meshGraphCommandHandlers, {}, { meshSender: 'authenticated_peer' });
