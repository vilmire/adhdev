/**
 * MESH-ONESHOT-ACK-RETRY: a bounded, idempotency-aware retry for a one-shot
 * P2P mesh command dispatch, scoped to the ONE failure mode that is provably
 * safe to retry.
 *
 * ── The gap this closes ───────────────────────────────────────────────────
 * Live (2026-10-10): an ops script fired `restart_daemon_node` once at a
 * MoltBook node whose ICE link had just dropped. The daemon's own ICE-disconnect
 * detection takes 15-30s to notice and recover; the P2P ACK timeout
 * (mesh-rpc-protocol.ts ACK_TIMEOUT_MS) is a flat 10s. So there is a "blackhole
 * window" — roughly [10s, 30s] after a disconnect — where a command sent lands
 * in neither: it is not yet known-unreachable (so nothing refuses to send it)
 * and it cannot possibly be acknowledged (so it always times out). The script
 * had no retry at all, so once that single shot landed in the blackhole, the
 * command was gone for good — even though the node reconnected and was healthy
 * again within the same ACK deadline that doomed the attempt.
 *
 * ── Why this does NOT become a generic retry-every-command wrapper ─────────
 * restart_daemon_node (and most one-shot mesh commands) are NOT idempotent —
 * resending a command that may have already reached and executed on the peer
 * risks a double-restart, a double-clone, a double-removal. So a retry is only
 * safe when we have POSITIVE PROOF the first attempt never reached a working
 * handler on the peer, not merely "we don't know what happened."
 *
 * That proof exists in exactly one place: mesh-rpc-endpoint.ts's ACK gate.
 * `ACK_TIMEOUT` fires only when the peer never acknowledged receipt within
 * ACK_TIMEOUT_MS — i.e. the command provably never started executing anywhere.
 * `REQUEST_TIMEOUT` (and everything else) means the peer DID ack — it is
 * processing or already finished — so retrying there could duplicate a
 * now-already-applied effect. This module therefore retries ONLY on
 * `meshCode === 'ACK_TIMEOUT'`; every other failure is terminal on first
 * attempt and reported as such, exactly matching "멱등성을 확보할 수 없으면
 * 그 명령은 재발송 대상에서 제외하고 보고하라."
 *
 * ── Why it waits on ICE state instead of just resleeping ──────────────────
 * Firing again immediately (or on a short fixed delay) inside the 10-30s
 * blackhole just produces a second ACK_TIMEOUT — pure waste, exactly the
 * "쏘는 것은 난비다" the task calls out. So before each retry this waits
 * (bounded) for `getMeshPeerConnectionStatus` to report the peer as connected
 * again, and only then re-dispatches — the retry is paced to the signal that
 * actually matters (is the peer back), not to a guessed timer.
 *
 * ── Why it is not shared with autoLaunch's retry (mesh-autolaunch-dispatch-cap.ts) ──
 * Two different problems, not duplicated by accident: autoLaunch is an
 * AUTONOMOUS, already-looping subsystem whose bug was an unbounded retry count
 * (needed: a cap + backoff on its EXISTING loop). This is a ONE-SHOT caller
 * with NO existing loop whose bug was zero retries (needed: a bounded retry
 * loop where none existed). Sharing one helper between "stop looping forever"
 * and "start looping a little" would couple two unrelated lifecycles.
 */
import { P2pRelayFailureError } from '../mesh/p2p-relay-failure.js';
import { isConnectedMeshPeer } from './high-family/mesh-status-view.js';
import { LOG } from '../logging/logger.js';

/** The one meshCode this module will ever retry on — see module header. */
const RETRYABLE_MESH_CODE = 'ACK_TIMEOUT';

/** Attempts beyond the first, i.e. total attempts = 1 + this. Small on purpose:
 *  the blackhole window this exists for is bounded (≤30s), so a couple of
 *  retries spanning it is enough — this is not a general resilience loop. */
const MAX_EXTRA_ATTEMPTS = 2;

/** Upper bound on how long this will wait for the peer to reconnect before a
 *  retry, per attempt. Generous relative to the measured 15-30s ICE recovery
 *  window so a slow-but-real reconnect is still caught. Mutable only for tests
 *  (see __setReconnectWaitMsForTests) — production code never changes it. */
