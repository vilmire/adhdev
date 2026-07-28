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
import { sha256Hex } from '../system/hash.js';
import { LOG } from '../logging/logger.js';
import { VersionArchive } from './version-archive.js';
import type {
  ProviderCompatibilityEntry,
  ProviderControlDef,
  ProviderModule,
  ProviderCategory,
  ProviderScripts,
  ProviderSettingDef,
  ProviderSettingSchema,
  ResolvedProvider,
} from './contracts.js';
import { validateProviderDefinition } from './provider-schema.js';
import {
  loadProvidersActive,
  resolveActiveSource,
} from './external-sources.js';
import type { ProviderSourceMode } from '../config/config.js';
import { getConfigDir } from '../config/config.js';
import {
  resolveRegistryBaseUrl,
  resolveProviderTarballUrl,
  resolveProviderTarballTarget,
} from '../config/registry-resolver.js';
import type { ProviderSourceConfigSnapshot, ProviderUserDirSource } from '../config/provider-source-config.js';
import { executeNativeHistory, executeNativeHistoryList } from './spec/native-history-executor.js';
import { createNativeHistoryDispatcher, type ReaderId } from './native-history/dispatcher.js';
import { resolveProviderChannel, type ProviderChannel } from './channel/contract.js';
import { ProviderChannelStore } from './channel/store.js';
import {
  ProviderChannelRuntime,
  collectSyncTargetTypes,
  type ChannelSyncReport,
} from './channel/runtime.js';

/**
 * Adds a provider-script root to the require whitelist. Wrapped in a
 * try/catch + null check so a loader hot-path can't crash on a path
 * that doesn't exist yet or one the whitelist hook rejects.
 *
 * The require-whitelist module is loaded lazily on first call. Eagerly
 * top-level importing it pulls `node:fs.realpathSync.native` into
 * module evaluation, which breaks unit tests that partially mock `fs`
 * (e.g. test/commands/get-logs-incremental.test.ts mocks only
 * existsSync + readFileSync). Lazy load keeps that mock surface valid.
 */
function registerProviderScriptRootSafely(root: string | null | undefined): void {
  if (!root || typeof root !== 'string') return;
  try {
    const { registerProviderScriptRoot } =
      require('./sdk/v1/sandbox/require-whitelist.js') as typeof import('./sdk/v1/sandbox/require-whitelist.js');
    registerProviderScriptRoot(root);
  } catch { /* boot-time only — swallow */ }
}

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

/**
 * Translate a spec `control_bar` array into the web-facing
 * `ProviderControlDef[]` shape the dashboard renders.
 *
 * The two shapes are distinct: `control_bar` entries are daemon-side
 * `{ id, label, visible_when_state, action }` records driving
 * SpecCliAdapter.invokeScript, while the dashboard's chat bar reads
 * `ProviderControlDef` (`{ id, type, label, placement, ... }`). Spec
 * providers (claude-cli / codex-cli) historically declared *only*
 * `control_bar`, so the dashboard saw no controls at all — the Model / Mode
 * pickers never rendered. This bridges that gap without changing how the
 * controls actually dispatch.
 *
 * Script-name contract: the dashboard sends the control's
 * `listScript` / `setScript` / `invokeScript` name through
 * `invoke_provider_script`, which gates on `provider.scripts[<name>]` and then
 * routes to `SpecCliAdapter.invokeScript(<name>)` — which matches the name
 * against `control_bar[].id`. So every synthesized script name MUST equal the
 * control id (the loader stubs `provider.scripts[id]` from the same source).
 *
 * Mapping:
 *   open_picker  → select (dynamic): list + set both keyed on the control id;
 *                  the adapter distinguishes LIST vs SELECT by the presence of
 *                  a choice arg, so one id serves both roles.
 *   send_keys    → action: one-shot keystroke (stop, cycle_mode).
 *   attach_image → skipped: it needs an image blob from a file picker, not a
 *                  bare bar button; surfacing it as an `action` would only
 *                  produce a button that errors with "requires args.blob".
 */
