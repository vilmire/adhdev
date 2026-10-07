import type { DaemonComponents } from '../boot/daemon-components.js';
import { LOG } from '../logging/logger.js';
import { meshRecord } from './mesh-record.js';
import { buildMeshNodeCapabilityTags, claimNextTask, updateTaskStatus } from './mesh-work-queue.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue.js';
import { resolveTranscriptAuthorityProfile } from '../providers/transcript-evidence.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { clearClaimDeferralForNode, noteClaimDeferredForNode, noteSessionClaimRefusal, type MeshClaimRefusal } from './mesh-claim-refusal.js';
import { resolveProviderMaxParallel, resolveSlotMaxParallel, resolveCoordinatorIdlePushPolicy } from '../repo-mesh-types.js';
import { meshNodeIdMatches, normalizeMeshWorkspaceForCompare, meshWorkspacesEquivalent, sessionIdsEquivalent, type MeshNodeIdentified, readText } from '@adhdev/mesh-shared';
import { resolveNodeCapabilitySlots } from './mesh-node-slots.js';
import { resolveDaemonSiblingNodeIds } from './mesh-daemon-slot-axis.js';
import { recordLastQuotaRanking, recordLastQuotaRankingOutcome } from './mesh-quota-ranking-records.js';
import { evaluateQuotaClaimGateForAssignment } from './mesh-queue-claim-gate.js';
import { readMeshNodeDaemonId, isMeshNodeFreshEnoughToLaunch, readNumberValue } from './mesh-node-identity.js';
import { shouldDeferDispatchForBootstrap } from './worktree-bootstrap-config.js';
import { beginTaskDispatchInFlight } from './mesh-task-inflight.js';
import { isModelAllowedBySlot } from './slot-model-enforcement.js';
import { dispatchMessageId, openOrResumeQueueAttempt } from './mesh-queue-dispatch-evidence.js';
import { withMeshDirectDispatch } from '../commands/command-args.js';
import type { TurnAttemptRef } from '@adhdev/mesh-shared';
import type { TurnLedger } from './turn-ledger/ledger.js';
import { isWorkspaceAutoFastForwardInFlight, maybeAutoFastForwardIdleNode, isDirtyNode, resolveAutoFastForwardPolicy } from './mesh-auto-fast-forward.js';
import { retractActionableSkipIfPreviouslyNotified } from './mesh-skip-notify.js';
import { activeWriteAssignedCount, activeReadonlyAssignedCount, sessionHasActiveAssignment } from './mesh-scheduling-fitness.js';
import { AUTO_LAUNCH_LEDGER_DEDUP_MAX, clearClaimRefusalState, clearWorktreeBootstrapStaleBypassState, logQuotaClaimFallbackSuccess, logWorktreeBootstrapStaleBypass, recordClaimRefusal, type QuotaClaimDrainTrace } from './mesh-queue-observability.js';
import { type MeshTaskRoutingDecision } from './mesh-routing-decision.js';
import { AUTO_LAUNCH_AWAIT_CLAIM_MS } from './mesh-autolaunch-integrity.js';
import { allowedClassifiedDifficultiesForSession, handleClaimPathDifficultyFloorRefusal, readSessionModel } from './mesh-difficulty-floor.js';
import { isWorkerMcpEnabled, mintWorkerTaskToken } from './worker-mcp-isolation.js';
import { readSessionWorkerMcpDelivered, resolveDispatchMessage } from './worker-handoff-dispatch.js';
import { isIdleSessionState, nodeHasActiveMeshWork, isLocalAutoLaunchNode, isSessionActivelyGenerating, resolveSessionBusyVerdict, type SessionBusyVerdict } from './mesh-candidacy-predicates.js';

// The claim path's mesh view, the dispatch delivery lifecycle and the queue drain
// live in mesh-queue-mesh-view.ts / mesh-queue-dispatch.ts / mesh-queue-trigger.ts;
// re-exported here, the path existing callers import from.
import { turnLedgerOf, deliverTaskToSession } from './mesh-queue-dispatch.js';
import { localCoordinatorDaemonId, delegatedWorkerAutoApproveSettingsForNode, getMeshWithCache } from './mesh-queue-mesh-view.js';
export { localCoordinatorDaemonId, loadRepoConfigForNode, loadRepoConfigForNodeDetailed, __resetRepoConfigWarnStreaksForTests, delegatedWorkerAutoApproveSettingsForNode, getMeshWithCache, readMeshNodeId } from './mesh-queue-mesh-view.js';
export type { RepoConfigUnavailableReason, LoadRepoConfigForNodeResult } from './mesh-queue-mesh-view.js';
export { turnLedgerOf, waitForLocalSessionReady, remoteSessionReadyProbe, __recordTaskDispatchedLedgerForTests } from './mesh-queue-dispatch.js';
export { awaitInFlightAutoLaunches, triggerMeshQueue, runIdleMaintenanceThenAssignQueue } from './mesh-queue-trigger.js';
export type { MeshQueueTriggerResult } from './mesh-queue-trigger.js';

export type { MeshTaskRoutingDecision } from './mesh-routing-decision.js';
export { DIFFICULTY_FLOOR_REPORT_AFTER_MS, resetDifficultyFloorReportsForTests as __resetDifficultyFloorReportsForTests } from './mesh-difficulty-floor.js';

