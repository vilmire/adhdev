import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { LOG } from '../logging/logger.js';
import { getQueue } from './mesh-work-queue.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue.js';
import { meshNodeIdMatches, daemonIdsEquivalent, sessionIdsEquivalent } from '@adhdev/mesh-shared';
import { readNonEmptyString } from './mesh-events-utils.js';
import { readMeshNodeDaemonId, isMeshNodeHealthLaunchable, isMeshNodeFreshEnoughToLaunch } from './mesh-node-identity.js';
import { queuePendingMeshCoordinatorEvent, retractPendingDispatchBlockedEvent } from './mesh-events-pending.js';
import { isWorktreeBootstrapStaleRunning } from './worktree-bootstrap-config.js';
import { isWithinCloneBootstrapGrace } from './mesh-clone-grace.js';
import { loadConfig } from '../config/config.js';
import { SLOT_MODEL_ABSENT_SKIP_REASON } from './slot-model-enforcement.js';
import { isLocalAutoLaunchNode, resolveSessionBusyVerdict } from './mesh-queue-assignment.js';
import { AUTO_LAUNCH_LEDGER_DEDUP_MAX } from './mesh-queue-observability.js';
import { PARKED_SKIP_REASON, PARKED_TASK_RETENTION_MS } from './mesh-task-parking.js';

// Fix (1): actionable dispatch-skip notification.
//
// User-core gap: when a queued task cannot be dispatched the coordinator (Claude Code via
// MCP) had no proactive signal — the skip was only recorded to task.autoLaunch + the ledger,
// both of which the coordinator must poll to discover. For a skip that will NOT self-resolve
// (a routing miss, no capable node, a convergence task pinned to a worktree, an unusable
// provider, an unreachable remote, or a dirty workspace) the coordinator could sit waiting
// for a dispatch that can never happen. We now actively surface those — and ONLY those — as a
// pending coordinator event carrying a "why + how to act" message, routed to the originating
// coordinator (sourceCoordinator*). Transient/back-pressure skips (cooldown, in-progress,
// awaiting-claim, parallel/session caps, node not yet launch-ready, an active assignment,
// provider quota below threshold) are
// deliberately excluded: they clear on their own and would only spam the coordinator every 4s.
const ACTIONABLE_SKIP_REASON_PREFIXES = [
    'target_node_id_unmatched',
    'no_node_satisfies_required_tags',
    'mesh_convergence_target_is_worktree',
    'remote_auto_launch_unsupported',
    'remote_auto_launch_no_coordinator_daemon_id',
    'missing_provider_priority',
    'provider_loader_unavailable',
    'provider_priority_unusable',
    'provider_unusable',
    'dirty_workspace',
    // TARGET-PIN-TTL EXPIRY: the task was pinned to a specific session (a delta —
    // a correction addressed to work already in flight) and that session never
    // claimed it within the TTL, so the pin was cleared. Unlike the transient
    // skips, this does NOT self-resolve into the intended outcome: the delta is
    // now claimable by ANY compatible session, i.e. it will not reach the session
    // it was written for. Previously this only bumped a metrics counter and wrote
    // a log, so the coordinator kept waiting for a delivery that could no longer
    // happen — measured live as 74min of silence while a worker continued on a
    // premise the delta was meant to correct. The coordinator must know its
    // addressed message lost its address.
    'target_session_pin_expired',
    // PIN-PARKING: the reason above's successor. The pin no longer CLEARS on expiry
    // (that silently re-homed a context-bound delta onto an arbitrary session); the
    // task PARKS instead — held, still addressed, claimable by nobody. That state is
    // by construction actionable and terminal-until-touched: nothing in the daemon
    // will ever move a parked task, so if the coordinator is not told, the work is
    // lost exactly as surely as if it had been dropped. Both reasons stay listed —
    // the old one so a version-skewed daemon's rows still page.
    PARKED_SKIP_REASON,
    // SLOT MODEL GUARD (absent): no slot on the node declares the task's model.
    // Permanent — no amount of waiting produces a slot, so the coordinator must
    // re-drive (adjust difficulty, target another node, ask the owner). Its
    // busy counterpart SLOT_MODEL_BUSY_SKIP_REASON is deliberately NOT listed:
    // that one clears on its own when the slot goes idle.
    SLOT_MODEL_ABSENT_SKIP_REASON,
    // QUOTA GATE: 'provider_quota_session_low' / 'provider_quota_weekly_low' /
    // 'provider_quota_exhausted' / 'all_providers_quota_gated' are deliberately
    // NOT listed either — an exhausted quota window RESETS, so the block
    // self-resolves exactly like the slot-busy case; the task waits in the
    // queue and the coordinator is not paged (mesh-quota-routing.ts). The
    // all-gated reason exists precisely so this WAIT is never conflated with
    // the actionable 'provider_priority_unusable' above.
];

