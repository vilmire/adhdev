// Mesh tool implementations — queue management: viewing the queue, cancelling a
// task (with the in-flight stop of the session that claimed it) and requeueing.
// Enqueueing lives in mesh-tools-queue.ts; mesh-tools.ts is the tool barrel.
import { recordMeshCoordinatorToolCall, refreshMeshFromDaemon, readQueueFromDaemon, readActiveWorkFromDaemon, buildActiveWorkPollingGuidance, type MeshContext } from './mesh-tools-internal.js';
import { sanitizeQueueStatusFilter, normalizeQueueViewMode, prioritizeActiveQueueRows, annotateQueueStaleness, filterQueueForView, queueViewStatusSet, buildQueueStatusSummaryFromCounts, buildQueueStatusSummary, buildQueueMaintenanceCountsReport, buildQueueMaintenanceReport, HISTORICAL_QUEUE_STATUSES, compactQueueRows, ACTIVE_QUEUE_STATUSES, compactActiveWorkRecords, buildCompactQueueMaintenanceReport, COMPACT_MAX_ACTIVE_QUEUE_ROWS, COMPACT_MAX_ACTIVE_WORK_ROWS, compactQueueRow, type QueueViewMode } from './mesh-queue-helpers.js';
import { readQueueActiveView } from './mesh-daemon-reads.js';
import { describeTaskDependencyState, summarizeQueueEntryInputForView, buildCompactStaleDirectWorkSummary, buildOrphanedPinNotice, type MeshWorkQueueEntry, type OrphanedPinnedTask } from '@adhdev/daemon-core';
import { collectMeshNodesWithRuntime } from './mesh-held-node-state.js';
import { scheduleBackgroundDirectReconcile } from './mesh-status-background.js';
import { summarizeTaskMessage } from './mesh-tools-internal-core.js';
import { queueCancel, orphanedPinNotify, queueRequeue } from '../ipc/turn-commands.js';
import { readString } from '@adhdev/mesh-shared';
import { IpcTransport } from '../transports/ipc.js';
import { unwrapCommandPayload } from './mesh-session-helpers.js';

