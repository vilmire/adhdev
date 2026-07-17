// Mesh tool implementations — session domain.
// Pure move out of mesh-tools.ts (no behavior change). Shared helpers, types, module
// state and dependency re-exports live in ./mesh-tools-internal.ts; mesh-tools.ts is a barrel.

import {
    IpcTransport,
    SESSION_PROVIDER_METADATA_TTL_MS,
    annotateRapidReadChatAdvisory,
    appendLedgerEntry,
    buildCoordinatorP2pRelayFailure,
    buildDirectTaskPayload,
    buildMeshActiveWork,
    collectPendingApprovals,
    buildMeshReadChatCacheFallback,
    buildMissingCoordinatorDaemonIdFailure,
    buildMissingNodeReadChatRecovery,
    buildQueueTriggerGuidance,
    collectLiveStatusProbe,
    collectLiveStatusSessions,
    collectMeshViewQueueNodesWithLiveSessions,
    commandForNode,
    compactChatPayload,
    deleteDirectDispatchesByTaskId,
    drainCoordinatorPendingEvents,
    drainPendingMeshCoordinatorEvents,
    enqueueTask,
    extractLaunchPayload,
    extractStatusMetadataSessions,
    findNodeWithRefresh,
    findOptionalNodeWithRefresh,
    getActiveDirectDispatches,
    getQueue,
    getSessionMetadata,
    getWorktreeBootstrapLaunchBlock,
    hasRecentDuplicateDispatch,
    insertDirectDispatch,
    ipcDispatchToRemoteAgent,
    markStaleDirectDispatches,
    reconcileDirectDispatchesFromTranscriptEvidence,
    recordMeshToolCall,
    isIdleSessionRecord,
    isLocalControlPlaneNode,
    isMeshCoordinatorSessionRecord,
    isMeshOwnedDelegateSession,
    isP2pRelayTransportFailure,
    isTerminalSessionRecord,
    isUnmanagedSessionRecord,
    isWorkerTaskMode,
    meshSessionCacheKey,
    meshSessionProviderMetadata,
    missingProviderPriorityMessage,
    pruneStaleDirectDispatches,
    randomUUID,
    readLedgerEntries,
    readProviderPriority,
    readSessionRecordId,
    readSpawnedSessionVisibility,
    readString,
    recordDirectDispatchTask,
    recordRecoverableLaunchFailure,
    refreshMeshFromDaemon,
    resolveCoordinatorDaemonId,
    resolveCoordinatorNode,
    resolveAllowSendKeysDestructive,
    resolveDelegatedWorkerAutoApprove,
    resolveMeshSessionProviderMetadata,
    resolveSessionProviderType,
    triggerMeshQueueAndReport,
    unwrapCommandPayload,
    validateMeshTaskModeRequest,
} from './mesh-tools-internal.js';
import type {
    MeshContext,
} from './mesh-tools-internal.js';
import { normalizeNodeCapabilitySlots } from '@adhdev/mesh-shared';


/**
 * Prune orphaned staleDirect dispatch records — direct dispatches whose original node/session is
 * no longer present in the live mesh (or terminal). dry_run (default) reports exactly which
 * taskIds would be pruned without mutating anything; pass execute=true to actually remove them.
 *
 * Safety:
 *  - Only records classified as staleDirectWork by buildMeshActiveWork against the CURRENT live
 *    mesh are eligible — active/pending/assigned/generating work is never in that set.
 *  - Of those, only orphans (node/session gone) are pruned. Fresh unacknowledged dispatch
 *    failures (staleDispatchUnacknowledged: node/session still live) are explicitly preserved and
 *    reported under preservedUnacknowledged so the caller can recover them.
 *  - Pruning deletes only the mesh_direct_dispatches store rows; the append-only mesh ledger
 *    (audit history) is left intact, and a direct_dispatch_pruned ledger entry is appended on
 *    execute so the prune itself is auditable.
 */
/**
 * DISPATCH-ACK-RISK-STALE — compute the dispatch-acknowledgement risk fields for a
 * direct (mesh_send_task --session_id) dispatch to an idle session.
 *
 * Before the NOTIF-DROP / CANON-A fix, ANY dispatch to an idle session was flagged
 * `dispatchAcknowledgementRisk:true` because a fast completion could race ahead of the
 * dispatch row and be swallowed by the prior-terminal providerSessionId dedup gate
 * (mesh-event-forwarding.ts). Now that the dispatch row is atomically pre-recorded BEFORE
 * inject, a successful pre-record makes sessionHasActiveAssignment=TRUE at completion time,
 * so the dedup gate is skipped and the completion is delivered — there is NO residual loss
 * risk. The stale warning made coordinators do needless verification polling.
 *
 * Risk is therefore true ONLY when the session was idle AND the dispatch row did not
 * persist (pre-record failed / was rolled back) — the one case where the dedup gate can
 * still swallow the completion. Returns the fields to spread into the success response, or
 * an empty object when there is no risk to surface.
 */
export function computeIdleDispatchAckRisk(
    sessionWasIdle: boolean,
    dispatchPreRecorded: boolean,
    sessionId: string,
): Record<string, unknown> {
    if (!sessionWasIdle || dispatchPreRecorded) return {};
    return {
        dispatchAcknowledgementRisk: true,
        dispatchAcknowledgementRiskReason: 'idle_dispatch_prerecord_failed',
        dispatchAcknowledgementNote: `Session '${sessionId}' was idle at dispatch time and the dispatch row could not be pre-recorded, so its completion may be deduplicated as a prior turn and lost. Use mesh_status to verify; if the session remains idle or the completion never lands, launch a fresh session and retry.`,
    };
}

export async function meshPruneStaleDirect(
    ctx: MeshContext,
    args: { execute?: boolean; dry_run?: boolean; include_terminal?: boolean } = {},
): Promise<string> {
    await refreshMeshFromDaemon(ctx);
    // execute must be explicit; dry_run is the default unless execute===true.
    const execute = args.execute === true && args.dry_run !== true;
    const includeTerminal = args.include_terminal === true;

    const liveNodes = await collectMeshViewQueueNodesWithLiveSessions(ctx);
    const ledgerEntries = readLedgerEntries(ctx.mesh.id, { tail: 500 });
    const directDispatches = getActiveDirectDispatches(ctx.mesh.id);

    // Manual prune is immediate (minAgeMs omitted → 0). The same prune core powers the daemon
    // reconcile-loop auto-prune, which passes a conservative age gate. Keeping a single core
    // means the safety classification + audit-ledger behavior can never drift between the two.
    const result = pruneStaleDirectDispatches({
        meshId: ctx.mesh.id,
        queue: getQueue(ctx.mesh.id),
        ledgerEntries,
        directDispatches,
        nodes: liveNodes,
        execute,
        includeTerminal,
        source: 'mesh_prune_stale_direct',
    });

    const { prunable, prunedCount, preservedUnacknowledged, preservedLedgerOnly, preservedNotOrphan } = result;

    const summarize = (records: typeof prunable) => records.map(r => ({
        taskId: r.taskId,
        nodeId: r.nodeId,
        sessionId: r.sessionId,
        status: r.status,
        terminal: r.terminal === true,
        staleReason: r.staleReason,
        taskTitle: r.taskTitle,
        createdAt: r.createdAt,
    }));

    return JSON.stringify({
        success: true,
        mode: result.mode,
        meshId: ctx.mesh.id,
        includeTerminal,
        candidateCount: result.candidateCount,
        prunableCount: prunable.length,
        prunedCount,
        prunable: summarize(prunable),
        preserved: {
            unacknowledgedCount: preservedUnacknowledged.length,
            ledgerOnlyCount: preservedLedgerOnly.length,
            notOrphanCount: preservedNotOrphan.length,
            unacknowledged: summarize(preservedUnacknowledged),
            ledgerOnly: summarize(preservedLedgerOnly),
            notOrphan: summarize(preservedNotOrphan),
        },
        note: execute
            ? `Pruned ${prunedCount} orphaned direct dispatch record(s) from the active staleDirect surface. The append-only mesh ledger audit history is preserved; a direct_dispatch_pruned entry records this prune.`
            : 'Dry run — nothing was deleted. Re-run with execute=true to prune the listed orphaned records. Fresh unacknowledged dispatch failures (node/session still live) and ledger-only audit entries are always preserved.',
    }, null, 2);
}

