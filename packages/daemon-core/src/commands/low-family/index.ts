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
import { diagnosticsHandlers } from './diagnostics.js';
import { statusMetaHandlers } from './status-meta.js';
import { coordinatorPromptHandlers } from './coordinator-prompt.js';
import { notificationHandlers } from './notification.js';
import { daemonLifecycleHandlers } from './daemon-lifecycle.js';
import { meshLedgerHandlers } from './mesh-ledger.js';
import { meshNodeLogsHandlers } from './mesh-node-logs.js';
import { workerReportHandlers } from './worker-report.js';
import { workerMailboxHandlers } from './worker-mailbox.js';
import type { LowFamilyRegistry } from './types.js';

export type { LowFamilyContext, LowFamilyHandler, LowFamilyRegistry } from './types.js';

export const lowFamilyRegistry: LowFamilyRegistry = new Map(
    Object.entries({
        ...sessionHostHandlers,
        ...specProviderDevHandlers,
        ...refineConfigHandlers,
        ...diagnosticsHandlers,
        ...statusMetaHandlers,
        ...coordinatorPromptHandlers,
        ...notificationHandlers,
        ...daemonLifecycleHandlers,
        ...meshLedgerHandlers,
        ...meshNodeLogsHandlers,
        ...workerReportHandlers,
        ...workerMailboxHandlers,
    }),
);
