import { LOG } from '../logging/logger.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue.js';

// ---------------------------------------------------------------------------
// AUTOLAUNCH-DISPATCH-CAP: the durable circuit breaker on the TRANSPORT-failure
// axis of auto-launch, sibling to AUTO_LAUNCH_UNCLAIMED_SPAWN_CAP
// (mesh-autolaunch-spawn-cap.ts).
//
// The gap this closes. recordTaskAutoLaunchDispatchFailure (mesh-autolaunch-
// spawn-budget.ts) increments `autoLaunchDispatchFailedCount` on every launch
// dispatch that died inside THIS coordinator's own transport layer — before a
// session ever existed anywhere — and DELIBERATELY spends no spawn budget,
// because charging transport failures to the unclaimed-session cap was itself
// the 2026-09-17 incident (a 26-minute signalling outage burned two healthy
// nodes' entire budgets with zero sessions created). That fix was correct on
// its own terms, but it left `autoLaunchDispatchFailedCount` read ONLY
// diagnostically (mesh-skip-notify.ts's resolveSpawnCapCause, to pick the
// right park-page copy) — nothing ever caps IT. A task whose every launch
// dies in transport (autoLaunchUnclaimedCount stays 0 because no session is
// ever created) never reaches maybeParkSpawnCappedTask at all, so it has NO
// durable backstop and can retry forever.
//
// Live measurement (2026-10-10): autoLaunchDispatchFailedCount climbed to 106
// over 21 minutes against "Peer signaling is temporarily unavailable" /
// auto_launch_cooldown, with a flat 5s cooldown between attempts and no cap,
// until a human cancelled it by hand. This is the unbounded-retry extreme;
// AUTO_LAUNCH_UNCLAIMED_SPAWN_CAP already solved the OTHER extreme (an
// unclaimed-session loop) — this module is the missing counterpart.
//
// Design mirrors mesh-autolaunch-spawn-cap.ts deliberately: same park/skip
// plumbing (parkTaskTargetPin, mesh_view_queue's parkedTasks, the 24h
// retention sweep, requeue-unparks-and-resets), same durability rationale (a
// crash/restart must not reset the counter — see that module's header), same
// reset lifecycle (already shared: both counters reset together on claim
// success and on requeue — mesh-runtime-store-claim.ts, mesh-work-queue.ts).
// The one deliberate difference is the budget size: a dispatch failure proves
// LESS than an unclaimed session (it never left this process), so legitimate
// transient flake — one bad reconnect window — must not park a task that
// would succeed on the very next tick once signalling recovers. The cap is
// therefore sized generously relative to the unclaimed-session cap (10 vs 5),
// and is backed by exponential backoff (see resolveDispatchFailureBackoffMs)
// so the SAME transient-flake case also stops hammering the transport layer
// long before it ever reaches the cap.
// ---------------------------------------------------------------------------

/**
 * Transport-layer launch-dispatch failures a single task may accumulate
 * (since its last successful claim) before it parks.
 *
 * Sized larger than AUTO_LAUNCH_UNCLAIMED_SPAWN_CAP (5): a dispatch failure is
 * weaker evidence of a structural problem than an unclaimed session — it can
 * be one flaky reconnect window — so this axis tolerates more attempts before
 * giving up, while the backoff (resolveDispatchFailureBackoffMs) ensures those
 * attempts are not all spent in the first couple of minutes.
 */
export const AUTO_LAUNCH_DISPATCH_FAILURE_CAP = 10;

/** Park + skip reason for a task that exhausted its durable dispatch-failure budget. */
export const DISPATCH_FAILURE_CAP_PARK_REASON = 'auto_launch_dispatch_failure_cap_parked';

/** The task's durable count of transport-layer dispatch failures (legacy rows → 0). */
export function autoLaunchDispatchFailureCount(task: Pick<MeshWorkQueueEntry, 'autoLaunchDispatchFailedCount'>): number {
    const count = task.autoLaunchDispatchFailedCount;
    return typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : 0;
}

/**
 * Park the task when its durable dispatch-failure budget is exhausted; returns
 * true when the caller must stop processing it this tick.
 *
 * Call site discipline mirrors maybeParkSpawnCappedTask: run it at the point
 * where the alternative is firing yet another dispatch. Unlike the spawn cap,
 * this one is NOT gated behind the await-claim guard — a dispatch failure
 * never creates a session, so there is no in-flight claim to protect.
 */
export function maybeParkDispatchFailureCappedTask(
    meshId: string,
    task: MeshWorkQueueEntry,
    park: (meshId: string, taskId: string, opts: { reason: string; allowUntargeted: boolean }) => MeshWorkQueueEntry | null,
    markSkip: (reason: string) => void,
): boolean {
    const count = autoLaunchDispatchFailureCount(task);
    if (count < AUTO_LAUNCH_DISPATCH_FAILURE_CAP) return false;
    const parked = park(meshId, task.id, { reason: DISPATCH_FAILURE_CAP_PARK_REASON, allowUntargeted: true });
    if (parked) {
        LOG.warn('MeshQueue', `AUTOLAUNCH-DISPATCH-CAP: task ${task.id} (mesh ${meshId}) recorded ${count} launch dispatch failures inside this coordinator's own transport layer (cap ${AUTO_LAUNCH_DISPATCH_FAILURE_CAP}), with NO session ever created — PARKED. `
            + 'No further dispatch attempts will be made; the coordinator is paged. mesh_queue_requeue unparks it and resets the budget.');
    }
    markSkip(DISPATCH_FAILURE_CAP_PARK_REASON);
    return true;
}

/**
 * Exponential backoff for the cooldown between launch-dispatch attempts on the
 * SAME node, keyed off how many transport failures this task has already
 * accumulated. Replaces the flat AUTO_LAUNCH_COOLDOWN_MS(5s) used uniformly
 * regardless of failure history — the flat cooldown is exactly what let 106
 * failures accumulate in 21 minutes (≈12s/attempt average, all against the
 * same "temporarily unavailable" signalling state).
 *
 * Capped at 5 minutes: long enough that a genuine signalling outage is not
 * hammered, short enough that recovery is still noticed promptly once the cap
 * above (10 failures, several minutes in even at the capped backoff) hasn't
 * yet been reached.
 */
export function resolveDispatchFailureBackoffMs(failureCount: number, baseMs: number): number {
    const CAP_MS = 5 * 60_000;
    const exponent = Math.max(0, Math.min(failureCount, 10));
    return Math.min(CAP_MS, baseMs * 2 ** exponent);
}

/** Bundles the re-read-after-record + backoff math the dispatch-failure catch
 *  site needs into one call, so that call site stays a one-liner. `getEntry`
 *  is injected (mesh-work-queue's getQueueEntryById) to keep this module a leaf. */
export function resolveCooldownUntilAfterDispatchFailure(
    meshId: string,
    taskId: string,
    baseMs: number,
    getEntry: (meshId: string, taskId: string) => MeshWorkQueueEntry | null,
    fallbackTask: MeshWorkQueueEntry,
): number {
    const freshCount = autoLaunchDispatchFailureCount(getEntry(meshId, taskId) ?? fallbackTask);
    return Date.now() + resolveDispatchFailureBackoffMs(freshCount, baseMs);
}
