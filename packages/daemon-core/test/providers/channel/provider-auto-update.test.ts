/**
 * Periodic gated provider auto-update (owner decision 2026-10-10;
 * docs/design/2026-10-10-provider-auto-update.md).
 *
 * Live trigger (2026-10-10): antigravity-cli 1.2.18 was published AFTER the
 * preview fleet restarted into its new daemon version, so the daemon-update
 * ride-along had already run and no node picked it up until
 * activate_provider_updates was sent to each by hand.
 *
 * Contracts under test:
 *   U1. A periodic run activates a newer bundle of an already-pinned type and
 *       records it as auto-updated (from → to).
 *   U2. A type the machine never activated is never auto-installed.
 *   U3. minDaemonVersion above the running daemon → blocked with the reason,
 *       pin unchanged; the same verdict is cached (no re-download next run).
 *       The daemon gate also applies to an explicit activation.
 *   U4. CLI axis: a bundle with no spec for the installed CLI version is
 *       blocked; a matching CLI version activates; an UNKNOWN version passes.
 *   U5. Never a downgrade; never undo the user's rollback (until the channel
 *       moves past it).
 *   U6. A local override (user providers dir) is skipped.
 *   U7. Opt-out: disabled → probe only; config/env resolution.
 *   U8. Running sessions: objects this process loaded survive gc after two
 *       further activations of the same type.
 *   U9. The loop waits for the boot sync, then runs on a jittered schedule
 *       and re-reads the enabled flag every run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ProviderLoader } from '../../../src/providers/provider-loader.js';
import { ProviderChannelStore } from '../../../src/providers/channel/store.js';
import { resolveProviderAutoUpdate } from '../../../src/providers/channel/contract.js';
import {
  AUTO_UPDATE_FIRST_DELAY_MS,
  AUTO_UPDATE_FIRST_JITTER_MS,
  AUTO_UPDATE_INTERVAL_JITTER_MS,
  AUTO_UPDATE_INTERVAL_MS,
  startProviderAutoUpdateLoop,
} from '../../../src/providers/provider-auto-update-loop.js';
import type { VersionArchive } from '../../../src/providers/version-archive.js';
import {
  buildRepoTree,
  digestFor,
  fakeRegistryBody,
  makeRegistryRow,
  makeTmp,
  type FakeMetadataSource,
  type FixtureProviderSpec,
} from './helpers.js';

const SPEC_V1 = JSON.stringify({ id: 'alpha-cli', name: 'Alpha', states: [] });

describe('provider auto-update (gated)', () => {
  let tmpRoot = '';
  let saved: Record<string, string | undefined> = {};
  let store: ProviderChannelStore;
  let repoRoot = '';
  let metadata: FakeMetadataSource;
  let downloads = 0;
  let specs: FixtureProviderSpec[];
  let cliVersions: Record<string, string | null>;

  const ENV_KEYS = ['ADHDEV_CONFIG_DIR', 'ADHDEV_PROVIDER_CHANNEL', 'ADHDEV_BUILD_CHANNEL', 'ADHDEV_PROVIDER_AUTO_UPDATE'];

  beforeEach(() => {
    tmpRoot = makeTmp('adhdev-auto-update-');
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.ADHDEV_CONFIG_DIR = tmpRoot;
    for (const k of ENV_KEYS.slice(1)) delete process.env[k];
    writeFileSync(join(tmpRoot, 'config.json'), JSON.stringify({ updateChannel: 'preview' }), 'utf-8');

    store = new ProviderChannelStore(ProviderChannelStore.defaultRoot());
    repoRoot = makeTmp('adhdev-auto-update-repo-');
    specs = [
      {
        category: 'cli', dirname: 'alpha-cli', type: 'alpha-cli', version: '1.0.0',
        manifestExtra: { compatibility: [{ ideVersion: '>=1.0.0', spec: 'specs/1.0.json' }] },
        files: { 'specs/1.0.json': SPEC_V1 },
      },
      { category: 'cli', dirname: 'beta-cli', type: 'beta-cli', version: '1.0.0' },
    ];
    buildRepoTree(repoRoot, specs);
    publishRows();
    downloads = 0;
    cliVersions = {};
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    for (const dir of [tmpRoot, repoRoot]) {
      if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  function publishRows() {
    metadata = {
      ...(metadata ?? {}),
      rows: specs.map((s) => makeRegistryRow(s, digestFor(repoRoot, s.category, s.dirname))),
      requestedUrls: metadata?.requestedUrls ?? [],
    };
  }

  /** Simulate a publish of `type` at `version` (optionally replacing manifest fields / files). */
  function publish(type: string, version: string, patch: Partial<FixtureProviderSpec> = {}) {
    const idx = specs.findIndex((s) => s.type === type);
    const next: FixtureProviderSpec = {
      ...(idx >= 0 ? specs[idx] : { category: 'cli', dirname: type, type }),
      ...patch,
      version,
      manifestExtra: { ...(idx >= 0 ? specs[idx].manifestExtra : {}), ...(patch.manifestExtra ?? {}) },
      files: { ...(idx >= 0 ? specs[idx].files : {}), ...(patch.files ?? {}) },
    };
    rmSync(join(repoRoot, next.category, next.dirname), { recursive: true, force: true });
    buildRepoTree(repoRoot, [next]);
    if (idx >= 0) specs[idx] = next; else specs.push(next);
    publishRows();
  }

  function newLoader(daemonVersion = '1.0.81', extra: Record<string, unknown> = {}) {
    const loader = new ProviderLoader({
      updateChannel: 'preview',
      channelStore: store,
      logFn: () => {},
      probeStarts: [join(tmpRoot, 'no-sibling-here')],
      daemonVersion,
      ...extra,
      channelSyncIO: {
        fetchJson: async (url: string) => {
          metadata.requestedUrls.push(url);
          return fakeRegistryBody(metadata, url);
        },
        downloadFile: async () => { downloads += 1; },
        extractTarball: async (_tarPath: string, destDir: string) => {
          const inner = join(destDir, 'adhdev-providers-test');
          mkdirSync(inner, { recursive: true });
          cpSync(repoRoot, inner, { recursive: true });
        },
      },
    });
    loader.setVersionArchive({ getLatest: (type: string) => cliVersions[type] ?? null } as unknown as VersionArchive);
    return loader;
  }

  async function bootstrapped(daemonVersion?: string) {
    const loader = newLoader(daemonVersion);
    const boot = await loader.maybeFirstSyncVerifiedChannel();
    expect(boot?.status).toBe('activated');
    return loader;
  }

  const pinVersion = (loader: ProviderLoader, type: string) =>
    loader.listVerifiedChannelPins().get(type)?.active.providerVersion;

  it('U1: a periodic run activates a newer bundle of a pinned type and records from → to', async () => {
    const loader = await bootstrapped();
    publish('alpha-cli', '1.1.0');

    const { report } = await loader.runAutoUpdate({ enabled: true });
    expect(report?.activated.map((a) => a.providerType)).toEqual(['alpha-cli']);
    expect(pinVersion(loader, 'alpha-cli')).toBe('1.1.0');
    expect(pinVersion(loader, 'beta-cli')).toBe('1.0.0');
    const status = loader.getAutoUpdateStatus();
    expect(status.enabled).toBe(true);
    expect(status.lastRunAt).toEqual(expect.any(String));
    expect(status.types['alpha-cli']).toMatchObject({ state: 'updated', from: '1.0.0', to: '1.1.0' });
    // The badge snapshot self-heals.
    expect(loader.getChannelStalenessSnapshot()?.staleTypes).toEqual([]);
  });

  it('U1b: the first-install bootstrap is not reported as an auto-update (no "auto-updated — → x" on every row)', async () => {
    // Live (isolated fresh standalone, 2026-10-10): once check_provider_updates
    // listed channel-store rows, every provider of a fresh install carried
    // { state: 'updated', from: null } from the bootstrap sync, so the Providers
    // tab would read "auto-updated — → x" on all 19 rows. An activation with no
    // prior pin is an install, not an update.
    const loader = await bootstrapped();
    expect(loader.getAutoUpdateStatus().types).toEqual({});
  });

  it('U2: a type this machine never activated is never auto-installed', async () => {
    const loader = await bootstrapped();
    publish('gamma-cli', '1.0.0');

    const { probe, report } = await loader.runAutoUpdate({ enabled: true });
    expect(probe.newTypes).toEqual(['gamma-cli']);
    expect(report).toBeNull(); // nothing stale → no sync at all
    expect(loader.listVerifiedChannelPins().has('gamma-cli')).toBe(false);
  });

  it('U3: minDaemonVersion above the running daemon is blocked with a reason; the verdict is cached', async () => {
    const loader = await bootstrapped('1.0.80');
    publish('alpha-cli', '1.1.0', { manifestExtra: { minDaemonVersion: '1.0.81' } });

    const first = await loader.runAutoUpdate({ enabled: true });
    expect(first.report?.activated).toEqual([]);
    expect(first.report?.status).not.toBe('error');
    expect(first.report?.blocked).toEqual([
      expect.objectContaining({ providerType: 'alpha-cli', code: 'DAEMON_VERSION_UNSUPPORTED', requires: { daemon: '1.0.81' } }),
    ]);
    expect(pinVersion(loader, 'alpha-cli')).toBe('1.0.0');
    expect(loader.getAutoUpdateStatus().types['alpha-cli']).toMatchObject({
      state: 'blocked', from: '1.0.0', to: '1.1.0', code: 'DAEMON_VERSION_UNSUPPORTED',
    });

    // Same bundle + same daemon/CLI → decided before transport (no download).
    const downloadsBefore = downloads;
    const second = await loader.runAutoUpdate({ enabled: true });
    expect(downloads).toBe(downloadsBefore);
    expect(second.report?.blocked?.[0]?.code).toBe('DAEMON_VERSION_UNSUPPORTED');

    // A daemon that meets the floor activates it (prerelease tail ignored).
    const newer = newLoader('1.0.81-rc.3');
    const third = await newer.runAutoUpdate({ enabled: true });
    expect(third.report?.activated.map((a) => a.providerVersion)).toEqual(['1.1.0']);
  });

  it('U3b: the daemon gate also applies to an explicit activation', async () => {
    const loader = await bootstrapped('1.0.80');
    publish('alpha-cli', '1.1.0', { manifestExtra: { minDaemonVersion: '1.0.81' } });
    const report = await loader.syncVerifiedChannel();
    expect(report.activated).toEqual([]);
    expect(report.blocked.map((b) => b.code)).toEqual(['DAEMON_VERSION_UNSUPPORTED']);
    expect(pinVersion(loader, 'alpha-cli')).toBe('1.0.0');
  });

  it('U4: no spec for the installed CLI version blocks; a matching version activates; unknown passes', async () => {
    const loader = await bootstrapped();
    // 1.1.0 drops the 1.x spec and only supports CLI >= 2.0.0.
    publish('alpha-cli', '1.1.0', {
      manifestExtra: { compatibility: [{ ideVersion: '>=2.0.0', spec: 'specs/2.0.json' }] },
      files: { 'specs/2.0.json': SPEC_V1 },
    });
    rmSync(join(repoRoot, 'cli', 'alpha-cli', 'specs', '1.0.json'));
    publishRows();

    cliVersions['alpha-cli'] = '1.5.0';
    const blocked = await loader.runAutoUpdate({ enabled: true });
    expect(blocked.report?.blocked).toEqual([
      expect.objectContaining({
        code: 'CLI_VERSION_UNSUPPORTED',
        requires: { cliVersion: '1.5.0', cliRanges: ['>=2.0.0'] },
      }),
    ]);
    expect(pinVersion(loader, 'alpha-cli')).toBe('1.0.0');

    cliVersions['alpha-cli'] = '2.1.0'; // the user upgraded the CLI → new inputs, re-evaluated
    const upgraded = await loader.runAutoUpdate({ enabled: true });
    expect(upgraded.report?.activated.map((a) => a.providerVersion)).toEqual(['1.1.0']);
  });

  it('U4b: an unknown CLI version is not a constraint', async () => {
    const loader = await bootstrapped();
    publish('alpha-cli', '1.1.0', {
      manifestExtra: { compatibility: [{ ideVersion: '>=2.0.0', spec: 'specs/2.0.json' }] },
      files: { 'specs/2.0.json': SPEC_V1 },
    });
    cliVersions['alpha-cli'] = null;
    const { report } = await loader.runAutoUpdate({ enabled: true });
    expect(report?.activated.map((a) => a.providerVersion)).toEqual(['1.1.0']);
  });

  it('U5: never a downgrade, and never undo the user rollback until the channel moves past it', async () => {
    const loader = await bootstrapped();
    publish('alpha-cli', '1.1.0');
    await loader.runAutoUpdate({ enabled: true });
    expect(pinVersion(loader, 'alpha-cli')).toBe('1.1.0');

    // The user rolls back → the channel still offers 1.1.0 → held.
    expect(loader.rollbackVerifiedChannel('alpha-cli')).not.toBeNull();
    expect(pinVersion(loader, 'alpha-cli')).toBe('1.0.0');
    const held = await loader.runAutoUpdate({ enabled: true });
    expect(held.report?.blocked?.map((b) => b.code)).toEqual(['ROLLBACK_PINNED']);
    expect(pinVersion(loader, 'alpha-cli')).toBe('1.0.0');

    // The channel moves past the rolled-back bundle → auto-update resumes.
    publish('alpha-cli', '1.2.0');
    await loader.runAutoUpdate({ enabled: true });
    expect(pinVersion(loader, 'alpha-cli')).toBe('1.2.0');

    // The channel goes BACK (yank) → never follows it down.
    publish('alpha-cli', '1.1.5');
    const down = await loader.runAutoUpdate({ enabled: true });
    expect(down.report?.blocked?.map((b) => b.code)).toEqual(['NOT_AN_UPGRADE']);
    expect(pinVersion(loader, 'alpha-cli')).toBe('1.2.0');
  });

  it('U6: a type loaded from a local override is skipped', async () => {
    await bootstrapped();
    const overrideDir = join(tmpRoot, 'providers', 'cli', 'alpha-cli');
    mkdirSync(overrideDir, { recursive: true });
    writeFileSync(join(overrideDir, 'provider.json'), JSON.stringify({
      type: 'alpha-cli', name: 'alpha local', category: 'cli', version: '9.9.9', spawn: { command: 'alpha-cli' },
    }), 'utf-8');
    const loader = newLoader();
    loader.loadAll();
    publish('alpha-cli', '1.1.0');
    const { report } = await loader.runAutoUpdate({ enabled: true });
    expect(report?.blocked?.map((b) => b.code)).toEqual(['USER_OVERRIDE']);
    expect(pinVersion(loader, 'alpha-cli')).toBe('1.0.0');
  });

  it('U7: disabled → read-only probe, nothing activated; env/config resolution', async () => {
    const loader = await bootstrapped();
    publish('alpha-cli', '1.1.0');
    const { probe, report } = await loader.runAutoUpdate({ enabled: false });
    expect(probe.staleTypes).toEqual(['alpha-cli']);
    expect(report).toBeNull();
    expect(pinVersion(loader, 'alpha-cli')).toBe('1.0.0');
    expect(loader.getAutoUpdateStatus().enabled).toBe(false);

    expect(resolveProviderAutoUpdate(undefined, {})).toBe(true);
    expect(resolveProviderAutoUpdate(false, {})).toBe(false);
    expect(resolveProviderAutoUpdate(true, { ADHDEV_PROVIDER_AUTO_UPDATE: 'off' })).toBe(false);
    expect(resolveProviderAutoUpdate(false, { ADHDEV_PROVIDER_AUTO_UPDATE: '1' })).toBe(true);
    expect(resolveProviderAutoUpdate(false, { ADHDEV_PROVIDER_AUTO_UPDATE: 'maybe' })).toBe(false);
  });

  it('U8: running sessions keep their tree — objects this process loaded survive gc', async () => {
    const loader = await bootstrapped();
    const sessionObject = store.getPointer('preview', 'alpha-cli')!.active.digest;
    const sessionSpec = join(store.getObjectDir(sessionObject), 'cli', 'alpha-cli', 'specs', '1.0.json');
    expect(existsSync(sessionSpec)).toBe(true);

    publish('alpha-cli', '1.1.0');
    await loader.runAutoUpdate({ enabled: true });
    publish('alpha-cli', '1.2.0');
    await loader.runAutoUpdate({ enabled: true });
    // N=2 retention alone would have removed 1.0.0 (active 1.2.0, previous 1.1.0).
    expect(store.getPointer('preview', 'alpha-cli')?.previous?.providerVersion).toBe('1.1.0');
    expect(existsSync(sessionSpec)).toBe(true);

    // A fresh process (sessions do not survive with it) converges back to N=2.
    const restarted = newLoader();
    publish('alpha-cli', '1.3.0');
    await restarted.syncVerifiedChannel({ onlyTargetTypes: ['alpha-cli'] });
    expect(existsSync(sessionSpec)).toBe(false);
  });
});

