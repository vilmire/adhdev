/**
 * Verified provider channel (Stage 2 content-addressed store) for the
 * ProviderLoader: loading active activations, syncing from the registry,
 * the daemon-update ride-along, staleness probe, and pin rollback.
 *
 * Split out of provider-loader.ts (file-size gate). Owns every piece of
 * channel state; reads the loader only through {@link ProviderChannelSyncHost}.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from '../config/config.js';
import { configDirChannelMismatch } from '../config/config-dir.js';
import { PROVIDER_CHANNEL_ENV_VAR, type ProviderChannel } from './channel/contract.js';
import { ProviderChannelStore, type ActivationPointer } from './channel/store.js';
import {
  ProviderChannelRuntime,
  describeFetchError,
  collectSyncTargetTypes,
  type ChannelSyncReport,
} from './channel/runtime.js';
import type {
  ProviderAutoUpdateRecord,
  ProviderAutoUpdateStatus,
  ProviderChannelStalenessSnapshot,
} from './provider-loader-types.js';
import {
  evaluateCliCompatibility,
  evaluateDaemonCompatibility,
  evaluateVersionOrdering,
  makeActivationBlock,
  type ActivationBlock,
  type ActivationGate,
} from './channel/auto-update-gate.js';
import { locateArtifactDir } from './channel/runtime.js';

/**
 * Gate mode for a verified sync (docs/design/2026-10-10-provider-auto-update.md §3.3):
 *   - 'auto'     — periodic auto-update, daemon-update ride-along, bootstrap:
 *                  every gate (ordering, rollback pin, override, daemon, CLI);
 *   - 'explicit' — the user said "now" (activate_provider_updates /
 *                  provider sync-channel): only the daemon-version gate, since
 *                  a bundle the daemon cannot run is never what "now" means.
 */
export type ChannelSyncMode = 'auto' | 'explicit';

/** Block codes whose verdict depends only on (bundle, daemon version, CLI version) — cacheable. */
const INPUT_DETERMINED_BLOCKS = new Set(['DAEMON_VERSION_UNSUPPORTED', 'CLI_VERSION_UNSUPPORTED']);

interface AutoUpdateRecordInternal extends ProviderAutoUpdateRecord {
  digest: string;
  /** daemon|cli inputs the verdict was taken under (blocked cache key). */
  inputsKey: string;
}

export interface AutoUpdateRunResult {
  probe: ProviderChannelStalenessSnapshot;
  /** null when no sync ran (disabled, probe failed, nothing stale). */
  report: ChannelSyncReport | null;
}

/**
 * ★STORE-RELOAD debounce: minimum gap between two activation-signature
 * samples in `refreshIfChannelActivationChanged()`.
 *
 * Sized against the burst it exists to absorb. `publish-provider-channels
 * --execute` activates the full provider set (51 types as of 2026-08-10) in a
 * tight loop, and each flip changes the signature; without a floor, launches
 * during that window would each trigger a full `loadAll()` — a re-walk and
 * re-parse of every provider dir on disk — against a pointer set still being
 * written. 5s is far longer than such a burst's per-flip spacing yet far below
 * any human-noticeable staleness: the failure it prevents (a worker launched
 * against a superseded bundle) was measured at over an HOUR of divergence.
 *
 * It bounds staleness, it does not create it: `syncVerifiedChannel()` still
 * reloads immediately for activations this daemon performs itself.
 */
const CHANNEL_ACTIVATION_RECHECK_MS = 5_000;

/** Test seam: verified channel sync transport I/O (never set in production). */
export interface ChannelSyncIO {
  fetchJson?: (url: string) => Promise<any>;
  downloadFile?: (url: string, destPath: string) => Promise<void>;
  extractTarball?: (tarPath: string, destDir: string) => Promise<void>;
}

/** The loader surface the channel layer reads (all live). */
export interface ProviderChannelSyncHost {
  readonly upstreamDir: string;
  readonly defaultProvidersDir: string;
  log(msg: string): void;
  /** Full provider-map rebuild (ProviderLoader.loadAll). */
  reload(): void;
  /** Load one provider root into the map; returns the count loaded. */
  loadDir(dir: string): number;
  hasLoadedProvider(type: string): boolean;
  hasUpstream(): boolean;
  /** Dir the loaded provider resolves from (null = not loaded) — USER_OVERRIDE gate. */
  providerSourceDir(type: string): string | null;
  /** Last detected CLI version for a type (VersionArchive); null = unknown. */
  detectedCliVersion(type: string): string | null;
}

