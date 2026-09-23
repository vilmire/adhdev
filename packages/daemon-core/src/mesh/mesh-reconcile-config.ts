// ---------------------------------------------------------------------------
// mesh-reconcile-config — reconcile-loop timing tunables + env resolvers
// ---------------------------------------------------------------------------
// Originally extracted from mesh-reconcile-loop.ts (A-3 god-module decomposition,
// pure move, no behavior change). Holds loop-cadence tunables and their
// env-override resolvers, PLUS tunables for schedulers that run ALONGSIDE the
// reconcile tick but are NOT part of it (e.g. the continuous auto-fast-forward
// scanner — see mesh-auto-fast-forward.ts). Each resolver reads MESH_*_MS from
// the environment and clamps the value so a mis-set env cannot make the loop (or
// a sibling scheduler) pathological. Single-consumer deadline constants that
// live next to their sole reader (e.g. ASSIGNED_STRANDED_DEADLINE_MS,
// STRICT_SESSION_MATCH_TTL_MS) intentionally stay in mesh-reconcile-loop.ts —
// only the shared loop-cadence tunables (and other cross-file scheduler
// tunables promoted here for the same reason) live in this file. Not every
// timing constant in the mesh package lives here — this module is a place for
// tunables that benefit from a shared, audited env-clamp pattern, not a
// mandatory registry.
// ---------------------------------------------------------------------------

import { readNonEmptyString } from './mesh-events-utils.js';
import { resolveTunedReconcileMs } from './mesh-reconcile-acked-hold.js';

// Default reconcile cadence. approval/completion notifications to a live CLI
// coordinator land within at most one interval. Overridable via env for tuning.
export const DEFAULT_RECONCILE_INTERVAL_MS = 4_000;

// PHASE 5 (auto-prune) conservative age gate. A direct dispatch whose node/session is
// orphaned (no longer in the live mesh) is only auto-pruned once it is at least this old,
// measured from its dispatch time. This protects against a node/session that is only
// *transiently* invisible (a momentary probe failure, a daemon restart) being pruned the
// instant it disappears. The MANUAL prune (mesh_prune_stale_direct) has no age gate — an
// operator pruning explicitly wants the orphan gone now. Overridable via env for tuning.
export const DEFAULT_AUTO_PRUNE_MIN_AGE_MS = 24 * 60 * 60_000; // 24h

// The orphan age gate is 24h, so reclassifying the same six-kind ledger snapshot every
// 4s cannot improve safety or materially reduce cleanup latency. Once per minute bounds
// the extra delay to <0.07% of the conservative gate while removing 15 redundant passes.
export const DEFAULT_AUTO_PRUNE_INTERVAL_MS = 60_000; // 1m

export function resolveAutoPruneMinAgeMs(): number {
    const raw = readNonEmptyString(process.env.MESH_AUTO_PRUNE_MIN_AGE_MS);
    if (raw) {
        const parsed = Number.parseInt(raw, 10);
        // Clamp to [1h, 30d] so a mis-set env can't make the gate pathologically aggressive
        // (prune the moment something blinks) or effectively disable it forever.
        if (Number.isFinite(parsed) && parsed >= 60 * 60_000 && parsed <= 30 * 24 * 60 * 60_000) return parsed;
    }
    return DEFAULT_AUTO_PRUNE_MIN_AGE_MS;
}

// PTY-OVERTRUST-DRAIN (Defect B, fix B). Age-based escape for the
// `generating_no_idle_coordinator` hold. Fix A makes the drain predicate read the RAW
// adapter (mask-stripped), so the common mask-driven false-busy is gone. But a hold can
// still arise from a genuine status-source desync that fix A does not reach (e.g. the
// adapter raw itself momentarily reads generating while the coordinator is actually at a
// turn end). This is a TIME-BASED BACKSTOP: when a mesh's pending terminal events have
// been held this long, re-confirm the coordinator's RAW adapter idle on the tick and, if
// it is genuinely idle, drain ONCE. It NEVER injects into a genuinely-generating PTY —
// the re-confirmation gates on raw adapter idle, so the intentional removal of
// force-inject-into-generating (data-loss) is preserved. Default 12s = 3 reconcile ticks
// at the 4s cadence: long enough that a normal mid-turn settle is not pre-empted, short
// enough that a desync-stranded completion is not held for minutes. Env-tunable.
export const DEFAULT_PENDING_HELD_DRAIN_ESCALATE_MS = 12_000;

