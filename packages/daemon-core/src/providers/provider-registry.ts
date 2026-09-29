/**
 * ProviderRegistry — the loaded provider map and everything answered from it
 * plus this machine's provider config: alias resolution, category/IDE
 * lookups, per-machine enablement / executable / detection state, the
 * provider settings API, and the model-discovery inventory overlay.
 *
 * Split out of provider-loader.ts (file-size gate). ProviderLoader extends it
 * with discovery/loading (sources, verified channel, script resolution, hot
 * reload); this half never touches the filesystem layout.
 */
import { registerIDEDefinition } from '../detection/ide-detector.js';
import type { ProviderModule, ProviderCategory } from './contracts.js';
import type { ProviderSettingDef, ProviderSettingSchema } from './provider-control-contracts.js';
import {
  parseArgsSetting,
  getPlatformVersionCommand,
  getSyntheticSettings,
  resolveWrappedCliBinary,
} from './provider-loader-support.js';
// Model-discovery overlay: a synchronous, side-effect-free read of the
// discovery cache, merged over the manifest's advisory modelOptions. See
// models/overlay.ts for why discovery outranks the manifest for this one field
// and why the manifest is never written back to.
import { buildModelOverlayPatch } from '../models/overlay.js';
import { readModelCache } from '../models/registry.js';
import type {
    CliDetectionEntry, MachineProviderCheckResult, MachineProviderConfig, ProviderAvailabilityState, ProviderMachineStatus,
} from './provider-loader-types.js';

export abstract class ProviderRegistry {
  protected providers = new Map<string, ProviderModule>();
  protected providerAvailability = new Map<string, ProviderAvailabilityState>();

  protected abstract log(msg: string): void;

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
 *
 * `categories` narrows resolution to the given provider categories. Without it
 * the resolution order is unchanged (direct type match first, then alias scan)
 * — every existing caller keeps its exact behaviour.
 *
 * The hint exists because provider types and aliases share one namespace across
 * categories, so a direct match can shadow an alias that a category-scoped
 * caller actually wants. Concretely: `extension/codex` declares `type: 'codex'`
 * while `cli/codex-cli` declares `aliases: ['codex']`, so unscoped
 * `resolveAlias('codex')` returns the IDE-webview provider. `adhdev launch`
 * only ever starts a cli session, so it passes `['cli']` and gets
 * `codex-cli`. Within a scope the direct-match-first order still holds.
 */
  resolveAlias(input: string, categories?: readonly ProviderCategory[]): string {
    const inScope = (p: ProviderModule | undefined): boolean =>
      !!p && (!categories || categories.includes(p.category));

 // 1. directly match
    const direct = this.providers.get(input);
    if (inScope(direct)) return input;
 // 2. alias match
    for (const p of this.providers.values()) {
      if (p.aliases?.includes(input) && inScope(p)) return p.type;
    }
    return input;
  }

 /**
 * Get provider with alias resolution (get + alias fallback)
 * `categories` narrows resolution the same way as `resolveAlias`, and also
 * filters the returned module so an out-of-scope provider is never handed back.
 */
  getByAlias(input: string, categories?: readonly ProviderCategory[]): ProviderModule | undefined {
    const resolved = this.providers.get(this.resolveAlias(input, categories));
    if (resolved && categories && !categories.includes(resolved.category)) return undefined;
    return resolved;
  }