// The four concerns below were split out of this module (pure move). Their public
// symbols are re-exported here so the module's export surface — which several suites
// and the mesh-events / mesh-events-coordinator barrels import through — is unchanged.
export {
    isWorkspaceAutoFastForwardInFlight,
    maybeAutoFastForwardIdleNode,
    runContinuousAutoFastForwardScan,
    runPendingCoordinatorCatchupScan,
    __resetIdleAutoFastForwardForTests,
} from './mesh-auto-fast-forward.js';
export { __isActionableSkipReasonForTests } from './mesh-skip-notify.js';
// activeWriteAssignedCount / activeReadonlyAssignedCount / sessionHasActiveAssignment are
// imported above for internal use, so they are re-exported by name rather than via
// `export ... from` (which would collide with the import binding).
export { activeWriteAssignedCount, activeReadonlyAssignedCount, sessionHasActiveAssignment };
export { AUTO_LAUNCH_LEDGER_DEDUP_MAX };
export {
    __resolveSchedulingStrategyForTests,
    __orderEligibleNodesForTests,
    __buildSchedulingPoolForTests,
    __decideSlotForModelForTests,
    __orderSlotsForProviderSelectionForTests,
    __scoreSlotForTaskForTests,
    __slotHasCapacityForTests,
} from './mesh-scheduling-fitness.js';
// Auto-launch candidacy predicates were split out (pure move, 2026-08-23) — see
// mesh-candidacy-predicates.ts. They are imported above for internal use, so they are
// re-exported by name rather than via `export ... from` (which would collide with the
// import binding). isIdleSessionState / nodeHasActiveMeshWork / isLocalAutoLaunchNode /
// isSessionActivelyGenerating / resolveSessionBusyVerdict were already public here and
// are read through this module by mesh-auto-fast-forward, mesh-skip-notify,
// mesh-reconcile-stranded-dispatch, med-family/cli-agent and several suites, so the
// surface must stay identical.
export {
    isIdleSessionState,
    nodeHasActiveMeshWork,
    isLocalAutoLaunchNode,
    isSessionActivelyGenerating,
    resolveSessionBusyVerdict,
};
export type { SessionBusyVerdict };

// WTCLAIM: workspace normalization for base-vs-worktree comparison now lives in
// @adhdev/mesh-shared (normalizeMeshWorkspaceForCompare) so the enqueue→claim path,
// the mesh_status per-node session filter, and the read_chat node scope guard all
// share one comparison rule instead of drifting module-private copies.

/**
 * Resolve the transcript-authority profile of the LIVE claiming session's
 * provider module (runtime capability, not manifest — a manifest may declare
 * nativeHistory the live-loaded session doesn't have). Row-lean subset: the
 * nativeHistory config itself stays local. Undefined when the session isn't
 * locally observable — the row simply carries no stamp and consumers fall
 * back to local resolution (older-daemon rows look the same).
 */
function resolveClaimingSessionTranscriptProfile(
    components: DaemonComponents,
    sessionId: string,
): MeshWorkQueueEntry['assignedTranscriptProfile'] {
    try {
        const instances = components.instanceManager?.getByCategory?.('cli') || [];
        const inst = instances.find((i: any) => {
            const sid = i?.getState?.().instanceId;
            return typeof sid === 'string' && sid && sessionIdsEquivalent(sid, sessionId);
        }) as { provider?: unknown } | undefined;
        const provider = inst?.provider;
        if (!provider || typeof provider !== 'object') return undefined;
        const profile = resolveTranscriptAuthorityProfile(provider as Parameters<typeof resolveTranscriptAuthorityProfile>[0]);
        return { class: profile.class, timing: profile.timing, emitsPtyTurnEvents: profile.emitsPtyTurnEvents };
    } catch {
        return undefined;
    }
}

/**
 * WORKTREE-CLAIM-GATE-BYPASS: the SINGLE claim-time gate for the worktree-bootstrap
 * defer. tryAssignQueueTask is the one funnel every claim path flows through (the
 * event-driven agent:ready drain, the triggerMeshQueue idle-session drain, the
 * auto-launch claim, the reconcile re-drain), so a worktree node whose bootstrap is
 * still 'running' can never be claimed from any path — the event handler's own defer
 * once let a concurrent drain claim through here within ~0.16s and dispatch into a
 * half-built worktree (native addons not yet installed → child daemon dies → empty
 * session, stranded forever because the transport ack still returned ok). The task
 * stays pending (no fail/cancel), so the bootstrap_complete refire re-runs this claim
 * and passes once status is no longer 'running'. Identity uses meshNodeIdMatches,
 * never a raw === (canon-identity regression guard). Conservative: any non-'running'
 * status does NOT gate.
 *
 * COMPLETION-PROPAGATION F7 (C2 SSOT): the node's bootstrap status is read from the
 * router's synchronous inline cache FIRST — the authoritative source
 * markWorktreeBootstrapTerminalState stamps synchronously — falling back to the
 * merged claim view only when the inline node carries no bootstrap status (a
 * config-registered node's status lags the inline stamp through the detached persist
 * chain). Dual-source (5-c): inline is authoritative for bootstrap status but often
 * lacks lastGit, which the stale-bypass check needs.
 *
 * Returns true when the claim must be deferred.
 */