export async function meshSendTask(
    ctx: MeshContext,
    args: {
        node_id: string; session_id?: string; message: string;
        task_mode?: string; taskMode?: string;
        readonly?: boolean; read_only?: boolean;
        mission_id?: string; missionId?: string;
    },
): Promise<string> {
    // DELIVERY-MSG-GUARD: make the schema's nominal `required: ['message']` real. The
    // tool dispatcher forwards raw args without runtime schema validation, so a caller
    // omitting message (or passing a non-string) would hand undefined down the direct-
    // dispatch path — buildDirectTaskPayload / recordDirectDispatchTask / createSessionDelivery —
    // and crash insertSessionDelivery's NOT NULL. Reject at the tool boundary.
    const message = readString(args.message);
    if (!message) {
        return JSON.stringify({
            success: false,
            code: 'invalid_message',
            error: 'mesh_send_task requires a non-empty string `message`.',
        });
    }
    const requestedTaskMode = readString(args.task_mode) || readString(args.taskMode);
    const readonly = args.readonly === true || args.read_only === true;
    // Optional mission attribution. When set, the direct-dispatched task is also
    // materialised as an assigned queue entry so it counts toward the mission's
    // task aggregates — see recordDirectDispatchTask. Absent → unattributed
    // direct dispatch as before (backward compatible).
    const missionId = readString(args.missionId) || readString(args.mission_id) || undefined;
    const modeValidation = validateMeshTaskModeRequest(requestedTaskMode, message, readonly);
    if (!modeValidation.valid) {
        return JSON.stringify({
            success: false,
            code: 'live_debug_readonly_guardrail_violation',
            taskMode: modeValidation.taskMode || requestedTaskMode,
            violations: modeValidation.violations,
            allowedOperations: modeValidation.allowedOperations,
            error: `live_debug_readonly_guardrail_violation: forbidden operations (${modeValidation.violations.join(', ')})`,
        });
    }
    const taskMode = modeValidation.taskMode;
    const node = await findNodeWithRefresh(ctx, args.node_id);

    // Policy check: read-only node cannot receive tasks
    if (node.policy?.readOnly) {
        return JSON.stringify({ error: `Node '${args.node_id}' is read-only` });
    }

    // WTDISPATCH-FANOUT: a `convergence` task lands its work onto base (merge → push →
    // cleanup) and is base-only. Refuse a direct dispatch that targets a worktree-clone
    // node, fail-closed — co-located sibling worktree sessions racing a convergence
    // push/production-deploy is exactly the 4-way fan-out the live repro hit. Mirrors the
    // queue claim guard (claimNextQueueTask) and the auto-launch eligibility filter so the
    // base-only invariant holds across every dispatch entry point.
    if (taskMode === 'convergence' && node.isLocalWorktree === true) {
        return JSON.stringify({
            success: false,
            recoverable: true,
            code: 'mesh_convergence_target_is_worktree',
            reason: 'mesh_convergence_target_is_worktree',
            nodeId: args.node_id,
            sessionId: args.session_id,
            taskMode,
            error: `Node '${args.node_id}' is a worktree clone; a convergence task is base-only (it merges/pushes onto base). Dispatching it to a worktree session risks a multi-worktree push/deploy race.`,
            nextAction: `Dispatch the convergence task to the base node for this mesh, or run the deterministic fast-forward convergence path (mesh_fast_forward_node / mesh_refine_node) instead of mesh_send_task.`,
        });
    }

    let explicitTargetSession: any | undefined;
    if (args.session_id && isWorkerTaskMode(taskMode, readonly)) {
        try {
            const statusResult = await commandForNode(ctx, node, 'get_status_metadata', {});
            const sessions = extractStatusMetadataSessions(statusResult);
            explicitTargetSession = sessions.find(session => readSessionRecordId(session) === args.session_id);
            if (explicitTargetSession && isMeshCoordinatorSessionRecord(explicitTargetSession)) {
                return JSON.stringify({
                    success: false,
                    recoverable: true,
                    code: 'mesh_target_session_is_coordinator',
                    reason: 'mesh_target_session_is_coordinator',
                    nodeId: args.node_id,
                    sessionId: args.session_id,
                    taskMode: taskMode || 'unspecified',
                    error: `Session '${args.session_id}' is a Repo Mesh coordinator session, not a visible worker session. Launch or use a visible worker session before dispatching this task.`,
                    nextAction: `Call mesh_launch_session for node '${args.node_id}' and then retry mesh_send_task with that worker session_id, or use mesh_enqueue_task for queue-based worker assignment.`,
                });
            }
            if (explicitTargetSession && isUnmanagedSessionRecord(explicitTargetSession)) {
                // Session exists but lacks mesh delegation metadata (no meshNodeFor,
                // meshCoordinatorFor, or launchedByCoordinator). It could be:
                //   - The coordinator's own session → self-send risk
                //   - A manually launched session not associated with this mesh
                // Completion events from this session would not reach the coordinator
                // ledger. Surface a hard warning but still record the dispatch attempt
                // in the result so the coordinator can decide whether to proceed.
                //
                // Note: if the session happens to have meshCoordinatorFor set, the check
                // above would have already returned mesh_target_session_is_coordinator.
                // This warning fires only for truly unmanaged sessions.
                return JSON.stringify({
                    success: false,
                    recoverable: true,
                    code: 'mesh_target_session_unmanaged',
                    reason: 'mesh_target_session_unmanaged',
                    nodeId: args.node_id,
                    sessionId: args.session_id,
                    taskMode: taskMode || 'unspecified',
                    unsafeTranscriptAlias: true,
                    error: `Session '${args.session_id}' on node '${args.node_id}' has no Repo Mesh delegation metadata (missing meshNodeFor/meshCoordinatorFor/launchedByCoordinator). It may be the coordinator's own session or an unrelated session — dispatching risks self-send and orphaned completion events that never reach the coordinator ledger.`,
                    nextAction: `Call mesh_launch_session for node '${args.node_id}' to start a fresh managed worker session, then retry mesh_send_task with the returned session_id. Alternatively use mesh_enqueue_task for queue-based assignment without specifying session_id.`,
                });
            }
        } catch {
            explicitTargetSession = undefined;
        }
    }

    // Avoid duplicate side effects when an MCP/tool call is interrupted after
    // the daemon already accepted the send and the coordinator retries the
    // exact same node/session/message immediately.
    const duplicate = hasRecentDuplicateDispatch(ctx, args);
    if (duplicate.duplicate) {
        return JSON.stringify({
            success: true,
            duplicate: true,
            dispatched: false,
            warning: 'Duplicate mesh_send_task suppressed: the same node/session/message was dispatched recently.',
            nodeId: args.node_id,
            sessionId: args.session_id,
            source: duplicate.source,
            previousDispatch: duplicate.entry ? {
                id: duplicate.entry.id,
                timestamp: duplicate.entry.timestamp || duplicate.entry.updatedAt || duplicate.entry.createdAt,
                nodeId: duplicate.entry.nodeId || duplicate.entry.targetNodeId || duplicate.entry.assignedNodeId,
                sessionId: duplicate.entry.sessionId || duplicate.entry.targetSessionId || duplicate.entry.assignedSessionId,
            } : undefined,
        });
    }

    try {
        // ── IpcTransport + remote node: direct P2P agent_command dispatch ──────
        //
        // The local queue file (mesh-ledger/*.queue.json) is stored on THIS
        // machine and is inaccessible to the remote daemon.  Sending
        // trigger_mesh_queue to the remote daemon would always be a no-op
        // because it cannot read the queue.  Instead we relay agent_command
        // directly over P2P so the remote daemon forwards it to its agent.
        const isLocalNode = isLocalControlPlaneNode(ctx, node);
        if (ctx.transport instanceof IpcTransport && node.daemonId && !isLocalNode) {
            const cached = getSessionMetadata(meshSessionCacheKey(args.node_id, args.session_id || ''));
            const taskId = randomUUID();
            const coordinatorDaemonId = resolveCoordinatorDaemonId(ctx);
            const result = await ipcDispatchToRemoteAgent(ctx, node, {
                session_id: args.session_id,
                message: message,
                providerType: cached?.providerType,
                verifiedSession: explicitTargetSession,
                meshContext: {
                    meshId: ctx.mesh.id,
                    nodeId: args.node_id,
                    taskId,
                    ...(coordinatorDaemonId ? { coordinatorDaemonId } : {}),
                    // (3) Stamp the originating coordinator session so the worker's completion
                    // routes back to THIS coordinator session (multi-coordinator). Survives the
                    // P2P dispatch to the remote worker, which echoes it on its completion event.
                    ...(ctx.coordinatorSessionId ? { coordinatorSessionId: ctx.coordinatorSessionId } : {}),
                },
            });
            if (result.success) {
                // Record dispatch in ledger so task_history is accurate.
                // Defensive guard: a sessionless dispatch must not record the
                // provider type as a session id (an older ipcDispatch fallback
                // returned resolvedProviderType in result.sessionId). If the
                // returned sessionId equals the provider type, treat it as
                // sessionless so completion matching falls back to taskId.
                const resultSessionId = result.sessionId
                    && result.providerType
                    && result.sessionId === result.providerType
                    ? ''
                    : result.sessionId;
                const dispatchedSessionId = args.session_id || resultSessionId;
                const dispatchedAt = new Date().toISOString();
                try {
                    const providerType = result.providerType || cached?.providerType;
                    appendLedgerEntry(ctx.mesh.id, {
                        kind: 'task_dispatched',
                        nodeId: args.node_id,
                        sessionId: dispatchedSessionId,
                        providerType,
                        payload: buildDirectTaskPayload(message, 'p2p_direct', {
                            taskId,
                            taskMode,
                            providerType,
                            targetSessionId: dispatchedSessionId,
                            ...(ctx.coordinatorSessionId ? { coordinatorSessionId: ctx.coordinatorSessionId } : {}),
                            // COORD-EVENT-MISROUTE: persist the dispatching coordinator daemon anchor
                            // (same value stamped into meshContext above) so a transcript-reconcile
                            // synth recovers it instead of the worker's own self-daemon.
                            ...(coordinatorDaemonId ? { coordinatorDaemonId } : {}),
                        }),
                    });
                    insertDirectDispatch(ctx.mesh.id, {
                        taskId,
                        nodeId: args.node_id,
                        sessionId: dispatchedSessionId,
                        providerType: providerType || undefined,
                        message: message,
                        taskMode: taskMode || undefined,
                        via: 'p2p_direct',
                        dispatchedAt,
                    });
                    if (missionId) {
                        recordDirectDispatchTask(ctx.mesh.id, message, {
                            id: taskId,
                            missionId,
                            assignedNodeId: args.node_id,
                            assignedSessionId: dispatchedSessionId,
                            taskMode,
                            ...(readonly ? { readonly: true } : {}),
                            dispatchedAt,
                        });
                    }
                } catch { /* best-effort */ }
            }
            const returnedSessionId = result.sessionId
                && result.providerType
                && result.sessionId === result.providerType
                ? ''
                : result.sessionId;
            return JSON.stringify({
                ...result,
                nodeId: args.node_id,
                sessionId: result.success ? (args.session_id || returnedSessionId) : args.session_id,
                ...(result.success ? { source: 'direct', taskId } : {}),
                taskMode,
                ...(result.success && result.providerType ? { providerType: result.providerType } : {}),
                dispatched: result.success === true,
            });
        }

        // ── LocalTransport or local IpcTransport node ────────────────────────
        // If the coordinator explicitly targets a runtime session, push directly
        // and surface route failures immediately instead of creating a queue item
        // that can remain pending forever when the session was already stopped.
        if (args.session_id) {
            const cached = getSessionMetadata(meshSessionCacheKey(args.node_id, args.session_id));
            let resolvedProviderType = cached?.providerType || '';
            if (!resolvedProviderType) {
                let explicitSession = explicitTargetSession;
                if (!explicitSession) {
                    const statusResult = await commandForNode(ctx, node, 'get_status_metadata', {});
                    const sessions = extractStatusMetadataSessions(statusResult);
                    explicitSession = sessions.find(session => readSessionRecordId(session) === args.session_id);
                }
                if (!explicitSession) {
                    return JSON.stringify({
                        success: false,
                        recoverable: true,
                        code: 'mesh_target_session_not_found',
                        reason: 'mesh_target_session_not_found',
                        transport: 'local_ipc',
                        retryRecommended: true,
                        nodeId: args.node_id,
                        sessionId: args.session_id,
                        error: `Local session '${args.session_id}' is not present in live status for node '${args.node_id}'.`,
                        nextAction: `Launch a fresh session with mesh_launch_session(node_id: '${args.node_id}') or retry without session_id so Repo Mesh can target a live delegate session.`,
                    });
                }
                // The early validation block only runs for isWorkerTaskMode (excludes
                // live_debug_readonly). Apply the same coordinator/unmanaged checks here
                // for sessions resolved in this path so no task mode bypasses them.
                if (isMeshCoordinatorSessionRecord(explicitSession)) {
                    return JSON.stringify({
                        success: false,
                        recoverable: true,
                        code: 'mesh_target_session_is_coordinator',
                        reason: 'mesh_target_session_is_coordinator',
                        nodeId: args.node_id,
                        sessionId: args.session_id,
                        taskMode: taskMode || 'unspecified',
                        error: `Session '${args.session_id}' is a Repo Mesh coordinator session, not a visible worker session. Launch or use a visible worker session before dispatching this task.`,
                        nextAction: `Call mesh_launch_session for node '${args.node_id}' and then retry mesh_send_task with that worker session_id, or use mesh_enqueue_task for queue-based worker assignment.`,
                    });
                }
                if (isUnmanagedSessionRecord(explicitSession)) {
                    return JSON.stringify({
                        success: false,
                        recoverable: true,
                        code: 'mesh_target_session_unmanaged',
                        reason: 'mesh_target_session_unmanaged',
                        nodeId: args.node_id,
                        sessionId: args.session_id,
                        taskMode: taskMode || 'unspecified',
                        unsafeTranscriptAlias: true,
                        unsafeDelegateTarget: true,
                        error: `Session '${args.session_id}' on node '${args.node_id}' has no Repo Mesh delegation metadata (missing meshNodeFor/meshCoordinatorFor/launchedByCoordinator). It may be the coordinator's own session or an unrelated session — dispatching risks self-send and orphaned completion events that never reach the coordinator ledger.`,
                        nextAction: `Call mesh_launch_session for node '${args.node_id}' to start a fresh managed worker session, then retry mesh_send_task with the returned session_id. Alternatively use mesh_enqueue_task for queue-based assignment without specifying session_id.`,
                    });
                }
                resolvedProviderType = resolveSessionProviderType(explicitSession);
                if (resolvedProviderType) {
                    meshSessionProviderMetadata.set(meshSessionCacheKey(args.node_id, args.session_id), {
                        providerType: resolvedProviderType,
                        providerSessionId: readString(explicitSession?.providerSessionId) || undefined,
                        expiresAt: Date.now() + SESSION_PROVIDER_METADATA_TTL_MS,
                    });
                }
            }
            if (!resolvedProviderType) {
                return JSON.stringify({
                    success: false,
                    recoverable: true,
                    code: 'mesh_target_session_provider_unknown',
                    reason: 'mesh_target_session_provider_unknown',
                    transport: 'local_ipc',
                    retryRecommended: false,
                    nodeId: args.node_id,
                    sessionId: args.session_id,
                    error: `Local session '${args.session_id}' is live but does not expose providerType/cliType, so agent_command cannot be routed safely.`,
                    nextAction: `Relaunch the target session on node '${args.node_id}' or retry without session_id so Repo Mesh can pick a session with provider metadata.`,
                });
            }
            // Apply delivery policy: check session status and decide immediate vs queued vs rejected.
            // Busy/generating sessions must not receive immediate send_chat injection.
            if (explicitTargetSession && !isIdleSessionRecord(explicitTargetSession) && !isTerminalSessionRecord(explicitTargetSession)) {
                const sessionStatus = typeof explicitTargetSession?.status === 'string' ? explicitTargetSession.status : 'unknown';
                const { createSessionDelivery: createDelivery, resolveDeliveryDecision } = await import('@adhdev/daemon-core');
                const policyResult = resolveDeliveryDecision(sessionStatus, { kind: 'task' });
                if (policyResult.decision === 'queued') {
                    const delivery = createDelivery({
                        meshId: ctx.mesh.id,
                        nodeId: args.node_id,
                        sessionId: args.session_id,
                        providerType: resolvedProviderType,
                        kind: 'task',
                        message: message,
                        status: 'queued',
                    });
                    return JSON.stringify({
                        success: true,
                        dispatched: false,
                        decision: 'queued_delivery',
                        deliveryId: delivery.id,
                        reason: policyResult.reason,
                        nodeId: args.node_id,
                        sessionId: args.session_id,
                        sessionStatus,
                        taskMode: taskMode || undefined,
                        message: policyResult.message,
                        nextAction: `Use mesh_status to watch for session idle transition, or use mesh_enqueue_task for queue-based assignment. Check deliveryId '${delivery.id}' to track queued delivery.`,
                    });
                }
            }

            // Detect whether the session was idle at dispatch time. An idle session that
            // receives agent_command/send_chat should transition to generating. If it stays
            // idle, the dispatch was not acknowledged. Record this for stale detection and
            // surface it as a dispatchAcknowledgementRisk warning in the success response.
            const sessionWasIdle = explicitTargetSession
                ? isIdleSessionRecord(explicitTargetSession)
                : false;
            const taskId = randomUUID();
            const dispatchedAt = new Date().toISOString();
            const coordinatorDaemonId = resolveCoordinatorDaemonId(ctx);
            // CANON-A (direct-dispatch completion race — root fix): record the dispatch row
            // (task_dispatched ledger + insertDirectDispatch) ★BEFORE the agent_command inject,
            // exactly as the enqueue→claim path does (tryAssignQueueTask atomically claims the
            // queue row 'assigned' before deliverTaskToSession injects). A FAST direct dispatch to
            // an already-idle, reused session could otherwise have its genuine completion reach the
            // coordinator forwarder BEFORE this row existed → sessionHasActiveAssignment=false → the
            // prior-terminal providerSessionId dedup (mesh-event-forwarding.ts:551,603) swallowed the
            // new task's completion as a duplicate of the prior turn. Pre-recording makes
            // sessionHasActiveAssignment=true at completion time, so the dedup gate is skipped
            // symmetrically with enqueue. On a dispatch failure below we roll the row back.
            try {
                appendLedgerEntry(ctx.mesh.id, {
                    kind: 'task_dispatched',
                    nodeId: args.node_id,
                    sessionId: args.session_id,
                    providerType: resolvedProviderType,
                    payload: buildDirectTaskPayload(message, 'local_direct', {
                        taskId,
                        taskMode,
                        providerType: resolvedProviderType,
                        targetSessionId: args.session_id,
                        dispatchedToIdleSession: sessionWasIdle,
                        ...(ctx.coordinatorSessionId ? { coordinatorSessionId: ctx.coordinatorSessionId } : {}),
                        // COORD-EVENT-MISROUTE: persist the dispatching coordinator daemon anchor so a
                        // transcript-reconcile synth recovers it from the ledger rather than stamping
                        // the reconcile-runner's own self-daemon.
                        ...(coordinatorDaemonId ? { coordinatorDaemonId } : {}),
                    }),
                });
            } catch { /* best-effort */ }
            // DISPATCH-ACK-RISK-STALE: track whether the dispatch row was atomically
            // pre-recorded. When it lands, sessionHasActiveAssignment becomes TRUE at
            // completion time, so the prior-terminal dedup gate (mesh-event-forwarding.ts:551)
            // is skipped and the idle-session completion WILL be delivered — i.e. there is no
            // residual loss risk. The risk warning below must reflect THIS, not merely that the
            // session was idle. A genuine residual risk remains only if the pre-record did not
            // persist a row to gate on.
            insertDirectDispatch(ctx.mesh.id, {
                taskId,
                nodeId: args.node_id,
                sessionId: args.session_id,
                providerType: resolvedProviderType || undefined,
                message: message,
                taskMode: taskMode || undefined,
                via: 'local_direct',
                dispatchedToIdleSession: sessionWasIdle,
                dispatchedAt,
            });
            // insertDirectDispatch swallows its own persistence errors (it never throws),
            // so we cannot infer success from the absence of an exception. Verify the row
            // actually exists — this is the exact predicate sessionHasActiveAssignment keys
            // on, so it is the true signal of whether the dedup gate will be skipped.
            let dispatchPreRecorded = false;
            try {
                dispatchPreRecorded = getActiveDirectDispatches(ctx.mesh.id).some(d => d.taskId === taskId);
            } catch { /* read failed — treat as not-recorded → keep the conservative warning */ }
            // Stamp the mesh assignment via meshContext so the daemon can
            // attach it to the target instance BEFORE prompt injection.
            // setupMeshEventForwarding reads state.settings.meshNodeFor +
            // meshActiveTaskId to route completion events back. Without
            // this, plain CLI sessions targeted by mesh_send_task --direct
            // would silently drop generating_completed and the coordinator
            // would never observe task_completed.
            // coordinatorDaemonId is required so the completion event is
            // routed to the correct coordinator pendingCoordinatorEvents queue.
            const dispatchResult = await commandForNode(ctx, node, 'agent_command', {
                targetSessionId: args.session_id,
                agentType: resolvedProviderType,
                cliType: resolvedProviderType,
                providerType: resolvedProviderType,
                action: 'send_chat',
                message: message,
                meshContext: {
                    meshId: ctx.mesh.id,
                    nodeId: args.node_id,
                    taskId,
                    ...(coordinatorDaemonId ? { coordinatorDaemonId } : {}),
                    // (3) Originating coordinator session anchor — see the remote-dispatch path above.
                    ...(ctx.coordinatorSessionId ? { coordinatorSessionId: ctx.coordinatorSessionId } : {}),
                },
            });
            const dispatchPayload = unwrapCommandPayload(dispatchResult);
            if (dispatchPayload?.success === false || dispatchResult?.success === false) {
                // Roll back the pre-recorded dispatch row: the inject was rejected, so there is no
                // active assignment to gate. The task_dispatched ledger entry stays (append-only),
                // but the dispatch row is the discriminator sessionHasActiveAssignment keys on —
                // leaving it would mask a genuinely-unrelated later idle as an active assignment.
                try { deleteDirectDispatchesByTaskId(ctx.mesh.id, [taskId]); } catch { /* best-effort */ }
                dispatchPreRecorded = false;
                const source = dispatchPayload?.success === false ? dispatchPayload : dispatchResult;
                return JSON.stringify({
                    ...(source && typeof source === 'object' ? source : {}),
                    success: false,
                    nodeId: args.node_id,
                    sessionId: args.session_id,
                    error: dispatchPayload?.error || dispatchResult?.error || 'agent_command rejected the task',
                });
            }
            if (missionId) {
                try {
                    recordDirectDispatchTask(ctx.mesh.id, message, {
                        id: taskId,
                        missionId,
                        assignedNodeId: args.node_id,
                        assignedSessionId: args.session_id,
                        taskMode,
                        ...(readonly ? { readonly: true } : {}),
                        dispatchedAt,
                    });
                } catch { /* best-effort */ }
            }
            // Create a delivery record for session-level ACK tracking
            let deliveryId: string | undefined;
            try {
                const { createSessionDelivery: createDelivery } = await import('@adhdev/daemon-core');
                const delivery = createDelivery({
                    meshId: ctx.mesh.id,
                    nodeId: args.node_id,
                    sessionId: args.session_id,
                    providerType: resolvedProviderType || undefined,
                    taskId,
                    kind: 'task',
                    message: message,
                    status: sessionWasIdle ? 'delivered' : 'delivering',
                });
                deliveryId = delivery.id;
            } catch { /* best-effort */ }
            return JSON.stringify({
                success: true,
                dispatched: true,
                decision: 'immediate',
                source: 'direct',
                taskId,
                deliveryId,
                taskMode,
                providerType: resolvedProviderType,
                nodeId: args.node_id,
                sessionId: args.session_id,
                // DISPATCH-ACK-RISK-STALE: only warn on a GENUINE residual loss risk — an idle
                // session whose dispatch row did NOT survive pre-record. A successfully
                // pre-recorded idle dispatch (the NOTIF-DROP / CANON-A path) is not at risk.
                ...computeIdleDispatchAckRisk(sessionWasIdle, dispatchPreRecorded, args.session_id),
            });
        }

        // ── Untargeted local task: use queue pull ─────────────────────────────
        // COORD-EVENT-MISROUTE (anchor preservation): stamp the originating coordinator
        // SESSION anchor exactly as the sibling meshEnqueueTask does (mesh-tools-queue.ts).
        // Without it the queued task carries no sourceCoordinatorSessionId, so at claim time
        // targetCoordinatorSessionId is empty (mesh-queue-assignment.ts) and the completion
        // loses its session anchor — falling back to daemon-level fan-out across every local
        // coordinator instead of routing back to the coordinator session that issued the task.
        const task = enqueueTask(ctx.mesh.id, message, {
            targetNodeId: args.node_id,
            targetSessionId: args.session_id,
            taskMode,
            ...(readonly ? { readonly: true } : {}),
            ...(missionId ? { missionId } : {}),
            ...(ctx.coordinatorSessionId ? { sourceCoordinatorSessionId: ctx.coordinatorSessionId } : {}),
        });

        const queueTrigger = await triggerMeshQueueAndReport(ctx);

        // Also drain any pending coordinator events so the caller sees them inline
        const pendingEvents = drainPendingMeshCoordinatorEvents(ctx.mesh.id, ctx.localDaemonId);

        const result: Record<string, unknown> = {
            success: true,
            source: 'queue',
            nodeId: args.node_id,
            taskId: task.id,
            status: task.status,
            taskMode: task.taskMode,
            queueTrigger,
            ...buildQueueTriggerGuidance(queueTrigger),
        };
        if (pendingEvents.length > 0) {
            result.pendingCoordinatorEvents = pendingEvents;
        }
        return JSON.stringify(result);
    } catch (e: any) {
        const failure = buildCoordinatorP2pRelayFailure(e, {
            command: 'mesh_send_task',
            targetDaemonId: node.daemonId,
            nodeId: args.node_id,
            sessionId: args.session_id,
        });
        return JSON.stringify(failure);
    }
}

