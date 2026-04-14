/**
 * ADHDev Launcher — Configuration
 *
 * Manages launcher config, machine auth, and user preferences.
 */
import type { WorkspaceEntry } from './workspaces.js';
export type { WorkspaceEntry } from './workspaces.js';
export type { RecentActivityEntry } from './recent-activity.js';
export type { SavedProviderSessionEntry } from './saved-sessions.js';
export type { DaemonState } from './state-store.js';
export type ProviderSourceMode = 'normal' | 'no-upstream';
export declare function resolveProviderSourceMode(providerSourceMode: unknown, legacyDisableUpstream: unknown): ProviderSourceMode;
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
    machineNickname: string | null;
    /**
     * Stable local machine ID (prefix: `mach_`) — generated locally on first run.
     * Used as daemon instance key (`daemon_<machineId>`) and in status reports.
     */
    machineId?: string;
    machineSecret?: string | null;
    /**
     * Server-side D1 `machines.id` — the row ID assigned when daemon registers via
     * `POST /cli/complete`. This remains useful for account-side machine actions
     * that target the registered machine row directly (for example cloud rename).
     *
     * Machine auth itself uses `machineSecret` (adm_) and no longer falls back
     * to `registeredMachineId`.
     */
    registeredMachineId?: string;
    providerSettings: Record<string, Record<string, any>>;
    ideSettings: Record<string, {
        extensions?: Record<string, {
            enabled: boolean;
        }>;
    }>;
    disableUpstream?: boolean;
    providerSourceMode?: ProviderSourceMode;
    providerDir?: string;
    /**
     * Browser terminal sizing behavior for dashboard CLI panes.
     * Default `measured` keeps terminal size daemon-authoritative.
     * `fit` opt-in restores xterm fit-based sizing for advanced users.
     */
    terminalSizingMode?: 'measured' | 'fit';
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
