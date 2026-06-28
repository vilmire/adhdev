// Mesh tool implementations — queue domain.
// Pure move out of mesh-tools.ts (no behavior change). Shared helpers, types, module
// state and dependency re-exports live in ./mesh-tools-internal.ts; mesh-tools.ts is a barrel.

import {
    ACTIVE_QUEUE_STATUSES,
    COMPACT_MAX_ACTIVE_QUEUE_ROWS,
    COMPACT_MAX_ACTIVE_WORK_ROWS,
    HISTORICAL_QUEUE_STATUSES,
    IpcTransport,
    annotateQueueStaleness,
    appendLedgerEntry,
    buildActiveWorkPollingGuidance,
    buildCompactQueueMaintenanceReport,
    buildCompactStaleDirectWorkSummary,
    buildMeshActiveWork,
    buildMeshNodeCapabilityTags,
    buildQueueMaintenanceReport,
    buildQueueStatusSummary,
    buildQueueTriggerGuidance,
    cancelTask,
    collectMeshViewQueueNodesWithLiveSessions,
    compactActiveWorkRecords,
    compactQueueRow,
    compactQueueRows,
    describeTaskDependencyState,
    enqueueTask,
    filterQueueForView,
    getActiveDirectDispatches,
    getQueue,
    ipcDispatchToRemoteAgent,
    isLocalControlPlaneNode,
    markStaleDirectDispatches,
    meshNodeIdMatches,
    nodeSatisfiesRequiredTags,
    normalizeMeshCapabilityTags,
    normalizeQueueViewMode,
    prioritizeActiveQueueRows,
    readLedgerEntries,
    readString,
    reconcileDirectDispatchesFromTranscriptEvidence,
    recordMeshToolCall,
    refreshMeshFromDaemon,
    requeueTask,
    resolveCoordinatorDaemonId,
    resolvePreferredWorktreeNodeId,
    sanitizeQueueStatusFilter,
    summarizeTaskMessage,
    triggerMeshQueueAndReport,
} from './mesh-tools-internal.js';
import type {
    MeshContext,
    QueueViewMode,
} from './mesh-tools-internal.js';

