/**
 * ADHDev Launcher — Configuration
 * 
 * Manages launcher config, server connection tokens, and user preferences.
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { migrateWorkspacesFromRecent } from './workspaces.js';
import type { WorkspaceEntry } from './workspaces.js';
import type { WorkspaceActivityEntry } from './workspace-activity.js';
export type { WorkspaceEntry } from './workspaces.js';
export type { WorkspaceActivityEntry } from './workspace-activity.js';

export interface ADHDevConfig {
 // Server connection
    serverUrl: string;
    apiToken: string | null;
    connectionToken: string | null;

 // Selected IDE (primary)
    selectedIde: string | null;

 // All configured IDEs (multiple)
    configuredIdes: string[];

 // Installed extensions
    installedExtensions: string[];

 // User preferences
    autoConnect: boolean;
    /**
     * @deprecated Not read at runtime. Notification preferences are now managed by:
     * - Web UI layer: useNotificationPrefs (localStorage)
     * - Daemon layer: per-provider settings (approvalAlert, longGeneratingAlert)
     * Kept for backward config compat — will be removed in v0.7+.
     */
    notifications: boolean;

 // Auth
    userEmail: string | null;
    userName: string | null;

 // Setup state
    setupCompleted: boolean;
    setupDate: string | null;

 // Configured CLI agents
    configuredCLIs: string[];

 // Daemon: which IDEs to connect (empty = all)
    enabledIdes: string[];
    recentCliWorkspaces: string[];

 /** Saved workspaces for IDE/CLI/ACP launch (daemon-local) */
    workspaces?: WorkspaceEntry[];
 /** Default workspace id (from workspaces[]) — never used implicitly for launch */
    defaultWorkspaceId?: string | null;

 /** Recently used workspaces (IDE / CLI / ACP / default) for quick resume */
    recentWorkspaceActivity?: WorkspaceActivityEntry[];

 // Machine nickname (user-customizable label for this machine)
    machineNickname: string | null;

 // Stable machine ID (prevents duplicate daemon entries when OS hostname changes dynamically)
    machineId?: string;

 // Machine secret for server auth (replaces connectionToken)
    machineSecret?: string | null;

 // CLI launch history
    cliHistory: CliHistoryEntry[];

 // Per-provider user config (public setting values)
    providerSettings: Record<string, Record<string, any>>;

 // Per-IDE extension config (per-IDE on/off control)
    ideSettings: Record<string, {
        extensions?: Record<string, { enabled: boolean }>;
    }>;

 // Disable upstream provider auto-download (use builtin only)
 // Controllable from CLI (--no-upstream) and dashboard (machine page)
    disableUpstream?: boolean;

 // Optional custom provider directory for local development
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

const DEFAULT_CONFIG: ADHDevConfig = {
    serverUrl: 'https://api.adhf.dev',
    apiToken: null,
    connectionToken: null,
    selectedIde: null,
    configuredIdes: [],
    installedExtensions: [],
    autoConnect: true,
    notifications: true,
    userEmail: null,
    userName: null,
    setupCompleted: false,
    setupDate: null,
    configuredCLIs: [],
    enabledIdes: [],
    recentCliWorkspaces: [],
    workspaces: [],
    defaultWorkspaceId: null,
    recentWorkspaceActivity: [],
    machineNickname: null,
    machineId: undefined,
    machineSecret: null,
    cliHistory: [],
    providerSettings: {},
    ideSettings: {},
    disableUpstream: false,
};

/**
 * Get the config directory path
 */
export function getConfigDir(): string {
    const dir = join(homedir(), '.adhdev');
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    return dir;
}

/**
 * Get the config file path
 */
function getConfigPath(): string {
    return join(getConfigDir(), 'config.json');
}

/**
 * Load configuration from disk
 */
