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

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as chokidar from 'chokidar';
import { registerIDEDefinition } from '../detection/ide-detector.js';
import { LOG } from '../logging/logger.js';
import { VersionArchive } from './version-archive.js';
import type {
  ProviderCompatibilityEntry,
  ProviderModule,
  ProviderCategory,
  ProviderScripts,
  ProviderSettingDef,
  ProviderSettingSchema,
  ResolvedProvider,
} from './contracts.js';
import { validateProviderDefinition } from './provider-schema.js';
import type { ProviderSourceMode } from '../config/config.js';
import type { ProviderSourceConfigSnapshot, ProviderUserDirSource } from '../config/provider-source-config.js';

interface ProviderAvailabilityState {
  installed: boolean;
  detectedPath: string | null;
}

export type ProviderMachineStatus =
  | 'disabled'
  | 'enabled_unchecked'
  | 'not_detected'
  | 'detected';

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

type CliDetectionEntry = {
  id: string;
  displayName: string;
  icon: string;
  command: string;
  args?: string[];
  category: string;
  enabled: boolean;
  versionCommand?: string;
};

export class ProviderLoader {
  private providers = new Map<string, ProviderModule>();
  private providerAvailability = new Map<string, ProviderAvailabilityState>();
  private defaultProvidersDir: string;
  private explicitProviderDir: string | null = null;
  private userDir: string;
  private upstreamDir: string;
  private sourceMode: ProviderSourceMode = 'normal';
  private disableUpstream: boolean;
  private watchers: any[] = [];
  private logFn: (msg: string) => void;
  private versionArchive: VersionArchive | null = null;
  private scriptsCache = new Map<string, Partial<ProviderScripts>>();

  /** Inject VersionArchive so resolve() can auto-detect installed versions */
  setVersionArchive(archive: VersionArchive): void {
    this.versionArchive = archive;
  }

  private static readonly GITHUB_TARBALL_URL = 'https://github.com/vilmire/adhdev-providers/archive/refs/heads/main.tar.gz';
  private static readonly META_FILE = '.meta.json';
  private static readonly REPO_PROVIDER_DIRNAME = 'adhdev-providers';
  private static readonly SIBLING_MARKER_FILE = '.adhdev-provider-root';
  private static readonly SIBLING_ENV_VAR = 'ADHDEV_USE_SIBLING_PROVIDERS';

  private probeStarts: string[] = [];
  private siblingLogged = false;
  private userDirSource: ProviderUserDirSource = 'home-default';

  /** Process-level dedup for stderr sibling-adoption notices (shared across all ProviderLoader instances). */
  private static siblingStderrLogged: Set<string> = new Set();

