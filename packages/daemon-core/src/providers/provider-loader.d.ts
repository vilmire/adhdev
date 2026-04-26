/**
 * ProviderLoader — Provider discovery + OS/version override resolution
 *
 * Role:
 * 1. Load providers from upstream auto-download (~/.adhdev/providers/.upstream/)
 * 2. Load user custom from ~/.adhdev/providers/ (overrides)
 * 3. Apply OS/version overrides (process.platform + detected IDE version)
 * 4. Hot-reload support (fs.watch)
 *
 * Design principles:
 * - Load JS files via require() (CJS compatible)
 * - User custom can override builtin
 * - provider.js files are independent, so load order doesn't matter
 */
import { VersionArchive } from './version-archive.js';
import type { ProviderModule, ProviderCategory, ProviderSettingSchema, ResolvedProvider } from './contracts.js';
import type { ProviderSourceMode } from '../config/config.js';
export type ProviderMachineStatus = 'disabled' | 'enabled_unchecked' | 'not_detected' | 'detected';
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
export declare class ProviderLoader {
    private providers;
    private providerAvailability;
    private userDir;
    private upstreamDir;
    private disableUpstream;
    private watchers;
    private logFn;
    private versionArchive;
    private scriptsCache;
    /** Inject VersionArchive so resolve() can auto-detect installed versions */
    setVersionArchive(archive: VersionArchive): void;
    private static readonly GITHUB_TARBALL_URL;
    private static readonly META_FILE;
    constructor(options?: {
        userDir?: string;
        logFn?: (msg: string) => void;
        /** Explicit machine-level provider source policy */
        sourceMode?: ProviderSourceMode;
        /** Deprecated alias for sourceMode='no-upstream' */
        disableUpstream?: boolean;
    });
    private log;
    /**
     * User override root (~/.adhdev/providers by default).
     */
    getUserDir(): string;
    /**
    * Auto-updated upstream root (~/.adhdev/providers/.upstream by default).
    */
    getUpstreamDir(): string;
    /**
     * Provider search order for on-disk lookups.
     * Highest-priority editable overrides come first.
     */
    getProviderRoots(): string[];
    /**
    * Canonical provider directory shape for a given root.
    */
    getProviderDir(root: string, category: ProviderCategory, type: string): string;
    /**
    * Canonical user override directory for a provider.
    */
    getUserProviderDir(category: ProviderCategory, type: string): string;
    /**
    * Canonical upstream directory for a provider.
    */
    getUpstreamProviderDir(category: ProviderCategory, type: string): string;
    /**
     * Find the on-disk directory for a provider by type.
     * Search order: user override → upstream.
     */
    findProviderDir(type: string): string | null;
    /**
    * Resolve a file within a provider directory.
    */
    resolveProviderFile(type: string, ...segments: string[]): string | null;
    /**
    * Load all providers (3-tier priority)
    * 1. .upstream/ (GitHub auto-download — primary source)
    * 2. User custom (~/.adhdev/providers/ excluding .upstream)
    * User custom always wins (highest priority).
    * If .upstream/ is empty, call fetchLatest() before loadAll().
    */
    loadAll(): void;
    /**
     * Check if upstream directory exists and has providers.
     */
    hasUpstream(): boolean;
    /**
    * Get raw provider metadata by type (NO scripts loaded).
    * Safe for: category checks, icon, displayName, targetFilter, cdpPorts.
    * NOT safe for: script execution (readChat, listModels, sendMessage).
    * Use resolve() when scripts are needed.
    */
    getMeta(type: string): ProviderModule | undefined;
    /**
    * Resolve provider type by alias
    * 'claude' → 'claude-cli', 'codex' → 'codex-cli' etc
    * Returns input as-is if no match found.
    */
    resolveAlias(input: string): string;
    /**
    * Get provider with alias resolution (get + alias fallback)
    */
    getByAlias(input: string): ProviderModule | undefined;
    /**
    * Build CLI/ACP detection list (replaces cli-detector)
    * Dynamically generated from provider.js spawn.command.
    */
    getCliDetectionList(): {
        id: string;
        displayName: string;
        icon: string;
        command: string;
        args?: string[];
        category: string;
        enabled: boolean;
        versionCommand?: string;
    }[];
    /**
    * List providers by category
    */
    getByCategory(cat: ProviderCategory): ProviderModule[];
    /**
    * Extension Extension providers with extensionIdPattern only
    * (used by discoverAgentWebviews in daemon-cdp.ts)
    */
    getExtensionProviders(): ProviderModule[];
    /**
    * All loaded providers
    */
    getAll(): ProviderModule[];
    /**
    * Check if a provider is enabled (per-IDE)
    * Checks ideSettings[ideType].extensions[type].enabled.
    * Default false (disabled) — user must explicitly enable.
    * Always returns true when called without ideType.
    */
    isEnabled(type: string, ideType?: string): boolean;
    /**
    * Resolve per-IDE extension enabled state using the same normalization
    * that runtime attach/remove uses.
    */
    getIdeExtensionEnabledState(ideType: string, extensionType: string): boolean;
    /**
    * Save IDE extension enabled setting
    */
    setIdeExtensionEnabled(ideType: string, extensionType: string, enabled: boolean): boolean;
    /**
    * Return only enabled providers by category (per-IDE)
    */
    getEnabledByCategory(cat: ProviderCategory, ideType?: string): ProviderModule[];
    /**
    * Extension Enabled extension providers with extensionIdPattern only (per-IDE)
    */
    getEnabledExtensionProviders(ideType?: string): ProviderModule[];
    /**
    * Return CDP port map for IDE providers
    * Used by launch.ts, adhdev-daemon.ts
    */
    getCdpPortMap(): Record<string, [number, number]>;
    /**
    * Return IDE process name map (macOS)
    */
    getMacAppIdentifiers(): Record<string, string>;
    /**
    * Return IDE process name map (Windows)
    */
    getWinProcessNames(): Record<string, string[]>;
    /**
    * Available IDE types (only those with cdpPorts)
    */
    getAvailableIdeTypes(): string[];
    getSpawnCommand(type: string, fallback?: string): string;
    getSpawnArgs(type: string, fallback?: string[]): string[];
    getIdeCliCommand(type: string, fallback?: string | null): string | null;
    getIdePathCandidates(type: string, fallback?: string[]): string[];
    setProviderAvailability(type: string, state: {
        installed: boolean;
        detectedPath?: string | null;
    }): void;
    setCliDetectionResults(results: Array<{
        id: string;
        installed: boolean;
        path?: string;
    }>, replace?: boolean): void;
    setIdeDetectionResults(results: Array<{
        id: string;
        installed: boolean;
        path?: string | null;
        cliCommand?: string | null;
    }>, replace?: boolean): void;
    getAvailableProviderInfos(): Array<ProviderModule & {
        installed?: boolean;
        detectedPath?: string | null;
        enabled: boolean;
        machineStatus: ProviderMachineStatus;
        lastDetection?: MachineProviderCheckResult;
        lastVerification?: MachineProviderCheckResult;
    }>;
    /**
    * Register IDE providers to core/detector registry
    * → Enables detectIDEs() to detect provider.js-based IDEs
    */
    registerToDetector(): number;
    /**
    * Return final provider with OS/version overrides applied.
    *
    * Script resolution order:
    *   1. compatibility array (new format — preferred)
    *      Provider.json defines: "compatibility": [{ "ideVersion": ">=1.107.0", "scriptDir": "scripts/1.107" }]
    *      First matching range wins. Fallback: defaultScriptDir.
    *   2. versions field (legacy format — backward compat)
    *      "versions": { "< 1.107.0": { "__dir": "scripts/legacy" } }
    *   3. Root scripts.js (original format — no versioning)
    *
    * Version source: context.version → VersionArchive → undefined
    */
    resolve(type: string, context?: {
        os?: string;
        version?: string;
    }): ResolvedProvider | undefined;
    /**
     * Load scripts from a scriptDir within a provider directory.
     * Tries scripts.js first, then individual .js files.
     */
    private loadScriptsFromDir;
    /**
     * Hot-reload: start watching for file changes
     */
    watch(): void;
    /**
    * Stop hot-reload
    */
    stopWatch(): void;
    /**
    * Full reload
    */
    reload(): void;
    /**
    * Download latest providers tarball from GitHub → extract to .upstream/
    * - ETag-based change detection (skip if unchanged)
    * - Never touches user custom files in ~/.adhdev/providers/
    * - Runs in background; existing providers are kept on failure
    *
    * @returns Whether an update occurred
    */
    fetchLatest(): Promise<{
        updated: boolean;
        error?: string;
    }>;
    /** HTTP(S) file download (follows redirects) */
    private downloadFile;
    /** Recursive directory copy */
    private copyDirRecursive;
    /** .meta.json save */
    private writeMeta;
    /** Count provider files (provider.js or provider.json) */
    private countProviders;
    /**
    * Get public settings schema for a provider (for dashboard UI rendering)
    */
    getPublicSettings(type: string): ProviderSettingSchema[];
    /**
    * Get public settings schema for all providers
    */
    getAllPublicSettings(): Record<string, ProviderSettingSchema[]>;
    /**
    * Resolved setting value for a provider (default + user override)
    */
    getSettingValue(type: string, key: string): any;
    /**
    * All resolved settings for a provider (default + user override)
    */
    getSettings(type: string): Record<string, any>;
    /**
    * Save provider setting value (writes to config.json)
    */
    setSetting(type: string, key: string, value: any): boolean;
    private getOptionalStringSetting;
    protected readConfig(): any | null;
    protected writeConfig(config: any): void;
    private getPlatformVersionCommand;
    private getSettingsSchema;
    private getSyntheticSettings;
    /**
     * Find the on-disk directory for a provider by type.
     * Canonical shape: root/category/type.
     */
    private findProviderDirInternal;
    /**
     * Build a scripts function map from individual .js files in a directory.
     * Each file is wrapped as: (params?) => fs.readFileSync(filePath, 'utf-8')
     * (template substitution is NOT applied here — scripts.js handles that)
     */
    private buildScriptWrappersFromDir;
    /**
     * Recursively scan directory to load provider files
     * Supports two formats:
     *   1. provider.json (metadata) + scripts.js (optional CDP scripts)
     *   2. provider.js (legacy — everything in one file)
     * Structure: dir/category/agent-name/provider.{json,js}
     */
    private loadDir;
    /**
    * Simple semver range matching
    * Supported formats: '>=4.0.0', '<3.0.0', '>=2.1.0'
    */
    private matchesVersion;
    private compareVersions;
}