export async function meshViewQueue(
    ctx: MeshContext,
    args: { status?: string[]; view?: QueueViewMode; compact?: boolean; verbose?: boolean; refresh?: boolean },
): Promise<string> {
    const rateResult = await recordMeshCoordinatorToolCall(ctx, 'mesh_view_queue');
    // Default to the slim payload for LLM callers; verbose forces the full payload.
    const compact = args.verbose === true ? false : (args.compact ?? true);
    // An explicit refresh asks the coordinator to nudge members to push (never a read).
    const probeOpts = args.refresh === true ? { refresh: true } : undefined;
    try {
        await refreshMeshFromDaemon(ctx);
        const statusFilter = sanitizeQueueStatusFilter(args.status);
        const view = normalizeQueueViewMode(args.view);
        // Compact never emits historical rows, so it reads only the ACTIVE rows plus
        // the daemon's whole-queue counts and the dependency heads those rows point
        // at (read-latency pass 2026-09-27: was the whole queue — 5 MB, 1,567 of
        // 1,568 rows historical on the preview daemon). Verbose reads the full queue.
        const activeView = compact ? await readQueueActiveView(ctx) : null;
        const rawQueue = activeView
            ? activeView.activeRows as unknown as MeshWorkQueueEntry[]
            : await readQueueFromDaemon(ctx);
        // M1: annotate dependency state (waitingOn, dependenciesSatisfied) at view time.
        const dependencyRows: Array<{ id: string; status: string; blockedReason?: string; cancelReason?: string }> = activeView
            ? [...rawQueue, ...activeView.dependencyHeads]
            : rawQueue;
        const statusById = new Map(dependencyRows.map(task => [task.id, task.status]));
        const depMetaById = new Map(dependencyRows.map(task => [task.id, task] as const)) as unknown as Map<string, MeshWorkQueueEntry>;
        const withDependencies = rawQueue.map(task => {
            if (!Array.isArray(task.dependsOn) || task.dependsOn.length === 0) return task;
            const depState = describeTaskDependencyState(task, statusById, depMetaById);
            return { ...task, ...depState };
        });
        // Node/session decoration is the coordinator daemon's answer only. See
        // annotateQueueStaleness's liveVerifiedNodes param for why "nothing held
        // yet" must never count as evidence of absence: __liveProbeVerified stays
        // false for such a node. The node shape is a superset of the plain one (adds __liveProbeVerified;
        // sessions merge identically), so it's reused below for the active-work
        // evidence instead of probing twice.
        const liveNodes = await collectMeshNodesWithRuntime(ctx, probeOpts);
        const fullQueue = prioritizeActiveQueueRows(annotateQueueStaleness(withDependencies, ctx.mesh, liveNodes));
        const queue = filterQueueForView(fullQueue, view, statusFilter);
        const viewStatuses = queueViewStatusSet(view, statusFilter);
        const summary = activeView
            ? buildQueueStatusSummaryFromCounts(activeView.counts, fullQueue)
            : buildQueueStatusSummary(fullQueue);
        const visibleSummary = activeView
            ? buildQueueStatusSummaryFromCounts(activeView.counts, fullQueue, viewStatuses)
            : buildQueueStatusSummary(queue);
        const maintenance = activeView
            ? buildQueueMaintenanceCountsReport(
                fullQueue,
                (summary.historicalCount as number) ?? 0,
                activeView.oldHistoricalCount,
            )
            : buildQueueMaintenanceReport(fullQueue);
        // Without a view/status filter `visibleSummary` IS `summary`: compact emits
        // the visible* copies only for a filtered view.
        const filtered = Boolean(statusFilter?.length) || view !== 'all';
        // C-W9a: active work is computed in the daemon over the open direct dispatches
        // (mesh_direct attempts) and its records (+ turn outcomes), for THIS view's
        // annotated queue; the inputs come back for the dispatch-failure list below.
        // The direct-dispatch transcript reconcile is a WRITE-side nudge the response
        // does not need (see mesh-status-background.ts) — kicked in the background,
        // same as mesh_status, instead of blocking this read on a live read_chat.
        // No `queue` argument: the daemon reads its own (it used to receive this
        // view's whole annotated queue back — 5.3 MB out). Active work reads no
        // view annotation.
        const activeWorkView = await readActiveWorkFromDaemon(ctx, { nodes: liveNodes, recordTail: 200, includeInputs: true });
        scheduleBackgroundDirectReconcile(ctx, liveNodes, activeWorkView.directDispatches, activeWorkView.records);
        const ledgerEntries = activeWorkView.records;
        const activeWorkEvidence = activeWorkView.activeWork!;
        const recentDispatchFailures = ledgerEntries
            .filter(e => e.kind === 'p2p_dispatch_failed')
            .slice(-20)
            .map(e => ({
                nodeId: e.nodeId,
                taskId: e.payload?.taskId,
                error: e.payload?.error,
                via: e.payload?.via,
                failedAt: e.payload?.dispatchFailedAt || e.timestamp,
            }));
        // PIN-PARKING: surface parked rows as their own section rather than leaving
        // them to be spotted among the pending rows.
        //
        // A parked task is pending-shaped but behaves nothing like pending work: no
        // session will ever claim it and no timer will re-home it, so it is invisible
        // in every "is anything moving?" signal the coordinator actually reads
        // (activeWork, autoLaunch, the status counts). Left to blend in, it is a queue
        // row that looks like progress and is in fact a dead end — which is the same
        // silent loss parking was introduced to prevent, one layer up. Named
        // explicitly, with its original addressee and the reason it parked, it is
        // something the coordinator can act on.
        //
        // Deliberately NOT compacted away: this array is bounded by how many pins go
        // stale (single digits in practice, and each entry a handful of ids), and
        // hiding it in compact mode would defeat its purpose for exactly the busy
        // meshes where it matters most.
        const parkedTasks = fullQueue
            .filter((task: any) => task?.parked?.reason)
            .map((task: any) => ({
                taskId: task.id,
                parkedAt: task.parked.parkedAt,
                reason: task.parked.reason,
                originalTargetSessionId: task.parked.targetSessionId,
                originalTargetNodeId: task.parked.targetNodeId,
                currentTargetSessionId: task.targetSessionId,
                missionId: task.missionId,
                message: summarizeTaskMessage(task.message),
            }));
        const staleAssignedTasks = (maintenance as any).staleAssignedTasks || [];
        const requestedHistoricalRows = queue.some((task: any) => HISTORICAL_QUEUE_STATUSES.has(String(task?.status || '')));
        const pollingGuidance = buildActiveWorkPollingGuidance(activeWorkEvidence.summary);

        // Compact mode: completed/failed/cancelled historical row arrays are the main
        // payload bloat (mesh_view_queue has overflowed 250k chars on busy meshes).
        // Drop them in favor of the status counts that summary/visibleSummary already
        // carry, but keep pending/assigned active rows — those drive coordinator
        // dispatch decisions. verbose=true returns every row as before.
        const activeOnlyQueue = queue.filter((task: any) => !HISTORICAL_QUEUE_STATUSES.has(String(task?.status || '')));
        // Compact mode: cap active rows and truncate per-row messages (a busy mesh
        // can carry dozens of multi-KB task messages → 70KB+ in the active array).
        const compactQueueResult = compact ? compactQueueRows(activeOnlyQueue) : { rows: activeOnlyQueue, omitted: 0 };
        // MESH-IMAGE-DISPATCH: this is a VIEW surface, so a persisted input envelope
        // (which may carry base64 image data) must never be echoed verbatim here —
        // only the dispatch path needs the real envelope. Replace it with a
        // content-free summary (partCount/partTypes).
        const visibleQueue = (compact ? compactQueueResult.rows : queue).map((task: any) => summarizeQueueEntryInputForView(task));
        const wantActiveQueueArray = view === 'active' || statusFilter?.some(status => ACTIVE_QUEUE_STATUSES.has(status));
        const wantHistoricalQueueArray = !compact && (view === 'historical' || requestedHistoricalRows);
        // activeWork carries the full task message/summary per record — the single
        // largest payload source on a busy mesh. Slim + cap it in compact mode.
        const activeWorkResult = compact
            ? compactActiveWorkRecords(activeWorkEvidence.activeWork)
            : { records: activeWorkEvidence.activeWork, omitted: 0 };

        // staleDirectWork is a full MeshActiveWorkRecord[] of orphaned/historical
        // direct dispatches — it is the second major payload-bloat source (the first
        // being historical queue rows). In compact mode, collapse it to the same
        // bounded summary mesh_status uses and only emit the full array in verbose mode.
        const staleDirectWorkSummary = buildCompactStaleDirectWorkSummary(activeWorkEvidence.staleDirectWork, {
            note: activeWorkEvidence.staleDirectWorkNote,
            detailHint: 'Full stale direct entries are omitted from mesh_view_queue in compact mode. Call mesh_view_queue with verbose=true, or inspect mesh_task_history for ledger detail.',
        });
        // queueMaintenance/cleanupDryRun serialize the same maintenance object whose
        // cleanupCandidates array scales with old historical record count. In compact
        // mode drop the per-row arrays in favor of counts.
        const maintenanceForResponse = compact ? buildCompactQueueMaintenanceReport(maintenance) : maintenance;

        return JSON.stringify({
            success: true,
            payloadMode: compact ? 'compact' : 'full',
            sourceOfTruth: {
                kind: 'mesh_work_queue_file',
                activeStatuses: ['pending', 'assigned'],
                historicalStatuses: ['completed', 'failed', 'cancelled'],
                notes: 'pending/assigned are active work; completed/failed/cancelled are historical ledger records and never stale assignments.',
            },
            filter: {
                view,
                statuses: statusFilter,
                filtered,
            },
            queue: visibleQueue,
            ...(compact ? { historicalRowsOmitted: true, historicalRowsHint: 'Completed/failed/cancelled rows are omitted in compact mode; see historicalCounts. Call mesh_view_queue with verbose=true (or view=historical, compact=false) for full rows.' } : {}),
            ...(compact && compactQueueResult.omitted > 0 ? {
                activeRowsOmitted: compactQueueResult.omitted,
                activeRowsHint: `Showing the first ${COMPACT_MAX_ACTIVE_QUEUE_ROWS} active rows (per-row messages truncated). ${compactQueueResult.omitted} more active row(s) omitted — see activeCount/activeCounts for the complete total or use verbose=true.`,
            } : {}),
            activeWork: activeWorkResult.records,
            ...(compact && activeWorkResult.omitted > 0 ? {
                activeWorkOmitted: activeWorkResult.omitted,
                activeWorkHint: `Showing the first ${COMPACT_MAX_ACTIVE_WORK_ROWS} active-work records (messages truncated). ${activeWorkResult.omitted} more omitted — see activeWorkSummary for complete counts or use verbose=true.`,
            } : {}),
            staleDirectWorkSummary,
            ...(compact ? {} : { staleDirectWork: activeWorkEvidence.staleDirectWork }),
            activeWorkSummary: activeWorkEvidence.summary,
            ...(pollingGuidance ? { pollingGuidance } : {}),
            ...(rateResult.rateLimitExceeded ? { pollingRateAdvisory: { type: 'rate_limit_exceeded', tool: 'mesh_view_queue', callsInWindow: rateResult.callsInWindow, message: rateResult.advisory } } : {}),
            summary,
            ...(!compact || filtered ? { visibleSummary } : {}),
            activeCounts: summary.activeCounts,
            historicalCounts: summary.historicalCounts,
            ...(!compact || filtered ? {
                visibleActiveCounts: visibleSummary.activeCounts,
                visibleHistoricalCounts: visibleSummary.historicalCounts,
            } : {}),
            activeCount: summary.activeCount,
            historicalCount: summary.historicalCount,
            ...(!compact || filtered ? {
                visibleActiveCount: visibleSummary.activeCount,
                visibleHistoricalCount: visibleSummary.historicalCount,
            } : {}),
            ...(parkedTasks.length > 0 ? {
                parkedTasks,
                parkedTaskCount: parkedTasks.length,
                parkedTaskNote: 'PARKED tasks are held for an explicit coordinator decision and are claimable by NOBODY — their delta was addressed to a session whose pin went stale, and the daemon deliberately will not re-home it onto another session. '
                    + 'Nothing will move them until you act. Exits: mesh_queue_requeue(task_id, target_session_id=<live session>) to re-target, or with clear_target_session=true to let any compatible session take it; '
                    + 'add message=<rewritten instruction> to the same call if the situation moved on while it waited; mesh_queue_cancel(task_id) if it is moot. Any requeue unparks the task. '
                    + 'Left untouched they are failed (with a notification) once past the parked-task retention window.',
            } : {}),
            staleAssignedTasks: compact ? staleAssignedTasks.slice(0, 10).map(compactQueueRow) : staleAssignedTasks,
            staleAssignedCount: (maintenance as any).staleAssignedCount,
            queueMaintenance: maintenanceForResponse,
            // Alias of queueMaintenance — verbose only (compact keeps one copy).
            ...(compact ? {} : { cleanupDryRun: maintenanceForResponse }),
            ...(recentDispatchFailures.length > 0 ? {
                recentDispatchFailures,
                dispatchFailureCount: recentDispatchFailures.length,
                dispatchFailureNote: 'Remote P2P dispatch attempts that failed. Affected tasks remain pending and may require mesh_queue_requeue if no idle session picks them up.',
            } : {}),
            ...(wantActiveQueueArray && !compact ? {
                activeQueue: queue.filter((task: any) => ACTIVE_QUEUE_STATUSES.has(String(task?.status || ''))),
            } : {}),
            // In compact mode the `queue` field already holds exactly the slimmed+
            // capped active rows, so the separate activeQueue array would be a verbatim
            // duplicate (it doubled the payload). Point callers at `queue` instead.
            ...(wantActiveQueueArray && compact ? { activeQueueHint: 'In compact mode the active rows are in `queue` (already filtered to pending/assigned). Use verbose=true for the separate full activeQueue array.' } : {}),
            ...(wantHistoricalQueueArray ? {
                historicalQueue: queue.filter((task: any) => HISTORICAL_QUEUE_STATUSES.has(String(task?.status || ''))),
            } : {}),
            // Back-compat alias of staleAssignedTasks — verbose only (compact keeps one copy).
            ...(compact ? {} : { staleAssignments: staleAssignedTasks }),
        }, null, 2);
    } catch (e: any) {
        return JSON.stringify({ success: false, error: e.message });
    }
}

