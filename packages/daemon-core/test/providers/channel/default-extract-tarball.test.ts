/**
 * Covers the Node-native default tarball extraction (`zlib` gunzip + `tar-fs`,
 * src/providers/extract-tarball.ts) that replaced the `exec("tar -xzf …")`
 * shell-out.
 *
 * Why this suite exists: production Windows daemons failed to spawn the
 * system tar.exe even when it existed on disk (daemon PATH lacked System32),
 * aborting every provider channel sync with TRANSPORT_FAILED on fresh
 * installs. These tests prove, without any network access:
 *
 *   1. The default extraction path works with no `tar` binary involved —
 *      the tarball is produced AND consumed purely in Node, and the runtime
 *      activates the verified provider end-to-end.
 *   2. Digest parity with the system `tar`: the same tarball extracted both
 *      ways yields identical file sets and identical
 *      `adhdev-provider-tree-sha256-v1` digests (the core safety proof that
 *      swapping the extractor does not weaken the verified-channel guarantee).
 *      Skipped only on machines without a system tar.
 *   3. Corrupt / empty tarballs fail closed with a typed TRANSPORT_FAILED,
 *      and the transport-failure log line carries the PATH diagnostic.
 *
 * The injectable `extractTarball` seam is intentionally NOT used here except
 * in the final override test — everything else exercises the real default.
 */

import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderChannelStore } from '../../../src/providers/channel/store.js';
import { ProviderChannelRuntime } from '../../../src/providers/channel/runtime.js';
import { computeProviderTreeDigest } from '../../../src/providers/channel/tree-digest.js';
import { extractTarballGz } from '../../../src/providers/extract-tarball.js';
import {
  buildRepoTree,
  digestFor,
  fakeRegistryBody,
  makeTmp,
  type FakeMetadataSource,
  type FixtureProviderSpec,
} from './helpers.js';

const require = createRequire(import.meta.url);
const tarFs = require('tar-fs') as { pack: (dir: string) => NodeJS.ReadableStream };

const CLI_X: FixtureProviderSpec = {
  category: 'cli',
  dirname: 'x-cli',
  type: 'x-cli',
  version: '1.0.0',
  files: {
    'scripts.js': 'module.exports = {};',
    'docs/guide.md': '# 가이드\n\nunicode content ✓\n',
    'deep/nested/dir/data.json': '{"ok":true}',
    'empty.txt': '',
  },
};

