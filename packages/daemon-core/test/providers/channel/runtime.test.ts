import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ProviderChannelStore } from '../../../src/providers/channel/store.js';
import { collectSyncTargetTypes } from '../../../src/providers/channel/runtime.js';
import { TREE_DIGEST_ALGORITHM } from '../../../src/providers/channel/tree-digest.js';
import {
  buildObjectStaging,
  buildRepoTree,
  digestFor,
  entryFromSpec,
  makeRegistryRow,
  makeRuntime,
  makeTmp,
  type FakeMetadataSource,
  type FixtureProviderSpec,
} from './helpers.js';

const CLI_X: FixtureProviderSpec = {
  category: 'cli',
  dirname: 'x-cli',
  type: 'x-cli',
  version: '1.0.0',
  files: { 'scripts.js': 'module.exports = {};' },
};

describe('ProviderChannelRuntime.sync', () => {
  let root = '';
  let store: ProviderChannelStore;
  let repoRoot = '';

  beforeEach(() => {
    root = makeTmp('adhdev-channel-runtime-');
    store = new ProviderChannelStore(join(root, '.store'));
    repoRoot = join(root, 'repo');
    buildRepoTree(repoRoot, [CLI_X]);
  });

  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
    root = repoRoot = '';
  });

  function metadataFor(rows: Array<Record<string, unknown>>): FakeMetadataSource {
    return { rows, requestedUrls: [] };
  }

  it('activates a valid verified artifact end-to-end', async () => {
    const digest = digestFor(repoRoot, 'cli', 'x-cli');
    const metadata = metadataFor([makeRegistryRow(CLI_X, digest)]);
    const runtime = makeRuntime({ store, repoRoot, metadata });

    const report = await runtime.sync({ channel: 'stable', targetTypes: new Set(['x-cli']) });

    expect(report.status).toBe('activated');
    expect(report.errors).toHaveLength(0);
    expect(report.activated.map((a) => a.digest)).toEqual([digest]);
    expect(metadata.requestedUrls).toEqual([
      'https://registry.test/api/v1/registry/providers?channel=stable&limit=100',
    ]);

    const pointer = store.getPointer('stable', 'x-cli');
    expect(pointer?.active.digest).toBe(digest);
    expect(existsSync(join(store.getObjectDir(digest), 'cli', 'x-cli', 'provider.json'))).toBe(true);

    // Second sync with the same digest: already current, no new download.
    const again = await runtime.sync({ channel: 'stable', targetTypes: new Set(['x-cli']) });
    expect(again.status).toBe('up-to-date');
    expect(again.activated).toHaveLength(0);
  });

  it('refuses activation on digest mismatch and keeps last-known-good', async () => {
    // First: a good activation (last-known-good).
    const goodDigest = digestFor(repoRoot, 'cli', 'x-cli');
    const good = makeRuntime({ store, repoRoot, metadata: metadataFor([makeRegistryRow(CLI_X, goodDigest)]) });
    expect((await good.sync({ channel: 'stable', targetTypes: new Set(['x-cli']) })).status).toBe('activated');

    // Then: the channel advertises a digest the downloaded tree does NOT match.
    const wrongDigest = `sha256:${'b'.repeat(64)}`;
    const bad = makeRuntime({ store, repoRoot, metadata: metadataFor([makeRegistryRow(CLI_X, wrongDigest)]) });
    const report = await bad.sync({ channel: 'stable', targetTypes: new Set(['x-cli']) });

    expect(report.status).toBe('error');
    expect(report.errors.some((e) => e.code === 'DIGEST_MISMATCH' && e.providerType === 'x-cli')).toBe(true);
    expect(report.activated).toHaveLength(0);

    // Last-known-good still active, mismatched bytes never activated.
    expect(store.getPointer('stable', 'x-cli')?.active.digest).toBe(goodDigest);
    expect(existsSync(store.getObjectDir(wrongDigest))).toBe(false);
  });

  it('isolates entries with an unsupported digest algorithm', async () => {
    const digest = digestFor(repoRoot, 'cli', 'x-cli');
    const metadata = metadataFor([makeRegistryRow(CLI_X, digest, 'adhdev-canonical-bundle-sha256-v9')]);
    const runtime = makeRuntime({ store, repoRoot, metadata });

    const report = await runtime.sync({ channel: 'stable', targetTypes: new Set(['x-cli']) });

    expect(report.status).toBe('up-to-date');
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].code).toBe('ENTRY_ALGORITHM_UNSUPPORTED');
    expect(store.getPointer('stable', 'x-cli')).toBeNull();
  });

  it('never activates NULL-digest / legacy-unverified rows', async () => {
    const metadata = metadataFor([makeRegistryRow(CLI_X, null, 'legacy-unverified')]);
    const runtime = makeRuntime({ store, repoRoot, metadata });

    const report = await runtime.sync({ channel: 'stable', targetTypes: new Set(['x-cli']) });

    expect(report.status).toBe('up-to-date');
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].code).toBe('ENTRY_NON_ACTIVATABLE');
    expect(store.getPointer('stable', 'x-cli')).toBeNull();
  });

  it('keeps last-known-good when the registry is unavailable', async () => {
    const digest = digestFor(repoRoot, 'cli', 'x-cli');
    const good = makeRuntime({ store, repoRoot, metadata: metadataFor([makeRegistryRow(CLI_X, digest)]) });
    expect((await good.sync({ channel: 'stable', targetTypes: new Set(['x-cli']) })).status).toBe('activated');

    const down = makeRuntime({
      store,
      repoRoot,
      metadata: { failure: new Error('ECONNREFUSED'), requestedUrls: [] },
    });
    const report = await down.sync({ channel: 'stable', targetTypes: new Set(['x-cli']) });

    expect(report.status).toBe('error');
    expect(report.errors[0].code).toBe('CHANNEL_METADATA_UNAVAILABLE');
    // Last-known-good untouched.
    expect(store.getPointer('stable', 'x-cli')?.active.digest).toBe(digest);
    expect(store.listActiveActivations('stable').activations).toHaveLength(1);
  });

  it('reports a typed non-activation error when the registry is unavailable and there is no last-known-good', async () => {
    const down = makeRuntime({
      store,
      repoRoot,
      metadata: { failure: new Error('ENOTFOUND'), requestedUrls: [] },
    });
    const report = await down.sync({ channel: 'stable', targetTypes: new Set(['x-cli']) });

    expect(report.status).toBe('error');
    expect(report.errors[0].code).toBe('CHANNEL_METADATA_UNAVAILABLE');
    expect(store.listActiveActivations('stable').activations).toHaveLength(0);
  });

  it('stable never falls through to preview on metadata failure', async () => {
    const metadata: FakeMetadataSource = { failure: new Error('boom'), requestedUrls: [] };
    const down = makeRuntime({ store, repoRoot, metadata });

    const report = await down.sync({ channel: 'stable', targetTypes: new Set(['x-cli']) });

    expect(report.status).toBe('error');
    // The invariant under test is the CHANNEL, not the request count: a
    // metadata failure is now retried a bounded number of times, and every
    // one of those attempts must still read the requested channel. Asserting
    // a single request would silently convert this fail-closed guard into an
    // assertion about retry arity.
    expect(metadata.requestedUrls.length).toBeGreaterThanOrEqual(1);
    for (const url of metadata.requestedUrls) {
      expect(url).toContain('channel=stable');
      expect(url).not.toContain('channel=preview');
    }
  });

  /**
   * Boot-storm address-race regression (live RCA 2026-09-20).
   *
   * The daemon-update sync fires inside the daemon's own start-up storm, where
   * Node's Happy Eyeballs races IPv4/IPv6 candidates; on a host with AAAA
   * records but no usable IPv6 egress the losing candidates surface as an
   * AggregateError. Measured live: the identical request succeeds seconds
   * later. These tests assert the BEHAVIOR (a transient first failure still
   * ends in a completed sync), never the mere existence of a retry helper.
   */
  describe('transient channel metadata failure', () => {
    /**
     * Metadata source that throws for the first `failTimes` calls and then
     * serves rows normally — the shape of the live race.
     */
    function flakyRuntime(options: { failTimes: number; error: Error; digest: string; logs?: string[] }) {
      const attempts = { count: 0 };
      const runtime = makeRuntime({
        store,
        repoRoot,
        metadata: metadataFor([makeRegistryRow(CLI_X, options.digest)]),
        logFn: options.logs ? (msg) => options.logs!.push(msg) : undefined,
      });
      const realFetch = (runtime as any).fetchJson;
      (runtime as any).fetchJson = async (url: string) => {
        attempts.count += 1;
        if (attempts.count <= options.failTimes) throw options.error;
        return realFetch(url);
      };
      return { runtime, attempts };
    }

    it('retries and COMPLETES the sync when the first metadata attempt fails transiently', async () => {
      const digest = digestFor(repoRoot, 'cli', 'x-cli');
      const err: any = new AggregateError([
        Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH', syscall: 'connect', address: '2606:4700:3030::ac43:abd3', port: 443 }),
      ]);
      const { runtime, attempts } = flakyRuntime({ failTimes: 1, error: err, digest });

      const report = await runtime.sync({ channel: 'stable', targetTypes: new Set(['x-cli']) });

      // The point of the fix: a transient first failure no longer strands the
      // machine on stale manifests until the next daemon restart.
      expect(report.status).toBe('activated');
      expect(report.errors).toHaveLength(0);
      expect(report.activated.map((a) => a.digest)).toEqual([digest]);
      expect(attempts.count).toBe(2);
      expect(store.getPointer('stable', 'x-cli')?.active.digest).toBe(digest);
    });

    it('still fails closed (last-known-good preserved) once the bounded attempts are exhausted', async () => {
      const digest = digestFor(repoRoot, 'cli', 'x-cli');
      const err: any = new AggregateError([
        Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH', syscall: 'connect', address: '2606:4700:3030::ac43:abd3', port: 443 }),
      ]);
      // Never recovers — a genuine outage must NOT retry unboundedly.
      const { runtime, attempts } = flakyRuntime({ failTimes: Number.MAX_SAFE_INTEGER, error: err, digest });

      const report = await runtime.sync({ channel: 'stable', targetTypes: new Set(['x-cli']) });

      expect(report.status).toBe('error');
      expect(report.errors[0].code).toBe('CHANNEL_METADATA_UNAVAILABLE');
      expect(attempts.count).toBe(3); // bounded: METADATA_FETCH_ATTEMPTS
      expect(store.listActiveActivations('stable').activations).toHaveLength(0);
    });

    it('surfaces the AggregateError sub-errors (code + address) instead of the bare name', async () => {
      const digest = digestFor(repoRoot, 'cli', 'x-cli');
      const err: any = new AggregateError([
        Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH', syscall: 'connect', address: '2606:4700:3030::ac43:abd3', port: 443 }),
        Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT', syscall: 'connect', address: '172.67.171.211', port: 443 }),
      ]);
      const { runtime } = flakyRuntime({ failTimes: Number.MAX_SAFE_INTEGER, error: err, digest });

      const report = await runtime.sync({ channel: 'stable', targetTypes: new Set(['x-cli']) });
      const message = report.errors[0].message;

      // The exact regression: this message used to be literally
      // "…: AggregateError", which made the live failure unattributable.
      expect(message).toContain('EHOSTUNREACH');
      expect(message).toContain('2606:4700:3030::ac43:abd3:443');
      expect(message).toContain('ETIMEDOUT');
      expect(message).toContain('172.67.171.211:443');
      // The failing URL is named, so the registry base is verifiable from logs.
      expect(message).toContain('channel=stable');
      expect(message).not.toMatch(/:\s*AggregateError\s*$/);
    });

    it('does NOT retry a deterministic channel-contract failure', async () => {
      // A registry that ignores ?channel= returns the same wrong payload every
      // time; retrying it is pure latency on the boot path.
      const digest = digestFor(repoRoot, 'cli', 'x-cli');
      const metadata: FakeMetadataSource = {
        rows: [makeRegistryRow(CLI_X, digest)],
        channelEcho: null, // legacy registry: omits the echo
        requestedUrls: [],
      };
      const runtime = makeRuntime({ store, repoRoot, metadata });

      const report = await runtime.sync({ channel: 'preview', targetTypes: new Set(['x-cli']) });

      expect(report.status).toBe('error');
      expect(report.errors[0].code).toBe('CHANNEL_METADATA_MISMATCH');
      expect(metadata.requestedUrls).toHaveLength(1);
    });
  });

  it('fails closed when the transport fails (no partial activations)', async () => {
    const digest = digestFor(repoRoot, 'cli', 'x-cli');
    const metadata = metadataFor([makeRegistryRow(CLI_X, digest)]);
    const runtime = makeRuntime({ store, repoRoot, metadata });
    // Sabotage the transport.
    (runtime as any).downloadFile = async () => { throw new Error('HTTP 503'); };

    const report = await runtime.sync({ channel: 'stable', targetTypes: new Set(['x-cli']) });

    expect(report.status).toBe('error');
    expect(report.errors[0].code).toBe('TRANSPORT_FAILED');
    expect(store.getPointer('stable', 'x-cli')).toBeNull();
    // Staging cleaned up — no partial tree observable.
    expect(existsSync(join(root, '.store', 'staging')) && readdirSync(join(root, '.store', 'staging')).length > 0).toBe(false);
  });

  it('reports ENTRY_ARTIFACT_NOT_FOUND when the transport lacks the artifact', async () => {
    const digest = `sha256:${'c'.repeat(64)}`;
    const ghost: FixtureProviderSpec = { category: 'ide', dirname: 'ghost-ide', type: 'ghost-ide' };
    const metadata = metadataFor([makeRegistryRow(ghost, digest)]);
    const runtime = makeRuntime({ store, repoRoot, metadata });

    const report = await runtime.sync({ channel: 'stable', targetTypes: new Set(['ghost-ide']) });

    expect(report.status).toBe('error');
    expect(report.errors.some((e) => e.code === 'ENTRY_ARTIFACT_NOT_FOUND')).toBe(true);
  });

  it('supports rollback to the previous verified object after a bad update, without network', async () => {
    // v1 activation
    const digestV1 = digestFor(repoRoot, 'cli', 'x-cli');
    const v1 = makeRuntime({ store, repoRoot, metadata: metadataFor([makeRegistryRow(CLI_X, digestV1)]) });
    await v1.sync({ channel: 'stable', targetTypes: new Set(['x-cli']) });

    // v2: modify the tree → new digest, new activation
    writeFileSync(join(repoRoot, 'cli', 'x-cli', 'v2.txt'), 'v2', 'utf-8');
    const digestV2 = digestFor(repoRoot, 'cli', 'x-cli');
    expect(digestV2).not.toBe(digestV1);
    const metadataV2 = metadataFor([makeRegistryRow({ ...CLI_X, version: '2.0.0' }, digestV2)]);
    const v2 = makeRuntime({ store, repoRoot, metadata: metadataV2 });
    expect((await v2.sync({ channel: 'stable', targetTypes: new Set(['x-cli']) })).status).toBe('activated');
    expect(store.getPointer('stable', 'x-cli')?.active.digest).toBe(digestV2);

    // Rollback: local pointer flip, no metadata fetch.
    const requestedBefore = metadataV2.requestedUrls.length;
    const rolledBack = store.rollback('stable', 'x-cli');
    expect(rolledBack?.digest).toBe(digestV1);
    expect(metadataV2.requestedUrls.length).toBe(requestedBefore);
    const { activations } = store.listActiveActivations('stable');
    expect(activations[0].ref.digest).toBe(digestV1);
  });

  it('enforces N=2 retention across repeated syncs', async () => {
    const digests: string[] = [];
    for (const marker of ['v1', 'v2', 'v3']) {
      writeFileSync(join(repoRoot, 'cli', 'x-cli', 'marker.txt'), marker, 'utf-8');
      const digest = digestFor(repoRoot, 'cli', 'x-cli');
      digests.push(digest);
      const runtime = makeRuntime({ store, repoRoot, metadata: metadataFor([makeRegistryRow(CLI_X, digest)]) });
      expect((await runtime.sync({ channel: 'stable', targetTypes: new Set(['x-cli']) })).status).toBe('activated');
    }

    const objectsDir = join(root, '.store', 'objects');
    const remaining = readdirSync(objectsDir).sort();
    expect(remaining).toEqual(digests.slice(1).map((d) => d.slice('sha256:'.length)).sort());
  });
});

describe('collectSyncTargetTypes', () => {
  let root = '';

  beforeEach(() => {
    root = makeTmp('adhdev-channel-targets-');
  });

  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('unions providers installed into .upstream with already-activated types', () => {
    const upstream = join(root, '.upstream');
    buildRepoTree(upstream, [
      { category: 'cli', dirname: 'installed-cli', type: 'installed-cli' },
      { category: 'extension', dirname: 'installed-ext', type: 'installed-ext' },
    ]);

    const store = new ProviderChannelStore(join(root, '.store'));
    const { dir, digest } = buildObjectStaging({ category: 'cli', dirname: 'activated-cli', type: 'activated-cli' });
    store.activate('stable', {
      providerType: 'activated-cli',
      providerVersion: '1.0.0',
      category: 'cli',
      bundleDigest: digest,
      digestAlgorithm: TREE_DIGEST_ALGORITHM,
    }, dir);

    const targets = collectSyncTargetTypes(upstream, store, 'stable');
    expect([...targets].sort()).toEqual(['activated-cli', 'installed-cli', 'installed-ext']);
  });
});