 /**
 * Build CLI detection list (replaces cli-detector)
 * Dynamically generated from provider.js spawn.command.
 *
 * By default this only returns providers already enabled for this machine
 * (config.machineProviders[type].enabled === true) — that's the right scope
 * for `launch`, which must not spawn something the user never opted into.
 *
 * `includeDisabled: true` returns every cli provider with a spawn
 * command regardless of the enabled flag, with `enabled` reporting the REAL
 * per-provider state instead of the hardcoded `true` the gated list implies.
 * This exists for first-run setup detection: a fresh machine's
 * machineProviders is `{}` (nothing enabled yet), so the gated list is always
 * empty and setup could never show what it actually found on disk — the
 * wizard needs to see candidates BEFORE anything has been enabled.
 */
  getCliDetectionList(options?: { includeDisabled?: boolean }): CliDetectionEntry[] {
    const result: CliDetectionEntry[] = [];
    for (const p of this.providers.values()) {
      const enabled = this.isMachineProviderEnabled(p.type);
      if ((p.category === 'cli') && p.spawn?.command && (enabled || options?.includeDisabled)) {
        const versionCommand = getPlatformVersionCommand(p.versionCommand);
        const command = this.getSpawnCommand(p.type, p.spawn.command);
        const args = this.getSpawnArgs(p.type, p.spawn.args || []);
        // Only when no machine executable override is set (then `command` IS the override).
        const wrappedBinary = command === p.spawn.command
          ? resolveWrappedCliBinary(p.spawn.command, (p as { binary?: unknown }).binary)
          : undefined;
        result.push({
          id: p.type,
          displayName: p.displayName || p.name,
          icon: p.icon || '🔧',
          command,
          ...(args.length > 0 ? { args } : {}),
          ...(wrappedBinary ? { detectCommand: wrappedBinary } : {}),
          category: p.category,
          enabled,
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

  /**
   * Whether this provider's quota is probed on this machine. An INDEPENDENT
   * axis from isMachineProviderEnabled (which gates launching and mesh
   * claims): a machine can use a provider and still opt out of quota reads.
   * Absent = enabled, so configs written before this axis existed keep
   * probing; only an explicit `false` stops the probe.
   */
  isMachineQuotaEnabled(type: string): boolean {
    const providerType = this.resolveAlias(type);
    return this.readConfig()?.machineProviders?.[providerType]?.quotaEnabled !== false;
  }

  getMachineProviderConfig(type: string): MachineProviderConfig {
    const providerType = this.resolveAlias(type);
    const raw = this.readConfig()?.machineProviders?.[providerType];
    if (!raw || typeof raw !== 'object') return {};
    const executable = typeof raw.executable === 'string' && raw.executable.trim() ? raw.executable.trim() : undefined;
    return {
      ...(raw.enabled === true ? { enabled: true } : {}),
      ...(typeof raw.quotaEnabled === 'boolean' ? { quotaEnabled: raw.quotaEnabled } : {}),
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
      if ('quotaEnabled' in patch) {
        // Unset IS enabled — storing an explicit `true` would be noise, so
        // enabling removes the key. This axis changes no launch behaviour, so
        // lastDetection/lastVerification are deliberately left alone.
        if (patch.quotaEnabled === false) next.quotaEnabled = false;
        else delete next.quotaEnabled;
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

  setMachineQuotaEnabled(type: string, enabled: boolean): boolean {
    return this.setMachineProviderConfig(type, { quotaEnabled: enabled });
  }

  protected getEffectiveProviderAvailability(type: string): ProviderAvailabilityState | undefined {
    const providerType = this.resolveAlias(type);
    const availability = this.providerAvailability.get(providerType);
    if (availability) return availability;

    const machineConfig = this.getMachineProviderConfig(providerType);
    const lastDetection = machineConfig.lastDetection;
    if (!lastDetection) return undefined;
    return {
      installed: lastDetection.ok === true,
      detectedPath: typeof lastDetection.path === 'string' && lastDetection.path.trim()
        ? lastDetection.path.trim()
        : null,
    };
  }

  getMachineProviderStatus(type: string): ProviderMachineStatus {
    const providerType = this.resolveAlias(type);
    if (!this.isMachineProviderEnabled(providerType)) return 'disabled';
    const availability = this.getEffectiveProviderAvailability(providerType);
    if (!availability) return 'enabled_unchecked';
    return availability.installed ? 'detected' : 'not_detected';
  }

  getSpawnArgs(type: string, fallback: string[] = []): string[] {
    const machineConfig = this.getMachineProviderConfig(type);
    if (machineConfig.args) return [...machineConfig.args];
    return [...fallback];
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
        if (provider.category === 'cli') {
          const result = resultByType.get(provider.type);
          const installed = !!result?.installed;
          const detectedPath = result?.path || null;
          this.providerAvailability.set(provider.type, { installed, detectedPath });
          if (this.isMachineProviderEnabled(provider.type)) this.stampLastDetection(provider, installed, detectedPath);
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
      if (provider && (provider.category === 'cli') && this.isMachineProviderEnabled(providerType)) {
        this.stampLastDetection(provider, !!result.installed, detectedPath);
      }
    }
  }

  /** Persist a CLI detection outcome as the provider's machine `lastDetection`. */
  private stampLastDetection(provider: ProviderModule, installed: boolean, detectedPath: string | null): void {
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
      const availability = this.getEffectiveProviderAvailability(provider.type);
      const enabled = this.isMachineProviderEnabled(provider.type);
      const machineConfig = this.getMachineProviderConfig(provider.type);
      // ★MODEL-DISCOVERY OVERLAY. This is the single merge point: every model
      // picker (new-session dialog, mesh slot editor) reads
      // its list from this inventory via modelOptionsForProvider, so applying
      // the overlay here fixes all of them at once and none of them can drift.
      //
      // `readModelCache` is a synchronous Map lookup that CANNOT fetch — this
      // runs on the inventory path, which is hot. Refreshes happen on the
      // registry's own schedule; see models/registry.ts.
      //
      // A non-ok (or absent) snapshot yields an empty patch, so the manifest's
      // own modelOptions stand. That is the fallback guarantee: a signed-out or
      // offline CLI can never blank a picker.
      const modelPatch = buildModelOverlayPatch(readModelCache(provider.type), provider);
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
        ...modelPatch,
      };
    });
  }

  /**
   * Which providers' model lists could not be verified on this machine, and
   * why — the input to the "cannot verify" badge.
   *
   * ★Three states, deliberately distinguished, because collapsing them is how a
   * UI ends up claiming a list is current when nothing ever checked it:
   *   - `cannotVerify` — the provider DECLARES it cannot be discovered
   *     (`kind: 'none'`: claude-cli, hermes-cli). Honest permanent state.
   *   - `stale`        — discovery is supported but the last attempt FAILED
   *     (signed out, offline, unparseable). The manifest list is in force and
   *     may be wrong.
   *   - neither        — discovered successfully; the list is ground truth.
   */
  getModelDiscoveryStaleness(): { cannotVerifyTypes: string[]; staleTypes: string[] } {
    const cannotVerifyTypes: string[] = [];
    const staleTypes: string[] = [];
    for (const provider of this.getAll()) {
      if (provider.category !== 'cli') continue;
      const spec = (provider as { modelDiscovery?: { kind?: string } }).modelDiscovery;
      if (!spec || spec.kind === 'none') {
        // Undeclared and declared-none both mean "nothing checked this list".
        cannotVerifyTypes.push(provider.type);
        continue;
      }
      // Only providers this machine can actually run are judged: a CLI that is
      // not installed here has no list to be stale about, and flagging it would
      // fill the badge with rows the user cannot act on.
      if (!this.isMachineProviderEnabled(provider.type)) continue;
      const snapshot = readModelCache(provider.type);
      if (!snapshot || snapshot.status !== 'ok') staleTypes.push(provider.type);
    }
    cannotVerifyTypes.sort();
    staleTypes.sort();
    return { cannotVerifyTypes, staleTypes };
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
    // (fix) Previously this hard-coded `autoApprove` boolean default to `true`,
    // overriding whatever schemaDef.default the provider.json declared. That
    // surfaced as soon as a provider added an `autoApprove` schema entry with
    // default=false: the user had never opted in but the daemon treated the
    // session as auto-approve, which then triggered recordAutoApproval every
    // time the CLI showed an approval modal — producing a flood of system
    // "Auto-approved: ..." messages and keeping the session pinned to
    // generating while modals cycled in and out. Trust the schemaDef.default.
    const defaultVal = schemaDef ? schemaDef.default : undefined;

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
        args: value.trim() ? parseArgsSetting(value) : undefined,
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

  protected getOptionalStringSetting(type: string, key: string): string | null {
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

  protected getSettingsSchema(type: string): Record<string, ProviderSettingDef> {
    const provider = this.providers.get(type);
    if (!provider) return {};
    const result = {
      ...getSyntheticSettings(provider),
      ...(provider.settings || {}),
    };
    // (fix) Previously this clause forced `autoApprove.default = true` for any
    // boolean autoApprove schema, even when the provider.json explicitly set
    // `default: false`. Combined with the synthetic-settings fallback at
    // getSyntheticSettings (which also defaults autoApprove to true when the
    // provider doesn't supply one), that meant CLI providers silently turned on
    // auto-approval, producing a flood of "Auto-approved: ..." system messages
    // every time an approval modal appeared and pinning the session to
    // generating while modals cycled. Trust the provider's declared default.
    if (result.autoApprove?.type === 'boolean') {
      result.autoApprove = {
        ...result.autoApprove,
        public: true,
        label: result.autoApprove.label || 'Auto Approve',
        description: result.autoApprove.description || 'Automatically approve actionable prompts without sending approval alerts.',
      };
    }
    return result;
  }
}