function synthesizeControlsFromControlBar(specControls: any[]): ProviderControlDef[] {
  const out: ProviderControlDef[] = [];
  specControls.forEach((ctl, index) => {
    const id = typeof ctl?.id === 'string' ? ctl.id.trim() : '';
    const actionType = ctl?.action?.type;
    if (!id || !actionType) return;
    const label = typeof ctl?.label === 'string' && ctl.label.trim() ? ctl.label : id;
    // Preserve the spec's state gating so the web bar can mirror the daemon's
    // FsmDriver.handleClickControl enforcement (otherwise the button renders in
    // states where the daemon would silently drop the click).
    const visibleWhenState = Array.isArray(ctl?.visible_when_state)
      ? ctl.visible_when_state.filter((s: unknown): s is string => typeof s === 'string')
      : undefined;
    if (actionType === 'open_picker') {
      out.push({
        id,
        type: 'select',
        label,
        placement: 'bar',
        dynamic: true,
        listScript: id,
        setScript: id,
        readFrom: id,
        order: index,
        ...(visibleWhenState && visibleWhenState.length > 0 ? { visibleWhenState } : {}),
      });
    } else if (actionType === 'send_keys') {
      out.push({
        id,
        type: 'action',
        label,
        placement: 'bar',
        invokeScript: id,
        resultDisplay: 'none',
        order: index,
        ...(visibleWhenState && visibleWhenState.length > 0 ? { visibleWhenState } : {}),
      });
    }
    // attach_image intentionally skipped — see fn doc.
  });
  return out;
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

  /**
   * Resolved registry base URL and provider tarball URL. Resolution order:
   * explicit config field (constructor option) → env var → vendor default.
   * See `config/registry-resolver.ts`.
   */
  private readonly registryBaseUrl: string;
  private readonly providerTarballUrl: string;

  /** Inject VersionArchive so resolve() can auto-detect installed versions */
  setVersionArchive(archive: VersionArchive): void {
    this.versionArchive = archive;
  }

  private static readonly META_FILE = '.meta.json';
  private static readonly REGISTRY_META_FILE = '.registry-meta.json';
  private static readonly REPO_PROVIDER_DIRNAME = 'adhdev-providers';
  private static readonly SIBLING_MARKER_FILE = '.adhdev-provider-root';
  private static readonly SIBLING_ENV_VAR = 'ADHDEV_USE_SIBLING_PROVIDERS';
  /**
   * Development-only env opt-in for the legacy unverified `main.tar.gz`
   * upstream fallback. Even with this set, the fallback is refused whenever
   * the resolved provider channel is 'stable' (production mode).
   */
  private static readonly UNVERIFIED_TARBALL_ENV_VAR = 'ADHDEV_PROVIDER_ALLOW_UNVERIFIED_TARBALL';

  /** Resolved provider channel (explicit config/env wins; otherwise derived from the daemon release channel; absent/ambiguous → 'stable'). */
  readonly channel: ProviderChannel;
  private readonly allowUnverifiedTarball: boolean;
  private readonly channelStore: ProviderChannelStore | null;
  private readonly channelSyncIO?: {
    fetchJson?: (url: string) => Promise<any>;
    downloadFile?: (url: string, destPath: string) => Promise<void>;
    extractTarball?: (tarPath: string, destDir: string) => Promise<void>;
  };

  private probeStarts: string[] = [];
  private siblingLogged = false;
  private siblingRefusalLogged = false;
  /** Active verified-channel object dirs, refreshed by loadAll(). */
  private channelObjectRoots: string[] = [];
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
    const fallback = path.join(getConfigDir(), 'providers');
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
            // Stage 2 channel policy: a stable (production) runtime NEVER
            // adopts a sibling checkout — `.adhdev-provider-root` must not
            // silently override verified channel activations. Non-stable
            // development use still requires the explicit opt-in (marker
            // file or env var).
            if (this.channel === 'stable') {
              if (!this.siblingRefusalLogged) {
                this.siblingRefusalLogged = true;
                this.log(`Refusing sibling provider checkout (channel=stable): ${siblingCandidate}. Set providerChannel=preview (or ${'ADHDEV_PROVIDER_CHANNEL'}=preview) to opt in for development.`);
                try {
                  process.stderr.write(
                    `[adhdev] Ignoring sibling adhdev-providers checkout on stable channel: ${siblingCandidate}\n`,
                  );
                } catch { /* ignore */ }
              }
            } else {
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
    /**
     * Explicit provider registry base URL override (config.registryUrl).
     * Highest-priority resolver source, ahead of ADHDEV_REGISTRY_URL + default.
     */
    registryUrl?: string;
    /**
     * Explicit provider tarball URL override (config.providerTarballUrl).
     * Highest-priority resolver source, ahead of ADHDEV_PROVIDER_TARBALL_URL + default.
     */
    providerTarballUrl?: string;
    /**
     * Explicit provider artifact channel (config.providerChannel /
     * ADHDEV_PROVIDER_CHANNEL). When neither is set, the channel is derived
     * from `updateChannel` (preview daemon → preview provider channel);
     * absent or ambiguous → 'stable'. A stable runtime refuses
     * sibling-checkout adoption and the unverified tarball fallback;
     * verified channel activations are always loaded.
     */
    channel?: string;
    /**
     * Daemon release/update channel (config.updateChannel). Only used to
     * derive the provider channel when no explicit `channel` /
     * ADHDEV_PROVIDER_CHANNEL is configured — an explicit provider channel
     * always wins. Absent/ambiguous → 'stable'.
     */
    updateChannel?: string;
    /**
     * Development-only opt-in for the legacy unverified `main.tar.gz`
     * fallback (config.providerAllowUnverifiedTarball /
     * ADHDEV_PROVIDER_ALLOW_UNVERIFIED_TARBALL=1). Refused on the stable
     * channel regardless of this flag.
     */
    allowUnverifiedTarball?: boolean;
    /**
     * Verified channel store override (tests). Pass `null` to disable the
     * verified channel layer entirely. Defaults to the content-addressed
     * store under `<configDir>/providers/.store`.
     */
    channelStore?: ProviderChannelStore | null;
    /**
     * Test seam: inject the verified channel sync transport I/O
     * (metadata fetch / tarball download / extraction) instead of the
     * default HTTPS + tar implementation. Never set in production.
     */
    channelSyncIO?: {
      fetchJson?: (url: string) => Promise<any>;
      downloadFile?: (url: string, destPath: string) => Promise<void>;
      extractTarball?: (tarPath: string, destDir: string) => Promise<void>;
    };
  }) {
    this.logFn = options?.logFn || LOG.forComponent('Provider').asLogFn();
    this.probeStarts = options?.probeStarts ?? [process.cwd(), __dirname];
    this.registryBaseUrl = resolveRegistryBaseUrl(options?.registryUrl);
    this.providerTarballUrl = resolveProviderTarballUrl(options?.providerTarballUrl);
    // Channel resolution MUST happen before detectDefaultUserDir() below:
    // sibling-checkout adoption is gated on the resolved channel. Explicit
    // channel config/env always wins; otherwise the provider channel derives
    // from the daemon release channel (preview daemon → preview providers).
    this.channel = resolveProviderChannel(options?.channel, process.env, options?.updateChannel);
    this.allowUnverifiedTarball =
      options?.allowUnverifiedTarball === true ||
      process.env[ProviderLoader.UNVERIFIED_TARBALL_ENV_VAR] === '1';
    this.channelStore = options?.channelStore === null
      ? null
      : (options?.channelStore ?? new ProviderChannelStore(ProviderChannelStore.defaultRoot(), this.logFn));
    this.channelSyncIO = options?.channelSyncIO;

    // Default directory for auto-downloads. Resolved via getConfigDir() so
    // ADHDEV_CONFIG_DIR (preview/stable instance isolation) is honored instead
    // of a hardcoded ~/.adhdev.
    this.defaultProvidersDir = path.join(getConfigDir(), 'providers');
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

    // One-time migration: ~/.adhdev/marketplace → ~/.adhdev/external.
    // The directory was renamed when the "marketplace" install model was
    // dropped in favour of explicit external git sources. Best-effort:
    // if the rename fails we leave both dirs in place and log so the user
    // can investigate.
    this.migrateMarketplaceDirToExternal();
  }

  private migrateMarketplaceDirToExternal(): void {
    try {
      const configDir = getConfigDir();
      const oldDir = path.join(configDir, 'marketplace');
      const newDir = path.join(configDir, 'external');
      if (!fs.existsSync(oldDir)) return;
      if (fs.existsSync(newDir)) {
        // Both exist — don't merge. Leave old in place; surface in logs so
        // the user can decide what to keep. Loader still loads from
        // external/ only, so old marketplace/ becomes inert.
        this.log(`Migration skipped: both ~/.adhdev/marketplace and ~/.adhdev/external exist (marketplace dir is now inert and can be removed manually).`);
        return;
      }
      fs.renameSync(oldDir, newDir);
      this.log(`Migrated ~/.adhdev/marketplace → ~/.adhdev/external (one-time rename after provider source-layer cleanup).`);
    } catch (e: any) {
      this.log(`Marketplace→external migration failed: ${e?.message || e}`);
    }
  }

  private log(msg: string): void {
    this.logFn(`[ProviderLoader] ${msg}`);
  }

  private debugLog(msg: string): void {
    LOG.debug('Provider', `[ProviderLoader] ${msg}`);
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
    // Order matters: user customs > external (3rd-party sources) > verified
    // channel activations (Stage 2 store) > upstream (official auto-sync).
    // findProviderDirInternal walks this list in order to locate the
    // provider dir containing the scripts/, so external must be included
    // here even though loadAll() also reads it directly. The verified
    // channel roots sit above .upstream so digest-verified bytes win over
    // legacy manifest installs of the same type, mirroring loadAll().
    const externalDir = path.join(getConfigDir(), 'external');
    return [this.userDir, externalDir, ...this.channelObjectRoots, this.upstreamDir];
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
 * 1. ~/.adhdev/providers/.upstream/ — official git, auto-synced
 * 2. ~/.adhdev/external/ — 3rd-party git sources, user-added,
 *    bundled providers may include arbitrary JS (untrusted by default)
 * 3. ~/.adhdev/providers/ (excluding .upstream) — user-authored customs,
 *    always wins
 * Highest priority listed last (overwrites earlier loads).
 * If .upstream/ is empty, call fetchLatest() before loadAll().
 */
  loadAll(): void {
    this.providers.clear();
    this.providerAvailability.clear();

 // 1. Load upstream (GitHub auto-download — primary official source)
    let upstreamCount = 0;
    if (!this.disableUpstream && fs.existsSync(this.upstreamDir)) {
      upstreamCount = this.loadDir(this.upstreamDir);
      if (upstreamCount > 0) {
        this.log(`Loaded ${upstreamCount} upstream providers (auto-updated)`);
      }
    } else if (this.disableUpstream) {
      this.log('Upstream loading disabled (sourceMode=no-upstream)');
    }

 // 1.5 Verified channel activations (Stage 2 content-addressed store).
 //     Occupies the upstream precedence slot: loaded after .upstream so
 //     digest-verified bytes win over legacy manifest installs of the same
 //     type, while external sources and user customs still outrank it.
    this.loadVerifiedChannelActivations();

 // 2. Load external providers from ~/.adhdev/external/<source-name>/
 //    (3rd-party git sources). Overrides upstream but is itself overridden
 //    by user customs in step 3.
 //
 //    Each registered source is a separate subdirectory so two sources can
 //    both expose the same provider type without overwriting each other.
 //    When more than one source provides the same type, providers-active.json
 //    chooses the active one; without an explicit choice we deterministically
 //    pick the first in disk-walk order and log the ambiguity so the user
 //    can resolve it from the dashboard.
 //
 //    Any non-spec manifest (tui block / overrides / scriptDir) coming from
 //    an external source runs JavaScript the daemon hasn't audited, so
 //    dashboards must surface an "untrusted source" badge before letting
 //    the user enable them.
    const externalDir = path.join(getConfigDir(), 'external');
    if (fs.existsSync(externalDir)) {
      // Legacy layout (pre-source-namespace): manifests sit directly at
      // external/<category>/<type>/. Detect by presence of category dirs at
      // the root and migrate inline by treating the whole tree as a single
      // implicit source. Loader behavior unchanged for legacy callers.
      const rootEntries = (() => {
        try { return fs.readdirSync(externalDir, { withFileTypes: true }); }
        catch { return [] as fs.Dirent[]; }
      })();
      const KNOWN_CATEGORIES = new Set(['cli', 'ide', 'extension', 'acp']);
      const looksLegacy = rootEntries.some(e => e.isDirectory() && KNOWN_CATEGORIES.has(e.name));
      if (looksLegacy) {
        // Tree shape predates per-source dirs — treat the whole thing as a
        // single anonymous source so existing installs keep working until
        // they're migrated to a real source registration.
        const externalCount = this.loadDir(externalDir);
        if (externalCount > 0) {
          this.log(`Loaded ${externalCount} external providers (legacy unnamed source)`);
        }
      } else {
        // New layout: external/<source-name>/<category>/<type>/…
        const activeFile = loadProvidersActive();
        let totalLoaded = 0;
        const ambiguousTypes: { type: string; chosen: string; candidates: string[] }[] = [];
        // Per-source load, then filter by active-selection: for each type
        // present in more than one source, only the active source's copy
        // is left in this.providers.
        for (const sourceEntry of rootEntries) {
          if (!sourceEntry.isDirectory()) continue;
          const sourceDir = path.join(externalDir, sourceEntry.name);
          const sourceLoaded = this.loadDir(sourceDir);
          if (sourceLoaded > 0) {
            totalLoaded += sourceLoaded;
            this.log(`Loaded ${sourceLoaded} providers from external source "${sourceEntry.name}"`);
          }
        }
        // Resolve ambiguities — when the same type came from multiple
        // sources, the last load wins by default. Replay with the active
        // selection so the user-chosen source ends up winning.
        for (const [type] of this.providers) {
          const prov = this.providers.get(type);
          if (!prov) continue;
          const resolved = resolveActiveSource(prov.category, type, activeFile);
          if (resolved.candidates.length <= 1) continue;
          if (resolved.ambiguous) {
            ambiguousTypes.push({ type, chosen: resolved.source ?? '?', candidates: resolved.candidates });
          }
          if (resolved.source && resolved.source !== '?') {
            const sourceDir = path.join(externalDir, resolved.source);
            // Reload only this source's copy of the conflicting type so it
            // overwrites whatever else won the initial pass.
            const reloadCount = this.loadDir(sourceDir);
            // reloadCount is a sanity check — we expect ≥1
            if (reloadCount === 0) {
              this.log(`Active source "${resolved.source}" no longer provides ${type}`);
            }
          }
        }
        if (totalLoaded > 0) {
          this.log(`Loaded ${totalLoaded} external providers (3rd-party sources)`);
        }
        for (const a of ambiguousTypes) {
          this.log(`Ambiguous provider "${a.type}" — provided by [${a.candidates.join(', ')}], defaulted to "${a.chosen}". Set the active source from the dashboard to silence this warning.`);
        }
      }
    }

 // 3. Load user custom (excluding .upstream — highest priority, never auto-updated)
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

 // ─── Verified provider channel (Stage 2) ─────────────────

 /**
  * Load digest-verified channel activations from the content-addressed
  * store. Only objects referenced by an active pointer are read, so a
  * partially staged or interrupted sync is never observed. Corrupt pointers
  * / missing objects are logged as typed errors and skipped (fail closed).
  */
  private loadVerifiedChannelActivations(): void {
    this.channelObjectRoots = [];
    if (!this.channelStore) return;
    let result: ReturnType<ProviderChannelStore['listActiveActivations']>;
    try {
      result = this.channelStore.listActiveActivations(this.channel);
    } catch (e: any) {
      this.log(`⚠ Verified channel store unreadable (${this.channel}): ${e?.message || e}`);
      return;
    }
    for (const err of result.errors) {
      this.log(`⚠ Verified channel: ${err.code}: ${err.message}`);
    }
    let count = 0;
    for (const { objectDir } of result.activations) {
      count += this.loadDir(objectDir);
      this.channelObjectRoots.push(objectDir);
    }
    if (count > 0) {
      this.log(`Loaded ${count} verified channel providers (${this.channel}, content-addressed store)`);
    }
  }

 /**
  * Sync verified channel activations for the installed provider set
  * (providers installed into .upstream via the dashboard install flow, plus
  * everything already activated on this channel).
  *
  * Fail-closed / last-known-good: on any metadata or transport failure
  * nothing new is activated and the previous active objects keep loading.
  * Reloads providers when at least one activation changed.
  */
  async syncVerifiedChannel(): Promise<ChannelSyncReport> {
    if (!this.channelStore) {
      return {
        channel: this.channel,
        status: 'error',
        activated: [],
        skipped: [],
        errors: [{ code: 'STORE_CORRUPT', message: 'verified channel store is disabled' }],
      };
    }
    const runtime = new ProviderChannelRuntime({
      store: this.channelStore,
      registryBaseUrl: this.registryBaseUrl,
      providerTarballUrl: this.providerTarballUrl,
      logFn: this.logFn,
      ...this.channelSyncIO,
    });
    const targetTypes = collectSyncTargetTypes(this.upstreamDir, this.channelStore, this.channel);
    const report = await runtime.sync({ channel: this.channel, targetTypes });
    for (const skip of report.skipped) {
      this.log(`⚠ Verified channel skip: ${skip.reason}`);
    }
    for (const err of report.errors) {
      this.log(`⚠ Verified channel error: ${err.code}: ${err.message}`);
    }
    if (report.activated.length > 0) {
      this.loadAll();
    }
    return report;
  }

 /**
  * Number of valid active pointers on the resolved channel (0 = empty or
  * disabled store). Corrupt pointer files are excluded by the store.
  */
  countVerifiedChannelPointers(): number {
    if (!this.channelStore) return 0;
    try {
      return this.channelStore.listPointers(this.channel).pointers.size;
    } catch {
      return 0;
    }
  }

 /**
  * Bounded one-shot first sync for an empty verified channel store.
  *
  * Closes the rc.20 preview activation gap: a daemon whose provider channel
  * newly derives to a channel with an EMPTY store (e.g. updateChannel=preview
  * while providerChannel defaulted to stable) would otherwise sit at 0 active
  * providers until a manual check_provider_updates. Runs at most one
  * verified sync per call, only when the resolved channel has no pointers
  * AND there are installed (.upstream) providers to sync. Fail-closed: any
  * registry/transport failure activates nothing (last-known-good preserved)
  * and is retried on the next boot or via check_provider_updates. Never
  * invoked from any status path.
  *
  * Returns the sync report, or null when the first-sync gate did not apply.
  */
  async maybeFirstSyncVerifiedChannel(): Promise<ChannelSyncReport | null> {
    if (!this.channelStore) return null;
    if (this.countVerifiedChannelPointers() > 0) return null;
    if (!this.hasUpstream()) return null;
    return this.syncVerifiedChannel();
  }

 /**
  * Roll a provider back to its previously activated verified object. Pure
  * local pointer flip — no network. Returns the new active digest, or null
  * when there is no rollback target.
  */
  rollbackVerifiedChannel(providerType: string): string | null {
    if (!this.channelStore) return null;
    const ref = this.channelStore.rollback(this.channel, providerType);
    if (ref) this.loadAll();
    return ref?.digest ?? null;
  }

 /** Remove a verified activation (e.g. the provider was uninstalled). */
  deactivateVerifiedChannel(providerType: string): boolean {
    if (!this.channelStore) return false;
    const removed = this.channelStore.removePointer(this.channel, providerType);
    if (removed) this.loadAll();
    return removed;
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

  private getEffectiveProviderAvailability(type: string): ProviderAvailabilityState | undefined {
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
      const availability = this.getEffectiveProviderAvailability(provider.type);
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
            // entry.scriptDir is optional now — spec-driven providers (agy,
            // codex on >=0.137, claude on >=2.1) only ship `spec` here, so
            // there's nothing to load from the filesystem. SpecCliAdapter
            // takes over via the `spec` path later in this method.
            if (entry.scriptDir) {
              const loaded = this.loadScriptsFromDir(type, entry.scriptDir);
              if (loaded) {
                resolved.scripts = loaded;
                this.debugLog(`  [compatibility] ${type} v${currentVersion} → ${entry.scriptDir}`);
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
            } else {
              // Spec-only entry — still counts as a match so the
              // defaultScriptDir fallback below doesn't kick in.
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
            this.debugLog(`  [compatibility] ${type} v${currentVersion} → default: ${base.defaultScriptDir}`);
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
        this.debugLog(`  [compatibility] ${type} no version detected → default: ${base.defaultScriptDir}`);
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
 //    Legacy shape: base.overrides is an Array<{ when: {os,version}, scripts }>.
 //    v1 manifests (Phase 3-4) repurposed `overrides` as an object map of
 //    capability overrides (e.g. { detectStatus: { path, schema } }), which is
 //    consumed by the SDK builders, not by this resolver. Only iterate when
 //    the field is in the legacy array shape.
    if (Array.isArray(base.overrides)) {
      for (const override of base.overrides) {
        const osMatch = !override.when.os || override.when.os === currentOs;
        const verMatch = !override.when.version || (currentVersion && this.matchesVersion(currentVersion, override.when.version));
        if (osMatch && verMatch && override.scripts) {
          resolved.scripts = { ...resolved.scripts, ...override.scripts };
        }
      }
    } else if (base.overrides && typeof base.overrides === 'object') {
      // v1 manifest shape: { detectStatus: { path }, parseSession: { path }, ... }
      // Each script name maps to a path inside the provider directory. We load
      // the file and merge its export(s) into resolved.scripts. Lets a
      // provider override a single primitive (e.g. just detectStatus) while
      // letting the SDK synthesize the rest from the tui block.
      const providerDir = this.findProviderDirInternal(base.type);
      if (providerDir) {
        for (const [scriptName, override] of Object.entries(base.overrides as Record<string, any>)) {
          if (!override || typeof override.path !== 'string') continue;
          const fullPath = path.join(providerDir, override.path);
          if (!fs.existsSync(fullPath)) {
            this.log(`  [overrides] ${base.type}: ${scriptName} path not found: ${fullPath}`);
            continue;
          }
          try {
            // Override scripts go through the same whitelist gate as the
            // main scripts dir. Use the provider parent root so a v1
            // override can still require ../_shared helpers.
            registerProviderScriptRootSafely(path.dirname(path.dirname(providerDir)));
            delete require.cache[require.resolve(fullPath)];
            const fn = require(fullPath);
            const target = typeof fn === 'function' ? fn : (fn && fn[scriptName]);
            if (typeof target === 'function') {
              resolved.scripts = { ...resolved.scripts, [scriptName]: target } as any;
              this.log(`  [overrides] ${base.type}: ${scriptName} loaded from ${override.path}`);
            } else {
              this.log(`  [overrides] ${base.type}: ${scriptName} export missing in ${override.path}`);
            }
          } catch (e: any) {
            this.log(`  [overrides] ${base.type}: ${scriptName} require failed: ${e?.message || e}`);
          }
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

    // (spec migration) Late-binding spec.json native-history hook. Runs
    // *after* every script-loading path (compatibility / defaultScriptDir /
    // overrides) so it deterministically wins over a legacy v1 scripts.js
    // export. Three modes, picked by spec.json's native_history block:
    //   1. source     — declarative jsonl/sqlite executor (new-provider path,
    //                   no daemon change needed for new on-disk formats)
    //   2. override_path — provider-supplied reader file (escape hatch for
    //                   exotic formats); module default-exports a reader fn
    //   3. reader     — built-in reader id (claude-cli / codex-cli /
    //                   antigravity-cli / hermes-cli), kept for backwards
    //                   compatibility with the four shipped providers
    if (providerDir) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('node:fs');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const path = require('node:path');
        // Pick the right spec file for the detected CLI version. Resolution
        // order:
        //   1. compatibility[i].spec where ideVersion matches currentVersion
        //      (lets a provider ship specs/2.0.json, specs/2.1.json, etc.
        //      alongside the matching scriptDir)
        //   2. specs/default.json — explicit fallback
        //   3. spec.json — legacy single-spec layout
        // Missing files fall through silently to the next candidate.
        const candidates: string[] = [];
        if (Array.isArray((base as any).compatibility)) {
          for (const entry of (base as any).compatibility) {
            if (typeof entry?.spec !== 'string') continue;
            // If currentVersion is unknown (cli-manager hasn't probed yet)
            // we still let compatibility entries that don't pin a version
            // through, plus any entry whose pin matches.
            const matches = !entry.ideVersion
              || (currentVersion && this.matchesVersion(currentVersion, entry.ideVersion))
              || !currentVersion;
            if (matches) candidates.push(path.join(providerDir, entry.spec));
          }
        }
        candidates.push(path.join(providerDir, 'specs', 'default.json'));
        candidates.push(path.join(providerDir, 'spec.json'));
        const specPath = candidates.find((p: string) => fs.existsSync(p));
        // native_history block, resolved from either the separate spec file
        // (snake_case `native_history`) or — for v1-manifest-only providers that
        // ship no specs/*.json — the inline camelCase `nativeHistory` on the
        // manifest itself. The separate spec file wins when both exist. Without
        // the v1-manifest fallback, a provider whose ONLY declaration is an
        // inline `nativeHistory.source` (e.g. opencode's sqlite source) never got
        // its `scripts.readNativeHistory` wired: the whole block was gated on
        // `specPath`, so read_chat returned native-unavailable, the assistant
        // reply (only in the on-disk store, never in the PTY snapshot) was
        // dropped, providerSessionId stayed null, and the session wedged in
        // `generating` because no native completion evidence ever arrived.
        let nh: any | undefined;
        if (specPath) {
          // Hand the resolved spec path off to route.ts via a hidden field
          // so the routing layer doesn't have to repeat the candidate walk.
          (resolved as any)._resolvedSpecPath = specPath;
          // Extract control_bar + native_history directly from the JSON header.
          let specControls: any[] | undefined;
          try {
            const rawSpec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
            specControls = rawSpec.control_bar;
            nh = rawSpec.native_history;
          } catch { /* unreadable spec — leave controls/native unavailable */ }
          // Stub each control_bar entry as a provider.scripts.<id>. The
          // upstream invoke_provider_script gate checks that the script
          // name exists on provider.scripts before calling adapter.invokeScript;
          // for spec providers the *actual* dispatch happens inside
          // SpecCliAdapter.invokeScript which maps the name to control_bar.
          // The stub is just a presence marker so the gate doesn't reject.
          if (specControls && specControls.length > 0) {
            resolved.scripts = { ...(resolved.scripts || {}) };
            for (const ctl of specControls) {
              if (!(resolved.scripts as any)[ctl.id]) {
                (resolved.scripts as any)[ctl.id] = (..._args: unknown[]) => ({
                  __spec_control: true,
                  controlId: ctl.id,
                  actionType: ctl.action.type,
                });
              }
            }
            // Bridge the spec control_bar into the web-facing controls schema so
            // the dashboard chat bar actually renders Model/Mode pickers. Only
            // synthesize when the provider hasn't already declared its own
            // `controls` in provider.v1.json (e.g. hermes-cli) — an explicit
            // declaration wins and must not be clobbered.
            const hasDeclaredControls = Array.isArray((resolved as any).controls)
              && (resolved as any).controls.length > 0;
            if (!hasDeclaredControls) {
              const synthesized = synthesizeControlsFromControlBar(specControls);
              if (synthesized.length > 0) {
                resolved.controls = synthesized;
              }
            }
          }
        }
        // Fall back to the v1 manifest's inline `nativeHistory` (camelCase) when
        // no separate spec file provided a `native_history` block. Only treat it
        // as a declarative reader source when it actually carries source/
        // override_path/reader — a bare `nativeHistory` marker that only names
        // `scripts.readSession` (claude/codex/antigravity, whose real reader is
        // wired from their specs/*.json) must not be mistaken for one.
        if (!nh) {
          const inlineNh = (base as any)?.nativeHistory || (resolved as any)?.nativeHistory;
          if (inlineNh && (inlineNh.source || inlineNh.override_path || inlineNh.reader)) {
            nh = inlineNh;
          }
        }
        if (nh) {
          let reader: ((input: any) => any) | null = null;
          // lister enumerates all saved sessions for the store. Only the
          // declarative jsonl `source` path can enumerate by directory walk;
          // override/reader providers wire their own listSessions (or none).
          let lister: ((input: any) => any) | null = null;
          let format = 'spec';

          if (nh.source) {
            format = `spec-${nh.source.kind}`;
            reader = (input: any) => executeNativeHistory(nh, input);
            // Only jsonl stores are file-per-session and enumerable by a
            // directory walk. sqlite sources enumerate through their own
            // `session_query` (not implemented as a lister yet), so leave
            // listSessions unwired there rather than advertising an enumerator
            // that always returns empty.
            if (nh.source.kind === 'jsonl') {
              lister = (input: any) => executeNativeHistoryList(nh, input);
            }
          } else if (nh.override_path) {
            const overrideFile = path.resolve(providerDir, nh.override_path);
            if (fs.existsSync(overrideFile)) {
              try {
                registerProviderScriptRootSafely(path.dirname(path.dirname(providerDir)));
                delete require.cache[require.resolve(overrideFile)];
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const mod = require(overrideFile);
                const fn = typeof mod === 'function' ? mod : (mod && typeof mod.default === 'function' ? mod.default : null);
                if (fn) {
                  format = 'spec-override';
                  reader = (input: any) => fn(input);
                }
              } catch { /* fall through — leave native unavailable */ }
            }
          } else if (nh.reader) {
            const dispatch = createNativeHistoryDispatcher(nh.reader as ReaderId);
            format = nh.reader;
            reader = (input: any) => dispatch(input);
          }

          if (reader) {
            resolved.scripts = { ...(resolved.scripts || {}) };
            (resolved.scripts as any).readNativeHistory = reader;
            // Wire the enumerator alongside the reader. Without both the
            // `scripts.listSessions` marker AND the `listNativeHistory` fn,
            // `getProviderNativeHistoryScript(...,'listSessions')` resolves to
            // undefined and `list_saved_sessions` returns [] for every
            // declarative-source provider (claude/codex/antigravity/kimi/cursor)
            // regardless of how many transcripts are on disk.
            const scriptsMarker: { readSession: string; listSessions?: string } = { readSession: 'readNativeHistory' };
            if (lister) {
              (resolved.scripts as any).listNativeHistory = lister;
              scriptsMarker.listSessions = 'listNativeHistory';
            }
            (resolved as any).nativeHistory = {
              format,
              watchPath: undefined,
              scripts: scriptsMarker,
              mode: 'native-source',
            };
          }
        }
      } catch {
        // Best-effort — spec wiring failure must not break legacy providers.
      }
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
      // No provider dir for this type — a spec-only provider with no
      // legacy scripts/v1 layout is a normal configuration, not a
      // problem to surface at INFO. resolve() calls this on every
      // request; INFO spam every 200ms drowns out the real signal.
      this.debugLog(`[loadScriptsFromDir] ${type}: providerDir not found`);
      return null;
    }

    const dir = path.join(providerDir, scriptDir);
    if (!fs.existsSync(dir)) {
      this.debugLog(`[loadScriptsFromDir] ${type}: dir not found: ${dir}`);
      return null;
    }

    // Register the provider's *parent root* (e.g. .../adhdev-providers/) so
    // the require whitelist gates every script + every _shared helper this
    // provider may reach. Picking the grandparent (one above the category
    // dir `cli/`) lets sibling helpers in `_shared` resolve while still
    // blocking `../../etc/...` escapes. Idempotent.
    registerProviderScriptRootSafely(path.dirname(path.dirname(providerDir)));

    // Return cached scripts if available (cleared on reload/watch)
    const cached = this.scriptsCache.get(dir);
    if (cached) return cached;

    // Try scripts.js first
    const scriptsJs = path.join(dir, 'scripts.js');
    if (fs.existsSync(scriptsJs)) {
      try {
        delete require.cache[require.resolve(scriptsJs)];
        const loaded = require(scriptsJs);
        this.debugLog(`[loadScriptsFromDir] ${type}: loaded scripts.js from ${dir} (${Object.keys(loaded).length} exports)`);
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

        let reloadTimer: ReturnType<typeof setTimeout> | null = null;
        const handleChange = (filePath: string) => {
          if (/[\/\\]fixtures[\/\\]/.test(filePath)) {
            return;
          }
          if (filePath.endsWith('.js') || filePath.endsWith('.json')) {
            if (reloadTimer) clearTimeout(reloadTimer);
            reloadTimer = setTimeout(() => {
              this.log(`File changed: ${path.basename(filePath)}, reloading...`);
              this.reload();
            }, 300);
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
  /**
   * Sync providers from the ADHDev registry (registry.adhf.dev).
   *
   * Downloads only providers whose server checksum differs from the locally
   * cached checksum. Falls back gracefully to the GitHub tarball path if the
   * registry is unreachable or returns an unexpected response.
   *
   * Returns `{ updated: true }` when at least one provider file changed on disk,
   * `{ updated: false }` when everything is already current, or
   * `{ updated: false, error }` when the registry couldn't be reached and we
   * should proceed to the GitHub tarball fallback.
   */
  async fetchFromRegistry(): Promise<{ updated: boolean; error?: string }> {
    if (this.disableUpstream) {
      this.log('Registry sync skipped (sourceMode=no-upstream)');
      return { updated: false };
    }
    this.log(`Registry sync starting (${this.registryBaseUrl})...`);

    const https = require('https') as typeof import('https');
    const regMetaPath = path.join(this.upstreamDir, ProviderLoader.REGISTRY_META_FILE);

    // Load cached checksums
    let cachedChecksums: Record<string, string> = {};
    try {
      if (fs.existsSync(regMetaPath)) {
        cachedChecksums = JSON.parse(fs.readFileSync(regMetaPath, 'utf-8')).checksums ?? {};
      }
    } catch { }

    try {
      // 1. Fetch provider list
      const listUrl = `${this.registryBaseUrl}/providers`;
      const listBody = await new Promise<string>((resolve, reject) => {
        const req = https.get(listUrl, { headers: { 'User-Agent': 'adhdev-daemon', 'Accept': 'application/json' }, timeout: 10000 }, (res) => {
          if (res.statusCode !== 200) { reject(new Error(`registry list HTTP ${res.statusCode}`)); return; }
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('registry list timeout')); });
      });

      const list = JSON.parse(listBody) as { providers: Array<{ type: string; category: string; checksum: string; version: string }> };
      if (!Array.isArray(list.providers)) throw new Error('unexpected registry response shape');

      let updatedCount = 0;

      for (const entry of list.providers) {
        const { type, category, checksum, version } = entry;
        const cacheKey = `${category}/${type}`;
        if (cachedChecksums[cacheKey] === checksum) continue; // already current

        // Download this provider's manifest
        const dlUrl = `${this.registryBaseUrl}/providers/${type}/${version}/download`;
        const manifestBody = await new Promise<string>((resolve, reject) => {
          const req = https.get(dlUrl, { headers: { 'User-Agent': 'adhdev-daemon', 'Accept': 'application/json' }, timeout: 30000 }, (res) => {
            if (res.statusCode !== 200) { reject(new Error(`registry download HTTP ${res.statusCode} for ${type}@${version}`)); return; }
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error(`download timeout for ${type}`)); });
        });

        // Verify checksum
        const actualChecksum = sha256Hex(manifestBody);
        if (actualChecksum !== checksum) {
          this.log(`⚠ Registry checksum mismatch for ${type}@${version} — skipping`);
          continue;
        }

        // Write to upstream dir
        const providerDir = path.join(this.upstreamDir, category, type);
        fs.mkdirSync(providerDir, { recursive: true });
        fs.writeFileSync(path.join(providerDir, 'provider.json'), manifestBody, 'utf-8');

        cachedChecksums[cacheKey] = checksum;
        updatedCount++;
        this.log(`✓ Registry updated: ${category}/${type}@${version}`);
      }

      // Persist updated checksums
      fs.mkdirSync(this.upstreamDir, { recursive: true });
      fs.writeFileSync(regMetaPath, JSON.stringify({
        checksums: cachedChecksums,
        syncedAt: new Date().toISOString(),
        providerCount: list.providers.length,
      }, null, 2));

      this.log(`Registry sync complete: ${list.providers.length} providers, ${updatedCount} updated`);
      return { updated: updatedCount > 0 };
    } catch (e: any) {
      this.log(`⚠ Registry sync failed (falling back to GitHub tarball): ${e?.message}`);
      return { updated: false, error: e?.message };
    }
  }

  async fetchLatest(): Promise<{ updated: boolean; error?: string }> {
    if (this.disableUpstream) {
      this.log('Upstream fetch skipped (sourceMode=no-upstream)');
      return { updated: false };
    }
    // Stage 2: the unauthenticated main.tar.gz fallback is no longer a
    // production path. It requires an unmistakable development-only opt-in
    // (config.providerAllowUnverifiedTarball or
    // ADHDEV_PROVIDER_ALLOW_UNVERIFIED_TARBALL=1) AND a non-stable channel;
    // stable production mode always refuses it. The verified channel sync
    // (syncVerifiedChannel) is the production loading path.
    if (!this.isUnverifiedTarballAllowed()) {
      const msg =
        `TARBALL_FALLBACK_REFUSED: unverified provider tarball fallback is disabled ` +
        `(channel=${this.channel}, opt-in=${this.allowUnverifiedTarball ? 'on' : 'off'}). ` +
        `Use the verified channel sync instead.`;
      this.log(`⚠ ${msg}`);
      return { updated: false, error: msg };
    }
    const https = require('https') as typeof import('https');
    const { exec } = require('child_process') as typeof import('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

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

 // Minimum 30-minute interval (prevent excessive checks). BUT the cooldown must
 // never strand a clean machine with zero providers: fetchLatest() stamps the
 // timestamp even on a failed/ETag-unchanged attempt (to avoid retry storms), so
 // if the very first attempt hiccups the upstream dir stays empty yet every later
 // boot within 30min is skipped — leaving "Total: 0 providers" forever. When the
 // upstream currently has NO providers we bypass the cooldown and force a fetch;
 // the normal 30min throttle still applies once at least one provider is present.
    const MIN_INTERVAL_MS = 30 * 60 * 1000;
    const upstreamProviderCount = this.countProviders(this.upstreamDir);
    if (
      upstreamProviderCount > 0 &&
      prevTimestamp &&
      (Date.now() - prevTimestamp) < MIN_INTERVAL_MS
    ) {
      this.log('Upstream check skipped (last check < 30min ago)');
      return { updated: false };
    }
    if (upstreamProviderCount === 0 && prevTimestamp && (Date.now() - prevTimestamp) < MIN_INTERVAL_MS) {
      this.log('Upstream empty (0 providers) — forcing fetch despite <30min cooldown');
    }

    // Resolve the tarball target (config → env → vendor default) once so the
    // HEAD probe and the download below hit the same (possibly self-hosted) URL.
    const tarballTarget = resolveProviderTarballTarget(this.providerTarballUrl);

    try {
 // Step 1: HEAD request to check ETag
      const etag = await new Promise<string>((resolve, reject) => {
        const options = {
          method: 'HEAD',
          hostname: tarballTarget.hostname,
          path: tarballTarget.path,
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

 // Compare ETag — skip if unchanged, but only when providers are actually on
 // disk. A stale .meta.json etag can match while .upstream is empty (first-boot
 // hiccup, or the dir was cleared under a persisted meta); short-circuiting then
 // would leave the machine at 0 providers, so fall through to a real download.
      if (etag && etag === prevEtag && upstreamProviderCount > 0) {
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
      await this.downloadFile(tarballTarget.url, tmpTar);

 // Extract
      fs.mkdirSync(tmpExtract, { recursive: true });
      await execAsync(`tar -xzf "${tmpTar}" -C "${tmpExtract}"`, { timeout: 30000 });

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

 /**
  * Development-only gate for the legacy unverified tarball fallback: the
  * explicit opt-in must be on AND the resolved channel must be non-stable.
  * Stable (production) always refuses.
  */
  private isUnverifiedTarballAllowed(): boolean {
    return this.allowUnverifiedTarball && this.channel !== 'stable';
  }

 /** HTTP(S) file download (follows redirects) */
  private downloadFile(url: string, destPath: string): Promise<void> {    const https = require('https') as typeof import('https');
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
        source: this.providerTarballUrl,
      }, null, 2));
    } catch { }
  }

  /** Count provider files (provider.v1.json or provider.json — at most one per dir). */
  private countProviders(dir: string): number {
    if (!fs.existsSync(dir)) return 0;
    let count = 0;
    const scan = (d: string) => {
      try {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        const hasManifest = entries.some(e => e.name === 'provider.v1.json' || e.name === 'provider.json');
        if (hasManifest) count++;
        for (const entry of entries) {
          if (entry.isDirectory()) scan(path.join(d, entry.name));
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
        // (fix) Safe default is *off*. Auto-approving every modal without the
        // user opting in produced silent-bash-execution surprises and the
        // "Auto-approved: ..." system-message flood seen on AGY/Codex.
        default: false,
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
    const hasManifest = (dir: string) =>
      fs.existsSync(path.join(dir, 'provider.v1.json')) || fs.existsSync(path.join(dir, 'provider.json'));
    const readManifestType = (dir: string): string | null => {
      for (const file of ['provider.v1.json', 'provider.json']) {
        const p = path.join(dir, file);
        if (!fs.existsSync(p)) continue;
        try {
          const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
          if (typeof data?.type === 'string') return data.type;
        } catch { /* skip */ }
      }
      return null;
    };
    for (const root of searchRoots) {
      if (!fs.existsSync(root)) continue;
      const candidate = this.getProviderDir(root, cat, type);
      if (hasManifest(candidate)) return candidate;
      // Scan category dir for type match
      const catDir = path.join(root, cat);
      if (fs.existsSync(catDir)) {
        try {
          for (const entry of fs.readdirSync(catDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const entryDir = path.join(catDir, entry.name);
            const manifestType = readManifestType(entryDir);
            if (manifestType === type) return entryDir;
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

      // v1-first manifest selection. provider.v1.json (the SDK-shape
      // manifest with `overrides`, `tui`, `source`, `canonicalHistory`)
      // wins over provider.json (legacy). Without this branch the v1
      // file is silently ignored — that's how the codex-cli `overrides`
      // path and the tui-block builders went un-honored for the first
      // pass of SDK rollout.
      const hasV1 = entries.some(e => e.name === 'provider.v1.json');
      const hasJson = entries.some(e => e.name === 'provider.json');

      if (hasV1 || hasJson) {
        const manifestFile = hasV1 ? 'provider.v1.json' : 'provider.json';
        const jsonPath = path.join(d, manifestFile);
        try {
          const raw = fs.readFileSync(jsonPath, 'utf-8');
          const mod = JSON.parse(raw) as Omit<ProviderModule, 'extensionIdPattern'> & {
            extensionIdPattern?: RegExp | string;
          };

          // Validate v1 manifests against the SDK schema. Failures are
          // surfaced as a single warning line with all issues attached
          // so manifest authors don't need to guess which field is wrong.
          // Loading still proceeds — bricking the daemon on a single
          // bad field would be worse than running with a known warning.
          if (hasV1 && mod?.category === 'cli') {
            try {
              const { validateCliProviderManifest, formatManifestValidationIssues } =
                require('./sdk/v1/validators/manifest.js') as typeof import('./sdk/v1/validators/manifest.js');
              const validation = validateCliProviderManifest(mod);
              if (!validation.ok) {
                this.log(`⚠ ${jsonPath}: schema validation failed:\n${formatManifestValidationIssues(validation.issues)}`);
              }
            } catch (e: any) {
              // Validator load failed — log once and continue so a
              // broken validator can't take down provider loading.
              this.log(`⚠ ${jsonPath}: validator unavailable: ${e?.message || e}`);
            }
          }

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

          // v1 manifests use `nativeHistory` as the canonical field name.
          // Legacy v0 manifests use `canonicalHistory`. The daemon's
          // runtime + downstream code reads `provider.nativeHistory`, so
          // for legacy manifests we copy `canonicalHistory` into
          // `nativeHistory` here. We also keep `canonicalHistory`
          // populated in both directions (deprecated alias) so any
          // external consumers still reading the old name keep working
          // during the one-release deprecation window.
          const nh = (normalizedProvider as any).nativeHistory;
          const ch = (normalizedProvider as any).canonicalHistory;
          if (nh && !ch) {
            (normalizedProvider as any).canonicalHistory = nh;
          } else if (ch && !nh) {
            (normalizedProvider as any).nativeHistory = ch;
          }

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
                // Gate the IDE/extension scripts.js (legacy single-file
                // format) under the same whitelist. `d` here is the
                // provider dir; its grandparent contains _shared.
                registerProviderScriptRootSafely(path.dirname(path.dirname(d)));
                delete require.cache[require.resolve(scriptsPath)];
                const scripts = require(scriptsPath) as Partial<ProviderScripts>;
                normalizedProvider.scripts = scripts;
              } catch (e) {
                this.log(`⚠ Failed to load scripts: ${scriptsPath}: ${(e as Error).message}`);
              }
            }

            // Classify trust based on which on-disk layer this manifest
            // came from + whether it ships JavaScript hooks. The dashboard
            // uses this to render trust badges; non-spec external manifests
            // need an explicit user confirm before activation.
            const externalDirAbs = path.join(getConfigDir(), 'external');
            // The verified channel store (<configDir>/providers/.store/…)
            // lives under the default user dir but is verified upstream
            // content, not a user override — exclude it explicitly.
            const isChannelStoreObject = d.includes(`${path.sep}.store${path.sep}`);
            const layer: 'user' | 'upstream' | 'external' = d.startsWith(externalDirAbs)
              ? 'external'
              : (d.startsWith(this.userDir) && !d.includes('.upstream') && !isChannelStoreObject ? 'user' : 'upstream');
            try {
              const { inspectManifestShape, classifyTrust } =
                require('./provider-trust.js') as typeof import('./provider-trust.js');
              const shape = inspectManifestShape(mod as Record<string, unknown>);
              const trust = classifyTrust(layer, shape);
              (normalizedProvider as any)._sourceLayer = layer;
              (normalizedProvider as any)._sourceTrust = trust;
              (normalizedProvider as any)._manifestShape = shape;
              // For external-namespaced layouts (external/<source>/…) record
              // which source the manifest came from so dashboards can name
              // it in the trust badge.
              if (layer === 'external') {
                const rel = path.relative(externalDirAbs, d);
                const firstSeg = rel.split(path.sep)[0];
                if (firstSeg && firstSeg !== '..') (normalizedProvider as any)._sourceName = firstSeg;
              }
            } catch { /* best-effort — trust is enrichment, not gating */ }

            const existed = this.providers.has(normalizedProvider.type);
            this.providers.set(normalizedProvider.type, normalizedProvider);
            count++;
            const source = (normalizedProvider as any)._sourceLayer ?? 'upstream';
            const overrideWarning = existed && source === 'user' ? ' ⚠ OVERRIDES upstream' : '';
            const sourceName = (normalizedProvider as any)._sourceName;
            const sourceLabel = sourceName ? `${source}/${sourceName}` : source;
            this.log(`  ${existed ? '🔄' : '✅'} ${normalizedProvider.type} (${normalizedProvider.category}) — ${normalizedProvider.name} [${sourceLabel}]${overrideWarning}`);
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
          // `examples/` is a documentation / scaffold tree (e.g. stub-cli),
          // not a real provider source. SDK authors copy from here when
          // writing a new provider; daemon-core tests reference the
          // manifest by path. Keep it off the dashboard's provider list.
          if (d === dir && entry.name === 'examples') continue;
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
