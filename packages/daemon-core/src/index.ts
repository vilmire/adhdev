/**
 * @adhdev/daemon-core — Public API
 *
 * Core logic for daemon: CDP, Provider, IDE detection, CLI/ACP adapters and more.
 */

// ── Types ──
export type {
  ChatBubbleState,
  ChatMessage,
  ExtensionInfo,
  CommandResult as CoreCommandResult,
  ProviderConfig,
  DaemonEvent,
  StatusResponse,
  SystemInfo,
  DetectedIde,
  ProviderInfo,
  AgentEntry,
} from './types.js';

// ── Shared Types (cross-package) ──
export type {
  SessionEntry,
  CompactSessionEntry,
  CompactDaemonEntry,
  CloudDaemonSummaryEntry,
  DashboardBootstrapDaemonEntry,
  VersionUpdateReason,
  CloudStatusReportPayload,
  RoutingSessionEntry,
  P2PStatusSummary,
  SeqscribeStatusSummary,
  BeaconDiagnosticsSummary,
  FleetStatusPeerEntry,
  FleetStatusPeerViewDiagnostics,
  FleetStatusPeerView,
  DaemonStatusEventPayload,
  DashboardStatusEventPayload,
  SessionTransport,
  SessionKind,
  SessionCapability,
  AgentSessionStream,
  ReadChatCursor,
  ReadChatSyncResult,
  TransportTopic,
  SessionChatTailSubscriptionParams,
  SessionRuntimeOutputSubscriptionParams,
  MachineRuntimeSubscriptionParams,
  SessionHostDiagnosticsSubscriptionParams,
  SessionModalSubscriptionParams,
  DaemonMetadataSubscriptionParams,
  WorkspaceGitSubscriptionParams,
  SessionChatTailUpdate,
  MachineRuntimeUpdate,
  SessionHostDiagnosticsUpdate,
  SessionModalUpdate,
  DaemonMetadataUpdate,
  TopicUpdateEnvelope,
  SubscribeRequest,
  UnsubscribeRequest,
  StandaloneWsStatusPayload,
  AvailableProviderInfo,
  AcpConfigOption,
  AcpMode,
  ProviderControlSchema,
  StatusReportPayload,
  MachineInfo,
  SessionHostDiagnosticsSnapshot,
  SessionHostRecord,
  SessionHostWriteOwner,
  SessionHostAttachedClient,
  SessionHostLogEntry,
  SessionHostRequestTrace,
  SessionHostRuntimeTransition,
  DetectedIdeInfo,
  WorkspaceEntry,
  ProviderSummaryItem,
  ProviderSummaryMetadata,
  ProviderState,
  ProviderStatus,
  ProviderErrorReason,
  SessionActiveChatData,
  ActiveChatData,
  IdeProviderState,
  CliProviderState,
  AcpProviderState,
  ExtensionProviderState,
  MessageInputSupport,
  InputMediaStrategyDescriptor,
  InputAttachmentStrategy,
  InputMediaType,
} from './shared-types.js';

export type {
  InteractivePrompt,
  InteractiveQuestion,
  InteractiveOption,
  InteractivePromptResponse,
  InteractiveAnswer,
} from './providers/types/interactive-prompt.js';
export {
  normalizeInteractivePrompt,
  normalizeInteractivePromptResponse,
  buildClaudeInteractiveToolResult,
  interactivePromptFromClaudeAskUserQuestion,
  detectClaudeAskUserQuestionPromptFromJson,
} from './providers/types/interactive-prompt.js';

// ── Repo Mesh Types (cross-package) ──
export type {
  RepoMesh,
  RepoMeshDaemonRole,
  RepoMeshHostMetadata,
  RepoMeshHostPairingMetadata,
  RepoMeshHostStatus,
  RepoMeshNode,
  RepoMeshNodeHealth,
  RepoMeshPolicy,
  RepoMeshQuotaRoutingPolicy,
  RepoMeshMagiSessionCleanupMode,
  RepoMeshNodePolicy,
  RepoMeshRelatedRepo,
  RepoMeshNodeCapabilities,
  DetectedCommand,
  ProjectContextSnapshot,
  ProjectContextSource,
  RepoMeshCoordinatorConfig,
  LocalMeshConfig,
  LocalMeshEntry,
  LocalMeshNodeEntry,
  RepoMeshStatus,
  RepoMeshNodeStatus,
  RepoMeshPeerConnectionStatus,
  RepoMeshPeerConnectionState,
  RepoMeshPeerConnectionTransport,
  RepoMeshSessionStatus,
  RepoMeshQueueTask,
  RepoMeshQueueTaskStatus,
  RepoMeshQueueSummary,
  RepoMeshQueueStatus,
  RepoMeshLedgerEntryStatus,
  RepoMeshLedgerSummaryStatus,
  RepoMeshLedgerStatus,
  MeshAsyncJobLifecycle,
  RepoMeshSchedulingStrategy,
  RepoMeshSchedulingStatus,
  RepoMeshNodeSchedulingStatus,
  RepoMeshNodeProviderSchedulingStatus,
} from './repo-mesh-types.js';
export {
  DEFAULT_MESH_POLICY,
  // The routing gate's staleness threshold (staleAfterMs default) is the SINGLE
  // source for every "is this quota reading too old to trust" surface — the
  // mcp-server mesh_status compact summary and daemonQuotas age/stale markers
  // import it from here rather than duplicating the value.
  DEFAULT_QUOTA_ROUTING_POLICY,
  resolveDelegatedWorkerAutoApprove,
  delegatedWorkerAutoApproveSettings,
  resolveDelegatedWorkerDangerousModeAllow,
  resolveAllowSendKeysDestructive,
  resolveMagiSessionCleanupMode,
  magiAutoLaunchedSessionCleanupDecision,
  MESH_SCHEDULING_STRATEGIES,
  DEFAULT_MESH_SCHEDULING_STRATEGY,
  normalizeMeshSchedulingStrategy,
  resolveNodeSchedulingPriority,
  resolveProviderMaxParallel,
  mergeAndNormalizePolicy,
  normalizeAutoFastForwardPolicy,
  resolveMaxParallelTasks,
  MESH_MAX_PARALLEL_TASKS_MIN,
  MESH_MAX_PARALLEL_TASKS_MAX,
  MESH_CONVERGE_REFINE_TAG,
  MESH_CONVERGE_FAST_FORWARD_TAG,
  resolveAutoConvergeCodeChange,
} from './repo-mesh-types.js';

// ── Repo-shared declarative mesh config (.adhdev/mesh.json) ──
export {
  loadRepoMeshJsonConfig,
  normalizeRepoMeshDeclarativeConfig,
  buildMeshJsonConfigScaffold,
  serializeMeshJsonConfigScaffold,
  MESH_JSON_CONFIG_LOCATIONS,
  MESH_JSON_CONFIG_SCHEMA,
  MESH_JSON_PROVIDER_DEFAULTS_EXAMPLE,
} from './config/mesh-json-config.js';
export type {
  RepoMeshDeclarativeConfig,
  RepoMeshDeclarativeCoordinatorConfig,
  RepoMeshDeclarativeLimits,
  RepoMeshDeclarativeProviderDefaults,
  RepoMeshJsonConfigLoadResult,
} from './config/mesh-json-config.js';

// ── Git Surface ──
export * from './git/index.js';

// These types live in shared-types-extra.ts — imported directly because
// rollup-dts cannot resolve re-exports from shared-types.ts for them.
import type { RuntimeWriteOwner as _RuntimeWriteOwner } from './shared-types-extra.js';
import type { RuntimeAttachedClient as _RuntimeAttachedClient } from './shared-types-extra.js';
import type { RecentLaunchEntry as _RecentLaunchEntry } from './shared-types.js';
import type { TerminalBackendStatus as _TerminalBackendStatus } from './shared-types-extra.js';
export type RuntimeWriteOwner = _RuntimeWriteOwner;
export type RuntimeAttachedClient = _RuntimeAttachedClient;
export type RecentLaunchEntry = _RecentLaunchEntry;
export type TerminalBackendStatus = _TerminalBackendStatus;
export type { SessionHostEndpoint } from '@adhdev/session-host-core';

// Type aliases — rollup-dts cannot bundle re-exported type aliases at all.
// Canonical definition is @adhdev/mesh-shared session-status.ts (SESSION_STATUSES /
// RECENT_SESSION_BUCKETS); test/session-status-type-fork.test.ts pins these hand
// copies to it member-for-member.
export type SessionStatus = 'idle' | 'generating' | 'waiting_approval' | 'waiting_choice' | 'finalizing' | 'error' | 'stopped' | 'starting' | 'panel_hidden' | 'not_monitored' | 'disconnected';
export type RecentSessionBucket = 'needs_attention' | 'working' | 'task_complete' | 'idle';

