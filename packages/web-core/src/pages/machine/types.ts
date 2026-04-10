/**
 * MachineDetail — Shared types & utils for machine sub-tabs.
 */

import type { SessionEntry, RuntimeWriteOwner, RuntimeAttachedClient, AvailableProviderInfo } from '../../types'

// ─── Types ───────────────────────────────────────────
export interface IdeSessionEntry {
    id: string; sessionId?: string; type: string; version: string; instanceId: string; status: string
    workspace: string | null; terminals: number
    aiAgents: { id: string; name: string; status: string; version?: string }[]
    activeChat: any; chats: any[]; childSessions: SessionEntry[]
    cdpConnected: boolean; daemonId: string
}

export interface CliSessionEntry {
    id: string; sessionId?: string; type: string; cliName: string; status: string
    workspace: string; activeChat: any; daemonId: string
    providerSessionId?: string
    mode?: 'terminal' | 'chat'
    runtimeKey?: string; runtimeDisplayName?: string; runtimeWorkspaceLabel?: string
    runtimeWriteOwner?: RuntimeWriteOwner | null
    runtimeAttachedClients?: RuntimeAttachedClient[]
}

export interface AcpSessionEntry {
    id: string; sessionId?: string; type: string; acpName: string; status: string
    workspace: string; activeChat: any; daemonId: string
    providerSessionId?: string
    currentModel?: string; currentPlan?: string
}

export interface WorkspaceRow { id: string; path: string; label?: string; addedAt: number }

export interface MachineData {
    id: string; hostname: string; platform: string; arch: string
    cpus: number; totalMem: number; freeMem: number; availableMem?: number; loadavg: number[]
    uptime: number; release: string; cdpConnected: boolean; machineNickname: string | null
    p2p: { available: boolean; state: string; peers: number; screenshotActive: boolean }
    detectedIdes: { type: string; id?: string; name: string; running: boolean; path?: string }[]
    workspaces: WorkspaceRow[]
    defaultWorkspaceId: string | null
    defaultWorkspacePath: string | null
}

export interface LogEntry { timestamp: number; level: 'info' | 'warn' | 'error'; message: string }

export interface ProviderSettingsEntry {
    type: string; displayName: string; icon: string; category: string;
    schema: {
        key: string
        type: string
        default: unknown
        public: boolean
        label?: string
        description?: string
        min?: number
        max?: number
        options?: string[]
    }[];
    values: Record<string, unknown>;
}

export type WorkspaceLaunchKind = 'ide' | 'cli' | 'acp'

export type TabId = 'workspace' | 'overview' | 'session-host' | 'providers' | 'logs' | 'ides' | 'clis' | 'acps'

export type ProviderInfo = AvailableProviderInfo

export interface MachineRecentLaunch {
    id: string
    label: string
    kind: 'ide' | 'cli' | 'acp'
    providerType?: string
    providerSessionId?: string
    subtitle?: string
    workspace?: string | null
    currentModel?: string
}

export interface MachineLaunchTarget {
    id: string
    kind: WorkspaceLaunchKind
    label: string
    providerType?: string
    subtitle: string
}

export interface LaunchWorkspaceOption {
    key: string
    label: string
    description?: string
    workspaceId?: string | null
    workspacePath?: string | null
}

// ─── Utils ───────────────────────────────────────────
export { formatRelativeAgo } from '../../utils/time'

/** Shared context passed from MachineDetail to each tab component. */
export interface MachineTabContext {
    machineId: string
    machine: MachineData
    ideSessions: IdeSessionEntry[]
    cliSessions: CliSessionEntry[]
    acpSessions: AcpSessionEntry[]
    providers: ProviderInfo[]
    getIcon: (type: string) => string
    addLog: (level: LogEntry['level'], message: string) => void
    sendDaemonCommand: (daemonId: string, type: string, data?: Record<string, unknown>) => Promise<any>
}
