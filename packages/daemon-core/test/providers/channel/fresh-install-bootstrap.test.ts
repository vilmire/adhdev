/**
 * Fresh-install provider bootstrap — loader-level contract tests.
 *
 * Root cause: the "daemon ships empty" design assumed the dashboard install
 * flow would populate providers, but nothing ever did on a clean machine:
 * fetchLatest() is gated behind providerAllowUnverifiedTarball (default off),
 * and maybeFirstSyncVerifiedChannel() required a non-empty .upstream, so a
 * fresh install sat at 0 providers and the user could not run anything.
 *
 * Contract under test (maybeFirstSyncVerifiedChannel bootstrap branch):
 *   1. Empty .upstream AND empty channel store → ONE bounded bootstrap sync
 *      targets the WHOLE verified channel from the registry and creates the
 *      providers/ directory.
 *   2. Once any pointer exists the gate short-circuits forever — no
 *      re-bootstrap, zero network.
 *   3. Registry outage on a fresh install fails closed: nothing activates,
 *      the error is reported (never thrown), and the next boot retries.
 *   4. Only digest-verified entries activate: legacy-unverified rows and
 *      digest mismatches are typed skips/errors, never activations.
 *   5. The requested channel is the only channel read — stable queries
 *      channel=stable, preview queries channel=preview.
 *
 * All I/O is injected (fetchJson/downloadFile/extractTarball) — no test
 * touches the network.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync, writeFileSync } from 'fs';
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

const PROVIDER_COUNT = 5;

function freshSpecs(): FixtureProviderSpec[] {
  return Array.from({ length: PROVIDER_COUNT }, (_, i) => ({
    category: 'cli',
    dirname: `p${i}-cli`,
    type: `p${i}-cli`,
    version: '1.0.0',
  }));
}

describe('Fresh-install bootstrap (empty .upstream + empty store)', () => {
  let tmpRoot = '';
  let configDirBefore: string | undefined;
  let envChannelBefore: string | undefined;
  let buildChannelBefore: string | undefined;
  let store: ProviderChannelStore;
  let specs: FixtureProviderSpec[];
  let repoRoot = '';
  let metadata: FakeMetadataSource;
  let fetchCount = 0;

  beforeEach(() => {
    tmpRoot = makeTmp('adhdev-fresh-bootstrap-');
    configDirBefore = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = tmpRoot;
    envChannelBefore = process.env.ADHDEV_PROVIDER_CHANNEL;
    delete process.env.ADHDEV_PROVIDER_CHANNEL;
    buildChannelBefore = process.env.ADHDEV_BUILD_CHANNEL;
    delete process.env.ADHDEV_BUILD_CHANNEL;

    store = new ProviderChannelStore(ProviderChannelStore.defaultRoot());

    // Fresh install: preview updateChannel, NO .upstream, NO providers dir at
    // all — exactly what a clean machine looks like before first boot.
    writeFileSync(join(tmpRoot, 'config.json'), JSON.stringify({ updateChannel: 'preview' }), 'utf-8');

    specs = freshSpecs();
    repoRoot = makeTmp('adhdev-fresh-repo-');
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
    if (buildChannelBefore === undefined) delete process.env.ADHDEV_BUILD_CHANNEL;
    else process.env.ADHDEV_BUILD_CHANNEL = buildChannelBefore;
    for (const dir of [tmpRoot, repoRoot]) {
      if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    tmpRoot = repoRoot = '';
  });

  function newBootLoader() {
    return new ProviderLoader({
      updateChannel: 'preview',
      channelStore: store,
      logFn: () => {},
      probeStarts: [join(tmpRoot, 'no-sibling-here')],
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

  it('bootstraps the whole verified channel from the registry and creates providers/', async () => {
    expect(existsSync(join(tmpRoot, 'providers'))).toBe(false);
    const loader = newBootLoader();
    expect(loader.channel).toBe('preview');
    expect(loader.countVerifiedChannelPointers()).toBe(0);

    const report = await loader.maybeFirstSyncVerifiedChannel();
    expect(report?.status).toBe('activated');
    expect(report?.activated).toHaveLength(PROVIDER_COUNT);
    expect(report?.errors).toHaveLength(0);
    expect(loader.countVerifiedChannelPointers()).toBe(PROVIDER_COUNT);
    // The bootstrap path owns providers/ creation.
    expect(existsSync(join(tmpRoot, 'providers'))).toBe(true);
    // Only the preview channel was read/touched.
    expect(metadata.requestedUrls.every((u) => u.includes('channel=preview'))).toBe(true);
    expect(store.listPointers('stable').pointers.size).toBe(0);
    // The activated providers actually load.
    expect(loader.getMeta('p0-cli')).toBeDefined();
  });

  it('never re-bootstraps once pointers exist (gate short-circuits, no network)', async () => {
    const loader = newBootLoader();
    await loader.maybeFirstSyncVerifiedChannel();
    expect(loader.countVerifiedChannelPointers()).toBe(PROVIDER_COUNT);

    const fetchBefore = fetchCount;
    const second = await newBootLoader().maybeFirstSyncVerifiedChannel();
    expect(second).toBeNull();
    expect(fetchCount).toBe(fetchBefore);
  });

  it('registry outage on a fresh install fails closed and stays retryable', async () => {
    metadata.failure = new Error('registry unreachable');
    const loader = newBootLoader();
    // Never throws: the bounded report carries the typed error, boot proceeds.
    const report = await loader.maybeFirstSyncVerifiedChannel();
    expect(report?.status).toBe('error');
    expect(report?.errors[0].code).toBe('CHANNEL_METADATA_UNAVAILABLE');
    expect(loader.countVerifiedChannelPointers()).toBe(0);

    metadata.failure = undefined;
    const retry = await loader.maybeFirstSyncVerifiedChannel();
    expect(retry?.status).toBe('activated');
    expect(loader.countVerifiedChannelPointers()).toBe(PROVIDER_COUNT);
  });

  it('activates only digest-verified entries (legacy-unverified + digest mismatch stay out)', async () => {
    metadata.rows = specs.map((spec, i) => {
      if (i === 0) return makeRegistryRow(spec, null, 'legacy-unverified');
      if (i === 1) return makeRegistryRow(spec, `sha256:${'f'.repeat(64)}`); // well-formed but wrong digest
      return makeRegistryRow(spec, digestFor(repoRoot, spec.category, spec.dirname));
    });
    const loader = newBootLoader();

    const report = await loader.maybeFirstSyncVerifiedChannel();
    expect(report?.activated).toHaveLength(PROVIDER_COUNT - 2);
    expect(report?.skipped).toHaveLength(1);
    expect(report?.skipped[0].code).toBe('ENTRY_NON_ACTIVATABLE');
    expect(report?.errors.some((e) => e.code === 'DIGEST_MISMATCH' && e.providerType === 'p1-cli')).toBe(true);
    expect(loader.countVerifiedChannelPointers()).toBe(PROVIDER_COUNT - 2);
    expect(loader.getMeta('p0-cli')).toBeUndefined();
    expect(loader.getMeta('p1-cli')).toBeUndefined();
    expect(loader.getMeta('p2-cli')).toBeDefined();
  });

  // 2026-09-30 incident: the stable registry's CLI rows did not match the
  // provider repo, so a fresh install activated only its IDE providers — and
  // the old gate ("any pointer exists → never bootstrap again") kept it at zero
  // CLI agents even after the registry was fixed.
  it('retries a partially failed bootstrap on the next boot once the registry is fixed', async () => {
    const goodRows = specs.map((spec) => makeRegistryRow(spec, digestFor(repoRoot, spec.category, spec.dirname)));
    metadata.rows = specs.map((spec, i) => (i < 2 ? makeRegistryRow(spec, `sha256:${'e'.repeat(64)}`) : goodRows[i]));
    const first = await newBootLoader().maybeFirstSyncVerifiedChannel();
    expect(first?.errors.filter((e) => e.code === 'DIGEST_MISMATCH')).toHaveLength(2);
    expect(store.listPointers('preview').pointers.size).toBe(PROVIDER_COUNT - 2);

    metadata.rows = goodRows; // registry republished
    const second = await newBootLoader().maybeFirstSyncVerifiedChannel();
    expect(second?.activated.map((a) => a.providerType).sort()).toEqual(['p0-cli', 'p1-cli']);
    expect(store.listPointers('preview').pointers.size).toBe(PROVIDER_COUNT);

    // Clean now → the gate closes again with zero network.
    const fetchBefore = fetchCount;
    expect(await newBootLoader().maybeFirstSyncVerifiedChannel()).toBeNull();
    expect(fetchCount).toBe(fetchBefore);
  });

  it('heals an install from before the bootstrap markers that has no CLI agent, and leaves one that has', async () => {
    metadata.rows = specs.map((spec, i) => (i === 0 ? makeRegistryRow(spec, `sha256:${'e'.repeat(64)}`) : makeRegistryRow(spec, digestFor(repoRoot, spec.category, spec.dirname))));
    await newBootLoader().maybeFirstSyncVerifiedChannel();
    // Simulate a pre-marker install: drop the markers this daemon wrote.
    for (const f of ['.channel-bootstrap-pending.preview.json', '.channel-bootstrap-complete.preview.json']) {
      rmSync(join(tmpRoot, 'providers', f), { force: true });
    }
    // It has CLI agents (p1..p4) → a pre-marker install is left alone.
    const fetchBefore = fetchCount;
    expect(await newBootLoader().maybeFirstSyncVerifiedChannel()).toBeNull();
    expect(fetchCount).toBe(fetchBefore);
  });

  it('heals a pre-marker install whose bootstrap left it with IDE providers but no CLI agent', async () => {
    // Exactly the 1.0.61 shape: IDE rows verified, every CLI row mismatched.
    specs = [
      { category: 'ide', dirname: 'q-ide', type: 'q-ide', version: '1.0.0' },
      { category: 'cli', dirname: 'q-cli', type: 'q-cli', version: '1.0.0' },
    ];
    buildRepoTree(repoRoot, specs);
    const ide = makeRegistryRow(specs[0], digestFor(repoRoot, 'ide', 'q-ide'));
    metadata.rows = [ide, makeRegistryRow(specs[1], `sha256:${'e'.repeat(64)}`)];
    await newBootLoader().maybeFirstSyncVerifiedChannel();
    expect([...store.listPointers('preview').pointers.keys()]).toEqual(['q-ide']);
    for (const f of ['.channel-bootstrap-pending.preview.json', '.channel-bootstrap-complete.preview.json']) {
      rmSync(join(tmpRoot, 'providers', f), { force: true });
    }

    metadata.rows = [ide, makeRegistryRow(specs[1], digestFor(repoRoot, 'cli', 'q-cli'))];
    const healed = await newBootLoader().maybeFirstSyncVerifiedChannel();
    expect(healed?.activated.map((a) => a.providerType)).toEqual(['q-cli']);
  });

  it('stable fresh install queries the stable channel exactly', async () => {
    writeFileSync(join(tmpRoot, 'config.json'), JSON.stringify({ updateChannel: 'stable' }), 'utf-8');
    const loader = new ProviderLoader({
      updateChannel: 'stable',
      channelStore: store,
      logFn: () => {},
      probeStarts: [join(tmpRoot, 'no-sibling-here')],
      channelSyncIO: {
        fetchJson: async (url: string) => {
          metadata.requestedUrls.push(url);
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
    expect(loader.channel).toBe('stable');

    const report = await loader.maybeFirstSyncVerifiedChannel();
    expect(report?.status).toBe('activated');
    expect(report?.activated).toHaveLength(PROVIDER_COUNT);
    expect(metadata.requestedUrls.length).toBeGreaterThan(0);
    expect(metadata.requestedUrls.every((u) => u.includes('channel=stable'))).toBe(true);
    expect(store.listPointers('preview').pointers.size).toBe(0);
  });
});