// FALSE-BLOCKER-CLONE-QUEUE: the TRANSIENT counterpart of 'target_node_id_unmatched'. A
// queue task pinned to a freshly cloned worktree node can transiently find no matching node
// (its inline-cache entry has not propagated to this coordinator daemon yet, and/or its
// worktree bootstrap is still running). That unmatch SELF-RESOLVES — it is not the permanent
// routing miss the actionable blocker exists for — so it is deliberately NOT listed in
// ACTIONABLE_SKIP_REASON_PREFIXES: isActionableSkipReason() returns false for it, so no
// "actionable blocker — will NOT clear on its own" coordinator page is emitted. The skip is
// still recorded to task.autoLaunch + the ledger for diagnosability.
export const TRANSIENT_TARGET_NODE_BOOTSTRAP_PENDING_REASON = 'target_node_bootstrap_pending';

// De-dup actionable-skip coordinator notifications: emit once per (mesh, task) until the
// reason CHANGES, so the 4s reconcile loop re-marking the same skip does not re-notify. A
// non-skip transition (or a genuine reason change) re-arms it. In-memory only — a daemon
// restart re-notifies once, which is the correct behaviour after a restart.
const lastActionableSkipNotified = new Map<string, string>();

export function isActionableSkipReason(reason?: string): boolean {
    if (!reason) return false;
    return ACTIONABLE_SKIP_REASON_PREFIXES.some(prefix => reason === prefix || reason.startsWith(prefix));
}

/**
 * FALSE-BLOCKER-CLONE-QUEUE: a target pin is TRANSIENTLY (not permanently) unresolved when
 * the pinned node is a freshly cloned worktree that will auto-claim once its bootstrap
 * completes / its inline-cache entry propagates — as opposed to a removed/dead node whose
 * unmatch is a permanent, actionable routing miss. Two signals, either suffices:
 *   (a) the node IS visible in the (cache-merged) mesh view but its worktree bootstrap is
 *       still 'running' (and not stuck past the stale backstop), or
 *   (b) the node is NOT visible here yet, but a clone for its id was issued within the grace
 *       window (propagation/bootstrap latency) — see mesh-clone-grace.
 * Conservative: a node neither bootstrap-running nor recently cloned → returns false, so a
 * genuinely dead node keeps its permanent, actionable 'target_node_id_unmatched'.
 */
export function isTargetNodeTransientlyUnresolved(mesh: any, task: MeshWorkQueueEntry): boolean {
    const targetNodeId = readNonEmptyString(task.targetNodeId);
    if (!targetNodeId) return false;
    const node = Array.isArray(mesh?.nodes)
        ? mesh.nodes.find((n: any) => meshNodeIdMatches(n, targetNodeId))
        : undefined;
    if (node
        && (node as { worktreeBootstrap?: { status?: string } }).worktreeBootstrap?.status === 'running'
        && !isWorktreeBootstrapStaleRunning(node)) {
        return true;
    }
    return isWithinCloneBootstrapGrace(targetNodeId);
}

// ---------------------------------------------------------------------------
// DEAD-TARGET-SELFHEAL: unpin a queue task hard-pinned to a session/node that has
// died (absent from the live mesh) so a live idle session can claim it, instead of
// leaving it stranded 'pending' forever behind the target_session_constraint skip.
// ---------------------------------------------------------------------------

// Conservative age gate before a pinned-but-dead target is unpinned. A target that is
// merely briefly unassigned or momentarily reconnecting must not be reclaimed on the
// tick it drops out of view; we require the task to have been idle (no updatedAt bump)
// for at least this window first. Sized to comfortably outlast a transient P2P blip /
// reconnect while staying well inside the reclaim cadence of the rest of the file
// (AUTO_LAUNCH_AWAIT_CLAIM_MS is 90s; the stranded-reclaim watchdog fires on similar
// scales), so a real reconnect wins the race and the self-heal only fires on a target
// that is genuinely gone.
const DEAD_TARGET_GRACE_MS = 60_000;

// RC.20 TARGET-PIN TTL (the mesh_queue_requeue wedge): a task hard-pinned with
// target_session_id is delivered when that LIVE, compatible session claims it (the
// tier-1 claim gate matches the pin; the idle→claim drain drives it in seconds). But a
// pin whose target can never claim — a session on a REMOTE node this daemon cannot
// observe (the dead-target verdict stays UNKNOWN there by design), a session that is not
// an idle-claim participant for this mesh, or one that stays busy indefinitely — left
// the task 'pending' FOREVER behind the target_session_constraint skip (observed live
// 2026-07-28 on a cancel/reassignment control). Bounded rule: a pin that has gone
// UNCLAIMED for this TTL (anchored at the task's requeuedAt/createdAt, so per-tick
// updatedAt bumps cannot reset it) is EXPIRED — the target pin is cleared without
// consuming the retry budget and the task becomes claimable by any compatible session.
// Sized far above every legitimate claim window (DEAD_TARGET_GRACE_MS 60s,
// AUTO_LAUNCH_AWAIT_CLAIM_MS 90s, remote agent:ready pull lag, and the 5-min dead-target
// grace used by the live-busy contract) so a genuinely-live claim always wins the race;
// only a pin that demonstrably never delivers expires.
export const TARGET_SESSION_PIN_TTL_MS = 15 * 60_000;

