/**
 * Provider channel runtime (Stage 2): fetch explicit channel metadata,
 * download the provider artifact transport, verify every artifact tree
 * against its channel digest, and activate verified trees into the
 * content-addressed store.
 *
 * Data flow (fail-closed, last-known-good preserving):
 *
 *   registry `GET {base}/providers?channel=<ch>&limit=100`
 *     → preview responses must echo `channel: "preview"` at the top level —
 *       a missing/mismatched echo means the registry ignores channel reads
 *       (legacy prod payload) and is rejected with CHANNEL_METADATA_MISMATCH
 *       before anything is touched (stable stays echo-optional for backward
 *       compatibility with the pre-contract registry)
 *     → entries { type, version, category, bundleDigest, digestAlgorithm }
 *     → partition: NULL/legacy-unverified → typed skip; unknown algorithm →
 *       typed skip; malformed digest → typed skip
 *     → diff against active store pointers (already-current entries skipped)
 *     → download repo tarball (transport; bytes are NOT trusted)
 *     → extract into store staging (invisible to readers)
 *     → per entry: locate artifact dir, recompute
 *       `adhdev-provider-tree-sha256-v1` over the staged tree, compare to the
 *       channel digest — mismatch/invalid → typed per-entry error, previous
 *       activation untouched
 *     → verified trees move into objects/ (atomic rename) and pointers flip
 *       (atomic rename)
 *     → gc() enforces N=2 retention
 *
 * Any metadata/transport failure aborts the sync BEFORE anything is
 * activated: the last-known-good active objects keep loading. Stable never
 * falls through to preview — the requested channel is the only channel read.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ProviderChannelError,
  partitionChannelEntries,
  type ActivatableEntry,
  type ChannelEntry,
  type ProviderChannel,
  type ProviderChannelErrorCode,
  type SkippedEntry,
} from './contract.js';
import { computeProviderTreeDigest } from './tree-digest.js';
import type { ActivationRef, ProviderChannelStore } from './store.js';
import { extractTarballGz } from '../extract-tarball.js';
import {
  buildPinnedArchiveUrl,
  MAX_HISTORY_CANDIDATES,
  parseGitHubArchiveUrl,
  resolveTransportCandidates,
} from './pinned-transport.js';
import { readProviderManifest, type ActivationBlock, type ActivationGate } from './auto-update-gate.js';

export interface ChannelSyncError {
  code: ProviderChannelErrorCode;
  message: string;
  providerType?: string;
}

export interface ChannelSyncReport {
  channel: ProviderChannel;
  /** 'activated' ≥1 new activation; 'up-to-date' nothing changed; 'error' nothing changed and a sync-level failure occurred. */
  status: 'activated' | 'up-to-date' | 'error';
  activated: ActivationRef[];
  skipped: SkippedEntry[];
  errors: ChannelSyncError[];
  /**
   * Entries a compatibility gate declined (auto-update.gate). NOT errors: the
   * previous activation stays live and status/stamp logic ignores them.
   */
  blocked: ActivationBlock[];
}

export interface ProviderChannelRuntimeOptions {
  store: ProviderChannelStore;
  registryBaseUrl: string;
  providerTarballUrl: string;
  logFn?: (msg: string) => void;
  /** Injectable HTTP JSON fetch (tests). Defaults to a minimal https.get wrapper. */
  fetchJson?: (url: string) => Promise<any>;
  /**
   * Injectable JSON fetch for the transport-pinning commit lookup.
   *
   * Deliberately SEPARATE from `fetchJson`: that seam is the registry channel
   * metadata channel, and several tests assert that every URL passing through
   * it carries the requested `channel=` (the fail-closed guard against a
   * stable sync silently reading preview). The commit lookup is a different
   * host and a different contract, so routing it through the same seam would
   * turn a real invariant into one that has to be loosened. Defaults to the
   * same https wrapper.
   */
  fetchTransportMetaJson?: (url: string) => Promise<any>;
  /** Injectable file download (tests). Defaults to a redirect-following https wrapper. */
  downloadFile?: (url: string, destPath: string) => Promise<void>;
  /** Injectable tarball extraction (tests). Defaults to Node-native zlib + tar-fs extraction (no external `tar` binary). */
  extractTarball?: (tarPath: string, destDir: string) => Promise<void>;
}

const REGISTRY_LIST_LIMIT = 100;

/**
 * Bounded retry for the channel metadata request.
 *
 * WHY THIS EXISTS (live RCA 2026-09-20). The daemon-update sync fires during
 * the daemon's own start-up storm — IDE detection probing 8 CDP ports, the
 * coordinator session spawning, node-datachannel loading, the P2P smoke test
 * and the server WS connect all run in the same ~2s window. Node's Happy
 * Eyeballs (`autoSelectFamily`, default ON since Node 20) races the IPv4 and
 * IPv6 candidates with a 250ms head start for the first family; when the
 * event loop is congested that head start elapses before the IPv4 socket
 * completes, so the IPv6 candidates are attempted too. On a host that
 * publishes AAAA records but has no usable IPv6 egress — e.g. a Mac whose
 * only IPv6 default routes point at `utun*` VPN interfaces with no global
 * IPv6 address — those attempts fail `EHOSTUNREACH` and Node collects every
 * candidate's failure into an `AggregateError`.
 *
 * That failure is transient by construction: the very same request succeeds
 * seconds later once the boot storm drains (measured live — the 10-minute
 * staleness probe, which calls `fetchChannelEntries` with the identical URL,
 * reports successfully on the same boots where this sync aborts). A single
 * attempt that gives up until the next daemon restart therefore strands
 * published provider manifests indefinitely on exactly the machines that
 * update most often.
 *
 * The retry is deliberately small and finite: 3 attempts with a short
 * exponential backoff. It is NOT a substitute for the fail-closed design —
 * once the attempts are exhausted the sync still aborts with last-known-good
 * activations intact, which is the correct end state for a genuinely
 * unreachable registry. The bound is what keeps a real outage from turning
 * boot into an unbounded retry loop.
 */