export async function meshReadChat(
    ctx: MeshContext,
    args: { node_id: string; session_id: string; provider_session_id?: string; tail?: number; compact?: boolean },
): Promise<string> {
    const node = await findOptionalNodeWithRefresh(ctx, args.node_id);
    if (!node) {
        return JSON.stringify(buildMissingNodeReadChatRecovery(ctx, args), null, 2);
    }

    await drainCoordinatorPendingEvents(ctx, { nodeIds: [args.node_id] });

    const cached = resolveMeshSessionProviderMetadata(ctx, args.node_id, args.session_id);
    const providerSessionId = typeof args.provider_session_id === 'string' && args.provider_session_id.trim()
        ? args.provider_session_id.trim()
        : cached?.providerSessionId;
    const isLocalNode = isLocalControlPlaneNode(ctx, node);
    let result: any;
    try {
        result = await commandForNode(ctx, node, 'read_chat', {
            sessionId: args.session_id,
            targetSessionId: args.session_id,
            workspace: node.workspace,
            ...(cached?.providerType ? { agentType: cached.providerType, providerType: cached.providerType } : {}),
            ...(providerSessionId ? { providerSessionId } : {}),
            tailLimit: args.tail ?? 10,
        });
    } catch (e: any) {
        // Local read_chat and non-transport (provider/logic) failures keep the existing
        // throw so genuine errors still surface. The cache fallback covers ONLY a remote
        // P2P transport failure (saturated/unreachable peer): mesh_status already degrades
        // its P2P probe gracefully (collectLiveStatusProbe) — read_chat had no catch and
        // hard-failed at the 30s timeout instead of surfacing the coordinator's cached
        // summary. See buildMeshReadChatCacheFallback.
        if (isLocalNode || !isP2pRelayTransportFailure(e)) throw e;
        return buildMeshReadChatCacheFallback(ctx, args, node, e);
    }
    const payload = annotateRapidReadChatAdvisory(unwrapCommandPayload(result) as Record<string, any>, {
        key: `mesh:${args.node_id}:${args.session_id}`,
        toolName: 'mesh_read_chat',
        completionCallbackExpected: true,
    });
    // Default compact=true to keep coordinator context lean.
    // Pass compact=false explicitly only when full transcript detail is needed for debugging.
    const useCompact = args.compact !== false;
    if (useCompact) {
        const compactPayload = compactChatPayload(payload, {
            nodeId: args.node_id,
            sessionId: args.session_id,
            limit: args.tail ?? 10,
        });
        return JSON.stringify(
            payload.pollingAdvisory ? { ...compactPayload, pollingAdvisory: payload.pollingAdvisory } : compactPayload,
            null,
            2,
        );
    }
    return JSON.stringify(payload, null, 2);
}