let RECONNECT_WAIT_MS = 25_000;
let RECONNECT_POLL_MS = 500;

/** Test-only: shrink the reconnect wait/poll so a test exercising "peer never
 *  comes back" does not have to burn the real 25s per attempt. Pass no
 *  arguments to restore the production defaults. */
export function __setReconnectWaitMsForTests(waitMs: number = 25_000, pollMs: number = 500): void {
    RECONNECT_WAIT_MS = waitMs;
    RECONNECT_POLL_MS = pollMs;
}

/** True when the meshCode on a rejection is the one provably-safe-to-retry case. */
function isRetryableMeshFailure(err: unknown): boolean {
    if (err instanceof P2pRelayFailureError) return err.meshCode === RETRYABLE_MESH_CODE;
    const code = (err as { meshCode?: unknown } | null | undefined)?.meshCode;
    return code === RETRYABLE_MESH_CODE;
}

/**
 * Wait (bounded) for `getMeshPeerConnectionStatus(daemonId)` to report the peer
 * connected again. Returns true if it reconnected within the wait, false on
 * timeout — the caller still gets to decide whether to try once more anyway
 * (a connection-status getter that is absent or lies fails OPEN here: we do
 * not want a missing diagnostic to permanently block a retry the ACK gate
 * already proved is safe to attempt).
 */
async function waitForPeerReconnect(
    getConnectionStatus: ((daemonId: string) => Record<string, unknown> | null) | undefined,
    daemonId: string,
    waitMs: number,
): Promise<boolean> {
    if (!getConnectionStatus) return true;
    const deadline = Date.now() + Math.max(0, waitMs);
    for (;;) {
        if (isConnectedMeshPeer(getConnectionStatus(daemonId))) return true;
        if (Date.now() >= deadline) return false;
        await new Promise(resolve => setTimeout(resolve, RECONNECT_POLL_MS));
    }
}

export interface OneshotRetryOpts {
    /** Human-readable command name, for logging only. */
    command: string;
    /** The target daemon id, for logging and the reconnect-wait check. */
    daemonId: string;
    /** Bound `getMeshPeerConnectionStatus`, if this daemon exposes it. Optional
     *  by construction — see CommandRouterDeps; a daemon without it still gets
     *  the retry, just without the reconnect-aware pacing (falls back to the
     *  poll interval alone). */
    getConnectionStatus?: (daemonId: string) => Record<string, unknown> | null;
}

/**
 * Run `dispatch()` (a single `dispatchMeshCommand` call) with a bounded,
 * idempotency-aware retry. Retries ONLY when the rejection's meshCode is
 * `ACK_TIMEOUT` (see module header for why that is the sole safe case), up to
 * {@link MAX_EXTRA_ATTEMPTS} extra attempts, waiting for the peer to reconnect
 * (bounded) between attempts rather than firing blind into the blackhole
 * window. Any other failure — including the final attempt's ACK_TIMEOUT —
 * propagates to the caller unchanged (same terminal-state contract as before
 * this wrapper existed; it only ever ADDS retries, never swallows a result).
 */
export async function dispatchMeshOneshotWithAckRetry<T>(
    dispatch: () => Promise<T>,
    opts: OneshotRetryOpts,
): Promise<T> {
    let attempt = 0;
    for (;;) {
        try {
            return await dispatch();
        } catch (err) {
            if (!isRetryableMeshFailure(err) || attempt >= MAX_EXTRA_ATTEMPTS) throw err;
            attempt += 1;
            LOG.warn(
                'MeshOneshotRetry',
                `${opts.command} to ${opts.daemonId.slice(0, 24)} got ACK_TIMEOUT (never reached a working handler — safe to retry); `
                + `waiting up to ${RECONNECT_WAIT_MS}ms for the peer to reconnect before retry ${attempt}/${MAX_EXTRA_ATTEMPTS}.`,
            );
            const reconnected = await waitForPeerReconnect(opts.getConnectionStatus, opts.daemonId, RECONNECT_WAIT_MS);
            if (!reconnected) {
                LOG.warn('MeshOneshotRetry', `${opts.command} to ${opts.daemonId.slice(0, 24)}: peer did not report reconnected within the wait; retrying anyway (attempt ${attempt}/${MAX_EXTRA_ATTEMPTS}).`);
            }
        }
    }
}
