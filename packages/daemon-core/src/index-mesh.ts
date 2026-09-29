/**
 * @adhdev/daemon-core — Repo Mesh public surface.
 *
 * Re-exported wholesale by index.ts (`export * from './index-mesh.js'`); split out
 * so the root barrel stays navigable. Consumers keep importing from
 * `@adhdev/daemon-core` — this module is not a separate package entry.
 */

// ── Mesh Config ──
export { listMeshes, listMeshesReadOnly, getMesh, getMeshByRepo, createMesh, updateMesh, deleteMesh, addNode, removeNode, updateNode } from './config/mesh-config.js';
export { resolveScopedMeshId } from './config/mesh-config-routing.js';
export { normalizeRepoIdentity } from './config/mesh-config-store.js';
export type { CreateMeshOptions, UpdateMeshOptions, AddNodeOptions } from './config/mesh-config.js';

// ── Mesh shared daemon-id / node-id helpers (re-export so external tooling —
//    e.g. the mcp-server, which depends only on @adhdev/daemon-core — can
//    canonicalize daemon-id and node-id forms without taking a direct
//    @adhdev/mesh-shared dependency). ──
export { expandDaemonIdForms, daemonIdsEquivalent, machineCoreFromDaemonId, canonicalDaemonId } from '@adhdev/mesh-shared';
export { normalizeMeshNodeId, meshNodeIdMatches } from '@adhdev/mesh-shared';
export { DASHBOARD_WIRE_VERSION } from '@adhdev/mesh-shared';
// Canonical mesh tool-name registry (SSOT for the schema ↔ prompt ↔ barrel-comment
// consistency the 6-6 test enforces). Re-exported so mcp-server (which depends on
// daemon-core, not on mesh-shared directly) and the daemon-core prompt test both
// reference one list.
export { CANONICAL_MESH_TOOL_NAMES, CANONICAL_MESH_TOOL_COUNT, RETIRED_MESH_TOOLS, retiredMeshToolError } from '@adhdev/mesh-shared';
export type { CanonicalMeshToolName } from '@adhdev/mesh-shared';

