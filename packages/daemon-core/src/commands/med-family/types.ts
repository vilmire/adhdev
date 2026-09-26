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
 * Dispatch: each family file turns its handler table into command specs
 * (defineCommandSpecs) and the router runs `getDaemonCommandRegistry().get(cmd)`
 * with the context this family needs.
 */
import type { CommandRouterDeps, CommandRouterResult, MeshGitProbeCache } from '../router.js';
import type { MeshNodeGitStateStore } from '../../mesh/mesh-node-git-state.js';
import type { DaemonComponentsAccessor } from '../daemon-components-port.js';
import type { RepoMeshSessionCleanupMode } from '../../repo-mesh-types.js';
import type { WorktreeBootstrapState } from '../../mesh/worktree-bootstrap-config.js';
import type { PersistRemoteWorktreeNodeOutcome } from '../../mesh/mesh-remote-worktree-membership.js';

/** Mesh record resolved from the router's inline-mesh cache + local config. */
export type ResolvedMeshForCommand = {
    mesh: any;
    inline: boolean;
    source: 'inline_cache' | 'inline_bootstrap' | 'local_config';
} | null;

/** Result of the router's local worktree-node cleanup. */
export type CleanupLocalWorktreeNodeResult =
    | { success: true; skipped?: boolean; removedPath?: string; repoRoot?: string; reason?: string; fallback?: string; forced?: boolean; convergence?: Record<string, unknown>; recovered?: boolean; residue?: boolean; residueWarning?: string; residueError?: string; branchRefDeleted?: boolean; branchRefReason?: string; branchRefForced?: boolean; branchRefWarning?: string }
    | { success: false; code: string; error: string; recoveryHint: string; convergence?: Record<string, unknown> };

/**
 * Result of the non-destructive local-worktree removability precheck. `ok:false`
 * carries the same refusal `code`/`error`/`recoveryHint` that the destructive
 * cleanup would have returned, so callers can refuse a removal BEFORE performing
 * any irreversible step (e.g. stopping/deleting delegated sessions).
 */
export type WorktreeRemovalPrecheckResult =
    | { ok: true }
    | { ok: false; code: string; error: string; recoveryHint: string };

/**
 * Router-private collaborators injected at dispatch. Each is a bound method or
 * field of DaemonCommandRouter; handlers that don't need a given collaborator
 * simply ignore it. The router owns this instance state (inline-mesh cache,
 * aggregate-status cache, session/worktree cleanup, refine jobs), so it cannot be
 * read from `deps` — the registry receives bound references instead.
 */
export interface MedFamilyContext {
    deps: CommandRouterDeps;
    /**
     * The daemon's REAL `DaemonComponents` (late-bound by boot S7). Use this —
     * never `deps` cast to components — wherever a mesh function takes
     * `DaemonComponents`: `deps` has no turn ledger, and a claim made through it
     * dispatched without an attempt (rc.39). Throws
     * `DaemonComponentsNotReadyError` inside the boot window.
     */
    components: DaemonComponentsAccessor;

    /** Bound `DaemonCommandRouter.getMeshForCommand`. */
    getMeshForCommand: (
        meshId: string,
        inlineMesh?: unknown,
        options?: { preferInline?: boolean },
    ) => Promise<ResolvedMeshForCommand>;

    /** Bound `DaemonCommandRouter.getCachedInlineMesh`. */
    getCachedInlineMesh: (meshId: string, inlineMesh?: unknown) => any | undefined;

    /**
     * Bound `DaemonCommandRouter.markWorktreeBootstrapTerminalState`. `clone_mesh_node`'s
     * post-bootstrap emit (worktree_bootstrap_complete/_failed) runs on the WORKER
     * daemon that owns the cloned worktree and calls handleMeshForwardEvent locally
     * (in-process, before falling back to notifyMeshCoordinator) — that
     * local call needs the same bound stamp the HIGH-family mesh_forward_event
     * handler supplies, or it throws on `components.router.markWorktreeBootstrapTerminalState`
     * (the handler only has `ctx.deps`, which does NOT expose the router itself).
     */
    markWorktreeBootstrapTerminalState: (
        meshId: string,
        nodeId: string,
        status: 'complete' | 'failed',
        opts?: { workspace?: string; daemonId?: string; machineId?: string },
    ) => void;

