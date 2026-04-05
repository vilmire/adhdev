/**
 * ADHDev Launcher — Configuration
 *
 * Manages launcher config, machine auth, and user preferences.
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { randomUUID } from 'crypto';
import type { WorkspaceEntry } from './workspaces.js';
import type { RecentActivityEntry } from './recent-activity.js';
import type { SavedProviderSessionEntry } from './saved-sessions.js';
export type { WorkspaceEntry } from './workspaces.js';
export type { RecentActivityEntry } from './recent-activity.js';
export type { SavedProviderSessionEntry } from './saved-sessions.js';

export interface ADHDevConfig {
 // Server connection
    serverUrl: string;

 // Selected IDE (primary)
    selectedIde: string | null;

 // All configured IDEs (multiple)
    configuredIdes: string[];

 // Installed extensions
    installedExtensions: string[];

 // Auth
    userEmail: string | null;
    userName: string | null;

 // Setup state
    setupCompleted: boolean;
    setupDate: string | null;

 // Daemon: which IDEs to connect (empty = all)
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

 // Machine nickname (user-customizable label for this machine)
    machineNickname: string | null;

    /**
     * Stable local machine ID (prefix: `mach_`) — generated locally on first run.
     * Used as daemon instance key (`daemon_<machineId>`) and in status reports.
     */
    machineId?: string;

 // Machine secret for server auth
    machineSecret?: string | null;

    /**
     * Server-side D1 `machines.id` — the row ID assigned when daemon registers via
     * `POST /cli/complete`. Used as fallback for machine lookup on re-auth.
     *
     * @deprecated Legacy bridge field — will be removed after 2026-04-06.
     * Modern auth flow uses `machineSecret` (adm_) to identify machines.
     */
    registeredMachineId?: string;

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

const DEFAULT_CONFIG: ADHDevConfig = {
    serverUrl: 'https://api.adhf.dev',
    selectedIde: null,
    configuredIdes: [],
    installedExtensions: [],
    userEmail: null,
    userName: null,
    setupCompleted: false,
    setupDate: null,
    enabledIdes: [],
    workspaces: [],
    defaultWorkspaceId: null,
    recentActivity: [],
    savedProviderSessions: [],
    sessionReads: {},
    sessionReadMarkers: {},
    machineNickname: null,
    machineId: undefined,
    machineSecret: null,
    registeredMachineId: undefined,
    providerSettings: {},
    ideSettings: {},
    disableUpstream: false,
};

const MACHINE_ID_PREFIX = 'mach_';

function isPlainObject(value: unknown): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string');
}

function asNullableString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function asOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function normalizeConfig(raw: unknown): ADHDevConfig & { activeWorkspaceId?: string | null } {
    const parsed = isPlainObject(raw) ? raw : {};
    const legacySessionReads = isPlainObject(parsed.recentSessionReads) ? parsed.recentSessionReads : {};
    const sessionReads = isPlainObject(parsed.sessionReads) ? parsed.sessionReads : {};
    const mergedSessionReads = Object.fromEntries(
        Object.entries({ ...legacySessionReads, ...sessionReads })
            .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
    );
    const sessionReadMarkers = Object.fromEntries(
        Object.entries(isPlainObject(parsed.sessionReadMarkers) ? parsed.sessionReadMarkers : {})
            .filter(([, value]) => typeof value === 'string')
    );

    return {
        serverUrl: typeof parsed.serverUrl === 'string' && parsed.serverUrl.trim()
            ? parsed.serverUrl
            : DEFAULT_CONFIG.serverUrl,
        selectedIde: asNullableString(parsed.selectedIde),
        configuredIdes: asStringArray(parsed.configuredIdes),
        installedExtensions: asStringArray(parsed.installedExtensions),
        userEmail: asNullableString(parsed.userEmail),
        userName: asNullableString(parsed.userName),
        setupCompleted: asBoolean(parsed.setupCompleted, DEFAULT_CONFIG.setupCompleted),
        setupDate: asNullableString(parsed.setupDate),
        enabledIdes: asStringArray(parsed.enabledIdes),
        workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces as WorkspaceEntry[] : [],
        defaultWorkspaceId: asNullableString(parsed.defaultWorkspaceId) ?? asNullableString(parsed.activeWorkspaceId),
        recentActivity: Array.isArray(parsed.recentActivity) ? parsed.recentActivity as RecentActivityEntry[] : [],
        savedProviderSessions: Array.isArray(parsed.savedProviderSessions) ? parsed.savedProviderSessions as SavedProviderSessionEntry[] : [],
        sessionReads: mergedSessionReads,
        sessionReadMarkers,
        machineNickname: asNullableString(parsed.machineNickname),
        machineId: asOptionalString(parsed.machineId),
        machineSecret: parsed.machineSecret === null ? null : asOptionalString(parsed.machineSecret),
        registeredMachineId: asOptionalString(parsed.registeredMachineId),
        providerSettings: isPlainObject(parsed.providerSettings) ? parsed.providerSettings : {},
        ideSettings: isPlainObject(parsed.ideSettings) ? parsed.ideSettings : {},
        disableUpstream: asBoolean(parsed.disableUpstream, DEFAULT_CONFIG.disableUpstream ?? false),
        providerDir: asOptionalString(parsed.providerDir),
    };
}

export function generateMachineId(): string {
    return `${MACHINE_ID_PREFIX}${randomUUID().replace(/-/g, '')}`;
}

export function isStableMachineId(machineId?: string | null): boolean {
    return typeof machineId === 'string' && machineId.startsWith(MACHINE_ID_PREFIX);
}

function ensureMachineId(config: ADHDevConfig): { config: ADHDevConfig; changed: boolean } {
    if (isStableMachineId(config.machineId)) {
        return { config, changed: false };
    }

    // TODO(2026-04-06): Remove this legacy bridge after cloud clients have had
    // time to persist registeredMachineId from the upgraded setup/login flow.
    const legacyRegisteredMachineId = (!config.registeredMachineId && config.machineSecret && config.machineId)
        ? config.machineId
        : config.registeredMachineId;

    return {
        config: {
            ...config,
            machineId: generateMachineId(),
            registeredMachineId: legacyRegisteredMachineId,
        },
        changed: true,
    };
}

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
        const initialized = ensureMachineId({ ...DEFAULT_CONFIG });
        try {
            saveConfig(initialized.config);
        } catch { /* ignore */ }
        return initialized.config;
    }

    try {
        const raw = readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(raw);
        const normalizedInput = normalizeConfig(parsed);
        const ensured = ensureMachineId(normalizedInput);
        const normalized = ensured.config as ADHDevConfig & { activeWorkspaceId?: string | null };
        if (ensured.changed || JSON.stringify(parsed) !== JSON.stringify(normalized)) {
            try {
                saveConfig(normalized);
            } catch { /* ignore */ }
        }
        return normalized;
    } catch {
        const initialized = ensureMachineId({ ...DEFAULT_CONFIG });
        return initialized.config;
    }
}

/**
 * Save configuration to disk
 */
export function saveConfig(config: ADHDevConfig): void {
    const configPath = getConfigPath();
    const dir = getConfigDir();
    const normalized = normalizeConfig(config);

    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    writeFileSync(configPath, JSON.stringify(normalized, null, 2), { encoding: 'utf-8', mode: 0o600 });
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