// ── Mesh Coordinator ──
export { buildCoordinatorSystemPrompt } from './mesh/coordinator-prompt.js';
export { upsertMeshMission, getMeshMissions, getMeshMission, summarizeMissionTasks, summarizeMeshMission, getActiveMeshMissionSummaries, getMeshStatusMissionSummaries, getMeshStatusMissionsCompact, listMeshMissionSummaries, listMeshMissionsForTool, buildMissionPromptSection, GOAL_PREVIEW_MAX, COMPACT_STATUS_GOAL_PREVIEW_MAX, MESH_MISSION_LIST_HISTORY_ID_LIMIT, MESH_MISSION_LIST_STATUS_LIMIT, MESH_MISSION_STATUSES } from './mesh/mesh-missions.js';
export type { MeshMissionRecord, MeshMissionStatus, MeshMissionSummary, MeshMissionSlimSummary, MeshMissionTaskAggregate, MeshStatusMissionsCompact, MeshStatusMissionsHistoryFold, MeshMissionListResult } from './mesh/mesh-missions.js';
export { computeMeshTaskStats, computeMeshMissionStats } from './mesh/mesh-task-stats.js';
export type { MeshTaskStats, MeshMissionStats } from './mesh/mesh-task-stats.js';
export { deriveMeshReviewInboxItems } from './mesh/mesh-review-inbox.js';
export type { MeshReviewInboxItem, MeshReviewInboxDerivation, MeshReviewInboxEvidence, MeshReviewInboxDiffSummary, MeshReviewInboxDiffFile, MeshReviewInboxReason, MeshReviewInboxConvergence } from './mesh/mesh-review-inbox.js';
export type { CoordinatorPromptContext } from './mesh/coordinator-prompt.js';
export { planMeshOnboarding } from './mesh/mesh-onboarding-plan.js';
export type {
  MeshOnboardingDiscovery,
  MeshOnboardingErrorCode,
  MeshOnboardingOperation,
  MeshOnboardingPlanFailure,
  MeshOnboardingPlanResult,
  MeshOnboardingPlanSuccess,
  PlanMeshOnboardingOptions,
} from './mesh/mesh-onboarding-plan.js';
export { loadMeshCoordinatorRegistry, registerMeshCoordinator, unregisterMeshCoordinator, getCoordinatorForSession, listCoordinatorsForWorkspace, pruneDeadMeshCoordinators } from './mesh/coordinator-registry.js';
export type { CoordinatorRegistryEntry } from './mesh/coordinator-registry.js';
export {
  MESH_REFINE_CONFIG_LOCATIONS,
  MESH_REFINE_CONFIG_SCHEMA,
  loadMeshRefineConfig,
  resolveMeshRefineValidationPlan,
  suggestMeshRefineConfig,
  validateMeshRefineConfig,
} from './mesh/refine-config.js';
export {
  MESH_WORKTREE_BOOTSTRAP_CONFIG_LOCATIONS,
  MESH_WORKTREE_BOOTSTRAP_CONFIG_SCHEMA,
  loadMeshWorktreeBootstrapConfig,
  runMeshWorktreeBootstrap,
  startMeshWorktreeBootstrap,
  getWorktreeBootstrapQueueDepth,
  validateMeshWorktreeBootstrapConfig,
  type RepoMeshWorktreeBootstrapConfig,
  type WorktreeBootstrapState,
} from './mesh/worktree-bootstrap-config.js';
export type {
  MeshRefineValidationCategory,
  MeshRefineValidationCommandPlan,
  MeshRefineValidationPlan,
  RepoMeshRefineConfig,
  RepoMeshRefineValidationCommandConfig,
} from './mesh/refine-config.js';
// Unified repo-settings loader: assembles the separate `.adhdev/*` config files
// (mesh.json coordinator/operatingNotes, refine, worktree-bootstrap, change-impact)
// into one object. Policy is machine-local and not part of repo settings.
export { loadRepoSettings } from './config/repo-settings.js';
export type { RepoSettings, LoadRepoSettingsOptions } from './config/repo-settings.js';

// ── Mesh records (C-W9a: the event ledger + JSONL retired; write = meshRecord, read = local records) ──
export { buildTaskCompletionEvidence, isIntentionalCleanupStopEntry, normalizeMeshWorkerResult, ledgerEntryTaskId, MAX_LEDGER_SLICE_LIMIT } from './mesh/mesh-ledger.js';
export { getLedgerDir } from './mesh/mesh-ledger-paths.js';
export {
  readLocalRecords,
  readLocalRecordsByKind,
  readLocalRecordSlice,
  getLocalRecordSummary,
  getSessionRecoveryContext,
  readTurnTerminalViews,
  __clearLocalRecordsForTests,
  type ReadLocalRecordOptions,
} from './mesh/mesh-local-records.js';
export { isMeshTestPollution, isSyntheticTestMeshId, isSyntheticTestCoordinatorSession } from './mesh/mesh-test-pollution.js';
export type { MeshLedgerEntry, MeshLedgerKind, MeshLedgerSlice, MeshLedgerSummary, ReadLedgerOptions, ReadLedgerSliceOptions, SessionRecoveryContext, MeshTaskCompletionEvidence, MeshWorkerResultArtifact, MeshProcessArtifact, MeshValidationResultArtifact } from './mesh/mesh-ledger.js';
export { recordSessionUsage, readSessionUsage, summarizeMeshUsage, getUsageDir, MAX_SESSIONS_PER_MESH, USAGE_MAX_AGE_MS } from './mesh/mesh-usage-store.js';
// WORKER-MCP: pure env-flag read, no daemon state — same category as
// isTaskReadonly/DEFAULT_QUOTA_ROUTING_POLICY above, which is why mcp-server
// (a separate process/package) is allowed to import it directly rather than
// going through a transport command. Used to gate `mesh_notify_worker`'s
// publication in ListTools so a flag-off mesh coordinator sees the exact
// pre-E-T0 tool count (design's "게이트 off ⇒ byte-identical" promise, §7.1).
export { isWorkerMcpEnabled } from './mesh/worker-mcp-isolation.js';
// Wiring-unification F1: the one seam that turns an authored task into a worker-delivered body.
export { resolveDispatchMessage, type DispatchableTask } from './mesh/worker-handoff-dispatch.js';
export type { MeshSessionUsage, MeshUsageSummary, EvictedUsageRollup } from './mesh/mesh-usage-store.js';
export { foldUsageRecords, sumSessionUsage, makeUsage, totalTokens, isEmptyUsage, readTokenCount } from './shared/usage-normalize.js';
export type { NativeUsage, NativeUsageRecord, NativeUsageMode, SessionUsageTotals } from './shared/usage-normalize.js';
export { applyBoundedRetention, setWithBoundedRetention } from './shared/bounded-retention.js';
export type { BoundedRetentionOptions, BoundedRetentionResult } from './shared/bounded-retention.js';
export { fastForwardMeshNode } from './mesh/mesh-fast-forward.js';
export type { MeshFastForwardNodeArgs, MeshFastForwardPlannedStep, MeshFastForwardResult } from './mesh/mesh-fast-forward.js';

