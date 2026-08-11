/**
 * TOMBSTONE-LEDGER-BRIDGE — carry a session-host termination tombstone into the
 * mesh ledger so an unobserved death stops looking like a gap in the record.
 *
 * The gap this closes: when a mesh CLI session's child process is killed from
 * OUTSIDE the mesh (an external SIGTERM, an OOM kill, a crash), session-host
 * classifies the termination and persists a tombstone — but nothing ever wrote
 * that fact to the mesh ledger. The only `session_stopped` writer was the
 * operator-cleanup path (`recordIntentionalMeshSessionStop`), so reading the
 * ledger alone, an external kill was indistinguishable from "nothing happened":
 * a silent hole between the last normal entry and the next coordinator start.
 *
 * Observed instance (2026-08-11): coordinator session 249e9979 took exit 143
 * (SIGTERM) at 05:06:34.099Z with `previousLifecycle: 'running'`. The ledger
 * held ZERO entries between 05:07:48 and the replacement coordinator's
 * `coordinator_started` at 05:11:21 — a 3.5-minute blind spot that could only
 * be resolved by reading the tombstone file off disk by hand. That shape recurs:
 * 5 of 42 tombstones on this machine were exit 143, all from `running`, spread
 * over four days.
 *
 * This module does not change how sessions die, does not try to prevent the
 * death, and does not restart anything — it is purely the missing write.
 */

import type { SessionTermination } from '@adhdev/session-host-core';
import { LOG } from '../logging/logger.js';

/**
 * How a terminated mesh session should be classified in the ledger.
 *
 * `operator_cleanup` is NOT produced here — that reason belongs exclusively to
 * `recordIntentionalMeshSessionStop` (the mesh_cleanup_sessions / mesh_remove_node
 * path), which keeps writing its own entry unchanged. Everything this module
 * emits is a termination the mesh did not itself request.
 */
export type MeshTerminationStopReason =
    /** Killed by a signal (or an exit code that encodes one) with no stop request on record. */
    | 'external_signal'
    /** Non-zero exit with no stop request on record — the process failed on its own. */
    | 'unexpected_exit'
    /** Exit code could not be determined at all. */
    | 'unknown_termination'
    /** Clean exit 0 that the mesh did not request — the agent process ended by itself. */
    | 'self_exit'
    /** The session host itself was asked to stop/delete/restart/prune this session. */
    | 'host_requested_stop';

export interface MeshSessionTerminationLedgerInput {
    meshId: string;
    sessionId: string;
    nodeId?: string;
    providerType?: string;
    workspace?: string;
    /** True when this session was the mesh's own coordinator CLI session. */
    isCoordinator?: boolean;
    termination: SessionTermination;
}

/**
 * POSIX shells report a signal-terminated child as 128+signal. session-host
 * reports `signal` separately when node-pty gives it, but a PTY exit frequently
 * arrives with `signal: 0` and only the encoded exit code — which is exactly the
 * 249e9979 case (`exitCode: 143, signal: 0`). Decoding it is what lets the
 * ledger say "SIGTERM" instead of "exit 143", and 143 → SIGTERM is the single
 * most load-bearing mapping in this whole fix.
 */
const SIGNAL_NAMES: Record<number, string> = {
    1: 'SIGHUP',
    2: 'SIGINT',
    3: 'SIGQUIT',
    6: 'SIGABRT',
    9: 'SIGKILL',
    11: 'SIGSEGV',
    13: 'SIGPIPE',
    15: 'SIGTERM',
};

/** Decode the terminating signal number from an explicit signal or a 128+N exit code. */
export function resolveTerminationSignal(termination: SessionTermination): number | null {
    if (typeof termination.signal === 'number' && termination.signal > 0) return termination.signal;
    const code = termination.exitCode;
    // Only 129..159 is the shell's signal-encoding band. A bare 128 is not a
    // signal, and codes above 159 are ordinary failures that happen to be large.
    if (typeof code === 'number' && code > 128 && code <= 159) return code - 128;
    return null;
}

/** Human-readable signal name for a decoded signal number, when known. */
export function terminationSignalName(signal: number | null): string | undefined {
    return signal !== null ? SIGNAL_NAMES[signal] : undefined;
}

/**
 * Classify a termination for the ledger.
 *
 * The discriminator for "the mesh/host asked for this" vs. "something outside
 * killed it" is `termination.requestedStop`, which session-host stamps ONLY when
 * the death followed a stop/delete/restart/prune request through its own API. An
 * external `kill(1)` never sets it — that absence is the actual signal, and it is
 * why this classification is trustworthy rather than a heuristic on exit codes.
 */
export function classifyMeshTerminationStop(termination: SessionTermination): {
    reason: MeshTerminationStopReason;
    intentional: boolean;
    signal: number | null;
    signalName?: string;
} {
    const signal = resolveTerminationSignal(termination);
    const signalName = terminationSignalName(signal);

    if (termination.requestedStop) {
        // The host was asked to end this session. Still not `operator_cleanup`:
        // that reason means the mesh cleanup path recorded its own entry.
        return { reason: 'host_requested_stop', intentional: true, signal, signalName };
    }

    if (signal !== null) return { reason: 'external_signal', intentional: false, signal, signalName };
    if (termination.exitCode === null) return { reason: 'unknown_termination', intentional: false, signal, signalName };
    if (termination.exitCode === 0) return { reason: 'self_exit', intentional: false, signal, signalName };
    return { reason: 'unexpected_exit', intentional: false, signal, signalName };
}