export function resolvePendingHeldDrainEscalateMs(): number {
    // Floor 4s (one tick) so a mis-set env cannot make the escape race a normal settle;
    // ceiling 5min so it cannot be disabled into a permanent strand.
    return resolveTunedReconcileMs('MESH_PENDING_HELD_DRAIN_ESCALATE_MS', DEFAULT_PENDING_HELD_DRAIN_ESCALATE_MS, 4_000, 5 * 60_000);
}

// HOLD-CEILING. Hard upper bound on how long a terminal completion may sit in the
// `generating_no_idle_coordinator` hold before it is surfaced OUT-OF-BAND.
//
// The age-escape above has no ceiling of its own: it re-fires every tick once the
// event passes the 12s escalate threshold, but every one of those attempts is gated
// on reconfirmGenuinelyIdleCoordinators() reading the coordinator's RAW PTY as idle.
// A coordinator that is conversationally idle — parked waiting on an owner answer —
// still holds an OPEN PTY turn, so getDrainStatus() reads 'generating' and the escape
// is refused on every tick, forever. Measured worst case: a terminal completion held
// 873s (14m33s).
//
// This ceiling does NOT loosen that gate. Injecting into a genuinely-generating PTY
// is the data-loss path that was deliberately removed and stays removed. Instead,
// past the ceiling the loop stops treating PTY injection as the only delivery route
// and records the event to the out-of-band surface (an `event_held` ledger entry with
// reason `hold_ceiling_exceeded`), which mesh_status already projects through
// `pendingCoordinatorEvents` on the coordinator's very next tool call — a path that
// does not depend on PTY state at all. The event itself stays queued and still
// delivers normally the moment the PTY genuinely idles; the surface is ADDITIVE.
//
// Default 120s = 10× the escalate threshold: long enough that an ordinary mid-turn
// hold or a brief owner round-trip is never escalated, short enough that a
// conversationally-parked coordinator surfaces the completion in the same working
// session rather than a quarter-hour later.
export const DEFAULT_PENDING_HELD_CEILING_MS = 120_000;

export function resolvePendingHeldCeilingMs(): number {
    // Floor 12s (the escalate default) so the ceiling can never precede the ordinary
    // escape and pre-empt a normal settle; ceiling 30min so it cannot be tuned into
    // the unbounded hold this exists to eliminate.
    return resolveTunedReconcileMs('MESH_PENDING_HELD_CEILING_MS', DEFAULT_PENDING_HELD_CEILING_MS, 12_000, 30 * 60_000);
}

export function resolveReconcileIntervalMs(): number {
    const raw = readNonEmptyString(process.env.MESH_RECONCILE_INTERVAL_MS);
    if (raw) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 60_000) return parsed;
    }
    return DEFAULT_RECONCILE_INTERVAL_MS;
}

// ---------------------------------------------------------------------------
// Continuous auto-fast-forward SCHEDULER (own timer, NOT the reconcile tick)
// ---------------------------------------------------------------------------
// P6 (2026-09-23 IPC-load audit, finding 6): the continuous auto-ff scan used to
// run INSIDE the 4s reconcile tick, awaited serially — one P2P dry-run per remote
// base node, every ~4s subject only to a 45s per-node cooldown. Measured: 15,177
// of 16,040 logged P2P mesh sends over ~3.5 days (94.6%, ~4,300/day, ~1.2s each),
// 23% of daemon log lines, and the 13-34s event-loop spikes coincided with this
// traffic. Two changes:
//   1. The scan now runs on its OWN scheduler (see startContinuousAutoFastForwardScheduler
//      in mesh-auto-fast-forward.ts) — never awaited by the reconcile tick — so a
//      slow/degraded peer cannot stall queue-claim or event-pull phases.
//   2. Per-node backoff GROWS when a dry-run reports nothing to do (no upstream
//      movement), instead of re-polling every fixed interval forever. This is the
//      dominant cost: most dry-runs are no-ops (nothing changed since last scan).

