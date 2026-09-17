import { MeshRuntimeStore } from './mesh-runtime-store.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue.js';

// ---------------------------------------------------------------------------
// SPAWN-CAP-TRANSPORT-AWARE: the two durable counters behind the auto-launch spawn cap,
// as standalone mutators.
//
// Why they live HERE rather than in mesh-work-queue.ts: that file sits directly under the
// 2,400-line file-size gate (check:file-sizes) with only ~20 lines of headroom, and this
// pair plus its rationale does not fit. They are a self-contained cluster over one field
// each, needing nothing from mesh-work-queue but the entry type (import type — no value
// import, so no cycle) and the store transaction. `withQueueLock` there is itself only a
// one-line wrapper over MeshRuntimeStore.transaction, reproduced by withEntryLock below.
//
// Why they are separate from recordTaskAutoLaunch at all — the load-bearing reason, not
// just file size. That function's `autoLaunch` write is subject to the winner-clobber
// guards (a late non-winning write must not overwrite an in-window `completed` record,
// AUTOLAUNCH-WINNER-CLOBBER). The COUNTERS must not inherit that suppression:
//
//   - a launch whose record is clobber-suppressed still created a session, so the spawn
//     budget must still be charged — otherwise two racing spawns are billed as one and
//     the runaway cap under-counts exactly when it matters most;
//   - how many dispatches died in transport is independent of which launch happens to own
//     the `autoLaunch` field.
//
// Both counters share one lifecycle: they describe the window "since this task's last
// successful claim", so both reset on claim success (MeshRuntimeStore's claim transaction)
// and on any explicit requeue (mesh-work-queue's requeueTask). The cap that consumes the
// budget, and the 2026-09-08 runaway that motivates its durability, are documented in
// mesh-autolaunch-spawn-cap.ts.
// ---------------------------------------------------------------------------

function withEntryLock<T>(fn: () => T): T {
    return MeshRuntimeStore.getInstance().transaction(fn);
}

export function recordTaskAutoLaunch(
    meshId: string,
    taskId: string,
    autoLaunch: Omit<NonNullable<MeshWorkQueueEntry['autoLaunch']>, 'updatedAt'>,
    opts?: { spendSpawnBudget?: boolean },
): MeshWorkQueueEntry | null {
    return withEntryLock(() => {
        const entry = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
        if (!entry) return null;
        const now = new Date().toISOString();
        // AUTOLAUNCH-SPAWN-CAP (P3): spend one unit of the task's durable spawn budget —
        // but ONLY when the caller asserts a session actually came into existence.
        //
        // ★ SPAWN-CAP-TRANSPORT-AWARE. This used to key off `status === 'started'`, which
        // is written BEFORE the launch dispatch is awaited — i.e. it charged the budget for
        // the mere INTENT to launch, and the failure path never refunded it. Measured live
        // 2026-09-17: a 26-minute coordinator WS reconnect storm degraded P2P signalling,
        // ten `launch_cli` dispatches died at the signalling layer, ZERO sessions were
        // created — and two healthy nodes each burned their full budget and parked. The cap
        // is a launch/claim MISMATCH detector, not a transport-failure amplifier.
        //
        // The flag is an explicit parameter rather than another status string because the
        // only "a launch resolved" records ('failed'/'completed') can both be suppressed by
        // autoLaunchWriteWouldClobberWinner, so a budget decision inferred from the record
        // could silently go missing. The caller states what it knows instead; the module
        // header above covers why the counters are separate from this field at all.
        if (opts?.spendSpawnBudget) {
            entry.autoLaunchUnclaimedCount = (entry.autoLaunchUnclaimedCount ?? 0) + 1;
        }
        entry.autoLaunch = { ...autoLaunch, updatedAt: now };
        MeshRuntimeStore.getInstance().updateQueueEntry(entry);
        return entry;
    });
}

/**
 * Spend one unit of the task's durable spawn budget WITHOUT touching the `autoLaunch` field.
 *
 * Used for the launch whose `autoLaunch` write was suppressed by a clobber guard: the field
 * is protected, the budget is not. See the module header for why those differ.
 */
export function spendTaskAutoLaunchSpawnBudget(meshId: string, taskId: string): MeshWorkQueueEntry | null {
    return withEntryLock(() => {
        const entry = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
        if (!entry) return null;
        entry.autoLaunchUnclaimedCount = (entry.autoLaunchUnclaimedCount ?? 0) + 1;
        MeshRuntimeStore.getInstance().updateQueueEntry(entry);
        return entry;
    });
}

/**
 * Record that a launch dispatch for this task failed inside THIS coordinator's own transport
 * layer, creating no session anywhere.
 *
 * Spends no spawn budget by design — that is the whole point of the 2026-09-17 fix. Its one
 * consumer is diagnostic honesty: the spawn-cap park page reads this counter to name the real
 * failure mode and send the coordinator to its OWN ledger, instead of asserting that sessions
 * were launched and never claimed and sending it to hunt through a healthy node's logs for
 * sessions that never existed (mesh-skip-notify.ts).
 */
export function recordTaskAutoLaunchDispatchFailure(meshId: string, taskId: string): MeshWorkQueueEntry | null {
    return withEntryLock(() => {
        const entry = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
        if (!entry) return null;
        entry.autoLaunchDispatchFailedCount = (entry.autoLaunchDispatchFailedCount ?? 0) + 1;
        MeshRuntimeStore.getInstance().updateQueueEntry(entry);
        return entry;
    });
}
