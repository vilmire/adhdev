/**
 * rc.20 preview provider-channel activation gap — loader-level contract tests.
 *
 * Root cause: providerChannel defaulted to stable independently of the daemon
 * updateChannel, so a daemon upgraded to the preview release channel never
 * activated the immutable preview provider channel (M1/Linux sat at 0/51
 * while the operator's Mac, with an explicit providerChannel=preview, had
 * 51/51).
 *
 * Contract under test:
 *   1. Explicit providerChannel (config/env) always wins.
 *   2. Otherwise the provider channel derives from updateChannel
 *      (preview → preview, stable → stable) — stable stays byte-compatible.
 *   3. Every restart converges on boot; boot runs ONE bounded verified
 *      first-sync when the resolved channel store is empty and providers are
 *      installed (first sync → N, then idempotent 0, no status-path network).
 *   4. Fail-closed: registry outage preserves last-known-good pointers;
 *      legacy NULL-digest rows stay non-activatable.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ProviderLoader } from '../../../src/providers/provider-loader.js';
import { loadConfig, updateConfig } from '../../../src/config/config.js';
import { ProviderChannelStore } from '../../../src/providers/channel/store.js';
import {
  buildRepoTree,
  digestFor,
  makeRegistryRow,
  makeTmp,
  type FakeMetadataSource,
  type FixtureProviderSpec,
} from './helpers.js';

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

describe('Provider channel derivation (rc.20 gap)', () => {
  let tmpRoot = '';
  let configDirBefore: string | undefined;
  let envChannelBefore: string | undefined;

  beforeEach(() => {
    tmpRoot = makeTmp('adhdev-channel-derive-');
    configDirBefore = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = tmpRoot;
    envChannelBefore = process.env.ADHDEV_PROVIDER_CHANNEL;
    delete process.env.ADHDEV_PROVIDER_CHANNEL;
  });

  afterEach(() => {
    if (configDirBefore === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = configDirBefore;
    if (envChannelBefore === undefined) delete process.env.ADHDEV_PROVIDER_CHANNEL;
    else process.env.ADHDEV_PROVIDER_CHANNEL = envChannelBefore;
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
      channel: config.providerChannel,
      updateChannel: config.updateChannel,
      logFn: () => {},
      probeStarts: [join(tmpRoot, 'no-sibling-here')],
    });
  }

  it('fresh stable install derives the stable provider channel (byte-compatible)', () => {
    writeConfig({});
    expect(newBootLoader().channel).toBe('stable');
    writeConfig({ updateChannel: 'stable' });
    expect(newBootLoader().channel).toBe('stable');
  });

  it('fresh preview install derives the preview provider channel', () => {
    writeConfig({ updateChannel: 'preview' });
    expect(newBootLoader().channel).toBe('preview');
  });

  it('explicit providerChannel always wins over updateChannel', () => {
    writeConfig({ updateChannel: 'preview', providerChannel: 'stable' });
    expect(newBootLoader().channel).toBe('stable');
    writeConfig({ updateChannel: 'stable', providerChannel: 'preview' });
    expect(newBootLoader().channel).toBe('preview');
  });

  it('ADHDEV_PROVIDER_CHANNEL env always wins over updateChannel', () => {
    writeConfig({ updateChannel: 'stable' });
    process.env.ADHDEV_PROVIDER_CHANNEL = 'preview';
    expect(newBootLoader().channel).toBe('preview');
  });

  it('preview upgrade from stable: persisted updateChannel flips the derived channel on next boot', () => {
    writeConfig({ updateChannel: 'stable' });
    expect(newBootLoader().channel).toBe('stable');

    // What daemon_upgrade / `channel set preview` persist (they never write
    // providerChannel — no hidden mutation of the explicit override slot).
    updateConfig({ updateChannel: 'preview' } as any);

    const persisted = loadConfig();
    expect(persisted.updateChannel).toBe('preview');
    expect(persisted.providerChannel).toBeUndefined();
    expect(newBootLoader().channel).toBe('preview');
  });
});

describe('Verified channel first-sync (M1/Linux-like empty store)', () => {
  let tmpRoot = '';
  let configDirBefore: string | undefined;
  let envChannelBefore: string | undefined;
  let store: ProviderChannelStore;
  let upstreamDir = '';
  let specs: FixtureProviderSpec[];
  let repoRoot = '';
  let metadata: FakeMetadataSource;
  let fetchCount = 0;

  beforeEach(() => {
    tmpRoot = makeTmp('adhdev-channel-firstsync-');
    configDirBefore = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = tmpRoot;
    envChannelBefore = process.env.ADHDEV_PROVIDER_CHANNEL;
    delete process.env.ADHDEV_PROVIDER_CHANNEL;

    store = new ProviderChannelStore(ProviderChannelStore.defaultRoot());
    upstreamDir = join(tmpRoot, 'providers', '.upstream');

    // M1/Linux-like state: updateChannel=preview, all providers installed via
    // onboarding into .upstream, verified store empty on both channels.
    writeFileSync(join(tmpRoot, 'config.json'), JSON.stringify({ updateChannel: 'preview' }), 'utf-8');
    specs = previewSpecs();
    for (const spec of specs) writeUpstreamProvider(upstreamDir, spec.category, spec.type);

    repoRoot = makeTmp('adhdev-channel-repo-');
    buildRepoTree(repoRoot, specs);
    metadata = {
      rows: specs.map((spec) => makeRegistryRow(spec, digestFor(repoRoot, spec.category, spec.dirname))),
      requestedUrls: [],
    };
    fetchCount = 0;
  });

  afterEach(() => {
    if (configDirBefore === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = configDirBefore;
    if (envChannelBefore === undefined) delete process.env.ADHDEV_PROVIDER_CHANNEL;
    else process.env.ADHDEV_PROVIDER_CHANNEL = envChannelBefore;
    for (const dir of [tmpRoot, repoRoot]) {
      if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    tmpRoot = repoRoot = upstreamDir = '';
  });

  function newPreviewLoader() {
    const config = loadConfig();
    return new ProviderLoader({
      channel: config.providerChannel,
      updateChannel: config.updateChannel,
      channelStore: store,
      logFn: () => {},
      probeStarts: [join(tmpRoot, 'no-sibling-here')],
      channelSyncIO: {
        fetchJson: async (url: string) => {
          fetchCount += 1;
          metadata.requestedUrls.push(url);
          if (metadata.failure) throw metadata.failure;
          return { providers: metadata.rows ?? [] };
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

  it('first sync activates 51/51 preview pointers, then is idempotent (0)', async () => {
    const loader = newPreviewLoader();
    expect(loader.channel).toBe('preview');
    expect(loader.countVerifiedChannelPointers()).toBe(0);

    const first = await loader.maybeFirstSyncVerifiedChannel();
    expect(first?.status).toBe('activated');
    expect(first?.activated).toHaveLength(PREVIEW_COUNT);
    expect(first?.errors).toHaveLength(0);
    expect(loader.countVerifiedChannelPointers()).toBe(PREVIEW_COUNT);
    // Only the preview channel was touched — stable stays empty (isolation).
    expect(store.listPointers('stable').pointers.size).toBe(0);
    // The registry was queried for the preview channel exactly.
    expect(metadata.requestedUrls.every((u) => u.includes('channel=preview'))).toBe(true);

    // Second boot: pointers exist → gate short-circuits, zero network calls.
    const fetchBefore = fetchCount;
    const second = await newPreviewLoader().maybeFirstSyncVerifiedChannel();
    expect(second).toBeNull();
    expect(fetchCount).toBe(fetchBefore);

    // Even a forced manual sync is a no-op diff.
    const manual = await newPreviewLoader().syncVerifiedChannel();
    expect(manual.status).toBe('up-to-date');
    expect(manual.activated).toHaveLength(0);
  });

  it('skips the first-sync gate when no providers are installed (no network)', async () => {
    rmSync(upstreamDir, { recursive: true, force: true });
    const loader = newPreviewLoader();
    expect(await loader.maybeFirstSyncVerifiedChannel()).toBeNull();
    expect(fetchCount).toBe(0);
  });

  it('registry outage fails closed and preserves last-known-good pointers', async () => {
    const loader = newPreviewLoader();
    await loader.maybeFirstSyncVerifiedChannel();
    expect(loader.countVerifiedChannelPointers()).toBe(PREVIEW_COUNT);

    metadata.failure = new Error('registry unreachable');
    const report = await loader.syncVerifiedChannel();
    expect(report.status).toBe('error');
    expect(report.errors[0].code).toBe('CHANNEL_METADATA_UNAVAILABLE');
    // LKG: all 51 pointers and their objects still load.
    expect(loader.countVerifiedChannelPointers()).toBe(PREVIEW_COUNT);
    expect(store.listActiveActivations('preview').activations).toHaveLength(PREVIEW_COUNT);
    expect(loader.getMeta('p0-cli')).toBeDefined();
  });

  it('registry outage on a truly empty store activates nothing and stays retryable', async () => {
    metadata.failure = new Error('registry unreachable');
    const loader = newPreviewLoader();
    const report = await loader.maybeFirstSyncVerifiedChannel();
    expect(report?.status).toBe('error');
    expect(loader.countVerifiedChannelPointers()).toBe(0);

    metadata.failure = undefined;
    const retry = await loader.maybeFirstSyncVerifiedChannel();
    expect(retry?.status).toBe('activated');
    expect(loader.countVerifiedChannelPointers()).toBe(PREVIEW_COUNT);
  });

  it('stable channel skips legacy NULL-digest rows (never auto-activated)', async () => {
    writeFileSync(join(tmpRoot, 'config.json'), JSON.stringify({ updateChannel: 'stable' }), 'utf-8');
    metadata.rows = specs.map((spec) => makeRegistryRow(spec, null, 'legacy-unverified'));
    const loader = newPreviewLoader();
    expect(loader.channel).toBe('stable');

    const report = await loader.maybeFirstSyncVerifiedChannel();
    expect(report?.activated).toHaveLength(0);
    expect(report?.skipped).toHaveLength(PREVIEW_COUNT);
    expect(report?.skipped.every((s) => s.code === 'ENTRY_NON_ACTIVATABLE')).toBe(true);
    expect(loader.countVerifiedChannelPointers()).toBe(0);
  });

  it('config-dir isolation: a second instance dir has its own empty store', async () => {
    const loader = newPreviewLoader();
    await loader.maybeFirstSyncVerifiedChannel();
    expect(loader.countVerifiedChannelPointers()).toBe(PREVIEW_COUNT);

    // Restart-like isolation: same daemon identity, different config dir
    // (e.g. ~/.adhdev vs ~/.adhdev-preview) → disjoint stores.
    const otherRoot = makeTmp('adhdev-channel-other-');
    const before = process.env.ADHDEV_CONFIG_DIR;
    try {
      process.env.ADHDEV_CONFIG_DIR = otherRoot;
      writeFileSync(join(otherRoot, 'config.json'), JSON.stringify({ updateChannel: 'preview' }), 'utf-8');
      const otherStore = new ProviderChannelStore(ProviderChannelStore.defaultRoot());
      expect(otherStore.rootDir).not.toBe(store.rootDir);
      expect(otherStore.listPointers('preview').pointers.size).toBe(0);
    } finally {
      process.env.ADHDEV_CONFIG_DIR = before;
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});
