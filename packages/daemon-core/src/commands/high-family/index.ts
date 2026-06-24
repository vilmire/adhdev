/**
 * RF-ROUTER HIGH family — command registry.
 *
 * Aggregates the high-coupling command handlers extracted from
 * DaemonCommandRouter.executeDaemonCommand into a single cmd → handler map. The
 * router consults this registry after the LOW- and MED-family registries and
 * before its remaining switch (registry hit → return the handler result; miss →
 * fall through to the switch / CommandHandler delegation), so the facade and
 * dispatch semantics are unchanged.
 *
 * HIGH handlers are the most router-coupled: beyond the MED collaborators they
 * reach the router's aggregate-status memory cache and running-refine-job table.
 * The router binds those onto HighFamilyContext at dispatch — see types.ts.
 */
import { meshEventsHandlers } from './mesh-events.js';
import { meshCoordinatorLaunchHandlers } from './mesh-coordinator-launch.js';
import { meshStatusHandlers } from './mesh-status.js';
import type { HighFamilyRegistry } from './types.js';

export type { HighFamilyContext, HighFamilyHandler, HighFamilyRegistry } from './types.js';

export const highFamilyRegistry: HighFamilyRegistry = new Map(
    Object.entries({
        ...meshEventsHandlers,
        ...meshCoordinatorLaunchHandlers,
        ...meshStatusHandlers,
    }),
);
