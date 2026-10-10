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
 *
 * Split: the loaded-map queries, machine provider config and settings API live
 * in ProviderRegistry (provider-registry.ts, the base class); the verified
 * channel layer in provider-channel-sync.ts; sibling-checkout detection in
 * provider-loader-sibling.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as chokidar from 'chokidar';
import { LOG } from '../logging/logger.js';
import { VersionArchive } from './version-archive.js';
import type {
    ProviderModule,
    ProviderCategory,
    ProviderScripts,
    ResolvedProvider,
} from './contracts.js';
import {
  loadProvidersActive,
  resolveActiveSource,
} from './external-sources.js';
import type { ProviderSourceMode } from '../config/config.js';
import { getConfigDir } from '../config/config.js';
import {
  resolveRegistryBaseUrl,
  resolveProviderTarballUrl,
} from '../config/registry-resolver.js';
import type { ProviderSourceConfigSnapshot, ProviderUserDirSource } from '../config/provider-source-config.js';
import {
  resolveProviderChannel,
  isPreviewReleaseChannel,
  PROVIDER_CHANNEL_ENV_VAR,
  type ProviderChannel,
} from './channel/contract.js';
import { resolveBuildTrack } from '../track-identity.js';
import { ProviderChannelStore, type ActivationPointer } from './channel/store.js';
import type { ChannelSyncReport } from './channel/runtime.js';
import {
    registerProviderScriptRootSafely,
    buildScriptWrappersFromDir,
    matchesVersion,
} from './provider-loader-support.js';
import {
  loadProviderDir,
  findProviderDirInternal,
} from './provider-loader-manifest-scan.js';
import { applySpecNativeHistoryWiring } from './provider-loader-spec-wiring.js';
import { ProviderChannelSync } from './provider-channel-sync.js';
import { ProviderRegistry } from './provider-registry.js';
import { detectDefaultUserDir } from './provider-loader-sibling.js';
import type { ProviderAutoUpdateStatus, ProviderChannelStalenessSnapshot } from './provider-loader-types.js';




export class ProviderLoader extends ProviderRegistry {
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


  /** Resolved provider channel (explicit config/env wins; otherwise derived from the daemon release channel; absent/ambiguous → 'stable'). */
  readonly channel: ProviderChannel;
  /**
   * Whether `channel` came from an explicit signal (config.providerChannel /
   * ADHDEV_PROVIDER_CHANNEL / build-track stamp / preview updateChannel) or
   * merely fell through to the 'stable' default. Only used to gate the
   * cross-track stamp write — never to change channel resolution itself.
   */
  private readonly channelIsExplicit: boolean;
  /** Verified provider channel layer (provider-channel-sync.ts). */
  private readonly channelSync: ProviderChannelSync;
  /** Resolved registry base URL the verified channel syncs from (config → env → serverUrl → vendor default). */
  get registryBaseUrl(): string { return this.channelSync.registryBaseUrl; }