export async function meshReadDebug(
    ctx: MeshContext,
    args: { node_id: string; session_id: string; provider_session_id?: string; tail?: number; delivery?: 'daemon_file' | 'inline' },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    const cached = resolveMeshSessionProviderMetadata(ctx, args.node_id, args.session_id);
    const providerSessionId = typeof args.provider_session_id === 'string' && args.provider_session_id.trim()
        ? args.provider_session_id.trim()
        : cached?.providerSessionId;
    const delivery = args.delivery === 'inline' ? undefined : 'daemon_file';
    const result = await commandForNode(ctx, node, 'get_chat_debug_bundle', {
        sessionId: args.session_id,
        targetSessionId: args.session_id,
        workspace: node.workspace,
        ...(cached?.providerType ? { agentType: cached.providerType, providerType: cached.providerType } : {}),
        ...(providerSessionId ? { providerSessionId } : {}),
        tailLimit: args.tail ?? 40,
        ...(delivery ? { delivery } : {}),
    });
    const payload = unwrapCommandPayload(result);
    return JSON.stringify(payload, null, 2);
}

/**
 * MESH-READ-TERMINAL (feature 2: RAW terminal read). Read the CURRENT rendered
 * PTY viewport (live screen) of a delegated worker session on a mesh node.
 *
 * OWNERSHIP DOUBLE-CHECK (defense-in-depth, per mission 6938892f class):
 *   1. MCP side (here): resolve the session record from the node's live session
 *      list and require isMeshOwnedDelegateSession(session, meshId, nodeId) —
 *      mesh/session/node identity must match, so a cross-mesh or coordinator-own
 *      session id cannot be read.
 *   2. daemon side (read_terminal → getTerminalScreenSnapshot): gated on
 *      isMeshWorkerSession(). isMeshWorkerSession alone is a broad "delegated"
 *      gate, so the MCP-side identity match is what blocks cross-mesh access.
 *
 * The read_terminal daemon verb is in MESH_FORWARDABLE_SESSION_COMMANDS, so when
 * the worker is a REMOTE node the coordinator's daemon forwards it to the owning
 * worker daemon (which holds the live viewport) instead of returning
 * 'Session not found'.
 */