function isClaimGatedByWorktreeBootstrap(components: DaemonComponents, meshId: string, nodeId: string, sessionId: string, node: any): boolean {
    const inlineBootstrapNode = (() => {
        try {
            const inlineMesh = components.router?.getCachedInlineMesh?.(meshId);
            const inlineNode = Array.isArray(inlineMesh?.nodes)
                ? inlineMesh.nodes.find((n: any) => meshNodeIdMatches(n, nodeId))
                : undefined;
            return readText(inlineNode?.worktreeBootstrap?.status) ? inlineNode : undefined;
        } catch { return undefined; }
    })();
    const bootstrapGateNode = (() => {
        const base = inlineBootstrapNode ?? node;
        if (!base) return base;
        const git = (inlineBootstrapNode as any)?.lastGit ?? (inlineBootstrapNode as any)?.last_git
            ?? (node as any)?.lastGit ?? (node as any)?.last_git;
        return git ? { ...base, lastGit: git, last_git: git } : base;
    })();
    if ((bootstrapGateNode as { worktreeBootstrap?: { status?: string } } | undefined)?.worktreeBootstrap?.status !== 'running') {
        // Bootstrap is no longer 'running' (the terminal stamp landed, or never was
        // running): clear the dedup fingerprint so a genuinely new stuck episode warns.
        clearWorktreeBootstrapStaleBypassState(meshId, nodeId, sessionId);
        return false;
    }
    // Fix (3) safety net + F7: shouldDeferDispatchForBootstrap returns false when the 'running'
    // state is stale (older than the backstop AND git-clean) — treat that as silently complete
    // and allow the claim; otherwise defer (leave the task pending) so the claim re-fires once
    // bootstrap reaches a terminal state and never dispatches into a half-built worktree.
    if (!shouldDeferDispatchForBootstrap(bootstrapGateNode as any)) {
        // Transition-deduped (mesh-queue-observability): this bypass re-fires on every
        // ~4s drain tick while the terminal stamp is missing, so only the first entry
        // into the stuck state warns.
        logWorktreeBootstrapStaleBypass(meshId, nodeId, sessionId);
        return false;
    }
    LOG.info('MeshQueue', `Gating queue claim for worktree node ${nodeId} (${sessionId}): worktree bootstrap still running — task left pending; claim re-fires once bootstrap reaches a terminal state (guards against dispatching into a half-built worktree → empty session)`);
    return true;
}

/**
 * WTCLAIM / WTDISPATCH: a base-targeted task must never be claimed by — and
 * dispatched into — a co-located worktree-clone session, nor vice versa, nor a
 * sibling worktree node's session on the same daemon. The drain candidate's nodeId
 * can be derived from a stale / empty meshNodeId (falling back to the BASE node id),
 * and an auto-launched worker can carry its node binding only on the CLI-instance
 * settings. So the claiming session's REAL identity is resolved from its own
 * meshNodeId stamp first (authoritative — mesh-routing trusts it first; a match
 * settles it even when a base/worktree pair shares a workspace), then from its
 * workspace (adapter workingDir, else the live CLI instance). A contradiction on
 * either refuses the claim (fail-closed) so the task returns to pending for the
 * correctly-scoped session. Conservative: when neither the stamp nor both
 * workspaces are resolvable nothing is refused — a genuinely remote cross-daemon
 * candidate stays nodeId-matched from getRemoteIdleSessions.
 *
 * Returns the claiming session's live state (null when refused).
 */
function resolveClaimingSessionState(components: DaemonComponents, nodeId: string, sessionId: string, node: any): { claimState: any } | null {
    const localClaimAdapter = components.cliManager?.adapters?.get(sessionId) as { workingDir?: string } | undefined;
    let claimInstanceWorkspace = '';
    let claimStampedNodeId = '', claimState: any;
    try {
        claimState = components.instanceManager?.getInstance?.(sessionId)?.getState?.();
        claimInstanceWorkspace = readText(claimState?.workspace);
        const claimSettings = (claimState?.settings as Record<string, unknown>) || {};
        claimStampedNodeId = readText(claimSettings.meshNodeId);
    } catch { /* best-effort — fall through to the conservative (no refuse) path */ }

    const nodeWorkspaceRaw = readText(node?.workspace);
    const sessionWorkspaceRaw = readText(localClaimAdapter?.workingDir) || claimInstanceWorkspace;

    if (claimStampedNodeId && nodeId) {
        if (!meshNodeIdMatches({ id: claimStampedNodeId } as MeshNodeIdentified, nodeId)) {
            LOG.info('MeshQueue', `WTDISPATCH: refusing claim for node ${nodeId} (${sessionId}) — session is bound to node "${claimStampedNodeId}" (cross-node claim blocked)`);
            return null;
        }
    } else if (sessionWorkspaceRaw && nodeWorkspaceRaw && !meshWorkspacesEquivalent(sessionWorkspaceRaw, nodeWorkspaceRaw)) {
        LOG.info('MeshQueue', `WTCLAIM: refusing claim for node ${nodeId} (${sessionId}) — session workspace "${normalizeMeshWorkspaceForCompare(sessionWorkspaceRaw)}" ≠ node workspace "${normalizeMeshWorkspaceForCompare(nodeWorkspaceRaw)}" (cross-workspace dispatch blocked)`);
        return null;
    }
    return { claimState };
}