describe('provider auto-update loop schedule', () => {
  it('U9: waits for the boot sync, first run in [5, 10] min, then 6h ± 30 min; re-reads enabled', async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const runs: boolean[] = [];
    let enabled = true;
    let releaseBoot!: () => void;
    const bootSync = new Promise<void>((r) => { releaseBoot = r; });
    const onActivated = vi.fn();
    const loop = startProviderAutoUpdateLoop({
      runAutoUpdate: async ({ enabled: e }) => {
        runs.push(e);
        return { probe: { staleTypes: ['x'], newTypes: [], channel: 'preview' }, report: e ? { activated: [{}] } : null };
      },
      isEnabled: () => enabled,
      bootSync,
      onActivated,
      onStale: () => {},
      log: { info: () => {}, debug: () => {} },
      random: () => 0.5,
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return { cancel: () => {} }; },
    });

    await Promise.resolve();
    expect(timers).toHaveLength(0); // boot sync still running
    releaseBoot();
    await new Promise((r) => setTimeout(r, 0));
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(AUTO_UPDATE_FIRST_DELAY_MS + AUTO_UPDATE_FIRST_JITTER_MS / 2);

    timers[0].fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toEqual([true]);
    expect(onActivated).toHaveBeenCalledWith(1);
    expect(timers).toHaveLength(2);
    expect(timers[1].ms).toBe(AUTO_UPDATE_INTERVAL_MS); // 6h - 30m + 0.5 * 60m
    expect(timers[1].ms).toBeGreaterThanOrEqual(AUTO_UPDATE_INTERVAL_MS - AUTO_UPDATE_INTERVAL_JITTER_MS);

    enabled = false;
    timers[1].fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toEqual([true, false]);
    expect(onActivated).toHaveBeenCalledTimes(1);
    loop.stop();
  });
});