// ── Mesh Work Queue (GUPP) ──
export { enqueueTask, enqueueTaskBatch, recordDirectDispatchTask, getQueue, claimNextTask, updateTaskStatus, __writeTaskStatusForTests, updateSessionTaskStatus, cancelTask, requeueTask, getMeshQueueStats, getMeshQueueRevision, getActiveDirectDispatches, terminalizeSiblingDispatch, cancelDirectDispatchAttempts, recordMeshToolCall, assertNoDependencyCycle, hasPendingDependents, MESH_TASK_PRIORITIES } from './mesh/mesh-work-queue.js';
// C-W9a: the PURE queue helpers are exported from their leaf modules, so the
// mcp-server can use them without value-importing the DB-backed queue module
// (check:boundaries C8 forbids mesh-work-queue / mesh-ledger there).
export { summarizeQueueEntryInputForView, isTaskReadonly, describeTaskDependencyState, taskDependenciesSatisfied, MESH_TASK_BATCH_MAX_TASKS, normalizeMeshTaskPriority, meshTaskPriorityRank, resolveNotBefore, meshTaskNotBeforeReady, NOT_BEFORE_RELATIVE_THRESHOLD_MS } from './mesh/mesh-task-predicates.js';
export type { MeshTaskInputSummary } from './mesh/mesh-task-predicates.js';
export { normalizeMeshTaskMode, validateMeshTaskModeRequest, buildMeshTaskModeViolationError, formatMeshTaskModeViolations } from './mesh/mesh-task-mode-guardrail.js';
export { buildMeshNodeCapabilityTags, nodeSatisfiesRequiredTags, normalizeMeshCapabilityTags, providerPinsFromRequiredTags, filterProvidersByRequiredTags } from './mesh/mesh-node-capability-tags.js';
export { parkTaskTargetPin, failRetentionExpiredParkedTask, getParkedTasks } from './mesh/mesh-work-queue.js';
export type { MeshWorkQueueEntry, MeshTaskStatus, MeshTaskMode, MeshTaskPriority, MeshWorkQueueStats, MeshQueueMutationOptions, MeshEnqueueTaskOptions, MeshTaskBatchEntrySpec, MeshTaskModeValidationResult, MeshTaskModeViolationDetail, DirectDispatchRecord, MeshToolCallRateResult, MeshTaskParking } from './mesh/mesh-work-queue.js';
// PIN-PARKING: a stale target pin PARKS the task (held, still addressed, claimable by
// nobody) instead of silently re-homing a context-bound delta onto another session.
// The coordinator-facing exits are mesh_view_queue (parkedTasks), mesh_queue_requeue
// (re-target / rewrite / unpark) and mesh_queue_cancel. See mesh-task-parking.ts.
export { taskIsParked, parkedAgeMs, parkedTaskRetentionExpired, notifyCoordinatorOfParkedTaskDropped, PARKED_TASK_RETENTION_MS, PARKED_SKIP_REASON, PARK_REASON_PIN_EXPIRED, PARK_RETENTION_EXPIRED_REASON } from './mesh/mesh-task-parking.js';
export {
    MESH_ON_DEPENDENCY_FAILURE_PUBLIC_TEXT,
    resolveOnDependencyFailurePolicy,
    deriveDependencyFailures,
} from './mesh/mesh-dependency-failure.js';
export type { MeshDependencyFailure, MeshOnDependencyFailure } from './mesh/mesh-dependency-failure.js';
// Shared node-health resolver + launch gate (single source of truth for the auto-launch
// gate and the other launch-readiness readers — they must agree on what "launchable health" means).
export { deriveMeshNodeHealthFromGit, resolveEffectiveMeshNodeHealth, isMeshNodeHealthLaunchable, isMeshNodeFreshEnoughToLaunch } from './mesh/mesh-node-identity.js';
export { applyInlineMeshBranchConvergence } from './mesh/mesh-branch-convergence.js';
// GIT-GATE (owner-requested follow-up to H1, wiring-unification): the SAME dirty/stale
// predicates the auto-launch spawn gate applies (mesh-queue-autolaunch.ts), re-exported so
// mcp-server's mesh_send_task direct-dispatch tool can apply the identical checks before a
// non-readonly direct dispatch to a node — the two paths (claim-time, in
// mesh-queue-assignment.ts, and direct-dispatch, in mcp-server) must never drift onto
// separately-reimplemented logic.
export { isDirtyNode, resolveAutoFastForwardPolicy } from './mesh/mesh-auto-fast-forward.js';
export { buildCompactStaleDirectWorkSummary, buildMeshActiveWork, buildMeshActiveWorkSummary, collectPendingApprovals, classifyStaleDirectForPrune, pruneStaleDirectDispatches, PRUNABLE_ORPHAN_STALE_REASONS } from './mesh/mesh-active-work.js';
export type { StaleDirectPruneClassification, StaleDirectPruneResult, PruneStaleDirectDispatchesOptions } from './mesh/mesh-active-work.js';
export type { MeshActiveWorkRecord, MeshActiveWorkStatus, MeshActiveWorkSummary, MeshActiveWorkSource, MeshStaleDirectWorkSummary, MeshPendingApproval } from './mesh/mesh-active-work.js';
export { maybeInjectIdleActiveMissionReminder, shouldFireIdleReminder, buildIdleReminderMessage, missionSetHash, IDLE_REMINDER_DEBOUNCE_MS } from './mesh/mesh-idle-reminder.js';
export { buildMeshAsyncRefineJobs, summarizeMeshAsyncRefineJobs, STALE_TERMINAL_REFINE_WINDOW_MS, RECENT_TERMINAL_REFINE_CAP } from './mesh/mesh-refine-status.js';
export type { MeshAsyncRefineJobStatus, MeshAsyncRefineJobSummary, MeshAsyncRefineJobsSummary } from './mesh/mesh-refine-status.js';