export async function meshQueueCancel(
    ctx: MeshContext,
    args: { task_id?: string; taskId?: string; reason?: string },
): Promise<string> {
    try {
        const taskId = (args.task_id || args.taskId || '').trim();
        if (!taskId) return JSON.stringify({ success: false, error: 'task_id required' });

        // MESH-DISPATCH-MISROUTE: read the PRE-cancel entry so we know whether the task was
        // already dispatched to a live worker. cancelTask overwrites status to 'cancelled'
        // but preserves assignedSessionId/Node/Provider, so the assignment fields survive —
        // only the status must be captured before the mutation.
        // C-W9a: the cancel runs in the daemon (`queue_cancel`), which returns the row
        // as it was BEFORE the mutation alongside the cancelled one.
        const cancelled = await queueCancel(ctx.transport, { meshId: ctx.mesh.id, taskId, ...(args.reason !== undefined ? { reason: args.reason } : {}) });
        const preCancel = (cancelled.before ?? undefined) as {
            status?: string; assignedSessionId?: string; assignedNodeId?: string; assignedProviderType?: string;
        } | undefined;
        const wasAssigned = preCancel?.status === 'assigned';
        const assignedSessionId = readString(preCancel?.assignedSessionId) || undefined;
        const assignedNodeId = readString(preCancel?.assignedNodeId) || undefined;
        const assignedProviderType = readString(preCancel?.assignedProviderType) || undefined;

        const task = cancelled.task as unknown as MeshWorkQueueEntry | null;
        if (!task) return JSON.stringify({ success: false, error: `Queue task '${taskId}' not found` });
        ctx.transport.command('trigger_mesh_queue', { meshId: ctx.mesh.id }).catch(() => {});

        // MESH-DISPATCH-MISROUTE (fix 2): cancelling the queue row alone does NOT stop a worker
        // that already claimed the task and is generating — it ran to completion and committed
        // to the (often base) checkout. When the task was dispatched to a live session, propagate
        // a stop so the worker halts its in-flight generation. Guards:
        //  - only for an 'assigned' task with a resolvable assignedSessionId (a pending/terminal
        //    task has no live worker to stop — sending one would be a no-op at best);
        //  - NEVER stop the coordinator's own session (ctx.coordinatorSessionId) — that is the
        //    session issuing the cancel, not the worker. Stopping it would kill the coordinator.
        // The stop rides agent_command(action:'stop'), which is already in the router's
        // MESH_FORWARDABLE_SESSION_COMMANDS set: a session hosted on a REMOTE worker daemon is
        // auto-forwarded to that daemon (cross-machine workers are reached), and meshContext.nodeId
        // keeps the fail-closed cross-node scoping AND now seeds the router's deterministic
        // owner-resolution fallback (assignedNodeId → owner daemon) so a worktree-clone worker
        // whose session id missed the coordinator's cached active-sessions snapshot is still reached.
        // CANCEL-STOP false-positive fix: AWAIT the stop and report its REAL outcome
        // (stopped / no response from remote worker daemon / "CLI agent not running") instead of
        // pre-stamping attempted:true on a fire-and-forget call. Best-effort: any stop failure is
        // caught and surfaced in workerStop.reason — it must NEVER fail the cancel itself, which
        // already committed the queue 'cancelled' transition above.
        let workerStop: {
            attempted: boolean; stopped?: boolean; sessionId?: string; nodeId?: string; reason?: string;
            /** CANCEL-STOP-TASK-SCOPE: the daemon spared this session — it had moved on. */
            skipped?: string; sessionTaskId?: string;
        } = { attempted: false };
        if (wasAssigned && assignedSessionId && assignedSessionId !== ctx.coordinatorSessionId && assignedProviderType) {
            workerStop = { attempted: true, sessionId: assignedSessionId, nodeId: assignedNodeId };
            try {
                const stopResult = await ctx.transport.command('agent_command', {
                    targetSessionId: assignedSessionId,
                    cliType: assignedProviderType,
                    agentType: assignedProviderType,
                    action: 'stop',
                    // CANCEL-STOP-TASK-SCOPE: taskId rides UNCONDITIONALLY, not only when a
                    // node is known. It is what makes the daemon's stop task-scoped: without
                    // it the daemon cannot tell whether this session is still running the
                    // cancelled task, and a stale 'assigned' row would kill a session that had
                    // moved on to unrelated work. nodeId stays optional (it only seeds the
                    // router's owner-resolution fallback), so it keeps its own guard.
                    meshContext: {
                        meshId: ctx.mesh.id,
                        taskId,
                        ...(assignedNodeId ? { nodeId: assignedNodeId } : {}),
                    },
                });
                const stopped = stopResult?.stopped === true || stopResult?.success === true;
                workerStop.stopped = stopped;
                if (!stopped) {
                    workerStop.reason = readString(stopResult?.error) || 'worker stop not confirmed';
                    // CANCEL-STOP-TASK-SCOPE: a task-mismatch refusal is not a failure — the
                    // daemon deliberately spared a session that had moved on to another task.
                    // Name it distinctly so the coordinator does not read it as an unreachable
                    // worker and retry/escalate against a session that is working correctly.
                    if (readString(stopResult?.reason) === 'stop_task_mismatch') {
                        workerStop.skipped = 'session_moved_to_other_task';
                        workerStop.sessionTaskId = readString(stopResult?.sessionTaskId) || undefined;
                    }
                }
            } catch (e: any) {
                workerStop.stopped = false;
                workerStop.reason = e?.message || String(e);
            }
        } else if (wasAssigned && assignedSessionId === ctx.coordinatorSessionId) {
            workerStop = { attempted: false, reason: 'assigned_session_is_coordinator_self — stop suppressed' };
        }

        // CANCEL-ORPHANS-PINNED-TASK: the stop above is a HARD stop (CliManager.stopSession
        // removes the instance), so every OTHER pending queue task hard-pinned to that same
        // session is now undeliverable AND un-launchable — it can neither reach the dead
        // session nor spawn a new one (the pin makes auto-launch skip with
        // 'target_session_constraint'). Live repro 2026-08-16: 12 minutes with zero
        // generating sessions before a human noticed. Detect it here — at the moment we
        // KNOW which session we just killed — and page the coordinator with the exact
        // requeue call. Notify-only by design; see mesh-orphaned-pin-notify.ts for why the
        // pins are not cleared automatically and why detection cannot live in stopSession.
        //
        // Gated on `attempted`, NOT on `stopped`. No stop attempt → no session death → no
        // orphans, so the guard is right. But an ATTEMPTED-yet-unconfirmed stop ("no response
        // from remote worker daemon") must still notify: either the stop landed and the pins
        // are dead, or the worker daemon is unreachable — in which case tasks pinned to a
        // session on it are no more deliverable. Both readings leave the coordinator with
        // stranded work, and the notice names the uncertainty by naming its cause. Staying
        // silent on the unconfirmed case would re-open the exact hole this closes, since that
        // is the case where a stop is MOST likely to have half-happened.
        //
        // Best-effort, exactly like the stop itself — a failure here must never fail the
        // cancel, which already committed the 'cancelled' transition.
        //
        // CANCEL-STOP-TASK-SCOPE exception: a `stop_task_mismatch` refusal is categorically
        // different from an unconfirmed stop. It is a POSITIVE answer from a reachable daemon
        // — "that session is alive and working another task, so I did not kill it". No session
        // died, so nothing pinned to it is orphaned, and paging the coordinator would be a
        // false alarm telling it to requeue work that is fine where it is.
        // C-W9c: was in-process `notifyCoordinatorOfOrphanedPins` (a live queue read
        // + a `notifyMeshCoordinator` event write, both daemon-only concerns); now
        // the `orphaned_pin_notify` IPC round trip runs the whole call in the daemon.
        let orphanedPinnedTasks: OrphanedPinnedTask[] = [];
        if (workerStop.attempted && assignedSessionId && workerStop.skipped !== 'session_moved_to_other_task') {
            try {
                const { orphans } = await orphanedPinNotify(ctx.transport, {
                    meshId: ctx.mesh.id,
                    stoppedSessionId: assignedSessionId,
                    excludeTaskId: taskId,
                    cause: `Cancelling task ${taskId}`,
                    ...(assignedNodeId ? { nodeId: assignedNodeId } : {}),
                    ...(ctx.coordinatorSessionId ? { coordinatorSessionId: ctx.coordinatorSessionId } : {}),
                });
                orphanedPinnedTasks = orphans as unknown as OrphanedPinnedTask[];
            } catch {
                // The daemon-side helper already logs its own failures (queue read /
                // event persist). This outer catch only guarantees the cancel response
                // is still returned.
                orphanedPinnedTasks = [];
            }
        }

        return JSON.stringify({
            success: true,
            task,
            workerStop,
            // Surface the orphans inline too: the pending event reaches the coordinator on its
            // next drain, but the cancel's own response is read immediately — the coordinator
            // can act without waiting for the event round-trip.
            ...(orphanedPinnedTasks.length > 0 ? {
                orphanedPinnedTasks,
                orphanedPinnedTasksWarning: buildOrphanedPinNotice(
                    orphanedPinnedTasks,
                    assignedSessionId!,
                    `Cancelling task ${taskId}`,
                ),
            } : {}),
        }, null, 2);
    } catch (e: any) {
        return JSON.stringify({ success: false, error: e.message });
    }
}