/** The atomic claim's filter inputs for this (node, session, provider). */
function buildClaimOptions(p: {
    components: DaemonComponents;
    meshId: string;
    nodeId: string;
    sessionId: string;
    providerType: string;
    node: any;
    mesh: any;
    claimState: any;
    routingDecision?: MeshTaskRoutingDecision;
}) {
    const { components, meshId, nodeId, sessionId, providerType, node, mesh } = p;
    // Per-(node, provider) maxParallel cap (summed across the node's slots for this
    // provider) layers on top of the global/taskMode caps — stricter wins. Enforced
    // inside the atomic claim transaction so concurrent claims can't overshoot it.
    const nodeSlotsForCap = resolveNodeCapabilitySlots(node, meshId);
    const providerMaxParallel = resolveProviderMaxParallel(nodeSlotsForCap, providerType);
    // PER-SLOT cap. `maxParallel` bounds ONE SLOT (a (provider, model) pair), not a
    // shared provider pool: a node pinning claude-cli/opus to 1 means opus runs one
    // task at a time even while the claude-cli/sonnet slot sits idle. Auto-launch knows
    // the selected model; idle/event claims use live model metadata when available and
    // otherwise apply the conservative intersection of provider slots.
    const assignedModel = typeof p.routingDecision?.resolvedModel === 'string' && p.routingDecision.resolvedModel.trim()
        ? p.routingDecision.resolvedModel.trim()
        : readSessionModel(p.claimState);
    const allowedTaskDifficulties = allowedClassifiedDifficultiesForSession(node, nodeSlotsForCap, providerType, assignedModel);
    const claimingSlot = nodeSlotsForCap.find(s =>
        s.provider?.trim() === providerType && isModelAllowedBySlot(assignedModel, s));
    const slotMaxParallel = claimingSlot
        ? resolveSlotMaxParallel(nodeSlotsForCap, providerType, claimingSlot.model, isModelAllowedBySlot)
        : undefined;
    // P1 transcript-authority stamp: the claim runs on the daemon that owns the
    // session, so the LIVE provider module (runtime capability, not manifest) is
    // resolvable here — classify once and persist it on the row so coordinator-side
    // gates (early-arm / redrive) can classify this worker without local access.
    const assignedTranscriptProfile = resolveClaimingSessionTranscriptProfile(components, sessionId);
    // GIT-GATE: the auto-launch SPAWN gate refuses a dirty or stale-behind node before
    // it launches, but an ALREADY-idle session reaches this claim through a different
    // path (agent:ready, idle drain, reconcile re-drive) — so the SAME predicates are
    // resolved against the SAME node record here and threaded into the atomic claim as
    // a plain opt (the store's candidate filter never imports auto-fast-forward policy).
    // Fail-open by construction: both predicates decide only on POSITIVE telemetry.
    const gitGateMaxBehind = resolveAutoFastForwardPolicy(mesh).maxBehind;
    const nodeGitBehind = readNumberValue(node?.git?.behind, node?.cachedStatus?.git?.behind);
    const nodeGitGate = {
        dirty: isDirtyNode(node),
        staleBehind: !isMeshNodeFreshEnoughToLaunch(node, { maxBehind: gitGateMaxBehind }),
        ...(nodeGitBehind !== undefined ? { behind: nodeGitBehind } : {}),
        ...(gitGateMaxBehind !== undefined ? { maxBehind: gitGateMaxBehind } : {}),
    };
    // Before refusing on staleness, kick one immediate fast-forward attempt for this
    // node if continuous auto-ff is enabled — best-effort, fire-and-forget (self-
    // throttled, must never block this claim). The NEXT drain tick picks up the result.
    if (nodeGitGate.staleBehind && resolveAutoFastForwardPolicy(mesh).mode === 'continuous') {
        void maybeAutoFastForwardIdleNode(components, { meshId, nodeId, sessionId, providerType }).catch(() => { /* best-effort */ });
    }
    return {
        capabilityTags: buildMeshNodeCapabilityTags(node, providerType),
        assignedTranscriptProfile,
        options: {
            providerType,
            ...(providerMaxParallel !== undefined ? { providerMaxParallel } : {}),
            ...(assignedModel ? { assignedModel } : {}),
            nodeGitGate,
            ...(slotMaxParallel !== undefined ? { slotMaxParallel } : {}),
            // ★ DAEMON-AXIS CAP SCOPE: the provider/slot caps count over the physical
            // DAEMON MACHINE (CPU, memory, upstream rate limit, one on-disk CLI auth),
            // not this node alone — per-node counting let cloned worktrees multiply the
            // budget. Remote machines declare their own daemonId and keep their own.
            daemonNodeIds: resolveDaemonSiblingNodeIds(nodeId, mesh?.nodes),
            // WTDISPATCH-FANOUT: a `convergence` task (base-only: merge → push →
            // cleanup) is refused for worktree sessions, so sibling worktree sessions
            // cannot all claim the same convergence intent and race push/deploy.
            nodeIsWorktree: node?.isLocalWorktree === true,
            ...(allowedTaskDifficulties ? { allowedTaskDifficulties } : {}),
            ...(assignedTranscriptProfile ? { assignedTranscriptProfile } : {}),
        },
    };
}

/**
 * TURN-LEDGER (C2, C-W4): open — or, after a reclaim, resume — the attempt this
 * dispatch delivers, as evidence (dispatch_accepted → R1). The attempt id is stamped
 * on the queue row and carried to the worker (meshContext attemptId +
 * attemptGeneration), which echoes it as its evidence attemptRef. A ledger commit
 * writes the row in the same txn, so a pending row whose latest attempt is terminal
 * is a legitimate retry. Returns null (task back to pending) when no attempt can be
 * used: a dispatch without an attempt is the rc.39 defect (nothing can close the row).
 */