export class ProviderChannelSync {
  /** Active verified-channel object dirs, refreshed by loadVerifiedChannelActivations(). */
  objectRoots: string[] = [];
  /** Last read-only staleness probe result (checkVerifiedChannelStaleness). */
  private stalenessSnapshot: ProviderChannelStalenessSnapshot | null = null;
  /**
   * ★STORE-RELOAD: the channel activation signature observed at the last
   * load. `refreshIfChannelActivationChanged()` compares against it to
   * decide whether this daemon's in-memory provider map still matches the
   * pointers on disk. `null` = never sampled.
   */
  private activationSignature: string | null = null;
  /** Monotonic timestamp of the last signature sample, for the debounce. */
  private activationCheckedAtMs = 0;
  /** Tail of the in-process sync queue: verified syncs never overlap (they share staging + gc). */
  private syncTail: Promise<unknown> = Promise.resolve();
  /**
   * Every object digest this process has loaded. gc() keeps them although
   * unreferenced: a running session spawned from an object keeps reading it
   * (design doc §4). Resets with the process.
   */
  private readonly loadedDigests = new Set<string>();
  /** Auto-update status (design doc §5). In memory; the log is the history. */
  private autoUpdateEnabled = true;
  private autoUpdateLastRunAt: string | null = null;
  private autoUpdateLastError: string | undefined;
  private readonly autoUpdateRecords = new Map<string, AutoUpdateRecordInternal>();

  constructor(
    private readonly host: ProviderChannelSyncHost,
    /** null = the verified channel layer is disabled (tests). */
    readonly store: ProviderChannelStore | null,
    private readonly opts: {
      channel: ProviderChannel;
      /** See ProviderLoader.channelIsExplicit — gates the cross-track stamp write only. */
      channelIsExplicit: boolean;
      registryBaseUrl: string;
      providerTarballUrl: string;
      logFn: (msg: string) => void;
      channelSyncIO?: ChannelSyncIO;
      /** Running daemon version (normalized, no leading 'v'); '' when unknown. */
      daemonVersion: string;
    },
  ) {}

  /** Resolved registry base URL this layer syncs from. */
  get registryBaseUrl(): string { return this.opts.registryBaseUrl; }
  private get channel(): ProviderChannel { return this.opts.channel; }
  private get channelIsExplicit(): boolean { return this.opts.channelIsExplicit; }
  private get daemonVersion(): string { return this.opts.daemonVersion; }

  private runtime(store: ProviderChannelStore): ProviderChannelRuntime {
    return new ProviderChannelRuntime({
      store,
      registryBaseUrl: this.opts.registryBaseUrl,
      providerTarballUrl: this.opts.providerTarballUrl,
      logFn: this.opts.logFn,
      ...this.opts.channelSyncIO,
    });
  }


 /**
  * Load digest-verified channel activations from the content-addressed
  * store. Only objects referenced by an active pointer are read, so a
  * partially staged or interrupted sync is never observed. Corrupt pointers
  * / missing objects are logged as typed errors and skipped (fail closed).
  */
  loadVerifiedChannelActivations(): void {
    this.objectRoots = [];
    if (!this.store) return;
    // ★STORE-RELOAD: stamp the signature of the pointer set we are about to
    // read. Sampled BEFORE the reads so a concurrent activation landing during
    // this load leaves a signature that no longer matches, and the next check
    // reloads rather than concluding it is already current.
    try {
      this.activationSignature = this.store.activationSignature(this.channel);
      this.activationCheckedAtMs = Date.now();
    } catch {
      // A signature we cannot take must not be cached as "current" — leaving
      // it null makes the next check re-sample instead of trusting a stale map.
      this.activationSignature = null;
    }
    let result: ReturnType<ProviderChannelStore['listActiveActivations']>;
    try {
      result = this.store.listActiveActivations(this.channel);
    } catch (e: any) {
      this.host.log(`⚠ Verified channel store unreadable (${this.channel}): ${e?.message || e}`);
      return;
    }
    for (const err of result.errors) {
      this.host.log(`⚠ Verified channel: ${err.code}: ${err.message}`);
    }
    let count = 0;
    for (const { ref, objectDir } of result.activations) {
      this.loadedDigests.add(ref.digest);
      count += this.host.loadDir(objectDir);
      this.objectRoots.push(objectDir);
    }
    if (count > 0) {
      this.host.log(`Loaded ${count} verified channel providers (${this.channel}, content-addressed store)`);
    }
  }

