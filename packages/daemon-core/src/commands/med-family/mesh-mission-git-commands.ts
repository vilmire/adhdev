/**
 * Mission git-ref commands (design 2026-11-01-mission-git-refs §6):
 *  - mesh_mission_git_eval        → the mission's `MissionGitState` (read-only: it never
 *                                   changes a mission's status, outcome or items).
 *  - mesh_ref_containment_probe   → member-node side of the fallback: judge refs against
 *                                   THIS machine's repositories only and return verdicts.
 */
import { isSafeBranchName, isSafeRefValue, isSafeRelativeRepo } from '../../mesh/mission-ref-input.js';
import { readString } from '@adhdev/mesh-shared';
import type { MedFamilyContext, MedFamilyHandler } from './types.js';
import { defineCommandSpecs } from '../command-registry.js';
import { getMeshMission } from '../../mesh/mesh-missions.js';
import { rosterEvidenceExtra } from '../mesh-sender.js';
import { buildMissionRefEvalEnv, localRepoDirsOfMesh } from '../../mesh/mission-git-env.js';
import { evaluateMissionGitState, readMissionGitState, readMissionGitStates, scheduleStaleMissionGitEvals, missionGitEvalMetrics } from '../../mesh/mesh-mission-git-eval.js';
import { MAX_EVALUATED_REFS_PER_MISSION, probeRefsLocally, type RefProbeEntry } from '../../mesh/mission-ref-evaluator.js';
import type { MissionGitState } from '@adhdev/mesh-shared';

/** Wire projection of a state: ref rows trimmed unless `verbose` (detail / pinned SHA / base SHA). */
export function missionGitStateToWire(state: MissionGitState, verbose: boolean): Record<string, unknown> {
    return {
        missionId: state.missionId,
        state: state.state,
        ...(state.partialUnknown ? { partialUnknown: true } : {}),
        counts: state.counts,
        ...(state.baseRef ? { baseRef: state.baseRef } : {}),
        ...(state.baseSha ? { baseSha: state.baseSha } : {}),
        ...(state.evaluatedAt ? { evaluatedAt: state.evaluatedAt } : {}),
        stale: state.stale,
        refs: state.refs.map(r => ({
            refKey: r.refKey, itemId: r.itemId, status: r.status, ...(r.method ? { method: r.method } : {}), evaluatedAt: r.evaluatedAt,
            ...(r.detail?.unknownReason ? { unknownReason: r.detail.unknownReason } : {}),
            ...(r.detail?.note ? { note: r.detail.note } : {}),
            ...(verbose ? { ...(r.pinnedSha ? { pinnedSha: r.pinnedSha } : {}), ...(r.baseSha ? { baseSha: r.baseSha } : {}), ...(r.detail ? { detail: r.detail } : {}) } : {}),
        })),
    };
}

function readEntries(raw: unknown): RefProbeEntry[] | null {
    if (!Array.isArray(raw)) return null;
    const out: RefProbeEntry[] = [];
    for (const e of raw.slice(0, MAX_EVALUATED_REFS_PER_MISSION)) {
        const rec = e && typeof e === 'object' ? e as Record<string, unknown> : null;
        const kind = rec?.kind === 'branch' ? 'branch' : rec?.kind === 'commit' ? 'commit' : null;
        const value = readString(rec?.value);
        if (!kind || !value || !isSafeRefValue(kind, value)) return null;
        const pinned = readString(rec?.pinned);
        const repo = readString(rec?.repo);
        if (repo && !isSafeRelativeRepo(repo)) return null;
        out.push({ kind, value, ...(pinned && /^[0-9a-f]{7,64}$/i.test(pinned) ? { pinned } : {}), ...(repo ? { repo } : {}) });
    }
    return out;
}

export const meshMissionGitCommandHandlers: Record<string, MedFamilyHandler> = {
    mesh_mission_git_eval: async (ctx: MedFamilyContext, args: any) => {
        const meshId = readString(args?.meshId);
        if (!meshId) return { success: false, error: 'meshId is required' };
        const verbose = args?.verbose === true;
        const refresh = args?.refresh === true;
        const cachedOnly = args?.cachedOnly === true;
        try {
            const meshRecord = await ctx.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
            const mesh = meshRecord?.mesh;
            const selfDaemonId = ctx.deps.statusInstanceId;
            const envFor = (fetch: boolean) => buildMissionRefEvalEnv({
                meshId, mesh, selfDaemonId, dispatch: ctx.deps.dispatchMeshCommand,
                rosterEvidence: rosterEvidenceExtra({}, mesh), fetch,
            });

            const missionIds: string[] = Array.isArray(args?.missionIds)
                ? args.missionIds.filter((v: unknown): v is string => typeof v === 'string' && v.length > 0).slice(0, 200)
                : [];
            const single = readString(args?.missionId);
            if (single) {
                if (!getMeshMission(meshId, single)) return { success: false, code: 'mission_not_found', error: `mission '${single}' does not exist on this mesh` };
                if (cachedOnly) return { success: true, meshId, gitState: missionGitStateToWire(readMissionGitState(meshId, single), verbose) };
                const cached = readMissionGitState(meshId, single);
                // A single-mission read evaluates when nothing is cached or the cache is stale (no fetch unless `refresh`).
                const state = refresh || cached.stale ? await evaluateMissionGitState(meshId, single, envFor(refresh)) : cached;
                return { success: true, meshId, gitState: missionGitStateToWire(state, verbose), ...(args?.metrics === true ? { metrics: missionGitEvalMetrics(meshId) } : {}) };
            }
            if (missionIds.length === 0) return { success: false, error: 'missionId or missionIds is required' };
            // List view: cached answers now, stale ones refresh in the background.
            const states = readMissionGitStates(meshId, missionIds);
            if (!cachedOnly) scheduleStaleMissionGitEvals(meshId, states.values(), () => envFor(false));
            return { success: true, meshId, gitStates: Object.fromEntries([...states].map(([id, s]) => [id, missionGitStateToWire(s, verbose)])) };
        } catch (e: any) {
            return { success: false, error: `mission git evaluation failed: ${e?.message || e}` };
        }
    },

    // Member side of the host's fallback probe. Read-only; answers from THIS machine's repos and never relays further.
    mesh_ref_containment_probe: async (ctx: MedFamilyContext, args: any) => {
        const meshId = readString(args?.meshId);
        const entries = readEntries(args?.entries);
        if (!meshId || !entries) return { success: false, error: 'meshId and entries[{kind,value}] are required' };
        const baseBranch = readString(args?.baseBranch) ?? 'main';
        if (!isSafeBranchName(baseBranch)) return { success: false, error: 'baseBranch is not a valid branch name' };
        try {
            const meshRecord = await ctx.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
            const localRepos = localRepoDirsOfMesh(meshRecord?.mesh, ctx.deps.statusInstanceId);
            const results = await probeRefsLocally(entries, { defaultBranch: baseBranch, localRepos });
            return { success: true, meshId, results };
        } catch (e: any) {
            return { success: false, error: `ref containment probe failed: ${e?.message || e}` };
        }
    },
};

export const meshMissionGitCommandSpecs = defineCommandSpecs('med', meshMissionGitCommandHandlers, {
    mesh_ref_containment_probe: { meshSender: 'any_member_mesh' },
}, { meshSender: 'authenticated_peer' });
