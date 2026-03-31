/**
 * MachineDetail — Shared types & utils for machine sub-tabs.
 */

// ─── Types ───────────────────────────────────────────
export interface IdeSessionEntry {
    id: string; type: string; version: string; instanceId: string; status: string
    workspace: string | null; terminals: number
    aiAgents: { id: string; name: string; status: string; version?: string }[]
    activeChat: any; chats: any[]; agentStreams: any[]
    cdpConnected: boolean; daemonId: string
}

export interface CliSessionEntry {
    id: string; type: string; cliName: string; status: string
    workspace: string; activeChat: any; daemonId: string
}

export interface AcpSessionEntry {
    id: string; type: string; acpName: string; status: string
    workspace: string; activeChat: any; daemonId: string
    currentModel?: string; currentPlan?: string
}

export interface WorkspaceRow { id: string; path: string; label?: string; addedAt: number }

export interface WorkspaceActivityRow { path: string; lastUsedAt: number; kind?: string; agentType?: string }

export interface MachineData {
    id: string; hostname: string; platform: string; arch: string
    cpus: number; totalMem: number; freeMem: number; availableMem?: number; loadavg: number[]
    uptime: number; release: string; cdpConnected: boolean; machineNickname: string | null
    p2p: { available: boolean; state: string; peers: number; screenshotActive: boolean }
    detectedIdes: { type: string; id?: string; name: string; running: boolean; path?: string }[]
    workspaces: WorkspaceRow[]
    defaultWorkspaceId: string | null
    defaultWorkspacePath: string | null
    workspaceActivity: WorkspaceActivityRow[]
}

export interface LogEntry { timestamp: number; level: 'info' | 'warn' | 'error'; message: string }

export interface ProviderSettingsEntry {
    type: string; displayName: string; icon: string; category: string;
    schema: { key: string; type: string; default: any; public: boolean; label?: string; description?: string; min?: number; max?: number; options?: string[] }[];
    values: Record<string, any>;
}

export type TabId = 'overview' | 'ides' | 'clis' | 'acps' | 'providers' | 'logs'

export interface ProviderInfo {
    type: string; displayName: string; icon: string; category: string;
}

// ─── Utils ───────────────────────────────────────────
export function formatRelativeAgo(ts: number): string {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
}

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