 /**
  * ★STORE-RELOAD: reload providers if another process activated a different
  * bundle since this daemon last loaded.
  *
  * ── The gap this closes ────────────────────────────────────────────────
  * `ProviderChannelStore.activate()` is a pure pointer flip with no callback
  * into the loader, and the one place that reloads on activation —
  * `syncVerifiedChannel()` above — only runs for syncs THIS daemon performs.
  * Any other writer (the `provider publish`/`activate` CLI, a second daemon,
  * a dashboard-driven activation in another process) changes what is on disk
  * while this process keeps serving its boot-time map.
  *
  * Measured 2026-09-17: a daemon booted at 06:06 loaded cursor-cli v1.0.5
  * (its own boot sync having failed with CHANNEL_METADATA_UNAVAILABLE); a
  * separate process activated v1.0.6 at 07:11; a worker launched at 07:19
  * still got 1.0.5 — whose `meshCoordinator` declares no
  * `delegatedWorkerIsolation`, so `--approve-mcps` was never applied and the
  * worker booted with zero MCP tools. Nothing in the system reported the
  * divergence.
  *
  * ── Why polling the store rather than being notified ───────────────────
  * The alternative — having the publishing CLI signal the daemon over IPC —
  * was rejected: it couples correctness to the writer cooperating and to a
  * daemon being alive and addressable at flip time, and on a machine running
  * both a preview and a stable daemon it is ambiguous which to notify. Reading
  * the store makes the daemon's own launch path responsible for its own
  * freshness, which holds no matter who wrote.
  *
  * ── Why lazy rather than a timer or fs.watch ───────────────────────────
  * `fs.watch` needs a watcher lifecycle the loader has no teardown hook for,
  * and can fire mid-launch — reloading the provider map underneath a spawn
  * that has already read from it. A timer reloads on a schedule unrelated to
  * when anyone actually needs the data. Checking at the point of use is both
  * cheaper at rest (nothing runs when nothing launches) and correctly ordered:
  * the reload completes before the caller reads the map, never during.
  *
  * ── Debounce ───────────────────────────────────────────────────────────
  * Bounded to one signature sample per CHANNEL_ACTIVATION_RECHECK_MS. Without
  * it a burst of activations — `publish-provider-channels --execute` flips all
  * 51 types in a tight loop — would have each subsequent launch re-running a
  * full `loadAll()` (every provider dir on disk, re-parsed) against a pointer
  * set still mid-flight. The window also collapses a fan-out of concurrent
  * worker launches into a single check.
  *
  * Returns true when a reload actually happened.
  */
  refreshIfChannelActivationChanged(options?: { force?: boolean }): boolean {
    if (!this.store) return false;
    const now = Date.now();
    if (
      !options?.force
      && this.activationSignature !== null
      && now - this.activationCheckedAtMs < CHANNEL_ACTIVATION_RECHECK_MS
    ) {
      return false;
    }
    let signature: string;
    try {
      signature = this.store.activationSignature(this.channel);
    } catch (e: any) {
      // Fail closed toward the CURRENT map: an unreadable store is not
      // evidence of a new activation, and reloading on it would turn a
      // transient fs error into a provider-map rebuild on every launch.
      this.host.log(`⚠ Verified channel signature unreadable (${this.channel}): ${e?.message || e}`);
      this.activationCheckedAtMs = now;
      return false;
    }
    this.activationCheckedAtMs = now;
    if (this.activationSignature === signature) return false;
    const previous = this.activationSignature;
    // First sample (null) establishes the baseline without a reload — the map
    // was just built by loadAll(), so it is current by construction.
    if (previous === null) {
      this.activationSignature = signature;
      return false;
    }
    this.host.log(
      `Verified channel activations changed out-of-process on ${this.channel}`
      + ' — reloading providers so this daemon stops serving the superseded bundle',
    );
    // loadAll() re-stamps channelActivationSignature via
    // loadVerifiedChannelActivations(), so no manual assignment here.
    this.host.reload();
    return true;
  }

 /**
  * Sync verified channel activations for the installed provider set
  * (providers installed into .upstream via the dashboard install flow, plus
  * everything already activated on this channel).
  *
  * `bootstrapAll: true` (fresh-install bootstrap) instead targets every
  * activatable entry on the channel — used when a clean machine has an empty
  * .upstream AND an empty channel store, so there is no installed set to diff
  * against. Digest verification is unchanged: only verified entries activate.
  *
  * Fail-closed / last-known-good: on any metadata or transport failure
  * nothing new is activated and the previous active objects keep loading.
  * Reloads providers when at least one activation changed.
  */
  async syncVerifiedChannel(options?: {
    bootstrapAll?: boolean;
    /**
     * Extra provider types unioned into the sync target set. This is THE
     * install path for a channel type this machine has never activated
     * (kimi class: published after bootstrap → not in pins, not in
     * .upstream, unreachable by any targeted sync). Once activated the
     * pointer itself keeps the type in every future target set, so the
     * intent record needs no .upstream write.
     */
    extraTargetTypes?: readonly string[];
    /**
     * Restrict the sync to EXACTLY these provider types (the dashboard's
     * per-provider "Update" button). Replaces the default target set instead
     * of extending it, so one row's update never moves another provider's
     * pin. A restricted sync is partial by construction, so it does not write
     * the channel-activation stamp — the boot-time daemon-update ride-along
     * (maybeSyncVerifiedChannelOnDaemonUpdate) must still run for the rest.
     */
    onlyTargetTypes?: readonly string[];
    /** Gate mode (default 'explicit'). See ChannelSyncMode. */
    mode?: ChannelSyncMode;
  }): Promise<ChannelSyncReport> {
    // Serialize: the periodic auto-update, the boot chain and an explicit
    // activation can otherwise overlap on one store — and gc() wipes every
    // staging dir, including the other sync's in-flight extraction.
    const run = this.syncTail.then(() => this.syncVerifiedChannelNow(options));
    this.syncTail = run.catch(() => undefined);
    return run;
  }