// ── Mesh Scheduling Runtime (observability projection) ──
export { buildMeshSchedulingRuntime } from './mesh/mesh-scheduling-runtime.js';
export type { MeshSchedulingRuntime, MeshNodeSchedulingRuntime, MeshNodeProviderSchedulingRuntime } from './mesh/mesh-scheduling-runtime.js';

// ── Mesh Quota Routing (observability: last ranking decision per node) ──
export { getLastQuotaRanking } from './mesh/mesh-quota-ranking-records.js';
export type { LastQuotaRankingRecord, ProviderQuotaRiskSnapshot } from './mesh/mesh-quota-ranking-records.js';
// The GATE itself, for the MANUAL launch path (mcp-server mesh_launch_session).
// The auto-launch/queue-drain path calls these in-process; the MCP coordinator
// runs in a SEPARATE process and reaches them only through this barrel, so a
// missing export here is what let the manual path launch onto an exhausted
// provider (the kimi 403). Both dispatch paths must consume the same judgement
// module — see mesh-quota-routing.ts's fail-open contract, which the manual
// path inherits verbatim.
export { evaluateProviderQuotaGate, rankProvidersByQuotaGate } from './mesh/mesh-quota-routing.js';
export { quotaRiskSnapshotForCandidates } from './mesh/mesh-quota-ranking-records.js';
export type { ProviderQuotaGateBlock, ProviderQuotaGateRanking } from './mesh/mesh-quota-routing.js';

