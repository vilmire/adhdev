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
// Canonical definition lives in shared-types-extra.ts — keep these in sync.
export type SessionStatus = 'idle' | 'generating' | 'waiting_approval' | 'error' | 'stopped' | 'starting' | 'panel_hidden' | 'not_monitored' | 'disconnected';
export type RecentSessionBucket = 'needs_attention' | 'working' | 'task_complete' | 'idle';

// ── Core Interface ──
export type { IDaemonCore, DaemonCoreOptions } from './daemon-core.js';

// ── Config ──
export { loadConfig, saveConfig, resetConfig, clearAuthCredentials, isSetupComplete, markSetupComplete, updateConfig, setQuotaShowAccountEmail, getConfigDir, getDaemonDataDir } from './config/config.js';
export { isCrossTrackConfigDirOverride, otherTrackConfigDir } from './config/config-dir.js';
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
  listMagiKindPanels, listMagiKindPanelsReadOnly, getMagiKindPanel, setMagiKindPanel, removeMagiKindPanel, normalizeMagiSlots, resolveScopedMeshId,
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
export { loadMeshCoordinatorRegistry, registerMeshCoordinator, unregisterMeshCoordinator, getCoordinatorForSession, listCoordinatorsForWorkspace } from './mesh/coordinator-registry.js';
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

// ── Mesh Task Ledger ──
export { appendLedgerEntry, appendRemoteLedgerEntries, buildTaskCompletionEvidence, normalizeMeshWorkerResult, readLedgerEntries, readLedgerSlice, readLedgerSliceFromStore, getLedgerSummary, getLedgerDir, getSessionRecoveryContext, ledgerEntryTaskId, MAX_LEDGER_SLICE_LIMIT, tombstoneOperatingNote, readOperatingNotes, pruneOperatingNotes, isOperatingNoteTombstoned, OPERATING_NOTE_KIND, OPERATING_NOTE_TOMBSTONE_KIND, OPERATING_NOTE_DEDUPE_WINDOW, OPERATING_NOTE_KEEP_LATEST } from './mesh/mesh-ledger.js';
export type { AppendRemoteLedgerResult, MeshLedgerEntry, MeshLedgerKind, MeshLedgerSlice, MeshLedgerSummary, ReadLedgerOptions, ReadLedgerSliceOptions, SessionRecoveryContext, MeshTaskCompletionEvidence, MeshWorkerResultArtifact, MeshProcessArtifact, MeshValidationResultArtifact } from './mesh/mesh-ledger.js';
export { recordSessionUsage, readSessionUsage, summarizeMeshUsage, getUsageDir, MAX_SESSIONS_PER_MESH, USAGE_MAX_AGE_MS } from './mesh/mesh-usage-store.js';
export type { MeshSessionUsage, MeshUsageSummary, EvictedUsageRollup } from './mesh/mesh-usage-store.js';
export { foldUsageRecords, sumSessionUsage, makeUsage, totalTokens, isEmptyUsage, readTokenCount } from './providers/native-history/usage-normalize.js';
export type { NativeUsage, NativeUsageRecord, NativeUsageMode, SessionUsageTotals } from './providers/native-history/usage-normalize.js';
export { fastForwardMeshNode } from './mesh/mesh-fast-forward.js';
export type { MeshFastForwardNodeArgs, MeshFastForwardPlannedStep, MeshFastForwardResult } from './mesh/mesh-fast-forward.js';
export { buildMeshLedgerReconciliationEvidence, buildMeshLedgerReplicaEvidence } from './mesh/mesh-ledger-reconciliation.js';
export type { AnyLedgerSlice, MeshLedgerReconciliationEvidence, MeshLedgerReplicaEvidence, MeshLedgerReplicaStatus } from './mesh/mesh-ledger-reconciliation.js';