const METADATA_FETCH_ATTEMPTS = 3;

/** Backoff before retry N (ms). Short: this rides the boot path. */
const METADATA_RETRY_BACKOFF_MS = [250, 1000];

/**
 * Human-readable description of a failure, expanding `AggregateError`.
 *
 * `AggregateError` — what Happy Eyeballs throws when every address candidate
 * fails — carries an EMPTY `.message`, so the previous `e?.message || e`
 * rendered the entire diagnosis as the bare string "AggregateError": no
 * error code, no address, no family. That erasure is itself a defect; it made
 * the live failure impossible to attribute from logs for weeks, and drove an
 * investigation toward the registry and the URL when neither was at fault.
 *
 * Each sub-error is rendered as `CODE syscall address:port` so the family
 * (v4 vs v6) and the failure class are both readable at a glance. Duplicate
 * renderings are collapsed with a count — four candidates commonly reduce to
 * two distinct causes, and the collapsed form keeps the boot log short.
 */
export function describeFetchError(e: any): string {
  const subErrors: any[] = Array.isArray(e?.errors) ? e.errors : [];
  if (subErrors.length > 0) {
    const counts = new Map<string, number>();
    for (const sub of subErrors) {
      const parts: string[] = [];
      if (sub?.code) parts.push(String(sub.code));
      if (sub?.syscall) parts.push(String(sub.syscall));
      if (sub?.address) parts.push(`${sub.address}${sub.port ? `:${sub.port}` : ''}`);
      const rendered = parts.length > 0 ? parts.join(' ') : (sub?.message || String(sub));
      counts.set(rendered, (counts.get(rendered) ?? 0) + 1);
    }
    const rendered = [...counts.entries()]
      .map(([text, n]) => (n > 1 ? `${text} (x${n})` : text))
      .join('; ');
    const name = e?.name || 'AggregateError';
    return `${name}: ${rendered}`;
  }
  return e?.message || String(e);
}

