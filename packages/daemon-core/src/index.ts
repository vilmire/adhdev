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
  RepoMeshSessionStatus,
  RepoMeshQueueTask,
  RepoMeshQueueTaskStatus,
  RepoMeshQueueSummary,
  RepoMeshQueueStatus,
  RepoMeshLedgerEntryStatus,
  RepoMeshLedgerSummaryStatus,
  RepoMeshLedgerStatus,
  MeshAsyncJobLifecycle,
} from './repo-mesh-types.js';
export { DEFAULT_MESH_POLICY } from './repo-mesh-types.js';

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
export { loadConfig, saveConfig, resetConfig, isSetupComplete, markSetupComplete, updateConfig, getDaemonDataDir } from './config/config.js';
export { getWorkspaceState } from './config/workspaces.js';
export { appendRecentActivity, getRecentActivity } from './config/recent-activity.js';
export type { RecentActivityEntry } from './config/recent-activity.js';
export { getSavedProviderSessions, upsertSavedProviderSession } from './config/saved-sessions.js';
export type { SavedProviderSessionEntry } from './config/saved-sessions.js';

// ── Mesh Config ──
export {
  listMeshes, getMesh, getMeshByRepo, createMesh, updateMesh, deleteMesh,
  addNode, removeNode, updateNode, normalizeRepoIdentity,
} from './config/mesh-config.js';
export type { CreateMeshOptions, UpdateMeshOptions, AddNodeOptions } from './config/mesh-config.js';

// ── Mesh Coordinator ──
export { buildCoordinatorSystemPrompt } from './mesh/coordinator-prompt.js';
export type { CoordinatorPromptContext } from './mesh/coordinator-prompt.js';
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
export { syncMeshes } from './mesh/mesh-sync.js';
export type { MeshSyncTransport, MeshSyncResult, RemoteMeshRecord } from './mesh/mesh-sync.js';

// ── Mesh Task Ledger ──
export { appendLedgerEntry, appendRemoteLedgerEntries, buildTaskCompletionEvidence, normalizeMeshWorkerResult, readLedgerEntries, readLedgerSlice, getLedgerSummary, getLedgerDir, getSessionRecoveryContext, MAX_LEDGER_SLICE_LIMIT } from './mesh/mesh-ledger.js';
export type { AppendRemoteLedgerResult, MeshLedgerEntry, MeshLedgerKind, MeshLedgerSlice, MeshLedgerSummary, ReadLedgerOptions, ReadLedgerSliceOptions, SessionRecoveryContext, MeshTaskCompletionEvidence, MeshWorkerResultArtifact, MeshProcessArtifact, MeshValidationResultArtifact } from './mesh/mesh-ledger.js';
export { fastForwardMeshNode } from './mesh/mesh-fast-forward.js';
export type { MeshFastForwardNodeArgs, MeshFastForwardPlannedStep, MeshFastForwardResult } from './mesh/mesh-fast-forward.js';
export { buildMeshLedgerReconciliationEvidence, buildMeshLedgerReplicaEvidence } from './mesh/mesh-ledger-reconciliation.js';
export type { MeshLedgerReconciliationEvidence, MeshLedgerReplicaEvidence, MeshLedgerReplicaStatus } from './mesh/mesh-ledger-reconciliation.js';

// ── Mesh Work Queue (GUPP) ──
export { enqueueTask, getQueue, claimNextTask, updateTaskStatus, updateSessionTaskStatus, cancelTask, requeueTask, getMeshQueueStats, getMeshQueueRevision, normalizeMeshTaskMode, validateMeshTaskModeRequest, insertDirectDispatch, getActiveDirectDispatches, updateDirectDispatchStatus, cleanupTerminalDirectDispatches, markStaleDirectDispatches } from './mesh/mesh-work-queue.js';
export type { MeshWorkQueueEntry, MeshTaskStatus, MeshTaskMode, MeshWorkQueueStats, MeshQueueMutationOptions, MeshTaskModeValidationResult, DirectDispatchRecord } from './mesh/mesh-work-queue.js';
export { buildCompactStaleDirectWorkSummary, buildMeshActiveWork, buildMeshActiveWorkSummary } from './mesh/mesh-active-work.js';
export type { MeshActiveWorkRecord, MeshActiveWorkStatus, MeshActiveWorkSummary, MeshActiveWorkSource, MeshStaleDirectWorkSummary } from './mesh/mesh-active-work.js';
export { buildMeshAsyncRefineJobs } from './mesh/mesh-refine-status.js';
export type { MeshAsyncRefineJobStatus, MeshAsyncRefineJobSummary } from './mesh/mesh-refine-status.js';

