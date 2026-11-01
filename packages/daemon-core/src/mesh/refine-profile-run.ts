import { runMeshRefineValidationGate } from './mesh-refine-gates.js';

type GateOptions = NonNullable<Parameters<typeof runMeshRefineValidationGate>[2]>;

/**
 * LIGHT-TASK shared entry point (landing + review-in-task self-check): run the named
 * `validation.profiles` entry of the repo's refine config against `workspace`.
 *
 *   runMeshRefineValidationProfile(mesh, workspace, 'fast', { baseSha, configBaseRefs?, changeImpact?, onCommandComplete? })
 *     → Promise<MeshRefineValidationSummary>   // same summary shape as the full gate
 *
 * Bootstrap is skipped (light/review workspaces share a linked node_modules and must
 * never install), `baseSha` becomes ADHDEV_REFINE_BASE_SHA for the commands, and every
 * gate outside the profile is recorded `skipped: true, skipReason: 'skipped_by_profile'`
 * on `commandsRun`. An undeclared profile yields `status: 'failed', failureCode:
 * 'validation_profile_unknown'`. `mesh` may be `null`/`{}` when the config lives in
 * `.adhdev/refine.json` of `workspace` (pass `configBaseRefs` to fall back to a base ref).
 */
export function runMeshRefineValidationProfile(
    mesh: any,
    workspace: string,
    profile: string,
    opts?: Omit<GateOptions, 'profile' | 'skipBootstrap'>,
) {
    return runMeshRefineValidationGate(mesh, workspace, { ...opts, profile, skipBootstrap: true });
}
