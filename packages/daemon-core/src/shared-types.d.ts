/**
 * ADHDev Shared Types — Cross-package type definitions
 *
 * Types used across daemon-core, web-core, and downstream consumers.
 * Import via: import type { ... } from '@adhdev/daemon-core/types'
 *
 * IMPORTANT: This file must remain runtime-free (types only).
 */
import type { StatusResponse, ChatMessage, ExtensionInfo, SystemInfo, DetectedIde, AgentEntry } from './types.js';
export type { StatusResponse, ChatMessage, ExtensionInfo, SystemInfo, DetectedIde, AgentEntry, };
export type { ProviderState, ProviderStatus, ActiveChatData, IdeProviderState, CliProviderState, AcpProviderState, ExtensionProviderState, ProviderEvent, } from './providers/provider-instance.js';
export type { ProviderErrorReason } from './providers/provider-instance.js';
import type { ActiveChatData as _ActiveChatData, ProviderErrorReason as _ProviderErrorReason } from './providers/provider-instance.js';
import type { WorkspaceEntry } from './config/workspaces.js';
import type { ProviderResumeCapability } from './providers/contracts.js';
export interface SessionActiveChatData extends Omit<_ActiveChatData, 'messages'> {
    messages?: _ActiveChatData['messages'];
}
export type { WorkspaceEntry } from './config/workspaces.js';
/** Agent stream snapshot carried by flattened UI entries. */
export interface AgentSessionStream {
    sessionId?: string;
    instanceId?: string;
    parentSessionId?: string | null;
    agentType: string;
    agentName: string;
    extensionId: string;
    transport?: SessionTransport;
    status: string;
    title?: string;
    messages: ChatMessage[];
    inputContent: string;
    model?: string;
    activeModal: {
        message: string;
        buttons: string[];
    } | null;
}
export type ReadChatSyncMode = 'full' | 'append' | 'replace_tail' | 'noop';
export interface ReadChatCursor {
    knownMessageCount?: number;
    lastMessageSignature?: string;
    tailLimit?: number;
}
export interface ReadChatSyncResult {
    messages: ChatMessage[];
    status: string;
    title?: string;
    activeModal?: {
        message: string;
        buttons: string[];
    } | null;
    syncMode: ReadChatSyncMode;
    replaceFrom: number;
    totalMessages: number;
    lastMessageSignature: string;
}
export interface ProviderSummaryItem {
    id: string;
    value: string;
    label?: string;
    shortValue?: string;
    icon?: string;
    order?: number;
}
export interface ProviderSummaryMetadata {
    items: ProviderSummaryItem[];
}
export type TransportTopic = 'session.chat_tail' | 'machine.runtime' | 'session_host.diagnostics' | 'session.modal' | 'daemon.metadata';
export interface SessionChatTailSubscriptionParams extends ReadChatCursor {
    targetSessionId: string;
    historySessionId?: string;
}
export interface MachineRuntimeSubscriptionParams {
    intervalMs?: number;
}
export interface SessionModalSubscriptionParams {
    targetSessionId: string;
}
export interface DaemonMetadataSubscriptionParams {
    includeSessions?: boolean;
}
export interface SessionHostDiagnosticsSubscriptionParams {
    includeSessions?: boolean;
    limit?: number;
    intervalMs?: number;
}
export interface SessionChatTailUpdate extends ReadChatSyncResult {
    topic: 'session.chat_tail';
    key: string;
    sessionId: string;
    historySessionId?: string;
    seq: number;
    timestamp: number;
}
export interface MachineRuntimeUpdate {
    topic: 'machine.runtime';
    key: string;
    machine: MachineInfo;
    seq: number;
    timestamp: number;
}
export interface SessionHostDiagnosticsUpdate {
    topic: 'session_host.diagnostics';
    key: string;
    diagnostics: SessionHostDiagnosticsSnapshot;
    seq: number;
    timestamp: number;
}
export interface SessionModalUpdate {
    topic: 'session.modal';
    key: string;
    sessionId: string;
    status: string;
    title?: string;
    modalMessage?: string;
    modalButtons?: string[];
    seq: number;
    timestamp: number;
}
export interface DaemonMetadataUpdate {
    topic: 'daemon.metadata';
    key: string;
    daemonId: string;
    status: StatusReportPayload;
    userName?: string;
    seq: number;
    timestamp: number;
}
export interface TopicUpdateEnvelopeMap {
    'session.chat_tail': SessionChatTailUpdate;
    'machine.runtime': MachineRuntimeUpdate;
    'session_host.diagnostics': SessionHostDiagnosticsUpdate;
    'session.modal': SessionModalUpdate;
    'daemon.metadata': DaemonMetadataUpdate;
}
export type TopicUpdateEnvelope = TopicUpdateEnvelopeMap[TransportTopic];
export interface SubscribeRequestMap {
    'session.chat_tail': SessionChatTailSubscriptionParams;
    'machine.runtime': MachineRuntimeSubscriptionParams;
    'session_host.diagnostics': SessionHostDiagnosticsSubscriptionParams;
    'session.modal': SessionModalSubscriptionParams;
    'daemon.metadata': DaemonMetadataSubscriptionParams;
}
export type SubscribeRequest = {
    [K in TransportTopic]: {
        type: 'subscribe';
        topic: K;
        key: string;
        params: SubscribeRequestMap[K];
    };
}[TransportTopic];
export type UnsubscribeRequest = {
    [K in TransportTopic]: {
        type: 'unsubscribe';
        topic: K;
        key: string;
    };
}[TransportTopic];
export type StandaloneWsStatusPayload = StatusReportPayload;
export type SessionTransport = 'cdp-page' | 'cdp-webview' | 'pty' | 'acp';
export type SessionKind = 'workspace' | 'agent';
export type SessionCapability = 'read_chat' | 'send_message' | 'new_session' | 'list_sessions' | 'switch_session' | 'resolve_action' | 'open_panel' | 'terminal_io' | 'resize_terminal' | 'change_model' | 'set_mode' | 'set_thought_level';
import type { RuntimeWriteOwner, RuntimeAttachedClient, SessionStatus } from './shared-types-extra.js';
export type { RuntimeWriteOwner, RuntimeAttachedClient, SessionStatus } from './shared-types-extra.js';
export interface SessionEntry {
    id: string;
    parentId: string | null;
    providerType: string;
    providerName?: string;
    providerSessionId?: string;
    kind: SessionKind;
    transport: SessionTransport;
    status: SessionStatus;
    title: string;
    workspace?: string | null;
    runtimeKey?: string;
    runtimeDisplayName?: string;
    runtimeWorkspaceLabel?: string;
    /** CLI only: active presentation mode */
    mode?: 'terminal' | 'chat';
    runtimeWriteOwner?: RuntimeWriteOwner | null;
    runtimeAttachedClients?: RuntimeAttachedClient[];
    resume?: ProviderResumeCapability;
    activeChat: SessionActiveChatData | null;
    capabilities?: SessionCapability[];
    cdpConnected?: boolean;
    /** Dynamic control current values (generic key-value) */
    controlValues?: Record<string, string | number | boolean>;
    /** Provider-declared controls schema (transmitted once, cached by frontend) */
    providerControls?: ProviderControlSchema[];
    /** Flexible always-visible metadata for compact/live surfaces. */
    summaryMetadata?: ProviderSummaryMetadata;
    errorMessage?: string;
    errorReason?: _ProviderErrorReason;
    lastMessageHash?: string;
    lastUpdated?: number;
    unread?: boolean;
    lastSeenAt?: number;
    inboxBucket?: RecentSessionBucket;
    completionMarker?: string;
    seenCompletionMarker?: string;
    surfaceHidden?: boolean;
}
/**
 * Compact session metadata stored in UserSessionDO and reused by server-side
 * status/convenience APIs. This intentionally excludes rich UI-only fields.
 */
