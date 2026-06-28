/**
 * Repo Settings — one unified loader over the repo-committed `.adhdev/*` config
 * files (the "single source" assembly point).
 *
 * DESIGN (option B — file separation preserved): the repo keeps its declarative
 * config in SEPARATE files, each with its own dedicated loader:
 *
 *   .adhdev/mesh.json               → loadRepoMeshJsonConfig  (coordinator + operatingNotes)
 *   .adhdev/refine.json             → loadMeshRefineConfig     (Refinery validation)
 *   .adhdev/worktree_bootstrap.json → loadMeshWorktreeBootstrapConfig
 *   .adhdev/change-impact.json      → loadChangeImpactConfig
 *
 * Nothing is inlined into mesh.json. `loadRepoSettings` simply CALLS each
 * dedicated loader and assembles the results into one `RepoSettings` object so a
 * consumer can read every repo-shared setting through a single call instead of
 * threading four loaders. The per-file loaders remain the source of truth (and
 * stay independently usable); this is a convenience aggregator, not a new schema.
 *
 * IMPORTANT — policy is NOT here. RepoMeshPolicy (the 15 scheduling/approval
 * fields) is MACHINE-LOCAL only: it lives in meshes.json and is never sourced
 * from or merged with a repo file. mesh.json carries only coordinator prompt
 * config + operating notes (+ advisory limits).
 *
 * The refine/worktree-bootstrap loaders also honor a machine-local INLINE seam
 * (mesh.refineConfig / mesh.policy.worktreeBootstrap, etc.) — that seam is for
 * machine-local config and is unchanged here; mesh.json gains no such zone.
 */

import {
    loadRepoMeshJsonConfig,
    type RepoMeshDeclarativeCoordinatorConfig,
    type RepoMeshDeclarativeLimits,
    type RepoMeshJsonConfigLoadResult,
} from './mesh-json-config.js';
import {
    loadMeshRefineConfig,
    type MeshRefineConfigLoadResult,
} from '../mesh/refine-config.js';
import {
    loadMeshWorktreeBootstrapConfig,
    type WorktreeBootstrapConfigLoadResult,
} from '../mesh/worktree-bootstrap-config.js';
import {
    loadChangeImpactConfig,
    type ChangeImpactConfigLoadResult,
} from '../git/change-impact-config.js';
import type { CoordinatorOperatingNote } from '../mesh/coordinator-prompt.js';

export interface LoadRepoSettingsOptions {
    /** Workspace path whose `.adhdev/*` files are resolved (mesh.json / refine / bootstrap). */
    workspace: string;
    /**
     * Machine-local mesh entry, consulted ONLY for the INLINE seam of the
     * refine / worktree-bootstrap loaders (mesh.refineConfig etc.). Optional —
     * omit it and only the repo files are considered. NEVER used to source policy.
     */
    mesh?: any;
    /**
     * Repo root for change-impact resolution. Defaults to `workspace` when omitted
     * (change-impact compares the daemon build commit against the workspace HEAD).
     */
    repoRoot?: string;
}

/**
 * The assembled repo-shared settings. Each sub-config carries its own load
 * result (source / sourceType / error) so a consumer can tell "absent" from
 * "invalid" per file. `coordinator` / `operatingNotes` / `limits` are lifted out
 * of the mesh.json load result for convenience; `meshJson` keeps the full result
 * (e.g. for the `sourceType === 'invalid'` warning on coordinator launch).
 */
export interface RepoSettings {
    /** Repo-shared coordinator prompt config (override/append) from `.adhdev/mesh.json`. */
    coordinator?: RepoMeshDeclarativeCoordinatorConfig;
    /** Repo-declared baseline operating notes from `.adhdev/mesh.json`. */
    operatingNotes?: CoordinatorOperatingNote[];
    /** Advisory-only limits from `.adhdev/mesh.json` (recorded, not enforced in v1). */
    limits?: RepoMeshDeclarativeLimits;
    /** Full `.adhdev/mesh.json` declarative load result (coordinator/operatingNotes source). */
    meshJson: RepoMeshJsonConfigLoadResult;
    /** `.adhdev/refine.json` Refinery validation config load result. */
    refine: MeshRefineConfigLoadResult;
    /** `.adhdev/worktree_bootstrap.json` bootstrap config load result. */
    worktreeBootstrap: WorktreeBootstrapConfigLoadResult;
    /** `.adhdev/change-impact.json` change-impact config load result. */
    changeImpact: ChangeImpactConfigLoadResult;
}

/**
 * Load every repo-committed `.adhdev/*` setting for a workspace and assemble them
 * into one object. Each dedicated loader degrades to an `unavailable`/`invalid`
 * load result rather than throwing, so this never throws on a missing or broken
 * file — a consumer inspects the per-sub-config `sourceType`.
 */
export function loadRepoSettings(opts: LoadRepoSettingsOptions): RepoSettings {
    const workspace = typeof opts.workspace === 'string' ? opts.workspace : '';
    const mesh = opts.mesh;
    const repoRoot = typeof opts.repoRoot === 'string' && opts.repoRoot ? opts.repoRoot : workspace;

    const meshJson = loadRepoMeshJsonConfig(workspace);

    return {
        coordinator: meshJson.config?.coordinator,
        operatingNotes: meshJson.config?.operatingNotes,
        limits: meshJson.config?.limits,
        meshJson,
        refine: loadMeshRefineConfig(mesh, workspace),
        worktreeBootstrap: loadMeshWorktreeBootstrapConfig(mesh, workspace),
        changeImpact: loadChangeImpactConfig(repoRoot),
    };
}