// ── Mesh Route Preview (read-only hypothetical routing) ──
export { buildMeshRoutePreview, buildNodeRoutePreview } from './mesh/mesh-route-preview.js';
export type { MeshRoutePreviewQuery, NodeRoutePreview } from './mesh/mesh-route-preview.js';

// ── Mesh Host Ownership ──
export { buildMeshHostRequiredFailure, createDefaultMeshHostMetadata, normalizeMeshDaemonRole, requireMeshHostQueueOwner, resolveMeshHostStatus } from './mesh/mesh-host-ownership.js';

// ── Mesh Visualization ──
// buildMeshGraph and MeshGraph types moved to @adhdev/web-core to avoid
// bundling Node.js built-ins (fs, path, etc.) into browser builds.
// Import from '@adhdev/web-core' instead.
// export { buildMeshGraph } from './mesh/mesh-visualization.js';
// export type { MeshGraph, MeshGraphNode, MeshGraphEdge, MeshGraphNodeType, MeshGraphEdgeType } from './mesh/mesh-visualization.js';

// ── Mesh Events ──
// Wiring-unification C-W3: the pending-events queue and its drains are gone —
// coordinator notices are `turn.notify` entries delivered by the turn.deliver
// cursor; an MCP-only coordinator reads them over IPC (`get_pending_mesh_events`).
export { triggerMeshQueue, notifyMeshCoordinator } from './mesh/mesh-events.js';
export type { PendingMeshCoordinatorEvent } from './mesh/mesh-events.js';
export {
  createCoordinatorNotifier,
  createTurnIngestHandler,
  createTurnDeliverHandler,
  createDeliverEdgeWaiter,
  createTurnDeliverCounters,
  renderNotice,
  readCoordinatorNotices,
  deliverNoticeBacklog,
  listControlNotices,
  retractCoordinatorNotices,
  retractDispatchBlockedNotices,
  bindMeshNoticeRuntime,
  meshNoticeRuntime,
  defaultNoticeEventId,
  NOTICE_DEDUPE_BUCKET_MS,
  NOTICE_BACKLOG_WINDOW_MS,
  type CoordinatorNotice,
  type CoordinatorNotifier,
  type ControlNotice,
  type DeliverCursorEntry,
  type DeliverEdgeWaiter,
  type DeliverResult,
  type MeshNoticeRuntime,
  type PendingCoordinatorNoticeWire,
  type TurnDeliverCounters,
  type TurnDeliverDeps,
} from './mesh/turn-ledger/deliver.js';
export { routeNotice, type CoordinatorSessionView, type NoticeRoute } from './mesh/turn-ledger/routing.js';
export { evaluateNotifySuppression, type NotifySuppression } from './mesh/turn-ledger/suppression.js';
export {
  MeshTopicIndex,
  MESH_INDEX_CONSUMER,
  parseMeshIndexEntry,
  readOwnTaskLifecycle,
  readFleetTaskActivity,
  hasDispatchAfterTerminal,
  meshTopicIndexFor,
  type MeshIndexView,
  type MeshIndexQuery,
  type MeshIndexWriterFilter,
} from './mesh/mesh-topic-index.js';
// CANCEL-ORPHANS-PINNED-TASK: stopping a worker session strands pending queue tasks pinned to
// it. Exported for the mcp-server cancel tool, which is where the coordinator KNOWS which
// session it just killed (the queue lives in the coordinator daemon's store, so this cannot be
// detected on the worker side). See mesh-orphaned-pin-notify.ts.
export { findTasksOrphanedBySessionStop, notifyCoordinatorOfOrphanedPins, buildOrphanedPinNotice } from './mesh/mesh-orphaned-pin-notify.js';
export type { OrphanedPinnedTask } from './mesh/mesh-orphaned-pin-notify.js';
export { resolveSessionTurnPresentation, resolveTurnAttemptRow, presentationFromAttemptRow, turnStageToSurfaceStatus, isRestartBlockingPresentation, getTurnPresentationMetrics } from './mesh/mesh-turn-presentation.js';
export type { SessionTurnPresentation, TurnPresentationAuthority, TurnPresentationSurface, TurnAuthorityLookup, ResolveTurnPresentationArgs, TurnPresentationMetrics } from './mesh/mesh-turn-presentation.js';
// COORD-EVENT-MISROUTE: coordinator-identity helper so the mcp-server drain path can build a
// session-scoped drainer identity (identityDeliversTo sibling-session filter) with the same
// canonical builder daemon-core uses internally, instead of hand-rolling the identity shape.
export { coordinatorIdentityFromEmitFields } from './mesh/contracts.js';
export type { CoordinatorIdentity } from './mesh/contracts.js';
// The coordinator-side preview surfaced from a worker's completion/status event
// (finalSummary / workerResult.summary / lastMessagePreview). Same data the mobile
// inbox is fed; reused by mesh_read_chat's cache fallback when the live P2P read path
// is unavailable (saturated/unreachable peer).
export { resolveMeshSurfacedSessionPreview, readMeshCompletionSummary, isWeakCompletionEvidence } from './mesh/mesh-events-utils.js';

