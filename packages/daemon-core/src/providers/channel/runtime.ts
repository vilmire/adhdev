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
}

export interface ProviderChannelRuntimeOptions {
  store: ProviderChannelStore;
  registryBaseUrl: string;
  providerTarballUrl: string;
  logFn?: (msg: string) => void;
  /** Injectable HTTP JSON fetch (tests). Defaults to a minimal https.get wrapper. */
  fetchJson?: (url: string) => Promise<any>;
  /** Injectable file download (tests). Defaults to a redirect-following https wrapper. */
  downloadFile?: (url: string, destPath: string) => Promise<void>;
  /** Injectable tarball extraction (tests). Defaults to system `tar -xzf`. */
  extractTarball?: (tarPath: string, destDir: string) => Promise<void>;
}

const REGISTRY_LIST_LIMIT = 100;

export class ProviderChannelRuntime {
  private readonly store: ProviderChannelStore;
  private readonly registryBaseUrl: string;
  private readonly providerTarballUrl: string;
  private readonly logFn: (msg: string) => void;
  private readonly fetchJson: (url: string) => Promise<any>;
  private readonly downloadFile: (url: string, destPath: string) => Promise<void>;
  private readonly extractTarball: (tarPath: string, destDir: string) => Promise<void>;

  constructor(options: ProviderChannelRuntimeOptions) {
    this.store = options.store;
    this.registryBaseUrl = options.registryBaseUrl.replace(/\/+$/, '');
    this.providerTarballUrl = options.providerTarballUrl;
    this.logFn = options.logFn ?? (() => {});
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.downloadFile = options.downloadFile ?? defaultDownloadFile;
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
    try {
      body = await this.fetchJson(url);
    } catch (e: any) {
      throw new ProviderChannelError(
        'CHANNEL_METADATA_UNAVAILABLE',
        `channel metadata fetch failed for channel "${channel}": ${e?.message || e}`,
      );
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
      });
    }
    return entries;
  }

  /**
   * Sync the verified channel activations for `targetTypes`.
   *
   * Never throws for expected failure modes: every failure is reported as a
   * typed error in the returned report and the previous activations stay
   * live (last-known-good). Unexpected programming errors still throw.
   */
  async sync(options: { channel: ProviderChannel; targetTypes: ReadonlySet<string> }): Promise<ChannelSyncReport> {
    const { channel, targetTypes } = options;
    const report: ChannelSyncReport = {
      channel,
      status: 'up-to-date',
      activated: [],
      skipped: [],
      errors: [],
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
    const targets = activatable.filter((e) => targetTypes.has(e.providerType));

    // 3. Diff against active pointers.
    const pending: ActivatableEntry[] = [];
    for (const entry of targets) {
      let activeDigest: string | null = null;
      try {
        activeDigest = this.store.getPointer(channel, entry.providerType)?.active.digest ?? null;
      } catch (e: any) {
        // Corrupt pointer: record and treat as pending — a verified
        // re-activation atomically replaces the corrupt file.
        report.errors.push(toSyncError(e, 'STORE_CORRUPT', entry.providerType));
      }
      if (activeDigest !== entry.bundleDigest) pending.push(entry);
    }

    if (pending.length === 0) {
      return report;
    }

    // 4. Transport: download + extract the provider repo tarball into store
    //    staging. Failure → abort before activating anything (LKG).
    const stagingRoot = this.store.createStagingDir('sync');
    try {
      const tarPath = path.join(stagingRoot, 'providers.tar.gz');
      const extractDir = path.join(stagingRoot, 'repo');
      fs.mkdirSync(extractDir, { recursive: true });
      try {
        await this.downloadFile(this.providerTarballUrl, tarPath);
        await this.extractTarball(tarPath, extractDir);
      } catch (e: any) {
        report.errors.push({ code: 'TRANSPORT_FAILED', message: `provider tarball transport failed: ${e?.message || e}` });
        report.status = 'error';
        this.log(`sync aborted (TRANSPORT_FAILED): ${e?.message || e}`);
        return report;
      }

      const repoRoot = findTarballRepoRoot(extractDir);
      if (!repoRoot) {
        report.errors.push({ code: 'TRANSPORT_FAILED', message: 'provider tarball has an unexpected structure (no repo root dir)' });
        report.status = 'error';
        return report;
      }

      // 5. Per entry: locate → stage → verify digest → activate. Per-entry
      //    failures never affect other entries and never touch the previous
      //    activation.
      for (const entry of pending) {
        const error = await this.tryActivateOne(channel, entry, repoRoot, stagingRoot);
        if (error) {
          report.errors.push(error);
        } else {
          const pointer = this.store.getPointer(channel, entry.providerType);
          if (pointer) report.activated.push(pointer.active);
        }
      }
    } finally {
      this.store.removeStagingDir(stagingRoot);
    }

    // 6. N=2 retention + crash-orphan cleanup.
    try {
      this.store.gc();
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
    stagingRoot: string,
  ): Promise<ChannelSyncError | null> {
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
    const objStaging = this.store.createStagingDir(`obj-${entry.providerType}`);
    let relDir: string;
    try {
      relDir = path.relative(repoRoot, artifactDir).split(path.sep).join('/');
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
function locateArtifactDir(repoRoot: string, entry: ActivatableEntry): string | null {
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

// ─── Default I/O (no new dependencies — same style as the existing loader) ─

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

function defaultDownloadFile(url: string, destPath: string): Promise<void> {
  const https = require('https') as typeof import('https');
  const http = require('http') as typeof import('http');
  return new Promise((resolve, reject) => {
    const doRequest = (reqUrl: string, redirectCount = 0) => {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'));
        return;
      }
      const mod = reqUrl.startsWith('https') ? https : http;
      const req = mod.get(reqUrl, { headers: { 'User-Agent': 'adhdev-daemon' }, timeout: 60000 }, (res) => {
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

async function defaultExtractTarball(tarPath: string, destDir: string): Promise<void> {
  const { exec } = require('child_process') as typeof import('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  await execAsync(`tar -xzf "${tarPath}" -C "${destDir}"`, { timeout: 60000 });
}