export function loadConfig(): ADHDevConfig {
    const configPath = getConfigPath();

    if (!existsSync(configPath)) {
        return { ...DEFAULT_CONFIG };
    }

    try {
        const raw = readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(raw);
        const merged = { ...DEFAULT_CONFIG, ...parsed } as ADHDevConfig & { activeWorkspaceId?: string | null };
        if (merged.defaultWorkspaceId == null && merged.activeWorkspaceId != null) {
            (merged as ADHDevConfig).defaultWorkspaceId = merged.activeWorkspaceId;
        }
        delete (merged as any).activeWorkspaceId;
        const hadStoredWorkspaces = Array.isArray(parsed.workspaces) && parsed.workspaces.length > 0;
        migrateWorkspacesFromRecent(merged);
        
        let configChanged = false;
        if (!merged.machineId) {
            const os = require('os');
            const crypto = require('crypto');
            const safeHostname = os.hostname().replace(/[^a-zA-Z0-9]/g, '_');
            const machineHash = crypto.createHash('md5').update(os.hostname() + os.homedir()).digest('hex').slice(0, 8);
            merged.machineId = `${safeHostname}_${machineHash}`;
            configChanged = true;
        }

        if (!hadStoredWorkspaces && (merged.workspaces?.length || 0) > 0) {
            configChanged = true;
        }

        if (configChanged) {
            try {
                saveConfig(merged);
            } catch { /* ignore */ }
        }
        return merged;
    } catch {
        return { ...DEFAULT_CONFIG };
    }
}

/**
 * Save configuration to disk
 */
export function saveConfig(config: ADHDevConfig): void {
    const configPath = getConfigPath();
    const dir = getConfigDir();

    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
    try { chmodSync(configPath, 0o600); } catch { /* Windows etc. not supported */ }
}

/**
 * Update specific config fields
 */
export function updateConfig(updates: Partial<ADHDevConfig>): ADHDevConfig {
    const config = loadConfig();
    const updated = { ...config, ...updates };
    saveConfig(updated);
    return updated;
}

/**
 * Mark setup as completed
 */
export function markSetupComplete(
    ideId: string | string[],
    extensions: string[]
): ADHDevConfig {
    const ideIds = Array.isArray(ideId) ? ideId : [ideId];
    return updateConfig({
        selectedIde: ideIds[0],
        configuredIdes: ideIds,
        installedExtensions: extensions,
        setupCompleted: true,
        setupDate: new Date().toISOString(),
    });
}

/**
 * Check if setup has been completed before
 */
export function isSetupComplete(): boolean {
    const config = loadConfig();
    return config.setupCompleted;
}

/**
 * Reset configuration
 */
export function resetConfig(): void {
    saveConfig({ ...DEFAULT_CONFIG });
}

/**
 * Generate a connection token for server authentication
 */
export function generateConnectionToken(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let token = 'db_';
    for (let i = 0; i < 32; i++) {
        token += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return token;
}
/**
 * Add launch to history (max 20, dedup by category+type+dir+args+workspace+model)
 */
export function addCliHistory(entry: Omit<CliHistoryEntry, 'timestamp'>): void {
    const config = loadConfig();
    const history = config.cliHistory || [];
    const argsKey = (entry.cliArgs || []).join(' ');
    const category = entry.category || 'cli';
    const workspaceKey = entry.workspace || '';
    const modelKey = entry.model || '';
    
 // Remove duplicate (same category + type + dir + args + workspace + model)
    const filtered = history.filter(h => {
        const hArgsKey = (h.cliArgs || []).join(' ');
        return !(
            (h.category || 'cli') === category &&
            h.cliType === entry.cliType &&
            h.dir === entry.dir &&
            hArgsKey === argsKey &&
            (h.workspace || '') === workspaceKey &&
            (h.model || '') === modelKey
        );
    });
    
 // Add to front
    filtered.unshift({
        ...entry,
        category,
        timestamp: Date.now(),
        label: entry.label || (() => {
            const base = `${entry.cliType} · ${entry.dir.split('/').filter(Boolean).pop() || 'root'}`;
            const suffix: string[] = [];
            if (entry.workspace && entry.workspace !== entry.dir) suffix.push(entry.workspace.split('/').filter(Boolean).pop() || entry.workspace);
            if (entry.model) suffix.push(`model=${entry.model}`);
            if (argsKey) suffix.push(argsKey);
            if (entry.newWindow) suffix.push('new window');
            return suffix.length > 0 ? `${base} (${suffix.join(' · ')})` : base;
        })(),
    });
    
 // Keep max 20
    config.cliHistory = filtered.slice(0, 20);
    saveConfig(config);
}