  private static looksLikeProviderRoot(candidate: string): boolean {
    try {
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) return false;
      return ['ide', 'extension', 'cli', 'acp'].some((category) =>
        fs.existsSync(path.join(candidate, category))
      );
    } catch {
      return false;
    }
  }

  private static hasProviderRootMarker(candidate: string): boolean {
    try {
      return fs.existsSync(path.join(candidate, ProviderLoader.SIBLING_MARKER_FILE));
    } catch {
      return false;
    }
  }

  private detectDefaultUserDir(): { path: string; source: 'sibling-env' | 'sibling-marker' | 'home-default' } {
    const fallback = path.join(os.homedir(), '.adhdev', 'providers');
    const envOptIn = process.env[ProviderLoader.SIBLING_ENV_VAR] === '1';
    const visited = new Set<string>();

    for (const start of this.probeStarts) {
      let current = path.resolve(start);
      while (!visited.has(current)) {
        visited.add(current);
        const siblingCandidate = path.join(path.dirname(current), ProviderLoader.REPO_PROVIDER_DIRNAME);
        if (ProviderLoader.looksLikeProviderRoot(siblingCandidate)) {
          const hasMarker = ProviderLoader.hasProviderRootMarker(siblingCandidate);
          if (envOptIn || hasMarker) {
            const source: 'sibling-env' | 'sibling-marker' = hasMarker ? 'sibling-marker' : 'sibling-env';
            if (!this.siblingLogged) {
              this.log(`Using sibling provider checkout (${source}): ${siblingCandidate}`);
              this.siblingLogged = true;
            }
            // Force-surface adoption to stderr once per sibling path per process, so CLI
            // entry points that suppress logFn still leave a visible trail.
            if (!ProviderLoader.siblingStderrLogged.has(siblingCandidate)) {
              ProviderLoader.siblingStderrLogged.add(siblingCandidate);
              try {
                process.stderr.write(
                  `[adhdev] Using sibling adhdev-providers checkout (${source}): ${siblingCandidate}\n`,
                );
              } catch { /* ignore */ }
            }
            return { path: siblingCandidate, source };
          }
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }

    return { path: fallback, source: 'home-default' };
  }

  constructor(options?: {
    userDir?: string;
    logFn?: (msg: string) => void;
    /** Explicit machine-level provider source policy */
    sourceMode?: ProviderSourceMode;
    /** Deprecated alias for sourceMode='no-upstream' */
    disableUpstream?: boolean;
    /**
     * Directories from which to walk up looking for a sibling `adhdev-providers`
     * checkout. Defaults to [process.cwd(), __dirname]. Used by tests for hermetic
     * probing; production code should leave this unset.
     */
    probeStarts?: string[];
  }) {
    this.logFn = options?.logFn || LOG.forComponent('Provider').asLogFn();
    this.probeStarts = options?.probeStarts ?? [process.cwd(), __dirname];

    // Default directory for auto-downloads
    this.defaultProvidersDir = path.join(os.homedir(), '.adhdev', 'providers');
    const detected = this.detectDefaultUserDir();
    this.userDir = detected.path;
    this.userDirSource = detected.source;
    this.upstreamDir = path.join(this.defaultProvidersDir, '.upstream');
    this.disableUpstream = false;

    this.applySourceConfig({
      userDir: options?.userDir,
      sourceMode: options?.sourceMode,
      disableUpstream: options?.disableUpstream,
    });
  }

  private log(msg: string): void {
    this.logFn(`[ProviderLoader] ${msg}`);
  }

 // ─── Public API ────────────────────────────────

  /**
   * User override root (~/.adhdev/providers by default).
   */
  getUserDir(): string {
    return this.userDir;
  }

 /**
 * Auto-updated upstream root (~/.adhdev/providers/.upstream by default).
 */
  getUpstreamDir(): string {
    return this.upstreamDir;
  }

  /**
   * Provider search order for on-disk lookups.
   * Highest-priority editable overrides come first.
   */
  getProviderRoots(): string[] {
    return [this.userDir, this.upstreamDir];
  }

  getSourceConfig(): ProviderSourceConfigSnapshot {
    return {
      sourceMode: this.sourceMode,
      disableUpstream: this.disableUpstream,
      explicitProviderDir: this.explicitProviderDir,
      userDir: this.userDir,
      userDirSource: this.userDirSource,
      upstreamDir: this.upstreamDir,
      providerRoots: this.getProviderRoots(),
    };
  }

  applySourceConfig(options?: {
    userDir?: string;
    sourceMode?: ProviderSourceMode;
    disableUpstream?: boolean;
  }): ProviderSourceConfigSnapshot {
    const nextSourceMode = options?.sourceMode === 'no-upstream'
      ? 'no-upstream'
      : (options?.sourceMode === 'normal'
        ? 'normal'
        : (options?.disableUpstream ? 'no-upstream' : this.sourceMode || 'normal'));

    if (options && Object.prototype.hasOwnProperty.call(options, 'userDir')) {
      this.explicitProviderDir = options.userDir?.trim() ? options.userDir : null;
    }

    this.sourceMode = nextSourceMode;
    if (this.explicitProviderDir) {
      this.userDir = this.explicitProviderDir;
      this.userDirSource = 'explicit';
    } else {
      const detected = this.detectDefaultUserDir();
      this.userDir = detected.path;
      this.userDirSource = detected.source;
    }
    this.upstreamDir = path.join(this.defaultProvidersDir, '.upstream');
    this.disableUpstream = this.sourceMode === 'no-upstream';

    if (this.explicitProviderDir) {
      this.log(`Config 'providerDir' applied: ${this.userDir}`);
    } else {
      this.log(`Using default user providers directory: ${this.userDir}`);
    }
    this.log(`Provider source config: mode=${this.sourceMode} explicitProviderDir=${this.explicitProviderDir || '-'} userDir=${this.userDir} upstreamDir=${this.upstreamDir}`);

    return this.getSourceConfig();
  }

 /**
 * Canonical provider directory shape for a given root.
 */
  getProviderDir(root: string, category: ProviderCategory, type: string): string {
    return path.join(root, category, type);
  }

 /**
 * Canonical user override directory for a provider.
 */
  getUserProviderDir(category: ProviderCategory, type: string): string {
    return this.getProviderDir(this.userDir, category, type);
  }

 /**
 * Canonical upstream directory for a provider.
 */
  getUpstreamProviderDir(category: ProviderCategory, type: string): string {
    return this.getProviderDir(this.upstreamDir, category, type);
  }

  /**
   * Find the on-disk directory for a provider by type.
   * Search order: user override → upstream.
   */
  findProviderDir(type: string): string | null {
    return this.findProviderDirInternal(type);
  }

 /**
 * Resolve a file within a provider directory.
 */
  resolveProviderFile(type: string, ...segments: string[]): string | null {
    const dir = this.findProviderDirInternal(type);
    if (!dir) return null;
    return path.join(dir, ...segments);
  }

 /**
 * Load all providers (3-tier priority)
 * 1. .upstream/ (GitHub auto-download — primary source)
 * 2. User custom (~/.adhdev/providers/ excluding .upstream)
 * User custom always wins (highest priority).
 * If .upstream/ is empty, call fetchLatest() before loadAll().
 */
  loadAll(): void {
    this.providers.clear();
    this.providerAvailability.clear();

 // 1. Load upstream (GitHub auto-download — primary source)
    let upstreamCount = 0;
    if (!this.disableUpstream && fs.existsSync(this.upstreamDir)) {
      upstreamCount = this.loadDir(this.upstreamDir);
      if (upstreamCount > 0) {
        this.log(`Loaded ${upstreamCount} upstream providers (auto-updated)`);
      }
    } else if (this.disableUpstream) {
      this.log('Upstream loading disabled (sourceMode=no-upstream)');
    }

 // 2. Load user custom (excluding .upstream — highest priority, never auto-updated)
    if (fs.existsSync(this.userDir)) {
      const userCount = this.loadDir(this.userDir, ['.upstream']);
      if (userCount > 0) {
        this.log(`Loaded ${userCount} user custom providers (never auto-updated)`);
      }
    }

    this.log(`Total: ${this.providers.size} providers [${[...this.providers.keys()].join(', ')}]`);

 // ❌ Error: no providers found
    if (this.providers.size === 0) {
      this.log(`❌ No providers loaded! Run 'adhdev daemon' with internet to download providers.`);
    }
  }

 /**
  * Check if upstream directory exists and has providers.
  */
  hasUpstream(): boolean {
    if (!fs.existsSync(this.upstreamDir)) return false;
    try {
      return fs.readdirSync(this.upstreamDir).some(d =>
        fs.statSync(path.join(this.upstreamDir, d)).isDirectory()
      );
    } catch { return false; }
  }

 /**
 * Get raw provider metadata by type (NO scripts loaded).
 * Safe for: category checks, icon, displayName, targetFilter, cdpPorts.
 * NOT safe for: script execution (readChat, listModels, sendMessage).
 * Use resolve() when scripts are needed.
 */
  getMeta(type: string): ProviderModule | undefined {
    return this.providers.get(type);
  }

 /**
 * Resolve provider type by alias
 * 'claude' → 'claude-cli', 'codex' → 'codex-cli' etc
 * Returns input as-is if no match found.
 */
  resolveAlias(input: string): string {
 // 1. directly match
    if (this.providers.has(input)) return input;
 // 2. alias match
    for (const p of this.providers.values()) {
      if (p.aliases?.includes(input)) return p.type;
    }
    return input;
  }

 /**
 * Get provider with alias resolution (get + alias fallback)
 */
  getByAlias(input: string): ProviderModule | undefined {
    return this.providers.get(this.resolveAlias(input));
  }

 /**
 * Build CLI/ACP detection list (replaces cli-detector)
 * Dynamically generated from provider.js spawn.command.
 */
  getCliDetectionList(): CliDetectionEntry[] {
    const result: CliDetectionEntry[] = [];
    for (const p of this.providers.values()) {
      if ((p.category === 'cli' || p.category === 'acp') && p.spawn?.command && this.isMachineProviderEnabled(p.type)) {
        const versionCommand = this.getPlatformVersionCommand(p.versionCommand);
        const command = this.getSpawnCommand(p.type, p.spawn.command);
        const args = this.getSpawnArgs(p.type, p.spawn.args || []);
        result.push({
          id: p.type,
          displayName: p.displayName || p.name,
          icon: p.icon || '🔧',
          command,
          ...(args.length > 0 ? { args } : {}),
          category: p.category,
          enabled: true,
          ...(typeof versionCommand === 'string' && versionCommand.trim()
            ? { versionCommand: versionCommand.trim() }
            : {}),
        });
      }
    }
    return result;
  }

 /**
 * List providers by category
 */
  getByCategory(cat: ProviderCategory): ProviderModule[] {
    return [...this.providers.values()].filter(p => p.category === cat);
  }

 /**
 * Extension Extension providers with extensionIdPattern only
 * (used by discoverAgentWebviews in daemon-cdp.ts)
 */
  getExtensionProviders(): ProviderModule[] {
    return [...this.providers.values()].filter(
      p => p.category === 'extension' && p.extensionIdPattern
    );
  }

 /**
 * All loaded providers
 */
  getAll(): ProviderModule[] {
    return [...this.providers.values()];
  }

 /**
 * Check if a provider is enabled (per-IDE)
 * Checks ideSettings[ideType].extensions[type].enabled.
 * Default false (disabled) — user must explicitly enable.
 * Always returns true when called without ideType.
 */
  isEnabled(type: string, ideType?: string): boolean {
    if (!ideType) return true;
    try {
      return this.getIdeExtensionEnabledState(ideType, type);
    } catch {
      return false;
    }
  }

 /**
 * Resolve per-IDE extension enabled state using the same normalization
 * that runtime attach/remove uses.
 */
  getIdeExtensionEnabledState(ideType: string, extensionType: string): boolean {
    const config = this.readConfig();
    if (!config) return false;
    const baseIdeType = ideType.split('_')[0];
    const val = config.ideSettings?.[baseIdeType]?.extensions?.[extensionType]?.enabled;
    return val === true;
  }

 /**
 * Save IDE extension enabled setting
 */
  setIdeExtensionEnabled(ideType: string, extensionType: string, enabled: boolean): boolean {
    const config = this.readConfig();
    if (!config) return false;

    try {
      const baseIdeType = ideType.split('_')[0];
      if (!config.ideSettings) config.ideSettings = {};
      if (!config.ideSettings[baseIdeType]) config.ideSettings[baseIdeType] = {};
      if (!config.ideSettings[baseIdeType].extensions) config.ideSettings[baseIdeType].extensions = {};
      config.ideSettings[baseIdeType].extensions[extensionType] = { enabled };
      this.writeConfig(config);
      this.log(`IDE extension setting: ${ideType}.${extensionType}.enabled = ${enabled}`);
      return true;
    } catch (e) {
      this.log(`Failed to save IDE extension setting: ${(e as Error).message}`);
      return false;
    }
  }

 /**
 * Return only enabled providers by category (per-IDE)
 */
  getEnabledByCategory(cat: ProviderCategory, ideType?: string): ProviderModule[] {
    return this.getByCategory(cat).filter(p => this.isEnabled(p.type, ideType));
  }

 /**
 * Extension Enabled extension providers with extensionIdPattern only (per-IDE)
 */
  getEnabledExtensionProviders(ideType?: string): ProviderModule[] {
    return this.getExtensionProviders().filter(p => this.isEnabled(p.type, ideType));
  }

 /**
 * Return CDP port map for IDE providers
 * Used by launch.ts, adhdev-daemon.ts
 */
  getCdpPortMap(): Record<string, [number, number]> {
    const map: Record<string, [number, number]> = {};
    for (const p of this.providers.values()) {
      if (p.category === 'ide' && p.cdpPorts) {
        map[p.type] = p.cdpPorts as [number, number];
      }
    }
    return map;
  }

 /**
 * Return IDE process name map (macOS)
 */
  getMacAppIdentifiers(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const p of this.providers.values()) {
      if (p.category === 'ide' && p.processNames?.darwin) {
        map[p.type] = p.processNames.darwin as string;
      }
    }
    return map;
  }

 /**
 * Return IDE process name map (Windows)
 */
  getWinProcessNames(): Record<string, string[]> {
    const map: Record<string, string[]> = {};
    for (const p of this.providers.values()) {
      if (p.category === 'ide' && p.processNames?.win32) {
        map[p.type] = p.processNames.win32 as string[];
      }
    }
    return map;
  }

 /**
 * Available IDE types (only those with cdpPorts)
 */
  getAvailableIdeTypes(): string[] {
    return [...this.providers.values()]
      .filter(p => p.category === 'ide' && p.cdpPorts)
      .map(p => p.type);
  }

  getSpawnCommand(type: string, fallback?: string): string {
    const providerType = this.resolveAlias(type);
    const machineConfig = this.getMachineProviderConfig(providerType);
    if (machineConfig.executable) return machineConfig.executable;
    return fallback || this.providers.get(providerType)?.spawn?.command || providerType;
  }

  getIdeCliCommand(type: string, fallback?: string | null): string | null {
    const override = this.getOptionalStringSetting(type, 'cliPathOverride');
    if (override) return override;
    return fallback || this.providers.get(type)?.cli || null;
  }

  getIdePathCandidates(type: string, fallback?: string[]): string[] {
    const override = this.getOptionalStringSetting(type, 'appPathOverride');
    if (override) return [override];
    if (fallback && fallback.length > 0) return fallback;
    const osPaths = this.providers.get(type)?.paths?.[process.platform];
    return Array.isArray(osPaths) ? [...osPaths] : [];
  }

  isMachineProviderEnabled(type: string): boolean {
    const providerType = this.resolveAlias(type);
    const config = this.readConfig();
    return config?.machineProviders?.[providerType]?.enabled === true;
  }

  getMachineProviderConfig(type: string): MachineProviderConfig {
    const providerType = this.resolveAlias(type);
    const raw = this.readConfig()?.machineProviders?.[providerType];
    if (!raw || typeof raw !== 'object') return {};
    const executable = typeof raw.executable === 'string' && raw.executable.trim() ? raw.executable.trim() : undefined;
    return {
      ...(raw.enabled === true ? { enabled: true } : {}),
      ...(executable ? { executable } : {}),
      ...(Array.isArray(raw.args) ? { args: raw.args.filter((arg: unknown): arg is string => typeof arg === 'string') } : {}),
      ...(raw.lastDetection && typeof raw.lastDetection === 'object' ? { lastDetection: raw.lastDetection } : {}),
      ...(raw.lastVerification && typeof raw.lastVerification === 'object' ? { lastVerification: raw.lastVerification } : {}),
    };
  }

  setMachineProviderConfig(type: string, patch: Partial<MachineProviderConfig>): boolean {
    const providerType = this.resolveAlias(type);
    if (!this.providers.has(providerType)) return false;
    const config = this.readConfig();
    if (!config) return false;

    try {
      if (!config.machineProviders) config.machineProviders = {};
      const current: MachineProviderConfig = config.machineProviders[providerType] || {};
      const next: MachineProviderConfig = { ...current };
      const enabledChanged = 'enabled' in patch && current.enabled !== (patch.enabled === true);
      const executableChanged = 'executable' in patch;
      const argsChanged = 'args' in patch;
      if ('enabled' in patch) next.enabled = patch.enabled === true;
      if ('executable' in patch) {
        const executable = typeof patch.executable === 'string' ? patch.executable.trim() : '';
        if (executable) next.executable = executable;
        else delete next.executable;
      }
      if ('args' in patch) {
        if (Array.isArray(patch.args)) next.args = patch.args.filter((arg): arg is string => typeof arg === 'string');
        else delete next.args;
      }
      if (enabledChanged || executableChanged || argsChanged) {
        delete next.lastDetection;
        delete next.lastVerification;
      }
      if ('lastDetection' in patch) {
        if (patch.lastDetection) next.lastDetection = patch.lastDetection;
        else delete next.lastDetection;
      }
      if ('lastVerification' in patch) {
        if (patch.lastVerification) next.lastVerification = patch.lastVerification;
        else delete next.lastVerification;
      }
      config.machineProviders[providerType] = next;
      if (next.enabled !== true) {
        this.providerAvailability.set(providerType, { installed: false, detectedPath: null });
      }
      this.writeConfig(config);
      this.log(`Machine provider config updated: ${providerType}`);
      return true;
    } catch (e) {
      this.log(`Failed to save machine provider config: ${(e as Error).message}`);
      return false;
    }
  }

  setMachineProviderEnabled(type: string, enabled: boolean): boolean {
    return this.setMachineProviderConfig(type, { enabled });
  }

  getMachineProviderStatus(type: string): ProviderMachineStatus {
    const providerType = this.resolveAlias(type);
    if (!this.isMachineProviderEnabled(providerType)) return 'disabled';
    const availability = this.providerAvailability.get(providerType);
    if (!availability) return 'enabled_unchecked';
    return availability.installed ? 'detected' : 'not_detected';
  }

  getSpawnArgs(type: string, fallback: string[] = []): string[] {
    const machineConfig = this.getMachineProviderConfig(type);
    if (machineConfig.args) return [...machineConfig.args];
    return [...fallback];
  }

  private parseArgsSetting(value: string): string[] {
    const args: string[] = [];
    let current = '';
    let quote: 'single' | 'double' | null = null;
    let escaping = false;
    for (const ch of value.trim()) {
      if (escaping) {
        current += ch;
        escaping = false;
        continue;
      }
      if (ch === '\\') {
        escaping = true;
        continue;
      }
      if (quote === 'single') {
        if (ch === "'") quote = null;
        else current += ch;
        continue;
      }
      if (quote === 'double') {
        if (ch === '"') quote = null;
        else current += ch;
        continue;
      }
      if (ch === "'") {
        quote = 'single';
        continue;
      }
      if (ch === '"') {
        quote = 'double';
        continue;
      }
      if (/\s/.test(ch)) {
        if (current) {
          args.push(current);
          current = '';
        }
        continue;
      }
      current += ch;
    }
    if (escaping) current += '\\';
    if (current) args.push(current);
    return args;
  }

  setProviderAvailability(type: string, state: { installed: boolean; detectedPath?: string | null }): void {
    this.providerAvailability.set(type, {
      installed: !!state.installed,
      detectedPath: state.detectedPath ?? null,
    });
  }

  setCliDetectionResults(results: Array<{ id: string; installed: boolean; path?: string }>, replace: boolean = true): void {
    const resultByType = new Map<string, { id: string; installed: boolean; path?: string }>();
    for (const result of results) {
      resultByType.set(this.resolveAlias(result.id), result);
    }

    if (replace) {
      for (const provider of this.providers.values()) {
        if (provider.category === 'cli' || provider.category === 'acp') {
          const result = resultByType.get(provider.type);
          const installed = !!result?.installed;
          const detectedPath = result?.path || null;
          this.providerAvailability.set(provider.type, { installed, detectedPath });
          if (this.isMachineProviderEnabled(provider.type)) {
            this.setMachineProviderConfig(provider.type, {
              lastDetection: {
                ok: installed,
                stage: 'detection',
                checkedAt: new Date().toISOString(),
                command: this.getSpawnCommand(provider.type, provider.spawn?.command),
                path: detectedPath,
                message: installed ? 'Provider command detected' : 'Provider command was not detected',
              },
            });
          }
        }
      }
      return;
    }

    for (const result of results) {
      const providerType = this.resolveAlias(result.id);
      const provider = this.providers.get(providerType);
      const detectedPath = result.path || null;
      this.setProviderAvailability(providerType, {
        installed: !!result.installed,
        detectedPath,
      });
      if (provider && (provider.category === 'cli' || provider.category === 'acp') && this.isMachineProviderEnabled(providerType)) {
        this.setMachineProviderConfig(providerType, {
          lastDetection: {
            ok: !!result.installed,
            stage: 'detection',
            checkedAt: new Date().toISOString(),
            command: this.getSpawnCommand(providerType, provider.spawn?.command),
            path: detectedPath,
            message: result.installed ? 'Provider command detected' : 'Provider command was not detected',
          },
        });
      }
    }
  }

  setIdeDetectionResults(results: Array<{ id: string; installed: boolean; path?: string | null; cliCommand?: string | null }>, replace: boolean = true): void {
    if (replace) {
      for (const provider of this.providers.values()) {
        if (provider.category === 'ide') {
          this.providerAvailability.set(provider.type, { installed: false, detectedPath: null });
        }
      }
    }
    for (const result of results) {
      this.setProviderAvailability(result.id, {
        installed: !!result.installed,
        detectedPath: result.cliCommand || result.path || null,
      });
    }
  }

  getAvailableProviderInfos(): Array<ProviderModule & { installed?: boolean; detectedPath?: string | null; enabled: boolean; machineStatus: ProviderMachineStatus; lastDetection?: MachineProviderCheckResult; lastVerification?: MachineProviderCheckResult }> {
    return this.getAll().map((provider) => {
      const availability = this.providerAvailability.get(provider.type);
      const enabled = this.isMachineProviderEnabled(provider.type);
      const machineConfig = this.getMachineProviderConfig(provider.type);
      return {
        ...provider,
        enabled,
        machineStatus: this.getMachineProviderStatus(provider.type),
        ...(machineConfig.lastDetection ? { lastDetection: machineConfig.lastDetection } : {}),
        ...(machineConfig.lastVerification ? { lastVerification: machineConfig.lastVerification } : {}),
        ...(availability
          ? {
              installed: availability.installed,
              detectedPath: availability.detectedPath,
            }
          : {}),
      };
    });
  }

 /**
 * Register IDE providers to core/detector registry
 * → Enables detectIDEs() to detect provider.js-based IDEs
 */
  registerToDetector(): number {
    let count = 0;
    for (const p of this.providers.values()) {
      if (p.category === 'ide' && p.cli && p.paths) {
        registerIDEDefinition({
          id: p.type,
          name: p.name,
          displayName: p.displayName || p.name,
          icon: p.icon || '💻',
          cli: p.cli,
          paths: p.paths as { darwin?: string[]; win32?: string[]; linux?: string[] },
        });
        count++;
      }
    }
    this.log(`Registered ${count} IDE providers to detector`);
    return count;
  }

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
  resolve(type: string, context?: { os?: string; version?: string }): ResolvedProvider | undefined {
    const base = this.providers.get(type);
    if (!base) return undefined;
    const providerDir = this.findProviderDirInternal(type) || undefined;

    const currentOs = context?.os || process.platform;
    const currentVersion = context?.version ??
      this.versionArchive?.getLatest(type) ??
      undefined;

 // Deep clone to avoid mutating the original
    const resolved: ResolvedProvider = JSON.parse(JSON.stringify(base));
 // Restore RegExp from original (lost during JSON.parse)
    if (base.extensionIdPattern) {
      resolved.extensionIdPattern = base.extensionIdPattern;
    }
 // Restore script functions (lost during JSON.parse)
    if (base.scripts) {
      resolved.scripts = { ...base.scripts };
    }
    if (providerDir) {
      resolved._resolvedProviderDir = providerDir;
    }

 // 1. Apply OS override
    if (base.os?.[currentOs]) {
      const osOverride = base.os[currentOs];
      if (osOverride.scripts) {
        resolved.scripts = { ...resolved.scripts, ...osOverride.scripts };
      }
      if (osOverride.inputMethod) resolved.inputMethod = osOverride.inputMethod;
      if (osOverride.inputSelector) resolved.inputSelector = osOverride.inputSelector;
      resolved._resolvedOs = currentOs;
    }

 // 2. Apply version-based script selection
    if (currentVersion) {
      resolved._resolvedVersion = currentVersion;

      // --- New format: compatibility array ---
      if (base.compatibility) {
        const compat = base.compatibility;
        let matched = false;

        for (const entry of compat) {
          if (this.matchesVersion(currentVersion, entry.ideVersion)) {
            const loaded = this.loadScriptsFromDir(type, entry.scriptDir);
            if (loaded) {
              resolved.scripts = loaded;
              this.log(`  [compatibility] ${type} v${currentVersion} → ${entry.scriptDir}`);
              resolved._resolvedScriptDir = entry.scriptDir;
              resolved._resolvedScriptsSource = `compatibility:${entry.ideVersion}`;
              if (providerDir) {
                const fullDir = path.join(providerDir, entry.scriptDir);
                resolved._resolvedScriptsPath = fs.existsSync(path.join(fullDir, 'scripts.js'))
                  ? path.join(fullDir, 'scripts.js')
                  : fullDir;
              }
              matched = true;
            }
            break; // first match wins
          }
        }

        // No compatibility match → defaultScriptDir
        if (!matched && base.defaultScriptDir) {
          const loaded = this.loadScriptsFromDir(type, base.defaultScriptDir);
          if (loaded) {
            resolved.scripts = loaded;
            this.log(`  [compatibility] ${type} v${currentVersion} → default: ${base.defaultScriptDir}`);
            resolved._resolvedScriptDir = base.defaultScriptDir;
            resolved._resolvedScriptsSource = 'defaultScriptDir:version_miss';
            if (providerDir) {
              const fullDir = path.join(providerDir, base.defaultScriptDir);
              resolved._resolvedScriptsPath = fs.existsSync(path.join(fullDir, 'scripts.js'))
                ? path.join(fullDir, 'scripts.js')
                : fullDir;
            }
          }
          resolved._versionWarning = `Version ${currentVersion} not in compatibility matrix. Using default scripts.`;
        }

      // --- Legacy format: versions field ---
      } else if (base.versions) {
        for (const [range, override] of Object.entries(base.versions)) {
          if (!this.matchesVersion(currentVersion, range)) continue;

          const dirOverride = override.__dir;
          if (dirOverride) {
            const loaded = this.loadScriptsFromDir(type, dirOverride);
            if (loaded) {
              resolved.scripts = loaded;
              this.log(`  [version override] ${type} ${range} → ${dirOverride}`);
              resolved._resolvedScriptDir = dirOverride;
              resolved._resolvedScriptsSource = `versions:${range}`;
              if (providerDir) {
                const fullDir = path.join(providerDir, dirOverride);
                resolved._resolvedScriptsPath = fs.existsSync(path.join(fullDir, 'scripts.js'))
                  ? path.join(fullDir, 'scripts.js')
                  : fullDir;
              }
            }
          } else if (override.scripts) {
            resolved.scripts = { ...resolved.scripts, ...override.scripts };
          }
        }
      }
    } else if (base.compatibility && base.defaultScriptDir) {
      // No version detected but compatibility format → use defaultScriptDir
      const loaded = this.loadScriptsFromDir(type, base.defaultScriptDir);
      if (loaded) {
        resolved.scripts = loaded;
        this.log(`  [compatibility] ${type} no version detected → default: ${base.defaultScriptDir}`);
        resolved._resolvedScriptDir = base.defaultScriptDir;
        resolved._resolvedScriptsSource = 'defaultScriptDir:no_version';
        if (providerDir) {
          const fullDir = path.join(providerDir, base.defaultScriptDir);
          resolved._resolvedScriptsPath = fs.existsSync(path.join(fullDir, 'scripts.js'))
            ? path.join(fullDir, 'scripts.js')
            : fullDir;
        }
      }
    }

 // 3. Composite override (OS + version)
    if (base.overrides) {
      for (const override of base.overrides) {
        const osMatch = !override.when.os || override.when.os === currentOs;
        const verMatch = !override.when.version || (currentVersion && this.matchesVersion(currentVersion, override.when.version));
        if (osMatch && verMatch && override.scripts) {
          resolved.scripts = { ...resolved.scripts, ...override.scripts };
        }
      }
    }

    if ((resolved.category === 'cli' || resolved.category === 'acp') && resolved.spawn?.command) {
      resolved.spawn = {
        ...resolved.spawn,
        command: this.getSpawnCommand(type, resolved.spawn.command),
        args: this.getSpawnArgs(type, resolved.spawn.args || []),
      };
    }

    return resolved;
  }

 /**
  * Load scripts from a scriptDir within a provider directory.
  * Tries scripts.js first, then individual .js files.
  */
  private loadScriptsFromDir(type: string, scriptDir: string): Partial<ProviderScripts> | null {
    const providerDir = this.findProviderDirInternal(type);
    if (!providerDir) {
      this.log(`  [loadScriptsFromDir] ${type}: providerDir not found`);
      return null;
    }

    const dir = path.join(providerDir, scriptDir);
    if (!fs.existsSync(dir)) {
      this.log(`  [loadScriptsFromDir] ${type}: dir not found: ${dir}`);
      return null;
    }

    // Return cached scripts if available (cleared on reload/watch)
    const cached = this.scriptsCache.get(dir);
    if (cached) return cached;

    // Try scripts.js first
    const scriptsJs = path.join(dir, 'scripts.js');
    if (fs.existsSync(scriptsJs)) {
      try {
        delete require.cache[require.resolve(scriptsJs)];
        const loaded = require(scriptsJs);
        this.log(`  [loadScriptsFromDir] ${type}: loaded scripts.js from ${dir} (${Object.keys(loaded).length} exports)`);
        this.scriptsCache.set(dir, loaded);
        return loaded;
      } catch (e) {
        this.log(`  ⚠ scripts.js load failed: ${scriptsJs}: ${(e as Error).message}`);
      }
    }

    // Fallback: build from individual .js files
    const result = this.buildScriptWrappersFromDir(dir);
    this.scriptsCache.set(dir, result);
    return result;
  }

  /**
   * Hot-reload: start watching for file changes
   */
  watch(): void {
    this.stopWatch();
    const watchDir = (dir: string) => {
      if (!fs.existsSync(dir)) {
        try { fs.mkdirSync(dir, { recursive: true }); } catch { return; }
      }
      try {
        const watcher = chokidar.watch(dir, {
          ignored: /(^|[\/\\])\.\./, // ignore dotfiles
          persistent: true,
          ignoreInitial: true,
          awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
        });

        const handleChange = (filePath: string) => {
          if (/[\/\\]fixtures[\/\\]/.test(filePath)) {
            return;
          }
          if (filePath.endsWith('.js') || filePath.endsWith('.json')) {
            this.log(`File changed: ${path.basename(filePath)}, reloading...`);
            this.reload();
          }
        };

        watcher.on('add', handleChange).on('change', handleChange).on('unlink', handleChange);
        watcher.on('error', (err: unknown) => this.log(`Watch error: ${(err as Error).message}`));
        this.watchers.push(watcher);
        this.log(`Hot-reload watcher active: ${dir}`);
      } catch (e) {
        this.log(`Watch failed for ${dir}: ${(e as Error).message}`);
      }
    };
    watchDir(this.userDir);
  }

 /**
 * Stop hot-reload
 */
  stopWatch(): void {
    for (const w of this.watchers) {
      try { w.close(); } catch { }
    }
    this.watchers = [];
  }

 /**
 * Full reload
 */
  reload(): void {
    this.log('Reloading all providers...');
 // Clear caches
    this.scriptsCache.clear();
 // Clear require cache (hot-reload)
    for (const key of Object.keys(require.cache)) {
      if (key.includes('providers') && (key.endsWith('.js') || key.endsWith('.json'))) {
        delete require.cache[key];
      }
    }
    this.loadAll();
  }

 // ─── Upstream Auto-Update ─────────────────────────

 /**
 * Download latest providers tarball from GitHub → extract to .upstream/
 * - ETag-based change detection (skip if unchanged)
 * - Never touches user custom files in ~/.adhdev/providers/
 * - Runs in background; existing providers are kept on failure
 * 
 * @returns Whether an update occurred
 */
  async fetchLatest(): Promise<{ updated: boolean; error?: string }> {
    if (this.disableUpstream) {
      this.log('Upstream fetch skipped (sourceMode=no-upstream)');
      return { updated: false };
    }
    const https = require('https') as typeof import('https');
    const { execSync } = require('child_process') as typeof import('child_process');

    const metaPath = path.join(this.upstreamDir, ProviderLoader.META_FILE);
    let prevEtag = '';
    let prevTimestamp = 0;

 // Read previous metadata
    try {
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        prevEtag = meta.etag || '';
        prevTimestamp = meta.timestamp || 0;
      }
    } catch { }

 // Minimum 30-minute interval (prevent excessive checks)
    const MIN_INTERVAL_MS = 30 * 60 * 1000;
    if (prevTimestamp && (Date.now() - prevTimestamp) < MIN_INTERVAL_MS) {
      this.log('Upstream check skipped (last check < 30min ago)');
      return { updated: false };
    }

    try {
 // Step 1: HEAD request to check ETag
      const etag = await new Promise<string>((resolve, reject) => {
        const options = {
          method: 'HEAD',
          hostname: 'github.com',
          path: '/vilmire/adhdev-providers/archive/refs/heads/main.tar.gz',
          headers: { 'User-Agent': 'adhdev-launcher' },
          timeout: 10000,
        };

        const req = https.request(options, (res) => {
 // GitHub 302 redirect → follow
          if (res.statusCode === 302 && res.headers.location) {
            const url = new URL(res.headers.location);
            const req2 = https.request({
              method: 'HEAD',
              hostname: url.hostname,
              path: url.pathname + (url.search || ''),
              headers: { 'User-Agent': 'adhdev-launcher' },
              timeout: 10000,
            }, (res2) => {
              resolve(res2.headers.etag || res2.headers['last-modified'] || '');
            });
            req2.on('error', reject);
            req2.on('timeout', () => { req2.destroy(); reject(new Error('timeout')); });
            req2.end();
          } else {
            resolve(res.headers.etag || res.headers['last-modified'] || '');
          }
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      });

 // Compare ETag — skip if unchanged
      if (etag && etag === prevEtag) {
 // Update timestamp only
        this.writeMeta(metaPath, prevEtag, Date.now());
        this.log('Upstream unchanged (ETag match)');
        return { updated: false };
      }

 // Step 2: Download + extract
      this.log('Downloading latest providers from GitHub...');

      const tmpTar = path.join(os.tmpdir(), `adhdev-providers-${Date.now()}.tar.gz`);
      const tmpExtract = path.join(os.tmpdir(), `adhdev-providers-extract-${Date.now()}`);

 // Download tarball
      await this.downloadFile(ProviderLoader.GITHUB_TARBALL_URL, tmpTar);

 // Extract
      fs.mkdirSync(tmpExtract, { recursive: true });
      execSync(`tar -xzf "${tmpTar}" -C "${tmpExtract}"`, { timeout: 30000 });

 // Tarball internal structure: adhdev-providers-main/ide/... → strip 1 level
      const extracted = fs.readdirSync(tmpExtract);
      const rootDir = extracted.find(d =>
        fs.statSync(path.join(tmpExtract, d)).isDirectory() && d.startsWith('adhdev-providers')
      );
      if (!rootDir) throw new Error('Unexpected tarball structure');

      const sourceDir = path.join(tmpExtract, rootDir);

 // .upstream replacement (atomic-ish: rename old → copy new → delete old)
      const backupDir = this.upstreamDir + '.bak';
      if (fs.existsSync(this.upstreamDir)) {
 // Backup
        if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
        fs.renameSync(this.upstreamDir, backupDir);
      }

      try {
 // Copy new upstream
        this.copyDirRecursive(sourceDir, this.upstreamDir);
 // Save metadata
        this.writeMeta(metaPath, etag || `ts-${Date.now()}`, Date.now());
 // Backup remove
        if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
      } catch (e) {
 // Restore backup on copy failure
        if (fs.existsSync(backupDir)) {
          if (fs.existsSync(this.upstreamDir)) fs.rmSync(this.upstreamDir, { recursive: true, force: true });
          fs.renameSync(backupDir, this.upstreamDir);
        }
        throw e;
      }

 // Cleanup temp
      try { fs.rmSync(tmpTar, { force: true }); } catch { }
      try { fs.rmSync(tmpExtract, { recursive: true, force: true }); } catch { }

      const upstreamCount = this.countProviders(this.upstreamDir);
      this.log(`✅ Upstream updated: ${upstreamCount} providers`);

      return { updated: true };
    } catch (e: any) {
      this.log(`⚠ Upstream fetch failed (using existing): ${e?.message}`);
 // Update timestamp even on failure (prevent continuous retries)
      this.writeMeta(metaPath, prevEtag, Date.now());
      return { updated: false, error: e?.message };
    }
  }

 /** HTTP(S) file download (follows redirects) */
  private downloadFile(url: string, destPath: string): Promise<void> {
    const https = require('https') as typeof import('https');
    const http = require('http') as typeof import('http');

    return new Promise((resolve, reject) => {
      const doRequest = (reqUrl: string, redirectCount = 0) => {
        if (redirectCount > 5) { reject(new Error('Too many redirects')); return; }
        const mod = reqUrl.startsWith('https') ? https : http;
        const req = mod.get(reqUrl, { headers: { 'User-Agent': 'adhdev-launcher' }, timeout: 60000 }, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            doRequest(res.headers.location!, redirectCount + 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          const ws = fs.createWriteStream(destPath);
          res.pipe(ws);
          ws.on('finish', () => { ws.close(); resolve(); });
          ws.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
      };
      doRequest(url);
    });
  }

 /** Recursive directory copy */
  private copyDirRecursive(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        this.copyDirRecursive(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

 /** .meta.json save */
  private writeMeta(metaPath: string, etag: string, timestamp: number): void {
    try {
      fs.mkdirSync(path.dirname(metaPath), { recursive: true });
      fs.writeFileSync(metaPath, JSON.stringify({
        etag,
        timestamp,
        lastCheck: new Date(timestamp).toISOString(),
        source: ProviderLoader.GITHUB_TARBALL_URL,
      }, null, 2));
    } catch { }
  }

  /** Count provider files (provider.js or provider.json) */
  private countProviders(dir: string): number {
    if (!fs.existsSync(dir)) return 0;
    let count = 0;
    const scan = (d: string) => {
      try {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (entry.isDirectory()) scan(path.join(d, entry.name));
          else if (entry.name === 'provider.json') count++;
        }
      } catch { }
    };
    scan(dir);
    return count;
  }

 // ─── Provider Settings API ─────────────────────────

 /**
 * Get public settings schema for a provider (for dashboard UI rendering)
 */
  getPublicSettings(type: string): ProviderSettingSchema[] {
    const settings = this.getSettingsSchema(type);
    return Object.entries(settings)
      .filter(([, def]) => def.public === true)
      .map(([key, def]) => ({ key, ...def }));
  }

 /**
 * Get public settings schema for all providers
 */
  getAllPublicSettings(): Record<string, ProviderSettingSchema[]> {
    const result: Record<string, ProviderSettingSchema[]> = {};
    for (const [type] of this.providers) {
      const settings = this.getPublicSettings(type);
      if (settings.length > 0) result[type] = settings;
    }
    return result;
  }

 /**
 * Resolved setting value for a provider (default + user override)
 */
  getSettingValue(type: string, key: string): any {
    const providerType = this.resolveAlias(type);
    const machineConfig = this.getMachineProviderConfig(providerType);
    if (key === 'enabled') {
      return machineConfig.enabled === true;
    }
    if (key === 'executablePath') {
      return machineConfig.executable || '';
    }
    if (key === 'executableArgs') {
      const args = machineConfig.args;
      return args ? args.map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(' ') : '';
    }
    const schemaDef = this.getSettingsSchema(providerType)[key];
    const defaultVal = schemaDef
      ? (key === 'autoApprove' && schemaDef.type === 'boolean'
        ? true
        : schemaDef.default)
      : undefined;

    const config = this.readConfig();
    const userVal = config?.providerSettings?.[providerType]?.[key];
    return userVal !== undefined ? userVal : defaultVal;
  }

 /**
 * All resolved settings for a provider (default + user override)
 */
  getSettings(type: string): Record<string, any> {
    const providerType = this.resolveAlias(type);
    const settings = this.getSettingsSchema(providerType);
    const result: Record<string, any> = {};
    for (const [key] of Object.entries(settings)) {
      result[key] = this.getSettingValue(providerType, key);
    }
    return result;
  }

 /**
 * Save provider setting value (writes to config.json)
 */
  setSetting(type: string, key: string, value: any): boolean {
    const providerType = this.resolveAlias(type);
    const schemaDef = this.getSettingsSchema(providerType)[key];
    if (!schemaDef) return false;

 // Non-public settings cannot be modified externally
    if (!schemaDef.public) return false;

 // Type validation
    if (schemaDef.type === 'boolean' && typeof value !== 'boolean') return false;
    if (schemaDef.type === 'string' && typeof value !== 'string') return false;
    if (schemaDef.type === 'number') {
      if (typeof value !== 'number') return false;
      if (schemaDef.min !== undefined && value < schemaDef.min) return false;
      if (schemaDef.max !== undefined && value > schemaDef.max) return false;
    }
    if (schemaDef.type === 'select' && schemaDef.options && !schemaDef.options.includes(value)) return false;

    if (key === 'enabled') {
      return this.setMachineProviderEnabled(providerType, value);
    }
    if (key === 'executablePath') {
      return this.setMachineProviderConfig(providerType, { executable: value });
    }
    if (key === 'executableArgs') {
      return this.setMachineProviderConfig(providerType, {
        args: value.trim() ? this.parseArgsSetting(value) : undefined,
      });
    }

    const config = this.readConfig();
    if (!config) return false;

    try {
      if (!config.providerSettings) config.providerSettings = {};
      if (!config.providerSettings[providerType]) config.providerSettings[providerType] = {};
      config.providerSettings[providerType][key] = value;
      this.writeConfig(config);
      this.log(`Setting updated: ${providerType}.${key} = ${JSON.stringify(value)}`);
      return true;
    } catch (e) {
      this.log(`Failed to save setting: ${(e as Error).message}`);
      return false;
    }
  }

  private getOptionalStringSetting(type: string, key: string): string | null {
    const value = this.getSettingValue(type, key);
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  protected readConfig(): any | null {
    try {
      const { loadConfig } = require('../config/config.js');
      return loadConfig();
    } catch {
      return null;
    }
  }

  protected writeConfig(config: any): void {
    const { saveConfig } = require('../config/config.js');
    saveConfig(config);
  }

  private getPlatformVersionCommand(versionCommand?: ProviderModule['versionCommand']): string | undefined {
    if (!versionCommand) return undefined;
    if (typeof versionCommand === 'string') {
      const trimmed = versionCommand.trim();
      return trimmed || undefined;
    }
    const platformValue = versionCommand[process.platform];
    if (typeof platformValue === 'string' && platformValue.trim()) {
      return platformValue.trim();
    }
    const defaultValue = versionCommand.default;
    if (typeof defaultValue === 'string' && defaultValue.trim()) {
      return defaultValue.trim();
    }
    return undefined;
  }

  private getSettingsSchema(type: string): Record<string, ProviderSettingDef> {
    const provider = this.providers.get(type);
    if (!provider) return {};
    const result = {
      ...this.getSyntheticSettings(type, provider),
      ...(provider.settings || {}),
    };
    if (result.autoApprove?.type === 'boolean') {
      result.autoApprove = {
        ...result.autoApprove,
        default: true,
        public: true,
        label: result.autoApprove.label || 'Auto Approve',
        description: result.autoApprove.description || 'Automatically approve actionable prompts without sending approval alerts.',
      };
    }
    return result;
  }

  private getSyntheticSettings(type: string, provider: ProviderModule): Record<string, ProviderSettingDef> {
    const result: Record<string, ProviderSettingDef> = {};

    if (provider.category === 'cli' || provider.category === 'acp') {
      result.enabled = {
        type: 'boolean',
        default: false,
        public: true,
        label: 'Enabled on this machine',
        description: 'Opt in before ADHDev detects, launches, or verifies this provider on this machine.',
      };
    }

    if (!provider.settings?.autoApprove) {
      result.autoApprove = {
        type: 'boolean',
        default: true,
        public: true,
        label: 'Auto Approve',
        description: 'Automatically approve actionable prompts without sending approval alerts.',
      };
    }

    if ((provider.category === 'cli' || provider.category === 'acp') && provider.spawn?.command && !provider.settings?.executablePath) {
      result.executablePath = {
        type: 'string',
        default: '',
        public: true,
        label: 'Executable path',
        description: 'Optional absolute path for this provider binary. Leave blank to use the default PATH lookup.',
      };
    }

    if ((provider.category === 'cli' || provider.category === 'acp') && provider.spawn?.command && !provider.settings?.executableArgs) {
      result.executableArgs = {
        type: 'string',
        default: '',
        public: true,
        label: 'Executable arguments',
        description: 'Optional replacement for provider default command arguments. Leave blank to use the provider default.',
      };
    }

    if (provider.category === 'ide') {
      if (provider.cli && !provider.settings?.cliPathOverride) {
        result.cliPathOverride = {
          type: 'string',
          default: '',
          public: true,
          label: 'CLI path override',
          description: 'Optional absolute path for the IDE CLI launcher. Leave blank to use the detected default.',
        };
      }
      if (provider.paths && !provider.settings?.appPathOverride) {
        result.appPathOverride = {
          type: 'string',
          default: '',
          public: true,
          label: 'App path override',
          description: 'Optional absolute path for the IDE app bundle or executable. Leave blank to use the default install locations.',
        };
      }
    }

    return result;
  }

 // ─── Private ───────────────────────────────────

  /**
   * Find the on-disk directory for a provider by type.
   * Canonical shape: root/category/type.
   */
  private findProviderDirInternal(type: string): string | null {
    const provider = this.providers.get(type);
    if (!provider) return null;
    const cat = provider.category;

    const searchRoots = this.getProviderRoots();
    for (const root of searchRoots) {
      if (!fs.existsSync(root)) continue;
      const candidate = this.getProviderDir(root, cat, type);
      if (fs.existsSync(path.join(candidate, 'provider.json'))) return candidate;
      // Scan category dir for type match
      const catDir = path.join(root, cat);
      if (fs.existsSync(catDir)) {
        try {
          for (const entry of fs.readdirSync(catDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const jsonPath = path.join(catDir, entry.name, 'provider.json');
            if (fs.existsSync(jsonPath)) {
              try {
                const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
                if (data.type === type) return path.join(catDir, entry.name);
              } catch { /* skip */ }
            }
          }
        } catch { /* skip */ }
      }
    }
    return null;
  }

  /**
   * Build a scripts function map from individual .js files in a directory.
   * Each file is wrapped as: (params?) => fs.readFileSync(filePath, 'utf-8')
   * (template substitution is NOT applied here — scripts.js handles that)
   */
  private buildScriptWrappersFromDir(dir: string): Partial<ProviderScripts> {
    // Use a dedicated scripts.js in the alt dir if present
    const scriptsJs = path.join(dir, 'scripts.js');
    if (fs.existsSync(scriptsJs)) {
      try {
        delete require.cache[require.resolve(scriptsJs)];
        return require(scriptsJs);
      } catch { /* fall through to individual file loading */ }
    }

    // Individual files: list_models.js → scripts.listModels, etc.
    const toCamel = (name: string) =>
      name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

    const result: Partial<ProviderScripts> = {};
    try {
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.js')) continue;
        const scriptName = toCamel(file.replace('.js', ''));
        const filePath = path.join(dir, file);
        result[scriptName] = (...args: any[]): string => {
          try {
            let content = fs.readFileSync(filePath, 'utf-8');
            if (args[0] && typeof args[0] === 'object') {
              for (const [key, val] of Object.entries(args[0])) {
                let v = val;
                if (typeof v === 'string') {
                  // If it doesn't start with a quote, user probably passed raw text
                  if (!v.startsWith('"') && !v.startsWith("'") && !v.startsWith('`')) {
                    v = JSON.stringify(v);
                  }
                } else {
                  v = JSON.stringify(v);
                }
                const re = new RegExp(`\\$\\{\\s*${key}\\s*\\}`, 'g');
                content = content.replace(re, String(v));
              }
            } else if (typeof args[0] === 'string') {
              // Fallback for single-string arg passed as firstVal
              const re = new RegExp(`\\$\\{\\s*MESSAGE\\s*\\}`, 'g');
              let v = args[0];
              if (!v.startsWith('"') && !v.startsWith("'") && !v.startsWith('`')) {
                v = JSON.stringify(v);
              }
              content = content.replace(re, String(v));
            } else if (args[0] !== undefined) {
               // legacy fallback for single argument usually MESSAGE
               let v = String(args[0]);
               if (!v.startsWith('"') && !v.startsWith("'") && !v.startsWith('`')) {
                   v = JSON.stringify(v);
               }
               content = content.replace(new RegExp(`\\$\\{\\s*MESSAGE\\s*\\}`, 'g'), v);
            }
            return content;
          } catch { return ''; }
        };
      }
    } catch { /* ignore */ }
    return result;
  }

 /**
  * Recursively scan directory to load provider files
  * Supports two formats:
  *   1. provider.json (metadata) + scripts.js (optional CDP scripts)
  *   2. provider.js (legacy — everything in one file)
  * Structure: dir/category/agent-name/provider.{json,js}
  */
   private loadDir(dir: string, excludeDirs?: string[]): number {
    if (!fs.existsSync(dir)) return 0;
    let count = 0;

    const scan = (d: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }

      // Check if this directory has provider.json
      const hasJson = entries.some(e => e.name === 'provider.json');

      if (hasJson) {
        const jsonPath = path.join(d, 'provider.json');
        try {
          const raw = fs.readFileSync(jsonPath, 'utf-8');
          const mod = JSON.parse(raw) as Omit<ProviderModule, 'extensionIdPattern'> & {
            extensionIdPattern?: RegExp | string;
          };

          // Restore RegExp fields from JSON (extensionIdPattern)
          if (typeof mod.extensionIdPattern === 'string') {
            const flags = mod.extensionIdPattern_flags || '';
            mod.extensionIdPattern = new RegExp(mod.extensionIdPattern, flags);
          }
          const { extensionIdPattern_flags, extensionIdPattern, ...providerFields } = mod;
          const normalizedProvider: ProviderModule = {
            ...providerFields,
            ...(extensionIdPattern instanceof RegExp ? { extensionIdPattern } : {}),
          };

          const validation = validateProviderDefinition(normalizedProvider);
          for (const warning of validation.warnings) {
            this.log(`⚠ ${jsonPath}: ${warning}`);
          }
          if (validation.errors.length > 0) {
            this.log(`⚠ Invalid provider at ${jsonPath}: ${validation.errors.join('; ')}`);
          } else {
            // Load scripts.js if exists (IDE/Extension)
            // Skip for compatibility-format providers — scripts loaded lazily in resolve()
            const hasCompatibility = Array.isArray(normalizedProvider.compatibility);
            const scriptsPath = path.join(d, 'scripts.js');
            if (!hasCompatibility && fs.existsSync(scriptsPath)) {
              try {
                delete require.cache[require.resolve(scriptsPath)];
                const scripts = require(scriptsPath) as Partial<ProviderScripts>;
                normalizedProvider.scripts = scripts;
              } catch (e) {
                this.log(`⚠ Failed to load scripts: ${scriptsPath}: ${(e as Error).message}`);
              }
            }

            const existed = this.providers.has(normalizedProvider.type);
            this.providers.set(normalizedProvider.type, normalizedProvider);
            count++;
            // Identify source tier for debugging
            const source = d.startsWith(this.userDir) && !d.includes('.upstream')
              ? 'user' : 'upstream';
            const overrideWarning = existed && source === 'user' ? ' ⚠ OVERRIDES upstream' : '';
            this.log(`  ${existed ? '🔄' : '✅'} ${normalizedProvider.type} (${normalizedProvider.category}) — ${normalizedProvider.name} [${source}]${overrideWarning}`);
          }
        } catch (e) {
          this.log(`⚠ Failed to load ${jsonPath}: ${(e as Error).message}`);
        }
      }

      // Continue scanning subdirectories (only for dirs without provider.json)
      if (!hasJson) {
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
          if (excludeDirs && d === dir && excludeDirs.includes(entry.name)) continue;
          scan(path.join(d, entry.name));
        }
      }
    };

    scan(dir);
    return count;
  }

 /**
 * Simple semver range matching
 * Supported formats: '>=4.0.0', '<3.0.0', '>=2.1.0'
 */
  private matchesVersion(current: string, range: string): boolean {
    const match = range.match(/^([><=!]+)\s*(\d+\.\d+\.\d+)$/);
    if (!match) return false;

    const [, op, target] = match;
    const cmp = this.compareVersions(current, target);

    switch (op) {
      case '>=': return cmp >= 0;
      case '>': return cmp > 0;
      case '<=': return cmp <= 0;
      case '<': return cmp < 0;
      case '=':
      case '==': return cmp === 0;
      case '!=': return cmp !== 0;
      default: return false;
    }
  }

  private compareVersions(a: string, b: string): number {
    const normalize = (v: string) => v.split(/[-_+]/)[0].split('.').map(x => parseInt(x, 10) || 0);
    const pa = normalize(a);
    const pb = normalize(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const va = pa[i] || 0;
      const vb = pb[i] || 0;
      if (va !== vb) return va - vb;
    }
    return 0;
  }
}
