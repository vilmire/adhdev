/**
 * Dashboard read commands for the Blueprint tab:
 *  - mesh_route_preview → buildMeshRoutePreview (read-only)
 *  - mesh_task_output   → the latest mesh_task_outputs envelope, projected to
 *                         finalSummary/providerType (see the handler's comment)
 */
import type { MedFamilyContext, MedFamilyHandler } from './types.js';
import { buildMeshRoutePreview } from '../../mesh/mesh-route-preview.js';
import { getMesh } from '../../config/mesh-config.js';
import { MeshRuntimeStore } from '../../mesh/mesh-runtime-store.js';
import { defineCommandSpecs } from '../command-registry.js';
import { readString } from '@adhdev/mesh-shared';

export const meshTaskViewCommandHandlers: Record<string, MedFamilyHandler> = {
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

    // Task-detail completion info: finalSummary is persisted per terminal in
    // mesh_task_outputs (persistOutputVersion, mesh-task-terminal.ts). taskId →
    // the latest envelope, projected to the fields the task-detail panel needs.
    // Never the raw envelope blob — worker_result/artifacts/evidence stay
    // server-side until a UI actually needs them, same "narrow DTO" discipline
    // as list_mesh_notes.
    mesh_task_output: async (_ctx: MedFamilyContext, args: any) => {
        const meshId = readString(args?.meshId);
        const taskId = readString(args?.taskId);
        if (!meshId || !taskId) return { success: false, error: 'meshId and taskId are required' };
        const mesh = getMesh(meshId);
        if (!mesh) return { success: false, error: `unknown mesh: ${meshId}` };
        try {
            const row = MeshRuntimeStore.getInstance().getLatestTaskOutput(taskId);
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
};

export const meshTaskViewCommandSpecs = defineCommandSpecs('med', meshTaskViewCommandHandlers, {}, { meshSender: 'authenticated_peer' });
