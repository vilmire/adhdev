import { LOG } from '../logging/logger.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue.js';

// ---------------------------------------------------------------------------
// AUTOLAUNCH-SPAWN-CAP (P3): the durable circuit breaker on auto-launch.
//
// The incident this closes (2026-09-08~09, 8.8h, ~300 launches for a handful of
// tasks). A task can enter a launch/claim MISMATCH: the launch-side selector is
// willing to spawn a session for it, but the claim-side gate (nine distinct
// refusal predicates in claimNextQueueTask) refuses every session that shows up.
// Each spawned session idles, never claims, and the reconcile loop spawns the
// next one. P1/P2 removed one seed of that mismatch (the difficulty-floor skew),
// but any of the OTHER claim predicates can reproduce the same class — so the
// terminal defense must be reason-agnostic: "N launches with no successful claim
// → stop launching and hand the task to the coordinator."
//
// ★ Why the counter is DURABLE (persisted on the task row), not in-memory. The
// incident's self-amplifying loop was:
//
//   launch loop → session pileup → EMFILE crash → daemon restart
//     → every in-memory brake (backoff maps, cooldowns, dedup) resets
//     → re-ignition (measured: 127 launches in the first 27 minutes)
//
// The existing autoLaunchAwaitClaimBackoff DID partially brake the loop — and
// evaporated on the crash it caused. A counter that rides in the task row's
// payload JSON (mesh_queue.payload, so no schema migration; absent on legacy
// rows → 0) survives the restart, which is the entire point of P3.
//
// ★ Reset discipline — the false-positive risk. A healthy task must never park:
//   - CLAIM SUCCESS resets the counter (claimNextQueueTask, the single choke
//     point every claim path funnels through — idle drain, inline launch claim,
//     remote agent:ready claim, deferred-claim redrive, direct-delivery
//     fallback all end there). Normal launch→claim cycles therefore never
//     accumulate anything.
//   - REQUEUE resets the counter (requeueTask, both paths — the same explicit
//     coordinator decision that unparks a row). Without this, requeueing a
//     spawn-cap-parked task would be a dead exit: the row unparks with its
//     budget still exhausted and re-parks on the next launch attempt.
// A crash-and-restart deliberately does NOT reset it — that is the loop.
//
// Parking reuses the PIN-PARKING structure wholesale (mesh-task-parking.ts):
// the row stays pending but claimable by nobody (`task_parked` claim gate), it
// is listed under parkedTasks in mesh_view_queue, any mesh_queue_requeue unparks
// it, and the 24h retention sweep fails it WITH a notification rather than
// silently dropping it. The coordinator is paged at park time on the same
// mesh:dispatch_blocked channel (SPAWN_CAP_PARK_REASON is registered as an
// actionable skip in mesh-skip-notify).
//
// This module is a LEAF (type-only import of mesh-work-queue): the park mutator
// is INJECTED by the caller, exactly like parkExpiredTargetPin in
// mesh-task-parking — mesh-work-queue imports this module's reason constant via
// mesh-task-parking, so a value import back would close a cycle.
// ---------------------------------------------------------------------------

/**
 * Launches-without-a-claim a single task may consume before it parks.
 *
 * Sizing. Every counted unit is a FULL failed cycle: a real session spawn whose
 * claim never landed, already paced by the await-claim window and its backoff
 * (90 → 180 → 360s) plus the direct-delivery fallback — so five units is many
 * minutes of provably unproductive spawning, not five quick ticks. Transient
 * flake (a remote dispatch failure, a session that died mid-boot) legitimately
 * burns one or two units and then a successful claim resets the budget to zero;
 * only a task NO launch ever claims can reach the cap. The runaway this guards
 * against burned 300 launches — 60× the cap — and parking is fully recoverable
 * (one mesh_queue_requeue restores a fresh budget), so erring tight is safe.
 */
export const AUTO_LAUNCH_UNCLAIMED_SPAWN_CAP = 5;

/** Park + skip reason for a task that exhausted its durable spawn budget. */
export const SPAWN_CAP_PARK_REASON = 'auto_launch_spawn_cap_parked';

/** The task's durable count of launches since its last successful claim (legacy rows → 0). */
export function autoLaunchUnclaimedSpawnCount(task: Pick<MeshWorkQueueEntry, 'autoLaunchUnclaimedCount'>): number {
    const count = task.autoLaunchUnclaimedCount;
    return typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : 0;
}

/**
 * Park the task when its durable spawn budget is exhausted; returns true when the
 * caller must stop processing it this tick (i.e. it is spawn-cap-parked).
 *
 * Call site discipline: this runs AFTER the await-claim guard in the auto-launch
 * scan, at the point where the alternative is firing yet another launch. That
 * ordering is load-bearing for false positives — a launch whose claim is still
 * legitimately in flight is protected by the await-claim window/backoff and never
 * reaches this check, so a would-succeed claim is never killed by a park.
 *
 * `park` is the injected parkTaskTargetPin (with allowUntargeted — a runaway task
 * usually has no target pin). It is idempotent and 'pending'-only, so a row that
 * raced into another state is left untouched (park returns null → we still report
 * capped=true and record the skip; the row's own state machine wins).
 */
export function maybeParkSpawnCappedTask(
    meshId: string,
    task: MeshWorkQueueEntry,
    park: (meshId: string, taskId: string, opts: { reason: string; allowUntargeted: boolean }) => MeshWorkQueueEntry | null,
    markSkip: (reason: string) => void,
): boolean {
    const count = autoLaunchUnclaimedSpawnCount(task);
    if (count < AUTO_LAUNCH_UNCLAIMED_SPAWN_CAP) return false;
    const parked = park(meshId, task.id, { reason: SPAWN_CAP_PARK_REASON, allowUntargeted: true });
    if (parked) {
        LOG.warn('MeshQueue', `AUTOLAUNCH-SPAWN-CAP: task ${task.id} (mesh ${meshId}) recorded ${count} auto-launches with no successful claim (cap ${AUTO_LAUNCH_UNCLAIMED_SPAWN_CAP}) — PARKED. `
            + 'No further sessions will be spawned for it; the coordinator is paged. mesh_queue_requeue unparks it and resets the budget.');
    }
    markSkip(SPAWN_CAP_PARK_REASON);
    return true;
}
