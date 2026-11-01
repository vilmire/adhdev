/**
 * When mission git verdicts are (re)computed (design 2026-11-01-mission-git-refs §5):
 *  ① right after a Refinery merge/push: the mesh's ACTIVE missions that carry refs are
 *    re-evaluated, with a fetch (decision G2: the only automatic fetch);
 *  ② lazily when a list/dashboard read finds verdicts older than the TTL (cached answer
 *    first, no fetch);
 *  ③ explicitly through `mesh_mission_git_eval {refresh:true}` (fetch).
 * Completed/abandoned missions are never re-evaluated automatically, and old missions get
 * no backfill (decision G5): their first verdict comes from an on-demand read.
 *
 * Best-effort everywhere: a failure here must never affect the Refinery or a read.
 */
import { LOG } from '../logging/logger.js';
import { getMesh } from '../config/mesh-config.js';
import { getMeshMissions } from './mesh-missions.js';
import { buildMissionRefEvalEnv, type MeshCommandDispatcher } from './mission-git-env.js';
import { evaluateMissionGitState, readMissionGitState, scheduleStaleMissionGitEvals } from './mesh-mission-git-eval.js';
import { collectMissionRefTargets } from './mission-ref-evaluator.js';

export interface MissionGitTriggerPorts {
    selfDaemonId?: string;
    dispatch?: MeshCommandDispatcher;
}

/** ① The awaitable core: re-evaluate the mesh's ACTIVE missions that carry refs (first one fetches). */
export async function evaluateActiveMissionsAfterRefine(meshId: string, mesh: unknown, ports: MissionGitTriggerPorts = {}): Promise<string[]> {
    const evaluated: string[] = [];
    let fetchPending = true;
    for (const mission of getMeshMissions(meshId, ['active'])) {
        if (collectMissionRefTargets(meshId, mission.id).length === 0) continue;
        const env = buildMissionRefEvalEnv({ meshId, mesh, selfDaemonId: ports.selfDaemonId, dispatch: ports.dispatch, fetch: fetchPending });
        fetchPending = false; // one fetch per push is enough for every mission of the mesh
        await evaluateMissionGitState(meshId, mission.id, env);
        evaluated.push(mission.id);
    }
    return evaluated;
}

/** ① After a Refinery merge: fire-and-forget. */
export function scheduleMissionGitEvalAfterRefine(meshId: string, ports: MissionGitTriggerPorts = {}): void {
    void (async () => {
        const mesh = getMesh(meshId);
        if (mesh) await evaluateActiveMissionsAfterRefine(meshId, mesh, ports);
    })().catch(e => LOG.debug('MeshMissions', `post-refine git eval failed for mesh ${meshId}: ${e?.message || e}`));
}

/** ② Lazy TTL refresh for the missions a read just returned (cached states already went to the caller). */
export function scheduleStaleGitRefresh(meshId: string, missionIds: readonly string[], ports: MissionGitTriggerPorts = {}): void {
    try {
        const mesh = getMesh(meshId);
        if (!mesh) return;
        const states = missionIds.map(id => readMissionGitState(meshId, id)).filter(s => s.stale);
        scheduleStaleMissionGitEvals(meshId, states, () => buildMissionRefEvalEnv({ meshId, mesh, selfDaemonId: ports.selfDaemonId, dispatch: ports.dispatch }));
    } catch { /* best effort */ }
}
