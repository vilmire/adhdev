/**
 * ADHDev Web Core — shared type definitions
 */

import type {
    AgentSessionStream,
    BeaconDiagnosticsSummary,
    FleetStatusPeerView,
    MachineInfo,
    DetectedIdeInfo,
    WorkspaceEntry,
    AvailableProviderInfo,
    ProviderResumeCapability,
    SessionEntry,
    SessionTransport,
    GitCompactSummary,
    RuntimeWriteOwner,
    RuntimeAttachedClient,
    TerminalBackendStatus,
    MessageInputSupport,
} from '@adhdev/daemon-core';
import type { InteractivePrompt } from '@adhdev/daemon-core';

// Re-export shared types for convenience
export type {
    SessionEntry,
    SessionTransport,
    RuntimeWriteOwner,
    RuntimeAttachedClient,
    SessionStatus,
    RecentSessionBucket,
    TerminalBackendStatus,
    AgentSessionStream,
    ReadChatCursor,
    ReadChatSyncResult,
    AcpConfigOption,
    AcpMode,
    StatusReportPayload,
    BeaconDiagnosticsSummary,
    FleetStatusPeerEntry,
    FleetStatusPeerView,
    MachineInfo,
    DetectedIdeInfo,
    WorkspaceEntry,
    ActiveChatData,
    ChatMessage,
    AvailableProviderInfo,
    DashboardBootstrapDaemonEntry,
    DashboardStatusEventPayload,
    DaemonStatusEventPayload,
    ProviderResumeCapability,
    MessageInputSupport,
} from '@adhdev/daemon-core';

export interface RecentLaunchEntry {
    id: string;
    providerType: string;
    providerName: string;
    kind: 'ide' | 'cli' | 'acp';
    providerSessionId?: string;
    title?: string;
    workspace?: string | null;
    summaryMetadata?: {
        items: Array<{
            id: string;
            value: string;
            label?: string;
            shortValue?: string;
            icon?: string;
            order?: number;
        }>;
    };
    lastLaunchedAt: number;
}

export interface WebAgentInfo {
    name: string;
    type: string;
    status: string;
    version?: string;
}

export interface WebChatInfo {
    id: string;
    title: string;
    status?: string;
}

export interface WebAiAgentInfo {
    id: string;
    name: string;
    status: string;
    version?: string;
}

export type WebVersionUpdateReason =
    | 'force_update_below'
    | 'major_minor_mismatch'
    | 'patch_mismatch'
    | 'daemon_ahead';

export type WebReleaseChannel = 'stable' | 'preview';
export type WebNpmTag = 'latest' | 'next';

export interface WebVersionUpdatePolicy {
    channel: WebReleaseChannel;
    npmTag: WebNpmTag;
    targetVersion: string;
    minVersion?: string;
    updateCommand: string;
}

export interface BaseDaemonData {
    id: string;
    sessionId?: string;
    providerSessionId?: string;
    parentSessionId?: string | null;
    type: string;
    /** Provider type alias used for CLI/ACP sessions */
    agentType?: string;
    sessionKind?: 'workspace' | 'agent';
    transport?: SessionTransport;
    mode?: 'terminal' | 'chat';
    version?: string;
    serverVersion?: string;
    versionMismatch?: boolean;
    versionUpdateRequired?: boolean;
    versionUpdateReason?: WebVersionUpdateReason;
    releaseChannel?: WebReleaseChannel;
    updateChannel?: WebReleaseChannel;
    updatePolicy?: WebVersionUpdatePolicy;
    updateCommand?: string;
    platform?: string;
    hostname?: string;
    nickname?: string;
    status: string;
    title?: string;
    connectedAt?: string;
    uptime?: number;
    agents?: WebAgentInfo[];
    openFiles?: { path: string; language: string; isDirty: boolean }[];
    activeFile?: string | null;
    terminals?: number;
    chats?: WebChatInfo[];
    activeChat?: SessionEntry['activeChat'];
    activeInteractivePrompt?: InteractivePrompt | null;
    workspace?: string | null;
    git?: GitCompactSummary;
    runtimeKey?: string;
    runtimeDisplayName?: string;
    runtimeWorkspaceLabel?: string;
    runtimeWriteOwner?: RuntimeWriteOwner | null;
    runtimeAttachedClients?: RuntimeAttachedClient[];
    resume?: ProviderResumeCapability;
    cdpConnected?: boolean;
    daemonId?: string;
    instanceId?: string;
    timestamp?: number;
    _lastUpdate?: number;
    cliName?: string;
    currentConfig?: {
        cli: string;
        dir: string;
        homeDir: string;
    };
    childSessions?: SessionEntry[];
    agentStreams?: AgentSessionStream[];
    availableProviders?: AvailableProviderInfo[];

