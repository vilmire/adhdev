/**
 * Shared fixtures/helpers for the verified provider channel tests.
 *
 * The runtime's transport is fully injectable, so tests never touch the
 * network: a fake tarball extraction copies a locally built "repo" tree into
 * the extraction dir under a single top-level folder (mirroring the
 * `adhdev-providers-<ref>/` shape of GitHub archive tarballs).
 */

import { afterEach } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { computeProviderTreeDigest, TREE_DIGEST_ALGORITHM } from '../../../src/providers/channel/tree-digest.js';
import type { ChannelEntry, ProviderChannel } from '../../../src/providers/channel/contract.js';
import { ProviderChannelStore } from '../../../src/providers/channel/store.js';
import { ProviderChannelRuntime } from '../../../src/providers/channel/runtime.js';

/**
 * Every directory this file's tests create via makeTmp() outlives the call
 * that made it (tests read/write into it across a whole `it()` body, and
 * some — buildObjectStaging()'s staging dir — outlive that too), so none of
 * them can be rm'd inline. Track every one here and sweep them in a single
 * afterEach below. Every test file that imports makeTmp/buildObjectStaging
 * from this module gets that afterEach registered automatically (a top-level
 * vitest hook call attaches to whichever suite is currently running), so
 * individual test files don't need their own matching cleanup — this
 * replaces the per-file `rmSync(tmpRoot, ...)` afterEach pattern some test
 * files still also do; running both is harmless (rmSync force:true no-ops on
 * an already-removed path).
 */
const trackedTmpDirs: string[] = [];

export function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trackedTmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (trackedTmpDirs.length > 0) {
    const dir = trackedTmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

export interface FixtureProviderSpec {
  category: string;
  /** On-disk directory name (NOT assumed to equal the provider type). */
  dirname: string;
  type: string;
  version?: string;
  /** Extra files below the provider dir, relative path → content. */
  files?: Record<string, string>;
  manifestExtra?: Record<string, unknown>;
}

/**
 * Build a fake provider repo tree: `<repoRoot>/<category>/<dirname>/…` with
 * a provider.json manifest. Returns repoRoot.
 */
export function buildRepoTree(repoRoot: string, specs: FixtureProviderSpec[]): string {
  for (const spec of specs) {
    const dir = join(repoRoot, spec.category, spec.dirname);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'provider.json'),
      JSON.stringify({
        type: spec.type,
        name: spec.manifestExtra?.name ?? `${spec.type} name`,
        category: spec.category,
        version: spec.version ?? '1.0.0',
        ...(spec.category === 'cli' ? { spawn: { command: spec.type } } : {}),
        ...(spec.manifestExtra ?? {}),
      }, null, 2),
      'utf-8',
    );
    for (const [rel, content] of Object.entries(spec.files ?? {})) {
      const filePath = join(dir, rel);
      mkdirSync(join(filePath, '..'), { recursive: true });
      writeFileSync(filePath, content, 'utf-8');
    }
  }
  return repoRoot;
}

/**
 * Compute the expected `adhdev-provider-tree-sha256-v1` digest for one
 * provider inside a repo tree, by mirroring `<category>/<dirname>` into a
 * clean root (the digest input is repo-root-relative paths).
 */
export function digestFor(repoRoot: string, category: string, dirname: string): string {
  const mirror = makeTmp('adhdev-channel-mirror-');
  try {
    mkdirSync(join(mirror, category), { recursive: true });
    cpSync(join(repoRoot, category, dirname), join(mirror, category, dirname), { recursive: true });
    return computeProviderTreeDigest(mirror);
  } finally {
    rmSync(mirror, { recursive: true, force: true });
  }
}

/** Registry row (rowToMeta) shape consumed by the runtime's metadata source. */
export function makeRegistryRow(
  spec: FixtureProviderSpec,
  bundleDigest: string | null,
  digestAlgorithm: string | null = TREE_DIGEST_ALGORITHM,
): Record<string, unknown> {
  return {
    type: spec.type,
    version: spec.version ?? '1.0.0',
    category: spec.category,
    bundleDigest,
    digestAlgorithm,
  };
}

export interface FakeMetadataSource {
  rows?: Array<Record<string, unknown>>;
  /** When set, the fetch throws this error (registry unavailable). */
  failure?: Error;
  /**
   * Top-level channel echo of the fake registry response.
   *   - undefined (default): echo the channel parsed from the request URL
   *     (a healthy channel-aware registry);
   *   - null: omit the echo entirely (legacy registry without the channel
   *     contract — the rc.21 prod payload shape);
   *   - string: force that echo value (mismatched-channel registry).
   */
  channelEcho?: string | null;
  /** Records every requested URL (channel fallthrough assertions). */
  requestedUrls: string[];
}

/** Build the fake registry response body honoring the channelEcho contract. */
export function fakeRegistryBody(metadata: FakeMetadataSource, url: string): Record<string, unknown> {
  const body: Record<string, unknown> = { providers: metadata.rows ?? [] };
  const echo = metadata.channelEcho === undefined
    ? new URL(url).searchParams.get('channel')
    : metadata.channelEcho;
  if (typeof echo === 'string') body.channel = echo;
  return body;
}

export function makeRuntime(options: {
  store: ProviderChannelStore;
  repoRoot: string;
  metadata: FakeMetadataSource;
  logFn?: (msg: string) => void;
}): ProviderChannelRuntime {
  const { store, repoRoot, metadata } = options;
  return new ProviderChannelRuntime({
    store,
    registryBaseUrl: 'https://registry.test/api/v1/registry',
    providerTarballUrl: 'https://tarball.test/providers.tar.gz',
    logFn: options.logFn,
    fetchJson: async (url: string) => {
      metadata.requestedUrls.push(url);
      if (metadata.failure) throw metadata.failure;
      return fakeRegistryBody(metadata, url);
    },
    downloadFile: async () => { /* transport bytes are irrelevant — extraction is faked below */ },
    extractTarball: async (_tarPath: string, destDir: string) => {
      const inner = join(destDir, 'adhdev-providers-test');
      mkdirSync(inner, { recursive: true });
      cpSync(repoRoot, inner, { recursive: true });
    },
  });
}

export function entryFromSpec(
  spec: FixtureProviderSpec,
  digest: string,
): ChannelEntry & { bundleDigest: string; digestAlgorithm: string } {
  return {
    providerType: spec.type,
    providerVersion: spec.version ?? '1.0.0',
    category: spec.category,
    bundleDigest: digest,
    digestAlgorithm: TREE_DIGEST_ALGORITHM,
  };
}

/**
 * Build a free-standing object-staging tree (`<dir>/<category>/<dirname>/…`)
 * and its digest — used to drive store.activate() directly.
 */
export function buildObjectStaging(spec: FixtureProviderSpec): { dir: string; digest: string } {
  const dir = makeTmp('adhdev-channel-objstage-');
  buildRepoTree(dir, [spec]);
  return { dir, digest: computeProviderTreeDigest(dir) };
}

export const STABLE: ProviderChannel = 'stable';
export const PREVIEW: ProviderChannel = 'preview';
