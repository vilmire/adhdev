// ---------------------------------------------------------------------------
// mesh-reconcile-config — reconcile-loop timing tunables + env resolvers
// ---------------------------------------------------------------------------
// Extracted from mesh-reconcile-loop.ts (A-3 god-module decomposition, pure move,
// no behavior change). Holds the loop-cadence tunables and their env-override
// resolvers. Each resolver reads MESH_*_MS from the environment and clamps the
// value so a mis-set env cannot make the loop pathological. Single-consumer
// deadline constants that live next to their sole reader (e.g.
// ASSIGNED_STRANDED_DEADLINE_MS, STRICT_SESSION_MATCH_TTL_MS) intentionally stay
// in mesh-reconcile-loop.ts — only the shared loop-cadence tunables move here.
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