// Wiring-unification A4: the one ProviderCategory (web-core imports it type-only).
export type { ProviderCategory, LaunchableProviderCategory } from './providers/contracts.js';

// ── Core Interface ──
export type { IDaemonCore, DaemonCoreOptions } from './daemon-core.js';

// ── Config ──
export { loadConfig, saveConfig, resetConfig, clearAuthCredentials, isSetupComplete, markSetupComplete, updateConfig, setQuotaShowAccountEmail, getConfigDir, getDaemonDataDir } from './config/config.js';
export { applyDaemonEnvOverrides, isSecretLikeEnvKey } from './config/env-overrides.js';
export type { EnvOverrideApplyResult } from './config/env-overrides.js';
export { isCrossTrackConfigDirOverride, otherTrackConfigDir } from './config/config-dir.js';
export {
  classifyVolatilePath,
  extractScriptPathFromCommand,
  inspectEmbeddedPath,
  type EmbeddedPathHealth,
  type EmbeddedPathState,
} from './config/embedded-path-health.js';
export {
  getProcessInstanceContext,
  InstanceContextConflictError,
  resetProcessInstanceContextForTests,
  resolveInstanceContext,
} from './config/instance-context.js';
export type { InstanceContext, ResolveInstanceContextOptions } from './config/instance-context.js';
export { getWorkspaceState } from './config/workspaces.js';
export { appendRecentActivity, getRecentActivity } from './config/recent-activity.js';
export type { RecentActivityEntry } from './config/recent-activity.js';
export { getSavedProviderSessions, upsertSavedProviderSession } from './config/saved-sessions.js';
export type { SavedProviderSessionEntry } from './config/saved-sessions.js';

// ── Mesh Config ──
export {
  listMeshes, listMeshesReadOnly, getMesh, getMeshByRepo, createMesh, updateMesh, deleteMesh,
  addNode, removeNode, updateNode, normalizeRepoIdentity,
  listMagiKindPanels, listMagiKindPanelsReadOnly, getMagiKindPanel, setMagiKindPanel, removeMagiKindPanel, normalizeMagiSlots, collectIgnoredMagiSlotFields, resolveScopedMeshId,
} from './config/mesh-config.js';
export type { CreateMeshOptions, UpdateMeshOptions, AddNodeOptions } from './config/mesh-config.js';
// MAGI panel / common-output / synthesis types (re-exported from the mesh-shared
// leaf so the mcp-server — which depends only on @adhdev/daemon-core — can consume
// them without taking a direct @adhdev/mesh-shared dependency).
export type {
  MagiMode, MagiTaskKind,
  MagiSlot, MagiKindPanelMap,
  MagiClaim, MagiClaimStance, MagiAgentResponse,
  MagiResponseSource, MagiReplicaGitRef, MagiGitSkew, MagiSynthesizedResponse,
  MagiClusterCategory, MagiClusterMember, MagiClaimCluster, MagiSynthesis,
} from '@adhdev/mesh-shared';
// Value re-export: per-replica raw-answer truncation cap (used by the mcp-server
// collection path, which depends only on @adhdev/daemon-core).
export { MAGI_RAW_ANSWER_CAP } from '@adhdev/mesh-shared';

