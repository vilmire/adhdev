import { LOG } from '../logging/logger.js';
import { sessionIdsEquivalent, daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { readNonEmptyString } from './mesh-events-utils.js';
import { queuePendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import { loadConfig } from '../config/config.js';
import { isTerminalSessionStatus } from './mesh-candidacy-predicates.js';
import type { DaemonComponents } from '../boot/daemon-lifecycle.js';

// ---------------------------------------------------------------------------
// COORD-NOTIFY-STUCK: a PINNED task (targetSessionId set) whose dispatch fails
// returns to 'pending' with the pin intact (mesh-work-queue.ts requeueTask,
// dispatchFailure branch: clearTargetSession is explicitly false — a dispatch
// failure is not evidence the pin is wrong, so DEAD-TARGET-SELFHEAL/pin-TTL own
// unpinning on their own, slower, liveness evidence). Until one of those
// backstops fires (60s dead-target grace, or the 15min pin TTL), the row sits
// pending and reoffers itself only to the exact session named by the pin.
//
// The gap this closes (observed live 2026-08-26, mission af4a1ff8): the
// coordinator gets no signal that this happened. Two failure modes followed
// from that silence:
//   1. The coordinator re-targets the SAME dead session with a fresh task,
//      compounding the stuck state instead of resolving it.
//   2. The coordinator waits, unaware anything needs a decision, while the
//      backstop timers run out the clock.
//
// This module pages the coordinator immediately on the FIRST dispatch failure
// of a pinned task, the same way mesh-orphaned-pin-notify.ts pages on a known
// session stop — except here the daemon does not yet know the target is dead
// (a single dispatch failure is not proof), so the notice is phrased as "this
// failed once and will keep retrying against the same pin" rather than "this
// session is gone", and it includes the node's OTHER live sessions so the
// coordinator can immediately judge whether re-targeting is warranted instead
// of waiting on the slower liveness backstops.
// ---------------------------------------------------------------------------

const DISPATCH_FAILED_PINNED_REASON = 'pinned_session_dispatch_failed';
const RECLAIMED_PINNED_REASON = 'pinned_session_reclaimed_stranded';

/** A live session on the pinned task's target node, for the coordinator to judge re-targeting. */
export interface LiveNodeSession {
    sessionId: string;
    providerType?: string;
}

/**
 * List live (non-terminal) CLI sessions on `nodeId` for this mesh, LOCAL only.
 *
 * Mirrors the filter idiom `liveSessionCountForNode` (mesh-candidacy-predicates.ts)
 * uses, but returns identities instead of a count — a coordinator judging whether to
 * re-target a stuck pin needs to see WHAT is actually alive there, not just how many.
 * Local-only (no remote-idle mirror lookup) is deliberate: it is a best-effort context
 * hint on a notification, not a scheduling gate, and the remote-idle store lags live
 * state in exactly the way that would misinform this specific decision.
 */
export function liveSessionsForNode(components: DaemonComponents, meshId: string, nodeId: string): LiveNodeSession[] {
    try {
        const instances = components.instanceManager?.getByCategory?.('cli') || [];
        const sessions: LiveNodeSession[] = [];
        for (const inst of instances) {
            const state = (inst as any).getState?.();
            if (!state) continue;
            const settings = (state.settings as Record<string, unknown>) || {};
            if (readNonEmptyString(settings.meshNodeFor) !== meshId) continue;
            const instNodeId = readNonEmptyString(settings.meshNodeId) || readNonEmptyString(settings.nodeId);
            if (!daemonIdsEquivalent(instNodeId, nodeId)) continue;
            const status = readNonEmptyString(state.status).toLowerCase();
            if (isTerminalSessionStatus(status)) continue;
            const sessionId = readNonEmptyString(state.instanceId);
            if (!sessionId) continue;
            sessions.push({
                sessionId,
                ...(readNonEmptyString(settings.providerType) ? { providerType: String(settings.providerType) } : {}),
            });
        }
        return sessions;
    } catch (e: any) {
        LOG.warn('MeshQueue', `Live-session lookup failed for node ${nodeId} (mesh ${meshId}): ${e?.message || e}`);
        return [];
    }
}

/** Build the coordinator-facing "why + how to act" message for a pinned dispatch failure. */
export function buildDispatchFailedPinnedNotice(opts: {
    taskId: string;
    targetSessionId: string;
    nodeId: string;
    error?: string;
    liveSessions: readonly LiveNodeSession[];
}): string {
    const { taskId, targetSessionId, nodeId, error, liveSessions } = opts;
    const errorLine = error ? ` (${error})` : '';
    const others = liveSessions.filter(s => !sessionIdsEquivalent(s.sessionId, targetSessionId));
    const liveList = others.length > 0
        ? `Other live session(s) currently on node '${nodeId}': ${others.map(s => `${s.sessionId}${s.providerType ? ` (${s.providerType})` : ''}`).join(', ')}.`
        : `No other live session was found on node '${nodeId}' at notification time.`;
    return `[System] Dispatch to pinned session '${targetSessionId}' failed for task ${taskId}${errorLine} and the task returned to pending, STILL PINNED to that same session — it will keep retrying against it (with backoff) until it either succeeds or a slower liveness backstop (dead-target grace / pin TTL, up to 15min) clears the pin. Do not send a fresh task to '${targetSessionId}' — it just failed to accept one.\n`
        + `${liveList}\n`
        + `If the pin is stale (session is actually gone), re-target now instead of waiting: mesh_queue_requeue(task_id='${taskId}', target_session_id=<live session id>) to re-pin, or mesh_queue_requeue(task_id='${taskId}', clear_target_session=true) to let any compatible session on the node claim it. If this looks transient (session mid-boot/reconnect), no action is needed — the retry will likely succeed on its own.`;
}

/**
 * Page the originating coordinator when a PINNED task's dispatch fails and the
 * task requeues to pending with its pin intact. No-ops for unpinned tasks — an
 * unpinned dispatch failure requeues onto the open pool and is the ordinary,
 * self-resolving case (any compatible session picks it up on the next tick).
 *
 * Reuses the same `mesh:dispatch_blocked` coordinator-alert channel
 * mesh-orphaned-pin-notify.ts and mesh-skip-notify.ts use — already classed as
 * a COORDINATOR_ALERT_EVENT in contracts.ts (unicast to the originating
 * coordinator) and already fingerprinted by (task, reason) in
 * mesh-events-pending.ts, so repeats of the SAME reason for the SAME task
 * collapse automatically; this function adds no separate in-memory dedup.
 */
export function notifyCoordinatorOfPinnedDispatchFailure(
    components: DaemonComponents,
    opts: {
        meshId: string;
        taskId: string;
        targetSessionId: string;
        nodeId: string;
        error?: string;
        sourceCoordinatorSessionId?: string;
        sourceCoordinatorDaemonId?: string;
    },
): void {
    const targetSessionId = readNonEmptyString(opts.targetSessionId);
    if (!targetSessionId) return; // unpinned — not this notifier's concern

    const liveSessions = liveSessionsForNode(components, opts.meshId, opts.nodeId);
    const coordinatorMessage = buildDispatchFailedPinnedNotice({
        taskId: opts.taskId,
        targetSessionId,
        nodeId: opts.nodeId,
        error: opts.error,
        liveSessions,
    });

    const targetCoordinatorDaemonId = readNonEmptyString(opts.sourceCoordinatorDaemonId) || readNonEmptyString(loadConfig().machineId);
    const targetCoordinatorSessionId = readNonEmptyString(opts.sourceCoordinatorSessionId);

    LOG.warn('MeshQueue', `COORD-NOTIFY-STUCK: dispatch of pinned task ${opts.taskId} to session ${targetSessionId} (node ${opts.nodeId}, mesh ${opts.meshId}) failed and requeued with pin intact.`);
    try {
        queuePendingMeshCoordinatorEvent({
            event: 'mesh:dispatch_blocked',
            meshId: opts.meshId,
            nodeLabel: opts.nodeId,
            nodeId: opts.nodeId,
            metadataEvent: {
                source: 'mesh_pinned_dispatch_failed',
                taskId: opts.taskId,
                reason: DISPATCH_FAILED_PINNED_REASON,
                targetSessionId,
                liveSessionIds: liveSessions.map(s => s.sessionId),
                coordinatorMessage,
            },
            coordinatorMessage,
            queuedAt: Date.now(),
            ...(targetCoordinatorDaemonId ? { targetCoordinatorDaemonId } : {}),
            ...(targetCoordinatorSessionId ? { targetCoordinatorSessionId } : {}),
        });
    } catch (e: any) {
        LOG.warn('MeshQueue', `Failed to surface pinned-dispatch-failure notification for task ${opts.taskId} (mesh ${opts.meshId}): ${e?.message || e}`);
    }
}

/** Build the coordinator-facing "why + how to act" message for a pinned stranded-reclaim. */
export function buildReclaimedPinnedNotice(opts: {
    taskId: string;
    targetSessionId: string;
    nodeId: string;
    reclaimReason: string;
    silentForMs: number;
    liveSessions: readonly LiveNodeSession[];
}): string {
    const { taskId, targetSessionId, nodeId, reclaimReason, silentForMs, liveSessions } = opts;
    const silentMin = Math.round(silentForMs / 60_000);
    const others = liveSessions.filter(s => !sessionIdsEquivalent(s.sessionId, targetSessionId));
    const liveList = others.length > 0
        ? `Other live session(s) currently on node '${nodeId}': ${others.map(s => `${s.sessionId}${s.providerType ? ` (${s.providerType})` : ''}`).join(', ')}.`
        : `No other live session was found on node '${nodeId}' at notification time.`;
    return `[System] Task ${taskId} was reclaimed from pinned session '${targetSessionId}' (node '${nodeId}') after ${silentMin}min with no confirmed progress (${reclaimReason}), and returned to pending STILL PINNED to that same session — it will keep re-offering itself ONLY to '${targetSessionId}' and to nothing else. If that session is actually gone or wedged, it will keep failing silently until you act.\n`
        + `${liveList}\n`
        + `Re-target now if the pin is stale: mesh_queue_requeue(task_id='${taskId}', target_session_id=<live session id>) to re-pin, or mesh_queue_requeue(task_id='${taskId}', clear_target_session=true) to let any compatible session on the node claim it. If '${targetSessionId}' is expected to reconnect and resume, no action is needed.`;
}

/**
 * Page the originating coordinator when a PINNED task's stranded/no-turn dispatch is
 * reclaimed (returned to pending) by the watchdog in mesh-reconcile-stranded-dispatch.ts
 * — the ~15min-plus-grace silent-worker backstop, as opposed to the immediate dispatch
 * failure notifyCoordinatorOfPinnedDispatchFailure covers. reclaimStrandedAssignedTask
 * never touches targetSessionId, so a pinned task reclaimed here goes back to 'pending'
 * with the SAME silent gap: no signal reaches the coordinator, which can misjudge the
 * node as merely slow (the exact confusion recorded in this file's QUEUE-HOLD-HARD-
 * DEADLINE comment) instead of acting on a stuck pin.
 *
 * Same channel/dedup contract as notifyCoordinatorOfPinnedDispatchFailure — see its doc.
 */
export function notifyCoordinatorOfPinnedReclaim(
    components: DaemonComponents,
    opts: {
        meshId: string;
        taskId: string;
        targetSessionId: string;
        nodeId: string;
        reclaimReason: string;
        silentForMs: number;
        sourceCoordinatorSessionId?: string;
        sourceCoordinatorDaemonId?: string;
    },
): void {
    const targetSessionId = readNonEmptyString(opts.targetSessionId);
    if (!targetSessionId) return; // unpinned — not this notifier's concern

    const liveSessions = liveSessionsForNode(components, opts.meshId, opts.nodeId);
    const coordinatorMessage = buildReclaimedPinnedNotice({
        taskId: opts.taskId,
        targetSessionId,
        nodeId: opts.nodeId,
        reclaimReason: opts.reclaimReason,
        silentForMs: opts.silentForMs,
        liveSessions,
    });

    const targetCoordinatorDaemonId = readNonEmptyString(opts.sourceCoordinatorDaemonId) || readNonEmptyString(loadConfig().machineId);
    const targetCoordinatorSessionId = readNonEmptyString(opts.sourceCoordinatorSessionId);

    LOG.warn('MeshQueue', `COORD-NOTIFY-STUCK: pinned task ${opts.taskId} reclaimed from session ${targetSessionId} (node ${opts.nodeId}, mesh ${opts.meshId}) after ${Math.round(opts.silentForMs / 60_000)}min silence and requeued with pin intact.`);
    try {
        queuePendingMeshCoordinatorEvent({
            event: 'mesh:dispatch_blocked',
            meshId: opts.meshId,
            nodeLabel: opts.nodeId,
            nodeId: opts.nodeId,
            metadataEvent: {
                source: 'mesh_pinned_stranded_reclaim',
                taskId: opts.taskId,
                reason: RECLAIMED_PINNED_REASON,
                targetSessionId,
                liveSessionIds: liveSessions.map(s => s.sessionId),
                coordinatorMessage,
            },
            coordinatorMessage,
            queuedAt: Date.now(),
            ...(targetCoordinatorDaemonId ? { targetCoordinatorDaemonId } : {}),
            ...(targetCoordinatorSessionId ? { targetCoordinatorSessionId } : {}),
        });
    } catch (e: any) {
        LOG.warn('MeshQueue', `Failed to surface pinned-reclaim notification for task ${opts.taskId} (mesh ${opts.meshId}): ${e?.message || e}`);
    }
}