  private async syncVerifiedChannelNow(options?: Parameters<ProviderChannelSync['syncVerifiedChannel']>[0]): Promise<ChannelSyncReport> {
    if (!this.store) {
      return {
        channel: this.channel,
        status: 'error',
        activated: [],
        skipped: [],
        errors: [{ code: 'STORE_CORRUPT', message: 'verified channel store is disabled' }],
        blocked: [],
      };
    }
    const mode: ChannelSyncMode = options?.mode ?? 'explicit';
    const runtime = this.runtime(this.store);
    const onlyTypes = (options?.onlyTargetTypes ?? [])
      .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
      .map((t) => t.trim());
    const restricted = onlyTypes.length > 0;
    const targetTypes = restricted
      ? new Set(onlyTypes)
      : collectSyncTargetTypes(this.host.upstreamDir, this.store, this.channel);
    if (!restricted) {
      for (const extra of options?.extraTargetTypes ?? []) {
        if (typeof extra === 'string' && extra.trim()) targetTypes.add(extra.trim());
      }
    }
    const pinsBefore = this.listVerifiedChannelPins();
    const report = await runtime.sync({
      channel: this.channel,
      targetTypes,
      bootstrapAll: options?.bootstrapAll,
      gate: this.buildGate(mode),
      retainDigests: this.loadedDigests,
    });
    this.recordGateOutcome(report, pinsBefore, mode);
    for (const skip of report.skipped) {
      this.host.log(`⚠ Verified channel skip: ${skip.reason}`);
    }
    for (const err of report.errors) {
      this.host.log(`⚠ Verified channel error: ${err.code}: ${err.message}`);
    }
    if (report.activated.length > 0) {
      this.host.reload();
      // Self-heal the staleness badge: everything just activated is neither
      // stale nor new anymore. Pure cache update — no network from here.
      if (this.stalenessSnapshot) {
        const activatedTypes = new Set(report.activated.map((a) => a.providerType));
        this.stalenessSnapshot = {
          ...this.stalenessSnapshot,
          staleTypes: this.stalenessSnapshot.staleTypes.filter((t) => !activatedTypes.has(t)),
          newTypes: this.stalenessSnapshot.newTypes.filter((t) => !activatedTypes.has(t)),
        };
      }
    }
    if (report.status !== 'error' && !restricted) {
      // Record which daemon version last completed a verified sync — the
      // boot-time daemon-update activation (maybeSyncVerifiedChannelOnDaemonUpdate)
      // short-circuits on this stamp. Errored syncs write nothing so the next
      // boot retries.
      this.writeChannelActivationStamp();
    }
    return report;
  }

 /**
  * Number of valid active pointers on the resolved channel (0 = empty or
  * disabled store). Corrupt pointer files are excluded by the store.
  */
  countVerifiedChannelPointers(): number {
    if (!this.store) return 0;
    try {
      return this.store.listPointers(this.channel).pointers.size;
    } catch {
      return 0;
    }
  }

 /**
  * Bounded one-shot first sync for an empty verified channel store.
  *
  * Two empty-store cases, one gate (channel has no active pointers):
  *
  *   1. Providers installed into .upstream (upgrade / channel-switch paths —
  *      the rc.20 preview activation gap): targeted sync of the installed set.
  *   2. Fresh install — .upstream empty AND store empty (the "daemon ships
  *      empty" design left new users at 0 providers and unable to run
  *      anything): bootstrap sync. The registry channel listing itself is the
  *      target set, so the daemon self-populates the whole verified channel
  *      on first boot. Only digest-verified entries activate;
  *      legacy-unverified rows stay typed skips.
  *
  * Runs at most one verified sync per call and ONLY while the resolved
  * channel has zero pointers — once anything is activated the gate
  * short-circuits forever (no re-bootstrap, no network). Fail-closed: any
  * registry/transport failure activates nothing (last-known-good preserved)
  * and is retried on the next boot or via check_provider_updates. Never
  * invoked from any status path.
  *
  * Returns the sync report, or null when the first-sync gate did not apply.
  */
  async maybeFirstSyncVerifiedChannel(): Promise<ChannelSyncReport | null> {
    if (!this.store) return null;
    if (this.countVerifiedChannelPointers() > 0) {
      // A bootstrap that activated SOME entries used to close this gate for
      // good, so whatever failed in it was never retried. 2026-09-30: the
      // stable registry's CLI rows did not match the provider repo, a fresh
      // install activated the 12 IDE providers and none of the 7 CLI agents,
      // and kept zero CLI agents after the registry was fixed. Re-run the
      // bootstrap until one completes cleanly. Installs from before the stamp
      // existed (neither marker) are left alone unless they have no CLI agent
      // at all — which only a failed bootstrap produces.
      if (this.bootstrapMarkerExists('complete')) return null;
      if (!this.bootstrapMarkerExists('pending') && this.hasActiveCliPointer()) return null;
      return this.runBootstrapSync();
    }
    if (this.host.hasUpstream()) return this.syncVerifiedChannel({ mode: 'auto' });
    // Fresh-install bootstrap: nothing installed, nothing activated. Make
    // sure the providers dir exists (nothing else creates it on this path —
    // the store's own mkdirs only cover providers/.store) and pull the whole
    // verified channel from the registry.
    try { fs.mkdirSync(this.host.defaultProvidersDir, { recursive: true }); } catch { /* best-effort */ }
    return this.runBootstrapSync();
  }