function openClaimAttempt(p: {
    turnLedger: TurnLedger;
    meshId: string;
    task: MeshWorkQueueEntry;
    nodeId: string;
    sessionId: string;
    providerType: string;
    mesh: any;
    assignedTranscriptProfile: MeshWorkQueueEntry['assignedTranscriptProfile'];
    trigger: string;
}): TurnAttemptRef | null {
    const { turnLedger, meshId, task, sessionId } = p;
    try {
        const opened = openOrResumeQueueAttempt(turnLedger, {
            coordinatorDaemonId: localCoordinatorDaemonId(),
            meshId,
            task,
            nodeId: p.nodeId,
            sessionId,
            providerType: p.providerType,
            consumeProfile: p.assignedTranscriptProfile?.class === 'native-source' ? 'native_source' : 'default',
            maxTaskRetries: typeof p.mesh?.policy?.maxTaskRetries === 'number' ? p.mesh.policy.maxTaskRetries : 1,
        });
        if ('refused' in opened) {
            // A prompt must never be injected into an attempt that already
            // consumed one (crash/replay or a same-tick duplicate path).
            LOG.warn('MeshQueue', `Refusing queue claim dispatch of task ${task.id} → session ${sessionId}: its open attempt ${opened.refused.attemptId} is already ${opened.refused.state}`);
            updateTaskStatus(meshId, task.id, 'pending');
            return null;
        }
        task.attemptId = opened.ref.attemptId;
        MeshRuntimeStore.getInstance().updateQueueEntry(task);
        return opened.ref;
    } catch (e: any) {
        LOG.warn('TurnLedger', `refusing queue claim of task ${task.id} → session ${sessionId}: failed to open its turn attempt (claim path ${p.trigger}) — task left pending: ${e?.message || e}`);
        updateTaskStatus(meshId, task.id, 'pending');
        return null;
    }
}

/** Bookkeeping for a claimed task whose attempt is open, before it is dispatched. */
function recordTaskClaimed(p: { meshId: string; task: MeshWorkQueueEntry; nodeId: string; sessionId: string; providerType: string; attemptId: string }): void {
    const { meshId, task, nodeId, sessionId, providerType } = p;
    // WORKER-MCP (design §9.2.1): mint the per-task worker token now that the attempt
    // exists (the direct-dispatch arm mints in recordDirectDispatchTask). AFTER the
    // attempt open so the token carries a real attemptId: binding to the task alone
    // would let a late report from a superseded dispatch land on the retry's row (the
    // REDRIVE-DUP family). Best-effort — a mint failure must not sink the dispatch.
    if (isWorkerMcpEnabled()) {
        try {
            mintWorkerTaskToken({ meshId, taskId: task.id, attemptId: p.attemptId, sessionId, nodeId });
        } catch (e: any) {
            LOG.warn('WorkerMcp', `Failed to mint worker task token for ${task.id}: ${e?.message || e}`);
        }
    }
    // LEDGER-TASK-TRACEABILITY (C): the task just transitioned pending→assigned. Record
    // the claim (distinct from the later task_dispatched, which fires when the message is
    // handed to the transport in deliverTaskToSession). Best-effort.
    try {
        meshRecord(meshId, 'task_claimed', {
            nodeId,
            sessionId,
            providerType,
            taskId: task.id,
            payload: {
                taskId: task.id,
                ...(task.missionId ? { missionId: task.missionId } : {}),
                nodeId,
                sessionId,
                providerType,
                claimedAt: new Date().toISOString(),
            },
        }, { local: true });
    } catch { /* best-effort — claim proceeds regardless */ }
    // FALSE-BLOCKER-CLONE-QUEUE (stale-event clear): the task just claimed and will
    // dispatch, so any actionable blocker previously paged for it is now stale —
    // re-arm the de-dup ledger and retract any undelivered dispatch_blocked event.
    retractActionableSkipIfPreviouslyNotified(meshId, task.id);
    // CANON-IDENTITY single-flight: mark the task in-flight the moment it is handed
    // to a transport, so requeueTask can tell a genuinely-generating task (refuse the
    // operator requeue — it would open a second session) from a stale assigned row.
    // Cleared when the task leaves `assigned`.
    beginTaskDispatchInFlight(meshId, task.id);
}

/**
 * The meshContext a claimed task is dispatched with (both transports). REDRIVE-DUP:
 * the dispatch nonce lets the worker reject a stale inject after a reclaim; the
 * attempt identity correlates the worker's evidence to (taskId, attemptId, session);
 * the coordinator session anchor routes the completion back to the session that
 * enqueued the task (multi-coordinator); COORDINATOR-SILENT-IDLE's one-shot
 * silentIdlePush rides here when the mesh policy asks for it.
 */
function buildClaimDispatchMeshContext(p: {
    meshId: string; nodeId: string; task: MeshWorkQueueEntry; attemptRef: TurnAttemptRef;
    coordinatorDaemonId: string | undefined; coordinatorSessionId: string | undefined; silentIdlePush: boolean;
}) {
    const { task, attemptRef } = p;
    return {
        meshId: p.meshId,
        nodeId: p.nodeId,
        taskId: task.id,
        ...(typeof task.dispatchNonce === 'number' ? { dispatchNonce: task.dispatchNonce } : {}),
        ...(attemptRef.attemptId ? { attemptId: attemptRef.attemptId } : {}),
        attemptGeneration: attemptRef.generation,
        ...(p.coordinatorDaemonId ? { coordinatorDaemonId: p.coordinatorDaemonId } : {}),
        ...(p.coordinatorSessionId ? { coordinatorSessionId: p.coordinatorSessionId } : {}),
        ...(p.silentIdlePush ? { silentIdlePush: true } : {}),
    };
}

