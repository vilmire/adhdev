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
    WorkspaceActivity,
    ActiveChatData,
    AvailableProviderInfo,
} from '@adhdev/daemon-core';

// Re-export shared types for convenience
export type {
    SessionEntry,
    AgentSessionStream,
    AcpConfigOption,
    AcpMode,
    StatusReportPayload,
    MachineInfo,
    DetectedIdeInfo,
    WorkspaceEntry,
    WorkspaceActivity,
    ActiveChatData,
    ChatMessage,
    AvailableProviderInfo,
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
    sessionKind?: 'workspace' | 'agent';
    transport?: 'cdp-page' | 'cdp-webview' | 'pty' | 'acp';
    mode?: 'terminal' | 'chat';
    version?: string;
    platform?: string;
    hostname?: string;
    nickname?: string;
    status: 'online' | 'idle' | 'offline';
    connectedAt?: string;
    uptime?: number;
    agents?: WebAgentInfo[];
    openFiles?: { path: string; language: string; isDirty: boolean }[];
    activeFile?: string | null;
    terminals?: number;
    chats?: WebChatInfo[];
    activeChat?: ActiveChatData | null;
    workspace?: string | null;
    cdpConnected?: boolean;
    currentModel?: string;
    currentPlan?: string;
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
    workspaceActivity?: WorkspaceActivity[];
    aiAgents?: WebAiAgentInfo[];
}

// Backward compatibility alias for web-core components
export type DaemonData = BaseDaemonData;

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected'