// ── Mesh shared daemon-id / node-id helpers (re-export so external tooling —
//    e.g. the mcp-server, which depends only on @adhdev/daemon-core — can
//    canonicalize daemon-id and node-id forms without taking a direct
//    @adhdev/mesh-shared dependency). ──
export { expandDaemonIdForms, daemonIdsEquivalent, machineCoreFromDaemonId, canonicalDaemonId } from '@adhdev/mesh-shared';
export { normalizeMeshNodeId, meshNodeIdMatches } from '@adhdev/mesh-shared';
// Canonical mesh tool-name registry (SSOT for the schema ↔ prompt ↔ barrel-comment
// consistency the 6-6 test enforces). Re-exported so mcp-server (which depends on
// daemon-core, not on mesh-shared directly) and the daemon-core prompt test both
// reference one list.
export { CANONICAL_MESH_TOOL_NAMES, CANONICAL_MESH_TOOL_COUNT } from '@adhdev/mesh-shared';
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
export { enqueueTask, enqueueTaskGraph, recordDirectDispatchTask, getQueue, claimNextTask, updateTaskStatus, __writeTaskStatusForTests, updateSessionTaskStatus, cancelTask, requeueTask, getMeshQueueStats, getMeshQueueRevision, getActiveDirectDispatches, terminalizeSiblingDispatch, cancelDirectDispatchAttempts, recordMeshToolCall, assertNoDependencyCycle, hasPendingDependents, MESH_TASK_PRIORITIES } from './mesh/mesh-work-queue.js';
// C-W9a: the PURE queue helpers are exported from their leaf modules, so the
// mcp-server can use them without value-importing the DB-backed queue module
// (check:boundaries C8 forbids mesh-work-queue / mesh-ledger / mesh-graph-provenance there).
export { summarizeQueueEntryInputForView, isTaskReadonly, describeTaskDependencyState, taskDependenciesSatisfied, MESH_TASK_GRAPH_MAX_TASKS, normalizeMeshTaskPriority, meshTaskPriorityRank, resolveNotBefore, meshTaskNotBeforeReady, NOT_BEFORE_RELATIVE_THRESHOLD_MS } from './mesh/mesh-task-predicates.js';
export type { MeshTaskInputSummary } from './mesh/mesh-task-predicates.js';
export { normalizeMeshTaskMode, validateMeshTaskModeRequest, buildMeshTaskModeViolationError, formatMeshTaskModeViolations } from './mesh/mesh-task-mode-guardrail.js';
export { buildMeshNodeCapabilityTags, nodeSatisfiesRequiredTags, normalizeMeshCapabilityTags, resolveConvergeRequiredTags, providerPinsFromRequiredTags, filterProvidersByRequiredTags } from './mesh/mesh-node-capability-tags.js';
export { parkTaskTargetPin, failRetentionExpiredParkedTask, getParkedTasks } from './mesh/mesh-work-queue.js';
export type { MeshWorkQueueEntry, MeshTaskStatus, MeshTaskMode, MeshTaskPriority, MeshWorkQueueStats, MeshQueueMutationOptions, MeshEnqueueTaskOptions, MeshTaskGraphEntrySpec, MeshTaskModeValidationResult, MeshTaskModeViolationDetail, DirectDispatchRecord, MeshToolCallRateResult, MeshTaskParking } from './mesh/mesh-work-queue.js';
// PIN-PARKING: a stale target pin PARKS the task (held, still addressed, claimable by
// nobody) instead of silently re-homing a context-bound delta onto another session.
// The coordinator-facing exits are mesh_view_queue (parkedTasks), mesh_queue_requeue
// (re-target / rewrite / unpark) and mesh_queue_cancel. See mesh-task-parking.ts.
export { taskIsParked, parkedAgeMs, parkedTaskRetentionExpired, buildParkedTaskNotice, notifyCoordinatorOfParkedTaskDropped, PARKED_TASK_RETENTION_MS, PARKED_SKIP_REASON, PARK_REASON_PIN_EXPIRED, PARK_RETENTION_EXPIRED_REASON } from './mesh/mesh-task-parking.js';
export {
    MESH_ON_DEPENDENCY_FAILURE_PUBLIC_TEXT,
    parseOnDependencyFailurePolicy,
    resolveOnDependencyFailurePolicy,
    projectGraphPublicPolicy,
    deriveDependencyFailures,
    MeshGraphPolicyError,
} from './mesh/mesh-graph-derived-failure.js';
export type { MeshDependencyFailure, MeshGraphPolicy, MeshGraphPublicPolicyView } from './mesh/mesh-graph-derived-failure.js';
export {
    declareWorkspaceIntents,
    setWorkspaceBaseRevision,
    runWorkspaceSagaTick,
    recoverExpiredWorkspaceSagas,
    compensateWorkspaceIntent,
} from './mesh/mesh-graph-workspace-saga.js';
export {
    classifyWorkspaceCompensationSafety,
    WORKSPACE_DELETE_REFUSALS,
} from './mesh/mesh-graph-workspace-safety.js';
export {
    deriveWorkspaceBranchIdentity,
    deriveWorkspaceOwnerTag,
    WORKSPACE_OWNER_GIT_CONFIG_KEY,
    WORKSPACE_SAGA_LEASE_MS,
} from './mesh/mesh-graph-workspace-identity.js';
export { WorkspaceSagaPermanentError } from './mesh/mesh-graph-workspace-ports.js';
// ── GRAPH-ORCHESTRATION Phase E: the coordinator-facing surface ──
// C2 built claim/release/sweep but deliberately left MCP exposure to E; these are
// the exports the mesh_graph_gate_claim / mesh_graph_gate_release tools call.
export {
    claimMeshGraphGate,
    releaseMeshGraphGate,
    abandonMeshGraphGate,
    sweepMeshGraphGateTimeouts,
    coordinatorGateBlockReason,
    coordinatorGateAbandonedReason,
    MESH_GATE_DEFAULT_LEASE_SECONDS,
    MESH_GATE_NAMED_OUTCOMES,
    MESH_GATE_RELEASE_PATCH_KEYS,
} from './mesh/mesh-graph-gates.js';
// The coordinator node-patch + retry surface: the recovery path
// `blockWithMaterializationError` has always promised for a node blocked on a
// `materialization_error:*`. Exported so mesh_graph_node_patch can reach it —
// before this, the only patch surface demanded a claimed gate.
export { patchGraphNodeAndRetry, MESH_NODE_PATCH_KEYS } from './mesh/mesh-graph-transition-runner.js';
export type {
    PatchGraphNodeAndRetryInput,
    PatchGraphNodeAndRetryResult,
} from './mesh/mesh-graph-transition-runner.js';
// G4: read-only convergence evidence attached where a coordinator meets a gate
// (claim result; opt-in graph-view augmentation). Never releases anything.
export { collectGateConvergenceEvidence } from './mesh/mesh-graph-gate-evidence.js';
export type { GateConvergenceEvidence, GateCommitEvidence } from './mesh/mesh-graph-gate-evidence.js';
export type {
    MeshGraphGateClaimInput,
    MeshGraphGateClaimResult,
    MeshGraphGateReleaseInput,
    MeshGraphGateReleaseResult,
    MeshGraphGateReleasePatch,
    MeshGraphGateAbandonInput,
    MeshGraphGateAbandonResult,
    MeshGraphGateSweepResult,
} from './mesh/mesh-graph-gates.js';
export {
    commitMeshGraphPlan,
    computeMeshGraphPlanDigest,
    isAdvancedGraphTask,
    requestUsesGraphV2,
    MeshGraphPlanError,
} from './mesh/mesh-graph-plan.js';
export type {
    MeshGraphPlanRequest,
    MeshGraphPlanResult,
    MeshGraphGatePlanSpec,
    MeshGraphTaskPlanSpec,
} from './mesh/mesh-graph-plan.js';
export { buildMeshGraphViews } from './mesh/mesh-graph-view.js';
export type {
    MeshGraphView,
    MeshGraphNodeView,
    MeshGraphEdgeView,
    MeshEdgeConditionView,
    MeshEdgeConditionClause,
    MeshGraphGateView,
    MeshGraphWorkspaceView,
    BuildMeshGraphViewOptions,
} from './mesh/mesh-graph-view.js';
export {
    recordGraphEnqueueCommitted,
    recordGraphEnqueueValidationFailed,
    recordGraphEnqueueRolledBack,
    recordSingleEnqueueDecision,
    // GRAPH-MEASUREMENT-DIRECT — the direct dispatch surface's decision record.
    recordDirectDispatchDecision,
    recordGraphGateClaimed,
    recordGraphGateReleased,
    recordGraphGateAbandoned,
    recordGraphNodePatched,
    recordGraphGateExpired,
} from './mesh/mesh-graph-provenance.js';
// C-W9a: the pure decision vocabulary from its leaf (see the queue-helper note above).
export {
    normalizeOrchestrationDecision,
    MESH_DECLARED_ELIGIBLE_SINGLE_HINT,
    MESH_UNSANCTIONED_DIRECT_HINT,
    MESH_VALID_SINGLE_REASONS,
    MESH_SUPERSEDED_SINGLE_REASONS,
    MESH_DIRECT_REASONS,
    MESH_VALID_DIRECT_REASONS,
    MESH_UNSANCTIONED_DIRECT_REASONS,
} from './mesh/mesh-orchestration-decision.js';
export type { GraphEnqueueProvenance } from './mesh/mesh-graph-provenance.js';
export type {
    NormalizedOrchestrationDecision,
    OrchestrationDecisionNormalizeResult,
} from './mesh/mesh-orchestration-decision.js';
export type { MeshGraphGateRow, MeshTaskGraphNodeRow, MeshTaskGraphRow } from './mesh/mesh-graph-types.js';
export type { GraphWorkspaceDeclaration, WorkspaceSagaTickResult, WorkspaceSagaStepResult } from './mesh/mesh-graph-workspace-saga.js';
export type { WorkspaceDeleteRefusal, WorkspaceInspectReport, WorkspaceSafetySnapshot } from './mesh/mesh-graph-workspace-safety.js';
export type { WorkspaceSagaPorts } from './mesh/mesh-graph-workspace-ports.js';
// Shared node-health resolver + launch gate (single source of truth for the auto-launch
// gate AND the MAGI fan-out planner — they must agree on what "launchable health" means).
export { deriveMeshNodeHealthFromGit, resolveEffectiveMeshNodeHealth, isMeshNodeHealthLaunchable } from './mesh/mesh-node-identity.js';
export { buildCompactStaleDirectWorkSummary, buildMeshActiveWork, buildMeshActiveWorkSummary, collectPendingApprovals, classifyStaleDirectForPrune, pruneStaleDirectDispatches, PRUNABLE_ORPHAN_STALE_REASONS } from './mesh/mesh-active-work.js';
export type { StaleDirectPruneClassification, StaleDirectPruneResult, PruneStaleDirectDispatchesOptions } from './mesh/mesh-active-work.js';
export type { MeshActiveWorkRecord, MeshActiveWorkStatus, MeshActiveWorkSummary, MeshActiveWorkSource, MeshStaleDirectWorkSummary, MeshPendingApproval } from './mesh/mesh-active-work.js';
export { maybeInjectIdleActiveMissionReminder, shouldFireIdleReminder, buildIdleReminderMessage, missionSetHash, IDLE_REMINDER_DEBOUNCE_MS } from './mesh/mesh-idle-reminder.js';
export { buildMeshAsyncRefineJobs, summarizeMeshAsyncRefineJobs, STALE_TERMINAL_REFINE_WINDOW_MS, RECENT_TERMINAL_REFINE_CAP } from './mesh/mesh-refine-status.js';
export type { MeshAsyncRefineJobStatus, MeshAsyncRefineJobSummary, MeshAsyncRefineJobsSummary } from './mesh/mesh-refine-status.js';
export { buildMeshMagiActivity, summarizeMeshMagiActivity, getMeshMagiActivityByGroup, STALE_MAGI_WINDOW_MS, RECENT_MAGI_CAP, MAGI_NEEDS_VERIFICATION_PREVIEW_CAP } from './mesh/mesh-magi-status.js';
export type { MeshMagiActivityStatus, MeshMagiActivitySummary, MeshMagiActivitySummaryFold, MeshMagiNeedsVerificationItem } from './mesh/mesh-magi-status.js';

// ── Mesh Scheduling Runtime (observability projection) ──
export { buildMeshSchedulingRuntime } from './mesh/mesh-scheduling-runtime.js';
export type { MeshSchedulingRuntime, MeshNodeSchedulingRuntime, MeshNodeProviderSchedulingRuntime } from './mesh/mesh-scheduling-runtime.js';

// ── Mesh Quota Routing (observability: last ranking decision per node) ──
export { getLastQuotaRanking } from './mesh/mesh-quota-routing.js';
export type { LastQuotaRankingRecord, ProviderQuotaRiskSnapshot } from './mesh/mesh-quota-routing.js';
// The GATE itself, for the MANUAL launch path (mcp-server mesh_launch_session).
// The auto-launch/queue-drain path calls these in-process; the MCP coordinator
// runs in a SEPARATE process and reaches them only through this barrel, so a
// missing export here is what let the manual path launch onto an exhausted
// provider (the kimi 403). Both dispatch paths must consume the same judgement
// module — see mesh-quota-routing.ts's fail-open contract, which the manual
// path inherits verbatim.
export { evaluateProviderQuotaGate, rankProvidersByQuotaGate, quotaRiskSnapshotForCandidates } from './mesh/mesh-quota-routing.js';
export type { ProviderQuotaGateBlock, ProviderQuotaGateRanking } from './mesh/mesh-quota-routing.js';

// ── Mesh Route Preview (read-only hypothetical routing) ──
export { buildMeshRoutePreview, buildNodeRoutePreview } from './mesh/mesh-route-preview.js';
export type { MeshRoutePreviewQuery, NodeRoutePreview } from './mesh/mesh-route-preview.js';