// ── Mesh Host Ownership ──
export { buildMeshHostRequiredFailure, createDefaultMeshHostMetadata, isMeshHostOwner, normalizeMeshDaemonRole, requireMeshHostQueueOwner, resolveMeshHostStatus } from './mesh/mesh-host-ownership.js';

// ── Mesh Visualization ──
// buildMeshGraph and MeshGraph types moved to @adhdev/web-core to avoid
// bundling Node.js built-ins (fs, path, etc.) into browser builds.
// Import from '@adhdev/web-core' instead.
// export { buildMeshGraph } from './mesh/mesh-visualization.js';
// export type { MeshGraph, MeshGraphNode, MeshGraphEdge, MeshGraphNodeType, MeshGraphEdgeType } from './mesh/mesh-visualization.js';

// ── Mesh Events ──
export { triggerMeshQueue, drainPendingMeshCoordinatorEvents, getPendingMeshCoordinatorEvents, clearPendingMeshCoordinatorEvents, queuePendingMeshCoordinatorEvent } from './mesh/mesh-events.js';
export type { PendingMeshCoordinatorEvent } from './mesh/mesh-events.js';

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

// ── State Store ──
export { loadState, saveState, resetState } from './config/state-store.js';
export type { DaemonState } from './config/state-store.js';

// ── Detection ──
export { detectIDEs } from './detection/ide-detector.js';
export type { IDEInfo } from './detection/ide-detector.js';
export { detectCLIs } from './detection/cli-detector.js';
export { getHostMemorySnapshot } from './system/host-memory.js';
export type { HostMemorySnapshot } from './system/host-memory.js';
export {
  classifyHotChatSessionsForSubscriptionFlush,
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
export { DaemonCommandRouter } from './commands/router.js';
export type { CommandRouterDeps, CommandRouterResult } from './commands/router.js';
export {
  maybeRunDaemonUpgradeHelperFromEnv,
  spawnDetachedDaemonUpgradeHelper,
  resolveCurrentGlobalInstallSurface,
  buildPinnedGlobalInstallCommand,
  execNpmCommandSync,
  getNpmExecOptions,
} from './commands/upgrade-helper.js';
export type {
  DaemonUpgradeHelperPayload,
  CurrentGlobalInstallSurface,
  PinnedGlobalInstallCommand,
  NpmExecOptions,
} from './commands/upgrade-helper.js';

// ── Status ──
export { DaemonStatusReporter } from './status/reporter.js';
export { buildSessionEntries, findCdpManager, hasCdpManager, isCdpConnected } from './status/builders.js';
export { buildStatusSnapshot, buildMachineInfo } from './status/snapshot.js';
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
} from './logging/logger.js';
export type { ScopedLogger, LogLevel, LogEntry } from './logging/logger.js';
export {
    resolveDebugRuntimeConfig,
    setDebugRuntimeConfig,
    getDebugRuntimeConfig,
    resetDebugRuntimeConfig,
    shouldCollectTraceCategory,
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
export { ProviderInstanceManager } from './providers/provider-instance-manager.js';
export { IdeProviderInstance } from './providers/ide-provider-instance.js';
export { CliProviderInstance } from './providers/cli-provider-instance.js';
export { AcpProviderInstance } from './providers/acp-provider-instance.js';
export type { ProviderModule, CdpTargetFilter, ProviderResumeCapability, InputEnvelope, InputPart, MessagePart, ReadChatTurnStatus, ControlListResult, ControlSetResult, ControlInvokeResult } from './providers/contracts.js';
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
export { ProviderCliAdapter } from './cli-adapters/provider-cli-adapter.js';
export type { CliAdapter } from './cli-adapter-types.js';
export { NodePtyTransportFactory } from './cli-adapters/pty-transport.js';
export type { PtyRuntimeTransport, PtyTransportFactory, PtySpawnOptions } from './cli-adapters/pty-transport.js';
export { SessionHostPtyTransportFactory } from './cli-adapters/session-host-transport.js';
export type { HostedCliRuntimeDescriptor, CliTransportFactoryParams } from './commands/cli-manager.js';
export {
  DEFAULT_SESSION_HOST_APP_NAME,
  DEFAULT_STANDALONE_SESSION_HOST_APP_NAME,
  resolveSessionHostAppName,
  resolveSessionHostAppNameResolution,
} from './session-host/app-name.js';
export type { SessionHostAppNameResolution } from './session-host/app-name.js';
export { ensureSessionHostReady, listHostedCliRuntimes } from './session-host/runtime-support.js';
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
