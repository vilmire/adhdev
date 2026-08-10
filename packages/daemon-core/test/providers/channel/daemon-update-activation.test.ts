/**
 * Daemon-update = provider activation (option C) and the read-only staleness
 * probe (option A) — owner decision 2026-08-10.
 *
 * Background (live 08-10 measurement): the verified-channel pin only advances
 * on explicit activation, so after a registry publish AND a full fleet
 * restart every pin still carried the 08-07 bootstrap timestamp — published
 * provider fixes never reached existing machines, and a type first published
 * after bootstrap (kimi) had no pin at all and was unreachable even by
 * activate_provider_updates (the sync target set is pins+installed).
 *
 * Contracts under test:
 *   C1. A successful verified sync stamps the running daemon version; a boot
 *       on the SAME version+channel is a no-op (zero network) — the pin
 *       design's network-free boot contract is preserved.
 *   C2. A boot on a DIFFERENT daemon version runs one full sync and advances
 *       stale pins.
 *   C3. Empty store → no-op (maybeFirstSyncVerifiedChannel owns bootstrap).
 *   C4. A FAILED sync does not advance the stamp — the next boot retries.
 *   C5. Without a known daemon version the ride-along never runs.
 *   A1. The staleness probe reports stale pins and never-installed new types
 *       from ONE listing request, without touching any pointer.
 *   A2. A probe transport failure keeps the previous snapshot's lists and
 *       records the error (fail-closed, badge never lies from one bad poll).
 *
 * All I/O is injected — no test touches the network.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ProviderLoader } from '../../../src/providers/provider-loader.js';
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

describe('daemon-update activation + staleness probe', () => {
  let tmpRoot = '';
  let configDirBefore: string | undefined;
  let envChannelBefore: string | undefined;
  let buildChannelBefore: string | undefined;
  let store: ProviderChannelStore;
  let repoRoot = '';
  let metadata: FakeMetadataSource;
  let fetchCount = 0;

  const SPECS: FixtureProviderSpec[] = [
    { category: 'cli', dirname: 'alpha-cli', type: 'alpha-cli', version: '1.0.0' },
    { category: 'cli', dirname: 'beta-cli', type: 'beta-cli', version: '1.0.0' },
  ];

  beforeEach(() => {
    tmpRoot = makeTmp('adhdev-update-activation-');
    configDirBefore = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = tmpRoot;
    envChannelBefore = process.env.ADHDEV_PROVIDER_CHANNEL;
    delete process.env.ADHDEV_PROVIDER_CHANNEL;
    buildChannelBefore = process.env.ADHDEV_BUILD_CHANNEL;
    delete process.env.ADHDEV_BUILD_CHANNEL;
    writeFileSync(join(tmpRoot, 'config.json'), JSON.stringify({ updateChannel: 'preview' }), 'utf-8');

    store = new ProviderChannelStore(ProviderChannelStore.defaultRoot());
    repoRoot = makeTmp('adhdev-update-activation-repo-');
    buildRepoTree(repoRoot, SPECS);
    metadata = {
      rows: SPECS.map((spec) => makeRegistryRow(spec, digestFor(repoRoot, spec.category, spec.dirname))),
      requestedUrls: [],
    };
    fetchCount = 0;
  });

  afterEach(() => {
    if (configDirBefore === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = configDirBefore;
    if (envChannelBefore === undefined) delete process.env.ADHDEV_PROVIDER_CHANNEL;
    else process.env.ADHDEV_PROVIDER_CHANNEL = envChannelBefore;
    if (buildChannelBefore === undefined) delete process.env.ADHDEV_BUILD_CHANNEL;
    else process.env.ADHDEV_BUILD_CHANNEL = buildChannelBefore;
    for (const dir of [tmpRoot, repoRoot]) {
      if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    tmpRoot = repoRoot = '';
  });

  function newLoader(daemonVersion?: string) {
    return new ProviderLoader({
      updateChannel: 'preview',
      channelStore: store,
      logFn: () => {},
      probeStarts: [join(tmpRoot, 'no-sibling-here')],
      ...(daemonVersion !== undefined ? { daemonVersion } : {}),
      channelSyncIO: {
        fetchJson: async (url: string) => {
          fetchCount += 1;
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

  const stampPath = () => join(tmpRoot, 'providers', '.channel-activation-stamp.json');

  /** Simulate a registry publish: bump one provider's version → new digest row. */
  function publishBump(type: string, version: string) {
    const spec = SPECS.find((s) => s.type === type)!;
    const bumped: FixtureProviderSpec = { ...spec, version };
    buildRepoTree(repoRoot, [bumped]); // overwrites the manifest with the new version
    metadata.rows = SPECS.map((s) => makeRegistryRow(
      s.type === type ? bumped : s,
      digestFor(repoRoot, s.category, s.dirname),
    ));
  }

  it('C1: a successful sync stamps the daemon version; same-version boots are network-free no-ops', async () => {
    const loader = newLoader('1.0.41');
    const bootstrap = await loader.maybeFirstSyncVerifiedChannel();
    expect(bootstrap?.status).toBe('activated');
    const stamp = JSON.parse(readFileSync(stampPath(), 'utf-8'));
    expect(stamp.daemonVersion).toBe('1.0.41');
    expect(stamp.channel).toBe('preview');

    const fetchesBefore = fetchCount;
    const sameVersionBoot = newLoader('1.0.41');
    expect(await sameVersionBoot.maybeSyncVerifiedChannelOnDaemonUpdate()).toBeNull();
    expect(fetchCount).toBe(fetchesBefore);
  });

  it('C2: a boot on a NEW daemon version runs one sync and advances stale pins', async () => {
    const loader = newLoader('1.0.41');
    await loader.maybeFirstSyncVerifiedChannel();
    publishBump('alpha-cli', '1.1.0'); // published while the fleet slept

    const upgradedBoot = newLoader('1.0.42');
    const report = await upgradedBoot.maybeSyncVerifiedChannelOnDaemonUpdate();
    expect(report?.status).toBe('activated');
    expect(report?.activated.map((a) => a.providerType)).toContain('alpha-cli');
    expect(upgradedBoot.listVerifiedChannelPins().get('alpha-cli')?.active?.providerVersion).toBe('1.1.0');
    expect(JSON.parse(readFileSync(stampPath(), 'utf-8')).daemonVersion).toBe('1.0.42');

    // And the version after that is again a no-op.
    const fetchesBefore = fetchCount;
    expect(await newLoader('1.0.42').maybeSyncVerifiedChannelOnDaemonUpdate()).toBeNull();
    expect(fetchCount).toBe(fetchesBefore);
  });

  it('C3: an empty store never rides the daemon update (bootstrap owns it)', async () => {
    const loader = newLoader('1.0.42');
    const fetchesBefore = fetchCount;
    expect(await loader.maybeSyncVerifiedChannelOnDaemonUpdate()).toBeNull();
    expect(fetchCount).toBe(fetchesBefore);
  });

  it('C4: a failed sync does not advance the stamp — the next boot retries', async () => {
    const loader = newLoader('1.0.41');
    await loader.maybeFirstSyncVerifiedChannel();

    metadata.failure = new Error('registry down');
    const failedBoot = newLoader('1.0.42');
    const report = await failedBoot.maybeSyncVerifiedChannelOnDaemonUpdate();
    expect(report?.status).toBe('error');
    expect(JSON.parse(readFileSync(stampPath(), 'utf-8')).daemonVersion).toBe('1.0.41');

    metadata.failure = undefined;
    const retryBoot = newLoader('1.0.42');
    const retry = await retryBoot.maybeSyncVerifiedChannelOnDaemonUpdate();
    expect(retry).not.toBeNull();
    expect(JSON.parse(readFileSync(stampPath(), 'utf-8')).daemonVersion).toBe('1.0.42');
  });

  it('C5: without a daemon version the ride-along never runs and syncs write no stamp', async () => {
    const loader = newLoader();
    await loader.maybeFirstSyncVerifiedChannel();
    expect(existsSync(stampPath())).toBe(false);
    expect(await loader.maybeSyncVerifiedChannelOnDaemonUpdate()).toBeNull();
  });

  it('A1: the probe reports stale pins and never-installed new types without touching pointers', async () => {
    const loader = newLoader('1.0.41');
    await loader.maybeFirstSyncVerifiedChannel();

    // Everything current → clean snapshot.
    let snap = await loader.checkVerifiedChannelStaleness();
    expect(snap.staleTypes).toEqual([]);
    expect(snap.newTypes).toEqual([]);
    expect(snap.error).toBeUndefined();

    // A publish moves alpha past the pin, and a brand-new type appears on the
    // channel (the kimi class: published after bootstrap, no pin, not installed).
    publishBump('alpha-cli', '1.1.0');
    const newcomer: FixtureProviderSpec = { category: 'cli', dirname: 'gamma-cli', type: 'gamma-cli', version: '1.0.0' };
    buildRepoTree(repoRoot, [newcomer]);
    metadata.rows = [...metadata.rows!, makeRegistryRow(newcomer, digestFor(repoRoot, 'cli', 'gamma-cli'))];

    const pinBefore = loader.listVerifiedChannelPins().get('alpha-cli')?.active?.digest;
    snap = await loader.checkVerifiedChannelStaleness();
    expect(snap.staleTypes).toEqual(['alpha-cli']);
    expect(snap.newTypes).toEqual(['gamma-cli']);
    // Read-only: the stale pin did NOT move.
    expect(loader.listVerifiedChannelPins().get('alpha-cli')?.active?.digest).toBe(pinBefore);
    expect(loader.getChannelStalenessSnapshot()).toBe(snap);
  });

  it('A3: extraTargetTypes installs a NEVER-activated channel type (the kimi class)', async () => {
    const loader = newLoader('1.0.41');
    await loader.maybeFirstSyncVerifiedChannel();

    // A new type is published to the channel after this machine bootstrapped:
    // no pin, nothing in .upstream — the default target set can never reach it.
    const newcomer: FixtureProviderSpec = { category: 'cli', dirname: 'gamma-cli', type: 'gamma-cli', version: '1.0.0' };
    buildRepoTree(repoRoot, [newcomer]);
    metadata.rows = [...metadata.rows!, makeRegistryRow(newcomer, digestFor(repoRoot, 'cli', 'gamma-cli'))];

    // A plain sync (no extras) must NOT pick it up — that is the design.
    await loader.syncVerifiedChannel();
    expect(loader.listVerifiedChannelPins().has('gamma-cli')).toBe(false);

    // The install path: union the type into the target set.
    const report = await loader.syncVerifiedChannel({ extraTargetTypes: ['gamma-cli'] });
    expect(report.activated.map((a) => a.providerType)).toContain('gamma-cli');
    expect(loader.listVerifiedChannelPins().get('gamma-cli')?.active?.providerVersion).toBe('1.0.0');
    // Once pinned, every FUTURE plain sync includes it — the pointer IS the intent record.
    publishBump('alpha-cli', '1.1.0');
    const later = await loader.syncVerifiedChannel();
    expect(later.status).not.toBe('error');
    expect(loader.listVerifiedChannelPins().has('gamma-cli')).toBe(true);
  });

  it('A4: activation self-heals the staleness snapshot (badge drops without a re-probe)', async () => {
    const loader = newLoader('1.0.41');
    await loader.maybeFirstSyncVerifiedChannel();
    publishBump('alpha-cli', '1.1.0');
    const newcomer: FixtureProviderSpec = { category: 'cli', dirname: 'gamma-cli', type: 'gamma-cli', version: '1.0.0' };
    buildRepoTree(repoRoot, [newcomer]);
    metadata.rows = [...metadata.rows!, makeRegistryRow(newcomer, digestFor(repoRoot, 'cli', 'gamma-cli'))];

    let snap = await loader.checkVerifiedChannelStaleness();
    expect(snap.staleTypes).toEqual(['alpha-cli']);
    expect(snap.newTypes).toEqual(['gamma-cli']);

    await loader.syncVerifiedChannel({ extraTargetTypes: ['gamma-cli'] });
    snap = loader.getChannelStalenessSnapshot()!;
    expect(snap.staleTypes).toEqual([]); // alpha advanced by the same sync
    expect(snap.newTypes).toEqual([]);   // gamma installed
  });

  it('A2: a probe transport failure keeps the previous lists and records the error', async () => {
    const loader = newLoader('1.0.41');
    await loader.maybeFirstSyncVerifiedChannel();
    publishBump('alpha-cli', '1.1.0');
    await loader.checkVerifiedChannelStaleness();

    metadata.failure = new Error('registry down');
    const snap = await loader.checkVerifiedChannelStaleness();
    expect(snap.error).toContain('registry down');
    expect(snap.staleTypes).toEqual(['alpha-cli']); // previous result preserved
  });
});