// ── Mesh Host Ownership ──
export { buildMeshHostRequiredFailure, createDefaultMeshHostMetadata, isMeshHostOwner, normalizeMeshDaemonRole, requireMeshHostQueueOwner, resolveMeshHostStatus } from './mesh/mesh-host-ownership.js';

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
export { resolveSessionTurnPresentation, resolveTurnAttemptRow, presentationFromAttemptRow, turnStageToSurfaceStatus, isRestartBlockingPresentation, classifyShadowDivergence, getTurnPresentationMetrics } from './mesh/mesh-turn-presentation.js';
export type { SessionTurnPresentation, TurnPresentationAuthority, TurnPresentationSurface, TurnAuthorityLookup, ResolveTurnPresentationArgs, TurnPresentationMetrics, ShadowDivergenceReason } from './mesh/mesh-turn-presentation.js';
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

// ── State Store ──
export { loadState, saveState, resetState } from './config/state-store.js';
export type { DaemonState } from './config/state-store.js';

// ── Detection ──
export { detectIDEs } from './detection/ide-detector.js';
export type { IDEInfo } from './detection/ide-detector.js';
export { detectCLIs, detectCLI } from './detection/cli-detector.js';
export { getHostMemorySnapshot } from './system/host-memory.js';
export type { HostMemorySnapshot } from './system/host-memory.js';
export {
  classifyHotChatSessionsForSubscriptionFlush,
  detectNewlySettledCompletedSessions,
  DEFAULT_ACTIVE_CHAT_POLL_STATUSES,
  DEFAULT_CHAT_TAIL_RECENT_MESSAGE_GRACE_MS,
} from './status/chat-tail-hot-sessions.js';

// ── CDP ──
export { DaemonCdpManager } from './cdp/manager.js';
export { CdpDomHandlers } from './cdp/devtools.js';
export { setupIdeInstance, registerExtensionProviders, connectCdpManager, probeCdpPort } from './cdp/setup.js';
export type { CdpSetupContext, SetupIdeInstanceOptions } from './cdp/setup.js';
export { DaemonCdpInitializer } from './cdp/initializer.js';
export type { CdpInitializerConfig } from './cdp/initializer.js';

// ── Commands ──
export { DaemonCommandHandler } from './commands/handler.js';
export type { CommandResult, CommandContext } from './commands/handler.js';
export { DaemonCommandRouter, readCachedInlineMeshActiveSessionDetails, resolveMeshNodeAttribution, buildMeshNodeDataFreshness, buildMeshNodeProbeFreshness, MESH_NODE_LIVE_TRUTH_MARKER } from './commands/router.js';
export type { CommandRouterDeps, CommandRouterResult } from './commands/router.js';
export { CommandRegistry, COMMAND_PREFIX_DEFAULTS, defineCommandSpecs, isCommandSource, normalizeCommandSource } from './commands/command-registry.js';
export type { CommandInvalidationTopic, CommandSource, CommandSpec, CommandFamily, CommandSessionAttributes, PrefixDefault } from './commands/command-registry.js';
export { getDaemonCommandRegistry } from './commands/router.js';
export { InteractionContextMap } from './commands/interaction-context.js';
export { MESH_SENDER_DAEMON_ID_ARG, isMeshSenderRefusalResult, readMeshSender } from './commands/mesh-sender.js';
export type { MeshSenderClass, MeshSenderRefusal } from './commands/mesh-sender.js';

// ── Dashboard subscription topic engine (shared cloud/standalone) ──
export { TopicSubscriptionRegistry, DEFAULT_GIT_REFRESH_CONCURRENCY, DEFAULT_CHAT_TAIL_FLUSH_DEBOUNCE_MS } from './subscriptions/topic-registry.js';
export type {
    TopicSink,
    TopicEngineOptions,
    TopicEngineSources,
    ChatTailEngineOptions,
    ChatTailEngineState,
    DaemonMetadataUpdateBody,
} from './subscriptions/topic-registry.js';
export {
  maybeRunDaemonUpgradeHelperFromEnv,
  spawnDetachedDaemonUpgradeHelper,
  resolveCurrentGlobalInstallSurface,
  resolveInstanceDir,
  buildPinnedGlobalInstallCommand,
  execNpmCommandSync,
  resolveNpmPublishedVersion,
  getNpmExecOptions,
} from './commands/upgrade-helper.js';
export type {
  DaemonUpgradeHelperPayload,
  CurrentGlobalInstallSurface,
  PinnedGlobalInstallCommand,
  NpmExecOptions,
} from './commands/upgrade-helper.js';

// ── Status ──
export { DaemonStatusReporter, buildCloudStatusReportPayload, projectFleetStatusEntry } from './status/reporter.js';
export { buildSessionEntries, findCdpManager, hasCdpManager, isCdpConnected, isCoordinatorSpawnedHiddenWorker, resolveSurfaceHidden, resolveMuted, resolveSpawnedSessionHideMute } from './status/builders.js';
export { buildStatusSnapshot, buildMachineInfo, buildAvailableProviders, getLastDisplayMessage } from './status/snapshot.js';
export { getDaemonBuildInfo } from './build-info.js';
export type { DaemonBuildInfo } from './build-info.js';
export {
    TRACK,
    IDENTITY,
    BUILD_CHANNEL_ENV_VAR,
    getTrackIdentity,
    getInstallOrigin,
    resolveBuildTrack,
} from './track-identity.js';
export type { BuildTrack, TrackIdentity } from './track-identity.js';
export { normalizeManagedStatus, isManagedStatusWorking, isManagedStatusWaiting, normalizeActiveChatData } from './status/normalize.js';
export type { ManagedStatus } from './status/normalize.js';
export type { StatusSnapshotOptions, StatusSnapshot } from './status/snapshot.js';

// ── Logger ──
export {
    LOG,
    installGlobalInterceptor,
    setLogLevel,
    getLogLevel,
    getRecentLogs,
    getDaemonLogDir,
    getCurrentDaemonLogPath,
    setLogInstancePort,
    getLogInstanceTag,
    MAX_SIZE_ROTATION_GENERATIONS,
    rotateCaptureLogIfNeeded,
    openCaptureLogFd,
    DAEMON_CAPTURE_LOG_NAME,
    MAX_CAPTURE_LOG_SIZE,
    MAX_CAPTURE_LOG_GENERATIONS,
} from './logging/logger.js';
export type { ScopedLogger, LogLevel, LogEntry } from './logging/logger.js';

// ── Disk space preflight ──
export {
    checkDiskSpace,
    readDiskSpace,
    classifyDiskSpace,
    describeDiskSpace,
    logDiskSpaceStatus,
    preflightDiskSpace,
    formatBytes,
    LowDiskSpaceError,
    DISK_CRITICAL_PERCENT_FREE,
    DISK_CRITICAL_FREE_BYTES,
    DISK_WARNING_PERCENT_FREE,
    DISK_WARNING_FREE_BYTES,
} from './diagnostics/disk-space-preflight.js';
export type { DiskSpaceLevel, DiskSpaceStats, DiskSpaceStatus } from './diagnostics/disk-space-preflight.js';
export {
    SYM,
    consoleSymbols,
    resolveConsoleSymbols,
    supportsUnicodeSymbols,
    resetConsoleSymbolsCache,
} from './logging/console-symbols.js';
export type { ConsoleSymbols, UnicodeSupportProbe } from './logging/console-symbols.js';
export {
    resolveDebugRuntimeConfig,
    setDebugRuntimeConfig,
    getDebugRuntimeConfig,
    resetDebugRuntimeConfig,
    shouldCollectTraceCategory,
    isAlwaysOnTraceCategory,
    ALWAYS_ON_TRACE_CATEGORIES,
} from './logging/debug-config.js';
export type { DebugRuntimeOptions, DebugRuntimeConfig } from './logging/debug-config.js';
export {
    createDebugTraceStore,
    configureDebugTraceStore,
    recordDebugTrace,
    getRecentDebugTrace,
    clearDebugTrace,
    createInteractionId,
} from './logging/debug-trace.js';
export type { DebugTraceEvent, DebugTraceEntry, DebugTraceQuery, DebugTraceStore, DebugTraceLevel } from './logging/debug-trace.js';
export { logCommand, getRecentCommands } from './logging/command-log.js';

// ── CLI Management ──
export { DaemonCliManager } from './commands/cli-manager.js';

// ── Launch ──
export { launchWithCdp, getAvailableIdeIds, killIdeProcess, isIdeRunning } from './launch.js';