// ── Mesh Work Queue (GUPP) ──
export { enqueueTask, enqueueTaskGraph, MESH_TASK_GRAPH_MAX_TASKS, recordDirectDispatchTask, getQueue, claimNextTask, updateTaskStatus, updateSessionTaskStatus, cancelTask, requeueTask, getMeshQueueStats, getMeshQueueRevision, normalizeMeshTaskMode, validateMeshTaskModeRequest, buildMeshTaskModeViolationError, formatMeshTaskModeViolations, isTaskReadonly, buildMeshNodeCapabilityTags, nodeSatisfiesRequiredTags, normalizeMeshCapabilityTags, resolveConvergeRequiredTags, insertDirectDispatch, getActiveDirectDispatches, updateDirectDispatchStatus, cleanupTerminalDirectDispatches, markStaleDirectDispatches, deleteDirectDispatchesByTaskId, recordMeshToolCall, assertNoDependencyCycle, hasPendingDependents, describeTaskDependencyState, taskDependenciesSatisfied, normalizeMeshTaskPriority, meshTaskPriorityRank, resolveNotBefore, meshTaskNotBeforeReady, MESH_TASK_PRIORITIES, NOT_BEFORE_RELATIVE_THRESHOLD_MS } from './mesh/mesh-work-queue.js';
export type { MeshWorkQueueEntry, MeshTaskStatus, MeshTaskMode, MeshTaskPriority, MeshWorkQueueStats, MeshQueueMutationOptions, MeshEnqueueTaskOptions, MeshTaskGraphEntrySpec, MeshTaskModeValidationResult, MeshTaskModeViolationDetail, DirectDispatchRecord, MeshToolCallRateResult } from './mesh/mesh-work-queue.js';
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

// ── Mesh Host Ownership ──
export { buildMeshHostRequiredFailure, createDefaultMeshHostMetadata, isMeshHostOwner, normalizeMeshDaemonRole, requireMeshHostQueueOwner, resolveMeshHostStatus } from './mesh/mesh-host-ownership.js';

// ── Mesh Visualization ──
// buildMeshGraph and MeshGraph types moved to @adhdev/web-core to avoid
// bundling Node.js built-ins (fs, path, etc.) into browser builds.
// Import from '@adhdev/web-core' instead.
// export { buildMeshGraph } from './mesh/mesh-visualization.js';
// export type { MeshGraph, MeshGraphNode, MeshGraphEdge, MeshGraphNodeType, MeshGraphEdgeType } from './mesh/mesh-visualization.js';

// ── Mesh Events ──
export { triggerMeshQueue, drainPendingMeshCoordinatorEvents, getPendingMeshCoordinatorEvents, clearPendingMeshCoordinatorEvents, queuePendingMeshCoordinatorEvent, requeueHeldMeshCoordinatorEvents, serializeV2EnvelopeToWire, readV2EnvelopeFromWire, reconcileDirectDispatchCompletionFromTranscript } from './mesh/mesh-events.js';
export type { PendingMeshCoordinatorEvent, MeshHeldEventRequeueFilter, MeshHeldEventRequeueResult } from './mesh/mesh-events.js';
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
export { resolveDeliveryDecision, createSessionDelivery, updateSessionDeliveryStatus, getActiveSessionDeliveries, markSessionDeliveriesTerminal } from './mesh/mesh-delivery-policy.js';
export type { MeshSessionDeliveryStatus, MeshSessionDeliveryKind, MeshDeliveryDecision, MeshDeliveryPolicyResult, SessionDeliveryRecord } from './mesh/mesh-delivery-policy.js';

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
export { DaemonCdpScanner } from './cdp/scanner.js';
export type { CdpScannerOptions } from './cdp/scanner.js';
export { DaemonCdpInitializer } from './cdp/initializer.js';
export type { CdpInitializerConfig } from './cdp/initializer.js';

// ── Commands ──
export { DaemonCommandHandler } from './commands/handler.js';
export type { CommandResult, CommandContext } from './commands/handler.js';
export { DaemonCommandRouter, readCachedInlineMeshActiveSessionDetails, resolveMeshNodeAttribution, buildMeshNodeDataFreshness, buildMeshNodeProbeFreshness, MESH_NODE_LIVE_TRUTH_MARKER } from './commands/router.js';
export type { CommandRouterDeps, CommandRouterResult } from './commands/router.js';
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
export { DaemonStatusReporter, buildCloudStatusReportPayload } from './status/reporter.js';
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
} from './logging/logger.js';
export type { ScopedLogger, LogLevel, LogEntry } from './logging/logger.js';
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

// ── Boot / Lifecycle ──
export { initDaemonComponents, startDaemonDevSupport, shutdownDaemonComponents } from './boot/daemon-lifecycle.js';
export type { DaemonInitConfig, DaemonComponents, DaemonDevSupportOptions } from './boot/daemon-lifecycle.js';

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
export { validateFsmSpec } from './providers/spec/fsm-loader.js';
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
  fetchClaudeQuota,
  fetchGrokQuota,
  fetchAntigravityQuota,
  installClaudeStatusline,
  uninstallClaudeStatusline,
  readStatuslineStatus,
  StatuslineInstallError,
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
  printClaudeInstallResult,
  printClaudeUninstallResult,
  printClaudeStatuslineStatus,
  printQuotaInstallError,
} from './quota/cli.js';
