/**
 * A6-SILENT-REFUSAL — why an atomic claim declined to hand out a task, and the per-node
 * marker for a claim that was deferred (rather than decided) by the auto-fast-forward lease.
 *
 * Both clusters live here rather than in their consumers because both consumers
 * (mesh-runtime-store, mesh-queue-assignment) are frozen file-size baseline entries, and
 * because this module is a dependency-free leaf: pure types plus one Map. It must NOT import
 * from either consumer — they import from it, so the pair would cycle.
 *
 * ── Why the refusal reasons exist ────────────────────────────────────────────────────────
 * `claimNextQueueTask` evaluates nine independent per-candidate predicates plus two
 * pre-checks, and every one of them used to funnel into a single bare `return null`. The
 * caller (`tryAssignQueueTask`) then did `if (!task) return false` — also silent. A task that
 * could NEVER claim was therefore indistinguishable from one with simply no work waiting:
 * nothing in the logs, the ledger, or `mesh_view_queue` told them apart.
 *
 * Live cost (2026-08-20): a task sat pending against an idle zero-message session while the
 * drain silently refused it every ~4s. Diagnosis meant re-deriving all nine predicates by
 * hand against live state.
 *
 * These reasons are DIAGNOSTIC ONLY. They never change whether a claim succeeds.
 */

/** The gate that refused a claim. One value per predicate — collapsing two onto a shared
 *  string would restore the exact ambiguity this type exists to remove. */
export type MeshClaimRefusalReason =
    /** No pending row was offered by the candidate SELECT at all (an empty queue, or every
     *  row already assigned/terminal). Not a gate — the normal idle case, and deliberately
     *  NOT reported by recordClaimRefusal, which would otherwise fire on every idle tick. */
    | 'no_pending_candidates'
    /** This session already holds an active assignment (one task per session). */
    | 'session_already_assigned'
    /** The node's capability tags don't cover the task's requiredTags. Permanent until the
     *  task is retagged or a node advertising those tags joins the mesh. */
    | 'required_tags_unsatisfied'
    /** A `dependsOn` entry is not yet completed, or a system blockedReason is stamped. */
    | 'dependencies_unsatisfied'
    /** The task's `notBefore` gate has not elapsed. */
    | 'not_before_delayed'
    /** PIN-PARKING: the row awaits a coordinator decision and no daemon may claim it. */
    | 'task_parked'
    /** A base-only convergence task cannot be claimed by a worktree-clone session. */
    | 'convergence_target_is_worktree'
    /** The row is pinned to a different node/session than the one claiming. */
    | 'target_pin_unmatched'
    /** The claiming session's slot/model does not clear the task's difficulty floor. */
    | 'difficulty_floor_unmet'
    /** The (daemon, provider) or per-slot maxParallel cap is already consumed. */
    | 'parallel_cap_reached'
    /** A write task cannot claim a node that already holds an active assignment.
     *  NOTE: a STALE `assigned` row (a stranded task that never reached a terminal state)
     *  pins a node here indefinitely and silently blocks every later claim. The bounded
     *  `reclaimStrandedAssignedTask` net is what recovers it; this reason is what makes the
     *  condition visible while it persists. */
    | 'node_busy_with_active_assignment';

/** Sink passed in by a caller that wants to know why a claim returned null; mutated in place
 *  by `claimNextQueueTask`. Omitting it preserves the exact prior behavior. */
export interface MeshClaimRefusal {
    reason?: MeshClaimRefusalReason;
    /** Free-form context (e.g. which candidate got furthest). Ids/counts only — never task
     *  or chat CONTENT, since this reaches logs and the ledger. */
    detail?: string;
}

/**
 * Run an ordered gate chain over claim candidates, returning the first candidate that clears
 * every gate — or, when none does, the reason the candidate that got FURTHEST was refused.
 *
 * Split out of `claimNextQueueTask` (a frozen file-size baseline entry) as a pure function:
 * it holds no state and touches no database. The gate ORDER and short-circuit semantics are
 * the caller's to define and are preserved exactly — this only records which gate said no.
 *
 * "Deepest" rather than "first" because with several pending rows the interesting reason is
 * the one closest to claiming, not whichever row happened to be scanned first (typically an
 * unrelated tag or target mismatch that says nothing about why the queue is stuck).
 */
export function selectClaimCandidate<T>(
    candidates: readonly T[],
    gates: ReadonlyArray<{ reason: MeshClaimRefusalReason; test: (candidate: T) => boolean }>,
): { entry: T } | { entry?: undefined; reason: MeshClaimRefusalReason; deepest?: T } {
    let deepestIndex = -1;
    let deepestReason: MeshClaimRefusalReason | undefined;
    let deepest: T | undefined;
    for (const candidate of candidates) {
        const failedAt = gates.findIndex(gate => !gate.test(candidate));
        if (failedAt === -1) return { entry: candidate };
        if (failedAt > deepestIndex) {
            deepestIndex = failedAt;
            deepestReason = gates[failedAt].reason;
            deepest = candidate;
        }
    }
    return { reason: deepestReason ?? 'no_pending_candidates', ...(deepest !== undefined ? { deepest } : {}) };
}