/**
 * Stamp mesh context onto a LOCAL session so completion events route correctly via
 * setupMeshEventForwarding. Without this, manually-opened idle sessions
 * (mesh_launch_session without auto-launch) lack meshNodeFor/meshNodeId and
 * agent:generating_completed is silently dropped as isMeshDelegate=false. Adopting
 * a (possibly manually-opened) session as a worker also applies the delegated-worker
 * auto-approve policy, and — since this branch runs on the coordinator daemon for a
 * co-located session — stamps this daemon's id as meshCoordinatorDaemonId, the
 * anchor the forwarder keys on (matching what mesh_launch_session stamps).
 */
function stampLocalClaimedSession(components: DaemonComponents, p: { meshId: string; nodeId: string; sessionId: string; providerType: string; task: MeshWorkQueueEntry; mesh: any; node: any }): void {
    try {
        const inst = components.instanceManager.getInstance(p.sessionId);
        if (!inst || typeof inst.updateSettings !== 'function') return;
        const localDaemonId = localCoordinatorDaemonId();
        const localSourceCoordinatorSessionId = readText(p.task.sourceCoordinatorSessionId);
        inst.updateSettings({
            meshNodeFor: p.meshId,
            meshNodeId: p.nodeId,
            launchedByCoordinator: true,
            ...delegatedWorkerAutoApproveSettingsForNode(
                p.mesh,
                p.node,
                components.providerLoader?.getMeta(p.providerType),
                p.providerType,
            ),
            ...(localDaemonId ? { meshCoordinatorDaemonId: localDaemonId } : {}),
            // COMPLETION-PROPAGATION F5: (re)stamp the coordinator SESSION anchor from THIS
            // task's sourceCoordinatorSessionId with PRIORITY — a reused session may carry a
            // stale anchor that would unicast the completion to the wrong/absent coordinator
            // session. When the task carries NONE, CLEAR it (updateSettings merges, so an
            // explicit undefined overrides) so the completion BROADCASTS instead.
            meshCoordinatorSessionId: localSourceCoordinatorSessionId || undefined,
        });
    } catch { /* best-effort — dispatch still proceeds */ }
}

