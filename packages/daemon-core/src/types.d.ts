/**
 * ADHDev Daemon Core — Shared Types
 *
 * Shared types referenced by daemon-core, daemon-standalone, and web-core.
 * When modifying this file, also update interface contracts in AGENT_PROTOCOL.md.
 */
import type { StatusReportPayload } from './shared-types.js';
/** Full status response from /api/v1/status and WS events */
export interface StatusResponse extends StatusReportPayload {
    /** For standalone API compat */
    id: string;
    type: string;
    platform: string;
    hostname: string;
    /** User display name from config */
    userName?: string;
    /** Available providers */
    availableProviders: ProviderInfo[];
    /** System info (legacy compat) */
    system?: SystemInfo;
}
export interface ChatMessage {
    role: string;
    /** Plain text (legacy) or rich content blocks (ACP standard) */
    content: string | ContentBlock[];
    kind?: string;
    id?: string;
    index?: number;
    timestamp?: number;
    receivedAt?: number;
    /** Tool calls associated with this message */
    toolCalls?: ToolCallInfo[];
    /** Optional: fiber metadata */
    _type?: string;
    _sub?: string;
    /** Meta information for thought/terminal logs etc */
    meta?: {
        label?: string;
        isRunning?: boolean;
    } | Record<string, any>;
    /** Sender name for shared sessions */
    senderName?: string;
}
import type { ContentBlock, ToolCallInfo } from './providers/contracts.js';
export interface ExtensionInfo {
    id: string;
    type: string;
    name: string;
    isMonitored?: boolean;
    agentStatus?: string;
}
export interface CommandResult {
    success: boolean;
    data?: any;
    error?: string;
}
export interface ProviderConfig {
    id: string;
    type: 'ide' | 'extension' | 'cli' | 'acp';
    name: string;
    /** CDP port detection */
    cdpDetect?: {
        processName?: string;
        portFlag?: string;
    };
    /** Capabilities */
    capabilities?: string[];
}
export type DaemonEvent = {
    type: 'status';
    data: StatusResponse;
} | {
    type: 'chat_update';
    data: {
        ideId: string;
        messages: ChatMessage[];
    };
} | {
    type: 'screenshot';
    data: {
        ideId: string;
        base64: string;
    };
} | {
    type: 'action_log';
    data: {
        ideId: string;
        text: string;
        timestamp: number;
    };
} | {
    type: 'error';
    data: {
        message: string;
    };
};
export interface SystemInfo {
    cpus: number;
    totalMem: number;
    freeMem: number;
    /** macOS: reclaimable-inclusive; prefer for UI used% (see host-memory.ts) */
    availableMem?: number;
    loadavg: number[];
    uptime: number;
    arch: string;
}
export interface DetectedIde {
    id: string;
    type: string;
    name: string;
    installed: boolean;
    running: boolean;
}
export interface ProviderInfo {
    type: string;
    icon: string;
    displayName: string;
    category: string;
}
/** Flattened agent entry from /api/v1/agents */
export interface AgentEntry {
    ideId: string;
    type: string;
    name: string;
    status: string;
    source: 'native' | 'extension';
}
