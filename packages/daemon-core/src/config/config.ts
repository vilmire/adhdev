/**
 * ADHDev Launcher — Configuration
 *
 * Manages launcher config, machine auth, and user preferences.
 */

import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { randomUUID } from 'crypto';
import { resolveConfigDir } from './config-dir.js';
import { IDENTITY, TRACK } from '../track-identity.js';
import type { WorkspaceEntry } from './workspaces.js';
export type { WorkspaceEntry } from './workspaces.js';
export type { RecentActivityEntry } from './recent-activity.js';
export type { SavedProviderSessionEntry } from './saved-sessions.js';
export type { DaemonState } from './state-store.js';

export type ProviderSourceMode = 'normal' | 'no-upstream';
export type ReleaseChannel = 'stable' | 'preview';

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
    /**
     * Per-provider quota probe switch. INDEPENDENT of `enabled`, which gates
     * launching instances and mesh claims: a machine can use a provider and
     * still not want its quota probed here. Absent = enabled (backwards
     * compatible); only `false` is meaningful.
     */
    quotaEnabled?: boolean;
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

    /**
     * Label provider quota with the signed-in account's email address.
     *
     * ON by default (owner decision, 2026-08-05). Every quota surface — the
     * three dashboards and `adhdev quota` — shows the same label, so the
     * account is part of the normal reading rather than a hidden extra. Users
     * who do not want it turn it off from the machine page's provider settings.
     *
     * When off, the email is never ACQUIRED: the codex fetcher skips the
     * `account/read` call entirely, so nothing downstream (the in-memory cache,
     * ~/.adhdev/quota/cache.json, the P2P node-facts bundle, any dashboard) can
     * carry a value that was never fetched. Hiding it at render time would have
     * left it on disk.
     *
     * The non-identifying plan tier (`metadata.planType`) is NOT gated by this
     * — it says "Plus", not who you are.
     */
    quotaShowAccountEmail?: boolean;

    /**
     * True once a human has explicitly chosen the value above (via the machine
     * page toggle / setQuotaShowAccountEmail). Absent means any stored value is
     * an old default this file wrote, not a preference — see
     * resolveQuotaShowAccountEmail.
     */
    quotaShowAccountEmailSetByUser?: boolean;

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
     * Optional provider registry base URL override (for example a self-hosted
     * registry). Highest-priority source in the registry resolver, ahead of the
     * `ADHDEV_REGISTRY_URL` env var and the vendor default. See
     * `config/registry-resolver.ts`.
     */
    registryUrl?: string;

    /**
     * Optional provider tarball (archive) URL override so self-hosters can point
     * the daemon at their own provider mirror instead of the vendor GitHub repo.
     * Highest-priority source, ahead of `ADHDEV_PROVIDER_TARBALL_URL` and the
     * vendor default. See `config/registry-resolver.ts`.
     */
    providerTarballUrl?: string;

    /**
     * Explicit provider artifact channel ('stable' | 'preview'). Absent or
     * ambiguous values resolve to 'stable' at runtime; stable never falls
     * through to preview. See providers/channel/contract.ts.
     */
    providerChannel?: string;

    /**
     * Development-only opt-in: allow the legacy unverified `main.tar.gz`
     * upstream fallback. Refused whenever the resolved provider channel is
     * 'stable' (production mode), regardless of this flag.
     */
    providerAllowUnverifiedTarball?: boolean;

    /**
     * DEPRECATED (Phase 3): legacy runtime update channel. The channel is now
     * a build-time identity (track-identity.ts) — this field is read-only for
     * the provider-channel derivation union and ignored by every upgrade path.
     * Absent/unknown values resolve to the build track.
     */
    updateChannel?: ReleaseChannel;

    /**
     * Browser terminal sizing behavior for dashboard CLI panes.
     * Default `measured` keeps terminal size daemon-authoritative.
     * `fit` opt-in restores xterm fit-based sizing for advanced users.
     */
    terminalSizingMode?: 'measured' | 'fit';
}