export async function meshEnqueueTask(
    ctx: MeshContext,
    args: {
        message: string; task_mode?: string; taskMode?: string;
        readonly?: boolean; read_only?: boolean;
        requiredTags?: string[]; required_tags?: string[];
        targetNodeId?: string; target_node_id?: string;
        targetNode?: string; target_node?: string;
        preferWorktree?: boolean; prefer_worktree?: boolean;
        dependsOn?: string[]; depends_on?: string[];
        missionId?: string; mission_id?: string;
    },
): Promise<string> {
    const taskMode = readString(args.task_mode) || readString(args.taskMode);
    const readonly = args.readonly === true || args.read_only === true;
    const requiredTags = normalizeMeshCapabilityTags(Array.isArray(args.requiredTags) ? args.requiredTags : args.required_tags);
    const dependsOn = Array.isArray(args.dependsOn) ? args.dependsOn : Array.isArray(args.depends_on) ? args.depends_on : undefined;
    const missionId = readString(args.missionId) || readString(args.mission_id) || undefined;
    // Routing hint: explicit target id wins; otherwise prefer_worktree resolves to the
    // most recently cloned worktree node so isolated work is not preemptively claimed by
    // the first idle base node. Either becomes a targetNodeId, which the node-targeted
    // claim tier honors as a HARD constraint (only that node may claim).
    //
    // MESH-DISPATCH-MISROUTE: accept target_node / targetNode in addition to
    // target_node_id / targetNodeId. A coordinator that passed target_node (the natural
    // name) previously had it silently dropped — the task enqueued UNPINNED and any idle
    // node, including a different machine's base, could claim it (the live cross-machine
    // misroute). Resolving every spelling closes that gap.
    const explicitTargetRaw = readString(args.targetNodeId) || readString(args.target_node_id)
        || readString(args.targetNode) || readString(args.target_node) || undefined;
    const preferWorktree = args.preferWorktree === true || args.prefer_worktree === true;

    // MESH-DISPATCH-MISROUTE: a target pin is a hard constraint, so an unresolvable target
    // id must FAIL LOUDLY rather than silently fall through to an unpinned (any-node) task.
    // Canonicalize the supplied id to the live mesh node's own id via the shared identity
    // normalizer (handles id / nodeId / node_id and daemon-id forms) so the downstream raw
    // `node.id === targetNodeId` compares and the claim-tier SQL both match exactly.
    let targetNodeId: string | undefined;
    if (explicitTargetRaw) {
        const matched = ctx.mesh.nodes.find(n => meshNodeIdMatches(n as any, explicitTargetRaw));
        if (!matched) {
            return JSON.stringify({
                success: false,
                code: 'target_node_not_found',
                error: `target node '${explicitTargetRaw}' is not a member of this mesh — refusing to enqueue an unpinned task (it could be claimed by any node, including a different machine). Use mesh_list_nodes to get a valid node id.`,
                targetNodeId: explicitTargetRaw,
                availableNodeIds: ctx.mesh.nodes.map(n => (n as any).id).filter(Boolean),
            });
        }
        targetNodeId = readString((matched as any).id) || explicitTargetRaw;
    } else if (preferWorktree) {
        targetNodeId = resolvePreferredWorktreeNodeId(ctx) || undefined;
    }
    try {
        const task = enqueueTask(ctx.mesh.id, args.message, { taskMode, ...(readonly ? { readonly: true } : {}), requiredTags, dependsOn, missionId, targetNodeId, ...(ctx.coordinatorSessionId ? { sourceCoordinatorSessionId: ctx.coordinatorSessionId } : {}) });

        // ── LocalTransport: queue-based pull (standalone daemon, all local) ─────
        if (!(ctx.transport instanceof IpcTransport)) {
            const queueTrigger = await triggerMeshQueueAndReport(ctx);
            return JSON.stringify({
                success: true,
                source: 'queue',
                taskId: task.id,
                status: task.status,
                taskMode: task.taskMode,
                requiredTags: task.requiredTags,
                ...(targetNodeId ? { targetNodeId } : {}),
                ...(preferWorktree && !explicitTargetRaw && !targetNodeId ? { preferWorktreeNoOp: true } : {}),
                queueTrigger,
                ...buildQueueTriggerGuidance(queueTrigger),
            });
        }

        // ── IpcTransport (Cloud Mesh): the queue file lives on THIS machine only.
        //    Remote daemons on other machines cannot read the local queue file.
        //    Strategy: trigger local queue for local nodes, and for remote nodes
        //    directly P2P-dispatch to the first idle session found (enqueue-and-push).
        {
            // 1. Trigger local queue for local node pick-up
            const queueTrigger = await triggerMeshQueueAndReport(ctx);

            // 2. For each remote node, directly dispatch to an idle session via P2P
            const coordinatorDaemonId = resolveCoordinatorDaemonId(ctx);
            const dispatchPromises: Promise<void>[] = [];
            for (const node of ctx.mesh.nodes) {
                const isLocalNode = isLocalControlPlaneNode(ctx, node);
                if (isLocalNode || !node.daemonId) continue;
                // When the task targets a specific node, only that node's daemon
                // should receive the P2P push; others would steal the work.
                if (targetNodeId && node.id !== targetNodeId) continue;
                if (!nodeSatisfiesRequiredTags(requiredTags, buildMeshNodeCapabilityTags(node))) continue;

                // MISROUTE-INJECT-SPLIT: stamp meshContext (nodeId) onto the eager P2P push so the
                // worker's agent_command handler scopes it to THIS node's session via the
                // fail-closed findMeshNodeAdapter, instead of the provider-only fuzzy fallback that
                // can land a freshly-launched worktree node's task on a co-located idle BASE session
                // (the base-leak). Without nodeId the receiver's meshScopeNodeId is empty and it falls
                // through to findAdapter's first-same-cliType match. The queue-claim path already
                // carries this context; the enqueue-and-push path was the only dispatch missing it.
                dispatchPromises.push(
                    ipcDispatchToRemoteAgent(ctx, node, {
                        message: args.message,
                        meshContext: {
                            meshId: ctx.mesh.id,
                            nodeId: node.id,
                            taskId: task.id,
                            ...(coordinatorDaemonId ? { coordinatorDaemonId } : {}),
                        },
                    })
                        .then(result => {
                            if (result.success) {
                                try {
                                    const providerType = result.providerType;
                                    const descriptor = summarizeTaskMessage(args.message);
                                    appendLedgerEntry(ctx.mesh.id, {
                                        kind: 'task_dispatched',
                                        nodeId: node.id,
                                        sessionId: result.sessionId,
                                        providerType,
                                        payload: {
                                            source: 'queue',
                                            via: 'p2p_direct',
                                            taskId: task.id,
                                            message: args.message,
                                            taskTitle: descriptor.taskTitle,
                                            taskSummary: descriptor.taskSummary,
                                            ...(task.taskMode ? { taskMode: task.taskMode } : {}),
                                            ...(providerType ? { providerType } : {}),
                                            targetSessionId: result.sessionId,
                                        },
                                    });
                                } catch { /* best-effort */ }
                            }
                        })
                        .catch((err: any) => {
                            try {
                                appendLedgerEntry(ctx.mesh.id, {
                                    kind: 'p2p_dispatch_failed',
                                    nodeId: node.id,
                                    payload: {
                                        source: 'queue',
                                        via: 'p2p_direct',
                                        taskId: task.id,
                                        error: err?.message || String(err),
                                        dispatchFailedAt: new Date().toISOString(),
                                    },
                                });
                            } catch { /* best-effort */ }
                        }),
                );
            }
            // Fire-and-forget — don't block the coordinator response
            Promise.all(dispatchPromises).catch(() => {});

            return JSON.stringify({
                success: true,
                source: 'queue',
                taskId: task.id,
                status: task.status,
                taskMode: task.taskMode,
                requiredTags: task.requiredTags,
                ...(targetNodeId ? { targetNodeId } : {}),
                ...(preferWorktree && !explicitTargetRaw && !targetNodeId ? { preferWorktreeNoOp: true } : {}),
                queueTrigger,
                ...buildQueueTriggerGuidance(queueTrigger),
            });
        }
    } catch (e: any) {
        const message = e?.message || String(e);
        if (message.includes('live_debug_readonly_guardrail_violation')) {
            return JSON.stringify({ success: false, code: 'live_debug_readonly_guardrail_violation', taskMode, error: message });
        }
        if (message.includes('dependency_cycle_detected')) {
            return JSON.stringify({ success: false, code: 'dependency_cycle_detected', dependsOn, error: message });
        }
        return JSON.stringify({ success: false, error: message });
    }
}

