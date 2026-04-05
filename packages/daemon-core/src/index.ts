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
  SessionTransport,
  SessionKind,
  SessionCapability,
  AgentSessionStream,
  AvailableProviderInfo,
  AcpConfigOption,
  AcpMode,
  ProviderControlSchema,
  StatusReportPayload,
  MachineInfo,
  DetectedIdeInfo,
  WorkspaceEntry,
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

// ── Detection ──
export { detectIDEs } from './detection/ide-detector.js';
export type { IDEInfo } from './detection/ide-detector.js';
export { detectCLIs } from './detection/cli-detector.js';
export { getHostMemorySnapshot } from './system/host-memory.js';
export type { HostMemorySnapshot } from './system/host-memory.js';

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
export { maybeRunDaemonUpgradeHelperFromEnv } from './commands/upgrade-helper.js';

// ── Status ──
export { DaemonStatusReporter } from './status/reporter.js';
export { buildSessionEntries, findCdpManager, hasCdpManager, isCdpConnected } from './status/builders.js';
export { buildStatusSnapshot } from './status/snapshot.js';
export { normalizeManagedStatus, isManagedStatusWorking, isManagedStatusWaiting, normalizeActiveChatData } from './status/normalize.js';
export type { ManagedStatus } from './status/normalize.js';
export type { StatusSnapshotOptions, StatusSnapshot } from './status/snapshot.js';

// ── Logger ──
export { LOG, installGlobalInterceptor, setLogLevel, getLogLevel, getRecentLogs } from './logging/logger.js';
export type { ScopedLogger, LogLevel, LogEntry } from './logging/logger.js';
export { logCommand, getRecentCommands } from './logging/command-log.js';

// ── CLI Management ──
export { DaemonCliManager } from './commands/cli-manager.js';

// ── Launch ──
export { launchWithCdp, getAvailableIdeIds, killIdeProcess, isIdeRunning } from './launch.js';

// ── IPC ──
export { DEFAULT_DAEMON_PORT, DAEMON_WS_PATH } from './ipc-protocol.js';

// ── Chat History ──
export { readChatHistory } from './config/chat-history.js';

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
export type { ProviderModule, CdpTargetFilter, ProviderResumeCapability } from './providers/contracts.js';
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
export { ensureSessionHostReady, listHostedCliRuntimes } from './session-host/runtime-support.js';
export type { SessionHostEndpoint } from '@adhdev/session-host-core';

// ── Installer ──
export { getAIExtensions, installExtensions, launchIDE, isExtensionInstalled } from './installer.js';
export type { ExtensionInfo as InstallerExtensionInfo } from './installer.js';

// ── Boot / Lifecycle ──
export { initDaemonComponents, startDaemonDevSupport, shutdownDaemonComponents } from './boot/daemon-lifecycle.js';
export type { DaemonInitConfig, DaemonComponents, DaemonDevSupportOptions } from './boot/daemon-lifecycle.js';