export async function meshReadTerminal(
    ctx: MeshContext,
    args: { node_id: string; session_id: string; max_bytes?: number },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    // OWNERSHIP DOUBLE-CHECK (MCP side): the session must be a mesh-owned delegate
    // of THIS mesh + node. Resolve it from the node's live session list; a miss or
    // a non-owned/ cross-mesh record is refused before any command is issued.
    const liveSessions = await collectLiveStatusSessions(ctx, node);
    const record = liveSessions.find((s) => readSessionRecordId(s) === args.session_id);
    if (record && !isMeshOwnedDelegateSession(record, ctx.mesh.id, args.node_id)) {
        return JSON.stringify({
            success: false,
            error: 'session is not a mesh-owned delegate of this mesh/node — mesh_read_terminal is scoped to sessions this coordinator spawned',
            nodeId: args.node_id,
            sessionId: args.session_id,
        }, null, 2);
    }

    const cached = resolveMeshSessionProviderMetadata(ctx, args.node_id, args.session_id);
    const result = await commandForNode(ctx, node, 'read_terminal', {
        sessionId: args.session_id,
        targetSessionId: args.session_id,
        workspace: node.workspace,
        ...(cached?.providerType ? { agentType: cached.providerType, providerType: cached.providerType } : {}),
        ...(typeof args.max_bytes === 'number' && Number.isFinite(args.max_bytes) ? { maxBytes: args.max_bytes } : {}),
    });
    const payload = unwrapCommandPayload(result);
    return JSON.stringify(payload, null, 2);
}

