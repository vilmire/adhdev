/**
 * RF-ROUTER LOW family — shared types for the extracted low-coupling command
 * handlers. Each handler is a pure function of (context, args): it reads only the
 * router deps it needs and returns the exact CommandRouterResult the original
 * `executeDaemonCommand` switch case returned, so the router facade is unchanged.
 *
 * Dispatch: each family file turns its handler table into command specs
 * (defineCommandSpecs) and the router runs `getDaemonCommandRegistry().get(cmd)`
 * with the context this family needs.
 */
import type { CommandRouterDeps, CommandRouterResult } from '../router.js';

/** Mesh record resolved from the router's inline-mesh cache + local config. */
export type ResolvedMeshForCommand = {
    mesh: any;
    inline: boolean;
    source: 'inline_cache' | 'inline_bootstrap' | 'local_config';
} | null;

export interface LowFamilyContext {
    deps: CommandRouterDeps;
    /**
     * Bound `DaemonCommandRouter.getMeshForCommand`. A handful of LOW handlers
     * (mesh-node-logs) must resolve a mesh node's owning daemonId from the
     * router's inline-mesh cache, which is router instance state not present in
     * `deps`. The router injects it at dispatch; handlers that don't need it
     * ignore it. Optional so unit tests can omit it (and assert the guarded
     * fallback) without constructing a full router.
     */
    getMeshForCommand?: (
        meshId: string,
        inlineMesh?: unknown,
        options?: { preferInline?: boolean },
    ) => Promise<ResolvedMeshForCommand>;
}

export type LowFamilyHandler = (ctx: LowFamilyContext, args: any) => Promise<CommandRouterResult>;

