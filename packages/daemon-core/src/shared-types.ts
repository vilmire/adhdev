/**
 * ADHDev Shared Types — Cross-package type definitions
 *
 * Types used across daemon-core, web-core, and downstream consumers.
 * Import via: import type { ... } from '@adhdev/daemon-core/types'
 *
 * IMPORTANT: This file must remain runtime-free (types only).
 */

import type {
    StatusResponse,
    ChatMessage,
    ExtensionInfo,
    SystemInfo,
    DetectedIde,
    AgentEntry,
} from './types.js';

export type {
    StatusResponse,
    ChatMessage,
    ExtensionInfo,
    SystemInfo,
    DetectedIde,
    AgentEntry,
};

// Re-export provider types (except ProviderErrorReason which is defined below)
export type {
    ProviderState,
    ProviderStatus,
    ActiveChatData,
    IdeProviderState,
    CliProviderState,
    AcpProviderState,
    ExtensionProviderState,
    ProviderEvent,
} from './providers/provider-instance.js';

// Re-export ProviderErrorReason (defined in this file, imported by provider-instance)
export type { ProviderErrorReason } from './providers/provider-instance.js';

// Local import for use in Managed*Entry types below
import type { ActiveChatData as _ActiveChatData } from './providers/provider-instance.js';
import type { WorkspaceEntry } from './config/workspaces.js';

// Re-export WorkspaceEntry for downstream consumers
export type { WorkspaceEntry } from './config/workspaces.js';

// ─── Managed Entry Types (reporter → server/web) ────────────────────
// These define the shape of data sent by DaemonStatusReporter
// and consumed by web-core and downstream consumers.

/** IDE entry as reported by daemon to dashboard */
export interface ManagedIdeEntry {
    ideType: string;
    ideVersion: string;
    instanceId: string;
    workspace: string | null;
    terminals: number;
    aiAgents: unknown[];
    activeChat: _ActiveChatData | null;
    chats: unknown[];
    agentStreams: ManagedAgentStream[];
    cdpConnected: boolean;
    currentModel?: string;
    currentPlan?: string;
    currentAutoApprove?: string;
}

/** CLI entry as reported by daemon to dashboard */
export interface ManagedCliEntry {
    id: string;
    instanceId: string;
    cliType: string;
    cliName: string;
    status: string;
    mode: 'terminal' | 'chat';
    workspace: string;
    activeChat: _ActiveChatData | null;
}

/** ACP entry as reported by daemon to dashboard */
export interface ManagedAcpEntry {
    id: string;
    acpType: string;
    acpName: string;
    status: string;
    mode: 'chat';
    workspace: string;
    activeChat: _ActiveChatData | null;
    currentModel?: string;
    currentPlan?: string;
    acpConfigOptions?: AcpConfigOption[];
    acpModes?: AcpMode[];
    /** Error details */
    errorMessage?: string;
    errorReason?: 'not_installed' | 'auth_failed' | 'spawn_error' | 'init_failed' | 'crash' | 'timeout' | 'cdp_error' | 'disconnected';
}

/** Agent stream within an IDE (extension status) */
export interface ManagedAgentStream {
    agentType: string;
    agentName: string;
    extensionId: string;
    status: string;
    messages: ChatMessage[];
    inputContent: string;
    model?: string;
    activeModal: { message: string; buttons: string[] } | null;
}

/** Available provider information */
export interface AvailableProviderInfo {
    type: string;
    name: string;
    category: 'ide' | 'extension' | 'cli' | 'acp';
    displayName: string;
    icon: string;
}

/** ACP config option (model/mode/thought_level selection) */
export interface AcpConfigOption {
    category: 'model' | 'mode' | 'thought_level' | 'other';
    configId: string;
    currentValue?: string;
    options: { value: string; name: string; description?: string; group?: string }[];
}

/** ACP mode */
export interface AcpMode {
    id: string;
    name: string;
    description?: string;
}

// ─── Common Sub-Types (used across StatusReportPayload, BaseDaemonData, etc.) ──

/** Machine hardware/OS info (reported by daemon, displayed by web) */
export interface MachineInfo {
    hostname: string;
    platform: string;
    arch: string;
    cpus: number;
    totalMem: number;
    freeMem: number;
    /** macOS: reclaimable-inclusive; prefer for UI used% */
    availableMem?: number;
    loadavg: number[];
    uptime: number;
    release: string;
}

/** Detected IDE on a machine */
export interface DetectedIdeInfo {
    type: string;
    id?: string;
    name: string;
    running: boolean;
    path?: string;
}

/** Workspace recent activity */
export interface WorkspaceActivity {
    path: string;
    lastUsedAt: number;
    kind?: string;
    agentType?: string;
}

// ─── Status Report Payload (daemon → server) ────────────────────────
// Full payload shape sent via WebSocket status_report

export interface StatusReportPayload {
    /** Daemon instance ID */
    instanceId: string;
    /** Daemon version */
    version: string;
    /** Daemon mode flag */
    daemonMode: boolean;
    /** Machine info */
    machine: MachineInfo;
    /** Machine nickname (user-set) */
    machineNickname?: string | null;
    /** Timestamp */
    timestamp: number;
    /** Detected IDEs on this machine */
    detectedIdes: DetectedIdeInfo[];
    /** P2P state */
    p2p?: { available: boolean; state: string; peers: number; screenshotActive?: boolean };
    /** Managed IDE instances */
    managedIdes: ManagedIdeEntry[];
    /** Managed CLI instances */
    managedClis: ManagedCliEntry[];
    /** Managed ACP instances */
    managedAcps: ManagedAcpEntry[];
    /** Saved workspaces */
    workspaces?: WorkspaceEntry[];
    defaultWorkspaceId?: string | null;
    defaultWorkspacePath?: string | null;
    workspaceActivity?: WorkspaceActivity[];
}