    /** Bound `DaemonCommandRouter.requireMeshHostMutationOwner` (owner gate). */
    requireMeshHostMutationOwner: (meshId: string, inlineMesh: unknown, operation: string) => Promise<CommandRouterResult | null>;

    /** Bound `DaemonCommandRouter.invalidateAggregateMeshStatus`. */
    invalidateAggregateMeshStatus: (meshId: string) => void;

    /** Bound `DaemonCommandRouter.updateInlineMeshNode`. */
    updateInlineMeshNode: (meshId: string, mesh: any, node: any) => void;

    /**
     * Bound `DaemonCommandRouter.seedRemoteClonedWorktreeNode` — seed a worktree node
     * cloned on another machine into this coordinator's inline cache, merging
     * order-independently against a bootstrap-event hydrate. Returns false when the
     * node carries no resolvable id (or the seed failed); best-effort by contract.
     */
    seedRemoteClonedWorktreeNode: (meshId: string, node: any) => boolean;

    /**
     * Bound `DaemonCommandRouter.persistRemoteClonedWorktreeNode` — write that same
     * remotely-cloned node into this coordinator's meshes.json so it survives a
     * coordinator restart (idempotent; never for a tombstoned node).
     */
    persistRemoteClonedWorktreeNode: (meshId: string, node: any) => Promise<PersistRemoteWorktreeNodeOutcome | 'tombstoned'>;

    /**
     * Bound `DaemonCommandRouter.tombstoneRemovedMeshNode` — record a removal so late
     * one-shot events / member reports cannot re-register the node (idempotent).
     */
    tombstoneRemovedMeshNode: (meshId: string, nodeId: string) => void;

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
        source?: 'mesh_cleanup_sessions' | 'mesh_remove_node' | 'magi_session_cleanup';
        requireAutoLaunchedForTaskIds?: Record<string, string>;
        /**
         * Opt-in orphan reclaim (default false). When true, a workspace-only live
         * session (no node binding) OR a session bound to a node that no longer
         * exists in `liveMeshNodeIds` is stopped instead of skipped — reclaims the
         * SESSION-ACCUMULATION-LEAK orphans. `liveMeshNodeIds` is the current mesh's
         * node id set; a session whose meshNodeId is still present is treated as an
         * active sibling and left alone.
         */
        reclaimOrphans?: boolean;
        liveMeshNodeIds?: string[];
    }) => Promise<{ success: boolean; [key: string]: unknown }>;

    /** Bound `DaemonCommandRouter.cleanupLocalWorktreeNode`. */
    cleanupLocalWorktreeNode: (args: {
        mesh: any;
        node: any;
        nodeId: string;
        force?: boolean;
    }) => Promise<CleanupLocalWorktreeNodeResult>;

    /**
     * Bound `DaemonCommandRouter.precheckLocalWorktreeRemovable` — purely
     * non-destructive validation of whether a local worktree node can be removed.
     * Called BEFORE session cleanup so a refusal does not orphan the session.
     */
    precheckLocalWorktreeRemovable: (args: {
        mesh: any;
        node: any;
        nodeId: string;
        force?: boolean;
    }) => Promise<WorktreeRemovalPrecheckResult>;

    /**
     * Bound `DaemonCommandRouter.getWorktreeForceCleanupConvergence` — the
     * merge/push convergence authority (externally recorded metadata, git
     * merge-base containment, or patch-equivalence). Read-only.
     */
    getWorktreeForceCleanupConvergence: (args: {
        repoRoot: string;
        workspace: string;
        node: any;
    }) => Promise<{ allow: boolean; status?: string; source?: string; ref?: string; error?: string }>;

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
    /**
     * Coordinator-held node state (mesh/mesh-node-git-state.ts): get_mesh hydrates
     * remote nodes' git from it; the requeue guard reads held remote session status.
     */
    meshNodeGitState?: MeshNodeGitStateStore;
}

export type MedFamilyHandler = (ctx: MedFamilyContext, args: any) => Promise<CommandRouterResult>;


export type { WorktreeBootstrapState };
