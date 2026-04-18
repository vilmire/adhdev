/**
 * @adhdev/daemon-core — Public API
 *
 * Core logic for daemon: CDP, Provider, IDE detection, CLI/ACP adapters and more.
 */

// ── Types ──
export type {
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
  ReadChatSyncMode,
  ReadChatSyncResult,
  TransportTopic,
  SessionChatTailSubscriptionParams,
  MachineRuntimeSubscriptionParams,
  SessionHostDiagnosticsSubscriptionParams,
  SessionModalSubscriptionParams,
  DaemonMetadataSubscriptionParams,
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
  ActiveChatData,
  IdeProviderState,
  CliProviderState,
  AcpProviderState,
  ExtensionProviderState,
} from './shared-types.js';

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

// Type aliases — rollup-dts cannot bundle re-exported type aliases at all.
// Canonical definition lives in shared-types-extra.ts — keep these in sync.
export type SessionStatus = 'idle' | 'generating' | 'waiting_approval' | 'error' | 'stopped' | 'starting' | 'panel_hidden' | 'not_monitored' | 'disconnected';
export type RecentSessionBucket = 'needs_attention' | 'working' | 'task_complete' | 'idle';

// ── Core Interface ──
export type { IDaemonCore, DaemonCoreOptions } from './daemon-core.js';

// ── Config ──
export { loadConfig, saveConfig, resetConfig, isSetupComplete, markSetupComplete, updateConfig } from './config/config.js';
export { getWorkspaceState } from './config/workspaces.js';
export { appendRecentActivity, getRecentActivity } from './config/recent-activity.js';
export type { RecentActivityEntry } from './config/recent-activity.js';
export { getSavedProviderSessions, upsertSavedProviderSession } from './config/saved-sessions.js';
export type { SavedProviderSessionEntry } from './config/saved-sessions.js';

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
export { maybeRunDaemonUpgradeHelperFromEnv, spawnDetachedDaemonUpgradeHelper } from './commands/upgrade-helper.js';
export type { DaemonUpgradeHelperPayload } from './commands/upgrade-helper.js';

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
export type { ProviderModule, CdpTargetFilter, ProviderResumeCapability, InputEnvelope, InputPart, MessagePart, ControlListResult, ControlSetResult, ControlInvokeResult } from './providers/contracts.js';
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
} from './providers/chat-message-normalization.js';
export type { BuiltinChatMessageKind, ChatMessageKind } from './providers/chat-message-normalization.js';
export { VersionArchive, detectAllVersions } from './providers/version-archive.js';
export type { ProviderVersionInfo, VersionHistory } from './providers/version-archive.js';

// ── Dev Server ──
export { DevServer } from './daemon/dev-server.js';

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
} from './session-host/app-name.js';
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
export type { SessionHostEndpoint } from '@adhdev/session-host-core';

// ── Installer ──
export { getAIExtensions, installExtensions, launchIDE, isExtensionInstalled } from './installer.js';
export type { ExtensionInfo as InstallerExtensionInfo } from './installer.js';

// ── Boot / Lifecycle ──
export { initDaemonComponents, startDaemonDevSupport, shutdownDaemonComponents } from './boot/daemon-lifecycle.js';
export type { DaemonInitConfig, DaemonComponents, DaemonDevSupportOptions } from './boot/daemon-lifecycle.js';