  /**
   * Whole-channel bootstrap; stamps completion only when no entry failed. An
   * entry whose artifact the provider repo no longer ships
   * (ENTRY_ARTIFACT_NOT_FOUND — a provider removed from the repo while its old
   * registry row remains) can never succeed and does not hold the stamp back.
   */
  private async runBootstrapSync(): Promise<ChannelSyncReport> {
    const report = await this.syncVerifiedChannel({ bootstrapAll: true, mode: 'auto' });
    const blocking = report.errors.filter((e) => e.code !== 'ENTRY_ARTIFACT_NOT_FOUND');
    const clean = report.status !== 'error' && blocking.length === 0;
    this.writeBootstrapMarker(clean ? 'complete' : 'pending');
    return report;
  }

  /** Per-channel file names, so a preview and a stable instance never read each other's marker. */
  private bootstrapMarkerPath(kind: 'complete' | 'pending'): string {
    return path.join(this.host.defaultProvidersDir, `.channel-bootstrap-${kind}.${this.channel}.json`);
  }

  private bootstrapMarkerExists(kind: 'complete' | 'pending'): boolean {
    return fs.existsSync(this.bootstrapMarkerPath(kind));
  }

  /** Exactly one of the two markers exists after a bootstrap pass. Best-effort: a missing marker only means one more pass. */
  private writeBootstrapMarker(kind: 'complete' | 'pending'): void {
    try {
      fs.mkdirSync(this.host.defaultProvidersDir, { recursive: true });
      fs.writeFileSync(this.bootstrapMarkerPath(kind), JSON.stringify({ channel: this.channel, at: new Date().toISOString() }) + '\n', 'utf-8');
      fs.rmSync(this.bootstrapMarkerPath(kind === 'complete' ? 'pending' : 'complete'), { force: true });
    } catch { /* best-effort */ }
  }

  private hasActiveCliPointer(): boolean {
    if (!this.store) return false;
    try {
      for (const pointer of this.store.listPointers(this.channel).pointers.values()) {
        if (pointer.active.category === 'cli') return true;
      }
    } catch { /* unreadable store → treat as none */ }
    return false;
  }

  /** Stamp path recording which daemon version last ran a successful verified sync. */
  private channelActivationStampPath(): string {
    return path.join(this.host.defaultProvidersDir, '.channel-activation-stamp.json');
  }

  private readChannelActivationStamp(): { daemonVersion?: string; channel?: string } | null {
    try {
      return JSON.parse(fs.readFileSync(this.channelActivationStampPath(), 'utf-8'));
    } catch {
      return null;
    }
  }

  /**
   * CROSS-TRACK CLOBBER GUARD (2026-08-22 incident).
   *
   * The stamp lives under `<configDir>/providers/`, and ADHDEV_CONFIG_DIR
   * overrides that path while feeding NO signal into resolveProviderChannel.
   * So a process pointed at a preview config dir whose channel merely fell
   * through to the 'stable' default (a source run under tsx — no
   * `__ADHDEV_BUILD_CHANNEL__` bundler define — inheriting a coordinator
   * shell's ADHDEV_CONFIG_DIR=~/.adhdev-preview) would rewrite the LIVE
   * preview daemon's stamp to channel:'stable'. The next real daemon boot then
   * read a stamp whose channel no longer matched its own, and the observed
   * result was 52 providers loading as 0.
   *
   * The guard is deliberately narrow — refusing the write outright would be an
   * over-correction that breaks the stamp's whole purpose (skipping a full
   * network sync on same-version reboots), making every boot re-sync. We
   * suppress ONLY the write that would flip an existing stamp onto another
   * track, and only when this process's channel is a fallback rather than an
   * explicit signal. Concretely, a write is skipped iff ALL hold:
   *   - the channel was NOT explicitly signalled (fallback 'stable'), and
   *   - the config dir's basename implies the OTHER track
   *     (configDirChannelMismatch — the same predicate daemon-lifecycle.ts
   *     already warns on), and
   *   - a stamp already exists whose channel differs from ours.
   * A normal daemon — explicit channel, or a matching/absent stamp — always
   * writes, so the network-free-boot contract is untouched.
   */
  private writeChannelActivationStamp(): void {
    if (!this.daemonVersion) return;
    const stampPath = this.channelActivationStampPath();
    if (!this.channelIsExplicit) {
      const mismatch = configDirChannelMismatch(getConfigDir(), this.channel, false);
      if (mismatch) {
        const existing = this.readChannelActivationStamp();
        if (existing && existing.channel && existing.channel !== this.channel) {
          // Loud and attributable: the 2026-08-21 misdiagnosis cost hours
          // because the overwrite was silent. Name both sides and the cause.
          this.host.log(
            `⚠ Refusing to overwrite channel activation stamp ${stampPath}: `
            + `existing stamp is ${existing.daemonVersion ?? 'unknown'}@${existing.channel}, `
            + `this process resolved channel '${this.channel}' by FALLBACK (no explicit `
            + `providerChannel/${PROVIDER_CHANNEL_ENV_VAR}/build-track stamp) while the config dir `
            + `${getConfigDir()} implies the '${mismatch.impliedTrack}' track. `
            + `This usually means a source/dev process (tsx — no build-track stamp) inherited a live `
            + `daemon's ADHDEV_CONFIG_DIR. Leaving the live stamp intact; set `
            + `${PROVIDER_CHANNEL_ENV_VAR}=${mismatch.impliedTrack} for this process if it is meant to `
            + `manage the '${mismatch.impliedTrack}' channel.`,
          );
          return;
        }
      }
    }
    try {
      fs.mkdirSync(this.host.defaultProvidersDir, { recursive: true });
      fs.writeFileSync(stampPath, JSON.stringify({
        daemonVersion: this.daemonVersion,
        channel: this.channel,
        syncedAt: new Date().toISOString(),
      }, null, 2));
    } catch { /* best-effort — a missing stamp only means one extra sync next boot */ }
  }

