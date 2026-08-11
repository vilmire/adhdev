import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { LOG } from '../logging/logger.js';
import { getQueue, expireTaskTargetPin } from './mesh-work-queue.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue.js';
import { meshNodeIdMatches, daemonIdsEquivalent, sessionIdsEquivalent } from '@adhdev/mesh-shared';
import { readNonEmptyString } from './mesh-events-utils.js';
import { readMeshNodeDaemonId, isMeshNodeHealthLaunchable, isMeshNodeFreshEnoughToLaunch } from './mesh-node-identity.js';
import { queuePendingMeshCoordinatorEvent, retractPendingDispatchBlockedEvent } from './mesh-events-pending.js';
import { isWorktreeBootstrapStaleRunning } from './worktree-bootstrap-config.js';
import { isWithinCloneBootstrapGrace } from './mesh-clone-grace.js';
import { loadConfig } from '../config/config.js';
import { SLOT_MODEL_ABSENT_SKIP_REASON } from './slot-model-enforcement.js';
import { isLocalAutoLaunchNode, resolveSessionBusyVerdict, AUTO_LAUNCH_LEDGER_DEDUP_MAX } from './mesh-queue-assignment.js';

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
    // SLOT MODEL GUARD (absent): no slot on the node declares the task's model.
    // Permanent — no amount of waiting produces a slot, so the coordinator must
    // re-drive (adjust difficulty, target another node, ask the owner). Its
    // busy counterpart SLOT_MODEL_BUSY_SKIP_REASON is deliberately NOT listed:
    // that one clears on its own when the slot goes idle.
    SLOT_MODEL_ABSENT_SKIP_REASON,
    // QUOTA GATE: 'provider_quota_session_low' / 'provider_quota_weekly_low' are
    // deliberately NOT listed either — an exhausted quota window RESETS, so the
    // block self-resolves exactly like the slot-busy case; the task waits in the
    // queue and the coordinator is not paged (mesh-quota-routing.ts).
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

function actionableSkipGuidance(reason: string): { summary: string; nextAction: string } {
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
        summary: 'the node has no usable provider for this task (provider priority missing/unusable, or the provider loader is unavailable)',
        nextAction: "Check the node's providerPriority policy and that the required CLI/ACP provider is installed and enabled on that machine.",
    };
    if (reason === 'dirty_workspace') return {
        summary: "the node's workspace is dirty, so auto-launch is blocked to avoid clobbering uncommitted changes",
        nextAction: "Clean or commit the node's working tree (or fast-forward it); the task will then auto-assign.",
    };
    if (reason === 'target_session_pin_expired') return {
        summary: 'it was pinned to a specific session (a follow-up/delta for work already in flight) that never claimed it within the pin TTL, so the pin was cleared and the message will NOT reach the session it was addressed to',
        nextAction: 'Assume the addressed session never received this delta and is still acting on its previous instructions. Re-send it to that session once it is idle (or re-target it), and re-check the work it produced in the meantime.',
    };
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
    // The queue is owned by this coordinator daemon, so scope the event to this daemon's id;
    // the originating coordinator SESSION (if known) further narrows delivery on this daemon.
    const targetCoordinatorDaemonId = readNonEmptyString(loadConfig().machineId);
    const targetCoordinatorSessionId = readNonEmptyString(task?.sourceCoordinatorSessionId);
    const nodeLabel = readNonEmptyString(nodeId) || readNonEmptyString(task?.targetNodeId);
    const { summary, nextAction } = actionableSkipGuidance(reason!);
    const coordinatorMessage = `[System] A queued mesh task${nodeLabel ? ` for node ${nodeLabel}` : ''} is not being dispatched because ${summary}. ${nextAction} This is an actionable blocker — it will NOT clear on its own; the task stays pending until you resolve it.`;
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