/** Age of the task's target pin in ms (anchored at the last requeue, else creation). */
export function targetPinAgeMs(task: MeshWorkQueueEntry, nowMs: number = Date.now()): number | null {
    const anchorMs = Date.parse(task.requeuedAt || task.createdAt || '');
    return Number.isFinite(anchorMs) ? nowMs - anchorMs : null;
}

/**
 * TTL-WHILE-WORKING: does the pin's TTL run right now, or is the addressee
 * demonstrably busy earning it?
 *
 * The defect this fixes (measured live 2026-08-19: `unclaimed 902s ≥ ttl 900s`,
 * dropped 2 seconds over the line, on the very `agent:ready` where the worker
 * finished): the TTL was pure wall-clock age from requeuedAt/createdAt, so it
 * ran while the pinned session was actively generating. That inverts the pin's
 * purpose. A pin means "append this to THAT session's context"; the more work
 * that session is doing, the more valuable the pin is and the more likely a
 * 15-minute wall-clock budget elapses. The pin therefore died soonest in exactly
 * the case it was written for — the session that day was implementing P2/P3/P4
 * in one turn, which trivially exceeds 15 minutes of legitimate work.
 *
 * The corrected basis is UNPRODUCTIVE waiting: the TTL only advances while the
 * addressee is NOT visibly working. Concretely, a `GENERATING` verdict from the
 * local instance manager suspends the clock for that tick.
 *
 * ★ The never-expiring hole this deliberately does NOT open. Suspension requires
 * POSITIVE evidence of work — `resolveSessionBusyVerdict === 'GENERATING'`, which
 * only a live LOCAL session can produce. Every weaker state keeps the clock
 * running:
 *   - IDLE_CONFIRMED — alive but idle. It could claim the row and is not; that is
 *     precisely the stale-pin case, so waiting must count.
 *   - UNKNOWN — remote, or gone. Absence of evidence is not evidence of work; a
 *     remote session that never claims is the original RC.20 wedge, and treating
 *     unknown as busy would make its pin immortal.
 * So a pin can be held open only by a session this daemon can watch generating,
 * and the moment that stops the bounded TTL resumes. Suspension is also evaluated
 * per tick against live state — it can never be latched on.
 *
 * Because the clock is suspended rather than reset, generating time is not
 * REFUNDED either: a session that alternates work and idling still exhausts the
 * TTL across its idle stretches, so a pin whose addressee never actually claims
 * remains bounded.
 */
export interface TargetPinTtlVerdict {
    /** The pin has waited past the TTL in unproductive time → park it. */
    expired: boolean;
    /** Unproductive age used for the decision, in ms (null when unmeasurable). */
    ageMs: number | null;
    /** True when the clock is suspended this tick because the addressee is generating. */
    suspended: boolean;
}

/**
 * Accumulated GENERATING time per pinned task, subtracted from wall-clock age.
 *
 * In-memory and best-effort by design: on a daemon restart a task starts
 * accumulating again from zero, which can only make the TTL fire EARLIER (less
 * credited work), never later. Erring toward expiry is the safe direction —
 * parking is recoverable, an immortal pin is not.
 */
const targetPinGeneratingCreditMs = new Map<string, { creditMs: number; lastSeenMs: number }>();

/** Drop credit bookkeeping for tasks that are no longer pinned/pending. */
export function forgetTargetPinGeneratingCredit(meshId: string, taskId: string): void {
    targetPinGeneratingCreditMs.delete(`${meshId}::${taskId}`);
}