const MESH_SEND_KEYS_DESTRUCTIVE = new Set(['CTRL_C', 'ESC']);

/**
 * MESH-SEND-KEYS (feature 3: key injection). Inject a structured key sequence into
 * a delegated worker session's live PTY.
 *
 * OWNERSHIP DOUBLE-CHECK (per mission 6938892f class, same as mesh_read_terminal):
 *   1. MCP side (here): the session must be isMeshOwnedDelegateSession of THIS
 *      mesh + node — blocks cross-mesh / coordinator-own PTY writes.
 *   2. daemon side (send_keys → injectKeys): gated on isMeshWorkerSession().
 *
 * DESTRUCTIVE DOUBLE GATE (owner-approved): CTRL_C/ESC require BOTH
 * confirm_destructive=true (per-call) AND mesh/node policy allowSendKeysDestructive
 * (opt-in). delegatedWorkerAutoApprove does NOT grant this — it is tool-consent,
 * not PTY-input authority, so a Ctrl-C could otherwise bypass it and kill the
 * worker.
 *
 * The daemon layer independently enforces the submit-race recheck and the
 * actionable-modal fail-closed refusal. Every attempt is AUDITED to the ledger
 * (key enums + result), NEVER the literal text body.
 *
 * send_keys is in MESH_FORWARDABLE_SESSION_COMMANDS so a remote-worker target is
 * forwarded to the owning daemon (which holds the live PTY).
 */
export async function meshSendKeys(
    ctx: MeshContext,
    args: {
        node_id: string;
        session_id: string;
        sequence: Array<{ text?: string; key?: string }>;
        confirm_destructive?: boolean;
        allow_modal_override?: boolean;
    },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);
    const items = Array.isArray(args.sequence) ? args.sequence : [];
    if (items.length === 0) {
        return JSON.stringify({ success: false, error: 'sequence (non-empty array of {text}|{key}) required' }, null, 2);
    }

    // OWNERSHIP DOUBLE-CHECK (MCP side): resolve the session from the node's live
    // session list; refuse a non-owned / cross-mesh record before writing anything.
    const liveSessions = await collectLiveStatusSessions(ctx, node);
    const record = liveSessions.find((s) => readSessionRecordId(s) === args.session_id);
    if (record && !isMeshOwnedDelegateSession(record, ctx.mesh.id, args.node_id)) {
        return JSON.stringify({
            success: false,
            error: 'session is not a mesh-owned delegate of this mesh/node — mesh_send_keys is scoped to sessions this coordinator spawned',
            nodeId: args.node_id,
            sessionId: args.session_id,
        }, null, 2);
    }

    // DESTRUCTIVE DOUBLE GATE.
    const requestedKeys = items
        .map((it) => (it && typeof it.key === 'string' ? it.key : ''))
        .filter(Boolean);
    const hasDestructive = requestedKeys.some((k) => MESH_SEND_KEYS_DESTRUCTIVE.has(k));
    const auditKeys = requestedKeys.slice(0, 64);
    const recordAudit = (result: string, extra: Record<string, unknown> = {}) => {
        try {
            appendLedgerEntry(ctx.mesh.id, {
                kind: 'key_injection',
                nodeId: args.node_id,
                sessionId: args.session_id,
                payload: {
                    keys: auditKeys, // key ENUMS only — never the literal text body
                    hasDestructive,
                    confirmDestructive: args.confirm_destructive === true,
                    result,
                    ...extra,
                },
            });
        } catch { /* ledger append is best-effort */ }
    };

    if (hasDestructive) {
        const policyAllows = resolveAllowSendKeysDestructive(ctx.mesh.policy, node.policy);
        if (args.confirm_destructive !== true || !policyAllows) {
            recordAudit('refused', { refused: 'destructive_gate', policyAllows });
            return JSON.stringify({
                success: false,
                error: 'destructive key (CTRL_C/ESC) requires BOTH confirm_destructive=true AND mesh policy allowSendKeysDestructive=true',
                refused: 'destructive_gate',
                confirmDestructive: args.confirm_destructive === true,
                policyAllowsDestructive: policyAllows,
            }, null, 2);
        }
    }

    const cached = resolveMeshSessionProviderMetadata(ctx, args.node_id, args.session_id);
    const result = await commandForNode(ctx, node, 'send_keys', {
        sessionId: args.session_id,
        targetSessionId: args.session_id,
        workspace: node.workspace,
        ...(cached?.providerType ? { agentType: cached.providerType, providerType: cached.providerType } : {}),
        sequence: items,
        confirm_destructive: args.confirm_destructive === true,
        allow_modal_override: args.allow_modal_override === true,
    });
    const payload = unwrapCommandPayload(result) as Record<string, unknown>;
    // Audit the daemon's verdict (injected / refused). The daemon result carries no
    // literal text either, so it is safe to reflect keys/result here.
    if (payload?.success === true) {
        recordAudit('injected', { submits: payload.submits === true });
    } else {
        recordAudit('refused', { refused: readString(payload?.refused) || 'error' });
    }
    return JSON.stringify(payload, null, 2);
}

