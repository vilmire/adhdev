/**
 * RF-ROUTER MED family — command registry.
 *
 * Aggregates the medium-coupling command handlers extracted from
 * DaemonCommandRouter.executeDaemonCommand into a single cmd → handler map. The
 * router consults this registry after the LOW-family registry and before its
 * switch (registry hit → return the handler result; miss → fall through to the
 * remaining switch / CommandHandler delegation), so the facade and dispatch
 * semantics are unchanged.
 *
 * MED handlers differ from LOW handlers in that they need router-private
 * collaborators (mesh resolution, owner gating, inline-cache mutation, worktree /
 * session cleanup, refine job starters, IDE launch). The router binds those onto
 * MedFamilyContext at dispatch — see types.ts.
 */
import { cliAgentHandlers } from './cli-agent.js';
import { ideHandlers } from './ide.js';
import { meshCrudHandlers } from './mesh-crud.js';
import { meshHostPairingHandlers } from './mesh-host-pairing.js';
import { meshQueueHandlers } from './mesh-queue.js';
import { fastForwardHandlers } from './fast-forward.js';
import { meshRestartHandlers } from './mesh-restart.js';
import type { MedFamilyRegistry } from './types.js';

export type { MedFamilyContext, MedFamilyHandler, MedFamilyRegistry } from './types.js';

export const medFamilyRegistry: MedFamilyRegistry = new Map(
    Object.entries({
        ...cliAgentHandlers,
        ...ideHandlers,
        ...meshCrudHandlers,
        ...meshHostPairingHandlers,
        ...meshQueueHandlers,
        ...fastForwardHandlers,
        ...meshRestartHandlers,
    }),
);