export function resolveTargetPinTtlVerdict(
    components: DaemonComponents,
    task: MeshWorkQueueEntry,
    nowMs: number = Date.now(),
): TargetPinTtlVerdict {
    const wallAgeMs = targetPinAgeMs(task, nowMs);
    if (wallAgeMs === null) return { expired: false, ageMs: null, suspended: false };

    const targetSessionId = readNonEmptyString(task.targetSessionId);
    const key = `${task.meshId}::${task.id}`;
    const prior = targetPinGeneratingCreditMs.get(key);

    // Positive evidence of work only — see the never-expiring-hole note above.
    const generating = !!targetSessionId
        && resolveSessionBusyVerdict(components, targetSessionId) === 'GENERATING';

    let creditMs = prior?.creditMs ?? 0;
    if (generating && prior) {
        // Credit the interval since the last observation, bounded by that gap so a
        // long scheduler stall cannot mint unbounded credit.
        creditMs += Math.max(0, nowMs - prior.lastSeenMs);
    }
    targetPinGeneratingCreditMs.set(key, { creditMs, lastSeenMs: nowMs });

    const unproductiveAgeMs = Math.max(0, wallAgeMs - creditMs);
    return {
        // A tick on which the addressee is OBSERVABLY GENERATING never expires the pin,
        // independently of the accumulated credit.
        //
        // The credit ledger alone is not sufficient here, and the difference is the
        // whole live defect. Credit only accrues from the SECOND observation onward
        // (the first has no prior interval to bank), and it is in-memory — so a pin
        // that crossed the wall-clock TTL while the daemon was not watching, or before
        // a restart, would arrive at its very first post-restart observation with zero
        // credit and expire on the spot, while the session it is addressed to is
        // visibly mid-turn. That is exactly the observed failure (`unclaimed 902s`
        // logged on an `agent:ready`, i.e. at the end of real work) reproduced by a
        // different route.
        //
        // Gating on the live verdict makes "is the addressee working right now?" the
        // decisive question and leaves the credit ledger as what it should be: an
        // optimisation that stops intermittent work from silently burning the budget.
        // It cannot make a pin immortal — the verdict is re-evaluated every tick from
        // live state and only a LOCAL, observably-generating session can produce it.
        expired: !generating && unproductiveAgeMs >= TARGET_SESSION_PIN_TTL_MS,
        ageMs: unproductiveAgeMs,
        suspended: generating,
    };
}

/** Test hook: reset the generating-credit ledger between cases. */
export function __resetTargetPinGeneratingCreditForTests(): void {
    targetPinGeneratingCreditMs.clear();
}

interface DeadTargetVerdict {
    /** The pinned target is confirmed dead and past the grace window → safe to unpin. */
    dead: boolean;
    /** True when the target NODE itself is absent from the live mesh (clear targetNodeId too). */
    nodeDead: boolean;
    /** Short reason string for the ledger/requeue. */
    reason: string;
}

/**
 * Decide whether a task's hard target pin (targetSessionId and/or targetNodeId) points at
 * something that has DIED — i.e. is absent from the live mesh snapshot — and has been so
 * long enough (DEAD_TARGET_GRACE_MS since the task's last update) that unpinning is safe.
 *
 * Two definitive death signals, deliberately conservative to never race a reconnecting node:
 *
 *  (1) NODE dead — the task pins a targetNodeId that matches NO node in the live mesh
 *      (the same `meshNodeIdMatches`-over-mesh.nodes signal the targetPinUnmatched relabel
 *      uses at the empty-candidate site). A pinned session on an absent node is unreachable
 *      regardless, so the session pin is dead too. `nodeDead` ⇒ clear targetNodeId as well.
 *      Excluded: a target that is only TRANSIENTLY unresolved (a freshly-cloned worktree
 *      still propagating / bootstrapping) — isTargetNodeTransientlyUnresolved gates it out.
 *
 *  (2) SESSION dead on a LIVE LOCAL node — the target node IS present and is THIS daemon's
 *      node, but the pinned session is absent from the local instance manager
 *      (resolveSessionBusyVerdict === 'UNKNOWN'). Local session visibility is complete, so
 *      absence here is genuine death, not a busy/generating flip. We KEEP targetNodeId (only
 *      the session died; the node is healthy and can host a replacement claim).
 *
 * A live REMOTE node whose session is not in our idle view is NOT treated as dead: absence
 * from the remote-idle mirror is explicitly UNKNOWN liveness (the session may be busy or its
 * agent:ready pull merely lost), so unpinning it could race healthy in-flight work. Returns
 * dead=false in that case, leaving the existing skip in place.
 */
export function resolveDeadTargetVerdict(components: DaemonComponents, meshId: string, mesh: any, task: MeshWorkQueueEntry): DeadTargetVerdict {
    const NOT_DEAD: DeadTargetVerdict = { dead: false, nodeDead: false, reason: '' };
    const targetSessionId = readNonEmptyString(task.targetSessionId);
    const targetNodeId = readNonEmptyString(task.targetNodeId);
    if (!targetSessionId && !targetNodeId) return NOT_DEAD;

    // Age gate: never reclaim a pin younger than the grace window (guards against a target
    // that has only just dropped out of view for a momentary reconnect).
    const lastUpdateMs = Date.parse(task.updatedAt || task.createdAt || '');
    if (Number.isFinite(lastUpdateMs) && Date.now() - lastUpdateMs < DEAD_TARGET_GRACE_MS) return NOT_DEAD;

    const nodes: any[] = Array.isArray(mesh?.nodes) ? mesh.nodes : [];

    // (1) NODE-dead — a pinned node absent from the live mesh, and NOT merely transiently
    // unresolved (a propagating/bootstrapping clone). This is a permanent routing miss.
    if (targetNodeId) {
        const nodePresent = nodes.some(n => meshNodeIdMatches(n, targetNodeId));
        if (!nodePresent) {
            if (isTargetNodeTransientlyUnresolved(mesh, task)) return NOT_DEAD;
            return { dead: true, nodeDead: true, reason: 'dead_target_node_absent' };
        }
    }

    // (2) SESSION-dead on a LIVE LOCAL node. Only meaningful when a session is pinned.
    if (targetSessionId) {
        // Resolve the pinned target's node (if any) to decide whether we can trust local
        // absence. Without a targetNodeId, fall back to whichever live node hosts the session
        // is unknowable here; treat that as a LOCAL check only (a session id we cannot see
        // locally on a node we cannot resolve remotely stays UNKNOWN → not dead).
        const node = targetNodeId
            ? nodes.find(n => meshNodeIdMatches(n, targetNodeId))
            : undefined;
        // A pinned session on a REMOTE live node: absence from our view is UNKNOWN, not death.
        // Only a LOCAL node (or no node pin at all — same-daemon assumption) lets us conclude
        // death from local instance-manager absence.
        const nodeIsLocal = node ? isLocalAutoLaunchNode(node) : true;
        if (nodeIsLocal) {
            const verdict = resolveSessionBusyVerdict(components, targetSessionId);
            if (verdict === 'UNKNOWN') {
                // Session absent from the complete local session view → genuinely gone.
                return { dead: true, nodeDead: false, reason: 'dead_target_session_absent' };
            }
            // GENERATING / IDLE_CONFIRMED → the session is alive (possibly busy). Never disturb.
        }
    }

    return NOT_DEAD;
}

