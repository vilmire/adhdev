/**
 * RF-ROUTER LOW family — command registry.
 *
 * Aggregates the low-coupling command handlers extracted from
 * DaemonCommandRouter.executeDaemonCommand into a single cmd → handler map.
 * The router consults this registry before its switch (registry hit → return the
 * handler result; miss → fall through to the remaining switch / CommandHandler
 * delegation), so the facade and dispatch semantics are unchanged.
 */
import { sessionHostHandlers } from './session-host.js';
import { specProviderDevHandlers } from './spec-providerdev.js';
import { refineConfigHandlers } from './refine-config.js';
import type { LowFamilyRegistry } from './types.js';

export type { LowFamilyContext, LowFamilyHandler, LowFamilyRegistry } from './types.js';

export const lowFamilyRegistry: LowFamilyRegistry = new Map(
    Object.entries({
        ...sessionHostHandlers,
        ...specProviderDevHandlers,
        ...refineConfigHandlers,
    }),
);