export function tryAssignQueueTask(
    components: DaemonComponents,
    meshId: string,
    nodeId: string,
    sessionId: string,
    providerType: string,
    // LEDGER-TASK-TRACEABILITY (A): routing rationale computed by the auto-launch drain
    // (fitness score, skipped candidates, resolved model/thinking). Threaded to the
    // task_dispatched ledger entry. Other claim paths (event/idle drain) omit it and the
    // entry records source:'queue' with just the resolved provider from the claimed row.
    routingDecision?: MeshTaskRoutingDecision,
    quotaClaimTrace?: QuotaClaimDrainTrace,
    trigger: string = 'queue_claim',
): boolean {
    // TURN-LEDGER FAIL-CLOSED (rc.39): a queue claim dispatches the task body
    // into an attempt the ledger opens below. With no ledger there is no
    // attempt — the worker's stamp reads `attempt=?`, nothing can ever close
    // the row, and it stays `assigned` forever, blocking the node. Refuse BEFORE
    // the atomic claim so the row is untouched (still pending), loudly.
    const turnLedger = turnLedgerOf(components);
    if (!turnLedger) {
        LOG.warn('TurnLedger', `refusing queue claim for node ${nodeId} (${sessionId}) in mesh ${meshId}: no turn ledger on this daemon (claim path ${trigger}) — task left pending`);
        return false;
    }
    // Same class, other half: without the router's inline-mesh cache the claim view
    // misses cloned worktree nodes (CLAIMSTALL) — real components always carry it.
    if (typeof components.router?.getCachedInlineMesh !== 'function') {
        LOG.warn('MeshQueue', `refusing queue claim for node ${nodeId} (${sessionId}) in mesh ${meshId}: components carry no router inline-mesh view (claim path ${trigger}) — task left pending`);
        return false;
    }
    const mesh = getMeshWithCache(components, meshId);
    // Match with the shared 3-form normalizer (id / nodeId / node_id), not raw
    // `n.id` — a stamp-form nodeId vs the mesh node's config-form id must still resolve.
    const node = mesh?.nodes.find((n: any) => meshNodeIdMatches(n, nodeId));

    // OBSERVABILITY (quota-ranking gap C): only the auto-launch path just ran the
    // ranking loop and wrote a real record for this nodeId — every OTHER path adopts
    // whatever provider the already-running session has. Record that fact so the gap
    // is visible in getLastQuotaRanking/mesh_status rather than silently absent.
    if (routingDecision?.source !== 'autoLaunch') {
        recordLastQuotaRanking(nodeId, { decidedAt: Date.now(), winner: providerType, adopted: true });
    }

    // AUTO-FF LEASE: an auto fast-forward may be mutating this node's workspace right
    // now (git merge --ff-only can move HEAD); dispatching mid-checkout would run the
    // worker against an inconsistent tree. The task stays pending and re-fires on the
    // next drain tick. Keyed by canonical workspace. AUTOLAUNCH-DEFERRED-CLAIM
    // (mesh-claim-refusal.ts): mark the deferral so the auto-launch await-claim guard
    // re-drives instead of waiting out a window that assumes a claim is in flight.
    if (isWorkspaceAutoFastForwardInFlight(readText(node?.workspace))) {
        LOG.info('MeshQueue', `Deferring queue claim for node ${nodeId} (${sessionId}): an auto fast-forward is mutating its workspace — task left pending, claim re-fires next tick`);
        noteClaimDeferredForNode(meshId, nodeId);
        return false;
    }

    // QUOTA GATE (claim path) + PIN OVERRIDE: see mesh-queue-claim-gate.ts. Returns
    // true when the claim must be refused — the task stays pending.
    if (evaluateQuotaClaimGateForAssignment({ meshId, nodeId, sessionId, providerType, model: routingDecision?.selectedSlot?.model, trigger, node, mesh, providerLoader: components.providerLoader, quotaClaimTrace })) {
        return false;
    }
    if (isClaimGatedByWorktreeBootstrap(components, meshId, nodeId, sessionId, node)) return false;
    const claiming = resolveClaimingSessionState(components, nodeId, sessionId, node);
    if (!claiming) return false;

    const claim = buildClaimOptions({ components, meshId, nodeId, sessionId, providerType, node, mesh, claimState: claiming.claimState, routingDecision });
    // A6-SILENT-REFUSAL: collect WHICH gate refused so the `!task` exit below stops being
    // the silent funnel that made a permanently-stuck task look like an idle queue.
    const claimRefusal: MeshClaimRefusal = {};
    const task = claimNextTask(meshId, nodeId, sessionId, claim.capabilityTags, { ...claim.options, outRefusal: claimRefusal });
    if (!task) {
        const refusalReason = claimRefusal.reason || 'no_pending_candidates';
        // ORPHAN-SPAWN-DEADLOCK: the auto-launch spawn gate reads this (see mesh-claim-refusal.ts).
        noteSessionClaimRefusal(meshId, sessionId, { reason: refusalReason, ...(claimRefusal.taskId ? { taskId: claimRefusal.taskId } : {}) });
        recordClaimRefusal(meshId, {
            nodeId,
            sessionId,
            ...(providerType ? { providerType } : {}),
            reason: refusalReason,
            ...(claimRefusal.detail ? { detail: claimRefusal.detail } : {}),
        });
        // Qualify the ranking written above so it can no longer be misread as evidence
        // that a task was dispatched to this node.
        recordLastQuotaRankingOutcome(nodeId, 'refused', refusalReason);
        handleClaimPathDifficultyFloorRefusal({ meshId, nodeId, refusalReason, claimRefusal, coordinatorDaemonId: localCoordinatorDaemonId() });
        return false;
    }
    // A claim succeeded — drop any refusal fingerprint so a later genuine re-entry into
    // the same gate is reported again, and retire the ff-deferred-claim marker
    // (AUTOLAUNCH-DEFERRED-CLAIM) now that this node has demonstrably claimed.
    clearClaimRefusalState(meshId, nodeId, sessionId);
    noteSessionClaimRefusal(meshId, sessionId, null);
    clearClaimDeferralForNode(meshId, nodeId);
    recordLastQuotaRankingOutcome(nodeId, 'claimed');

    if (quotaClaimTrace?.blocked.length) {
        logQuotaClaimFallbackSuccess(quotaClaimTrace.blocked, task.id, { nodeId, sessionId, providerType });
        quotaClaimTrace.blocked = [];
        quotaClaimTrace.evaluated = 0;
        quotaClaimTrace.clear = 0;
    }

    LOG.info('MeshQueue', `Node ${nodeId} (${sessionId}) pulled task ${task.id}`);

    const dispatchAttemptRef = openClaimAttempt({ turnLedger, meshId, task, nodeId, sessionId, providerType, mesh, assignedTranscriptProfile: claim.assignedTranscriptProfile, trigger });
    if (!dispatchAttemptRef) return false;
    recordTaskClaimed({ meshId, task, nodeId, sessionId, providerType, attemptId: dispatchAttemptRef.attemptId });

    // WORKER-MCP decision C: the dispatched body may carry handoff notes from related
    // earlier work — composed ONCE (not per transport) and applied to the DISPATCHED
    // body only; `task.message` stays the authored text.
    const dispatchMessage = resolveDispatchMessage(task, meshId, node, {
        workerMcp: readSessionWorkerMcpDelivered(claiming.claimState?.settings),
    });
    const coordinatorDaemonId = localCoordinatorDaemonId();
    const coordinatorSessionId = readText(task.sourceCoordinatorSessionId) || undefined;
    const meshContext = buildClaimDispatchMeshContext({
        meshId, nodeId, task, attemptRef: dispatchAttemptRef, coordinatorDaemonId, coordinatorSessionId,
        // COORDINATOR-SILENT-IDLE (opt-in): the worker stamps silentNextIdlePush on its own
        // live session so the SINGLE completion that follows this dispatch rides a muted
        // status snapshot. Default 'always' → absent, nothing changes.
        silentIdlePush: resolveCoordinatorIdlePushPolicy(mesh?.policy) === 'auto_silent_on_dispatch',
    });
    // The send_chat body both transports carry. MESH-IMAGE-DISPATCH: the envelope the
    // task was enqueued with rides to the worker (spread conditionally so a text-only
    // task sends the byte-identical payload). D2 (SessionInputService): the dispatch's
    // stable identity — the turn ledger's `task:<id>:n<nonce>` — so a same-nonce
    // redelivery is ONE message to the worker's funnel; always queued behind a busy turn.
    const sendChat = {
        targetSessionId: sessionId,
        cliType: providerType,
        action: 'send_chat',
        message: dispatchMessage,
        ...(task.input ? { input: task.input } : {}),
        messageId: dispatchMessageId(task),
        policy: { mode: 'queue' },
        origin: 'mesh',
    };
    // Shared dispatch lifecycle (CONS3): delivery record, status transitions,
    // requeue-on-failure, ledger and the hang timeout live in deliverTaskToSession —
    // only the transport call differs between the two arms below.
    const deliverContext = {
        meshId,
        nodeId,
        sessionId,
        providerType,
        task,
        components,
        ...(coordinatorSessionId ? { sourceCoordinatorSessionId: coordinatorSessionId } : {}),
        ...(coordinatorDaemonId ? { sourceCoordinatorDaemonId: coordinatorDaemonId } : {}),
        ...(routingDecision ? { routingDecision } : {}),
        attemptRef: dispatchAttemptRef,
    };

    // CANON-IDENTITY: read the remote daemon id through the normalizing helper so a node
    // whose daemonId arrives in a non-top-level-camelCase serialization form (daemon_id /
    // machine.daemonId / lastProbe.machine.daemon_id / …) is still recognized as remote.
    const remoteDaemonId = readMeshNodeDaemonId(node ?? {});
    const dispatchMeshCommand = components.dispatchMeshCommand;
    // WTDISPATCH-SELFDIAL: locality is a DAEMON-IDENTITY question, not a session-presence
    // one. A local worktree node INHERITS the coordinator's own daemonId from the node it
    // was cloned from, so asking only `cliManager.adapters.has(sessionId)` (a raw Map
    // lookup, false for a sibling observed via the remote-idle store / an independently
    // minted ACP id / a prefixed id form) dialed P2P to ourselves, which the mesh manager
    // refuses. Ask the identity question FIRST through the same canon-aware predicate the
    // auto-launch path uses; the adapter probe stays as a secondary signal.
    if (remoteDaemonId && dispatchMeshCommand && !(isLocalAutoLaunchNode(node) || components.cliManager.adapters.has(sessionId))) {
        deliverTaskToSession(
            () => dispatchMeshCommand(remoteDaemonId, 'agent_command', {
                ...sendChat,
                // DISPATCH-SOURCE-TRACE: call-site tag echoed in the worker daemon log.
                dispatchSource: 'mesh-queue-assignment:tryAssignQueueTask:remote',
                meshContext,
            }),
            { ...deliverContext, transport: 'remote' },
            // Warmup-aware deadline: this dispatch can be the FIRST command to a peer whose
            // mesh DataChannel is still opening — charge the cold-open handshake to the
            // connect budget, not the response budget.
            { daemonId: remoteDaemonId, getConnection: components.getMeshPeerConnectionStatus },
        );
        return true;
    }

    stampLocalClaimedSession(components, { meshId, nodeId, sessionId, providerType, task, mesh, node });
    // `_meshDirectDispatch` pins local execution: the router must not forward to an
    // "owner" if the session vanished between claim and dispatch (wiring-unification
    // B4). ARCH-REFACTOR R1: meshContext (incl. taskId) rides the LOCAL dispatch too,
    // so agent_command's send_chat path binds this task to its turn (per-turn identity).
    deliverTaskToSession(
        () => components.router.execute('agent_command', withMeshDirectDispatch({}, {
            ...sendChat,
            // DISPATCH-SOURCE-TRACE: call-site tag echoed in the daemon log.
            dispatchSource: 'mesh-queue-assignment:tryAssignQueueTask:local',
            meshContext,
        // In-process: this daemon's own queue dispatching to its own session —
        // no remote sender for the router's mesh sender gate to check.
        }), 'mesh', { inProcess: true }),
        { ...deliverContext, transport: 'local' },
    );

    return true;
}