// ── AUTOLAUNCH-DEFERRED-CLAIM ────────────────────────────────────────────────────────────
// Per-(mesh,node) marker: the LAST claim attempt on this node was refused by the auto-ff
// workspace lease rather than by any decision about the task itself.
//
// The local auto-launch path makes exactly ONE claim attempt — an inline tryAssignQueueTask
// right after launch_cli returns — and `agent:ready` does not drive a claim for a locally
// launched session. So a claim lost to the lease is lost for the whole 90s await-claim window
// (then 90→180→360s of backoff) unless the guard is told to re-drive. Observed live: launch at
// 23:34:07.779, deferral at 23:34:07.780, no claim ever, while the session sat idle at zero
// messages and the task sat pending.
//
// Deliberately per-NODE, not per-task: the lease is keyed by WORKSPACE and refuses every claim
// touching it, so the node — not any single task — is what was blocked. Keyed to a COUNT rather
// than a boolean so the retry is bounded: an ff that keeps re-acquiring the lease (a repo
// perpetually behind upstream) must not spin the re-drive forever. Past the cap the task falls
// back to the ordinary await-claim window, which is the pre-existing behavior.
const claimDeferredByFastForward = new Map<string, number>();

/** Bounded re-drive budget per (mesh, node). A reconcile tick is ~4s and a local ff dry-run is
 *  sub-second, so a handful of attempts spans far more than a normal ff needs; beyond that it
 *  is not a transient lease overlap and should not keep bypassing the window. */
export const MAX_FAST_FORWARD_CLAIM_REDRIVES = 3;

/** Bound on the marker map, mirroring the sibling auto-launch de-dup maps. */
const CLAIM_DEFERRAL_MAX_ENTRIES = 2000;

function claimDeferralKey(meshId: string, nodeId: string): string {
    return `${meshId}::${nodeId}`;
}

/** Record that the ff lease — not a task-level gate — refused this node's claim. */
export function noteClaimDeferredForNode(meshId: string, nodeId: string): void {
    if (!nodeId) return;
    const key = claimDeferralKey(meshId, nodeId);
    claimDeferredByFastForward.set(key, (claimDeferredByFastForward.get(key) || 0) + 1);
    // Bound memory: drop the oldest insertion (Map preserves insertion order). A dropped
    // marker only forgoes one re-drive, which degrades to the pre-existing window behavior.
    if (claimDeferredByFastForward.size > CLAIM_DEFERRAL_MAX_ENTRIES) {
        const oldest = claimDeferredByFastForward.keys().next().value;
        if (oldest !== undefined) claimDeferredByFastForward.delete(oldest);
    }
}

/** Does this node have an ff-deferred claim still owed a re-drive (within the budget)? */
export function claimDeferralOwedForNode(meshId: string, nodeId: string): boolean {
    if (!nodeId) return false;
    const seen = claimDeferredByFastForward.get(claimDeferralKey(meshId, nodeId)) || 0;
    return seen > 0 && seen <= MAX_FAST_FORWARD_CLAIM_REDRIVES;
}

/**
 * Should the auto-launch await-claim guard re-drive a claim for this (node, session) right now?
 *
 * True only when ALL of:
 *   - both ids are known (a re-drive needs a concrete target);
 *   - this node has an ff-deferred claim still owed a re-drive within the budget;
 *   - the lease is NOT currently held — checked through the caller-supplied probe, so this
 *     module stays free of an import back to the auto-fast-forward module. A still-held lease
 *     leaves the marker in place and simply waits for the next ~4s tick.
 */
export function shouldRedriveDeferredClaim(
    meshId: string,
    nodeId: string,
    sessionId: string,
    leaseHeld: () => boolean,
): boolean {
    if (!nodeId || !sessionId) return false;
    if (!claimDeferralOwedForNode(meshId, nodeId)) return false;
    return !leaseHeld();
}

/** Clear the marker once the node claims (or the re-drive budget is spent). */
export function clearClaimDeferralForNode(meshId: string, nodeId: string): void {
    if (!nodeId) return;
    claimDeferredByFastForward.delete(claimDeferralKey(meshId, nodeId));
}

/** @internal Test-only: reset the ff-deferred claim tracking between cases. */
export function __resetClaimDeferralForTests(): void {
    claimDeferredByFastForward.clear();
}
