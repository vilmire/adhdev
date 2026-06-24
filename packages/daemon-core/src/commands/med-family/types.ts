/**
 * RF-ROUTER MED family — shared types for the extracted medium-coupling command
 * handlers. Like the LOW family, each handler is a function of (context, args)
 * that returns the exact CommandRouterResult the original `executeDaemonCommand`
 * switch case returned, so the router facade is unchanged.
 *
 * Unlike the LOW family, MED handlers need a handful of router-private
 * collaborators (mesh resolution, owner gating, inline-cache mutation, worktree /
 * session cleanup, refine job starters, IDE launch). The router binds these onto
 * MedFamilyContext at dispatch; they are NOT reachable from `deps`. The IDE family
 * also needs `launchIde` to break the original `launch_ide`/`restart_*`
 * self-recursion through executeDaemonCommand.
 *
 * Registry dispatch: DaemonCommandRouter.executeDaemonCommand looks up the cmd in
 * medFamilyRegistry BEFORE its switch; a hit returns the handler result, a miss
 * falls through to the remaining switch (and ultimately CommandHandler delegation).
 */
import type { CommandRouterDeps, CommandRouterResult, MeshGitProbeCache } from '../router.js';
import type { RepoMeshSessionCleanupMode } from '../../repo-mesh-types.js';
import type { WorktreeBootstrapState } from '../../mesh/worktree-bootstrap-config.js';

/** Mesh record resolved from the router's inline-mesh cache + local config. */
export type ResolvedMeshForCommand = {
    mesh: any;
    inline: boolean;
    source: 'inline_cache' | 'inline_bootstrap' | 'local_config';
} | null;

/** Result of the router's local worktree-node cleanup. */
export type CleanupLocalWorktreeNodeResult =
    | { success: true; skipped?: boolean; removedPath?: string; repoRoot?: string; reason?: string; fallback?: string; forced?: boolean; convergence?: Record<string, unknown>; recovered?: boolean; residue?: boolean; residueWarning?: string; residueError?: string }
    | { success: false; code: string; error: string; recoveryHint: string; convergence?: Record<string, unknown> };

/**
 * Router-private collaborators injected at dispatch. Each is a bound method or
 * field of DaemonCommandRouter; handlers that don't need a given collaborator
 * simply ignore it. The router owns this instance state (inline-mesh cache,
 * aggregate-status cache, session/worktree cleanup, refine jobs), so it cannot be
 * read from `deps` — the registry receives bound references instead.
 */
export interface MedFamilyContext {
    deps: CommandRouterDeps;

    /** Bound `DaemonCommandRouter.getMeshForCommand`. */
    getMeshForCommand: (
        meshId: string,
        inlineMesh?: unknown,
        options?: { preferInline?: boolean },
    ) => Promise<ResolvedMeshForCommand>;

    /** Bound `DaemonCommandRouter.getCachedInlineMesh`. */
    getCachedInlineMesh: (meshId: string, inlineMesh?: unknown) => any | undefined;

    /** Bound `DaemonCommandRouter.requireMeshHostMutationOwner` (owner gate). */
    requireMeshHostMutationOwner: (meshId: string, inlineMesh: unknown, operation: string) => Promise<CommandRouterResult | null>;

    /** Bound `DaemonCommandRouter.invalidateAggregateMeshStatus`. */
    invalidateAggregateMeshStatus: (meshId: string) => void;

    /** Bound `DaemonCommandRouter.updateInlineMeshNode`. */
    updateInlineMeshNode: (meshId: string, mesh: any, node: any) => void;

    /** Bound `DaemonCommandRouter.removeInlineMeshNode`. */
    removeInlineMeshNode: (meshId: string, mesh: any, nodeId: string) => boolean;

    /** Bound `DaemonCommandRouter.normalizeMeshSessionCleanupMode`. */
    normalizeMeshSessionCleanupMode: (value: unknown) => RepoMeshSessionCleanupMode;

    /** Bound `DaemonCommandRouter.cleanupMeshSessions`. */
    cleanupMeshSessions: (args: {
        meshId: string;
        nodeId: string;
        node: any;
        mode: RepoMeshSessionCleanupMode;
        sessionIds?: string[];
        dryRun?: boolean;
        source?: 'mesh_cleanup_sessions' | 'mesh_remove_node';
    }) => Promise<{ success: boolean; [key: string]: unknown }>;

    /** Bound `DaemonCommandRouter.cleanupLocalWorktreeNode`. */
    cleanupLocalWorktreeNode: (args: {
        mesh: any;
        node: any;
        nodeId: string;
        force?: boolean;
    }) => Promise<CleanupLocalWorktreeNodeResult>;

    /** Bound `DaemonCommandRouter.startMeshRefineJob` (async execute path). */
    startMeshRefineJob: (meshId: string, nodeId: string, args: any) => Promise<CommandRouterResult>;

    /** Bound `DaemonCommandRouter.batchRefineMeshNodes` (dry-run batch plan). */
    batchRefineMeshNodes: (meshId: string, requestedNodeIds: string[] | undefined, args: any) => Promise<CommandRouterResult>;

    /** Bound `DaemonCommandRouter.startMeshRefineBatchJob` (async batch execute). */
    startMeshRefineBatchJob: (meshId: string, requestedNodeIds: string[] | undefined, args: any) => Promise<CommandRouterResult>;

    /** Bound `DaemonCommandRouter.stopIde` (CDP disconnect + cleanup + optional kill). */
    stopIde: (ideType: string, killProcess?: boolean) => Promise<void>;

    /**
     * Module-level `launchIde` helper bound to this context. The original
     * `launch_ide` case body, lifted into a free function so `restart_session` /
     * `restart_ide` can invoke the IDE launch directly instead of recursing
     * through `executeDaemonCommand('launch_ide')` (which would re-enter the
     * registry). Byte-identical to the original case body.
     */
    launchIde: (args: any) => Promise<CommandRouterResult>;

    /** Router's inline-mesh cache (read/write of resolved mesh records). */
    inlineMeshCache: Map<string, any>;

    /** Router's mesh git-probe cache (reused direct-truth probes for get_mesh). */
    meshGitProbeCache: MeshGitProbeCache;
}

export type MedFamilyHandler = (ctx: MedFamilyContext, args: any) => Promise<CommandRouterResult | null>;

export type MedFamilyRegistry = Map<string, MedFamilyHandler>;

export type { WorktreeBootstrapState };
