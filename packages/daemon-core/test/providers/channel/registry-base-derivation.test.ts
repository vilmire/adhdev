/**
 * rc.21 preview registry-base derivation — live M1 canary reproduction.
 *
 * Live root cause: rc.21 correctly derived providerChannel=preview from
 * updateChannel=preview and fetched `?channel=preview&limit=100`, BUT the
 * registry base fell back to the hardcoded PRODUCTION registry
 * (`https://api.adhf.dev/api/v1/registry`) because config.registryUrl and
 * ADHDEV_REGISTRY_URL were absent — it never derived the registry host from
 * the resolved daemon serverUrl (`https://api-preview.adhf.dev`). Prod
 * ignores the channel param and returns legacy digest-less rows, so all 51
 * preview providers were ENTRY_NON_ACTIVATABLE while the direct preview API
 * was healthy (51/51 digest-bearing).
 *
 * Contract under test:
 *   1. No registry override → the registry base derives from the resolved
 *      daemon serverUrl (preview server → preview registry; stable server →
 *      byte-identical stable default; custom origin → custom registry).
 *   2. Explicit config.registryUrl / ADHDEV_REGISTRY_URL still win.
 *   3. Boot and CLI construction paths resolve the IDENTICAL registry base.
 *   4. Preview fail-closed: a registry response that omits the top-level
 *      channel echo or echoes a different channel is a typed
 *      CHANNEL_METADATA_MISMATCH — last-known-good pointers are preserved
 *      and legacy prod rows are never treated as preview. Stable keeps
 *      accepting legacy echo-less responses (backward compatibility).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ProviderLoader } from '../../../src/providers/provider-loader.js';
import { loadConfig } from '../../../src/config/config.js';
import { DEFAULT_REGISTRY_BASE_URL } from '../../../src/config/registry-resolver.js';
import { ProviderChannelStore } from '../../../src/providers/channel/store.js';
import {
  buildRepoTree,
  digestFor,
  fakeRegistryBody,
  makeRegistryRow,
  makeTmp,
  type FakeMetadataSource,
  type FixtureProviderSpec,
} from './helpers.js';

const PREVIEW_SERVER = 'https://api-preview.adhf.dev';
const PREVIEW_REGISTRY = 'https://api-preview.adhf.dev/api/v1/registry';
const PREVIEW_COUNT = 51;

function previewSpecs(): FixtureProviderSpec[] {
  return Array.from({ length: PREVIEW_COUNT }, (_, i) => ({
    category: 'cli',
    dirname: `p${i}-cli`,
    type: `p${i}-cli`,
    version: '1.0.0',
  }));
}

function writeUpstreamProvider(upstreamDir: string, category: string, type: string) {
  const dir = join(upstreamDir, category, type);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'provider.json'),
    JSON.stringify({ type, name: `${type} name`, category, spawn: { command: type } }, null, 2),
    'utf-8',
  );
}

describe('rc.21 registry base derivation from resolved serverUrl', () => {
  let tmpRoot = '';
  let configDirBefore: string | undefined;
  let envRegistryBefore: string | undefined;

  beforeEach(() => {
    tmpRoot = makeTmp('adhdev-rc21-base-');
    configDirBefore = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = tmpRoot;
    envRegistryBefore = process.env.ADHDEV_REGISTRY_URL;
    delete process.env.ADHDEV_REGISTRY_URL;
  });

  afterEach(() => {
    if (configDirBefore === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = configDirBefore;
    if (envRegistryBefore === undefined) delete process.env.ADHDEV_REGISTRY_URL;
    else process.env.ADHDEV_REGISTRY_URL = envRegistryBefore;
    if (tmpRoot && existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = '';
  });

  function writeConfig(config: Record<string, unknown>) {
    writeFileSync(join(tmpRoot, 'config.json'), JSON.stringify(config), 'utf-8');
  }

  // Mirrors the boot caller (boot/daemon-lifecycle.ts initDaemonComponents).
  function newBootLoader() {
    const config = loadConfig();
    return new ProviderLoader({
      registryUrl: config.registryUrl,
      serverUrl: config.serverUrl,
      channel: config.providerChannel,
      updateChannel: config.updateChannel,
      logFn: () => {},
      probeStarts: [join(tmpRoot, 'no-sibling-here')],
    });
  }

  // Mirrors the CLI caller (packages/daemon-cloud provider-loader-factory.ts).
  function newCliLoader() {
    const config = loadConfig();
    return new ProviderLoader({
      registryUrl: config.registryUrl,
      serverUrl: config.serverUrl,
      channel: config.providerChannel,
      updateChannel: config.updateChannel,
      logFn: () => {},
      probeStarts: [join(tmpRoot, 'no-sibling-here')],
    });
  }

  function registryBaseOf(loader: ProviderLoader): string {
    return (loader as unknown as { registryBaseUrl: string }).registryBaseUrl;
  }

  it('preview server + no registry override derives the preview registry base (live bug)', () => {
    writeConfig({ updateChannel: 'preview', serverUrl: PREVIEW_SERVER });
    const loader = newBootLoader();
    expect(loader.channel).toBe('preview');
    // Pre-fix this was the PRODUCTION default — preview daemons queried prod.
    expect(registryBaseOf(loader)).toBe(PREVIEW_REGISTRY);
    expect(registryBaseOf(loader)).not.toBe(DEFAULT_REGISTRY_BASE_URL);
  });

  it('stable server keeps the byte-identical stable default', () => {
    writeConfig({ updateChannel: 'stable', serverUrl: 'https://api.adhf.dev' });
    expect(registryBaseOf(newBootLoader())).toBe(DEFAULT_REGISTRY_BASE_URL);
    writeConfig({});
    expect(registryBaseOf(newBootLoader())).toBe(DEFAULT_REGISTRY_BASE_URL);
  });

  it('custom server origin derives a custom registry base (self-host)', () => {
    writeConfig({ serverUrl: 'https://adhdev.internal.example:8443' });
    expect(registryBaseOf(newBootLoader())).toBe(
      'https://adhdev.internal.example:8443/api/v1/registry',
    );
  });

  it('explicit config.registryUrl still wins over serverUrl derivation', () => {
    writeConfig({ serverUrl: PREVIEW_SERVER, registryUrl: 'https://registry.example.com/v1' });
    expect(registryBaseOf(newBootLoader())).toBe('https://registry.example.com/v1');
  });

  it('ADHDEV_REGISTRY_URL still wins over serverUrl derivation', () => {
    writeConfig({ serverUrl: PREVIEW_SERVER });
    process.env.ADHDEV_REGISTRY_URL = 'https://env-registry.example.com/v1';
    expect(registryBaseOf(newBootLoader())).toBe('https://env-registry.example.com/v1');
  });

  it('boot and CLI construction paths resolve the identical registry base', () => {
    writeConfig({ updateChannel: 'preview', serverUrl: PREVIEW_SERVER });
    expect(registryBaseOf(newBootLoader())).toBe(registryBaseOf(newCliLoader()));
    expect(registryBaseOf(newCliLoader())).toBe(PREVIEW_REGISTRY);
  });
});

describe('rc.21 preview sync against the derived registry base', () => {
  let tmpRoot = '';
  let configDirBefore: string | undefined;
  let envRegistryBefore: string | undefined;
  let store: ProviderChannelStore;
  let specs: FixtureProviderSpec[];
  let repoRoot = '';
  let metadata: FakeMetadataSource;

  beforeEach(() => {
    tmpRoot = makeTmp('adhdev-rc21-sync-');
    configDirBefore = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = tmpRoot;
    envRegistryBefore = process.env.ADHDEV_REGISTRY_URL;
    delete process.env.ADHDEV_REGISTRY_URL;

    store = new ProviderChannelStore(ProviderChannelStore.defaultRoot());
    const upstreamDir = join(tmpRoot, 'providers', '.upstream');

    // Live M1 state: preview daemon, preview serverUrl, no registry override,
    // all 51 providers installed via onboarding, verified store empty.
    writeFileSync(
      join(tmpRoot, 'config.json'),
      JSON.stringify({ updateChannel: 'preview', serverUrl: PREVIEW_SERVER }),
      'utf-8',
    );
    specs = previewSpecs();
    for (const spec of specs) writeUpstreamProvider(upstreamDir, spec.category, spec.type);

    repoRoot = makeTmp('adhdev-rc21-repo-');
    buildRepoTree(repoRoot, specs);
    metadata = {
      rows: specs.map((spec) => makeRegistryRow(spec, digestFor(repoRoot, spec.category, spec.dirname))),
      requestedUrls: [],
    };
  });

  afterEach(() => {
    if (configDirBefore === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = configDirBefore;
    if (envRegistryBefore === undefined) delete process.env.ADHDEV_REGISTRY_URL;
    else process.env.ADHDEV_REGISTRY_URL = envRegistryBefore;
    for (const dir of [tmpRoot, repoRoot]) {
      if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    tmpRoot = repoRoot = '';
  });

  function newPreviewLoader() {
    const config = loadConfig();
    return new ProviderLoader({
      registryUrl: config.registryUrl,
      serverUrl: config.serverUrl,
      channel: config.providerChannel,
      updateChannel: config.updateChannel,
      channelStore: store,
      logFn: () => {},
      probeStarts: [join(tmpRoot, 'no-sibling-here')],
      channelSyncIO: {
        fetchJson: async (url: string) => {
          metadata.requestedUrls.push(url);
          if (metadata.failure) throw metadata.failure;
          return fakeRegistryBody(metadata, url);
        },
        downloadFile: async () => {},
        extractTarball: async (_tarPath: string, destDir: string) => {
          const { cpSync, mkdirSync: mk } = await import('fs');
          const inner = join(destDir, 'adhdev-providers-test');
          mk(inner, { recursive: true });
          cpSync(repoRoot, inner, { recursive: true });
        },
      },
    });
  }

  it('preview server + no override queries the PREVIEW registry and activates 51/51', async () => {
    const loader = newPreviewLoader();
    const report = await loader.syncVerifiedChannel();

    // The request went to the preview registry derived from serverUrl — never prod.
    expect(metadata.requestedUrls).toHaveLength(1);
    expect(metadata.requestedUrls[0]).toBe(
      `${PREVIEW_REGISTRY}/providers?channel=preview&limit=100`,
    );
    expect(report.status).toBe('activated');
    expect(report.activated).toHaveLength(PREVIEW_COUNT);
    expect(report.skipped).toHaveLength(0);
    expect(report.errors).toHaveLength(0);
    expect(loader.countVerifiedChannelPointers()).toBe(PREVIEW_COUNT);
  });

  it('missing channel echo (legacy prod payload) fails closed and preserves LKG pointers', async () => {
    const loader = newPreviewLoader();
    await loader.syncVerifiedChannel();
    expect(loader.countVerifiedChannelPointers()).toBe(PREVIEW_COUNT);

    // Prod ignores ?channel=preview: no top-level echo, legacy digest-less rows.
    metadata.channelEcho = null;
    metadata.rows = specs.map((spec) => makeRegistryRow(spec, null, 'legacy-unverified'));
    metadata.requestedUrls.length = 0;

    const report = await loader.syncVerifiedChannel();
    expect(report.status).toBe('error');
    expect(report.errors[0].code).toBe('CHANNEL_METADATA_MISMATCH');
    // LKG: every pointer and object still loads; nothing was activated/dropped.
    expect(loader.countVerifiedChannelPointers()).toBe(PREVIEW_COUNT);
    expect(store.listActiveActivations('preview').activations).toHaveLength(PREVIEW_COUNT);
    expect(loader.getMeta('p0-cli')).toBeDefined();
  });

  it('mismatched channel echo fails closed and preserves LKG pointers', async () => {
    const loader = newPreviewLoader();
    await loader.syncVerifiedChannel();
    expect(loader.countVerifiedChannelPointers()).toBe(PREVIEW_COUNT);

    metadata.channelEcho = 'stable';
    const report = await loader.syncVerifiedChannel();
    expect(report.status).toBe('error');
    expect(report.errors[0].code).toBe('CHANNEL_METADATA_MISMATCH');
    expect(loader.countVerifiedChannelPointers()).toBe(PREVIEW_COUNT);
    expect(store.listActiveActivations('preview').activations).toHaveLength(PREVIEW_COUNT);
  });

  it('legacy rows without the channel contract are never treated as preview (empty store)', async () => {
    metadata.channelEcho = null;
    metadata.rows = specs.map((spec) => makeRegistryRow(spec, null, 'legacy-unverified'));
    const loader = newPreviewLoader();

    const report = await loader.syncVerifiedChannel();
    expect(report.status).toBe('error');
    expect(report.errors[0].code).toBe('CHANNEL_METADATA_MISMATCH');
    expect(report.activated).toHaveLength(0);
    expect(loader.countVerifiedChannelPointers()).toBe(0);
  });

  it('stable channel still accepts a legacy echo-less registry (backward compatible)', async () => {
    writeFileSync(
      join(tmpRoot, 'config.json'),
      JSON.stringify({ updateChannel: 'stable', serverUrl: 'https://api.adhf.dev' }),
      'utf-8',
    );
    // Legacy stable registry: digest-bearing rows but no channel echo contract.
    metadata.channelEcho = null;
    const loader = newPreviewLoader();
    expect(loader.channel).toBe('stable');
    expect(metadata.requestedUrls).toHaveLength(0);

    const report = await loader.syncVerifiedChannel();
    expect(metadata.requestedUrls[0]).toBe(
      `${DEFAULT_REGISTRY_BASE_URL}/providers?channel=stable&limit=100`,
    );
    expect(report.status).toBe('activated');
    expect(report.activated).toHaveLength(PREVIEW_COUNT);
    expect(loader.countVerifiedChannelPointers()).toBe(PREVIEW_COUNT);
  });
});
