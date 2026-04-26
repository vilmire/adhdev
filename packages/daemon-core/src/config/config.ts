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
export type { WorkspaceEntry } from './workspaces.js';
export type { RecentActivityEntry } from './recent-activity.js';
export type { SavedProviderSessionEntry } from './saved-sessions.js';
export type { DaemonState } from './state-store.js';

export type ProviderSourceMode = 'normal' | 'no-upstream';

export function resolveProviderSourceMode(
    providerSourceMode: unknown,
    legacyDisableUpstream: unknown,
): ProviderSourceMode {
    if (providerSourceMode === 'normal' || providerSourceMode === 'no-upstream') {
        return providerSourceMode;
    }
    return legacyDisableUpstream === true ? 'no-upstream' : 'normal';
}

export interface MachineProviderCheckResult {
    ok: boolean;
    stage?: 'detection' | 'runnable' | 'verification';
    checkedAt?: string;
    message?: string;
    command?: string;
    path?: string | null;
}

export interface MachineProviderConfig {
    enabled?: boolean;
    executable?: string;
    args?: string[];
    lastDetection?: MachineProviderCheckResult;
    lastVerification?: MachineProviderCheckResult;
}

export interface ADHDevConfig {
 // Server connection
    serverUrl: string;

    /**
     * Allow server-relayed REST/API commands to reach the daemon.
     * Disabled by default so cloud dashboard traffic stays P2P-only.
     */
    allowServerApiProxy?: boolean;

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
     * `POST /cli/complete`. This remains useful for account-side machine actions
     * that target the registered machine row directly (for example cloud rename).
     *
     * Machine auth itself uses `machineSecret` (adm_) and no longer falls back
     * to `registeredMachineId`.
     */
    registeredMachineId?: string;

 // Per-provider user config (public setting values)
    providerSettings: Record<string, Record<string, any>>;

 // Machine-local provider activation/config. Providers default disabled until explicitly enabled.
    machineProviders: Record<string, MachineProviderConfig>;

 // Per-IDE extension config (per-IDE on/off control)
    ideSettings: Record<string, {
        extensions?: Record<string, { enabled: boolean }>;
    }>;

 // Disable upstream provider auto-download (use builtin only)
 // Controllable from CLI (--no-upstream) and dashboard (machine page)
 // Deprecated legacy boolean; prefer providerSourceMode.
    disableUpstream?: boolean;

 // Explicit machine-level provider source policy.
    providerSourceMode?: ProviderSourceMode;

 // Optional explicit provider override root (for example a local adhdev-providers checkout)
    providerDir?: string;

    /**
     * Browser terminal sizing behavior for dashboard CLI panes.
     * Default `measured` keeps terminal size daemon-authoritative.
     * `fit` opt-in restores xterm fit-based sizing for advanced users.
     */
    terminalSizingMode?: 'measured' | 'fit';
}

const DEFAULT_CONFIG: ADHDevConfig = {
    serverUrl: 'https://api.adhf.dev',
    allowServerApiProxy: false,
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
    machineNickname: null,
    machineId: undefined,
    machineSecret: null,
    registeredMachineId: undefined,
    providerSettings: {},
    machineProviders: {},
    ideSettings: {},
    providerSourceMode: 'normal',
    terminalSizingMode: 'measured',
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

function normalizeMachineProviders(value: unknown): Record<string, MachineProviderConfig> {
    if (!isPlainObject(value)) return {};
    const result: Record<string, MachineProviderConfig> = {};
    for (const [providerType, raw] of Object.entries(value)) {
        if (!isPlainObject(raw)) continue;
        const entry: MachineProviderConfig = {};
        if (raw.enabled === true) entry.enabled = true;
        if (typeof raw.executable === 'string' && raw.executable.trim()) {
            entry.executable = raw.executable.trim();
        }
        if (Array.isArray(raw.args)) {
            entry.args = raw.args.filter((arg): arg is string => typeof arg === 'string');
        }
        if (isPlainObject(raw.lastDetection)) {
            entry.lastDetection = raw.lastDetection as MachineProviderCheckResult;
        }
        if (isPlainObject(raw.lastVerification)) {
            entry.lastVerification = raw.lastVerification as MachineProviderCheckResult;
        }
        result[providerType] = entry;
    }
    return result;
}

function normalizeConfig(raw: unknown): ADHDevConfig & { activeWorkspaceId?: string | null } {
    const parsed = isPlainObject(raw) ? raw : {};

    return {
        serverUrl: typeof parsed.serverUrl === 'string' && parsed.serverUrl.trim()
            ? parsed.serverUrl
            : DEFAULT_CONFIG.serverUrl,
        allowServerApiProxy: asBoolean(parsed.allowServerApiProxy, DEFAULT_CONFIG.allowServerApiProxy ?? false),
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
        machineNickname: asNullableString(parsed.machineNickname),
        machineId: asOptionalString(parsed.machineId),
        machineSecret: parsed.machineSecret === null ? null : asOptionalString(parsed.machineSecret),
        registeredMachineId: asOptionalString(parsed.registeredMachineId),
        providerSettings: isPlainObject(parsed.providerSettings) ? parsed.providerSettings : {},
        machineProviders: normalizeMachineProviders(parsed.machineProviders),
        ideSettings: isPlainObject(parsed.ideSettings) ? parsed.ideSettings : {},
        providerSourceMode: resolveProviderSourceMode(parsed.providerSourceMode, parsed.disableUpstream),
        providerDir: asOptionalString(parsed.providerDir),
        terminalSizingMode: parsed.terminalSizingMode === 'fit' ? 'fit' : 'measured',
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

    return {
        config: {
            ...config,
            machineId: generateMachineId(),
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
 * One-time migration: move runtime state fields from config.json to state.json.
 * Called eagerly during loadConfig so state is extracted before the config
 * normalizer strips the unknown fields.
 */
function migrateStateToStateFile(raw: Record<string, any>): void {
    const statePath = join(getConfigDir(), 'state.json');
    if (existsSync(statePath)) return;

    const recentActivity = Array.isArray(raw.recentActivity) ? raw.recentActivity : [];
    const savedProviderSessions = Array.isArray(raw.savedProviderSessions) ? raw.savedProviderSessions : [];
    const legacySessionReads = isPlainObject(raw.recentSessionReads) ? raw.recentSessionReads : {};
    const sessionReads = isPlainObject(raw.sessionReads) ? raw.sessionReads : {};
    const sessionReadMarkers = isPlainObject(raw.sessionReadMarkers) ? raw.sessionReadMarkers : {};

    const hasData = recentActivity.length > 0
        || savedProviderSessions.length > 0
        || Object.keys(sessionReads).length > 0
        || Object.keys(legacySessionReads as object).length > 0
        || Object.keys(sessionReadMarkers as object).length > 0;

    if (!hasData) return;

    const mergedReads = Object.fromEntries(
        Object.entries({ ...legacySessionReads, ...sessionReads })
            .filter(([, v]) => typeof v === 'number' && Number.isFinite(v as number))
    );
    const cleanedMarkers = Object.fromEntries(
        Object.entries(sessionReadMarkers as Record<string, unknown>)
            .filter(([, v]) => typeof v === 'string')
    );

    const state = {
        recentActivity,
        savedProviderSessions,
        sessionReads: mergedReads,
        sessionReadMarkers: cleanedMarkers,
    };

    writeFileSync(statePath, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 });
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

        // One-time migration: move runtime state to ~/.adhdev/state.json
        migrateStateToStateFile(parsed);

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