// ── IPC ──
export { DEFAULT_DAEMON_PORT, DAEMON_WS_PATH } from './ipc-protocol.js';
export {
  DEFAULT_CDP_SCAN_INTERVAL_MS,
  DEFAULT_CDP_DISCOVERY_INTERVAL_MS,
  DEFAULT_STATUS_INITIAL_REPORT_DELAY_MS,
  DEFAULT_STATUS_SERVER_REPORT_INTERVAL_MS,
  DEFAULT_STATUS_P2P_REPORT_INTERVAL_MS,
  MIN_MACHINE_RUNTIME_SUBSCRIPTION_INTERVAL_MS,
  DEFAULT_MACHINE_RUNTIME_SUBSCRIPTION_INTERVAL_MS,
  MIN_SESSION_HOST_DIAGNOSTICS_SUBSCRIPTION_INTERVAL_MS,
  DEFAULT_SESSION_HOST_DIAGNOSTICS_SUBSCRIPTION_INTERVAL_MS,
  DEFAULT_SESSION_HOST_READY_TIMEOUT_MS,
  STANDALONE_CDP_SCAN_INTERVAL_MS,
  DEFAULT_STANDALONE_PORT,
} from './runtime-defaults.js';

// ── Chat History ──
export { readChatHistory } from './config/chat-history.js';
export {
  hashSignatureParts,
  buildChatMessageSignature,
  buildChatTailDeliverySignature,
  buildSessionModalDeliverySignature,
} from './chat/chat-signatures.js';
export type {
  ChatMessageSignatureInput,
  ChatTailDeliverySignatureInput,
  SessionModalDeliverySignatureInput,
} from './chat/chat-signatures.js';
export {
  normalizeChatTailActiveModal,
  normalizeSessionModalFields,
  prepareSessionChatTailUpdate,
  prepareSessionModalUpdate,
} from './chat/subscription-updates.js';
export { runAsyncBatch } from './chat/async-batch.js';
export type { AsyncBatchOptions } from './chat/async-batch.js';
export {
    DEFAULT_CHAT_TAIL_MISSING_SESSION_POLICY,
    decideMissingSessionAttempt,
    isMissingLiveSessionResult,
    recordMissingSessionAttempt,
    resolveBackoffMs,
    shouldWarnForMissingSession,
} from './chat/chat-tail-missing-session-backoff.js';
export type {
    ChatTailMissingSessionDecision,
    ChatTailMissingSessionPolicy,
    ChatTailMissingSessionState,
} from './chat/chat-tail-missing-session-backoff.js';
export type {
  ChatTailSubscriptionCursor,
  PrepareSessionChatTailUpdateInput,
  PreparedSessionChatTailUpdate,
  PrepareSessionModalUpdateInput,
  PreparedSessionModalUpdate,
  SessionChatTailCommandResult,
} from './chat/subscription-updates.js';

// ── Agent Stream ──
export { DaemonAgentStreamManager } from './agent-stream/index.js';
export { AgentStreamPoller } from './agent-stream/index.js';
export type { AgentStreamPollerDeps } from './agent-stream/index.js';
export { forwardAgentStreamsToIdeInstance } from './agent-stream/forward.js';

// ── Providers ──
export { ProviderLoader } from './providers/provider-loader.js';
export {
  resolveProviderChannel,
  isPreviewReleaseChannel,
  partitionChannelEntries,
  ProviderChannelError,
  KNOWN_DIGEST_ALGORITHMS,
  LEGACY_UNVERIFIED_ALGORITHM,
  DEFAULT_PROVIDER_CHANNEL,
  PROVIDER_CHANNEL_ENV_VAR,
} from './providers/channel/contract.js';
export type {
  ProviderChannel,
  ChannelEntry,
  ActivatableEntry,
  SkippedEntry,
  ProviderChannelErrorCode,
} from './providers/channel/contract.js';
export { computeProviderTreeDigest, TREE_DIGEST_ALGORITHM } from './providers/channel/tree-digest.js';
export { ProviderChannelStore } from './providers/channel/store.js';
export type { ActivationRef, ActivationPointer, ActivateResult } from './providers/channel/store.js';
export { ProviderChannelRuntime, collectSyncTargetTypes } from './providers/channel/runtime.js';
export type { ChannelSyncReport, ChannelSyncError, ProviderChannelRuntimeOptions } from './providers/channel/runtime.js';
export { ProviderInstanceManager } from './providers/provider-instance-manager.js';
// Session lifecycle bus (wiring-unification B1)
export { createSessionLifecycleBus } from './sessions/lifecycle-bus.js';
export type { SessionLifecycleBus, Unsubscribe, SubscribeOptions, AsyncSubscribeOptions, BusStats, CreateSessionLifecycleBusOptions } from './sessions/lifecycle-bus.js';
export { BUS_EVENT_KINDS, assertNeverBusEvent } from './sessions/lifecycle-events.js';
export type { SessionLifecycleEvent, DaemonEvent as DaemonBusEvent, BusEvent, BusEventKind, EventOf, RegisterOrigin, StatusCause, TerminationCause, DaemonFactsCause, PromptTransport, EnrichedProviderEvent } from './sessions/lifecycle-events.js';
export { createSessionEventPort } from './sessions/session-port.js';
export type { SessionEventPort, SessionSignalDetail, CreateSessionEventPortOptions } from './sessions/session-port.js';
export { SessionRegistry } from './sessions/registry.js';
export type { SessionRuntimeTarget, TerminateDetail } from './sessions/registry.js';
export { IdeProviderInstance } from './providers/ide-provider-instance.js';
export { CliProviderInstance } from './providers/cli-provider-instance.js';
export { AcpProviderInstance } from './providers/acp-provider-instance.js';
export type { ProviderModule, AutoApproveMode, AutoApproveModesConfig, AutoApproveModeRisk, AutoApproveModeStrategy, CdpTargetFilter, ProviderResumeCapability, InputEnvelope, InputPart, MessagePart, ReadChatTurnStatus, ControlListResult, ControlSetResult, ControlInvokeResult } from './providers/contracts.js';
export type { ProviderSourceConfigSnapshot, ProviderSourceConfigUpdate } from './config/provider-source-config.js';
export { parseProviderSourceConfigUpdate } from './config/provider-source-config.js';
export { normalizeInputEnvelope, normalizeMessageParts, flattenMessageParts } from './providers/io-contracts.js';
export {
  BUILTIN_CHAT_MESSAGE_KINDS,
  isBuiltinChatMessageKind,
  normalizeChatMessageKind,
  resolveChatMessageKind,
  buildChatMessage,
  buildSystemChatMessage,
  buildRuntimeSystemChatMessage,
  buildAssistantChatMessage,
  buildThoughtChatMessage,
  buildToolChatMessage,
  buildTerminalChatMessage,
  buildUserChatMessage,
  normalizeChatMessage,
  normalizeChatMessages,
  CHAT_MESSAGE_VISIBILITIES,
  CHAT_MESSAGE_TRANSCRIPT_VISIBILITIES,
  CHAT_MESSAGE_AUDIENCES,
  CHAT_MESSAGE_SOURCES,
  CHAT_MESSAGE_ACTIVITY_SOURCES,
  CHAT_MESSAGE_INTERNAL_SOURCES,
  classifyChatMessageVisibility,
  hasTrailingToolActivityAfterFinalAssistant,
  extractFinalAssistantSummaryEvidence,
  isUserFacingChatMessage,
  isActivityChatMessage,
  isInternalChatMessage,
  filterUserFacingChatMessages,
  filterActivityChatMessages,
  filterInternalChatMessages,
  filterChatMessagesByVisibility,
} from './providers/chat-message-normalization.js';
export type { BuiltinChatMessageKind, ChatMessageKind, ChatMessageVisibility, ChatMessageTranscriptVisibility, ChatMessageAudience, ChatMessageSource, ChatMessageTranscriptSurface, ChatMessageVisibilityClassification } from './providers/chat-message-normalization.js';
export { VersionArchive, detectAllVersions } from './providers/version-archive.js';
export type { ProviderVersionInfo, VersionHistory } from './providers/version-archive.js';

// ── Dev Server ──
export { DevServer, DEV_SERVER_PORT } from './daemon/dev-server.js';