/**
 * FALSE-BLOCKER-CLONE-QUEUE (stale-event clear): once a task whose actionable blocker we
 * previously paged either gets claimed or transitions to a self-resolving state, re-arm the
 * de-dup ledger (so a later genuine blocker re-notifies) AND retract any still-undelivered
 * dispatch_blocked pending event, so the coordinator's pending queue no longer carries the
 * stale "will NOT clear on its own" warning. Cheap: only touches the pending store when this
 * (mesh, task) actually had a prior actionable notification recorded.
 */
export function retractActionableSkipIfPreviouslyNotified(meshId: string, taskId: string): void {
    const dedupKey = `${meshId}:${taskId}`;
    if (!lastActionableSkipNotified.delete(dedupKey)) return; // nothing was paged → nothing to retract
    try {
        const coordinatorDaemonId = readNonEmptyString(loadConfig().machineId) || undefined;
        const removed = retractPendingDispatchBlockedEvent(meshId, taskId, coordinatorDaemonId);
        if (removed > 0) {
            LOG.info('MeshQueue', `Retracted ${removed} stale dispatch-blocked event(s) for task ${taskId} (mesh ${meshId}) — its blocker resolved`);
        }
    } catch (e: any) {
        LOG.warn('MeshQueue', `Failed to retract stale dispatch-blocked event for task ${taskId} (mesh ${meshId}): ${e?.message || e}`);
    }
}

/**
 * DISPATCH-ACK-EVIDENCE: what the coordinator can actually PROVE about whether a task's
 * message reached its worker, read from the durable delivery records.
 *
 * The distinction this exists to make (see the false-positive it fixes in
 * {@link actionableSkipGuidance}):
 *
 *  - 'consumed'      — a delivery reached 'acked'/'completed', i.e. the worker emitted
 *                      agent:generating_started. The worker demonstrably HAS the message.
 *  - 'delivered'     — a delivery reached 'delivered': the transport confirmed the handoff
 *                      to the provider/PTY boundary, but no turn-start echo came back. The
 *                      message very likely arrived; we cannot prove the worker acted on it.
 *  - 'never_dispatched' — no delivery record exists at all. Nothing was ever handed to a
 *                      transport, so the message certainly did not reach the session.
 *
 * Only 'never_dispatched' licenses telling the coordinator to re-send. Asserting that on
 * the other two produces the duplicate-injection hazard: re-sending a delta the worker is
 * already acting on runs the same instruction twice.
 */
type TaskDeliveryEvidence = 'consumed' | 'delivered' | 'never_dispatched';

function resolveTaskDeliveryEvidence(meshId: string, taskId: string): TaskDeliveryEvidence {
    try {
        const store = MeshRuntimeStore.getInstance();
        if (store.taskDeliveryConsumed(meshId, taskId)) return 'consumed';
        if (store.taskHasConfirmedDelivery(meshId, taskId)) return 'delivered';
    } catch {
        // Store unreadable — fall through to the conservative answer. 'delivered' (not
        // 'never_dispatched') is the safe default: it withholds the re-send advice rather
        // than inventing a "certainly not received" claim we have no evidence for.
        return 'delivered';
    }
    return 'never_dispatched';
}