export async function meshLaunchSession(
    ctx: MeshContext,
    args: { node_id: string; type?: string; force?: boolean },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);
    const bootstrapBlock = getWorktreeBootstrapLaunchBlock(node, ctx.mesh.policy);
    if (bootstrapBlock) return JSON.stringify(bootstrapBlock, null, 2);

    {
        const requestedType = typeof args.type === 'string' && args.type.trim() ? args.type.trim() : '';
        let resolvedProviderType = requestedType;
        if (requestedType) {
            // PROVIDER-TYPE-HONORED: an explicit type is validated ONLY against the node's
            // capability slots (policy.slots) — the single authoritative capability list
            // (ORCHESTRATION_NODE_SLOTS.md). When the node declares slots and none names the
            // requested provider, fail closed instead of proceeding: silently resolving to
            // providerPriority[0] was the exact bug (mesh_launch_session(type:"cursor-cli")
            // spawned claude-cli). providerPriority is deliberately NOT consulted here — it is
            // an ordered PREFERENCE hint, not a capability whitelist, so a legacy node that
            // declares only providerPriority (no slots) keeps the pre-existing contract that an
            // explicit type may name any provider (the daemon-side launch is the real gate).
            // Provider names are compared raw — slots store canonical provider types.
            const slotProviders = normalizeNodeCapabilitySlots((node.policy as any)?.slots).map(s => s.provider);
            if (slotProviders.length && !slotProviders.includes(requestedType)) {
                return JSON.stringify({
                    success: false,
                    code: 'mesh_provider_type_unsupported',
                    error: `Node '${args.node_id}' does not support provider '${requestedType}'. Its capability slots (policy.slots) declare: ${slotProviders.join(', ')}. Configure a slot for '${requestedType}' via mesh_node_slots_set, or launch with one of the supported types.`,
                    nodeId: args.node_id,
                    requestedType,
                    supportedProviders: slotProviders,
                }, null, 2);
            }
        }
        if (!resolvedProviderType) {
            const providerPriority = readProviderPriority(node.policy);
            if (!providerPriority.length) {
                return JSON.stringify({ success: false, error: missingProviderPriorityMessage(args.node_id) });
            }

            // OFFLINE-NODE-BLOCKING: probe each candidate provider until one is detected. Two
            // guards keep an OFFLINE target node from serializing a ~90s × providers stall
            // (~270s for a 3-provider priority list):
            //   (a) `detect_provider` is read-only, so stamp it with the status-origin marker
            //       ({ statusProbe: true }) — the daemon-cloud relay then grants the SHORT
            //       connect-wait budget so a probe to an unconnected peer gives up in ~2s
            //       instead of the 90s connect deadline.
            //   (b) short-circuit on the FIRST transport-level failure. A per-provider
            //       "not detected" comes back as a RESOLVED { detected: false } payload (try
            //       the next provider); a THROW means the node itself is unreachable (peer not
            //       connected / offline / relay timeout) — every remaining provider would fail
            //       identically, so break immediately and fail fast with a node-unreachable error.
            const failed: string[] = [];
            let unreachableError: string | null = null;
            for (const providerType of providerPriority) {
                let detectedPayload: any;
                try {
                    const detectedResult = await commandForNode(ctx, node, 'detect_provider', { providerType }, { statusProbe: true });
                    detectedPayload = unwrapCommandPayload(detectedResult);
                } catch (e: any) {
                    // Transport/connection failure: the node is unreachable, not the provider
                    // missing. Stop probing the rest of the priority list.
                    unreachableError = e?.message || String(e);
                    break;
                }
                if (detectedPayload?.success && detectedPayload?.detected) {
                    resolvedProviderType = providerType;
                    break;
                }
                failed.push(`${providerType}: ${detectedPayload?.error || 'not detected'}`);
            }
            if (!resolvedProviderType) {
                if (unreachableError) {
                    return JSON.stringify({ success: false, error: `Node '${args.node_id}' is unreachable — cannot detect a provider (${unreachableError}). The node's daemon may be offline; retry once it reconnects.` });
                }
                return JSON.stringify({ success: false, error: `No usable provider detected for node '${args.node_id}' from providerPriority: ${failed.join('; ')}` });
            }
        }

        const coordinatorNode = resolveCoordinatorNode(ctx);
        const coordinatorDaemonId = resolveCoordinatorDaemonId(ctx);
        const spawnedSessionVisibility = readSpawnedSessionVisibility(ctx.mesh.policy);
        // Worker sessions are coordinator-dispatched; a human shouldn't have to approve
        // each one. Resolve the auto-approve policy (node override → mesh policy → default
        // true) and stamp it into the launch settings envelope so it wins over the global
        // per-provider-type autoApprove config via the settingsOverride merge.
        const delegatedWorkerAutoApprove = resolveDelegatedWorkerAutoApprove(ctx.mesh.policy, node.policy);
        const isLocalNode = isLocalControlPlaneNode(ctx, node);
        if (node.daemonId && !isLocalNode && !coordinatorDaemonId) {
            return JSON.stringify(buildMissingCoordinatorDaemonIdFailure(ctx, node, resolvedProviderType), null, 2);
        }

        // MESH-LAUNCH-DUP-GUARD: an enqueue auto-launch (queue task → daemon spawns a worker)
        // races a manual mesh_launch_session for the same node/worktree. Without this guard the
        // manual call unconditionally issues a second launch_cli, leaving an empty duplicate
        // worker session alongside the one doing the work ("채팅 2개"). Right before launch, probe
        // live status and, if a non-terminal mesh-owned worker session for THIS mesh+node already
        // exists (idle OR still booting/generating), return it idempotently instead of spawning a
        // duplicate. force=true bypasses the guard for a deliberate additional session. Placed
        // AFTER provider resolution + the coordinator-id fail-closed check so an unlaunchable node
        // never burns a status relay (and the relay-blocked invariant holds).
        if (args.force !== true) {
            try {
                const statusResult = await commandForNode(ctx, node, 'get_status_metadata', {});
                const sessions = extractStatusMetadataSessions(statusResult);
                const existing = sessions.find(session =>
                    !isTerminalSessionRecord(session)
                    && isMeshOwnedDelegateSession(session, ctx.mesh.id, args.node_id));
                if (existing) {
                    const existingSessionId = readSessionRecordId(existing);
                    if (existingSessionId) {
                        const existingProviderType = resolveSessionProviderType(existing) || resolvedProviderType || undefined;
                        const existingStatus = typeof existing?.status === 'string' ? existing.status : 'unknown';
                        return JSON.stringify({
                            success: true,
                            duplicate: true,
                            launched: false,
                            reused: true,
                            sessionId: existingSessionId,
                            nodeId: args.node_id,
                            ...(existingProviderType ? { resolvedProviderType: existingProviderType, providerType: existingProviderType } : {}),
                            sessionStatus: existingStatus,
                            idle: isIdleSessionRecord(existing),
                            reason: 'mesh_launch_session_duplicate_guard',
                            warning: `Node '${args.node_id}' already has a live mesh-owned worker session ('${existingSessionId}', status '${existingStatus}'). Returning it instead of launching an empty duplicate (likely an enqueue auto-launch already spawned it).`,
                            nextAction: `Use session '${existingSessionId}' for mesh_send_task/mesh_read_chat. If you intentionally need a second concurrent session on this node, retry mesh_launch_session with force=true.`,
                        }, null, 2);
                    }
                }
            } catch {
                // Status probe failed (transport/timeout). Fail open — proceed to launch rather
                // than blocking a legitimate launch on an unreachable status probe. A duplicate is
                // recoverable (mesh_cleanup_sessions); a blocked launch on a transient probe error
                // is worse for the coordinator flow.
            }
        }

        let result: any;
        try {
            result = await commandForNode(ctx, node, 'launch_cli', {
                cliType: resolvedProviderType,
                dir: node.workspace,
                settings: {
                    // Worker launch envelope (A5): structured metadata so worker sessions
                    // know their role and can route completion events back correctly.
                    role: 'worker',
                    meshNodeFor: ctx.mesh.id,
                    meshNodeId: args.node_id,
                    spawnedSessionVisibility,
                    // Delegated worker auto-approval (see resolveDelegatedWorkerAutoApprove).
                    // Lands in settingsOverride and beats the global per-provider autoApprove.
                    autoApprove: delegatedWorkerAutoApprove,
                    ...(coordinatorDaemonId ? { meshCoordinatorDaemonId: coordinatorDaemonId } : {}),
                    // (3) Stamp the originating coordinator SESSION at launch too, so a worker
                    // launched via mesh_launch_session routes its completions back to the exact
                    // coordinator session (multi-coordinator). Absent → daemon-level fallback.
                    ...(ctx.coordinatorSessionId ? { meshCoordinatorSessionId: ctx.coordinatorSessionId } : {}),
                    ...(coordinatorNode?.id ? { meshCoordinatorNodeId: coordinatorNode.id } : {}),
                    launchedByCoordinator: true,
                }
            });
        } catch (e: any) {
            return JSON.stringify(recordRecoverableLaunchFailure(ctx, node, resolvedProviderType, e), null, 2);
        }
        const launchPayload = extractLaunchPayload(result);
        if (launchPayload?.success === false || result?.success === false) {
            const launchError = new Error(launchPayload?.error || result?.error || 'launch_cli rejected the session launch');
            return JSON.stringify(recordRecoverableLaunchFailure(ctx, node, resolvedProviderType, launchError), null, 2);
        }
        const runtimeSessionId = typeof launchPayload?.sessionId === 'string'
            ? launchPayload.sessionId
            : typeof launchPayload?.id === 'string'
                ? launchPayload.id
                : typeof launchPayload?.runtimeSessionId === 'string'
                    ? launchPayload.runtimeSessionId
                    : '';
        const providerSessionId = typeof launchPayload?.providerSessionId === 'string' && launchPayload.providerSessionId.trim()
            ? launchPayload.providerSessionId.trim()
            : undefined;
        if (runtimeSessionId) {
            meshSessionProviderMetadata.set(meshSessionCacheKey(args.node_id, runtimeSessionId), {
                providerType: resolvedProviderType,
                ...(providerSessionId ? { providerSessionId } : {}),
                expiresAt: Date.now() + SESSION_PROVIDER_METADATA_TTL_MS,
            });
        }
        // Record session launch in ledger
        try {
            appendLedgerEntry(ctx.mesh.id, {
                kind: 'session_launched',
                nodeId: args.node_id,
                sessionId: runtimeSessionId || undefined,
                providerType: resolvedProviderType,
                payload: { providerSessionId },
            });
        } catch { /* ledger append is best-effort */ }

        // Tell daemon to trigger queue processing so the new session immediately picks up pending tasks.
        // Surface the trigger result so coordinators can distinguish "session launched"
        // from "queued work actually claimed by that session".
        const queueTrigger = await triggerMeshQueueAndReport(ctx);

        return JSON.stringify({
            ...launchPayload,
            resolvedProviderType,
            ...(providerSessionId ? { providerSessionId } : {}),
            queueTrigger,
            ...buildQueueTriggerGuidance(queueTrigger),
        }, null, 2);
    }
}