 /**
  * DAEMON-UPDATE = PROVIDER ACTIVATION (owner decision 2026-08-10, option C).
  *
  * The verified-channel pin deliberately only advances on an explicit
  * activation ("the user saying now"), which left published provider fixes
  * invisible on every machine where nobody pressed the button — live 08-10
  * measurement: every fleet pin still carried the 08-07 bootstrap timestamp
  * after a publish AND a full fleet restart. The daemon upgrade is the one
  * update moment the user already trusts, so ride it: on the FIRST boot of a
  * new daemon version (or after a channel switch), run one full verified
  * sync. Every other boot stays network-free — the stamp written by the last
  * successful sync short-circuits same-version boots. Fail-closed: an
  * errored sync writes no stamp, so the next boot retries; last-known-good
  * activations are untouched throughout (syncVerifiedChannel semantics).
  *
  * Empty stores are excluded — maybeFirstSyncVerifiedChannel owns bootstrap,
  * and its successful sync writes the same stamp (both paths converge in
  * syncVerifiedChannel), so a fresh install does not double-sync.
  *
  * Note this advances EXISTING targets (active pins + installed set) only. A
  * provider type first published after bootstrap still needs an explicit
  * catalog install — surfaced by checkVerifiedChannelStaleness as newTypes.
  */
  async maybeSyncVerifiedChannelOnDaemonUpdate(): Promise<ChannelSyncReport | null> {
    if (!this.store || !this.daemonVersion) return null;
    if (this.countVerifiedChannelPointers() === 0) return null;
    const stamp = this.readChannelActivationStamp();
    if (stamp?.daemonVersion === this.daemonVersion && stamp?.channel === this.channel) return null;
    this.host.log(`Daemon version transition detected (stamp=${stamp?.daemonVersion ?? 'none'}@${stamp?.channel ?? '-'} → ${this.daemonVersion}@${this.channel}) — running verified channel sync`);
    return this.syncVerifiedChannel({ mode: 'auto' });
  }

 /**
  * Read-only staleness probe (owner decision 2026-08-10, option A).
  *
  * ONE channel-listing request, no downloads, no pointer writes: compares the
  * channel's current entries against the local active pins and reports
  *   - staleTypes: pinned providers whose channel entry moved past the pin
  *   - newTypes:   activatable channel entries this machine has never
  *                 activated NOR installed — the class that made kimi
  *                 invisible (published after bootstrap, unreachable even by
  *                 activate_provider_updates because the sync target set is
  *                 pins+installed).
  * The result is cached on the loader for get_status_metadata so dashboards
  * can badge without triggering network from a status path. Fail-closed: on
  * any transport/shape error the previous snapshot is kept and the error is
  * recorded on it.
  */
  async checkVerifiedChannelStaleness(): Promise<ProviderChannelStalenessSnapshot> {
    const checkedAt = new Date().toISOString();
    if (!this.store) {
      return this.stalenessSnapshot = { checkedAt, channel: this.channel, staleTypes: [], newTypes: [], error: 'verified channel store is disabled' };
    }
    const runtime = this.runtime(this.store);
    let entries: Awaited<ReturnType<ProviderChannelRuntime['fetchChannelEntries']>>;
    try {
      entries = await runtime.fetchChannelEntries(this.channel);
    } catch (e: any) {
      const prev = this.stalenessSnapshot;
      return this.stalenessSnapshot = {
        checkedAt,
        channel: this.channel,
        staleTypes: prev?.staleTypes ?? [],
        newTypes: prev?.newTypes ?? [],
        // Expand AggregateError sub-errors: a bare "AggregateError" string
        // here is unattributable (see describeFetchError).
        error: describeFetchError(e),
      };
    }
    const pins = this.listVerifiedChannelPins();
    const installedTargets = collectSyncTargetTypes(this.host.upstreamDir, this.store, this.channel);
    const staleTypes: string[] = [];
    const newTypes: string[] = [];
    for (const entry of entries) {
      if (!entry.bundleDigest) continue; // not activatable — never actionable
      const pin = pins.get(entry.providerType);
      if (pin) {
        if (pin.active?.digest !== entry.bundleDigest) staleTypes.push(entry.providerType);
      } else if (!installedTargets.has(entry.providerType) && !this.host.hasLoadedProvider(entry.providerType)) {
        // "New" means this machine cannot run the provider today. A type
        // already LOADED through any layer — user dir, sibling checkout,
        // external source — is not new, and offering an install would be
        // actively misleading: those layers OUTRANK the channel store
        // (getProviderRoots order), so activating the channel bundle would
        // change nothing the daemon loads. Live catch 2026-08-10: a dev
        // machine loading opencode/cursor from the sibling checkout showed
        // both as "감지됨" rows AND as installable new types.
        newTypes.push(entry.providerType);
      }
    }
    staleTypes.sort();
    newTypes.sort();
    return this.stalenessSnapshot = { checkedAt, channel: this.channel, staleTypes, newTypes };
  }

