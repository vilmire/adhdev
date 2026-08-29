/**
 * RF-ROUTER HIGH family — shared types for the extracted high-coupling command
 * handlers. Like the LOW and MED families, each handler is a function of
 * (context, args) that returns the exact CommandRouterResult the original
 * `executeDaemonCommand` switch case returned, so the router facade is unchanged.
 *
 * HIGH handlers are the most router-coupled of the three families: in addition to
 * the MED collaborators (mesh resolution, owner gating, inline-cache), they reach
 * the router's aggregate-status memory cache and running-refine-job table — state
 * the router owns and the `mesh_status` aggregate render and `get_mesh_review_inbox`
 * re-entry both depend on. The router binds those onto HighFamilyContext at
 * dispatch; they are NOT reachable from `deps`.
 *
 * Registry dispatch: DaemonCommandRouter.executeDaemonCommand looks up the cmd in
 * highFamilyRegistry AFTER the LOW and MED registries and BEFORE its remaining
 * switch; a hit returns the handler result, a miss falls through to the switch
 * (and ultimately CommandHandler delegation).
 */
import type {
    CommandRouterDeps,
    CommandRouterResult,
    MeshGitProbeCache,
    MeshRefineJobHandle,
} from '../router.js';
import type { ResolvedMeshForCommand } from '../med-family/types.js';

/**
 * Router-private collaborators injected at dispatch. Each is a bound method or
 * field of DaemonCommandRouter; handlers that don't need a given collaborator
 * simply ignore it. The router owns this instance state (inline-mesh cache,
 * aggregate-status memory cache, running-refine-job table, git-probe cache), so
 * it cannot be read from `deps` — the registry receives bound references instead.
 */
export interface HighFamilyContext {
    deps: CommandRouterDeps;

    /** Bound `DaemonCommandRouter.getMeshForCommand`. */
    getMeshForCommand: (
        meshId: string,
        inlineMesh?: unknown,
        options?: { preferInline?: boolean },
    ) => Promise<ResolvedMeshForCommand>;

    /** Bound `DaemonCommandRouter.getCachedAggregateMeshStatus`. */
    getCachedAggregateMeshStatus: (
        meshId: string,
        mesh?: any,
        options?: { requireDirectPeerTruth?: boolean; allowStalePending?: boolean },
    ) => any | null;

    /** Bound `DaemonCommandRouter.rememberAggregateMeshStatus`. */
    rememberAggregateMeshStatus: (meshId: string, snapshot: any, refreshReason: string) => any;

    /**
     * Bound `DaemonCommandRouter.execute`. `get_mesh_review_inbox` re-enters the
     * router with a `mesh_status` refresh to obtain computed node fields; this is
     * the same self-call the inlined case made.
     */
    execute: (cmd: string, args: any, source?: string) => Promise<CommandRouterResult>;

    /**
     * Bound `DaemonCommandRouter.markWorktreeBootstrapTerminalState`. The
     * `mesh_forward_event` handler must stamp a worktree bootstrap terminal
     * transition (complete/failed) into the coordinator's inline mesh view so
     * the claim gate observes it — the handler only has `ctx.deps`, which does
     * NOT expose the router itself.
     */
    markWorktreeBootstrapTerminalState: (
        meshId: string,
        nodeId: string,
        status: 'complete' | 'failed',
        opts?: { workspace?: string },
    ) => void;

    /**
     * Bound `DaemonCommandRouter.getCachedInlineMesh`. A successful stamp above
     * schedules `setImmediate(() => triggerMeshQueue(components, meshId))` inside
     * injectMeshSystemMessage, reusing this SAME shim as `components` — and
     * triggerMeshQueue's first line unconditionally calls
     * `components.router.getCachedInlineMesh(meshId)` (only the `.router` access
     * is optional-chained, not the method call). Without this bound, the queue
     * re-fire throws "components.router?.getCachedInlineMesh is not a function"
     * (WARN-logged, not surfaced) and silently does nothing instead of draining
     * the deferred claim.
     */
    getCachedInlineMesh: (meshId: string, inlineMesh?: unknown) => any | undefined;

    /** Router's aggregate-status memory cache (`.has()` probe in mesh_status). */
    aggregateMeshStatusCache: Map<string, { builtAt: number; snapshot: any; queueRevision: string }>;

    /** Meshes with a background SWR freshen already in flight — coalesces the
     *  async refresh a stale-serve interactive open kicks off. */
    swrRefreshInFlight: Set<string>;

    /** Router's running-refine-job table (surfaced as activeRefineJobs in mesh_status). */
    runningRefineJobs: Map<string, MeshRefineJobHandle>;

    /** Router's inline-mesh cache (launch_mesh_coordinator caches cloud inline mesh). */
    inlineMeshCache: Map<string, any>;

    /** Router's mesh git-probe cache (shared probe dedup for mesh_status). */
    meshGitProbeCache: MeshGitProbeCache;
}

export type HighFamilyHandler = (ctx: HighFamilyContext, args: any) => Promise<CommandRouterResult | null>;

export type HighFamilyRegistry = Map<string, HighFamilyHandler>;