    machine?: MachineInfo;
    system?: Partial<MachineInfo>;
    p2p?: {
        available: boolean;
        state: string;
        peers: number;
        screenshotActive?: boolean;
    };
    detectedIdes?: DetectedIdeInfo[];
    /**
     * seqscribe Beacon staleness / sole-copy advisory (design §7.1).
     *
     * ★ Arrives over P2P ONLY. The server WS status path carries no beacon
     * field at all (`buildCloudStatusReportPayload` is a fixed-key allow-list
     * that excludes it), because this object holds topic names and peer writer
     * ids. So a machine card renders the badge only when the dashboard has a
     * live P2P link — which is correct: it is advisory replication detail, not
     * routing metadata, and the cloud is not supposed to know it.
     */
    beacon?: BeaconDiagnosticsSummary;
    /** Latest fixed-key fleet.status entries observed by this daemon over SUB. */
    fleetStatusPeerView?: FleetStatusPeerView;
    machineNickname?: string | null;
    machineId?: string | null;
    sessionCapabilities?: string[];
    workspaces?: WorkspaceEntry[];
    defaultWorkspaceId?: string | null;
    defaultWorkspacePath?: string | null;
    terminalSizingMode?: 'measured' | 'fit';
    recentLaunches?: RecentLaunchEntry[];
    terminalBackend?: TerminalBackendStatus;
    aiAgents?: WebAiAgentInfo[];
    // ── Inbox / recent session metadata ──
    /** Whether this session has unread content */
    unread?: boolean;
    /** Timestamp of last user interaction */
    lastSeenAt?: number;
    /** Last activity timestamp used by daemon unread calculations */
    lastUpdated?: number;
    /** Inbox categorization bucket */
    inboxBucket?: import('@adhdev/daemon-core').RecentSessionBucket;
    completionMarker?: string;
    seenCompletionMarker?: string;
    surfaceHidden?: boolean;
    muted?: boolean;
    lastMessagePreview?: string;
    lastMessageRole?: string;
    lastMessageAt?: number;
    lastMessageHash?: string;
    /** Provider control current values */
    controlValues?: Record<string, string | number | boolean>;
    /** Provider-declared controls schema */
    providerControls?: import('@adhdev/daemon-core').ProviderControlSchema[];
    /** Flexible always-visible metadata for compact/live surfaces. */
    summaryMetadata?: {
        items: Array<{
            id: string;
            value: string;
            label?: string;
            shortValue?: string;
            icon?: string;
            order?: number;
        }>;
    };
    // ── Discriminator flags (set by status-transform) ──
    /** @internal CLI session marker */
    _isCli?: boolean;
    /** @internal ACP session marker */
    _isAcp?: boolean;
    /** @internal Status payload included an explicit sessions list, even if empty. */
    _sessionListAuthoritative?: boolean;
    settings?: Record<string, any>;
    /**
     * True owning-daemon id for a session a coordinator synthesises into its own
     * snapshot (mesh delegated sessions). Used to attribute the session's machine to
     * the worker node instead of the coordinator daemon hosting the snapshot.
     */
    ownerDaemonId?: string;
    /** True owning-machine display name fallback when the owning daemon is not aggregated. */
    ownerMachineName?: string;
    /** Set when this session is acting as a mesh coordinator for the given mesh. */
    coordinator?: { meshId: string; role: 'coordinator' };
    meshQueueStats?: {
        total?: number;
        active?: number;
        historical?: number;
        pending: number;
        assigned: number;
        completed: number;
        failed: number;
        cancelled?: number;
    };
    /** Effective message input/media support for this session. Fail-closed to text-only when absent. */
    messageInput?: MessageInputSupport;
}

// Backward compatibility alias for web-core components
export type DaemonData = BaseDaemonData;

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected'