// ── CLI Adapters ──
export type { CliAdapter } from './cli-adapter-types.js';
export { NodePtyTransportFactory } from './cli-adapters/pty-transport.js';
export type { PtyRuntimeTransport, PtyTransportFactory, PtySpawnOptions } from './cli-adapters/pty-transport.js';
export { SessionHostPtyTransportFactory } from './cli-adapters/session-host-transport.js';
export {
  RawTerminalAttachment,
  namedKeyToAnsi,
  namedKeysToAnsi,
  withRawTerminalAttachment,
} from './cli-adapters/raw-terminal-io.js';
export type { NamedKey, RawTerminalAttachmentOptions, RawTerminalSessionHostClient } from './cli-adapters/raw-terminal-io.js';
export type { HostedCliRuntimeDescriptor, CliTransportFactoryParams } from './commands/cli-manager.js';
export {
  DEFAULT_SESSION_HOST_APP_NAME,
  DEFAULT_STANDALONE_SESSION_HOST_APP_NAME,
  resolveSessionHostAppName,
  resolveSessionHostAppNameResolution,
} from './session-host/app-name.js';
export type { SessionHostAppNameResolution } from './session-host/app-name.js';
export { ensureSessionHostReady, listHostedCliRuntimes } from './session-host/runtime-support.js';
export { createManagedSessionHost } from './session-host/managed-host.js';
export type { ManagedSessionHost, ManagedSessionHostOptions } from './session-host/managed-host.js';
export {
  getSessionHostRecoveryLabel,
  getSessionHostSurfaceKind,
  isSessionHostLiveRuntime,
  isSessionHostRecoverySnapshot,
  partitionSessionHostDiagnosticsSessions,
  partitionSessionHostRecords,
} from './session-host/runtime-surface.js';
export type { SessionHostSurfaceKind, SessionHostSurfaceRecordLike } from './session-host/runtime-surface.js';
export { shouldAutoRestoreHostedSessionsOnStartup } from './session-host/startup-restore-policy.js';

// ── Installer ──
export { getAIExtensions, installExtensions, launchIDE, isExtensionInstalled } from './installer.js';
export type { ExtensionInfo as InstallerExtensionInfo } from './installer.js';

// ── Boot / Lifecycle ── (staged boot: bootDaemonRuntime below; host surface: createDaemonHostRuntime)
export type { DaemonComponents } from './boot/daemon-components.js';

// ── Local IPC server (shared between cloud + standalone daemons) ──
export {
  startLocalIpcServer,
  buildIpcStatusHttpResponse,
  type LocalIpcServerOptions,
  type LocalIpcServerHandle,
  type IpcCommandContext,
  type IpcCommandResult,
  type IpcStatusPayload,
} from './ipc/local-ipc-server.js';
// IPC load guards (audit #12): per-connection in-flight cap + probe-verb token
// bucket, shared so daemon-cloud's own local IPC WS server enforces the SAME
// limits as this module's LocalIpcServer instead of a second hand-rolled copy.
export { IpcConnectionLoadGuard, type IpcGuardRejection } from './ipc/ipc-load-guards.js';
export {
    IPC_MAX_PAYLOAD_BYTES,
    IPC_MAX_INFLIGHT_PER_CONNECTION,
    IPC_BUSY_ERROR_CODE,
    IPC_PROBE_RATE_LIMIT_WINDOW_MS,
    IPC_PROBE_RATE_LIMIT_MAX_CALLS,
    IPC_RATE_LIMITED_ERROR_CODE,
    IPC_PROBE_RATE_LIMITED_COMMANDS,
} from './ipc-protocol.js';

// ── CLI Spec (adhdev:cli/spec@4) ──
export { createNativeHistoryDispatcher } from './providers/native-history/index.js';
export type { ReaderId } from './providers/native-history/index.js';
export {
    readClaudeCliSession, readCodexCliSession,
    readAntigravityCliSession, readHermesCliSession,
} from './providers/native-history/index.js';
export type {
    ControlAction, Control,
    NotificationRule, DelegateTrigger,
} from './providers/spec/types.js';
export type { TraceEntry } from './providers/spec/evaluator.js';
export { evaluateFsm } from './providers/spec/fsm-evaluator.js';
export type { FsmClock } from './providers/spec/fsm-evaluator.js';
export { validateFsmSpec, collectFsmSpecWarnings } from './providers/spec/fsm-loader.js';
export { FsmDriver } from './providers/spec/fsm-driver.js';
export type { DashboardEvent, DashboardCommand, SpecDriverOpts, ISpecDriver } from './providers/spec/fsm-driver.js';
export { TerminalAdapter } from './providers/spec/adapter.js';
export type { TerminalAdapterOpts, TerminalAdapterHandlers } from './providers/spec/adapter.js';

// ── Provider SDK (v1) — selective re-exports for external tooling ──
// Tooling (registry publish, dashboard validators, the e2e harness) needs
// the manifest validator, the builder catalog, and the contract version.
// We don't re-export *everything* from the SDK to keep the public surface
// stable; consumers that need internal SDK types still import from the
// sdk/v1 subpath.
export {
  validateCliProviderManifest,
  validateAcpProviderManifest,
  formatManifestValidationIssues,
  type ManifestValidationIssue,
  type ManifestValidationResult,
  V1_CONTRACT_VERSION,
  V1_PRIMITIVE_CATALOG,
  V1_ALL_PRIMITIVES,
} from './providers/sdk/v1/index.js';

// ── Provider quota ──
// Plan-consumption reporting per CLI provider. `claude-cli` additionally needs
// an opt-in setup step (it reports quota only to a statusline command), so the
// install/uninstall surface is exported alongside the fetchers for the CLI.
export {
  fetchKimiQuota,
  fetchCodexQuota,
  // The two Codex sources are exported individually as well: `fetchCodexQuota`
  // is local-first and only falls back to the app-server, so a caller that
  // needs one specific transport (diagnostics, tests) must be able to name it.
  fetchCodexQuotaFromRollout,
  fetchCodexQuotaFromAppServer,
  readLatestCodexRateLimits,
  codexSessionsDir,
  fetchClaudeQuota,
  fetchGrokQuota,
  fetchAntigravityQuota,
  installClaudeStatusline,
  uninstallClaudeStatusline,
  readStatuslineStatus,
  StatuslineInstallError,
  // ★Force refresh runs IN the daemon (it warms the shared cache); the CLI
  // reaches it over local IPC via the `refresh_provider_quota` command rather
  // than calling this in-process, where it would refresh a cache nothing reads.
  forceRefreshQuota,
  QUOTA_AXIS,
  QUOTA_AXIS_TTL_MS,
  type QuotaAxis,
  type QuotaForceRefreshEntry,
  type QuotaForceRefreshResult,
  type ProviderQuota,
  type QuotaProvider,
  type QuotaStatus,
  type QuotaFailureKind,
  type QuotaWindow,
  type QuotaMetadata,
  type StatuslineStatus,
  type StatuslineInstallPaths,
} from './quota/index.js';

// Shared CLI rendering for `adhdev quota` — used by both daemon-cloud
// (Commander) and daemon-standalone (hand-rolled arg parsing) so the
// terminal output stays identical without duplicating it per CLI host.
export {
  printQuota,
  printQuotaRefreshOutcome,
  printClaudeInstallResult,
  printClaudeUninstallResult,
  printClaudeStatuslineStatus,
  printQuotaInstallError,
} from './quota/cli.js';