  /**
   * PERIODIC AUTO-UPDATE (owner decision 2026-10-10; design doc
   * docs/design/2026-10-10-provider-auto-update.md). One read-only listing;
   * when pins are stale and auto-update is enabled, a sync RESTRICTED to the
   * stale pinned types under the 'auto' gates. Never installs a new type
   * (newTypes are not targets), never writes the daemon-version stamp (a
   * restricted sync is partial), never touches running sessions (activation
   * is a new object + pointer flip; loaded objects are retained by gc).
   * Disabled → the same read-only probe the 08-10 badge used.
   */
  async runAutoUpdate(options: { enabled: boolean }): Promise<AutoUpdateRunResult> {
    this.autoUpdateEnabled = options.enabled;
    const probe = await this.checkVerifiedChannelStaleness();
    this.autoUpdateLastRunAt = probe.checkedAt;
    if (probe.error) {
      this.autoUpdateLastError = probe.error;
      return { probe, report: null };
    }
    this.autoUpdateLastError = undefined;
    // A blocked verdict about a bundle the channel no longer offers is stale.
    for (const [type, rec] of this.autoUpdateRecords) {
      if (rec.state === 'blocked' && !probe.staleTypes.includes(type)) this.autoUpdateRecords.delete(type);
    }
    if (!options.enabled || probe.staleTypes.length === 0) return { probe, report: null };
    const report = await this.syncVerifiedChannel({ onlyTargetTypes: probe.staleTypes, mode: 'auto' });
    if (report.status === 'error') {
      this.autoUpdateLastError = report.errors.map((e) => `${e.code}: ${e.message}`).join(' | ') || 'sync error';
    }
    return { probe, report };
  }

  /** Auto-update status for the dashboard (check_provider_updates). Pure read. */
  getAutoUpdateStatus(): ProviderAutoUpdateStatus {
    const types: Record<string, ProviderAutoUpdateRecord> = {};
    for (const [type, rec] of this.autoUpdateRecords) {
      const { digest: _digest, inputsKey: _inputsKey, ...pub } = rec;
      types[type] = pub;
    }
    return {
      enabled: this.autoUpdateEnabled,
      lastRunAt: this.autoUpdateLastRunAt,
      ...(this.autoUpdateLastError ? { lastError: this.autoUpdateLastError } : {}),
      types,
    };
  }

  private gateInputsKey(type: string): string {
    return `${this.daemonVersion}|${this.host.detectedCliVersion(type) ?? ''}`;
  }

  /** True when the type loads from outside the channel store / .upstream (user dir, sibling checkout, external). */
  private isOverriddenOutsideChannel(type: string): boolean {
    const dir = this.host.providerSourceDir(type);
    if (!dir || !this.store) return false;
    const inside = (root: string) => {
      const rel = path.relative(root, dir);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    };
    return !inside(this.store.rootDir) && !inside(this.host.upstreamDir);
  }

  /** Provider dir of the CURRENT active object for a pin (CLI-regression baseline), or null. */
  private activeArtifactDir(pointer: ActivationPointer): string | null {
    if (!this.store) return null;
    try {
      return locateArtifactDir(this.store.getObjectDir(pointer.active.digest), pointer.active);
    } catch {
      return null;
    }
  }

