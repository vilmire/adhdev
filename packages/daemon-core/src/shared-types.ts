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
import type { ActiveChatData as _ActiveChatData, ProviderErrorReason as _ProviderErrorReason } from './providers/provider-instance.js';
import type { WorkspaceEntry } from './config/workspaces.js';
import type { ProviderResumeCapability } from './providers/contracts.js';

// Re-export WorkspaceEntry for downstream consumers
export type { WorkspaceEntry } from './config/workspaces.js';

// ─── Managed Entry Types (reporter → server/web) ────────────────────
// These define the shape of data sent by DaemonStatusReporter
// and consumed by web-core and downstream consumers.

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
    activeModal: { message: string; buttons: string[] } | null;
}

export type SessionTransport = 'cdp-page' | 'cdp-webview' | 'pty' | 'acp';

export type SessionKind = 'workspace' | 'agent';

export type SessionCapability =
    | 'read_chat'
    | 'send_message'
    | 'new_session'
    | 'list_sessions'
    | 'switch_session'
    | 'resolve_action'
    | 'terminal_io'
    | 'resize_terminal'
    | 'change_model'
    | 'set_mode'
    | 'set_thought_level';

export interface SessionEntry {
    id: string;
    parentId: string | null;
    providerType: string;
    providerName: string;
    kind: SessionKind;
    transport: SessionTransport;
    status: 'idle' | 'generating' | 'waiting_approval' | 'error' | 'stopped' | 'starting' | 'panel_hidden' | 'not_monitored' | 'disconnected';
    title: string;
    workspace: string | null;
    runtimeKey?: string;
    runtimeDisplayName?: string;
    runtimeWorkspaceLabel?: string;
    runtimeWriteOwner?: {
        clientId: string;
        ownerType: 'agent' | 'user';
    } | null;
    runtimeAttachedClients?: {
        clientId: string;
        type: 'daemon' | 'web' | 'local-terminal';
        readOnly: boolean;
    }[];
    resume?: ProviderResumeCapability;
    activeChat: _ActiveChatData | null;
    capabilities: SessionCapability[];
    cdpConnected?: boolean;
    currentModel?: string;
    currentPlan?: string;
    currentAutoApprove?: string;
    acpConfigOptions?: AcpConfigOption[];
    acpModes?: AcpMode[];
    errorMessage?: string;
    errorReason?: _ProviderErrorReason;
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
    /** Canonical daemon runtime sessions */
    sessions: SessionEntry[];
    /** Saved workspaces */
    workspaces?: WorkspaceEntry[];
    defaultWorkspaceId?: string | null;
    defaultWorkspacePath?: string | null;
    workspaceActivity?: WorkspaceActivity[];
}
