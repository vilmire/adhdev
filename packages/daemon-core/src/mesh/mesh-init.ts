/**
 * Mesh init / onboarding helper.
 *
 * One-shot helper that onboards an existing git project into Repo Mesh:
 *   1. suggest + write `.adhdev/refine.json`           (Refinery validation config)
 *   2. suggest + write `.adhdev/worktree_bootstrap.json` (worktree bootstrap config)
 *   3. suggest + write `.adhdev/change-impact.json`     (change-impact classification)
 *   4. recommend a node providerPriority from the installed CLI providers
 *
 * mesh_init now covers all THREE repo-committed `.adhdev/*` config families that
 * carry a suggest→validate→write engine (refine + worktree_bootstrap +
 * change-impact). `.adhdev/mesh.json` (coordinator prompt + operating notes) has
 * its own dedicated export/write path (export_mesh_json_config / write_mesh_json_config).
 *
 * Design contract (matches the rest of the mesh tooling):
 *   - Heuristics are suggestion/scaffold only. The written files are the
 *     execution source of truth; Refinery/bootstrap only ever read the saved
 *     config. The suggestion functions never become the execution path.
 *   - Writing is opt-in (`write: true`) and never clobbers an existing config
 *     unless `overwrite: true` is set, so re-running init on an already-onboarded
 *     repo is safe.
 *   - The providerPriority recommendation is returned, not auto-applied to the
 *     node policy — applying it mutates mesh policy, which is the coordinator's
 *     decision.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
    MESH_REFINE_CONFIG_LOCATIONS,
    loadMeshRefineConfig,
    suggestMeshRefineConfig,
    validateMeshRefineConfig,
    type RepoMeshRefineConfig,
    type RepoMeshRefineValidationCommandConfig,
} from './refine-config.js';
import {
    MESH_WORKTREE_BOOTSTRAP_CONFIG_LOCATIONS,
    loadMeshWorktreeBootstrapConfig,
    validateMeshWorktreeBootstrapConfig,
    type RepoMeshWorktreeBootstrapConfig,
} from './worktree-bootstrap-config.js';
import {
    CHANGE_IMPACT_CONFIG_LOCATIONS,
    loadChangeImpactConfig,
    suggestChangeImpactConfig,
    validateChangeImpactConfig,
    type ChangeImpactConfig,
} from '../git/change-impact-config.js';
import { listMagiKindPanelsReadOnly } from '../config/mesh-config.js';
import type { MagiKindPanelMap } from '@adhdev/mesh-shared';
import type { CLIInfo } from '../detection/cli-detector.js';

/** Canonical write targets — the first/preferred location for each config family. */
export const MESH_INIT_REFINE_CONFIG_PATH = MESH_REFINE_CONFIG_LOCATIONS[0];
export const MESH_INIT_WORKTREE_BOOTSTRAP_CONFIG_PATH = MESH_WORKTREE_BOOTSTRAP_CONFIG_LOCATIONS[0];
export const MESH_INIT_CHANGE_IMPACT_CONFIG_PATH = CHANGE_IMPACT_CONFIG_LOCATIONS[0];

/**
 * Default lockfiles whose change should invalidate a 'ready' bootstrap.
 * Only paths that actually exist in the workspace are recorded as staleInputs.
 */
const CANDIDATE_STALE_INPUTS = [
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lockb',
    'Cargo.lock',
    'go.sum',
    'poetry.lock',
    'requirements.txt',
];

export interface MeshInitConfigFileResult {
    path: string;
    relativePath: string;
    written: boolean;
    /** Why it was not written (already_exists / not_suggested / no change). */
    skippedReason?: 'already_exists' | 'no_suggestion';
    config?: RepoMeshRefineConfig | RepoMeshWorktreeBootstrapConfig | ChangeImpactConfig;
}

/**
 * Serialize a validated config to disk as pretty JSON, creating `.adhdev/` as
 * needed. Returns the absolute path written. Never invoked unless the caller
 * opted into writing.
 */