/** Sleep helper for the metadata retry backoff. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ProviderChannelRuntime {
  private readonly store: ProviderChannelStore;
  private readonly registryBaseUrl: string;
  private readonly providerTarballUrl: string;
  private readonly logFn: (msg: string) => void;
  private readonly fetchJson: (url: string) => Promise<any>;
  private readonly fetchTransportMetaJson: (url: string) => Promise<any>;
  private readonly downloadFile: (url: string, destPath: string) => Promise<void>;
  private readonly extractTarball: (tarPath: string, destDir: string) => Promise<void>;

  constructor(options: ProviderChannelRuntimeOptions) {
    this.store = options.store;
    this.registryBaseUrl = options.registryBaseUrl.replace(/\/+$/, '');
    this.providerTarballUrl = options.providerTarballUrl;
    this.logFn = options.logFn ?? (() => {});
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.fetchTransportMetaJson = options.fetchTransportMetaJson ?? defaultFetchJson;
    this.downloadFile = options.downloadFile ?? downloadProviderArchive;
    this.extractTarball = options.extractTarball ?? defaultExtractTarball;
  }

  private log(msg: string): void {
    this.logFn(`[ProviderChannelRuntime] ${msg}`);
  }

  /**
   * Fetch and normalize the entry list for one explicit channel. Throws a
   * typed CHANNEL_METADATA_UNAVAILABLE error on any failure — callers must
   * keep last-known-good and MUST NOT retry with a different channel.
   */
  async fetchChannelEntries(channel: ProviderChannel): Promise<ChannelEntry[]> {
    const url = `${this.registryBaseUrl}/providers?channel=${channel}&limit=${REGISTRY_LIST_LIMIT}`;
    let body: any;
    // Transport-level failures are retried a bounded number of times (see
    // METADATA_FETCH_ATTEMPTS): the live failure mode is a boot-storm address
    // race that clears within seconds. Everything below this loop — shape and
    // channel-echo validation — is a DETERMINISTIC contract failure and is
    // deliberately NOT retried: re-requesting a registry that ignores
    // `?channel=` just returns the same wrong payload three times.
    for (let attempt = 1; ; attempt += 1) {
      try {
        body = await this.fetchJson(url);
        if (attempt > 1) {
          this.log(`channel metadata fetch succeeded for channel "${channel}" on attempt ${attempt}/${METADATA_FETCH_ATTEMPTS}`);
        }
        break;
      } catch (e: any) {
        const detail = describeFetchError(e);
        if (attempt >= METADATA_FETCH_ATTEMPTS) {
          throw new ProviderChannelError(
            'CHANNEL_METADATA_UNAVAILABLE',
            `channel metadata fetch failed for channel "${channel}" after ${attempt} attempt(s) (url=${url}): ${detail}`,
          );
        }
        const backoff = METADATA_RETRY_BACKOFF_MS[attempt - 1] ?? METADATA_RETRY_BACKOFF_MS[METADATA_RETRY_BACKOFF_MS.length - 1];
        this.log(`channel metadata fetch attempt ${attempt}/${METADATA_FETCH_ATTEMPTS} failed (${detail}) — retrying in ${backoff}ms`);
        await delay(backoff);
      }
    }
    if (!body || !Array.isArray(body.providers)) {
      throw new ProviderChannelError(
        'CHANNEL_METADATA_UNAVAILABLE',
        `channel metadata for "${channel}" has an unexpected shape (missing providers array)`,
      );
    }
    // Fail-closed channel echo contract (rc.21): the preview registry echoes
    // the requested channel at the top level. A response that omits the echo
    // or echoes a different channel comes from a registry that does not honor
    // channel reads (e.g. the legacy production registry, which ignores
    // ?channel=preview and returns digest-less legacy rows). Refuse to treat
    // such rows as preview — callers keep last-known-good. The stable channel
    // intentionally does NOT require the echo: the stable registry predates
    // the echo contract and its echo-less responses must stay accepted
    // (backward compatibility).
    if (channel === 'preview') {
      const echo = typeof body.channel === 'string' ? body.channel.trim().toLowerCase() : '';
      if (echo !== channel) {
        throw new ProviderChannelError(
          'CHANNEL_METADATA_MISMATCH',
          `registry response for channel "preview" ${typeof body.channel === 'string' ? `echoes channel "${body.channel}"` : 'omits the top-level channel echo'} — the registry does not honor the channel contract (legacy/stable payload); refusing to treat its rows as preview, last-known-good preserved`,
        );
      }
    }
    const entries: ChannelEntry[] = [];
    for (const raw of body.providers) {
      if (!raw || typeof raw.type !== 'string' || typeof raw.version !== 'string' || typeof raw.category !== 'string') {
        // Malformed rows cannot be mapped to an artifact — drop them here;
        // they are not activatable in any case.
        continue;
      }
      entries.push({
        providerType: raw.type,
        providerVersion: raw.version,
        category: raw.category,
        bundleDigest: typeof raw.bundleDigest === 'string' ? raw.bundleDigest : null,
        digestAlgorithm: typeof raw.digestAlgorithm === 'string' ? raw.digestAlgorithm : null,
        ...(raw.sourceCommit != null ? { sourceCommit: raw.sourceCommit } : {}),
      });
    }
    return entries;
  }

  /**
   * Sync the verified channel activations for `targetTypes`.
   *
   * `bootstrapAll: true` (fresh-install bootstrap) widens the target set to
   * EVERY activatable entry on the channel, ignoring `targetTypes`: a clean
   * machine has nothing in `.upstream` and no pointers, so there is no
   * installed set to diff against — the channel listing itself is the desired
   * end state. Only digest-verified entries activate; legacy-unverified /
   * unknown-algorithm rows stay typed skips exactly as in a targeted sync.
   *
   * Never throws for expected failure modes: every failure is reported as a
   * typed error in the returned report and the previous activations stay
   * live (last-known-good). Unexpected programming errors still throw.
   */
  async sync(options: {
    channel: ProviderChannel;
    targetTypes: ReadonlySet<string>;
    bootstrapAll?: boolean;
    /** Compatibility gates (auto-update-gate.ts). Absent = activate every verified pending entry. */
    gate?: ActivationGate;
    /** Objects gc() must keep although unreferenced (loaded by this process — see store.gc). */
    retainDigests?: ReadonlySet<string>;
  }): Promise<ChannelSyncReport> {
    const { channel, targetTypes, bootstrapAll, gate } = options;
    const report: ChannelSyncReport = {
      channel,
      status: 'up-to-date',
      activated: [],
      skipped: [],
      errors: [],
      blocked: [],
    };

    // 1. Channel metadata. Failure → abort before touching anything (LKG).
    let entries: ChannelEntry[];
    try {
      entries = await this.fetchChannelEntries(channel);
    } catch (e: any) {
      const err = toSyncError(e, 'CHANNEL_METADATA_UNAVAILABLE');
      report.errors.push(err);
      report.status = 'error';
      this.log(`sync aborted (${err.code}): ${err.message}`);
      return report;
    }

    // 2. Fail-closed entry gating (legacy-unverified / unsupported algorithm /
    //    malformed digest are typed skips, never activated).
    const { activatable, skipped } = partitionChannelEntries(entries);
    report.skipped = skipped;
    const targets = bootstrapAll ? activatable : activatable.filter((e) => targetTypes.has(e.providerType));

    // 3. Diff against active pointers.
    const pending: ActivatableEntry[] = [];
    for (const entry of targets) {
      let pointer: ReturnType<ProviderChannelStore['getPointer']> = null;
      try {
        pointer = this.store.getPointer(channel, entry.providerType);
      } catch (e: any) {
        // Corrupt pointer: record and treat as pending — a verified
        // re-activation atomically replaces the corrupt file.
        report.errors.push(toSyncError(e, 'STORE_CORRUPT', entry.providerType));
      }
      if ((pointer?.active.digest ?? null) === entry.bundleDigest) continue;
      // Pre-transport gate: decided from the pin alone, so a gated entry
      // never costs a tarball download.
      const early = gate?.beforeTransport?.(entry, pointer) ?? null;
      if (early) {
        report.blocked.push(early);
        continue;
      }
      pending.push(entry);
    }

    if (pending.length === 0) {
      return report;
    }

    // Published commits bypass GitHub discovery entirely. Keep separate groups:
    // channel entries may have been published from different repository commits.
    const groups = new Map<string, ActivatableEntry[]>();
    const archive = parseGitHubArchiveUrl(this.providerTarballUrl);
    for (const entry of pending) {
      if (entry.sourceCommit !== undefined &&
        (typeof entry.sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(entry.sourceCommit))) {
        report.errors.push({ code: 'CHANNEL_METADATA_UNAVAILABLE', providerType: entry.providerType,
          message: `invalid sourceCommit for "${entry.providerType}"` });
        continue;
      }
      const key = entry.sourceCommit ?? '';
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    // Sync-scoped archive cache (review R3-02 / R4-02):
    // - Tip stays pinned for the whole legacy group (shared once).
    // - Historical candidates are released immediately after the attempt so
    //   peak retained staging is tip + at most one deeper archive.
    type CachedArchive = { stagingRoot: string; repoRoot: string };
    const archiveCache = new Map<string, CachedArchive>();
    let tipUrlHeld: string | null = null;
    /** Peak number of retained staging dirs observed during this sync (tests). */
    let peakRetainedArchives = 0;
    const notePeak = () => {
      peakRetainedArchives = Math.max(peakRetainedArchives, archiveCache.size);
    };
    const releaseArchiveCache = () => {
      for (const cached of archiveCache.values()) {
        this.store.removeStagingDir(cached.stagingRoot);
      }
      archiveCache.clear();
      tipUrlHeld = null;
    };
    const releaseArchive = (transportUrl: string): void => {
      if (transportUrl === tipUrlHeld) return;
      const cached = archiveCache.get(transportUrl);
      if (!cached) return;
      this.store.removeStagingDir(cached.stagingRoot);
      archiveCache.delete(transportUrl);
    };

    const ensureArchive = async (
      transportUrl: string,
    ): Promise<{ ok: true; repoRoot: string } | { ok: false; message: string }> => {
      const hit = archiveCache.get(transportUrl);
      if (hit) return { ok: true, repoRoot: hit.repoRoot };
      let stagingRoot: string;
      try {
        stagingRoot = this.store.createStagingDir('sync');
      } catch (e: any) {
        return { ok: false, message: `provider staging create failed: ${e?.message || e}` };
      }
      try {
        const tarPath = path.join(stagingRoot, 'providers.tar.gz');
        const extractDir = path.join(stagingRoot, 'repo');
        try {
          fs.mkdirSync(extractDir, { recursive: true });
          await this.downloadFile(transportUrl, tarPath);
          await this.extractTarball(tarPath, extractDir);
        } catch (e: any) {
          this.store.removeStagingDir(stagingRoot);
          return { ok: false, message: `provider tarball transport failed: ${e?.message || e}` };
        }
        const repoRoot = findTarballRepoRoot(extractDir);
        if (!repoRoot) {
          this.store.removeStagingDir(stagingRoot);
          return { ok: false, message: 'provider tarball has an unexpected structure (no repo root dir)' };
        }
        archiveCache.set(transportUrl, { stagingRoot, repoRoot });
        notePeak();
        return { ok: true, repoRoot };
      } catch (e: any) {
        this.store.removeStagingDir(stagingRoot);
        return { ok: false, message: `provider tarball transport failed: ${e?.message || e}` };
      }
    };

    const activateAgainstRepo = async (
      entries: ActivatableEntry[],
      repoRoot: string,
    ): Promise<{
      activated: ActivationRef[];
      errors: ChannelSyncError[];
      blockedTypes: Set<string>;
    }> => {
      const activated: ActivationRef[] = [];
      const errors: ChannelSyncError[] = [];
      const blockedTypes = new Set<string>();
      for (const entry of entries) {
        const outcome = await this.tryActivateOne(channel, entry, repoRoot, gate);
        if (outcome && 'blocked' in outcome) {
          report.blocked.push(outcome.blocked);
          blockedTypes.add(entry.providerType);
        } else if (outcome) {
          errors.push(outcome);
        } else {
          const pointer = this.store.getPointer(channel, entry.providerType);
          if (pointer) activated.push(pointer.active);
        }
      }
      return { activated, errors, blockedTypes };
    };

    /** Prefer the physical artifact dirname when known; else category/type guess. */
    const historyPathsFor = (
      entry: ActivatableEntry,
      physicalByType: Map<string, string>,
    ): string[] => {
      const physical = physicalByType.get(entry.providerType);
      if (physical) return [physical];
      return [`${entry.category}/${entry.providerType}`];
    };

    const learnPhysicalPaths = (
      entries: ActivatableEntry[],
      repoRoot: string,
      physicalByType: Map<string, string>,
    ): void => {
      for (const entry of entries) {
        if (physicalByType.has(entry.providerType)) continue;
        const dir = locateArtifactDir(repoRoot, entry);
        if (!dir) continue;
        physicalByType.set(entry.providerType, `${entry.category}/${path.basename(dir)}`);
      }
    };

    try {
      for (const [sourceCommit, groupEntries] of groups) {
        const pending = [...groupEntries];
        if (pending.length === 0) continue;

        if (sourceCommit) {
          const candidates = [
            archive ? buildPinnedArchiveUrl(archive, sourceCommit) : this.providerTarballUrl,
          ];
          for (let attempt = 0; attempt < candidates.length; attempt += 1) {
            const transportUrl = candidates[attempt];
            const isLastCandidate = attempt === candidates.length - 1;
            const ensured = await ensureArchive(transportUrl);
            if (!ensured.ok) {
              report.errors.push({ code: 'TRANSPORT_FAILED', message: ensured.message });
              report.status = 'error';
              this.log(`source group failed (TRANSPORT_FAILED): ${ensured.message} [${pathEnvDiagnostic()}]`);
              break;
            }
            const { activated, errors, blockedTypes } = await activateAgainstRepo(pending, ensured.repoRoot);
            const retryable = errors.filter((e) => e.code === 'DIGEST_MISMATCH');
            const retryWithOlderCommit = retryable.length > 0
              && retryable.length === errors.length
              && !isLastCandidate;
            if (retryWithOlderCommit) {
              report.activated.push(...activated);
              const resolved = new Set([...activated.map((a) => a.providerType), ...blockedTypes]);
              for (let i = pending.length - 1; i >= 0; i -= 1) {
                if (resolved.has(pending[i].providerType)) pending.splice(i, 1);
              }
              continue;
            }
            report.activated.push(...activated);
            report.errors.push(...errors);
            break;
          }
          continue;
        }

        // Legacy (no sourceCommit): share tip once, then walk history only for
        // DIGEST_MISMATCH / ENTRY_ARTIFACT_NOT_FOUND rows (R4-03). After path
        // candidates are exhausted, try bounded full-repo history skipping
        // SHAs already tried *for that entry* so a rename cannot hide the
        // publish commit (R4-01). Historical archives are released immediately
        // (R4-02); while staged, every unresolved entry that still needs that
        // URL is verified against it (R5-01).
        const physicalByType = new Map<string, string>();
        const tipRetryableByType = new Map<string, ChannelSyncError>();
        const tipCandidates = await resolveTransportCandidates(
          this.providerTarballUrl,
          this.fetchTransportMetaJson,
          { limit: 1 },
        );
        const tipUrl = tipCandidates[0] ?? this.providerTarballUrl;
        tipUrlHeld = tipUrl;
        /** Per-entry URLs already evaluated (never a group-wide historical ban). */
        const triedByEntry = new Map<string, Set<string>>();
        const entryTried = (providerType: string): Set<string> => {
          let set = triedByEntry.get(providerType);
          if (!set) {
            set = new Set<string>([tipUrl]);
            triedByEntry.set(providerType, set);
          }
          return set;
        };

        {
          const ensured = await ensureArchive(tipUrl);
          if (!ensured.ok) {
            report.errors.push({ code: 'TRANSPORT_FAILED', message: ensured.message });
            report.status = 'error';
            this.log(`source group failed (TRANSPORT_FAILED): ${ensured.message} [${pathEnvDiagnostic()}]`);
            continue;
          }
          learnPhysicalPaths(pending, ensured.repoRoot, physicalByType);
          const { activated, errors, blockedTypes } = await activateAgainstRepo(pending, ensured.repoRoot);
          report.activated.push(...activated);
          const resolved = new Set([...activated.map((a) => a.providerType), ...blockedTypes]);
          for (let i = pending.length - 1; i >= 0; i -= 1) {
            if (resolved.has(pending[i].providerType)) pending.splice(i, 1);
          }
          for (const e of errors) {
            if (e.code === 'DIGEST_MISMATCH' || e.code === 'ENTRY_ARTIFACT_NOT_FOUND') {
              if (e.providerType) tipRetryableByType.set(e.providerType, e);
            } else {
              report.errors.push(e);
              // Terminal tip errors must not enter the history worklist (R4-03).
              if (e.providerType) {
                for (let i = pending.length - 1; i >= 0; i -= 1) {
                  if (pending[i].providerType === e.providerType) pending.splice(i, 1);
                }
              }
            }
          }
        }

        // History worklist: only commit-dependent tip outcomes.
        let historyPending = pending.filter((e) => tipRetryableByType.has(e.providerType));

        type HistoryAttemptResult = {
          activated: boolean;
          lastErrors: ChannelSyncError[];
          /** Non-retryable activation/staging failure — do not open repo fallback (R5-02). */
          terminal: boolean;
        };

        /**
         * Stage one historical URL, verify every unresolved entry that still
         * needs it, then release (peak = tip + 1). Attempts are tracked per
         * entry so one row consuming H cannot ban H for another (R5-01).
         */
        const tryHistoricalUrl = async (
          transportUrl: string,
          driver: ActivatableEntry,
        ): Promise<HistoryAttemptResult> => {
          const applicable = historyPending.filter(
            (e) => !entryTried(e.providerType).has(transportUrl),
          );
          if (applicable.length === 0) {
            return { activated: false, lastErrors: [], terminal: false };
          }
          for (const e of applicable) entryTried(e.providerType).add(transportUrl);
          const ensured = await ensureArchive(transportUrl);
          try {
            if (!ensured.ok) {
              const err: ChannelSyncError = {
                code: 'TRANSPORT_FAILED',
                message: ensured.message,
                providerType: driver.providerType,
              };
              // Download/extract failure is candidate-specific — not terminal
              // for the entry (later SHAs may still work).
              return { activated: false, lastErrors: [err], terminal: false };
            }
            learnPhysicalPaths(applicable, ensured.repoRoot, physicalByType);
            const { activated, errors, blockedTypes } = await activateAgainstRepo(
              applicable,
              ensured.repoRoot,
            );
            report.activated.push(...activated);
            const done = new Set([
              ...activated.map((a) => a.providerType),
              ...blockedTypes,
            ]);
            historyPending = historyPending.filter((e) => !done.has(e.providerType));

            const driverActivated = done.has(driver.providerType);
            if (driverActivated) {
              return { activated: true, lastErrors: [], terminal: false };
            }
            const isRetryable = (code: ChannelSyncError['code']): boolean =>
              code === 'DIGEST_MISMATCH' || code === 'ENTRY_ARTIFACT_NOT_FOUND';
            // Any non-retryable activation failure settles that row immediately
            // with its typed error — no further path/repo candidates (R5-02).
            for (const e of errors) {
              if (!e.providerType || isRetryable(e.code)) continue;
              historyPending = historyPending.filter((row) => row.providerType !== e.providerType);
              if (e.providerType !== driver.providerType) {
                // Collateral terminal rows are removed without revisiting the
                // outer loop — record their typed error here.
                report.errors.push(e);
              }
            }
            const driverErrors = errors.filter((e) => e.providerType === driver.providerType);
            const terminal = driverErrors.some((e) => !isRetryable(e.code));
            return {
              activated: false,
              lastErrors: driverErrors,
              terminal,
            };
          } finally {
            releaseArchive(transportUrl);
          }
        };

        const tryCandidateUrls = async (
          entry: ActivatableEntry,
          candidates: string[],
        ): Promise<HistoryAttemptResult> => {
          let lastErrors: ChannelSyncError[] = [];
          for (let attempt = 0; attempt < candidates.length; attempt += 1) {
            const transportUrl = candidates[attempt];
            if (transportUrl === tipUrl) continue;
            if (entryTried(entry.providerType).has(transportUrl)) continue;
            // Driver may already have been activated while another entry staged this URL.
            if (!historyPending.some((e) => e.providerType === entry.providerType)) {
              return { activated: true, lastErrors: [], terminal: false };
            }
            const remaining = candidates.slice(attempt + 1).filter(
              (u) => u !== tipUrl && !entryTried(entry.providerType).has(u),
            );
            const isLastCandidate = remaining.length === 0;
            const outcome = await tryHistoricalUrl(transportUrl, entry);
            if (outcome.activated) return outcome;
            if (outcome.terminal) return outcome;
            lastErrors = outcome.lastErrors.length > 0 ? outcome.lastErrors : lastErrors;
            const retryable = lastErrors.filter(
              (e) => e.code === 'DIGEST_MISMATCH' || e.code === 'ENTRY_ARTIFACT_NOT_FOUND',
            );
            if (lastErrors.length > 0 && retryable.length !== lastErrors.length) {
              return { activated: false, lastErrors, terminal: true };
            }
            if (isLastCandidate) break;
            if (lastErrors.length > 0) {
              this.log(
                `commit-dependent failure at ${transportUrl} for ${entry.providerType}`
                + ` (${[...new Set(retryable.map((e) => e.code))].join(', ')})`
                + ' — trying the next candidate commit',
              );
            }
          }
          return { activated: false, lastErrors, terminal: false };
        };

        for (const entry of [...historyPending]) {
          if (!historyPending.some((e) => e.providerType === entry.providerType)) continue;
          const paths = historyPathsFor(entry, physicalByType);
          const pathCandidates = await resolveTransportCandidates(
            this.providerTarballUrl,
            this.fetchTransportMetaJson,
            { paths },
          );
          let result = await tryCandidateUrls(entry, pathCandidates);
          // Path history can be nonempty yet still omit a pre-rename publish
          // commit — after path exhaustion, walk bounded full-repo history
          // skipping SHAs already tried for this entry (review R4-01).
          // Terminal path failures must NOT open repo fallback (R5-02).
          if (!result.activated && !result.terminal) {
            const repoCandidates = await resolveTransportCandidates(
              this.providerTarballUrl,
              this.fetchTransportMetaJson,
              { limit: MAX_HISTORY_CANDIDATES },
            );
            const deeper = await tryCandidateUrls(entry, repoCandidates);
            if (deeper.activated || deeper.terminal || deeper.lastErrors.length > 0) {
              result = deeper;
            }
          }
          if (!result.activated) {
            if (result.lastErrors.length > 0) {
              report.errors.push(...result.lastErrors);
            } else if (tipRetryableByType.has(entry.providerType)) {
              report.errors.push(tipRetryableByType.get(entry.providerType)!);
            }
          }
        }
      }
    } finally {
      releaseArchiveCache();
    }
    // Expose peak for targeted tests without widening the public report type.
    (report as ChannelSyncReport & { _peakRetainedArchives?: number })._peakRetainedArchives =
      peakRetainedArchives;

    // 6. N=2 retention + crash-orphan cleanup.
    try {
      this.store.gc({ retainDigests: options.retainDigests });
    } catch (e: any) {
      this.log(`gc failed (non-fatal): ${e?.message || e}`);
    }

    if (report.activated.length > 0) {
      report.status = 'activated';
    } else if (report.errors.length > 0) {
      report.status = 'error';
    }
    return report;
  }

  /**
   * Verify + activate a single entry. Returns null on success, or the typed
   * per-entry error. The previous activation is never modified here — the
   * store's activate() is the only mutation and it runs after verification.
   */
  private async tryActivateOne(
    channel: ProviderChannel,
    entry: ActivatableEntry,
    repoRoot: string,
    gate: ActivationGate | undefined,
  ): Promise<ChannelSyncError | { blocked: ActivationBlock } | null> {
    const artifactDir = locateArtifactDir(repoRoot, entry);
    if (!artifactDir) {
      return {
        code: 'ENTRY_ARTIFACT_NOT_FOUND',
        message: `no artifact directory for "${entry.providerType}" (category ${entry.category}) in the downloaded transport`,
        providerType: entry.providerType,
      };
    }

    // Move the artifact subtree into an object-staging dir whose layout
    // mirrors the repo root (<category>/<dirname>/…), so the tree digest is
    // computed over repo-root-relative paths exactly as specified.
    // Lease/mkdir failures are typed — never reject the whole sync (R3-03).
    let objStaging: string;
    try {
      objStaging = this.store.createStagingDir(`obj-${entry.providerType}`);
    } catch (e: any) {
      return {
        code: 'TRANSPORT_FAILED',
        message: `failed to create object staging: ${e?.message || e}`,
        providerType: entry.providerType,
      };
    }
    try {
      fs.mkdirSync(path.join(objStaging, entry.category), { recursive: true });
      fs.renameSync(artifactDir, path.join(objStaging, entry.category, path.basename(artifactDir)));
    } catch (e: any) {
      this.store.removeStagingDir(objStaging);
      return { code: 'TRANSPORT_FAILED', message: `failed to stage artifact tree: ${e?.message || e}`, providerType: entry.providerType };
    }

    let digest: string;
    try {
      digest = computeProviderTreeDigest(objStaging, entry.providerType);
    } catch (e: any) {
      this.store.removeStagingDir(objStaging);
      return toSyncError(e, 'ENTRY_TREE_INVALID', entry.providerType);
    }

    if (digest !== entry.bundleDigest) {
      this.store.removeStagingDir(objStaging);
      return {
        code: 'DIGEST_MISMATCH',
        message: `tree digest mismatch for "${entry.providerType}": channel=${entry.bundleDigest} recomputed=${digest} — refusing activation`,
        providerType: entry.providerType,
      };
    }

    // Post-verification gate: only now is the manifest trustworthy (its tree
    // matched the published digest). A block discards the staged object and
    // leaves the previous activation untouched.
    if (gate?.afterVerify) {
      const stagedDir = path.join(objStaging, entry.category, path.basename(artifactDir));
      let pointer: ReturnType<ProviderChannelStore['getPointer']> = null;
      try { pointer = this.store.getPointer(channel, entry.providerType); } catch { /* corrupt → treat as none */ }
      const blocked = gate.afterVerify(entry, { dir: stagedDir, manifest: readProviderManifest(stagedDir) }, pointer);
      if (blocked) {
        this.store.removeStagingDir(objStaging);
        this.log(`activation of ${entry.providerType}@${entry.providerVersion} blocked (${blocked.code}): ${blocked.reason}`);
        return { blocked };
      }
    }

    try {
      this.store.activate(channel, entry, objStaging);
      this.log(`verified + activated ${entry.providerType}@${entry.providerVersion} on channel ${channel}`);
      return null;
    } catch (e: any) {
      this.store.removeStagingDir(objStaging);
      return toSyncError(e, 'STORE_CORRUPT', entry.providerType);
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────

function toSyncError(e: any, fallbackCode: ProviderChannelErrorCode, providerType?: string): ChannelSyncError {
  if (e instanceof ProviderChannelError) {
    return { code: e.code, message: e.message, providerType: providerType ?? e.providerType };
  }
  return { code: fallbackCode, message: e?.message || String(e), providerType };
}

/** Tarballs of the provider repo contain a single top-level dir (`adhdev-providers-<ref>/`). */
function findTarballRepoRoot(extractDir: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(extractDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length !== 1) return null;
  return path.join(extractDir, dirs[0].name);
}

/**
 * Locate the artifact directory for a channel entry inside the extracted
 * repo: scan the entry's category dir for a subdirectory whose provider
 * manifest has a matching `type`. The directory name is NOT assumed to equal the provider type
 * (mirrors the Stage 1 generator's artifact indexing).
 */
export function locateArtifactDir(repoRoot: string, entry: Pick<ActivatableEntry, 'category' | 'providerType'>): string | null {
  const categoryDir = path.join(repoRoot, entry.category);
  let candidates: fs.Dirent[];
  try {
    candidates = fs.readdirSync(categoryDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const candidate of candidates) {
    if (!candidate.isDirectory()) continue;
    if (candidate.name.startsWith('_') || candidate.name.startsWith('.')) continue;
    const dir = path.join(categoryDir, candidate.name);
    for (const manifestName of ['provider.v1.json', 'provider.json']) {
      const manifestPath = path.join(dir, manifestName);
      try {
        if (!fs.existsSync(manifestPath)) continue;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        if (manifest?.type === entry.providerType) return dir;
        break; // manifest exists but is a different provider — next candidate
      } catch {
        break; // unreadable manifest — next candidate
      }
    }
  }
  return null;
}

/**
 * Compute the sync target set: providers the user installed into .upstream
 * (via the dashboard install flow) plus everything already activated on this
 * channel (so activated providers keep receiving verified updates).
 */
export function collectSyncTargetTypes(
  upstreamDir: string,
  store: ProviderChannelStore,
  channel: ProviderChannel,
): Set<string> {
  const targets = new Set<string>();
  const { pointers } = store.listPointers(channel);
  for (const type of pointers.keys()) targets.add(type);

  const scan = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const manifest = entries.find((e) => e.isFile() && (e.name === 'provider.v1.json' || e.name === 'provider.json'));
    if (manifest) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, manifest.name), 'utf-8'));
        if (typeof parsed?.type === 'string' && parsed.type.trim()) targets.add(parsed.type);
      } catch { /* ignore unreadable manifests */ }
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      scan(path.join(dir, entry.name));
    }
  };
  scan(upstreamDir);
  return targets;
}

