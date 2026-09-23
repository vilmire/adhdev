/**
 * WORKER-MCP F3 — deliver a worker's mid-task progress note to its coordinator.
 *
 * ─── Why this file exists ───────────────────────────────────────────────
 *
 * `progress_update`'s tool description promised the coordinator "can see
 * movement", and the daemon wrote a `worker_progress_update` row for every
 * call — but NOTHING read that kind. Not `mesh_status`, not `mesh_view_queue`,
 * not the coordinator notify path. A measured production grep found zero
 * readers. The tool was a well-documented no-op: a worker spent a turn writing
 * a status note, was told "Progress noted", and no coordinator ever saw it.
 *
 * Leaving the promise in place while the feature did nothing is the worse of
 * the two options — a coordinator that believes it would hear about movement
 * waits instead of checking. So the consumer is built here rather than the
 * promise being withdrawn.
 *
 * ─── No new channel ─────────────────────────────────────────────────────
 *
 * This reuses `notifyMeshCoordinator` — the same pending-events
 * inbox every other coordinator-facing signal rides — exactly as
 * mesh-dispatch-failed-notify.ts and mesh-orphaned-pin-notify.ts do. The event
 * name `mesh:worker_progress` is registered in contracts.ts as a
 * COORDINATOR_ALERT_EVENT, so it routes unicast to the coordinator that
 * dispatched the task instead of broadcasting to every coordinator on the
 * daemon.
 *
 * ★It is deliberately NOT a terminal task event: a progress note must never
 * flip a queue row, and the coordinator message says so in as many words. The
 * failure this guards against is a coordinator reading "progress" as "done"
 * and re-dispatching live work.
 *
 * ─── What gets through ──────────────────────────────────────────────────
 *
 * Filtering lives at the producer (`shouldSurfaceProgressToCoordinator` in
 * worker-report.ts): first note per task always, then one per 5 minutes, and
 * nothing under 40 characters. That implements the owner's requirement that the
 * channel carry 큰줄기 and 오래걸리는것 rather than 자잘한부분 — an unfiltered
 * firehose is a channel coordinators learn to ignore.
 */

import { LOG } from '../logging/logger.js';
import { getMachineId } from '../config/config.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { notifyMeshCoordinator } from './turn-ledger/deliver.js';
import { readNonEmptyString } from './mesh-events-utils.js';
import type { WorkerProgressNoticeSink } from './worker-report.js';

/** The pending-event name. Registered as a coordinator alert in contracts.ts. */
export const WORKER_PROGRESS_EVENT_NAME = 'mesh:worker_progress';

/**
 * Queue one progress notice for the coordinator that dispatched the task.
 *
 * Addressed the same way a completion is: the queue row records which
 * coordinator daemon/session dispatched the work, so the notice is unicast back
 * to it. Missing addressing degrades to a broadcast — the legacy behaviour, and
 * strictly better than dropping the notice.
 */
export const queueWorkerProgressNotice: WorkerProgressNoticeSink = (notice) => {
    // Resolve the originating coordinator SESSION from the queue row — the same
    // `sourceCoordinatorSessionId` a completion routes by, so a progress note and
    // the completion for one task reach the same coordinator session. Absent on
    // legacy rows → daemon-level routing, which is that field's documented
    // fallback. A lookup failure degrades the same way rather than dropping the
    // notice.
    let targetCoordinatorSessionId = '';
    try {
        const task = MeshRuntimeStore.getInstance().findQueueEntryById(notice.meshId, notice.taskId);
        if (task) targetCoordinatorSessionId = readNonEmptyString(task.sourceCoordinatorSessionId);
    } catch (e: any) {
        LOG.warn('WorkerProgress', `Could not resolve coordinator for task ${notice.taskId}: ${e?.message || e}`);
    }
    // The queue row carries no daemon id (session id is the only coordinator
    // anchor it stores), so the daemon axis is this machine — matching how
    // mesh-dispatch-failed-notify.ts addresses its own alerts.
    const targetCoordinatorDaemonId = readNonEmptyString(getMachineId());

    const nodeLabel = notice.nodeId || notice.sessionId || notice.taskId;
    try {
        notifyMeshCoordinator({
            event: WORKER_PROGRESS_EVENT_NAME,
            meshId: notice.meshId,
            nodeLabel,
            ...(notice.nodeId ? { nodeId: notice.nodeId } : {}),
            metadataEvent: {
                source: 'worker_progress_update',
                taskId: notice.taskId,
                ...(notice.sessionId ? { sessionId: notice.sessionId } : {}),
                // ★The note TEXT rides here. This is a local daemon→coordinator
                // queue, not the cloud status path — the server content boundary
                // is not in play. The `mesh_turn_events` row for the same note
                // stays content-free (length only), which is what keeps the
                // LEDGER meta-only per design §9.1.
                note: notice.note,
                // Never terminal. Named explicitly so a future drain-side reader
                // cannot mistake this for a completion by its shape.
                terminal: false,
                coordinatorMessage: notice.coordinatorMessage,
            },
            coordinatorMessage: notice.coordinatorMessage,
            queuedAt: notice.nowMs,
            ...(targetCoordinatorDaemonId ? { targetCoordinatorDaemonId } : {}),
            ...(targetCoordinatorSessionId ? { targetCoordinatorSessionId } : {}),
        });
    } catch (e: any) {
        LOG.warn('WorkerProgress', `Failed to queue progress notice for task ${notice.taskId}: ${e?.message || e}`);
    }
};