function actionableSkipGuidance(reason: string, evidence?: TaskDeliveryEvidence): { summary: string; nextAction: string } {
    if (reason === 'target_node_id_unmatched') return {
        summary: 'it is pinned to a target node id that matches no node in the mesh (the node may have been removed, or its id form does not resolve)',
        nextAction: 'Verify the target node still exists with mesh_status, then re-enqueue without the node pin or with a valid node id (or re-clone the node).',
    };
    if (reason === 'no_node_satisfies_required_tags') return {
        summary: "no node in the mesh can satisfy the task's required capability tags",
        nextAction: "Relax the task's requiredTags, or add/launch a node whose provider produces the required capabilities.",
    };
    if (reason === 'mesh_convergence_target_is_worktree') return {
        summary: 'it is a convergence task (base-only: merge → push → cleanup) but every candidate node is a worktree clone',
        nextAction: 'Dispatch the convergence task to the base node, or run the deterministic fast-forward path (mesh_fast_forward_node / mesh_refine_node) instead.',
    };
    if (reason.startsWith('remote_auto_launch')) return {
        summary: 'the target node is on a remote daemon this coordinator cannot auto-launch a session on (no dispatch transport, or no coordinator daemon id to stamp)',
        nextAction: 'Launch a session on that node yourself with mesh_launch_session, or ensure the remote daemon is connected over P2P.',
    };
    if (reason.startsWith('provider') || reason === 'missing_provider_priority') return {
        summary: `the current provider scan found no usable provider for this task (provider priority missing/unusable, or the provider loader is unavailable; ${reason})`,
        nextAction: "Check the node's providerPriority policy and that the required CLI/ACP provider is installed and enabled on that machine. Quota-gated candidates use a separate, self-resolving reason and are not proof of this configuration blocker.",
    };
    if (reason === 'dirty_workspace') return {
        summary: "the node's workspace is dirty, so auto-launch is blocked to avoid clobbering uncommitted changes",
        nextAction: "Clean or commit the node's working tree (or fast-forward it); the task will then auto-assign.",
    };
    if (reason === PARKED_SKIP_REASON) {
        // PIN-PARKING. Unlike the cleared-pin reason below, there is no ambiguity to
        // resolve about claimability: nothing will move this task until the
        // coordinator does. The delivery evidence still matters though — it decides
        // whether the right exit is "re-send it" or "the worker already has it, just
        // cancel the park" — so the same three-way branch drives the recommendation.
        const base = 'it was pinned to a specific session, that pin went stale, and the task is now PARKED — deliberately held for you rather than re-homed onto another session, because a delta written for one session\'s context becomes a context-free instruction anywhere else';
        if (evidence === 'consumed') return {
            summary: `${base}. The delivery record shows the addressed session DID receive and start acting on this message, so the parked row is a bookkeeping remnant, not a lost delta`,
            nextAction: 'Do NOT re-send it. Confirm with mesh_read_chat / mesh_read_terminal that the work is under way, then clear the park with mesh_queue_cancel (or requeue it only if you genuinely want it run again).',
        };
        if (evidence === 'delivered') return {
            summary: `${base}. The message WAS handed to that session's transport but no turn start was echoed, so whether it acted on it is unconfirmed`,
            nextAction: 'Check the session (mesh_read_chat / mesh_read_terminal) before acting. If it is already handling it, cancel the parked row; if not, mesh_queue_requeue with target_session_id=<live session> — and pass message=<rewritten instruction> if the situation moved on while it waited.',
        };
        return {
            summary: `${base}. No delivery to that session was ever recorded, so the message did not reach it and the worker is still acting on its previous instructions`,
            nextAction: 'Re-target it with mesh_queue_requeue(target_session_id=<live session>), or drop the pin with clear_target_session to let any compatible session take it. Re-read the work produced meanwhile and pass message=<rewritten instruction> if the delta is now partly stale; mesh_queue_cancel if it is moot.',
        };
    }
    if (reason === 'target_session_pin_expired') {
        // DISPATCH-ACK-EVIDENCE. This guidance used to assert, unconditionally, that the
        // addressed session "never received this delta" and to instruct a re-send. That is an
        // inference from the absence of a coordinator-side CLAIM, and the claim proves nothing
        // about the worker's inbox: 'unclaimed' here means only that the queue row never left
        // 'pending' within the TTL. Observed live 2026-08-11 (4x in one session): the worker had
        // in fact received the delta and was already acting on it — mesh_read_terminal showed the
        // work under way — so following the advice would have injected the same instruction twice.
        //
        // Branch on what the delivery records actually witness. Only the case with NO delivery
        // record at all still recommends a re-send; the others report the uncertainty honestly
        // and send the coordinator to verify before acting, because a duplicate injection is the
        // more expensive error.
        if (evidence === 'consumed') return {
            summary: 'it was pinned to a specific session and the pin TTL expired before the queue row was claimed — but the delivery record shows this session DID receive and start acting on the message (a turn was started for it), so the queue row lagging is a bookkeeping gap, not a lost delta',
            nextAction: 'Do NOT re-send it — the session already has this message and re-sending would run the same instruction twice. Check its current output (mesh_read_chat / mesh_read_terminal) to confirm the work is under way.',
        };
        if (evidence === 'delivered') return {
            summary: 'it was pinned to a specific session and the pin TTL expired before the queue row was claimed; the message WAS handed to that session\'s transport, but the session never echoed a turn start, so whether it acted on it is unconfirmed',
            nextAction: 'Verify before re-sending: check the session with mesh_read_chat / mesh_read_terminal. Re-send only if its output shows no sign of this message — it may already be acting on it, and re-sending would duplicate the instruction.',
        };
        return {
            summary: 'it was pinned to a specific session (a follow-up/delta for work already in flight) that never claimed it within the pin TTL, so the pin was cleared; no delivery to that session was ever recorded, so the message did not reach it',
            nextAction: 'The addressed session never received this delta and is still acting on its previous instructions. Re-send it to that session once it is idle (or re-target it), and re-check the work it produced in the meantime.',
        };
    }
    if (reason === SLOT_MODEL_ABSENT_SKIP_REASON) return {
        summary: "no capability slot on the node declares the model this task resolved to (its difficulty→brain preset picked a model the node was never configured to run)",
        nextAction: "Re-enqueue with a difficulty/model the node's slots declare, target a node that declares this model, or add a slot for it. The task is NOT run on a substitute model — an undeclared model is never launched.",
    };
    return {
        summary: `it cannot be dispatched (${reason})`,
        nextAction: 'Inspect the node/mesh state with mesh_status and resolve the blocker, or re-enqueue the task.',
    };
}