export async function meshQueueRequeue(
    ctx: MeshContext,
    args: {
        task_id?: string;
        taskId?: string;
        reason?: string;
        target_node_id?: string;
        targetNodeId?: string;
        target_session_id?: string;
        targetSessionId?: string;
        clear_target_node?: boolean;
        clearTargetNode?: boolean;
        keep_target_session?: boolean;
        keepTargetSession?: boolean;
        force?: boolean;
        message?: string;
    },
): Promise<string> {
    try {
        const taskId = (args.task_id || args.taskId || '').trim();
        if (!taskId) return JSON.stringify({ success: false, error: 'task_id required' });
        const targetNodeId = (args.target_node_id || args.targetNodeId || '').trim() || undefined;
        const targetSessionId = (args.target_session_id || args.targetSessionId || '').trim() || undefined;
        const keepTargetSession = args.keep_target_session === true || args.keepTargetSession === true;
        const clearTargetNode = args.clear_target_node === true || args.clearTargetNode === true;
        // clearTargetSession contract: an explicit target session pins the row (never cleared);
        // otherwise clear the stale target session unless the caller asked to keep it.
        const clearTargetSession = targetSessionId ? false : !keepTargetSession;
        const force = args.force === true;
        // PIN-PARKING (edit): optional instruction rewrite. Blank-guarded in
        // requeueTask so an empty string never blanks a task's only instruction.
        const message = typeof args.message === 'string' && args.message.trim() ? args.message : undefined;

        // CANON-IDENTITY cross-process single-flight: the in-flight guard set
        // (daemon-core mesh-task-inflight) is process-LOCAL. In IpcTransport (cloud /
        // multi-coordinator) mode this tool runs in the COORDINATOR process, but the
        // dispatch that marks a task in-flight (tryAssignQueueTask → beginTaskDispatchInFlight)
        // runs in the mesh-host DAEMON process. An in-process requeueTask here would consult a
        // DIFFERENT (empty) Set, so isTaskDispatchInFlight is always false, the guard is a
        // no-op, and a requeue-while-generating flips the row to pending → a SECOND session
        // claims the SAME task (the double-dispatch). Delegate the requeue to the daemon so
        // begin (dispatch) and check (requeue guard) are co-located in ONE process. The daemon
        // handler (requeue_mesh_queue_task) implements the same guard + the refused signal,
        // which we surface to the caller verbatim. LocalTransport (standalone) runs daemon and
        // coordinator in the same process, so its in-process path already sees the right Set.
        if (ctx.transport instanceof IpcTransport) {
            const raw = await ctx.transport.command('requeue_mesh_queue_task', {
                meshId: ctx.mesh.id,
                taskId,
                reason: args.reason,
                ...(targetNodeId ? { targetNodeId } : {}),
                ...(targetSessionId ? { targetSessionId } : {}),
                clearTargetNode,
                clearTargetSession,
                force,
                ...(message ? { message } : {}),
            });
            const result = unwrapCommandPayload(raw) || {};
            // Refused (in-flight / live-generating guard) or daemon error → surface verbatim
            // so the coordinator learns the requeue did NOT open a second dispatch.
            if (result.success === false) {
                return JSON.stringify(result, null, 2);
            }
            const task = result.task;
            if (!task) return JSON.stringify({ success: false, error: `Queue task '${taskId}' not found` });
            if (task.status === 'failed' && task.cancelReason?.startsWith('max_retries_exceeded')) {
                return JSON.stringify({
                    success: false,
                    code: 'max_retries_exceeded',
                    error: task.cancelReason,
                    task,
                    hint: 'Use force=true to bypass the retry cap for explicit operator recovery.',
                }, null, 2);
            }
            const triggerPreferredNodeId = targetNodeId || task.targetNodeId || undefined;
            ctx.transport.command('trigger_mesh_queue', {
                meshId: ctx.mesh.id,
                ...(triggerPreferredNodeId ? { preferredNodeId: triggerPreferredNodeId } : {}),
            }).catch(() => {});
            return JSON.stringify({ success: true, task }, null, 2);
        }

        // C-W9a: the requeue runs in the daemon (`queue_requeue`).
        const task = (await queueRequeue(ctx.transport, {
            meshId: ctx.mesh.id,
            taskId,
            options: {
                ...(args.reason !== undefined ? { reason: args.reason } : {}),
                ...(targetNodeId !== undefined ? { targetNodeId } : {}),
                ...(targetSessionId !== undefined ? { targetSessionId } : {}),
                ...(clearTargetNode !== undefined ? { clearTargetNode } : {}),
                ...(clearTargetSession !== undefined ? { clearTargetSession } : {}),
                ...(force !== undefined ? { force } : {}),
                ...(message ? { message } : {}),
            },
        })).task as unknown as MeshWorkQueueEntry | null;
        if (!task) return JSON.stringify({ success: false, error: `Queue task '${taskId}' not found` });
        if (task.status === 'failed' && task.cancelReason?.startsWith('max_retries_exceeded')) {
            return JSON.stringify({
                success: false,
                code: 'max_retries_exceeded',
                error: task.cancelReason,
                task,
                hint: 'Use force=true to bypass the retry cap for explicit operator recovery.',
            }, null, 2);
        }
        // Pass the task's target node as preferredNodeId so the trigger claims the
        // requeued task on the intended node's idle session FIRST (router.ts
        // preferred-node tier) before the general round-robin picks a different node.
        // Honours an explicit requeue target_node_id over the persisted one.
        const triggerPreferredNodeId = targetNodeId || task.targetNodeId || undefined;
        ctx.transport.command('trigger_mesh_queue', {
            meshId: ctx.mesh.id,
            ...(triggerPreferredNodeId ? { preferredNodeId: triggerPreferredNodeId } : {}),
        }).catch(() => {});
        return JSON.stringify({ success: true, task }, null, 2);
    } catch (e: any) {
        return JSON.stringify({ success: false, error: e.message });
    }
}