// ─── Default I/O (no new dependencies beyond tar-fs — same style as the existing loader) ─

/**
 * Compact PATH diagnostic for transport-failure logs. The daemon process once
 * diverged from the login shell on Windows (System32 missing from
 * process.env.PATH even though the user shell had it, so spawned `tar.exe`
 * was not found), and the daemon never logged its own PATH — leaving no way
 * to confirm that failure class from logs. The full PATH is intentionally NOT
 * logged (long, noisy, and carries user directory names); the entry count +
 * System32 presence answer the actual question if an external-command PATH
 * failure ever recurs.
 */
function pathEnvDiagnostic(): string {
  const raw = process.env.PATH ?? '';
  const entries = raw.split(path.delimiter).filter((e) => e.length > 0);
  const hasSystem32 = entries.some((e) => /system32$/i.test(e.replace(/[\\/]+$/, '')));
  return `platform=${process.platform} pathEntries=${entries.length} system32InPath=${hasSystem32}`;
}

function defaultFetchJson(url: string): Promise<any> {
  const https = require('https') as typeof import('https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'adhdev-daemon', Accept: 'application/json' }, timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('channel metadata request timeout')); });
  });
}

/**
 * Promote a completed partial download into the final path. Exported for
 * regression tests: failure cleanup must never delete a successful final file.
 */