/** Surface a non-self-resolving dispatch skip to the originating coordinator as a pending
 *  event (so it is delivered actively, not only on poll). De-duped per (mesh, task, reason). */
export function notifyCoordinatorOfActionableSkip(meshId: string, taskId: string, reason: string | undefined, nodeId?: string): void {
    if (!isActionableSkipReason(reason)) return;
    // FALSE-BLOCKER-CLONE-QUEUE chokepoint defense: a 'target_node_id_unmatched' skip whose
    // node was cloned within the grace window is a TRANSIENT propagation/bootstrap gap that
    // auto-clears, not a permanent routing miss — never page the coordinator for it (the
    // reason classifier upstream already routes the common case to the transient reason; this
    // is the single-funnel backstop for any path that still labels it as the permanent reason).
    if (reason === 'target_node_id_unmatched' && isWithinCloneBootstrapGrace(readNonEmptyString(nodeId))) return;
    const dedupKey = `${meshId}:${taskId}`;
    if (lastActionableSkipNotified.get(dedupKey) === reason) return;
    lastActionableSkipNotified.set(dedupKey, reason!);
    if (lastActionableSkipNotified.size > AUTO_LAUNCH_LEDGER_DEDUP_MAX) {
        const oldest = lastActionableSkipNotified.keys().next().value;
        if (oldest !== undefined) lastActionableSkipNotified.delete(oldest);
    }
    let task: MeshWorkQueueEntry | undefined;
    try { task = getQueue(meshId).find(t => t.id === taskId); } catch { /* best-effort */ }

    // STALE-SCAN-BLOCKER: re-read the task's CURRENT status before paging, and drop the
    // notification when the task is no longer pending.
    //
    // The auto-launch scan snapshots the pending set ONCE
    // (maybeAutoLaunchOneQueueSession: `queue.filter(status === 'pending')`) and then
    // awaits per candidate node — `resolveUsableProvider` awaits `detectCLI` for EVERY
    // slot in the node's provider priority, each a real process probe. Across a
    // multi-slot, multi-node scan that is seconds of wall-clock. Within that window the
    // task can be claimed by an idle session (pending → assigned → generating),
    // completed, or cancelled — but the loop still holds the pre-await snapshot row and
    // pages the coordinator about a blocker for work that is already under way or gone.
    //
    // Observed 2026-08-16, 4x, every one a false positive: 3 were late scans of
    // already-cancelled/completed tasks (queue pending count was 0 at delivery), and 1
    // arrived 122s after its task had already reached `generating` via a successful
    // autoLaunch. The message asserts an actionable blocker, so each one cost the
    // coordinator a diversion into diagnosing a block that did not exist.
    //
    // `getQueue` reads through to MeshRuntimeStore (not the caller's snapshot), so this
    // check sees the post-await truth. Deliberately fail-OPEN: an unreadable queue or a
    // row we cannot find leaves `task` undefined and we still notify, because silently
    // swallowing a real blocker is the worse failure — the point of this fix is accuracy,
    // not suppression.
    if (task && task.status !== 'pending') {
        LOG.info('MeshQueue', `Suppressed stale dispatch-blocked page for task ${taskId} (mesh ${meshId}): `
            + `reason '${reason}' was computed against a pre-await snapshot, but the task is now '${task.status}'.`);
        // Re-arm the de-dup ledger so a GENUINE later blocker for this task still pages.
        lastActionableSkipNotified.delete(dedupKey);
        return;
    }
    // The queue is owned by this coordinator daemon, so scope the event to this daemon's id;
    // the originating coordinator SESSION (if known) further narrows delivery on this daemon.
    const targetCoordinatorDaemonId = readNonEmptyString(loadConfig().machineId);
    const targetCoordinatorSessionId = readNonEmptyString(task?.sourceCoordinatorSessionId);
    const nodeLabel = readNonEmptyString(nodeId) || readNonEmptyString(task?.targetNodeId);
    // DISPATCH-ACK-EVIDENCE: resolve what the delivery records actually witness for this task
    // so the pin-expiry guidance can distinguish "certainly not received" from "unknown".
    // Only read for the reason that branches on it — every other reason is unaffected.
    const evidence = reason === 'target_session_pin_expired' || reason === PARKED_SKIP_REASON
        ? resolveTaskDeliveryEvidence(meshId, taskId)
        : undefined;
    const { summary, nextAction } = actionableSkipGuidance(reason!, evidence);
    // The trailing clause is reason-dependent. 'target_session_pin_expired' has ALREADY cleared
    // the pin by the time this fires (expireTaskTargetPin ran), so the task is claimable by any
    // compatible session — telling the coordinator it "stays pending until you resolve it" is
    // false for this reason and contradicts the summary itself. Provider-availability reasons
    // are observations from the current scan: a refresh or an already-starting session can make
    // progress, while a genuinely absent provider still needs explicit configuration work. Every
    // other actionable reason is a standing blocker, so the original clause remains unchanged.
    const providerAvailabilityResult = reason!.startsWith('provider') || reason === 'missing_provider_priority';
    // REACHABILITY-RESULT: a remote-auto-launch skip is a CONNECTIVITY observation, not a
    // standing configuration blocker. resolveAutoLaunchTarget emits it when the node
    // carries no resolvable daemonId, or when this daemon currently has no
    // dispatchMeshCommand transport (mesh-queue-assignment.ts) — both of which a P2P
    // reconnect / node re-registration clears with no operator action at all. Asserting
    // "it will NOT clear on its own" for it was simply false, and it is one of the two
    // reasons behind the four false blocker pages of 2026-08-16. It still deserves a page
    // (a genuinely offline node does need a human), so the reason stays actionable — only
    // the certainty of the wording is corrected to match what the code actually knows.
    const reachabilityResult = reason!.startsWith('remote_auto_launch');
    const closing = reason === PARKED_SKIP_REASON
        // PIN-PARKING: the strongest closing clause in this function, because parking
        // is the one state where NOTHING in the daemon will ever advance the task —
        // no retry, no timeout, no other session. Silence here is loss.
        ? `This task is claimable by NOBODY until you act on it — no session will pick it up and no timer will re-home it. It is held for ${Math.round(PARKED_TASK_RETENTION_MS / 3_600_000)}h and then failed (with another notification), so it is never silently discarded. Parked rows are listed under parkedTasks in mesh_view_queue, and any mesh_queue_requeue unparks it — including one that only rewrites its message.`
        : reason === 'target_session_pin_expired'
        ? 'The stale pin has already been cleared, so the task is now claimable by any compatible session — the action above is about the session it was originally addressed to.'
        : providerAvailabilityResult
            ? 'This result needs action if it persists: a later provider-status refresh or an already-starting usable session can clear it, but a genuinely missing, disabled, or misconfigured provider will keep the task pending until you fix that configuration.'
            : reachabilityResult
                ? 'This result needs action if it persists: the node reconnecting (or re-registering its daemon id) clears it on its own, but a node that stays unreachable will keep the task pending until you bring it back or re-target the task.'
                : 'This is an actionable blocker — it will NOT clear on its own; the task stays pending until you resolve it.';
    const coordinatorMessage = `[System] A queued mesh task${nodeLabel ? ` for node ${nodeLabel}` : ''} is not being dispatched because ${summary}. ${nextAction} ${closing}`;
    try {
        queuePendingMeshCoordinatorEvent({
            event: 'mesh:dispatch_blocked',
            meshId,
            nodeLabel: nodeLabel || meshId,
            ...(nodeLabel ? { nodeId: nodeLabel } : {}),
            metadataEvent: {
                source: 'mesh_queue_dispatch_skip',
                taskId,
                reason,
                ...(nodeLabel ? { nodeId: nodeLabel } : {}),
                coordinatorMessage,
            },
            coordinatorMessage,
            queuedAt: Date.now(),
            ...(targetCoordinatorDaemonId ? { targetCoordinatorDaemonId } : {}),
            ...(targetCoordinatorSessionId ? { targetCoordinatorSessionId } : {}),
        });
    } catch (e: any) {
        LOG.warn('MeshQueue', `Failed to surface actionable dispatch-skip (${reason}) for task ${taskId}: ${e?.message || e}`);
    }
}

/** Test hook: is a skip reason one that pages the coordinator? */
export function __isActionableSkipReasonForTests(reason: string): boolean {
    return isActionableSkipReason(reason);
}