const DEFAULT_CONFIG: ADHDevConfig = {
    // Track-stamped default origin: identical to the historical literal on
    // stable builds ('https://api.adhf.dev'); preview builds default to the
    // preview API instead of silently pinning stable.
    serverUrl: IDENTITY.serverUrl,
    allowServerApiProxy: false,
    quotaShowAccountEmail: true,
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
    updateChannel: 'stable',
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

/**
 * Resolve `quotaShowAccountEmail`, distinguishing a value the USER chose from
 * one this file wrote on its own.
 *
 * The migration problem: the option shipped opt-in (default false) in
 * 1.0.35-rc.7. `normalizeConfig` fills every missing key from DEFAULT_CONFIG and
 * `loadConfig` writes the result straight back when it differs from what was on
 * disk (see the saveConfig call there), so simply STARTING an rc.7 daemon
 * stamped `"quotaShowAccountEmail": false` into every user's config.json. Those
 * `false`s are an artefact of the old default, not a preference — treating them
 * as a deliberate opt-out would leave the new ON default unreachable for exactly
 * the users who already ran the previous build.
 *
 * So an explicit choice is recorded separately, by the write path that a human
 * actually triggers (`setQuotaShowAccountEmail`). Only that marker makes a
 * stored boolean authoritative:
 *   - marker present  → honour the stored value, whichever way it points
 *   - marker absent   → the stored value is (at best) an old default; use the
 *                       current default instead
 * A user who turns the option off after this change gets the marker and keeps
 * it off across upgrades; nobody has their choice silently reverted.
 */
function resolveQuotaShowAccountEmail(parsed: Record<string, any>): boolean {
    const fallback = DEFAULT_CONFIG.quotaShowAccountEmail ?? true;
    if (parsed.quotaShowAccountEmailSetByUser === true) {
        return asBoolean(parsed.quotaShowAccountEmail, fallback);
    }
    return fallback;
}

function normalizeMachineProviders(value: unknown): Record<string, MachineProviderConfig> {
    if (!isPlainObject(value)) return {};
    const result: Record<string, MachineProviderConfig> = {};
    for (const [providerType, raw] of Object.entries(value)) {
        if (!isPlainObject(raw)) continue;
        const entry: MachineProviderConfig = {};
        if (raw.enabled === true) entry.enabled = true;
        if (typeof raw.quotaEnabled === 'boolean') entry.quotaEnabled = raw.quotaEnabled;
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
        quotaShowAccountEmail: resolveQuotaShowAccountEmail(parsed),
        ...(parsed.quotaShowAccountEmailSetByUser === true ? { quotaShowAccountEmailSetByUser: true } : {}),
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
        registryUrl: asOptionalString(parsed.registryUrl),
        providerTarballUrl: asOptionalString(parsed.providerTarballUrl),
        providerChannel: asOptionalString(parsed.providerChannel),
        providerAllowUnverifiedTarball: asBoolean(parsed.providerAllowUnverifiedTarball, false),
        // Phase 3: legacy runtime channel field, read-only and never written
        // anymore (channel is a build-time identity — track-identity.ts). An
        // explicit preview/next value is still honored so the provider-channel
        // derivation union (providers/channel/contract.ts) stays
        // behavior-neutral for stale configs; anything absent or unknown
        // resolves to THIS binary's build track instead of failing.
        updateChannel: parsed.updateChannel === 'preview' || parsed.updateChannel === 'next'
            ? 'preview'
            : parsed.updateChannel === 'stable' || parsed.updateChannel === 'latest'
                ? 'stable'
                : TRACK,
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
 * Get the config directory path. The resolution rule itself lives in
 * config-dir.ts (resolveConfigDir); this adds the mkdir side effect callers
 * historically relied on.
 */
export function getConfigDir(): string {
    const dir = resolveConfigDir();
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    return dir;
}

/**
 * Get the daemon runtime data directory (~/.adhdev/daemon/).
 * Distinct from the user-config dir so runtime state can be cleared independently.
 */
export function getDaemonDataDir(): string {
    const dir = join(getConfigDir(), 'daemon');
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
 * Record a deliberate choice for the quota account label.
 *
 * Writes the intent marker alongside the value, which is what makes the stored
 * boolean authoritative across future default changes — see
 * resolveQuotaShowAccountEmail. Every human-facing write path (the machine page
 * toggle) must go through here rather than setting the boolean directly, or the
 * choice will be treated as an old default and overwritten.
 */
export function setQuotaShowAccountEmail(enabled: boolean): ADHDevConfig {
    return updateConfig({
        quotaShowAccountEmail: enabled,
        quotaShowAccountEmailSetByUser: true,
    });
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
