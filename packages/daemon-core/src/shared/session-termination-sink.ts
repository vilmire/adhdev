/**
 * TOMBSTONE-LEDGER-BRIDGE (transport half) — a producer-neutral seam between the
 * PTY exit path and whoever wants to record that a session died.
 *
 * Why this module exists instead of a direct call:
 *
 * The observation ("this CLI session's PTY exited, and session-host handed us a
 * tombstone describing how") is produced in `providers/spec` — the adapter is the
 * only place that sees the exit event at all. The consumer that needs it is the
 * mesh ledger. But `providers/**` must not value-import `mesh/**`: that arrow is
 * an enforced layering boundary (scripts/check-import-boundaries.mjs), because
 * every such import couples the completion engine to the mesh runtime.
 *
 * So the dependency is inverted here. The provider layer PUBLISHES a termination
 * observation to this neutral module and knows nothing about the mesh. The mesh
 * layer SUBSCRIBES from `boot/daemon-lifecycle.ts` and owns the decision of what
 * — if anything — to write. Same behavior as a direct call, correct direction:
 * the arrow now points providers -> shared <- mesh instead of providers -> mesh.
 *
 * This mirrors the injection precedent already in the tree
 * (`configureHandoffNoteSink` in mesh/worker-report.ts): wire at boot, pass null
 * to disable, and keep the producer callable from tests and from a daemon with
 * no mesh at all.
 *
 * Neutrality is the whole point — this module imports no layer, only a type from
 * session-host-core and the logger. Do not let it grow a mesh import; that would
 * relocate the breach rather than fix it.
 */

import type { SessionTermination } from '@adhdev/session-host-core';
import { LOG } from '../logging/logger.js';

/**
 * A CLI session's PTY died and session-host classified the death.
 *
 * Deliberately carries no mesh vocabulary: no meshId, no nodeId, no coordinator
 * flag. The producer does not know whether this session is mesh-bound — that
 * resolution belongs to the subscriber, which owns the mesh binding rules
 * (`resolveMeshTerminationBinding`). Keeping the payload mesh-free is what lets
 * this seam serve a second consumer later without a shape change.
 */
export interface SessionTerminationObservation {
    /** Owning session id (session registry / read-path targetSessionId). */
    sessionId: string;
    /** Provider type of the CLI that died (e.g. 'claude', 'codex'). */
    providerType?: string;
    /** Working directory the session ran in. */
    workspace?: string;
    /**
     * Runtime settings as mirrored onto the adapter. The subscriber reads the
     * mesh binding stamps out of this; the producer just forwards them opaquely.
     */
    runtimeSettings: Record<string, unknown>;
    /** The session-host tombstone, verbatim. */
    termination: SessionTermination;
}

/**
 * May return a promise (the mesh subscriber's ledger write is async). The
 * publisher never awaits it — see `publishSessionTermination` — but returning it
 * lets a test drive the seam to completion deterministically.
 */
export type SessionTerminationObserver = (
    observation: SessionTerminationObservation,
) => void | Promise<void>;

let observer: SessionTerminationObserver | null = null;

/** Wire the observer at daemon boot; pass null to disable (tests, no mesh). */
export function configureSessionTerminationObserver(next: SessionTerminationObserver | null): void {
    observer = next;
}

/**
 * Publish a termination observation.
 *
 * Best-effort by construction, and that is load-bearing rather than lazy: this
 * runs on the PTY exit path, so a throwing subscriber must never propagate back
 * and turn an observability gap into a crash. With no observer wired this is a
 * silent no-op, which is the correct behavior for a non-mesh daemon.
 */
export function publishSessionTermination(observation: SessionTerminationObservation): void {
    if (!observer) return;
    const warn = (e: any) => LOG.warn(
        'SessionTermination',
        `Termination observer failed for ${observation.sessionId}: ${e?.message || e}`,
    );
    try {
        // Catch the async rejection too. A promise-returning observer that
        // rejects would otherwise surface as an unhandled rejection on the PTY
        // exit path — the very crash this best-effort seam must never cause.
        void Promise.resolve(observer(observation)).catch(warn);
    } catch (e: any) {
        warn(e);
    }
}
