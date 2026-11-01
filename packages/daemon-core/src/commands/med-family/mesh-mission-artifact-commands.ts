/**
 * mesh_mission_artifact_list — discover what a mission has produced, for a
 * coordinator that has NO session of its own (an MCP-only coordinator).
 *
 * Why a mesh command and not `artifact_list`: the artifact_* verbs authorize
 * through a session (verified owner, worker credential, or a session-bound MCP
 * credential) and deliberately reject session-less IPC. A coordinator MCP server
 * launched without a coordinator session has none of those, so `artifact_list`
 * with a `mission_id` was refused. Mesh tools (`mesh_view_queue`, `mesh_status`, …)
 * are authorized by naming the mesh over local IPC, and this command takes the same
 * stance — while the artifact_* verbs stay exactly as strict as before.
 *
 * Scope is narrow: metadata + bounded preview only (never file bytes), only records
 * positively bound to BOTH the named mesh and the named mission, newest-limited
 * (default/max 50). Reading content still goes through `artifact_read`'s own checks.
 */
import { readString } from '@adhdev/mesh-shared';
import { toChatAttachmentMeta } from '../../artifacts/index.js';
import { defineCommandSpecs } from '../command-registry.js';
import { getArtifactStore } from './artifact-runtime.js';
import type { MedFamilyContext, MedFamilyHandler } from './types.js';

export const MESH_MISSION_ARTIFACT_LIST_MAX = 50;

export const meshMissionArtifactCommandHandlers: Record<string, MedFamilyHandler> = {
    mesh_mission_artifact_list: async (ctx: MedFamilyContext, args: any) => {
        const meshId = readString(args?.meshId);
        const missionId = readString(args?.missionId);
        if (!meshId || !missionId) return { success: false, code: 'invalid_arguments', error: 'meshId and missionId are required' };
        const rawLimit = args?.limit;
        const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
            ? Math.min(Math.trunc(rawLimit), MESH_MISSION_ARTIFACT_LIST_MAX)
            : MESH_MISSION_ARTIFACT_LIST_MAX;
        try {
            const artifacts = getArtifactStore(ctx)
                .listByMission(missionId, { meshId, limit })
                .filter((rec) => rec.meshId === meshId && rec.missionId === missionId);
            return { success: true, meshId, missionId, artifacts, attachments: artifacts.map((rec) => toChatAttachmentMeta(rec)) };
        } catch (e: any) {
            return { success: false, error: `mission artifact listing failed: ${e?.message || e}` };
        }
    },
};

// Local IPC only (the mesh MCP server's channel) — never P2P/WS/mesh peers.
export const meshMissionArtifactCommandSpecs = defineCommandSpecs('med', meshMissionArtifactCommandHandlers, {
    mesh_mission_artifact_list: { sources: ['ipc'] },
});