function writeConfigFile(workspace: string, relativePath: string, config: unknown): string {
    const target = join(workspace, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
    return target;
}

/**
 * Build a worktree_bootstrap scaffold from package scripts. Mirrors
 * suggestMeshRefineConfig's "scaffold only" posture: prefers an `install`/`ci`
 * style script, else falls back to `npm install`, and records existing
 * lockfiles as staleInputs so a base merge that changes them re-runs bootstrap.
 *
 * Returns undefined when there is nothing meaningful to scaffold.
 */
export function suggestMeshWorktreeBootstrapConfig(
    workspace: string,
): { commands: RepoMeshRefineValidationCommandConfig[]; staleInputs: string[]; suggestedConfig?: RepoMeshWorktreeBootstrapConfig } {
    const commands: RepoMeshRefineValidationCommandConfig[] = [];
    const hasPackageJson = existsSync(join(workspace, 'package.json'));
    const hasNpmLock = existsSync(join(workspace, 'package-lock.json'));

    if (hasPackageJson) {
        // `npm ci` requires a lockfile; otherwise fall back to `npm install`.
        commands.push(
            hasNpmLock
                ? { command: 'npm', args: ['ci'] }
                : { command: 'npm', args: ['install'] },
        );
    }

    const staleInputs = CANDIDATE_STALE_INPUTS.filter((relative) => existsSync(join(workspace, relative)));

    if (!commands.length) {
        return { commands, staleInputs };
    }

    return {
        commands,
        staleInputs,
        suggestedConfig: {
            version: 1,
            enabled: true,
            runOnClone: true,
            required: false,
            commands,
            ...(staleInputs.length ? { staleInputs } : {}),
        },
    };
}

/**
 * Map detected CLI providers → an ordered node providerPriority list.
 * Suggestion only: returned for the coordinator to apply to node policy, never
 * written into mesh policy here.
 *
 * Ordering preference (most → least preferred) when installed:
 *   claude-cli → codex-cli → gemini-cli → everything else (stable input order).
 */
const PROVIDER_PRIORITY_PREFERENCE = ['claude-cli', 'codex-cli', 'gemini-cli'];

export function suggestNodeProviderPriority(detected: CLIInfo[]): {
    providerPriority: string[];
    installedProviders: Array<{ id: string; displayName: string; version?: string }>;
} {
    const installed = detected.filter((cli) => cli.installed);
    const installedIds = installed.map((cli) => cli.id);

    const preferred = PROVIDER_PRIORITY_PREFERENCE.filter((id) => installedIds.includes(id));
    const rest = installedIds.filter((id) => !preferred.includes(id));
    const providerPriority = [...preferred, ...rest];

    return {
        providerPriority,
        installedProviders: installed.map((cli) => ({
            id: cli.id,
            displayName: cli.displayName,
            ...(cli.version ? { version: cli.version } : {}),
        })),
    };
}

export interface RunMeshInitOptions {
    /** When true, persist suggested configs to disk. Defaults to dry-run (false). */
    write?: boolean;
    /** When true, overwrite an existing config file. Defaults to false (never clobber). */
    overwrite?: boolean;
}

/**
 * A snapshot of the currently-saved config for each domain, so the coordinator can
 * render a current-vs-suggested diff to the user before an init/reinit overwrite.
 * This is READ-ONLY echo — every field is what is on disk / machine-local right now,
 * never a suggestion. Absent domains are reported as `undefined` config.
 */
export interface MeshInitCurrentConfigEcho {
    /** Currently-saved `.adhdev/refine.json` (repo-committed) — undefined when absent/invalid. */
    refine?: RepoMeshRefineConfig;
    /** Currently-saved `.adhdev/worktree_bootstrap.json` (repo-committed). */
    worktreeBootstrap?: RepoMeshWorktreeBootstrapConfig;
    /** Currently-saved `.adhdev/change-impact.json` (repo-committed). */
    changeImpact?: ChangeImpactConfig;
    /** Per-domain source type so the coordinator can tell "absent" from "invalid". */
    sourceTypes: {
        refine: string;
        worktreeBootstrap: string;
        changeImpact: string;
    };
    /**
     * Currently-configured MAGI kind→panel slot bindings (machine-local
     * ~/.adhdev/meshes.json). Empty object when none configured. This is a
     * machine-local echo — the coordinator labels it as such vs. the repo files.
     */
    magiKindPanels: MagiKindPanelMap;
}

export interface RunMeshInitResult {
    success: true;
    workspace: string;
    dryRun: boolean;
    refine: MeshInitConfigFileResult;
    worktreeBootstrap: MeshInitConfigFileResult;
    changeImpact: MeshInitConfigFileResult;
    providers: {
        providerPriority: string[];
        installedProviders: Array<{ id: string; displayName: string; version?: string }>;
    };
    /**
     * Read-only snapshot of the currently-saved config per domain (repo files +
     * machine-local kind panels). Lets the coordinator present a current-vs-suggested
     * diff to the user before any overwrite. Always populated (dry-run and write).
     */
    currentConfig: MeshInitCurrentConfigEcho;
    note: string;
}

/**
 * Orchestrate the full onboarding flow for one workspace:
 *   detect installed CLIs → suggest refine + bootstrap configs → (optionally)
 *   write them → recommend a node providerPriority.
 *
 * `detected` is injected (the caller resolves it via detectCLIs with its
 * ProviderLoader) so this module stays free of provider-loader wiring and is
 * trivially unit-testable.
 */
export function runMeshInit(
    mesh: any,
    workspace: string,
    detected: CLIInfo[],
    options: RunMeshInitOptions = {},
): RunMeshInitResult {
    const write = options.write === true;
    const overwrite = options.overwrite === true;

    const refine = applyConfigSuggestion({
        workspace,
        relativePath: MESH_INIT_REFINE_CONFIG_PATH,
        existing: loadMeshRefineConfig(mesh, workspace).config,
        suggestedConfig: suggestMeshRefineConfig(mesh, workspace).suggestedConfig,
        validate: (config) => validateMeshRefineConfig(config, MESH_INIT_REFINE_CONFIG_PATH).valid,
        write,
        overwrite,
    });

    const bootstrapSuggestion = suggestMeshWorktreeBootstrapConfig(workspace);
    const worktreeBootstrap = applyConfigSuggestion({
        workspace,
        relativePath: MESH_INIT_WORKTREE_BOOTSTRAP_CONFIG_PATH,
        existing: loadMeshWorktreeBootstrapConfig(mesh, workspace).config,
        suggestedConfig: bootstrapSuggestion.suggestedConfig,
        validate: (config) => validateMeshWorktreeBootstrapConfig(config, MESH_INIT_WORKTREE_BOOTSTRAP_CONFIG_PATH).valid,
        write,
        overwrite,
    });

    // change-impact classification (.adhdev/change-impact.json). suggest/validate/save
    // mirror refine's engine exactly, so it drops into the same applyConfigSuggestion
    // gate: existing-wins unless overwrite, dry-run by default, validated before write.
    const changeImpactLoaded = loadChangeImpactConfig(workspace);
    const changeImpact = applyConfigSuggestion({
        workspace,
        relativePath: MESH_INIT_CHANGE_IMPACT_CONFIG_PATH,
        existing: changeImpactLoaded.sourceType === 'repo_file' ? changeImpactLoaded.config : undefined,
        suggestedConfig: suggestChangeImpactConfig(workspace).suggestedConfig,
        validate: (config) => validateChangeImpactConfig(config, MESH_INIT_CHANGE_IMPACT_CONFIG_PATH).valid,
        write,
        overwrite,
    });

    const providers = suggestNodeProviderPriority(detected);

    // Read-only echo of the currently-saved config per domain so the coordinator can
    // present a current-vs-suggested diff before any overwrite (init vs reinit). This
    // never suggests — it reports what is on disk / machine-local right now.
    const refineLoaded = loadMeshRefineConfig(mesh, workspace);
    const bootstrapLoaded = loadMeshWorktreeBootstrapConfig(mesh, workspace);
    let magiKindPanels: MagiKindPanelMap = {};
    try {
        magiKindPanels = listMagiKindPanelsReadOnly();
    } catch {
        // Machine-local config unreadable — echo an empty binding rather than failing init.
        magiKindPanels = {};
    }
    const currentConfig: MeshInitCurrentConfigEcho = {
        refine: refineLoaded.config,
        worktreeBootstrap: bootstrapLoaded.config,
        changeImpact: changeImpactLoaded.sourceType === 'repo_file' ? changeImpactLoaded.config : undefined,
        sourceTypes: {
            refine: refineLoaded.sourceType,
            worktreeBootstrap: bootstrapLoaded.sourceType,
            changeImpact: changeImpactLoaded.sourceType,
        },
        magiKindPanels,
    };

    return {
        success: true,
        workspace,
        dryRun: !write,
        refine,
        worktreeBootstrap,
        changeImpact,
        providers,
        currentConfig,
        note: write
            ? 'Configs written to disk are the execution source of truth; suggestions are scaffold and only take effect once saved. providerPriority is a recommendation — apply it to node policy via clone/policy update. currentConfig echoes what was on disk before this run.'
            : 'Dry-run: no files written. Re-run with write=true to persist the suggested configs. Heuristic suggestions never execute until saved as repo config. Use currentConfig to diff current-vs-suggested before overwriting.',
    };
}

/**
 * Shared decision logic for a single config file: keep an existing config,
 * skip when nothing was suggested, or (when allowed) write the validated
 * suggestion to disk.
 */
function applyConfigSuggestion(input: {
    workspace: string;
    relativePath: string;
    existing?: unknown;
    suggestedConfig?: RepoMeshRefineConfig | RepoMeshWorktreeBootstrapConfig | ChangeImpactConfig;
    validate: (config: unknown) => boolean;
    write: boolean;
    overwrite: boolean;
}): MeshInitConfigFileResult {
    const { workspace, relativePath, existing, suggestedConfig, validate, write, overwrite } = input;
    const absolute = join(workspace, relativePath);

    // An existing, valid config wins unless the caller explicitly opts into overwrite.
    if (existing !== undefined && !overwrite) {
        return { path: absolute, relativePath, written: false, skippedReason: 'already_exists', config: existing as any };
    }

    if (!suggestedConfig || !validate(suggestedConfig)) {
        return { path: absolute, relativePath, written: false, skippedReason: 'no_suggestion' };
    }

    if (!write) {
        return { path: absolute, relativePath, written: false, config: suggestedConfig };
    }

    const writtenPath = writeConfigFile(workspace, relativePath, suggestedConfig);
    return { path: writtenPath, relativePath, written: true, config: suggestedConfig };
}
