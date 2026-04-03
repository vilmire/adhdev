/**
 * ADHDev Web Core — shared type definitions
 */

import type {
    AgentSessionStream,
    AcpConfigOption,
    AcpMode,
    MachineInfo,
    DetectedIdeInfo,
    WorkspaceEntry,
    ActiveChatData,
    AvailableProviderInfo,
    ProviderResumeCapability,
    RecentSessionEntry,
    SessionEntry,
    SessionTransport,
    RuntimeWriteOwner,
    RuntimeAttachedClient,
    TerminalBackendStatus,
} from '@adhdev/daemon-core';

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
    AcpConfigOption,
    AcpMode,
    StatusReportPayload,
    MachineInfo,
    DetectedIdeInfo,
    WorkspaceEntry,
    ActiveChatData,
    ChatMessage,
    AvailableProviderInfo,
    ProviderResumeCapability,
    RecentSessionEntry,
} from '@adhdev/daemon-core';

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

export interface BaseDaemonData {
    id: string;
    sessionId?: string;
    parentSessionId?: string | null;
    type: string;
    /** Provider type alias used for IDE sessions */
    ideType?: string;
    /** Provider type alias used for CLI/ACP sessions */
    agentType?: string;
    sessionKind?: 'workspace' | 'agent';
    transport?: SessionTransport;
    mode?: 'terminal' | 'chat';
    version?: string;
    platform?: string;
    hostname?: string;
    nickname?: string;
    status: string;
    connectedAt?: string;
    uptime?: number;
    agents?: WebAgentInfo[];
    openFiles?: { path: string; language: string; isDirty: boolean }[];
    activeFile?: string | null;
    terminals?: number;
    chats?: WebChatInfo[];
    activeChat?: ActiveChatData | null;
    workspace?: string | null;
    runtimeKey?: string;
    runtimeDisplayName?: string;
    runtimeWorkspaceLabel?: string;
    runtimeWriteOwner?: RuntimeWriteOwner | null;
    runtimeAttachedClients?: RuntimeAttachedClient[];
    resume?: ProviderResumeCapability;
    cdpConnected?: boolean;
    currentModel?: string;
    currentPlan?: string;
    currentAutoApprove?: string;
    daemonId?: string;
    instanceId?: string;
    timestamp?: number;
    _lastUpdate?: number;
    cliName?: string;
    acpConfigOptions?: AcpConfigOption[];
    acpModes?: AcpMode[];
    currentConfig?: {
        cli: string;
        dir: string;
        homeDir: string;
    };
    childSessions?: SessionEntry[];
    agentStreams?: AgentSessionStream[];
    availableProviders?: AvailableProviderInfo[];
    daemonMode?: boolean;
    machine?: MachineInfo;
    system?: Partial<MachineInfo>;
    p2p?: {
        available: boolean;
        state: string;
        peers: number;
        screenshotActive?: boolean;
    };
    detectedIdes?: DetectedIdeInfo[];
    machineNickname?: string | null;
    machineId?: string | null;
    sessionCapabilities?: string[];
    workspaces?: WorkspaceEntry[];
    defaultWorkspaceId?: string | null;
    defaultWorkspacePath?: string | null;
    recentSessions?: RecentSessionEntry[];
    terminalBackend?: TerminalBackendStatus;
    aiAgents?: WebAiAgentInfo[];
    // ── Inbox / recent session metadata ──
    /** Unique key for recent session tracking */
    recentKey?: string;
    /** Whether this session has unread content */
    unread?: boolean;
    /** Timestamp of last user interaction */
    lastSeenAt?: number;
    /** Inbox categorization bucket */
    inboxBucket?: import('@adhdev/daemon-core').RecentSessionBucket;
    surfaceHidden?: boolean;
    /** Provider control current values */
    controlValues?: Record<string, string | number | boolean>;
    /** Provider-declared controls schema */
    providerControls?: import('@adhdev/daemon-core').ProviderControlSchema[];
    // ── Discriminator flags (set by status-transform) ──
    /** @internal CLI session marker */
    _isCli?: boolean;
    /** @internal ACP session marker */
    _isAcp?: boolean;
}

// Backward compatibility alias for web-core components
export type DaemonData = BaseDaemonData;

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected'
