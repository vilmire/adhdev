/**
 * Cross-track channel activation stamp clobber guard (2026-08-22 incident).
 *
 * What happened: `npm run dev:standalone` was launched from a coordinator
 * shell exporting ADHDEV_CONFIG_DIR=~/.adhdev-preview. Standalone's
 * bootstrap-config-dir.ts deliberately honors an inherited ADHDEV_CONFIG_DIR,
 * and running under tsx means no `__ADHDEV_BUILD_CHANNEL__` bundler define —
 * so resolveProviderChannel fell through to its 'stable' default while the
 * process wrote into the LIVE preview daemon's providers dir. The stamp was
 * rewritten to channel:'stable'; the next preview daemon boot compared that
 * stamp against its own 'preview' channel and 52 providers presented as 0.
 *
 * Contracts under test:
 *   G1. A fallback-channel loader does NOT overwrite an existing stamp that
 *       belongs to the other track (the clobber itself).
 *   G2. The refusal is loud — it names both sides, so the next occurrence is
 *       attributable instead of silent.
 *   G3. OVER-CORRECTION GUARD: a normal daemon whose channel came from an
 *       explicit signal still writes the stamp. Without this, every boot would
 *       re-run a full network sync — the exact regression the stamp exists to
 *       prevent.
 *   G4. A fallback-channel loader still writes when there is no conflict
 *       (no pre-existing stamp), so first-boot behaviour is unchanged.
 *   G5. A fallback-channel loader still refreshes a stamp on its OWN track
 *       (same channel, older version) — the guard is about cross-track flips,
 *       not about fallback resolution per se.
 *
 * No network, no live state: ADHDEV_CONFIG_DIR is pinned to a tmp dir and the
 * stamp is written through the loader's own sync path with injected I/O.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
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

describe('channel activation stamp — cross-track clobber guard', () => {
  let tmpRoot = '';
  let repoRoot = '';
  let configDirBefore: string | undefined;
  let envChannelBefore: string | undefined;
  let buildChannelBefore: string | undefined;
  let store: ProviderChannelStore;
  let metadata: FakeMetadataSource;

  const SPECS: FixtureProviderSpec[] = [
    { category: 'cli', dirname: 'alpha-cli', type: 'alpha-cli', version: '1.0.0' },
  ];

  // The guard keys off the config dir's BASENAME implying a track, so the tmp
  // dir must be named like the preview track dir ('.adhdev-preview') to
  // reproduce the incident. Kept under a tmp parent — never the real home.
  function makePreviewLikeConfigDir(): string {
    const parent = makeTmp('adhdev-stamp-guard-');
    const dir = join(parent, '.adhdev-preview');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function stampPath(): string {
    return join(tmpRoot, 'providers', '.channel-activation-stamp.json');
  }

  function writeExistingStamp(daemonVersion: string, channel: string): void {
    mkdirSync(join(tmpRoot, 'providers'), { recursive: true });
    writeFileSync(
      stampPath(),
      JSON.stringify({ daemonVersion, channel, syncedAt: '2026-08-20T00:00:00.000Z' }, null, 2),
      'utf-8',
    );
  }

  function readStamp(): { daemonVersion?: string; channel?: string } {
    return JSON.parse(readFileSync(stampPath(), 'utf-8'));
  }

  beforeEach(() => {
    tmpRoot = makePreviewLikeConfigDir();
    configDirBefore = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = tmpRoot;
    envChannelBefore = process.env.ADHDEV_PROVIDER_CHANNEL;
    delete process.env.ADHDEV_PROVIDER_CHANNEL;
    buildChannelBefore = process.env.ADHDEV_BUILD_CHANNEL;
    delete process.env.ADHDEV_BUILD_CHANNEL;

    store = new ProviderChannelStore(ProviderChannelStore.defaultRoot());
    repoRoot = makeTmp('adhdev-stamp-guard-repo-');
    buildRepoTree(repoRoot, SPECS);
    metadata = {
      rows: SPECS.map((spec) => makeRegistryRow(spec, digestFor(repoRoot, spec.category, spec.dirname))),
      requestedUrls: [],
    };
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

  /**
   * @param explicitChannel pass 'preview'/'stable' to simulate a real daemon
   *        with an explicit signal; omit to simulate the dev/tsx fallback.
   */
  function newLoader(opts: { daemonVersion: string; explicitChannel?: string; logs?: string[] }) {
    return new ProviderLoader({
      ...(opts.explicitChannel ? { channel: opts.explicitChannel } : {}),
      channelStore: store,
      logFn: (msg: string) => { opts.logs?.push(msg); },
      probeStarts: [join(tmpRoot, 'no-sibling-here')],
      daemonVersion: opts.daemonVersion,
      channelSyncIO: {
        fetchJson: async (url: string) => fakeRegistryBody(metadata, url),
        downloadFile: async () => { /* nothing to download — no activatable target */ },
        extractTarball: async () => { /* unused */ },
      },
    });
  }

  it('G1/G2: fallback-stable loader refuses to clobber an existing preview stamp, loudly', async () => {
    writeExistingStamp('1.0.57', 'preview');
    const logs: string[] = [];
    const loader = newLoader({ daemonVersion: '1.0.99', logs });

    // Sanity: this reproduces the incident's resolution — fallback to 'stable'
    // even though the config dir is the preview track's.
    expect(loader.channel).toBe('stable');

    await loader.syncVerifiedChannel();

    // G1 — the live stamp survives untouched.
    expect(readStamp()).toMatchObject({ daemonVersion: '1.0.57', channel: 'preview' });

    // G2 — refusal names both sides and the cause.
    const refusal = logs.find((l) => l.includes('Refusing to overwrite channel activation stamp'));
    expect(refusal).toBeTruthy();
    expect(refusal).toContain('1.0.57@preview');
    expect(refusal).toContain('FALLBACK');
  });

  it('G3 (over-correction guard): an explicit-channel daemon still writes the stamp', async () => {
    writeExistingStamp('1.0.56', 'preview');
    const logs: string[] = [];
    const loader = newLoader({ daemonVersion: '1.0.57', explicitChannel: 'preview', logs });
    expect(loader.channel).toBe('preview');

    await loader.syncVerifiedChannel();

    // The whole point of the stamp: a real daemon advances it, so same-version
    // reboots stay network-free.
    expect(readStamp()).toMatchObject({ daemonVersion: '1.0.57', channel: 'preview' });
    expect(logs.find((l) => l.includes('Refusing to overwrite'))).toBeFalsy();
  });

  it('G4: fallback loader still writes when no stamp exists (no conflict to protect)', async () => {
    expect(existsSync(stampPath())).toBe(false);
    const loader = newLoader({ daemonVersion: '1.0.99' });

    await loader.syncVerifiedChannel();

    expect(readStamp()).toMatchObject({ daemonVersion: '1.0.99', channel: 'stable' });
  });

  it('G5: fallback loader still refreshes a stamp on its OWN channel', async () => {
    writeExistingStamp('1.0.50', 'stable');
    const loader = newLoader({ daemonVersion: '1.0.99' });

    await loader.syncVerifiedChannel();

    // Same channel → not a cross-track flip → normal advance.
    expect(readStamp()).toMatchObject({ daemonVersion: '1.0.99', channel: 'stable' });
  });

  it('guard never consults the real home dir', () => {
    // Regression rail for the test itself: the incident was about live state,
    // so assert the fixture is nowhere near it.
    expect(tmpRoot.startsWith(join(homedir(), '.adhdev'))).toBe(false);
  });
});
