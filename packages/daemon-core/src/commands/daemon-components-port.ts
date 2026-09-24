/**
 * The command layer's handle on the daemon's REAL `DaemonComponents`.
 *
 * Why this exists (live defect, preview rc.39, 2026-09-24): command handlers
 * used to pass `ctx.deps as any` wherever a mesh function expected
 * `DaemonComponents`. `ctx.deps` is the router's `CommandRouterDeps`, built in
 * boot S5 — it has no `turnLedger` (S7 builds the ledger and sets it on the
 * components object only). An IPC-triggered queue claim
 * (`trigger_mesh_queue`) therefore reached `tryAssignQueueTask` with a
 * look-alike whose `turnLedgerOf()` was null, silently skipped opening the
 * `mesh_queue:` attempt, and dispatched anyway — the row stayed `assigned`
 * forever with no attempt to close it.
 *
 * The router is constructed before the components exist (S5 < S7), so S7
 * late-binds the finished object here (`DaemonCommandRouter.attachComponents`).
 * Handlers read it through `ctx.components()`, which THROWS
 * `DaemonComponentsNotReadyError` inside the boot window instead of handing out
 * a partial object. There is no other way to obtain components in the command
 * layer; a structural stand-in is exactly the defect this replaces.
 */
import type { DaemonComponents } from '../boot/daemon-components.js';

export const DAEMON_COMPONENTS_NOT_READY = 'daemon_components_not_ready' as const;

export class DaemonComponentsNotReadyError extends Error {
    readonly code = DAEMON_COMPONENTS_NOT_READY;
    constructor(what: string) {
        super(`${what}: daemon components are not attached yet (boot stage S7 has not completed)`);
        this.name = 'DaemonComponentsNotReadyError';
    }
}

export function isDaemonComponentsNotReady(e: unknown): e is DaemonComponentsNotReadyError {
    return e instanceof DaemonComponentsNotReadyError
        || (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === DAEMON_COMPONENTS_NOT_READY);
}

/** Accessor handed to every family context. Throws `DaemonComponentsNotReadyError` before S7 attaches. */
export type DaemonComponentsAccessor = () => DaemonComponents;

/** The structured command result a handler returns when it needs components inside the boot window. */
export function componentsNotReadyResult(e: DaemonComponentsNotReadyError): { success: false; code: typeof DAEMON_COMPONENTS_NOT_READY; error: string } {
    return { success: false, code: DAEMON_COMPONENTS_NOT_READY, error: e.message };
}