export interface CompactSessionEntry {
    id: string;
    parentId: string | null;
    providerType: string;
    providerName: string;
    kind: SessionKind;
    transport: SessionTransport;
    status: SessionStatus;
    title: string;
    workspace: string | null;
    cdpConnected?: boolean;
    summaryMetadata?: ProviderSummaryMetadata;
}
/** Available provider information */
export interface AvailableProviderInfo {
    type: string;
    name: string;
    category: 'ide' | 'extension' | 'cli' | 'acp';
    displayName: string;
    icon: string;
    installed?: boolean;
    detectedPath?: string | null;
}
/** ACP config option (model/mode/thought_level selection) */
export interface AcpConfigOption {
    category: 'model' | 'mode' | 'thought_level' | 'other';
    configId: string;
    currentValue?: string;
    options: {
        value: string;
        name: string;
        description?: string;
        group?: string;
    }[];
}
/** ACP mode */
export interface AcpMode {
    id: string;
    name: string;
    description?: string;
}
/** Provider control schema transmitted to frontend */
export interface ProviderControlSchema {
    id: string;
    type: 'select' | 'toggle' | 'cycle' | 'slider' | 'action' | 'display';
    label: string;
    icon?: string;
    placement: 'bar' | 'header' | 'menu';
    /** Static options (for select/cycle) */
    options?: {
        value: string;
        label: string;
        description?: string;
        group?: string;
    }[];
    /** Dynamic options — frontend should call listScript to load */
    dynamic?: boolean;
    /** Script name to list options */
    listScript?: string;
    /** Script name to change value (value-based controls) */
    setScript?: string;
    /** Field name in readChat result for current value */
    readFrom?: string;
    /** Default value */
    defaultValue?: string | number | boolean;
    /** Script name to invoke (action type) */
    invokeScript?: string;
    /** How to display action result */
    resultDisplay?: 'toast' | 'inline' | 'none';
    /** Slider range */
    min?: number;
    max?: number;
    step?: number;
    /** Sort order */
    order?: number;
}
/** Machine hardware/OS info (reported by daemon, displayed by web) */
export interface MachineInfo {
    hostname: string;
    platform: string;
    arch?: string;
    cpus?: number;
    totalMem?: number;
    freeMem?: number;
    /** macOS: reclaimable-inclusive; prefer for UI used% */
    availableMem?: number;
    loadavg?: number[];
    uptime?: number;
    release?: string;
}
/** Detected IDE on a machine */
export interface DetectedIdeInfo {
    type: string;
    id?: string;
    name: string;
    running: boolean;
    path?: string;
}
export type { RecentSessionBucket, TerminalBackendStatus } from './shared-types-extra.js';
import type { RecentSessionBucket } from './shared-types-extra.js';
import type { TerminalBackendStatus } from './shared-types-extra.js';
export interface RecentLaunchEntry {
    id: string;
    providerType: string;
    providerName: string;
    kind: 'ide' | 'cli' | 'acp';
    providerSessionId?: string;
    title?: string;
    workspace?: string | null;
    summaryMetadata?: ProviderSummaryMetadata;
    lastLaunchedAt: number;
}
/** Compact machine payload broadcast by UserSessionDO to cloud dashboards. */
export interface CompactDaemonEntry {
    id: string;
    type?: string;
    machineId?: string;
    platform?: string;
    hostname?: string;
    nickname?: string;
    p2p?: StatusReportPayload['p2p'];
    cdpConnected?: boolean;
    timestamp?: number;
    version?: string;
    serverVersion?: string;
    versionMismatch?: boolean;
    terminalBackend?: TerminalBackendStatus;
    detectedIdes?: DetectedIdeInfo[];
    availableProviders?: AvailableProviderInfo[];
    sessions?: CompactSessionEntry[];
}
export interface StatusReportPayload {
    /** Unique daemon instance identifier */
    instanceId: string;
    /** Daemon version (metadata/full snapshots only) */
    version?: string;
    /** Machine info */
    machine: MachineInfo;
    /** Machine nickname (user-set) */
    machineNickname?: string | null;
    /** Timestamp */
    timestamp: number;
    /** Detected IDEs on this machine (metadata snapshot only) */
    detectedIdes?: DetectedIdeInfo[];
    /** P2P state */
    p2p?: {
        available: boolean;
        state: string;
        peers: number;
        screenshotActive?: boolean;
    };
    /** Canonical daemon runtime sessions */
    sessions: SessionEntry[];
    /** Saved workspaces */
    workspaces?: WorkspaceEntry[];
    defaultWorkspaceId?: string | null;
    defaultWorkspacePath?: string | null;
    terminalSizingMode?: 'measured' | 'fit';
    recentLaunches?: RecentLaunchEntry[];
    terminalBackend?: TerminalBackendStatus;
    /** Available providers (present in StatusSnapshot, optional in raw payload) */
    availableProviders?: AvailableProviderInfo[];
}
