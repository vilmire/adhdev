/**
 * @adhdev/daemon-core — Public API
 *
 * Core logic for daemon: CDP, Provider, IDE detection, CLI adapters and more.
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
  DaemonStatusEventPayload,
  DashboardStatusEventPayload,
  SessionTransport,
  SessionKind,
  SessionCapability,
  AgentSessionStream,
  ReadChatCursor,
  ReadChatSyncResult,
  TransportTopic,
  SessionRuntimeOutputSubscriptionParams,
  MachineRuntimeSubscriptionParams,
  SessionHostDiagnosticsSubscriptionParams,
  DaemonMetadataSubscriptionParams,
  WorkspaceGitSubscriptionParams,
  MachineRuntimeUpdate,
  SessionHostDiagnosticsUpdate,
  DaemonMetadataUpdate,
  DaemonMetadataDelta,
  DaemonMetadataWireUpdate,
  MeshStatusSubscriptionParams,
  MeshStatusSnapshotUpdate,
  MeshStatusDeltaUpdate,
  MeshStatusWireUpdate,
  TopicUpdateEnvelope,
  TopicProtocolMismatchUpdate,
  SubscribeRequest,
  UnsubscribeRequest,
  AvailableProviderInfo,
  ProviderAssistantEligibility,
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
  RepoMeshPolicyOverrides,
  RepoMeshQuotaRoutingPolicy,
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
  RepoMeshNodeGitObservation,
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
  MESH_SCHEDULING_STRATEGIES,
  DEFAULT_MESH_SCHEDULING_STRATEGY,
  normalizeMeshSchedulingStrategy,
  resolveNodeSchedulingPriority,
  resolveProviderMaxParallel,
  resolveMeshPolicy,
  normalizePolicyOverrides,
  mergePolicyOverrides,
  RETIRED_MESH_POLICY_KEYS,
  normalizeAutoFastForwardPolicy,
  resolveMaxParallelTasks,
  MESH_MAX_PARALLEL_TASKS_MIN,
  MESH_MAX_PARALLEL_TASKS_MAX,
} from './repo-mesh-types.js';

// ── Repo-shared declarative mesh config (.adhdev/mesh.json) ──
export {
  loadRepoMeshJsonConfig,
  normalizeRepoMeshDeclarativeConfig,
  buildMeshJsonConfigScaffold,
  serializeMeshJsonConfigScaffold,
  MESH_JSON_CONFIG_LOCATIONS,
  MESH_JSON_CONFIG_SCHEMA,
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

// ── Repo Mesh surface (config, coordinator, queue, graph, events, dispatch refusals) ──
export * from './index-mesh.js';


// ── State Store ──
export { loadState, saveState, resetState } from './config/state-store.js';
export type { DaemonState } from './config/state-store.js';

// ── Detection ──
export { detectIDEs } from './detection/ide-detector.js';
export type { IDEInfo } from './detection/ide-detector.js';
export { detectCLIs, detectCLI } from './detection/cli-detector.js';
export { getHostMemorySnapshot } from './system/host-memory.js';
export type { HostMemorySnapshot } from './system/host-memory.js';

// ── CDP ──
export { DaemonCdpManager } from './cdp/manager.js';
export { CdpDomHandlers } from './cdp/devtools.js';
export { setupIdeInstance, registerExtensionProviders, probeCdpPort } from './cdp/setup.js';
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
export { TopicSubscriptionRegistry, DEFAULT_GIT_REFRESH_CONCURRENCY } from './subscriptions/topic-registry.js';
export type {
    TopicSink,
    TopicEngineOptions,
    TopicEngineSources,
    DaemonMetadataScope,
    DaemonMetadataUpdateBody,
} from './subscriptions/topic-registry.js';
export { maybeRunDaemonUpgradeHelperFromEnv, spawnDetachedDaemonUpgradeHelper } from './commands/upgrade-helper.js';
export { resolveInstanceDir } from './commands/upgrade-log.js';
export { resolveCurrentGlobalInstallSurface, buildPinnedGlobalInstallCommand, execNpmCommandSync, resolveNpmPublishedVersion, getNpmExecOptions } from './commands/upgrade-install-surface.js';
export type { DaemonUpgradeHelperPayload } from './commands/upgrade-helper.js';
export type { CurrentGlobalInstallSurface, PinnedGlobalInstallCommand, NpmExecOptions } from './commands/upgrade-install-surface.js';

// ── Status ──
export { DaemonStatusReporter, buildCloudStatusReportPayload, observeP2PStatusSummary } from './status/reporter.js';
export { buildSessionEntries, findCdpManager, isCdpConnected, isCoordinatorSpawnedHiddenWorker, resolveSurfaceHidden, resolveMuted, resolveSpawnedSessionHideMute } from './status/builders.js';
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
    setConsoleLogLevel,
    getConsoleLogLevel,
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
export {
  ADHDEV_INTERNAL_AUTH_HEADER,
  ADHDEV_WORKER_CREDENTIAL_HEADER,
  ADHDEV_DAEMON_AUTH_FILE_ENV,
  ADHDEV_DAEMON_AUTH_FILE_FLAG,
  ADHDEV_COORDINATOR_MCP_AUTH_FILE_ENV,
  WORKER_MCP_DAEMON_VERBS,
  isWorkerMcpDaemonVerb,
} from './standalone-mcp-auth.js';
export { isLiveWorkerMcpCredential } from './standalone-mcp-auth-verify.js';

// ── Chat History ──
export { readChatHistory } from './config/chat-history.js';
export {
  hashSignatureParts,
  buildChatMessageSignature,
} from './chat/chat-signatures.js';
export type {
  ChatMessageSignatureInput,
} from './chat/chat-signatures.js';
export { runAsyncBatch } from './chat/async-batch.js';
export type { AsyncBatchOptions } from './chat/async-batch.js';

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
export { BUS_EVENT_KINDS } from './sessions/lifecycle-events.js';
export type { SessionLifecycleEvent, DaemonEvent as DaemonBusEvent, BusEvent, BusEventKind, EventOf, RegisterOrigin, StatusCause, TerminationCause, DaemonFactsCause, PromptTransport, EnrichedProviderEvent } from './sessions/lifecycle-events.js';
export { createSessionEventPort } from './sessions/session-port.js';
export type { SessionEventPort, SessionSignalDetail, CreateSessionEventPortOptions } from './sessions/session-port.js';
export { SessionRegistry } from './sessions/registry.js';
export type { SessionRuntimeTarget, TerminateDetail } from './sessions/registry.js';
export { IdeProviderInstance } from './providers/ide-provider-instance.js';
export { CliProviderInstance } from './providers/cli-provider-instance.js';
export type { ProviderModule, AutoApproveMode, AutoApproveModesConfig, AutoApproveModeRisk, AutoApproveModeStrategy, CdpTargetFilter, ProviderResumeCapability, InputEnvelope, InputPart, MessagePart, ReadChatTurnStatus } from './providers/contracts.js';
export type { ControlListResult, ControlSetResult, ControlInvokeResult } from './providers/provider-control-contracts.js';
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
export { installExtensions, launchIDE, isExtensionInstalled } from './installer.js';
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
    readAntigravityCliSession,
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
export type { DashboardEvent, DashboardCommand, SpecDriverOpts, ISpecDriver } from './providers/spec/fsm-driver-types.js';
export { TerminalAdapter } from './providers/spec/adapter.js';
export type { TerminalAdapterOpts, TerminalAdapterHandlers } from './providers/spec/adapter.js';

// v1-contract provider scaffolding (cli) — shared by `adhdev provider
// init`/`create` (daemon-cloud CLI) and the DevServer /api/scaffold route
// (daemon/dev-server.ts). See scaffold-v1.ts header.
export {
  buildCliProviderV1Scaffold,
  resolveCliSpecPath,
  CUSTOM_PROVIDERS_DOCS_URL,
  INIT_SCAFFOLDABLE_CATEGORIES,
} from './providers/scaffold-v1.js';
export type {
  CliProviderScaffoldOptions,
  CliProviderScaffoldResult,
} from './providers/scaffold-v1.js';

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
  V1_PRIMITIVE_CATALOG,
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

// seqscribe integration (the 2026-08-26 seqscribe integration plan).
// Phase 0 surface: node lifecycle, the topic table, the authority wiring and
// the status projection. Phase 1 adds the fleet-secret store (auth_ok delivery).
export {
  openSeqscribeNode,
  getSeqscribeDbPath,
  SEQSCRIBE_DB_NAME,
  SEQSCRIBE_DB_SUFFIX_ENV_VAR,
  WRITER_ID_PREFIX,
  type SeqscribeNodeHandle,
  type SeqscribeNodeOptions,
} from './seqscribe/node.js';
export {
  safeMeshId,
  safeSessionId,
  meshEventsTopic,
  meshEventsPolicy,
  sessionChatTopic,
  sessionChatPolicy,
  sessionSegmentFromChatTopic,
  CHAT_TOMBSTONE_KIND,
  configSettingsPolicy,
  baseTopicDefinitions,
  contentTopicsFor,
  CONFIG_SETTINGS_TOPIC,
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
export { summarizeSeqscribeStats } from './seqscribe/stats.js';
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
// §8 unit 2: transcript publisher counters. Exported so the cloud daemon's
// status projection can pass them to `summarizeSeqscribeStats`.
export {
  activeTranscriptProjectionService,
  type TranscriptProjectionCounters,
} from './seqscribe/transcript-publisher.js';
export {
  transcriptChatRuntimeCounters,
  type TranscriptChatRuntimeCounters,
} from './seqscribe/transcript-keyed-publish-runtime.js';
// §8 unit 6 ("mesh_read_chat remote display cutover"): the `mesh_read_chat_
// display` roster adapter. A VALUE export (unlike the type-only block below) —
// mcp-server is a node process, not a browser bundle, so the root-barrel
// value-import ban does not apply to it.
export {
  mapTranscriptViewToReadChatPayload,
  type TranscriptReadChatPayload,
} from './mesh/transcript-read-chat-adapter.js';
// The keyed chat wire (design 2026-09-28): type-only, zero-runtime-cost
// re-export so web-core can type-import the view from the root barrel WITHOUT a
// value import — the root-barrel-value-import ban (see meshSurfaceHelpers.ts's
// own note) only forbids pulling runtime code (logger/fs) into a browser
// bundle; an `export type` is erased at compile time. Value code (the folder, the codec) is
// reached through the portable subpath exports
// `@adhdev/daemon-core/seqscribe/transcript-keyed-codec` and
// `@adhdev/daemon-core/seqscribe/transcript-keyed-folder` — never this barrel.
export type {
  ReplicatedTranscriptViewV2,
  ReplicatedTranscriptMessageV2,
  ReplicatedTranscriptViewCoverageV2,
  ChatCoverageMode,
  ChatBubbleState as ChatWireBubbleState,
  ChatModalV2,
  ChatPromptV2,
  ChatTurnV2,
  ChatProvenanceV2,
  ChatTerminalMarkerV2,
} from './seqscribe/transcript-keyed-codec.js';
export type { KeyedTranscriptFrameDelta } from './seqscribe/transcript-keyed-folder.js';

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
export { openSeqscribeRuntime, tryOpenDaemonSeqscribeNode } from './seqscribe/runtime.js';
export type {
  SeqscribeRuntime,
  SeqscribeProjectionsView,
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
  TRANSCRIPT_TOPICS_AVAILABLE_TYPE,
  transcriptTopicsAvailableFrame,
} from './seqscribe/standalone-transcript-lane.js';
export type { StandaloneTranscriptLaneOptions, TranscriptTopicsAvailableFrame } from './seqscribe/standalone-transcript-lane.js';
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
  subscribeHostCommandTopics,
  subscribeHostMeshState,
  subscribeHostStatusFacts,
  subscribeHostTurnSnapshots,
} from './boot/host-subscribers.js';
export type { StatusFactsEvent, TurnSnapshotDeps } from './boot/host-subscribers.js';
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
// Assistant input attribution for PTY input that skips the router (cloud P2P
// `pty_input` frame): the host reports the transport's own source.
export { reportSessionTerminalInput } from './assistant/assistant-human-input.js';
export type { MeshDirectDispatchArgs } from './commands/command-args.js';
// Wiring-unification D2 — the one send funnel (`DaemonCliManager.input`).
export { createSessionInputService, BUSY_DECISION } from './sessions/session-input-service.js';
export type { SessionInputService, SessionInputTarget } from './sessions/session-input-service.js';

// ── Tool answers composed by the coordinator daemon (mesh_status_view / mesh_dispatch_route) ──
export { composeMeshStatusView, decideDispatchRoute, decideNodeRoutes, type MeshNodeRouteDecision } from './commands/high-family/mesh-status-view.js';
export type { MeshStatusViewArgs } from './commands/high-family/mesh-status-view.js';
