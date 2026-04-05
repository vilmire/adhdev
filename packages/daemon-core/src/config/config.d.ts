/**
 * ADHDev Launcher — Configuration
 *
 * Manages launcher config, machine auth, and user preferences.
 */
import type { WorkspaceEntry } from './workspaces.js';
import type { RecentActivityEntry } from './recent-activity.js';
import type { SavedProviderSessionEntry } from './saved-sessions.js';
export type { WorkspaceEntry } from './workspaces.js';
export type { RecentActivityEntry } from './recent-activity.js';
export type { SavedProviderSessionEntry } from './saved-sessions.js';
export interface ADHDevConfig {
    serverUrl: string;
    selectedIde: string | null;
    configuredIdes: string[];
    installedExtensions: string[];
    userEmail: string | null;
    userName: string | null;
    setupCompleted: boolean;
    setupDate: string | null;
    enabledIdes: string[];
    /** Saved workspaces for IDE/CLI/ACP launch (daemon-local) */
    workspaces?: WorkspaceEntry[];
    /** Default workspace id (from workspaces[]) — never used implicitly for launch */
    defaultWorkspaceId?: string | null;
    /** Unified recent activity across IDE / CLI / ACP launch flows */
    recentActivity?: RecentActivityEntry[];
    /** Persistent resume-capable provider sessions keyed by providerSessionId */
    savedProviderSessions?: SavedProviderSessionEntry[];
    /** Last seen timestamps for live sessions, keyed by sessionId */
    sessionReads?: Record<string, number>;
    /** Last seen completion marker for live sessions, keyed by sessionId */
    sessionReadMarkers?: Record<string, string>;
    machineNickname: string | null;
    /**
     * Stable local machine ID (prefix: `mach_`) — generated locally on first run.
     * Used as daemon instance key (`daemon_<machineId>`) and in status reports.
     */
    machineId?: string;
    machineSecret?: string | null;
    providerSettings: Record<string, Record<string, any>>;
    ideSettings: Record<string, {
        extensions?: Record<string, {
            enabled: boolean;
        }>;
    }>;
    disableUpstream?: boolean;
    providerDir?: string;
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