export async function meshApprove(
    ctx: MeshContext,
    args: { node_id: string; session_id: string; action: string },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id); // membership check

    const cached = getSessionMetadata(meshSessionCacheKey(args.node_id, args.session_id));
    const providerSessionId = cached?.providerSessionId;
    const result = await commandForNode(ctx, node, 'resolve_action', {
        sessionId: args.session_id,
        targetSessionId: args.session_id,
        workspace: node.workspace,
        ...(cached?.providerType ? { agentType: cached.providerType, providerType: cached.providerType } : {}),
        ...(providerSessionId ? { providerSessionId } : {}),
        action: args.action === 'reject' ? 'reject' : 'approve',
    });
    return JSON.stringify(result, null, 2);
}

/**
 * mesh_list_pending_approvals — read-only mesh-wide approval inbox.
 *
 * mesh_approve resolves a SINGLE (node_id, session_id) action; before this tool there was
 * no way to enumerate which sessions are currently blocked awaiting an approval decision —
 * the coordinator had to page mesh_status and eyeball each node's sessions. This lists every
 * session in `awaiting_approval` across the mesh so a coordinator (or the UI approvals inbox)
 * can see the full pending set and drive a follow-up mesh_approve for each.
 *
 * No new store or DB: it reuses the exact derivation mesh_status/mesh_view_queue already run
 * (buildMeshActiveWork over the live-session-decorated nodes + queue + ledger + direct
 * dispatches), then filters to `status === 'awaiting_approval'` via collectPendingApprovals.
 * Read-only — probes node status but mutates no approval/session state.
 */
export async function meshListPendingApprovals(
    ctx: MeshContext,
    _args: Record<string, unknown> = {},
): Promise<string> {
    recordMeshToolCall({ meshId: ctx.mesh.id, tool: 'mesh_list_pending_approvals' });
    await refreshMeshFromDaemon(ctx);

    const liveNodes = await collectMeshViewQueueNodesWithLiveSessions(ctx);
    let ledgerEntries = readLedgerEntries(ctx.mesh.id, { tail: 200 });
    let directDispatches = getActiveDirectDispatches(ctx.mesh.id);
    const directReconciliation = await reconcileDirectDispatchesFromTranscriptEvidence(ctx, liveNodes, directDispatches, ledgerEntries);
    if (directReconciliation.reconciled > 0) {
        ledgerEntries = readLedgerEntries(ctx.mesh.id, { tail: 200 });
        directDispatches = getActiveDirectDispatches(ctx.mesh.id);
    }
    markStaleDirectDispatches(ctx.mesh.id);
    directDispatches = getActiveDirectDispatches(ctx.mesh.id);

    const activeWorkEvidence = buildMeshActiveWork({
        meshId: ctx.mesh.id,
        queue: getQueue(ctx.mesh.id),
        ledgerEntries,
        directDispatches,
        nodes: liveNodes,
    });

    const approvals = collectPendingApprovals(activeWorkEvidence.activeWork);

    return JSON.stringify({
        count: approvals.length,
        approvals,
        ...(approvals.length === 0
            ? { note: 'No sessions are currently awaiting an approval decision.' }
            : { nextStep: 'Resolve each with mesh_approve(node_id, session_id, action: "approve" | "reject").' }),
    }, null, 2);
}

export async function meshCleanupSessions(
    ctx: MeshContext,
    args: { node_id: string; mode: string; session_ids?: string[]; dry_run?: boolean },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    const result = await commandForNode(ctx, node, 'cleanup_mesh_sessions', {
        meshId: ctx.mesh.id,
        nodeId: args.node_id,
        mode: args.mode,
        sessionIds: args.session_ids,
        dryRun: args.dry_run === true,
        inlineMesh: ctx.mesh,
    });
    return JSON.stringify(result, null, 2);
}