export async function meshViewQueue(
    ctx: MeshContext,
    args: { status?: string[]; view?: QueueViewMode; compact?: boolean; verbose?: boolean },
): Promise<string> {
    const rateResult = recordMeshToolCall({ meshId: ctx.mesh.id, tool: 'mesh_view_queue' });
    // Default to the slim payload for LLM callers; verbose forces the full payload.
    const compact = args.verbose === true ? false : (args.compact ?? true);
    try {
        await refreshMeshFromDaemon(ctx);
        const statusFilter = sanitizeQueueStatusFilter(args.status);
        const view = normalizeQueueViewMode(args.view);
        const rawQueue = getQueue(ctx.mesh.id);
        // M1: annotate dependency state (waitingOn, dependenciesSatisfied) at view time.
        const statusById = new Map(rawQueue.map(task => [task.id, task.status]));
        const withDependencies = rawQueue.map(task => {
            if (!Array.isArray(task.dependsOn) || task.dependsOn.length === 0) return task;
            const depState = describeTaskDependencyState(task, statusById);
            return { ...task, ...depState };
        });
        const fullQueue = prioritizeActiveQueueRows(annotateQueueStaleness(withDependencies, ctx.mesh));
        const queue = filterQueueForView(fullQueue, view, statusFilter);
        const summary = buildQueueStatusSummary(fullQueue);
        const visibleSummary = buildQueueStatusSummary(queue);
        const maintenance = buildQueueMaintenanceReport(fullQueue);
        const liveNodes = await collectMeshViewQueueNodesWithLiveSessions(ctx);
        let ledgerEntries = readLedgerEntries(ctx.mesh.id, { tail: 200 });
        let directDispatches = getActiveDirectDispatches(ctx.mesh.id);
        const directReconciliation = await reconcileDirectDispatchesFromTranscriptEvidence(ctx, liveNodes, directDispatches, ledgerEntries);
        if (directReconciliation.reconciled > 0) {
            ledgerEntries = readLedgerEntries(ctx.mesh.id, { tail: 200 });
            directDispatches = getActiveDirectDispatches(ctx.mesh.id);
        }
        // Mark dispatched entries with no session activity after 30 min as stale.
        markStaleDirectDispatches(ctx.mesh.id);
        directDispatches = getActiveDirectDispatches(ctx.mesh.id);
        const activeWorkEvidence = buildMeshActiveWork({
            meshId: ctx.mesh.id,
            queue: fullQueue,
            ledgerEntries,
            // Always pass MeshRuntimeStore records (may be empty). buildMeshActiveWork uses them for local
            // dispatches and falls through to ledger scan for remote P2P dispatches not in MeshRuntimeStore.
            directDispatches,
            nodes: liveNodes,
        });
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
        const visibleQueue = compact ? compactQueueResult.rows : queue;
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
                filtered: Boolean(statusFilter?.length) || view !== 'all',
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
            visibleSummary,
            activeCounts: summary.activeCounts,
            historicalCounts: summary.historicalCounts,
            visibleActiveCounts: visibleSummary.activeCounts,
            visibleHistoricalCounts: visibleSummary.historicalCounts,
            activeCount: summary.activeCount,
            historicalCount: summary.historicalCount,
            visibleActiveCount: visibleSummary.activeCount,
            visibleHistoricalCount: visibleSummary.historicalCount,
            staleAssignedTasks: compact ? staleAssignedTasks.slice(0, 10).map(compactQueueRow) : staleAssignedTasks,
            staleAssignedCount: (maintenance as any).staleAssignedCount,
            queueMaintenance: maintenanceForResponse,
            cleanupDryRun: maintenanceForResponse,
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
            // Back-compat alias for callers already reading the first hardening payload.
            staleAssignments: compact ? staleAssignedTasks.slice(0, 10).map(compactQueueRow) : staleAssignedTasks,
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
        const preCancel = getQueue(ctx.mesh.id).find((t: any) => t?.id === taskId) as {
            status?: string; assignedSessionId?: string; assignedNodeId?: string; assignedProviderType?: string;
        } | undefined;
        const wasAssigned = preCancel?.status === 'assigned';
        const assignedSessionId = readString(preCancel?.assignedSessionId) || undefined;
        const assignedNodeId = readString(preCancel?.assignedNodeId) || undefined;
        const assignedProviderType = readString(preCancel?.assignedProviderType) || undefined;

        const task = cancelTask(ctx.mesh.id, taskId, { reason: args.reason });
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
        let workerStop: { attempted: boolean; stopped?: boolean; sessionId?: string; nodeId?: string; reason?: string } = { attempted: false };
        if (wasAssigned && assignedSessionId && assignedSessionId !== ctx.coordinatorSessionId && assignedProviderType) {
            workerStop = { attempted: true, sessionId: assignedSessionId, nodeId: assignedNodeId };
            try {
                const stopResult = await ctx.transport.command('agent_command', {
                    targetSessionId: assignedSessionId,
                    cliType: assignedProviderType,
                    agentType: assignedProviderType,
                    action: 'stop',
                    ...(assignedNodeId ? { meshContext: { meshId: ctx.mesh.id, nodeId: assignedNodeId, taskId } } : {}),
                });
                const stopped = stopResult?.stopped === true || stopResult?.success === true;
                workerStop.stopped = stopped;
                if (!stopped) {
                    workerStop.reason = readString(stopResult?.error) || 'worker stop not confirmed';
                }
            } catch (e: any) {
                workerStop.stopped = false;
                workerStop.reason = e?.message || String(e);
            }
        } else if (wasAssigned && assignedSessionId === ctx.coordinatorSessionId) {
            workerStop = { attempted: false, reason: 'assigned_session_is_coordinator_self — stop suppressed' };
        }

        return JSON.stringify({ success: true, task, workerStop }, null, 2);
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
    },
): Promise<string> {
    try {
        const taskId = (args.task_id || args.taskId || '').trim();
        if (!taskId) return JSON.stringify({ success: false, error: 'task_id required' });
        const targetNodeId = (args.target_node_id || args.targetNodeId || '').trim() || undefined;
        const targetSessionId = (args.target_session_id || args.targetSessionId || '').trim() || undefined;
        const keepTargetSession = args.keep_target_session === true || args.keepTargetSession === true;
        const task = requeueTask(ctx.mesh.id, taskId, {
            reason: args.reason,
            targetNodeId,
            targetSessionId,
            clearTargetNode: args.clear_target_node === true || args.clearTargetNode === true,
            clearTargetSession: targetSessionId ? false : !keepTargetSession,
            force: args.force === true,
        });
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
