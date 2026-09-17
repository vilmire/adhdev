import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ProviderLoader } from '../../../src/providers/provider-loader.js';
import { loadConfig, getConfigDir } from '../../../src/config/config.js';
import { resolveProviderChannel } from '../../../src/providers/channel/contract.js';
import { ProviderChannelStore } from '../../../src/providers/channel/store.js';
import { TREE_DIGEST_ALGORITHM } from '../../../src/providers/channel/tree-digest.js';
import { buildObjectStaging, makeTmp } from './helpers.js';

function writeUpstreamProvider(upstreamDir: string, category: string, type: string, name: string) {
  const dir = join(upstreamDir, category, type);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'provider.json'),
    JSON.stringify({ type, name, category, spawn: { command: type } }, null, 2),
    'utf-8',
  );
}

function activateVerified(store: ProviderChannelStore, type: string, name: string) {
  const { dir, digest } = buildObjectStaging({
    category: 'cli',
    dirname: type,
    type,
    manifestExtra: { name },
  });
  store.activate('stable', {
    providerType: type,
    providerVersion: '1.0.0',
    category: 'cli',
    bundleDigest: digest,
    digestAlgorithm: TREE_DIGEST_ALGORITHM,
  }, dir);
  return digest;
}

describe('Verified channel layer — loader integration', () => {
  let tmpRoot = '';
  let configDirBefore: string | undefined;
  let store: ProviderChannelStore;
  let upstreamDir = '';
  let userDir = '';
  let logs: string[];

  beforeEach(() => {
    tmpRoot = makeTmp('adhdev-channel-loader-');
    configDirBefore = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = tmpRoot;
    store = new ProviderChannelStore(ProviderChannelStore.defaultRoot());
    upstreamDir = join(tmpRoot, 'providers', '.upstream');
    userDir = join(tmpRoot, 'providers');
    logs = [];
    mkdirSync(upstreamDir, { recursive: true });
  });

  afterEach(() => {
    if (configDirBefore === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = configDirBefore;
    if (tmpRoot && existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = upstreamDir = userDir = '';
  });

  function newLoader(extra?: ConstructorParameters<typeof ProviderLoader>[0]) {
    // probeStarts pointed at an empty dir: never adopt a real sibling checkout.
    return new ProviderLoader({
      channelStore: store,
      logFn: (msg) => logs.push(msg),
      probeStarts: [join(tmpRoot, 'no-sibling-here')],
      ...extra,
    });
  }

  it('loads verified channel activations and lets them win over legacy .upstream installs', () => {
    writeUpstreamProvider(upstreamDir, 'cli', 'x-cli', 'legacy upstream x-cli');
    const digest = activateVerified(store, 'x-cli', 'verified x-cli');

    const loader = newLoader();
    loader.loadAll();

    const meta = loader.getMeta('x-cli') as any;
    expect(meta?.name).toBe('verified x-cli');
    // The script-lookup roots prefer the verified object dir over .upstream
    // (store objects are verified upstream content, not user overrides).
    const roots = loader.getProviderRoots();
    expect(roots.some((r) => r.includes('.store'))).toBe(true);
    expect(roots.indexOf(store.getObjectDir(digest))).toBeLessThan(roots.indexOf(upstreamDir));
  });

  it('still lets user customs outrank verified channel activations', () => {
    activateVerified(store, 'x-cli', 'verified x-cli');
    writeUpstreamProvider(userDir, 'cli', 'x-cli', 'user custom x-cli');

    const loader = newLoader();
    loader.loadAll();

    const meta = loader.getMeta('x-cli') as any;
    expect(meta?.name).toBe('user custom x-cli');
  });

  it('never scans the .store directory as user providers', () => {
    activateVerified(store, 'x-cli', 'verified x-cli');
    const loader = newLoader();
    loader.loadAll();
    // Exactly one provider — the dot-prefixed .store tree under the user dir
    // must not be picked up as an extra user layer.
    expect(loader.getAll().filter((p) => p.type === 'x-cli')).toHaveLength(1);
    expect(logs.some((l) => l.includes('verified channel providers'))).toBe(true);
  });

  it('locates lazy script dirs via the verified object root (spec providers)', () => {
    activateVerified(store, 'x-cli', 'verified x-cli');
    const loader = newLoader();
    loader.loadAll();
    const dir = loader.findProviderDir('x-cli');
    expect(dir).toContain('.store');
  });

  it('uses the config-dir abstraction for the default store root', () => {
    expect(ProviderChannelStore.defaultRoot()).toBe(join(tmpRoot, 'providers', '.store'));
  });
});

describe('Channel policy — sibling checkout adoption', () => {
  let tmpRoot = '';
  let projectDir = '';
  let siblingDir = '';
  let overrideBefore: string | undefined;

  beforeEach(() => {
    tmpRoot = makeTmp('adhdev-channel-sibling-');
    projectDir = join(tmpRoot, 'project');
    siblingDir = join(tmpRoot, 'adhdev-providers');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(siblingDir, 'cli'), { recursive: true });
    writeFileSync(join(siblingDir, '.adhdev-provider-root'), '', 'utf-8');
    // The suite-wide setup (test/helpers/setup-env.ts) turns on the
    // verification-path sibling override so the gate loads the repo's real
    // provider specs. This describe block asserts the PRODUCTION policy, so it
    // must observe the un-overridden behavior — clear it here.
    overrideBefore = process.env.ADHDEV_ALLOW_SIBLING_PROVIDERS_ON_STABLE;
    delete process.env.ADHDEV_ALLOW_SIBLING_PROVIDERS_ON_STABLE;
  });

  afterEach(() => {
    if (overrideBefore === undefined) delete process.env.ADHDEV_ALLOW_SIBLING_PROVIDERS_ON_STABLE;
    else process.env.ADHDEV_ALLOW_SIBLING_PROVIDERS_ON_STABLE = overrideBefore;
    if (tmpRoot && existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = projectDir = siblingDir = '';
  });

  it('stable runtime refuses sibling adoption even with the .adhdev-provider-root marker', () => {
    const logs: string[] = [];
    // The refusal notice is deduped per sibling path per process (static guard).
    // This sibling dir is a fresh tmp path per run, so the notice is always
    // first-seen here and the log assertion below stays meaningful.
    const loader = new ProviderLoader({
      probeStarts: [projectDir],
      channel: 'stable',
      logFn: (m) => logs.push(m),
    });

    expect(loader.getUserDir()).toBe(join(getConfigDir(), 'providers'));
    expect(loader.getSourceConfig().userDirSource).toBe('home-default');
    expect(logs.some((l) => l.includes('Refusing sibling provider checkout'))).toBe(true);
  });

  it('non-stable development channel adopts the sibling checkout with the explicit marker opt-in', () => {
    const loader = new ProviderLoader({ probeStarts: [projectDir], channel: 'preview' });

    expect(loader.getUserDir()).toBe(siblingDir);
    expect(loader.getSourceConfig().userDirSource).toBe('sibling-marker');
  });
});

describe('Channel contract — standalone/cloud boot caller parity', () => {
  let tmpRoot = '';
  let configDirBefore: string | undefined;

  beforeEach(() => {
    tmpRoot = makeTmp('adhdev-channel-boot-');
    configDirBefore = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = tmpRoot;
  });

  afterEach(() => {
    if (configDirBefore === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = configDirBefore;
    if (tmpRoot && existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = '';
  });

  it('resolves the same channel for the config plumbing both boot callers use', () => {
    // Both boot paths (daemon-lifecycle for standalone + cloud daemon, and
    // the daemon-cloud CLI provider-loader-factory) construct the loader as
    // `new ProviderLoader({ channel: config.providerChannel, ... })` from the
    // same loadConfig() — assert that contract end-to-end.
    for (const configured of [undefined, 'stable', 'preview', 'garbage']) {
      writeFileSync(
        join(tmpRoot, 'config.json'),
        JSON.stringify(configured === undefined ? {} : { providerChannel: configured }),
        'utf-8',
      );
      const config = loadConfig();
      const standaloneStyle = new ProviderLoader({
        channel: config.providerChannel,
        logFn: () => {},
        probeStarts: [join(tmpRoot, 'no-sibling-here')],
      });
      const cloudCliStyle = new ProviderLoader({
        channel: config.providerChannel,
        logFn: () => {},
        probeStarts: [join(tmpRoot, 'no-sibling-here')],
      });
      expect(standaloneStyle.channel).toBe(resolveProviderChannel(configured));
      expect(cloudCliStyle.channel).toBe(standaloneStyle.channel);
      expect(standaloneStyle.channel).toBe(configured === 'preview' ? 'preview' : 'stable');
    }
  });

});

// ★STORE-RELOAD (2026-09-17 cursor incident).
//
// `ProviderChannelStore.activate()` is a pure pointer flip with no callback
// into the loader, and the only reload-on-activation lives in the loader's own
// `syncVerifiedChannel()`. So an activation performed by ANOTHER process — the
// `provider publish/activate` CLI, a second daemon, a dashboard-driven flip —
// left a running daemon serving its boot-time map indefinitely.
//
// Measured: daemon booted 06:06 with cursor-cli v1.0.5 (its own boot sync
// having failed with CHANNEL_METADATA_UNAVAILABLE); v1.0.6 activated 07:11 by
// a separate process; a worker launched 07:19 still received 1.0.5 — which
// declares no delegatedWorkerIsolation, so `--approve-mcps` was never applied.
//
// These tests assert the OUTCOME (the loader serves the new bundle), not that
// a particular function was called.
describe('★out-of-process channel activation is picked up by a running loader', () => {
  let tmpRoot = '';
  let configDirBefore: string | undefined;
  let store: ProviderChannelStore;
  let logs: string[];

  beforeEach(() => {
    tmpRoot = makeTmp('adhdev-store-reload-');
    configDirBefore = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = tmpRoot;
    store = new ProviderChannelStore(ProviderChannelStore.defaultRoot());
    logs = [];
    mkdirSync(join(tmpRoot, 'providers', '.upstream'), { recursive: true });
  });

  afterEach(() => {
    if (configDirBefore === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = configDirBefore;
    tmpRoot = '';
  });

  function newLoader() {
    return new ProviderLoader({
      channelStore: store,
      logFn: (msg) => logs.push(msg),
      probeStarts: [join(tmpRoot, 'no-sibling-here')],
    });
  }

  /**
   * Activate through a SECOND store instance pointed at the same root — the
   * faithful model of the incident. The publishing CLI is a different process
   * with its own store object; the running daemon's loader holds a different
   * one and is never told.
   */
  function activateOutOfProcess(type: string, name: string, version: string) {
    const other = new ProviderChannelStore(ProviderChannelStore.defaultRoot());
    const { dir, digest } = buildObjectStaging({
      category: 'cli',
      dirname: type,
      type,
      manifestExtra: { name },
    });
    other.activate('stable', {
      providerType: type,
      providerVersion: version,
      category: 'cli',
      bundleDigest: digest,
      digestAlgorithm: TREE_DIGEST_ALGORITHM,
    }, dir);
    return digest;
  }

  it('★serves the NEW bundle after an out-of-process activation (the incident, inverted)', () => {
    activateOutOfProcess('cursor-cli', 'cursor v1.0.5', '1.0.5');
    const loader = newLoader();
    loader.loadAll();
    expect((loader.getMeta('cursor-cli') as any)?.name).toBe('cursor v1.0.5');

    // Another process flips the pointer. The loader is not notified.
    activateOutOfProcess('cursor-cli', 'cursor v1.0.6', '1.0.6');

    // Before the fix this returned the stale 1.0.5 forever.
    const reloaded = loader.refreshIfChannelActivationChanged({ force: true });
    expect(reloaded).toBe(true);
    expect((loader.getMeta('cursor-cli') as any)?.name).toBe('cursor v1.0.6');
  });

  it('★picks up a provider type that did not exist in the map at boot', () => {
    // The kimi class: a type published after this daemon bootstrapped is in
    // neither the pins nor .upstream, so a stale map has no entry at all.
    const loader = newLoader();
    loader.loadAll();
    expect(loader.getMeta('late-cli')).toBeFalsy();

    activateOutOfProcess('late-cli', 'late arrival', '1.0.0');

    expect(loader.refreshIfChannelActivationChanged({ force: true })).toBe(true);
    expect((loader.getMeta('late-cli') as any)?.name).toBe('late arrival');
  });

  it('does not reload when nothing changed (no churn on an idle daemon)', () => {
    activateOutOfProcess('cursor-cli', 'cursor v1.0.5', '1.0.5');
    const loader = newLoader();
    loader.loadAll();

    expect(loader.refreshIfChannelActivationChanged({ force: true })).toBe(false);
    expect(loader.refreshIfChannelActivationChanged({ force: true })).toBe(false);
    expect((loader.getMeta('cursor-cli') as any)?.name).toBe('cursor v1.0.5');
  });

  it('★debounces: a burst of activations does not trigger a loadAll per launch', () => {
    // `publish-provider-channels --execute` flips the whole provider set (51
    // types as of 2026-08-10) in a tight loop. Without a floor, every launch
    // during that window re-walks and re-parses every provider dir on disk,
    // against a pointer set still being written.
    activateOutOfProcess('cursor-cli', 'cursor v1.0.5', '1.0.5');
    const loader = newLoader();
    loader.loadAll();

    let loadAllCount = 0;
    const realLoadAll = loader.loadAll.bind(loader);
    (loader as any).loadAll = () => { loadAllCount += 1; realLoadAll(); };

    // Simulate the burst: many activations, each followed by a launch-path check.
    for (let i = 0; i < 20; i += 1) {
      activateOutOfProcess('cursor-cli', `cursor burst ${i}`, `1.0.${i}`);
      loader.refreshIfChannelActivationChanged();
    }

    // The debounce window (5s) is far wider than this loop's wall-clock, so the
    // whole burst collapses to at most one reload — NOT one per activation.
    expect(loadAllCount).toBeLessThanOrEqual(1);

    // ...and the daemon is not left permanently stale: the next check past the
    // window still converges on the final bundle.
    expect(loader.refreshIfChannelActivationChanged({ force: true })).toBe(true);
    expect((loader.getMeta('cursor-cli') as any)?.name).toBe('cursor burst 19');
  });

  it('a self-performed load establishes the baseline without an extra reload', () => {
    // loadAll() stamps the signature itself, so the first check after a load
    // must be a no-op rather than an immediate second full rebuild.
    activateOutOfProcess('cursor-cli', 'cursor v1.0.5', '1.0.5');
    const loader = newLoader();
    loader.loadAll();
    expect(loader.refreshIfChannelActivationChanged({ force: true })).toBe(false);
  });
});