export function promoteDownloadPartial(partialPath: string, destPath: string): void {
  fs.renameSync(partialPath, destPath);
}

/** Best-effort removal of a partial download; never touches `destPath`. */
export function discardDownloadPartial(partialPath: string): void {
  try {
    fs.rmSync(partialPath, { force: true });
  } catch { /* best-effort */ }
}

/**
 * Default provider-archive download (exported for mid-body disconnect tests).
 * Uses `stream/promises.pipeline` so premature response closure rejects.
 */
export function downloadProviderArchive(url: string, destPath: string): Promise<void> {
  const https = require('https') as typeof import('https');
  const http = require('http') as typeof import('http');
  const { pipeline } = require('stream/promises') as typeof import('stream/promises');
  return new Promise((resolve, reject) => {
    const doRequest = (reqUrl: string, redirectCount = 0) => {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'));
        return;
      }
      const mod = reqUrl.startsWith('https') ? https : http;
      const req = mod.get(reqUrl, { headers: { 'User-Agent': 'adhdev-daemon' }, timeout: 60000 }, (res) => {
        const code = res.statusCode ?? 0;
        if (code === 301 || code === 302 || code === 303 || code === 307 || code === 308) {
          const location = res.headers.location;
          res.resume();
          if (!location) {
            reject(new Error(`HTTP ${code} redirect without Location`));
            return;
          }
          doRequest(location, redirectCount + 1);
          return;
        }
        if (code !== 200) {
          res.resume();
          reject(new Error(`HTTP ${code}`));
          return;
        }
        // Parent must exist (staging can be wiped by a concurrent gc before
        // this runs — surface a clear error rather than createWriteStream ENOENT).
        try {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
        } catch (e: any) {
          res.resume();
          reject(e);
          return;
        }
        // Write to a sibling temp then rename. Use pipeline() so a mid-body
        // disconnect / source error rejects (res.pipe alone can hang the
        // promise and leave syncTail serialized forever — review R1-04).
        const partialPath = `${destPath}.${process.pid}.part`;
        const ws = fs.createWriteStream(partialPath);
        pipeline(res, ws)
          .then(() => {
            try {
              promoteDownloadPartial(partialPath, destPath);
              resolve();
            } catch (e: any) {
              discardDownloadPartial(partialPath);
              reject(e);
            }
          })
          .catch((e: any) => {
            discardDownloadPartial(partialPath);
            reject(e);
          });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
    };
    doRequest(url);
  });
}

async function defaultExtractTarball(tarPath: string, destDir: string): Promise<void> {
  // Node-native extraction (zlib gunzip + tar-fs) — no external `tar` binary.
  await extractTarballGz(tarPath, destDir);
}
