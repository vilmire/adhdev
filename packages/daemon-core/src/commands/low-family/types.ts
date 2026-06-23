/**
 * RF-ROUTER LOW family — shared types for the extracted low-coupling command
 * handlers. Each handler is a pure function of (context, args): it reads only the
 * router deps it needs and returns the exact CommandRouterResult the original
 * `executeDaemonCommand` switch case returned, so the router facade is unchanged.
 *
 * Registry dispatch: DaemonCommandRouter.executeDaemonCommand looks up the cmd in
 * lowFamilyRegistry BEFORE its switch; a hit returns the handler result, a miss
 * falls through to the remaining switch (and ultimately CommandHandler delegation).
 */
import type { CommandRouterDeps, CommandRouterResult } from '../router.js';

export interface LowFamilyContext {
    deps: CommandRouterDeps;
}

export type LowFamilyHandler = (ctx: LowFamilyContext, args: any) => Promise<CommandRouterResult>;

export type LowFamilyRegistry = Map<string, LowFamilyHandler>;