const hasSystemTar = (() => {
  try {
    execFileSync('tar', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Env for system-tar invocations: keep macOS bsdtar from adding AppleDouble (._*) entries. */
const SYSTEM_TAR_ENV = { ...process.env, COPYFILE_DISABLE: '1' };

/** Pack `srcDir` (contents at top level) into a .tar.gz — pure Node, no system tar. */
async function packTarGz(srcDir: string, destTar: string): Promise<void> {
  await pipeline(tarFs.pack(srcDir), zlib.createGzip(), fs.createWriteStream(destTar));
}

/** Recursively collect relative file paths of regular files below `dir`. */
function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

describe('default tarball extraction (Node-native, no system tar)', () => {
  let root = '';
  let store: ProviderChannelStore;
  let repoRoot = '';
  let tarSrcParent = '';
  let tarPath = '';

  beforeEach(async () => {
    root = makeTmp('adhdev-default-extract-');
    store = new ProviderChannelStore(path.join(root, '.store'));
    // Tarballs of the provider repo wrap everything in a single top-level
    // dir (`adhdev-providers-<ref>/`) — mirror that shape.
    tarSrcParent = path.join(root, 'tarsrc');
    repoRoot = path.join(tarSrcParent, 'adhdev-providers-test');
    buildRepoTree(repoRoot, [CLI_X]);
    tarPath = path.join(root, 'providers.tar.gz');
    await packTarGz(tarSrcParent, tarPath);
  });

  afterEach(() => {
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
    root = repoRoot = tarSrcParent = tarPath = '';
  });

  /** Runtime with metadata/download faked but the REAL default extraction. */
  function makeDefaultExtractRuntime(rows: Array<Record<string, unknown>>, logs: string[]): ProviderChannelRuntime {
    const metadata: FakeMetadataSource = { rows, requestedUrls: [] };
    return new ProviderChannelRuntime({
      store,
      registryBaseUrl: 'https://registry.test/api/v1/registry',
      providerTarballUrl: 'https://tarball.test/providers.tar.gz',
      logFn: (msg) => logs.push(msg),
      fetchJson: async (url: string) => {
        metadata.requestedUrls.push(url);
        return fakeRegistryBody(metadata, url);
      },
      downloadFile: async (_url: string, destPath: string) => {
        fs.copyFileSync(tarPath, destPath);
      },
      // extractTarball intentionally NOT injected — the default runs.
    });
  }

  it('extracts a real tar.gz with no system tar involved and activates end-to-end', async () => {
    const digest = digestFor(repoRoot, 'cli', 'x-cli');
    const logs: string[] = [];
    const runtime = makeDefaultExtractRuntime([
      { type: 'x-cli', version: '1.0.0', category: 'cli', bundleDigest: digest, digestAlgorithm: 'adhdev-provider-tree-sha256-v1' },
    ], logs);

    const report = await runtime.sync({ channel: 'stable', targetTypes: new Set(['x-cli']) });

    expect(report.status).toBe('activated');
    expect(report.errors).toHaveLength(0);
    expect(report.activated.map((a) => a.digest)).toEqual([digest]);

    // The activated tree is byte-identical to the source fixture tree.
    const objectDir = store.getObjectDir(digest);
    const srcDir = path.join(repoRoot, 'cli', 'x-cli');
    const activatedDir = path.join(objectDir, 'cli', 'x-cli');
    expect(listFiles(activatedDir)).toEqual(listFiles(srcDir));
    for (const rel of listFiles(srcDir)) {
      expect(fs.readFileSync(path.join(activatedDir, rel)).equals(fs.readFileSync(path.join(srcDir, rel)))).toBe(true);
    }
  });

  it.runIf(hasSystemTar)('produces the same file set and tree digest as the system tar extraction', async () => {
    const nodeOut = path.join(root, 'out-node');
    const sysOut = path.join(root, 'out-sys');
    fs.mkdirSync(nodeOut, { recursive: true });
    fs.mkdirSync(sysOut, { recursive: true });

    await extractTarballGz(tarPath, nodeOut);
    execFileSync('tar', ['-xzf', tarPath, '-C', sysOut], { env: SYSTEM_TAR_ENV });

    // Identical regular-file sets …
    expect(listFiles(nodeOut)).toEqual(listFiles(sysOut));
    // … with identical bytes …
    for (const rel of listFiles(sysOut)) {
      expect(fs.readFileSync(path.join(nodeOut, rel)).equals(fs.readFileSync(path.join(sysOut, rel)))).toBe(true);
    }
    // … and therefore identical verified-channel tree digests (the safety
    // proof: swapping the extractor cannot change what digest verification
    // accepts).
    expect(computeProviderTreeDigest(nodeOut)).toBe(computeProviderTreeDigest(sysOut));

    // Same tarball, created by the SYSTEM tar this time, extracted by the
    // Node path — digest must still match the pure-Node round-trip above.
    const sysMadeTar = path.join(root, 'providers-sys.tar.gz');
    execFileSync('tar', ['-czf', sysMadeTar, '-C', tarSrcParent, '.'], { env: SYSTEM_TAR_ENV });
    const sysMadeOut = path.join(root, 'out-sysmade');
    fs.mkdirSync(sysMadeOut, { recursive: true });
    await extractTarballGz(sysMadeTar, sysMadeOut);
    expect(computeProviderTreeDigest(sysMadeOut)).toBe(computeProviderTreeDigest(sysOut));
  });

  it('fails closed with TRANSPORT_FAILED on a corrupt tarball and logs the PATH diagnostic', async () => {
    fs.writeFileSync(tarPath, Buffer.from('this is definitely not a gzip stream'));
    const digest = digestFor(repoRoot, 'cli', 'x-cli');
    const logs: string[] = [];
    const runtime = makeDefaultExtractRuntime([
      { type: 'x-cli', version: '1.0.0', category: 'cli', bundleDigest: digest, digestAlgorithm: 'adhdev-provider-tree-sha256-v1' },
    ], logs);

    const report = await runtime.sync({ channel: 'stable', targetTypes: new Set(['x-cli']) });

    expect(report.status).toBe('error');
    expect(report.activated).toHaveLength(0);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].code).toBe('TRANSPORT_FAILED');
    expect(store.getPointer('stable', 'x-cli')).toBeNull();
    // The transport-failure log line carries the environment diagnostic.
    const abortLine = logs.find((l) => l.includes('TRANSPORT_FAILED'));
    expect(abortLine).toBeDefined();
    expect(abortLine).toContain(`platform=${process.platform}`);
    expect(abortLine).toMatch(/pathEntries=\d+/);
    expect(abortLine).toMatch(/system32InPath=(true|false)/);
  });

  it('fails closed with TRANSPORT_FAILED on an empty (valid) tarball', async () => {
    const emptySrc = path.join(root, 'emptysrc');
    fs.mkdirSync(emptySrc, { recursive: true });
    await packTarGz(emptySrc, tarPath); // valid gzip of an empty tar
    const digest = digestFor(repoRoot, 'cli', 'x-cli');
    const logs: string[] = [];
    const runtime = makeDefaultExtractRuntime([
      { type: 'x-cli', version: '1.0.0', category: 'cli', bundleDigest: digest, digestAlgorithm: 'adhdev-provider-tree-sha256-v1' },
    ], logs);

    const report = await runtime.sync({ channel: 'stable', targetTypes: new Set(['x-cli']) });

    expect(report.status).toBe('error');
    expect(report.activated).toHaveLength(0);
    expect(report.errors.some((e) => e.code === 'TRANSPORT_FAILED')).toBe(true);
    expect(store.getPointer('stable', 'x-cli')).toBeNull();
  });

  it('still honors an injected extractTarball override (test seam unchanged)', async () => {
    const digest = digestFor(repoRoot, 'cli', 'x-cli');
    const logs: string[] = [];
    let overrideCalls = 0;
    const metadata: FakeMetadataSource = {
      rows: [{ type: 'x-cli', version: '1.0.0', category: 'cli', bundleDigest: digest, digestAlgorithm: 'adhdev-provider-tree-sha256-v1' }],
      requestedUrls: [],
    };
    const runtime = new ProviderChannelRuntime({
      store,
      registryBaseUrl: 'https://registry.test/api/v1/registry',
      providerTarballUrl: 'https://tarball.test/providers.tar.gz',
      logFn: (msg) => logs.push(msg),
      fetchJson: async (url: string) => {
        metadata.requestedUrls.push(url);
        return fakeRegistryBody(metadata, url);
      },
      downloadFile: async () => { /* bytes irrelevant — extraction is overridden */ },
      extractTarball: async (_tarPath: string, destDir: string) => {
        overrideCalls += 1;
        fs.cpSync(tarSrcParent, destDir, { recursive: true });
      },
    });

    const report = await runtime.sync({ channel: 'stable', targetTypes: new Set(['x-cli']) });

    expect(overrideCalls).toBe(1);
    expect(report.status).toBe('activated');
    expect(report.errors).toHaveLength(0);
  });
});
