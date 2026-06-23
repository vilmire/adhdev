/**
 * RF-ROUTER LOW family — mesh refine-config / change-impact config commands.
 *
 * Schema/validate/suggest endpoints for the repo mesh refine config and the
 * change-impact config. Pure: every handler is a function of args only (it reads
 * no router deps), so ctx is unused. Extracted verbatim from executeDaemonCommand;
 * the config helpers are imported from their source modules, identical to router.ts.
 */
import {
    CHANGE_IMPACT_CONFIG_LOCATIONS,
    CHANGE_IMPACT_CONFIG_SCHEMA,
    loadChangeImpactConfig,
    suggestChangeImpactConfig,
    validateChangeImpactConfig,
} from '../../git/change-impact-config.js';
import {
    MESH_REFINE_CONFIG_LOCATIONS,
    MESH_REFINE_CONFIG_SCHEMA,
    loadMeshRefineConfig,
    suggestMeshRefineConfig,
    validateMeshRefineConfig,
} from '../../mesh/refine-config.js';
import {
    MESH_WORKTREE_BOOTSTRAP_CONFIG_LOCATIONS,
    MESH_WORKTREE_BOOTSTRAP_CONFIG_SCHEMA,
} from '../../mesh/worktree-bootstrap-config.js';
import type { LowFamilyContext, LowFamilyHandler } from './types.js';

export const refineConfigHandlers: Record<string, LowFamilyHandler> = {
    get_mesh_refine_config_schema: async (_ctx: LowFamilyContext, _args: any) => {
        return {
            success: true,
            schema: MESH_REFINE_CONFIG_SCHEMA,
            locations: MESH_REFINE_CONFIG_LOCATIONS,
            worktreeBootstrap: {
                schema: MESH_WORKTREE_BOOTSTRAP_CONFIG_SCHEMA,
                locations: MESH_WORKTREE_BOOTSTRAP_CONFIG_LOCATIONS,
                sourceOfTruth: 'repo worktree bootstrap config',
                runBehavior: 'When present and enabled, clone_mesh_node runs commands after submodule initialization and records status on the worktree node.',
            },
            sourceOfTruth: 'repo mesh/refine config',
            heuristicRole: 'suggestions_only_not_execution_path',
        };
    },

    validate_mesh_refine_config: async (_ctx: LowFamilyContext, args: any) => {
        const workspace = typeof args?.workspace === 'string' ? args.workspace : process.cwd();
        const mesh = args?.inlineMesh || {};
        const loaded = args?.config !== undefined
            ? { config: args.config, source: 'inline', sourceType: 'mesh_policy' as const }
            : loadMeshRefineConfig(mesh, workspace);
        const validation = loaded.config
            ? validateMeshRefineConfig(loaded.config, loaded.source)
            : { valid: false, errors: [((loaded as { error?: string }).error) || 'repo mesh/refine config unavailable'], commands: [], rejectedCommands: [] };
        return { success: validation.valid, ...loaded, ...validation };
    },

    suggest_mesh_refine_config: async (_ctx: LowFamilyContext, args: any) => {
        const workspace = typeof args?.workspace === 'string' ? args.workspace : process.cwd();
        const mesh = args?.inlineMesh || {};
        return {
            success: true,
            ...suggestMeshRefineConfig(mesh, workspace),
            note: 'Suggestions are heuristic scaffold only; Refinery will not execute them until saved into repo mesh/refine config.',
        };
    },

    get_mesh_change_impact_config_schema: async (_ctx: LowFamilyContext, _args: any) => {
        return {
            success: true,
            schema: CHANGE_IMPACT_CONFIG_SCHEMA,
            locations: CHANGE_IMPACT_CONFIG_LOCATIONS,
            sourceOfTruth: 'repo change-impact config',
            heuristicRole: 'suggestions_only_not_execution_path',
            note: 'Declarative config only — JSON/YAML are parsed but never executed. Defines which package/file changes require a daemon rebuild/restart vs. a web-only redeploy vs. nothing.',
        };
    },

    validate_mesh_change_impact_config: async (_ctx: LowFamilyContext, args: any) => {
        const workspace = typeof args?.workspace === 'string' ? args.workspace : process.cwd();
        if (args?.config !== undefined) {
            const validation = validateChangeImpactConfig(args.config, 'inline');
            return { success: validation.valid, source: 'inline', sourceType: 'mesh_policy', ...validation };
        }
        const loaded = loadChangeImpactConfig(workspace);
        if (loaded.sourceType === 'repo_file') {
            const validation = validateChangeImpactConfig(loaded.config, loaded.source);
            return { success: validation.valid, ...loaded, ...validation };
        }
        return {
            success: false,
            ...loaded,
            valid: false,
            errors: [loaded.error || 'repo change-impact config unavailable'],
        };
    },

    suggest_mesh_change_impact_config: async (_ctx: LowFamilyContext, args: any) => {
        const workspace = typeof args?.workspace === 'string' ? args.workspace : process.cwd();
        return {
            success: true,
            ...suggestChangeImpactConfig(workspace),
            note: 'Suggestions are heuristic scaffold only; the draft must be reviewed and saved into repo change-impact config before it takes effect. Nothing is executed.',
        };
    },
};