// seqscribe integration (docs/design/2026-08-26-seqscribe-integration-plan.md).
// Phase 0 surface: node lifecycle, the topic table, the authority wiring and
// the status projection. Phase 1 adds the fleet-secret store (auth_ok delivery)
// and the assistant.journal producer/consumer API.
export {
  openSeqscribeNode,
  getSeqscribeDbPath,
  SEQSCRIBE_DB_NAME,
  SEQSCRIBE_DB_SUFFIX_ENV_VAR,
  WRITER_ID_PREFIX,
  type SeqscribeNodeHandle,
  type SeqscribeNodeOptions,
} from './seqscribe/node.js';
// Beacon vector transport (design §7.1 Stage D). Transport-agnostic: the cloud
// daemon injects the WS legs, standalone never arms it.
export {
  armBeacon,
  resolveBeaconMode,
  projectBeaconReport,
  assertNoPlaintextHintTopics,
  defaultBeaconTopicScope,
  BEACON_ENV,
  MAX_BEACON_GET_QUERIES,
  type BeaconMode,
  type BeaconCounters,
  type BeaconHostTransport,
  type BeaconGetResponse,
  type ProjectedBeaconReport,
  type ProjectedWriterEntry,
  type ArmBeaconOptions,
  type BeaconHandle,
} from './seqscribe/beacon.js';
// Beacon CONSUMER surface (mission b60d70b8) — staleness/sole-copy as data a
// dashboard and `get_status_metadata` can read. ★ LOCAL/P2P ONLY: these carry
// topic names and peer writer ids, so they must never be added to
// `buildCloudSeqscribeSummary` (status/reporter.ts) — see the file header.
export {
  computeBeaconDiagnostics,
  summarizeSoleCopy,
  readKeyStaleAdvisory,
  toBeaconDiagnosticsSummary,
  BEACON_BOARD_TTL_MS,
  type BeaconDiagnostics,
  type BeaconPeerDiagnostics,
  type BeaconPeerTopicLag,
  type BeaconSoleCopyCandidate,
  type BeaconBoardSnapshot,
  type BeaconKeyStaleAdvisory,
  type SoleCopyVerdict,
  type SoleCopyUnknownReason,
} from './seqscribe/beacon-diagnostics.js';
export {
  safeMeshId,
  safeSessionId,
  meshEventsTopic,
  meshEventsPolicy,
  sessionTranscriptTopic,
  sessionTranscriptPolicy,
  assistantJournalPolicy,
  fleetStatusPolicy,
  configSettingsPolicy,
  baseTopicDefinitions,
  contentTopicsFor,
  ASSISTANT_JOURNAL_TOPIC,
  FLEET_STATUS_TOPIC,
  CONFIG_SETTINGS_TOPIC,
  SESSION_TRANSCRIPT_RING,
  FLEET_STATUS_RING,
  type TopicDefinition,
} from './seqscribe/topics.js';
export {
  createFleetAuthority,
  createFleetAuthorityIfConfigured,
  resolveFleetSecret,
  startFleetFinalityLoop,
  ADHDEV_AUTHORITY_ID,
  FINALITY_INTERVAL_MS,
  type FleetAuthorityOptions,
} from './seqscribe/authority.js';
export {
  loadStoredFleetSecret,
  storeFleetSecret,
  FLEET_SECRET_FILE,
  type StoredFleetSecret,
} from './seqscribe/fleet-secret.js';
export { appendAssistantJournal, consumeAssistantJournal } from './seqscribe/journal.js';
export { summarizeSeqscribeStats } from './seqscribe/stats.js';
// Phase 2 Stage 1: the convergence probe that makes live replication
// observable (a producer + consumer pair existed nowhere before it).
export {
  startConvergenceProbe,
  PROBE_ENTRY_KIND,
  PROBE_CONSUMER,
  PROBE_INTERVAL_MS,
  type ProbeHandle,
  type ProbeOptions,
  type ProbePayload,
} from './seqscribe/probe.js';
// Wiring-unification C7-1: the mesh PUBLISHER — the one writer of
// `mesh.<id>.events` (turn entries awaited through bounded slots, never shed;
// `mesh.record` for non-turn records). Replaces the Phase 2 dual-write shadow:
// no ADHDEV_SEQSCRIBE_MESH mode flag, no parity backfill.
export {
  configureMeshPublisher,
  // Boot/runtime topic activation: without it a mesh CONSUMER never defines
  // the per-mesh events/handoff pair, so the pair never becomes mutual-full and
  // the writer's backlog never replicates. At boot a failure is fatal (C7-1).
  activateKnownMeshTopics,
  activateMeshTopicsAtBoot,
  MeshTopicActivationError,
  // seqscribe v3.5 P14/P15: the runtime topic-activation announcement the cloud
  // transport subscribes to so a mesh created after boot is granted on every
  // LIVE peer session (defineTopic here → updateGrants there).
  onTopicActivated,
  announceTopicActivated,
  publishMeshTopicEntry,
  publishMeshRecord,
  appendMeshHandoff,
  projectMeshRecord,
  projectTurnTopicEntry,
  summaryRefToEntryId,
  flushMeshPublisher,
  meshPublisherCounters,
  meshPublisherInflight,
  meshPublisherWriterId,
  isMeshPublisherArmed,
  __resetMeshPublisherForTests,
  MESH_PUBLISH_SLOTS,
  MESH_RECORD_MAX_WAITING,
  type MeshPublisherCounters,
  type MeshRecordEntry,
} from './seqscribe/mesh-publisher.js';
// C3: the write API for every non-turn mesh event (mesh.record + the C-W9a local leg).
export { meshRecord, meshRecordAppended, type MeshRecordScalars, type MeshRecordResult, type MeshRecordOptions } from './mesh/mesh-record.js';
// C1–C3 turn ledger (C-W2): store, one-way migration, observe() write path, wire projection.
export {
  createTurnLedger,
  isAttemptTerminal,
  type TurnLedger,
  type TurnLedgerDeps,
  type TurnPublisherPort,
  type ObserveOptions,
  type ObserveResult,
  type ObserveVerdict,
  type PublishReport,
  type MeshEventNotice,
  type TurnLedgerCounters,
} from './mesh/turn-ledger/ledger.js';
export { TurnStore, type TurnEventRow, type MeshOperatingNoteRow } from './mesh/turn-ledger/store.js';
export {
  migrateTurnLedgerV1,
  exportLegacyTurnTables,
  formatTurnLedgerMigrationLine,
  type TurnLedgerMigrationReport,
} from './mesh/turn-ledger/migrate-v1.js';
export { TURN_LEDGER_SCHEMA_VERSION, LEGACY_TURN_TABLES } from './mesh/turn-ledger/schema.js';
export { projectTurnWireEvent, turnWireEventName, TURN_WIRE_EVENT_NAMES, type TurnWireEvent } from './mesh/turn-ledger/bus-projection.js';
export type { TurnLedgerPorts, TurnTxnHost, CancelDispatchRequest, TurnCompletionEnvelope } from './mesh/turn-ledger/effects.js';
export { createMeshRuntimeTurnLedger } from './mesh/turn-ledger/runtime-ledger.js';
export { migrateTurnLedgerV2, formatTurnLedgerMigrationV2Line, V2_RETIRED_TABLES, type TurnLedgerMigrationV2Report } from './mesh/turn-ledger/migrate-v2.js';
export { migrateTurnLedgerV3, formatTurnLedgerMigrationV3Line, V3_RETIRED_TABLE, type TurnLedgerMigrationV3Report } from './mesh/turn-ledger/migrate-v3.js';
// C-W8: the process's active ledger slot + the daemon-side turn IPC responders
// (an mcp-server test process arms an in-process ledger and answers its fake
// transport's turn_observe / turn_cancel through the real handlers).
export { getActiveTurnLedger } from './mesh/turn-ledger/active-ledger.js';
export { setActiveTurnLedgerForIpc, turnLedgerIpcHandlers } from './commands/low-family/turn-ledger-ipc.js';
// C-W8: operating notes on mesh_operating_notes (the ledger no longer holds them).
export {
  readOperatingNotes,
  recordOperatingNote,
  forgetOperatingNote,
  pruneOperatingNotes,
  isNoteExpired,
  resolveNoteExpiry,
  OPERATING_NOTE_KIND,
  OPERATING_NOTE_DEDUPE_WINDOW,
  OPERATING_NOTE_KEEP_LATEST,
  OPERATING_NOTE_CATEGORY_TTL_DAYS,
  type OperatingNoteEntry,
  type RecordOperatingNoteInput,
} from './mesh/mesh-operating-notes.js';
// C4 (C-W4): the one turn-lifecycle timer — started by boot/stages/loops.ts.
export {
  createTurnScheduler,
  startTurnScheduler,
  createLateBoundProbePort,
  type TurnScheduler,
  type TurnSchedulerDeps,
  type TurnTickReport,
} from './mesh/turn-ledger/scheduler.js';
// Wiring-unification C-W3: the durable turn cursors on `mesh.<id>.events`
// (turn.ingest / turn.deliver / mesh.index). The Stage 4A in-memory read model,
// its readiness gate and the roster module are gone — `mesh_topic_index`
// answers fleet reads, the turn tables answer own reads.
export {
  armMeshTurnConsumer,
  pruneRetiredMeshConsumers,
  TURN_INGEST_CONSUMER,
  TURN_DELIVER_CONSUMER,
  RETIRED_MESH_CONSUMER_PREFIXES,
  type MeshTopicCursorEntry,
  type MeshTurnConsumer,
  type MeshTurnConsumerCounters,
  type MeshTurnConsumerHandlers,
} from './seqscribe/mesh-turn-consumer.js';
export {
  projectMeshLedgerEntry,
  isProjectedPayloadKey,
  PROJECTED_PAYLOAD_KEYS,
  MESH_EVENT_ENTRY_KIND,
  MAX_PROJECTED_STRING,
  // seqscribe v3.5 P12/P13: the checked JsonValue conversion (sanitizeJson) and
  // the pre-append size estimate that replaced an unchecked cast and an
  // unbounded append respectively.
  toJsonValue,
  estimateProjectedEntryBytes,
  maxEntryBytes,
  type ProjectedMeshEvent,
} from './seqscribe/mesh-event-projection.js';
// §8 unit 2: transcript publisher + parity counters. Exported so the cloud
// daemon's status projection can pass them to `summarizeSeqscribeStats` the
// same way it already passes the mesh-axis `dualWrite`/`parity` counters.
export {
  transcriptParityCounters,
  __resetTranscriptParityForTests,
  type TranscriptParityCounters,
} from './seqscribe/transcript-parity.js';
export {
  activeTranscriptProjectionService,
  type TranscriptProjectionCounters,
} from './seqscribe/transcript-publisher.js';
// Phase 4 Stage 3: fleet.status parity evidence + future-consumer readiness.
export {
  configureFleetStatusParity,
  observeFleetStatusWsProjection,
  fleetStatusParityCounters,
  __resetFleetStatusParityForTests,
  FLEET_STATUS_PARITY_INTERVAL_MS,
  FLEET_STATUS_PARITY_SUMMARY_INTERVAL_MS,
  FLEET_STATUS_APPEND_SETTLE_MS,
  type FleetStatusParityBuckets,
  type FleetStatusParityCounters,
  type FleetStatusParityExpectation,
  type FleetStatusParityHandle,
  type FleetStatusParityMismatchKind,
  type FleetStatusParityOptions,
  type FleetStatusParityRunResult,
} from './seqscribe/fleet-status-parity.js';
export {
  evaluateFleetStatusReadiness,
  type FleetStatusReadiness,
  type FleetStatusReadinessInput,
  type FleetStatusReadinessReason,
} from './seqscribe/fleet-status-readiness.js';
export {
  createFleetStatusPeerViewConsumer,
  FLEET_STATUS_SUB_VIEW,
  type FleetStatusPeerViewConsumer,
} from './seqscribe/fleet-status-peer-view.js';
// §8 unit 5 ("web chat pane consumer cutover"): type-only, zero-runtime-cost
// re-export of the `session.<safeSessionId>.transcript` wire contract (§8
// unit 1) so web-core's roster adapter can type-import
// `ReplicatedTranscriptSnapshotV1` from the root barrel WITHOUT a value
// import — the root-barrel-value-import ban (see meshSurfaceHelpers.ts's own
// note) only forbids pulling runtime code (logger/fs) into a browser bundle;
// an `export type` is erased at compile time and carries none of that.
// §8 unit 6 ("mesh_read_chat remote display cutover"): the `mesh_read_chat_
// display` roster adapter. A VALUE export (unlike the type-only block below) —
// mcp-server is a node process, not a browser bundle, so the root-barrel
// value-import ban does not apply to it.
export {
  mapTranscriptSnapshotToReadChatPayload,
  type TranscriptReadChatPayload,
} from './mesh/transcript-read-chat-adapter.js';
export type {
  ReplicatedTranscriptSnapshotV1,
  ReplicatedTranscriptMessageV1,
  ReplicatedTranscriptTerminalMarkerV1,
  ReplicatedTranscriptCoverageV1,
  ReplicatedTranscriptProvenanceV1,
  ReplicatedTranscriptModalV1,
  ReplicatedTranscriptPromptV1,
  ReplicatedTranscriptTurnV1,
  TranscriptMessageBubbleState,
  TranscriptTerminalOutcome,
  TranscriptCoverageMode,
} from './seqscribe/transcript-projection.js';

