/**
 * REMOTE-READY-WAIT — the readiness barrier for the REMOTE auto-launch path, the symmetric
 * counterpart of `waitForLocalSessionReady` (mesh-queue-assignment.ts) and on the SAME budget.
 *
 * The remote path already RECEIVES the readiness signal and simply never waited for it. A
 * freshly launched remote worker emits `agent:ready`; the coordinator's forwarding handler
 * turns that into a `setRemoteIdleSession` row (mesh-event-forwarding.ts, the `agent:ready`
 * branch). But the remote auto-launch returned `true` the instant `launch_cli` resolved —
 * which means "the spawn was accepted", not "the session can take a prompt". The task was then
 * claimed and dispatched into a session that may still be booting.
 *
 * Why that matters specifically: for the five providers with `emitsPtyTurnEvents: false`
 * (codex-cli, cursor-cli, kimi, opencode, antigravity-cli) a read_chat round trip is the ONLY
 * evidence of life. Dispatching into a not-yet-interactive session therefore starts the 25-40s
 * `delivered_not_consumed_redrive` judgement clock with nothing able to stop it — and that
 * redrive re-claims an idle session WITHOUT recomputing routing, which is how a task silently
 * changes provider (see mesh-redrive-provenance.ts).
 *
 * Worst case is unchanged. On timeout the caller proceeds exactly as it does today,
 * optimistically. Nothing here extends a timeout, relaxes a gate, or alters the local path;
 * the redrive constants (`ASSIGNED_DELIVERED_UNCONSUMED_REDRIVE_MS`,
 * `RECLAIM_UNKNOWN_GRACE_TICKS`) are untouched. The only thing it changes is that the
 * judgement clock stops being started against a session that was never interactive.
 *
 * Split out of mesh-queue-assignment.ts (already near its file-size baseline) with the
 * readiness probe injected, so the barrier is testable without standing up a runtime store.
 */
import { LOG } from '../logging/logger.js';

/**
 * Budget, deliberately identical to the local barrier's LOCAL_LAUNCH_READY_TIMEOUT_MS /
 * LOCAL_LAUNCH_READY_POLL_MS. Symmetry is the point: the remote path should not get a more
 * generous (or stingier) allowance than the local one for the same question.
 */
export const REMOTE_LAUNCH_READY_TIMEOUT_MS = 15_000;
export const REMOTE_LAUNCH_READY_POLL_MS = 100;

export interface RemoteReadyWaitOptions {
    /**
     * Returns true once the launched session's `agent:ready` has landed (canonically: it
     * appears in the remote-idle registry). Must not throw — a throwing probe is treated as
     * "cannot observe" and abandons the wait rather than failing the launch.
     */
    isReady: () => boolean;
    timeoutMs?: number;
    pollMs?: number;
    /** Injectable clock/sleep for deterministic tests. */
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}

/**
 * Wait, bounded, for a remote auto-launched session to report ready.
 *
 * Returns true if readiness was observed within the budget, false on timeout or when there is
 * nothing to observe. The caller proceeds either way — the return value exists for logging and
 * tests, NOT as a gate. This function never throws.
 */
export async function waitForRemoteSessionReady(
    meshId: string,
    nodeId: string,
    sessionId: string | undefined,
    opts: RemoteReadyWaitOptions,
): Promise<boolean> {
    // A remote launch_cli does not always return a session id. With nothing to correlate a
    // ready against, waiting would burn the full budget on a match that can never happen.
    if (!sessionId) return false;
    const timeoutMs = opts.timeoutMs ?? REMOTE_LAUNCH_READY_TIMEOUT_MS;
    const pollMs = opts.pollMs ?? REMOTE_LAUNCH_READY_POLL_MS;
    const now = opts.now ?? (() => Date.now());
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const deadline = now() + timeoutMs;
    for (;;) {
        let ready = false;
        try {
            ready = opts.isReady();
        } catch {
            // Cannot observe readiness (store unavailable / probe failure) → do not hold the
            // 4s auto-launch loop hostage to a diagnostic barrier. Fall straight through to
            // the optimistic path, which is the pre-existing behavior.
            return false;
        }
        if (ready) return true;
        if (now() >= deadline) break;
        await sleep(pollMs);
    }
    LOG.warn('MeshQueue', `Remote auto-launched session ${sessionId} on node ${nodeId} (mesh ${meshId}) did not report agent:ready within ${timeoutMs}ms; proceeding optimistically — unchanged behavior, the claim still fires via the normal event/reconcile path`);
    return false;
}