  private buildGate(mode: ChannelSyncMode): ActivationGate {
    const afterVerify: ActivationGate['afterVerify'] = (entry, artifact, pointer) => {
      const daemon = evaluateDaemonCompatibility(entry, artifact.manifest, this.daemonVersion, pointer);
      if (daemon || mode !== 'auto') return daemon;
      return evaluateCliCompatibility(
        entry,
        artifact,
        this.host.detectedCliVersion(entry.providerType),
        pointer ? this.activeArtifactDir(pointer) : null,
        pointer,
      );
    };
    if (mode !== 'auto') return { afterVerify };
    return {
      beforeTransport: (entry, pointer) => {
        // Every pre-transport gate is about an EXISTING pin; a first
        // activation (bootstrap / explicit install) has nothing to protect.
        if (!pointer) return null;
        const ordering = evaluateVersionOrdering(entry, pointer);
        if (ordering) return ordering;
        if (this.isOverriddenOutsideChannel(entry.providerType)) {
          return makeActivationBlock(entry, pointer, 'USER_OVERRIDE',
            `${entry.providerType} loads from a local override (${this.host.providerSourceDir(entry.providerType)}) — the channel bundle would not take effect; auto-update skipped`);
        }
        // Same bundle, same inputs, same verdict — do not re-download it every run.
        const prev = this.autoUpdateRecords.get(entry.providerType);
        if (prev?.state === 'blocked' && prev.code && INPUT_DETERMINED_BLOCKS.has(prev.code)
          && prev.digest === entry.bundleDigest && prev.inputsKey === this.gateInputsKey(entry.providerType)) {
          return makeActivationBlock(entry, pointer, prev.code as ActivationBlock['code'], prev.reason ?? '', prev.requires);
        }
        return null;
      },
      afterVerify,
    };
  }

  /** Fold a sync's activations/blocks into the auto-update status and the log. */
  private recordGateOutcome(report: ChannelSyncReport, pinsBefore: Map<string, ActivationPointer>, mode: ChannelSyncMode): void {
    const at = new Date().toISOString();
    for (const ref of report.activated) {
      const from = pinsBefore.get(ref.providerType)?.active.providerVersion ?? null;
      if (mode === 'auto') {
        this.autoUpdateRecords.set(ref.providerType, {
          state: 'updated', from, to: ref.providerVersion, at, digest: ref.digest, inputsKey: this.gateInputsKey(ref.providerType),
        });
        this.host.log(`Provider auto-update: ${ref.providerType} ${from ?? '(none)'} → ${ref.providerVersion} (${this.channel})`);
      } else {
        this.autoUpdateRecords.delete(ref.providerType);
      }
    }
    for (const b of report.blocked) {
      const prev = this.autoUpdateRecords.get(b.providerType);
      const inputsKey = this.gateInputsKey(b.providerType);
      if (!(prev?.state === 'blocked' && prev.code === b.code && prev.digest === b.bundleDigest)) {
        this.host.log(`Provider auto-update: ${b.providerType} ${b.fromVersion ?? '(none)'} → ${b.providerVersion} blocked (${b.code}): ${b.reason}`);
      }
      this.autoUpdateRecords.set(b.providerType, {
        state: 'blocked',
        from: b.fromVersion,
        to: b.providerVersion,
        at: prev?.state === 'blocked' && prev.digest === b.bundleDigest ? prev.at : at,
        code: b.code,
        reason: b.reason,
        ...(b.requires ? { requires: b.requires } : {}),
        digest: b.bundleDigest,
        inputsKey,
      });
    }
  }

  /** Last probe result (null until the first checkVerifiedChannelStaleness run). Pure read. */
  getChannelStalenessSnapshot(): ProviderChannelStalenessSnapshot | null {
    return this.stalenessSnapshot;
  }

 /**
  * The verified-channel PIN for each provider: what this daemon actually
  * loads, as opposed to what is sitting in `.upstream`.
  *
  * Those two diverge by design. The store pin only advances on an activation
  * (explicit, daemon-update ride-along, or the gated 6h auto-update — which
  * can be off or blocked), so a published fix can be
  * present in the repo and in ~/.adhdev/providers/.upstream while the daemon
  * keeps running an older pinned object — which is exactly how a shipped kimi
  * resume fix stayed invisible on a machine for a full day. Anything that
  * reports "the installed version" without this is reporting the wrong number.
  *
  * Pure read: no network, no pointer writes.
  */
  listVerifiedChannelPins(): Map<string, ActivationPointer> {
    if (!this.store) return new Map();
    try {
      return this.store.listPointers(this.channel).pointers;
    } catch {
      return new Map();
    }
  }

 /**
  * Roll a provider back to its previously activated verified object. Pure
  * local pointer flip — no network. Returns the new active digest, or null
  * when there is no rollback target.
  */
  rollbackVerifiedChannel(providerType: string): string | null {
    if (!this.store) return null;
    const ref = this.store.rollback(this.channel, providerType);
    if (ref) this.host.reload();
    return ref?.digest ?? null;
  }

 /** Remove a verified activation (e.g. the provider was uninstalled). */
  deactivateVerifiedChannel(providerType: string): boolean {
    if (!this.store) return false;
    const removed = this.store.removePointer(this.channel, providerType);
    if (removed) this.host.reload();
    return removed;
  }
}