// Child-process wrappers that default to a hidden win32 console window.
// Exported from the package entry so `packages/daemon-cloud` — which is the
// codebase that was never swept for `windowsHide` and caused the `adhdev
// update` console-flash — can import them without a deep src path.
export {
  hiddenSpawn,
  hiddenSpawnSync,
  hiddenExecFileSync,
  hiddenExecSync,
} from './process/hidden-spawn.js';

// Wiring-unification B4 — staged daemon boot + seqscribe runtime.
export { bootDaemonRuntime, DEFAULT_DAEMON_BOOT_STAGES } from './boot/daemon-runtime.js';
export type { DaemonBootStages } from './boot/daemon-runtime.js';
export type {
  DaemonBootConfig,
  DaemonRuntime,
  SessionHostBoot,
  Disposer,
} from './boot/daemon-components.js';
export { buildDaemonHealthSummary } from './boot/health-summary.js';
export type { DaemonHealthSummary } from './boot/health-summary.js';
export { openSeqscribeRuntime, createBeaconSlot, tryOpenDaemonSeqscribeNode } from './seqscribe/runtime.js';
export type {
  SeqscribeRuntime,
  SeqscribeProjectionsView,
  BeaconSlot,
  BeaconHandleLike,
  FleetStatusProducer,
} from './seqscribe/runtime.js';
export { bindSeqscribeRuntime, seqscribeSlot } from './seqscribe/runtime-slot.js';
export { buildLocalSeqscribeStats } from './seqscribe/local-stats.js';
export { subscribeTranscriptProjection } from './seqscribe/transcript-bus-subscriber.js';
// G6 prerequisite — standalone dashboard replica lane (localhost WS peer).
export {
  StandaloneTranscriptLane,
  STANDALONE_SEQSCRIBE_WS_PATH,
  STANDALONE_SEQSCRIBE_PEER_CLASS,
  MAX_STANDALONE_SEQSCRIBE_LANES,
  deriveStandaloneTranscriptGrants,
  transcriptTopicSessionSegment,
} from './seqscribe/standalone-transcript-lane.js';
export type { StandaloneTranscriptLaneOptions } from './seqscribe/standalone-transcript-lane.js';
// ─── Session launch provenance (wiring-unification Phase E) ───
export {
  buildSessionLaunchRecord,
  buildRestoredLaunchRecord,
  buildModelSelection,
  classifyMeshLaunchAxisSource,
  resolveProviderDefaultModel,
  readLaunchProvenanceArgs,
  inferLaunchedBy,
} from './sessions/launch-record.js';
export type { LaunchAxis, LaunchAxisInput, LaunchProvenanceArgs, SessionLaunchRecordInput } from './sessions/launch-record.js';
export type { LaunchUpdateCause } from './sessions/lifecycle-events.js';
export {
  MODEL_AXIS_SOURCES,
  SESSION_LAUNCHED_BY,
  isModelAxisSource,
  isSessionLaunchedBy,
  sanitizeModelIdentifier,
  parseSessionLaunchRecord,
  describeModelSelection,
  effectiveModelSelectionValue,
  launchModelSelectionValue,
} from '@adhdev/mesh-shared';
export type {
  ModelAxisSource,
  ModelSelection,
  ModelSelectionHistoryEntry,
  ModelSelectionVia,
  ModelSelectionDisplay,
  SessionLaunchRecord,
  SessionLaunchedBy,
} from '@adhdev/mesh-shared';
export { resolveModelLaunchValue } from './commands/model-launch-args.js';
export { nativeHistoryObservedModel } from './providers/native-history/observed-model.js';
export type { ObservedModel } from './providers/native-history/observed-model.js';
export { buildSessionLaunchFields } from './status/builders.js';

// ─── Host absorption (wiring-unification B5) ───
export { createDaemonHostRuntime } from './boot/host-runtime.js';
export type {
  DaemonHostRuntime,
  DaemonHostTransport,
  HostAdmissionContext,
  HostSnapshotProfile,
  HostStatusSnapshot,
} from './boot/host-runtime.js';
export {
  isTurnCompletionEdge,
  subscribeHostChatTail,
  subscribeHostCommandTopics,
  subscribeHostMeshState,
  subscribeHostModal,
  subscribeHostStatusFacts,
  subscribeHostTurnSnapshots,
} from './boot/host-subscribers.js';
export type { StatusFactsEvent, ChatTailHooks, TurnSnapshotDeps } from './boot/host-subscribers.js';
export { SessionOutputFanout } from './boot/session-output-fanout.js';
export type { SessionOutputSink } from './boot/session-output-fanout.js';
export { bootSessionHost } from './session-host/host-bootstrap.js';
export type { SessionHostBootOptions, SessionHostHandle, SessionHostManagedBy } from './session-host/host-bootstrap.js';
export { SessionHostController } from './session-host/session-host-controller.js';
export {
  createStatusEventEmitter,
  createInstanceHideMuteResolver,
  projectP2PStatusEvent,
  projectServerStatusEvent,
  toDaemonStatusEventName,
} from './status/status-event.js';
export type { StatusEventEmitterDeps, StatusEventHideMute, ResolveStatusEventHideMute } from './status/status-event.js';
export type { HotChatSessionState, SessionModalState } from './providers/provider-instance.js';
export { subscribeLifecycleTrace, formatLifecycleTraceLine } from './sessions/lifecycle-trace.js';
export type { LifecycleTraceLog } from './sessions/lifecycle-trace.js';

// D-prep: the `_meshDirectDispatch` forwarding-loop guard — one reader, one writer
// (hosts forwarding a mesh command to themselves use the writer too).
export { readMeshDirectDispatchFlag, withMeshDirectDispatch } from './commands/command-args.js';
export type { MeshDirectDispatchArgs } from './commands/command-args.js';
// Wiring-unification D2 — the one send funnel (`DaemonCliManager.input`).
export { createSessionInputService, BUSY_DECISION } from './sessions/session-input-service.js';
export type { SessionInputService, SessionInputTarget } from './sessions/session-input-service.js';
