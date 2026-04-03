/**
 * ADHDev Launcher — Configuration
 *
 * Manages launcher config, server connection tokens, and user preferences.
 */
import type { WorkspaceEntry } from './workspaces.js';
import type { WorkspaceActivityEntry } from './workspace-activity.js';
import type { RecentActivityEntry } from './recent-activity.js';
export type { WorkspaceEntry } from './workspaces.js';
export type { WorkspaceActivityEntry } from './workspace-activity.js';
export type { RecentActivityEntry } from './recent-activity.js';
export interface ADHDevConfig {
    serverUrl: string;
    apiToken: string | null;
    connectionToken: string | null;
    selectedIde: string | null;
    configuredIdes: string[];
    installedExtensions: string[];
    autoConnect: boolean;
    /**
     * @deprecated Not read at runtime. Notification preferences are now managed by:
     * - Web UI layer: useNotificationPrefs (localStorage)
     * - Daemon layer: per-provider settings (approvalAlert, longGeneratingAlert)
     * Kept for backward config compat — will be removed in v0.7+.
     */
    notifications: boolean;
    userEmail: string | null;
    userName: string | null;
    setupCompleted: boolean;
    setupDate: string | null;
    configuredCLIs: string[];
    enabledIdes: string[];
    recentCliWorkspaces: string[];
    /** Saved workspaces for IDE/CLI/ACP launch (daemon-local) */
    workspaces?: WorkspaceEntry[];
    /** Default workspace id (from workspaces[]) — never used implicitly for launch */
    defaultWorkspaceId?: string | null;
    /** Recently used workspaces (IDE / CLI / ACP / default) for quick resume */
    recentWorkspaceActivity?: WorkspaceActivityEntry[];
    /** Unified recent activity across IDE / CLI / ACP launch flows */
    recentActivity?: RecentActivityEntry[];
    machineNickname: string | null;
    /**
     * Stable local machine ID (prefix: `mach_`) — generated locally on first run.
     * Used as daemon instance key (`daemon_<machineId>`) and in status reports.
     * NOT the same as the server-side D1 `machines.id` — see `registeredMachineId`.
     */
    machineId?: string;
    machineSecret?: string | null;
    /**
     * Server-side D1 `machines.id` — the row ID assigned when daemon registers via
     * `POST /cli/complete`. Corresponds to `machineId` in server DO context
     * (`DaemonConnection.machineId`, `StatusContext.machineId`).
     *
     * Naming differs from server-side `machineId` to avoid confusion with the local
     * `config.machineId` (mach_ prefix) which is a different value.
     *
     * @deprecated Legacy bridge field — will be removed after 2026-04-06.
     * Modern auth flow uses `machineSecret` (adm_) to identify machines.
     */
    registeredMachineId?: string;
    cliHistory: CliHistoryEntry[];
    providerSettings: Record<string, Record<string, any>>;
    ideSettings: Record<string, {
        extensions?: Record<string, {
            enabled: boolean;
        }>;
    }>;
    disableUpstream?: boolean;
    providerDir?: string;
}
export interface CliHistoryEntry {
    category?: 'ide' | 'cli' | 'acp';
    cliType: string;
    dir: string;
    cliArgs?: string[];
    workspace?: string;
    newWindow?: boolean;
    model?: string;
    timestamp: number;
    label?: string;
}
export declare function generateMachineId(): string;
export declare function isStableMachineId(machineId?: string | null): boolean;
/**
 * Get the config directory path
 */
export declare function getConfigDir(): string;
/**
 * Load configuration from disk
 */
export declare function loadConfig(): ADHDevConfig;
/**
 * Save configuration to disk
 */
export declare function saveConfig(config: ADHDevConfig): void;
/**
 * Update specific config fields
 */
export declare function updateConfig(updates: Partial<ADHDevConfig>): ADHDevConfig;
/**
 * Mark setup as completed
 */
export declare function markSetupComplete(ideId: string | string[], extensions: string[]): ADHDevConfig;
/**
 * Check if setup has been completed before
 */
export declare function isSetupComplete(): boolean;
/**
 * Reset configuration
 */
export declare function resetConfig(): void;
/**
 * Generate a connection token for server authentication
 */
export declare function generateConnectionToken(): string;
/**
 * Add launch to history (max 20, dedup by category+type+dir+args+workspace+model)
 */
export declare function addCliHistory(entry: Omit<CliHistoryEntry, 'timestamp'>): void;