/**
 * Build the `session_stopped` payload for a terminated mesh session.
 *
 * Field choices are driven by what the 249e9979 investigation actually needed and
 * could not get from the ledger:
 *  - `intentional` — the top-level "was this us?" discriminator, matching the
 *    convention `isIntentionalCleanupStopEntry` already reads.
 *  - `exitCode` / `signal` / `signalName` — 143 → SIGTERM is where diagnosis starts.
 *  - `previousLifecycle` — `running` means it died mid-work (the serious case);
 *    `idle` means it died between turns.
 *  - `terminatedAt` / `lastOutputAt` / `silentForMs` — the gap between last output
 *    and death (113ms here) is what separates an abrupt external kill from a
 *    process that wound down on its own first.
 */
export function buildMeshTerminationStopPayload(
    input: MeshSessionTerminationLedgerInput,
): Record<string, unknown> {
    const { termination } = input;
    const classified = classifyMeshTerminationStop(termination);

    const terminatedAtIso = Number.isFinite(termination.terminatedAt)
        ? new Date(termination.terminatedAt).toISOString()
        : undefined;
    const lastOutputAtIso = typeof termination.lastOutputAt === 'number' && Number.isFinite(termination.lastOutputAt)
        ? new Date(termination.lastOutputAt).toISOString()
        : undefined;
    const silentForMs = typeof termination.lastOutputAt === 'number'
        && Number.isFinite(termination.lastOutputAt)
        && Number.isFinite(termination.terminatedAt)
        && termination.terminatedAt >= termination.lastOutputAt
        ? termination.terminatedAt - termination.lastOutputAt
        : undefined;

    return {
        intentional: classified.intentional,
        reason: classified.reason,
        // `source` marks who wrote the row, mirroring the operator-cleanup path's
        // convention so a reader can tell the two writers apart.
        source: 'session_host_tombstone',
        observedVia: 'session_exit',
        exitCode: termination.exitCode,
        signal: classified.signal,
        ...(classified.signalName ? { signalName: classified.signalName } : {}),
        // session-host's own classification, kept verbatim alongside ours so the
        // ledger never silently disagrees with the tombstone on disk.
        terminationReason: termination.reason,
        lifecycle: termination.lifecycle,
        ...(termination.previousLifecycle ? { previousLifecycle: termination.previousLifecycle } : {}),
        ...(termination.requestedStop ? { requestedStop: termination.requestedStop } : {}),
        ...(typeof termination.osPid === 'number' ? { osPid: termination.osPid } : {}),
        ...(terminatedAtIso ? { terminatedAt: terminatedAtIso } : {}),
        ...(lastOutputAtIso ? { lastOutputAt: lastOutputAtIso } : {}),
        ...(silentForMs !== undefined ? { silentForMs } : {}),
        ...(input.isCoordinator ? { coordinatorSession: true } : {}),
        ...(input.workspace ? { workspace: input.workspace } : {}),
    };
}

/**
 * Resolve the mesh binding of a terminated CLI session from the runtime settings
 * the provider instance mirrors down onto its adapter.
 *
 * Both mesh roles must be covered, and they carry different stamps:
 *  - a WORKER session is bound via `meshNodeFor` (its mesh) + `meshNodeId` (its node);
 *  - a COORDINATOR session is bound via `meshCoordinatorFor` (the mesh it drives)
 *    and has no node of its own.
 * The coordinator case is not incidental — the death that motivated this bridge
 * (249e9979) WAS the coordinator, so resolving only `meshNodeFor` would have
 * missed exactly the session whose loss left the ledger blank.
 *
 * Returns null when the session has no mesh binding at all (an ordinary
 * non-mesh CLI session), which is the signal to write nothing.
 */
export function resolveMeshTerminationBinding(settings: Record<string, unknown> | null | undefined): {
    meshId: string;
    nodeId?: string;
    isCoordinator: boolean;
} | null {
    if (!settings || typeof settings !== 'object') return null;
    const read = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

    const workerMeshId = read(settings.meshNodeFor);
    if (workerMeshId) {
        const nodeId = read(settings.meshNodeId);
        return { meshId: workerMeshId, ...(nodeId ? { nodeId } : {}), isCoordinator: false };
    }

    const coordinatorMeshId = read(settings.meshCoordinatorFor);
    if (coordinatorMeshId) return { meshId: coordinatorMeshId, isCoordinator: true };

    return null;
}

/**
 * Append the `session_stopped` ledger entry for a terminated mesh session.
 *
 * Best-effort by construction: a ledger write must never propagate back into the
 * PTY exit path and turn an observability gap into a crash. Import is dynamic to
 * match `recordIntentionalMeshSessionStop` and keep the mesh ledger out of the
 * adapter's static import graph.
 */
export async function recordMeshSessionTerminationStop(
    input: MeshSessionTerminationLedgerInput,
): Promise<void> {
    if (!input.meshId || !input.sessionId) return;
    try {
        const { appendLedgerEntry } = await import('./mesh-ledger.js');
        appendLedgerEntry(input.meshId, {
            kind: 'session_stopped',
            ...(input.nodeId ? { nodeId: input.nodeId } : {}),
            sessionId: input.sessionId,
            ...(input.providerType ? { providerType: input.providerType } : {}),
            payload: buildMeshTerminationStopPayload(input),
        });
    } catch (e: any) {
        LOG.warn('MeshTermination', `Failed to record termination stop for ${input.sessionId}: ${e?.message || e}`);
    }
}