  private probeStarts: string[] = [];
  /** Once-per-loader dedup of the sibling-adoption info line (see provider-loader-sibling.ts). */
  private readonly siblingState = { siblingLogged: false };
  private userDirSource: ProviderUserDirSource = 'home-default';



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
     * Highest-priority resolver source, ahead of ADHDEV_REGISTRY_URL,
     * serverUrl derivation, and the vendor default.
     */
    registryUrl?: string;
    /**
     * Resolved daemon server URL (config.serverUrl). When no explicit
     * registryUrl / ADHDEV_REGISTRY_URL override is set, the registry base is
     * derived from this origin (preview server → preview registry). Every
     * construction path must pass it so boot, CLI, and command handlers share
     * one registry authority.
     */
    serverUrl?: string;
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
     * always wins, and the build track stamp (track-identity.ts) is also
     * consulted: a preview build derives preview even when this is stable.
     * Absent/ambiguous → 'stable'.
     */
    updateChannel?: string;
    /**
     * Verified channel store override (tests). Pass `null` to disable the
     * verified channel layer entirely. Defaults to the content-addressed
     * store under `<configDir>/providers/.store`.
     */
    channelStore?: ProviderChannelStore | null;
    /**
     * Test seam: inject the verified channel sync transport I/O
     * (metadata fetch / tarball download / extraction) instead of the
     * default HTTPS + Node-native tarball extraction. Never set in production.
     */
    channelSyncIO?: {
      fetchJson?: (url: string) => Promise<any>;
      downloadFile?: (url: string, destPath: string) => Promise<void>;
      extractTarball?: (tarPath: string, destDir: string) => Promise<void>;
    };
    /**
     * The running daemon's own version. When set, every successful verified
     * channel sync stamps it to disk, and maybeSyncVerifiedChannelOnDaemonUpdate
     * compares the stamp on boot — the "daemon update = provider activation"
     * policy (owner decision 2026-08-10).
     */
    daemonVersion?: string;
  }) {
    super();
    this.logFn = options?.logFn || LOG.forComponent('Provider').asLogFn();
    this.probeStarts = options?.probeStarts ?? [process.cwd(), __dirname];
    // Channel resolution MUST happen before detectDefaultUserDir() below:
    // sibling-checkout adoption is gated on the resolved channel. Explicit
    // channel config/env always wins; otherwise the provider channel derives
    // from the daemon release channel (preview daemon → preview providers).
    this.channel = resolveProviderChannel(options?.channel, process.env, options?.updateChannel);
    // Provenance of the resolution above, captured because resolveProviderChannel
    // collapses "explicitly stable" and "fell through to stable" into the same
    // value. Mirrors the signal set daemon-lifecycle.ts uses for its axis
    // warning, plus the build-track stamp (which that warning treats as the
    // absent signal it is diagnosing). Read only by writeChannelActivationStamp.
    this.channelIsExplicit = Boolean(
      (options?.channel && options.channel.trim())
      || (process.env[PROVIDER_CHANNEL_ENV_VAR] ?? '').trim()
      || resolveBuildTrack(process.env) === 'preview'
      || isPreviewReleaseChannel(options?.updateChannel),
    );
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.channelSync = new ProviderChannelSync(
      {
        get upstreamDir() { return self.upstreamDir; },
        get defaultProvidersDir() { return self.defaultProvidersDir; },
        log: (msg) => this.log(msg),
        reload: () => this.loadAll(),
        loadDir: (dir) => this.loadDir(dir),
        hasLoadedProvider: (type) => this.providers.has(type),
        hasUpstream: () => this.hasUpstream(),
        providerSourceDir: (type) => this.findProviderDirInternal(type),
        detectedCliVersion: (type) => this.versionArchive?.getLatest(type) ?? null,
      },
      options?.channelStore === null
        ? null
        : (options?.channelStore ?? new ProviderChannelStore(ProviderChannelStore.defaultRoot(), this.logFn)),
      {
        channel: this.channel,
        channelIsExplicit: this.channelIsExplicit,
        // Registry base / tarball URL resolution order: explicit config field
        // (constructor option) → env var → vendor default (registry-resolver.ts).
        registryBaseUrl: resolveRegistryBaseUrl(options?.registryUrl, process.env, options?.serverUrl),
        providerTarballUrl: resolveProviderTarballUrl(options?.providerTarballUrl),
        logFn: this.logFn,
        channelSyncIO: options?.channelSyncIO,
        daemonVersion: (options?.daemonVersion || '').trim().replace(/^v/, ''),
      },
    );

    // Default directory for auto-downloads. Resolved via getConfigDir() so
    // ADHDEV_CONFIG_DIR (preview/stable instance isolation) is honored instead
    // of a hardcoded ~/.adhdev.
    this.defaultProvidersDir = path.join(getConfigDir(), 'providers');
    const detected = detectDefaultUserDir({ probeStarts: this.probeStarts, channel: this.channel, log: (m) => this.log(m), state: this.siblingState });
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

  protected log(msg: string): void {
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
    return [this.userDir, externalDir, ...this.channelSync.objectRoots, this.upstreamDir];
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
      const detected = detectDefaultUserDir({ probeStarts: this.probeStarts, channel: this.channel, log: (m) => this.log(m), state: this.siblingState });
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
 * Empty .upstream/ is normal: verified channel activations (step 1.5) are
 * the primary source, bootstrapped from the registry by
 * maybeFirstSyncVerifiedChannel() at boot. (The legacy GitHub-tarball and
 * single-manifest registry sync paths were removed 2026-08-10 —
 * M-PROVIDER-DIST-UNIFY; the digest-verified channel is the only
 * registry-sourced layer.)
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
    this.channelSync.loadVerifiedChannelActivations();

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
      const KNOWN_CATEGORIES = new Set(['cli', 'ide', 'extension']);
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

 // ─── Verified provider channel (Stage 2) — see provider-channel-sync.ts ───

  /** ★STORE-RELOAD: reload when another process activated a different bundle. Returns true on reload. */
  refreshIfChannelActivationChanged(options?: { force?: boolean }): boolean {
    return this.channelSync.refreshIfChannelActivationChanged(options);
  }
  syncVerifiedChannel(options?: Parameters<ProviderChannelSync['syncVerifiedChannel']>[0]): Promise<ChannelSyncReport> {
    return this.channelSync.syncVerifiedChannel(options);
  }
  countVerifiedChannelPointers(): number { return this.channelSync.countVerifiedChannelPointers(); }
  maybeFirstSyncVerifiedChannel(): Promise<ChannelSyncReport | null> { return this.channelSync.maybeFirstSyncVerifiedChannel(); }
  maybeSyncVerifiedChannelOnDaemonUpdate(): Promise<ChannelSyncReport | null> {
    return this.channelSync.maybeSyncVerifiedChannelOnDaemonUpdate();
  }
  checkVerifiedChannelStaleness(): Promise<ProviderChannelStalenessSnapshot> { return this.channelSync.checkVerifiedChannelStaleness(); }
  getChannelStalenessSnapshot(): ProviderChannelStalenessSnapshot | null { return this.channelSync.getChannelStalenessSnapshot(); }
  /** Periodic gated auto-update (docs/design/2026-10-10-provider-auto-update.md). */
  runAutoUpdate(options: { enabled: boolean }): ReturnType<ProviderChannelSync['runAutoUpdate']> { return this.channelSync.runAutoUpdate(options); }
  getAutoUpdateStatus(): ProviderAutoUpdateStatus { return this.channelSync.getAutoUpdateStatus(); }
  listVerifiedChannelPins(): Map<string, ActivationPointer> { return this.channelSync.listVerifiedChannelPins(); }
  rollbackVerifiedChannel(providerType: string): string | null { return this.channelSync.rollbackVerifiedChannel(providerType); }
  deactivateVerifiedChannel(providerType: string): boolean { return this.channelSync.deactivateVerifiedChannel(providerType); }

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
 * Resolve the on-disk spec path for a provider WITHOUT resolving scripts.
 *
 * `resolve()` deep-clones the map entry, so the `_resolvedSpecPath` it sets
 * lives only on that clone; `getMeta()` returns the map entry and therefore
 * never carries the field. Callers that hold a `getMeta()` result and need
 * the spec path must use this instead of reading the hidden field.
 *
 * Root cause this exists for (agy folder-trust stall): the delegated mesh
 * worker launch path read `_resolvedSpecPath` off a `getMeta()` result, so
 * `loadPreLaunchTrustFromSpecPath()` always received undefined → no trust
 * plan → no worker-auto grant was ever ledgered → every fresh worktree hit
 * antigravity's "Do you trust the contents of this project?" prompt, which
 * has no reachable approval surface from the coordinator.
 *
 * Delegates to `resolve()` so the version/compatibility candidate walk stays
 * defined in exactly one place; returns null for providers that ship no spec.
 */
  getResolvedSpecPath(type: string, context?: { os?: string; version?: string }): string | null {
    const resolved = this.resolve(type, context) as { _resolvedSpecPath?: string } | undefined;
    const specPath = resolved?._resolvedSpecPath;
    return typeof specPath === 'string' && specPath.trim() ? specPath : null;
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
    this.applyVersionScripts(resolved, base, type, providerDir, currentVersion);

 // 3. Composite override (OS + version)
    this.applyScriptOverrides(resolved, base, currentOs, currentVersion);

    if ((resolved.category === 'cli') && resolved.spawn?.command) {
      resolved.spawn = {
        ...resolved.spawn,
        command: this.getSpawnCommand(type, resolved.spawn.command),
        args: this.getSpawnArgs(type, resolved.spawn.args || []),
      };
    }

    // (spec migration) Late-binding spec.json native-history hook. Runs
    // *after* every script-loading path (compatibility / defaultScriptDir /
    // overrides) so it deterministically wins over a legacy v1 scripts.js
    // export. Body lives in provider-loader-spec-wiring.ts.
    applySpecNativeHistoryWiring(resolved, base, providerDir, currentVersion);

    return resolved;
  }

  /**
   * resolve() stage 2 — version-based script selection: the `compatibility`
   * array (first matching range wins, else `defaultScriptDir`), the legacy
   * `versions` map, or `defaultScriptDir` when no version is known.
   */
  private applyVersionScripts(
    resolved: ResolvedProvider,
    base: ProviderModule,
    type: string,
    providerDir: string | undefined,
    currentVersion: string | undefined,
  ): void {
    if (currentVersion) {
      resolved._resolvedVersion = currentVersion;

      // --- New format: compatibility array ---
      if (base.compatibility) {
        let matched = false;
        for (const entry of base.compatibility) {
          if (!matchesVersion(currentVersion, entry.ideVersion)) continue;
          // entry.scriptDir is optional now — spec-driven providers (agy,
          // codex on >=0.137, claude on >=2.1) only ship `spec` here, so
          // there's nothing to load from the filesystem. SpecCliAdapter
          // takes over via the `spec` path later in resolve(). A spec-only
          // entry still counts as a match so the defaultScriptDir fallback
          // below doesn't kick in.
          if (!entry.scriptDir) { matched = true; break; }
          if (this.applyScriptDir(resolved, type, providerDir, entry.scriptDir, `compatibility:${entry.ideVersion}`)) {
            this.debugLog(`  [compatibility] ${type} v${currentVersion} → ${entry.scriptDir}`);
            matched = true;
          }
          break; // first match wins
        }

        // No compatibility match → defaultScriptDir
        if (!matched && base.defaultScriptDir) {
          if (this.applyScriptDir(resolved, type, providerDir, base.defaultScriptDir, 'defaultScriptDir:version_miss')) {
            this.debugLog(`  [compatibility] ${type} v${currentVersion} → default: ${base.defaultScriptDir}`);
          }
          resolved._versionWarning = `Version ${currentVersion} not in compatibility matrix. Using default scripts.`;
        }

      // --- Legacy format: versions field ---
      } else if (base.versions) {
        for (const [range, override] of Object.entries(base.versions)) {
          if (!matchesVersion(currentVersion, range)) continue;
          const dirOverride = override.__dir;
          if (dirOverride) {
            if (this.applyScriptDir(resolved, type, providerDir, dirOverride, `versions:${range}`)) {
              this.log(`  [version override] ${type} ${range} → ${dirOverride}`);
            }
          } else if (override.scripts) {
            resolved.scripts = { ...resolved.scripts, ...override.scripts };
          }
        }
      }
    } else if (base.compatibility && base.defaultScriptDir) {
      // No version detected but compatibility format → use defaultScriptDir
      if (this.applyScriptDir(resolved, type, providerDir, base.defaultScriptDir, 'defaultScriptDir:no_version')) {
        this.debugLog(`  [compatibility] ${type} no version detected → default: ${base.defaultScriptDir}`);
      }
    }
  }

  /** Load `scriptDir` into `resolved.scripts` and stamp its provenance. False when nothing loaded. */
  private applyScriptDir(
    resolved: ResolvedProvider,
    type: string,
    providerDir: string | undefined,
    scriptDir: string,
    source: string,
  ): boolean {
    const loaded = this.loadScriptsFromDir(type, scriptDir);
    if (!loaded) return false;
    resolved.scripts = loaded;
    resolved._resolvedScriptDir = scriptDir;
    resolved._resolvedScriptsSource = source;
    if (providerDir) {
      const fullDir = path.join(providerDir, scriptDir);
      resolved._resolvedScriptsPath = fs.existsSync(path.join(fullDir, 'scripts.js'))
        ? path.join(fullDir, 'scripts.js')
        : fullDir;
    }
    return true;
  }

  /**
   * resolve() stage 3 — composite overrides.
   * Legacy shape: base.overrides is an Array<{ when: {os,version}, scripts }>.
   * v1 manifests (Phase 3-4) repurposed `overrides` as an object map of
   * capability overrides (e.g. { detectStatus: { path, schema } }): each
   * script name maps to a path inside the provider directory, whose export is
   * merged into resolved.scripts. Lets a provider override a single primitive
   * (e.g. just detectStatus) while letting the SDK synthesize the rest from
   * the tui block.
   */
  private applyScriptOverrides(
    resolved: ResolvedProvider,
    base: ProviderModule,
    currentOs: string,
    currentVersion: string | undefined,
  ): void {
    if (Array.isArray(base.overrides)) {
      for (const override of base.overrides) {
        const osMatch = !override.when.os || override.when.os === currentOs;
        const verMatch = !override.when.version || (currentVersion && matchesVersion(currentVersion, override.when.version));
        if (osMatch && verMatch && override.scripts) {
          resolved.scripts = { ...resolved.scripts, ...override.scripts };
        }
      }
      return;
    }
    if (!base.overrides || typeof base.overrides !== 'object') return;
    const providerDir = this.findProviderDirInternal(base.type);
    if (!providerDir) return;
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
    const result = buildScriptWrappersFromDir(dir);
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


 // ─── Private ───────────────────────────────────

  /**
   * Find the on-disk directory for a provider by type.
   * Body lives in provider-loader-manifest-scan.ts.
   */
  private findProviderDirInternal(type: string): string | null {
    return findProviderDirInternal(
      {
        providers: this.providers,
        getProviderRoots: () => this.getProviderRoots(),
        getProviderDir: (root, category, type_) => this.getProviderDir(root, category, type_),
      },
      type,
    );
  }

 /**
  * Recursively scan directory to load provider files.
  * Body lives in provider-loader-manifest-scan.ts; this forwards the
  * instance state the scanner needs.
  */
   private loadDir(dir: string, excludeDirs?: string[]): number {
    return loadProviderDir(
      { log: (m) => this.log(m), userDir: this.userDir, providers: this.providers, channel: this.channel },
      dir,
      excludeDirs,
    );
  }
}