// Base interval between successive scans of a single node's backoff cursor. Same
// order of magnitude as the historical 45s cooldown, so a genuinely-behind node is
// still caught up within roughly one tick of it falling behind. Only a node whose
// LAST scan was a confirmed no-op backs off past this floor.
export const DEFAULT_AUTO_FF_SCAN_BASE_MS = 45_000; // 45s

// Ceiling for the exponential backoff below. 10 minutes bounds the worst-case
// staleness of a long-idle, never-changing remote base node while still keeping
// the eventual catch-up latency well inside a normal work session.
export const DEFAULT_AUTO_FF_SCAN_MAX_MS = 10 * 60_000; // 10m

// Multiplier applied per consecutive confirmed-no-op round: 45s → 90s → 180s →
// 360s → 600s(capped). Any round that finds real movement (or executes an ff)
// resets the node back to the base interval — see noteAutoFastForwardScanResult.
export const AUTO_FF_SCAN_BACKOFF_MULTIPLIER = 2;

export function resolveAutoFastForwardScanBaseMs(): number {
    // Floor 5s so a mis-set env cannot turn this into a busy-loop; ceiling 5min so
    // the base itself cannot be tuned past the max below (resolveAutoFastForwardScanMaxMs
    // still wins as the hard ceiling regardless).
    return resolveTunedReconcileMs('MESH_AUTO_FF_SCAN_BASE_MS', DEFAULT_AUTO_FF_SCAN_BASE_MS, 5_000, 5 * 60_000);
}

export function resolveAutoFastForwardScanMaxMs(): number {
    // Floor = the base default, so the ceiling can never be tuned below the floor
    // it bounds; ceiling 1h so a mis-set env cannot disable catch-up altogether.
    return resolveTunedReconcileMs('MESH_AUTO_FF_SCAN_MAX_MS', DEFAULT_AUTO_FF_SCAN_MAX_MS, DEFAULT_AUTO_FF_SCAN_BASE_MS, 60 * 60_000);
}

// Per-call budget for a single remote fast_forward_mesh_node dry-run dispatch.
// Bounds a slow/degraded peer so it cannot stall the scheduler tick for other
// nodes — see runAutoFastForwardScanTick's per-node Promise.race in
// mesh-auto-fast-forward.ts. Below the historical measured ~1.2s typical
// round-trip there would be false timeouts on a healthy peer, so the floor
// leaves ample headroom.
export const DEFAULT_AUTO_FF_CALL_TIMEOUT_MS = 8_000; // 8s

export function resolveAutoFastForwardCallTimeoutMs(): number {
    // Floor 2s (still >> the ~1.2s measured healthy round-trip) so the timeout
    // cannot be tuned into spurious failures; ceiling 60s so a mis-set env cannot
    // let one stuck peer occupy the scheduler for a full minute per node.
    return resolveTunedReconcileMs('MESH_AUTO_FF_CALL_TIMEOUT_MS', DEFAULT_AUTO_FF_CALL_TIMEOUT_MS, 2_000, 60_000);
}

// Per-tick wall-clock budget for the reconcile tick's remote-RPC-awaiting phases
// (PHASE 1 pullRemoteNodeQueues). A daemon whose LAST pull took longer than this
// is skipped until the NEXT tick rather than awaited again immediately — see
// mesh-remote-event-pull.ts's per-daemon last-duration tracking. This bounds one
// slow/degraded daemon's ability to stretch every tick for every OTHER daemon's
// pull, without changing delivery semantics (a skipped pull just retries next
// tick; the remote queue is unaffected).
export const DEFAULT_REMOTE_PULL_SLOW_DAEMON_SKIP_MS = 3_000; // 3s

export function resolveRemotePullSlowDaemonSkipMs(): number {
    // Floor 500ms so a mis-set env cannot make every daemon look "slow"; ceiling
    // equal to the reconcile interval ceiling (60s) so a mis-set env cannot make
    // the skip threshold exceed a whole tick's worth of budget anyway.
    return resolveTunedReconcileMs('MESH_REMOTE_PULL_SLOW_DAEMON_SKIP_MS', DEFAULT_REMOTE_PULL_SLOW_DAEMON_SKIP_MS, 500, 60_000);
}