// ── Mesh Delivery Policy ──
export { resolveDeliveryDecision, normalizeDeliveryMode, DEFAULT_DELIVERY_MODE } from './mesh/mesh-delivery-policy.js';
export type { MeshDeliveryMode } from './mesh/mesh-delivery-policy.js';
export { resolveInterruptCapability, CTRL_C, ESC, STOP_CONTROL_ID } from './providers/spec/interrupt-capability.js';
export type { InterruptCapability, InterruptUnsupportedReason } from './providers/spec/interrupt-capability.js';
export type { MeshSessionDeliveryStatus, MeshSessionDeliveryKind, MeshDeliveryDecision, MeshDeliveryPolicyResult } from './mesh/mesh-delivery-policy.js';

// ── Mesh P2P Relay Failure Classification ──
export {
  P2pRelayFailureError,
  buildP2pRelayFailurePayload,
  classifyP2pRelayFailure,
  isP2pRelayTransportFailure,
} from './mesh/p2p-relay-failure.js';
export type {
  P2pRelayFailureClassification,
  P2pRelayFailureCode,
  P2pRelayFailureContext,
  P2pRelayFailurePayload,
} from './mesh/p2p-relay-failure.js';

// ── Mesh Duplicate-Dispatch Refusal (DUP-CLAIM-REBIND) ──
export {
  DuplicateMeshDispatchError,
  DUPLICATE_MESH_DISPATCH_CODE,
  encodeDuplicateMeshDispatchCode,
  classifyDuplicateMeshDispatch,
} from './mesh/mesh-duplicate-dispatch.js';
export type { DuplicateMeshDispatchInfo } from './mesh/mesh-duplicate-dispatch.js';

// ── Mesh Session-Busy Refusal (preview rc.37 stamp overwrite) ──
export {
  SessionBusyWithTaskError,
  SESSION_BUSY_WITH_TASK_CODE,
  formatSessionBusyWithTaskToken,
  classifySessionBusyWithTask,
} from './mesh/mesh-session-busy-dispatch.js';
export type { SessionBusyWithTaskInfo } from './mesh/mesh-session-busy-dispatch.js';