// The auto-launch subsystem (launch locks, cooldown clock, target resolution,
// in-loop quota-gated provider selection, markAutoLaunch ledger writes, and the
// maybeAutoLaunchOneQueueSession scan) lives in mesh-queue-autolaunch.ts. Its test
// hooks are re-exported below so existing import paths are unaffected.
export {
    __autoLaunchTaskLockHeldForTests,
    __markAutoLaunchForTests,
    __resetAutoLaunchAwaitClaimBackoffForTests,
    __resolveUsableProviderForTests,
} from './mesh-queue-autolaunch.js';

// A remote auto-launch (launch_cli forward) is fire-and-async: the worker session
// spawns, reaches idle, emits agent:ready, that ready is queued on the worker, pulled
// by this coordinator (reconcile PHASE 1), and only THEN claims the task. That round
// trip routinely exceeds the 5s per-(mesh,node) cooldown, so cooldown alone lets the
// reconcile loop fire a SECOND launch for the same still-pending task before the first
// session's claim lands — every tick spawns yet another orphan session (observed live:
// 26 sessions for one task). This is a per-TASK await-claim window: once a task has a
// successfully-launched session whose claim we are still waiting on, do not launch it
// again until the window lapses. It is generous (a slow remote spawn can take tens of
// seconds) but bounded so a launch that silently never reaches idle is eventually retried.
// Defined in mesh-autolaunch-integrity (alongside the backoff state that consumes them) and
// re-exported here, which is the path existing callers/tests import from.
export { AUTO_LAUNCH_AWAIT_CLAIM_MS };
// AUTOLAUNCH-DEFERRED-CLAIM state lives in mesh-claim-refusal (this file is a frozen
// file-size baseline entry). Re-exported here, which is the path tests import from.
export { __resetClaimDeferralForTests, __resetSessionClaimRefusalsForTests } from './mesh-claim-refusal.js';
export { __seedAutoLaunchAwaitClaimBackoffForTests } from './mesh-autolaunch-integrity.js';
