/**
 * Pinned provider transport — the property under test is:
 *
 *   "Pushing a provider edit to main does NOT break digest verification of
 *    rows that were already published to the registry."
 *
 * That is the exact failure this work exists to remove. Before the pin, the
 * daemon downloaded `…/archive/refs/heads/main.tar.gz` and verified the trees
 * it contained against digests the registry froze at publish time, so the
 * first unpublished push to main made every fresh install fail closed with
 * DIGEST_MISMATCH.
 *
 * ── Why the central test drives the real runtime, not the URL builder ──
 *
 * It would be easy — and worthless — to assert that
 * `buildPinnedArchiveUrl(ref, sha)` returns a string containing that sha.
 * That asserts a proxy (a URL was shaped) rather than the property (a
 * published row still verifies after a push). A test like that stays green
 * even if the runtime never calls the resolver, or calls it and then ignores
 * the result.
 *
 * So `publishes then pushes` below models an actual two-commit repo: commit A
 * is what the registry published a digest for, commit B is an unpublished edit
 * sitting at the tip of main. The fake transport serves DIFFERENT BYTES per
 * commit SHA, exactly like GitHub does. The assertion is on the sync report —
 * the entry activates, and it activates at the digest the registry published.
 * Reverting the runtime wiring makes it fail, because commit B's tree really
 * does hash differently.
 */

import { describe, expect, it, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ProviderChannelStore } from '../../../src/providers/channel/store.js';
import {
  discardDownloadPartial,
  downloadProviderArchive,
  promoteDownloadPartial,
  ProviderChannelRuntime,
} from '../../../src/providers/channel/runtime.js';
import { ProviderChannelSync, type ProviderChannelSyncHost } from '../../../src/providers/provider-channel-sync.js';
import { createServer } from 'http';
import {
  buildPinnedArchiveUrl,
  listCandidateCommits,
  MAX_HISTORY_CANDIDATES,
  MIN_PER_PATH_HISTORY,
  parseGitHubArchiveUrl,
  resolveTransportCandidates,
} from '../../../src/providers/channel/pinned-transport.js';
import {
  buildRepoTree,
  digestFor,
  makeRegistryRow,
  makeTmp,
  PREVIEW,
  type FixtureProviderSpec,
} from './helpers.js';

const VENDOR_URL = 'https://github.com/vilmire/adhdev-providers/archive/refs/heads/main.tar.gz';

const SPEC: FixtureProviderSpec = { category: 'cli', dirname: 'kimi-cli', type: 'kimi', version: '1.0.11' };

/** Commit SHAs for the modelled history, newest first (as GitHub returns them). */
const COMMIT_TIP = 'b'.repeat(40);
const COMMIT_PUBLISHED = 'a'.repeat(40);

describe('pinned provider transport', () => {
  it.each(['stable', 'preview'] as const)('first sync on %s uses the published commit with main >20 commits ahead and API rate limited', async (channel) => {
    const published = makeTmp('adhdev-immutable-published-');
    buildRepoTree(published, [SPEC]);
    const digest = digestFor(published, SPEC.category, SPEC.dirname);
    // Model 37 newer commits: none of their trees can satisfy the channel digest.
    const newer = Array.from({ length: 37 }, (_, i) => ({
      sha: (i + 1).toString(16).padStart(40, '0'), tree: makeTmp('adhdev-immutable-newer-'),
    }));
    for (const [i, commit] of newer.entries()) {
      buildRepoTree(commit.tree, [{ ...SPEC, files: { 'extra.md': `unpublished change ${i}` } }]);
    }
    const store = new ProviderChannelStore(makeTmp('adhdev-immutable-store-'));
    expect(store.getPointer(channel, SPEC.type)).toBeNull();
    const urls: string[] = [];
    let source = newer[36].tree;
    let apiCalls = 0;
    const runtime = new ProviderChannelRuntime({
      store, registryBaseUrl: 'https://registry.test/api/v1/registry', providerTarballUrl: VENDOR_URL,
      fetchJson: async () => ({ channel, providers: [{ ...makeRegistryRow(SPEC, digest), sourceCommit: COMMIT_PUBLISHED }] }),
      fetchTransportMetaJson: async () => { apiCalls++; throw new Error('HTTP 403 API rate limit exceeded'); },
      downloadFile: async (url) => {
        urls.push(url);
        source = url.includes(COMMIT_PUBLISHED) ? published : newer[36].tree;
      },
      extractTarball: async (_tar, dest) => { cpSync(source, join(dest, 'providers'), { recursive: true }); },
    });
    const report = await runtime.sync({ channel, targetTypes: new Set(), bootstrapAll: true });
    expect(report.errors).toEqual([]);
    expect(report.status).toBe('activated');
    expect(store.getPointer(channel, SPEC.type)?.active.digest).toBe(digest);
    expect(apiCalls).toBe(0);
    expect(urls).toEqual([buildPinnedArchiveUrl(parseGitHubArchiveUrl(VENDOR_URL)!, COMMIT_PUBLISHED)]);
  });

  it('fetches each entry from its own immutable commit in a mixed publication', async () => {
    const other: FixtureProviderSpec = { ...SPEC, type: 'other-cli', dirname: 'other-cli' };
    const first = makeTmp('adhdev-source-first-');
    const second = makeTmp('adhdev-source-second-');
    buildRepoTree(first, [SPEC]);
    buildRepoTree(second, [other]);
    const firstDigest = digestFor(first, SPEC.category, SPEC.dirname);
    const secondDigest = digestFor(second, other.category, other.dirname);
    const store = new ProviderChannelStore(makeTmp('adhdev-source-mixed-'));
    let source = first;
    const urls: string[] = [];
    const runtime = new ProviderChannelRuntime({
      store, registryBaseUrl: 'https://registry.test', providerTarballUrl: VENDOR_URL,
      fetchJson: async () => ({ channel: PREVIEW, providers: [
        { ...makeRegistryRow(SPEC, firstDigest), sourceCommit: COMMIT_PUBLISHED },
        { ...makeRegistryRow(other, secondDigest), sourceCommit: COMMIT_TIP },
      ] }),
      fetchTransportMetaJson: async () => { throw new Error('rate limited'); },
      downloadFile: async (url) => { urls.push(url); source = url.includes(COMMIT_PUBLISHED) ? first : second; },
      extractTarball: async (_tar, dest) => { cpSync(source, join(dest, 'providers'), { recursive: true }); },
    });
    const result = await runtime.sync({ channel: PREVIEW, targetTypes: new Set(), bootstrapAll: true });
    expect(result.errors).toEqual([]);
    expect(result.activated.map((a) => a.digest)).toEqual([firstDigest, secondDigest]);
    expect(urls).toHaveLength(2);
  });

  it.each(['404', 'structure'])('isolates a failed SHA group (%s), preserves LKG and cleans up while another SHA activates', async (failure) => {
    const other: FixtureProviderSpec = { ...SPEC, type: 'healthy-cli', dirname: 'healthy-cli' };
    const repo = makeTmp('adhdev-group-');
    buildRepoTree(repo, [SPEC, other]);
    const digest = digestFor(repo, SPEC.category, SPEC.dirname);
    const otherDigest = digestFor(repo, other.category, other.dirname);
    const store = new ProviderChannelStore(makeTmp('adhdev-group-store-'));
    let fail = false;
    let currentUrl = '';
    const urls: string[] = [];
    const runtime = new ProviderChannelRuntime({
      store, registryBaseUrl: 'https://registry.test', providerTarballUrl: VENDOR_URL,
      fetchJson: async () => ({ channel: PREVIEW, providers: [
        { ...makeRegistryRow(SPEC, fail ? `sha256:${'f'.repeat(64)}` : digest), sourceCommit: COMMIT_PUBLISHED },
        ...(fail ? [{ ...makeRegistryRow(other, otherDigest), sourceCommit: COMMIT_TIP }] : []),
      ] }),
      downloadFile: async (url) => {
        currentUrl = url; urls.push(url);
        if (fail && url.includes(COMMIT_PUBLISHED) && failure === '404') throw new Error('HTTP 404');
      },
      extractTarball: async (_tar, dest) => {
        if (fail && currentUrl.includes(COMMIT_PUBLISHED) && failure === 'structure') return;
        cpSync(repo, join(dest, 'providers'), { recursive: true });
      },
    });
    await runtime.sync({ channel: PREVIEW, targetTypes: new Set([SPEC.type]) });
    const lkg = store.getPointer(PREVIEW, SPEC.type);
    fail = true; urls.length = 0;
    const gc = vi.spyOn(store, 'gc');
    const cleanup = vi.spyOn(store, 'removeStagingDir');
    const report = await runtime.sync({ channel: PREVIEW, targetTypes: new Set(), bootstrapAll: true });
    expect(report.status).toBe('activated');
    expect(report.errors).toEqual([expect.objectContaining({ code: 'TRANSPORT_FAILED' })]);
    expect(report.activated.map((a) => a.providerType)).toEqual([other.type]);
    expect(store.getPointer(PREVIEW, SPEC.type)).toEqual(lkg);
    expect(store.getPointer(PREVIEW, other.type)?.active.digest).toBe(otherDigest);
    expect(urls).toHaveLength(2);
    expect(gc).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it.each(['main', 'A'.repeat(40), '', 123, {}, false])('rejects invalid sourceCommit %j without transport', async (sourceCommit) => {
    const store = new ProviderChannelStore(makeTmp('adhdev-invalid-source-'));
    const download = vi.fn();
    const runtime = new ProviderChannelRuntime({
      store, registryBaseUrl: 'https://registry.test', providerTarballUrl: VENDOR_URL,
      fetchJson: async () => ({ channel: PREVIEW, providers: [{ ...makeRegistryRow(SPEC, `sha256:${'a'.repeat(64)}`), sourceCommit }] }),
      downloadFile: download,
    });
    const report = await runtime.sync({ channel: PREVIEW, targetTypes: new Set(), bootstrapAll: true });
    expect(report.errors).toEqual([expect.objectContaining({ code: 'CHANNEL_METADATA_UNAVAILABLE', providerType: SPEC.type })]);
    expect(report.activated).toEqual([]);
    expect(download).not.toHaveBeenCalled();
  });

  it.each([true, false])('verifies a custom mirror tree with an immutable pin (matching=%s)', async (matching) => {
    const repo = makeTmp('adhdev-mirror-source-');
    buildRepoTree(repo, [SPEC]);
    const digest = digestFor(repo, SPEC.category, SPEC.dirname);
    const mirror = 'https://mirror.example/providers.tar.gz';
    const store = new ProviderChannelStore(makeTmp('adhdev-mirror-store-'));
    const download = vi.fn(async (_url: string, _dest: string) => {});
    const discovery = vi.fn(async () => { throw new Error('must not discover'); });
    const runtime = new ProviderChannelRuntime({
      store, registryBaseUrl: 'https://registry.test', providerTarballUrl: mirror,
      fetchJson: async () => ({ channel: PREVIEW, providers: [{ ...makeRegistryRow(SPEC, matching ? digest : `sha256:${'f'.repeat(64)}`), sourceCommit: COMMIT_PUBLISHED }] }),
      fetchTransportMetaJson: discovery, downloadFile: download,
      extractTarball: async (_tar, dest) => { cpSync(repo, join(dest, 'providers'), { recursive: true }); },
    });
    const report = await runtime.sync({ channel: PREVIEW, targetTypes: new Set(), bootstrapAll: true });
    expect(download.mock.calls[0][0]).toBe(mirror);
    expect(discovery).not.toHaveBeenCalled();
    expect(report.errors.map((e) => e.code)).toEqual(matching ? [] : ['DIGEST_MISMATCH']);
    expect(store.getPointer(PREVIEW, SPEC.type)?.active.digest ?? null).toBe(matching ? digest : null);
  });

  it('preserves the last known good pin when an immutable source serves mismatched bytes', async () => {
    const repo = makeTmp('adhdev-immutable-bad-');
    buildRepoTree(repo, [SPEC]);
    const digest = digestFor(repo, SPEC.category, SPEC.dirname);
    const store = new ProviderChannelStore(makeTmp('adhdev-immutable-lkg-'));
    let offeredDigest = digest;
    const runtime = new ProviderChannelRuntime({
      store, registryBaseUrl: 'https://registry.test', providerTarballUrl: VENDOR_URL,
      fetchJson: async () => ({ channel: PREVIEW, providers: [{ ...makeRegistryRow(SPEC, offeredDigest), sourceCommit: COMMIT_PUBLISHED }] }),
      fetchTransportMetaJson: async () => { throw new Error('rate limited'); },
      downloadFile: async () => {},
      extractTarball: async (_tar, dest) => { cpSync(repo, join(dest, 'providers'), { recursive: true }); },
    });
    expect((await runtime.sync({ channel: PREVIEW, targetTypes: new Set([SPEC.type]) })).status).toBe('activated');
    offeredDigest = `sha256:${'f'.repeat(64)}`;
    const failed = await runtime.sync({ channel: PREVIEW, targetTypes: new Set([SPEC.type]) });
    expect(failed.errors.map((e) => e.code)).toEqual(['DIGEST_MISMATCH']);
    expect(failed.activated).toEqual([]);
    expect(store.getPointer(PREVIEW, SPEC.type)?.active.digest).toBe(digest);
  });

  /**
   * GitHub #13 root cause: full-repo history diluted the pin walk with
   * unrelated commits (65 ahead) while only 17 touched the artifact path.
   * Path-filtered recovery must find the published tree; digest equality is
   * unchanged (generation/verification still require identical bytes).
   */
  it('recovers legacy rows via path-filtered history when full-repo lag exceeds 20', async () => {
    const repoAtPublished = makeTmp('adhdev-pin-path-published-');
    buildRepoTree(repoAtPublished, [SPEC]);
    const publishedDigest = digestFor(repoAtPublished, SPEC.category, SPEC.dirname);

    // 120 unrelated full-repo SHAs would exhaust a full-repo walk of 20/100;
    // path history has only tip + published (2 commits that touch the artifact).
    const unrelated = Array.from({ length: 120 }, (_, i) =>
      (i + 1).toString(16).padStart(40, '0'),
    );
    const pathTip = 'c'.repeat(40);
    const pathHistory = [{ sha: pathTip }, { sha: COMMIT_PUBLISHED }];
    expect(unrelated.length).toBeGreaterThan(MAX_HISTORY_CANDIDATES);

    const repoAtTip = makeTmp('adhdev-pin-path-tip-');
    buildRepoTree(repoAtTip, [{ ...SPEC, files: { 'extra.md': 'unpublished tip' } }]);

    const treeByCommit = new Map([
      [pathTip, repoAtTip],
      [COMMIT_PUBLISHED, repoAtPublished],
    ]);
    const apiUrls: string[] = [];
    const downloadedUrls: string[] = [];
    let servingCommit: string | null = null;
    const store = new ProviderChannelStore(makeTmp('adhdev-pin-path-store-'));
    const runtime = new ProviderChannelRuntime({
      store,
      registryBaseUrl: 'https://registry.test/api/v1/registry',
      providerTarballUrl: VENDOR_URL,
      fetchJson: async () => ({
        channel: 'preview',
        providers: [makeRegistryRow(SPEC, publishedDigest)],
      }),
      fetchTransportMetaJson: async (url) => {
        apiUrls.push(url);
        // Tip probe (limit:1, no path) vs physical-dir path history (dirname may
        // differ from manifest type — R3-01).
        if (!url.includes('path=')) return [{ sha: pathTip }];
        expect(url).toContain(`path=${encodeURIComponent(`${SPEC.category}/${SPEC.dirname}`)}`);
        return pathHistory;
      },
      downloadFile: async (url: string) => {
        downloadedUrls.push(url);
        servingCommit = /\/archive\/([0-9a-f]{40})\.tar\.gz$/.exec(url)?.[1] ?? null;
      },
      extractTarball: async (_tarPath: string, destDir: string) => {
        const source = servingCommit ? treeByCommit.get(servingCommit) : undefined;
        if (!source) throw new Error(`no tree for commit ${servingCommit}`);
        const inner = join(destDir, 'adhdev-providers-test');
        mkdirSync(inner, { recursive: true });
        cpSync(source, inner, { recursive: true });
      },
    });

    const report = await runtime.sync({ channel: PREVIEW, targetTypes: new Set([SPEC.type]) });
    expect(report.status).toBe('activated');
    expect(report.errors).toEqual([]);
    expect(report.activated[0].digest).toBe(publishedDigest);
    expect(apiUrls.length).toBeGreaterThan(0);
    expect(downloadedUrls.at(-1)).toContain(COMMIT_PUBLISHED);
  });

  it('paginates path history with constant per_page so page boundaries stay stable (R1-03)', async () => {
    const published = 'd'.repeat(40);
    const shas = Array.from({ length: 104 }, (_, i) =>
      (i + 1).toString(16).padStart(40, '0'),
    );
    shas.push(published);
    expect(shas.length).toBe(105);

    let pageHits = 0;
    const found = await listCandidateCommits(
      parseGitHubArchiveUrl(VENDOR_URL)!,
      async (url) => {
        pageHits += 1;
        const u = new URL(url);
        const page = Number(u.searchParams.get('page') || '1');
        const perPage = Number(u.searchParams.get('per_page') || '0');
        expect(perPage).toBe(100); // constant — never shrink on the last page
        expect(url).toContain('path=');
        const start = (page - 1) * perPage;
        return shas.slice(start, start + perPage).map((sha) => ({ sha }));
      },
      { paths: [`${SPEC.category}/${SPEC.type}`], limit: 105 },
    );
    expect(pageHits).toBe(2);
    expect(found).toHaveLength(105);
    expect(found[0]).toBe(shas[0]);
    expect(found.at(-1)).toBe(published);
  });

  it('full catalog bootstrap shares one tip archive then recovers path lag 17 (R2-02/R3-02)', async () => {
    // Prod stable had ~19 legacy rows. Shared tip download once; only the
    // unresolved target walks deeper (review R3-02). Path depth 17 still reaches
    // the published SHA (R2-02 / GitHub #13).
    const CATALOG = 19;
    const TARGET_DEPTH = 17;
    expect(TARGET_DEPTH).toBeGreaterThan(Math.ceil(MAX_HISTORY_CANDIDATES / CATALOG));
    expect(TARGET_DEPTH).toBeLessThanOrEqual(MIN_PER_PATH_HISTORY);

    const others: FixtureProviderSpec[] = Array.from({ length: CATALOG - 1 }, (_, i) => ({
      category: 'cli',
      dirname: `other-${i}-cli`,
      type: `other-${i}-cli`,
      version: '1.0.0',
    }));
    const target: FixtureProviderSpec = {
      category: 'cli', dirname: 'antigravity-cli', type: 'antigravity-cli', version: '1.2.18',
    };

    const publishedTree = makeTmp('adhdev-r2-published-');
    buildRepoTree(publishedTree, [target, ...others]);
    const tipTree = makeTmp('adhdev-r2-tip-');
    buildRepoTree(tipTree, [
      { ...target, files: { 'extra.md': 'unpublished tip edit' } },
      ...others.map((o) => ({ ...o, files: { 'n.md': 'tip' } })),
    ]);
    const publishedDigest = digestFor(publishedTree, target.category, target.dirname);
    const tipDigest = digestFor(tipTree, target.category, target.dirname);
    expect(tipDigest).not.toBe(publishedDigest);

    const PUBLISHED = 'a'.repeat(40);
    const tipShas = Array.from({ length: TARGET_DEPTH }, (_, i) =>
      (i + 1).toString(16).padStart(40, '0'),
    );
    const TIP = tipShas[0];
    const targetHistory = [...tipShas, PUBLISHED];
    expect(targetHistory).toHaveLength(TARGET_DEPTH + 1);

    const treeByCommit = new Map<string, string>([
      [PUBLISHED, publishedTree],
      ...tipShas.map((sha) => [sha, tipTree] as const),
    ]);
    let serving: string | null = null;
    const downloadedUrls: string[] = [];
    const store = new ProviderChannelStore(makeTmp('adhdev-r2-catalog-store-'));
    const runtime = new ProviderChannelRuntime({
      store,
      registryBaseUrl: 'https://registry.test/api/v1/registry',
      providerTarballUrl: VENDOR_URL,
      fetchJson: async () => ({
        channel: 'preview',
        providers: [
          makeRegistryRow(target, publishedDigest),
          ...others.map((o) => makeRegistryRow(o, digestFor(tipTree, o.category, o.dirname))),
        ],
      }),
      fetchTransportMetaJson: async (url) => {
        if (!url.includes('path=')) return [{ sha: TIP }];
        if (url.includes(encodeURIComponent('cli/antigravity-cli'))) {
          return targetHistory.map((sha) => ({ sha }));
        }
        return Array.from({ length: 50 }, (_, i) => ({
          sha: ((i + 1) * 16).toString(16).padStart(40, '0'),
        }));
      },
      downloadFile: async (url) => {
        downloadedUrls.push(url);
        serving = /\/archive\/([0-9a-f]{40})\.tar\.gz$/.exec(url)?.[1] ?? null;
      },
      extractTarball: async (_tar, dest) => {
        const source = serving ? treeByCommit.get(serving) : tipTree;
        const inner = join(dest, 'adhdev-providers-test');
        mkdirSync(inner, { recursive: true });
        cpSync(source ?? tipTree, inner, { recursive: true });
      },
    });
    const report = await runtime.sync({
      channel: PREVIEW,
      targetTypes: new Set(),
      bootstrapAll: true,
    });
    expect(report.errors.filter((e) => e.providerType === target.type)).toEqual([]);
    expect(store.getPointer(PREVIEW, target.type)?.active.digest).toBe(publishedDigest);
    // One shared tip + one download per deeper candidate for the unresolved target
    // (not CATALOG × history). Tip SHA is not re-downloaded.
    expect(downloadedUrls.filter((u) => u.includes(TIP)).length).toBe(1);
    expect(downloadedUrls.length).toBeLessThan(CATALOG * 2);
    expect(downloadedUrls.length).toBe(1 + TARGET_DEPTH); // tip + 16 older tips + published
  });

  it('shared mirror URL downloads once for a full legacy catalog (R3-02)', async () => {
    const specs: FixtureProviderSpec[] = Array.from({ length: 19 }, (_, i) => ({
      category: 'cli', dirname: `p${i}-cli`, type: `p${i}-cli`, version: '1.0.0',
    }));
    const repo = makeTmp('adhdev-shared-mirror-');
    buildRepoTree(repo, specs);
    const downloads: string[] = [];
    const store = new ProviderChannelStore(makeTmp('adhdev-shared-mirror-store-'));
    const mirror = 'https://mirror.test/providers.tar.gz';
    const runtime = new ProviderChannelRuntime({
      store,
      registryBaseUrl: 'https://registry.test/api/v1/registry',
      providerTarballUrl: mirror,
      fetchJson: async () => ({
        channel: 'preview',
        providers: specs.map((s) => makeRegistryRow(s, digestFor(repo, s.category, s.dirname))),
      }),
      downloadFile: async (url) => { downloads.push(url); },
      extractTarball: async (_tar, dest) => {
        const inner = join(dest, 'adhdev-providers-test');
        mkdirSync(inner, { recursive: true });
        cpSync(repo, inner, { recursive: true });
      },
    });
    const report = await runtime.sync({
      channel: PREVIEW,
      targetTypes: new Set(),
      bootstrapAll: true,
    });
    expect(report.errors).toEqual([]);
    expect(report.activated).toHaveLength(19);
    expect(downloads).toEqual([mirror]);
  });

  it('recovers a pre-rename publish commit after nonempty current-path history (R4-01)', async () => {
    // Published under cli/old-widget-cli; tip renamed to cli/new-widget-cli.
    // Current-path history is nonempty but omits the publish SHA; full-repo
    // fallback must still find it (digest includes the relative path).
    const type = 'widget';
    const oldSpec: FixtureProviderSpec = {
      category: 'cli', dirname: 'old-widget-cli', type, version: '1.0.0',
    };
    const newSpec: FixtureProviderSpec = {
      category: 'cli', dirname: 'new-widget-cli', type, version: '1.0.1',
      files: { 'renamed.md': 'after rename' },
    };
    const published = makeTmp('adhdev-r4-rename-pub-');
    buildRepoTree(published, [oldSpec]);
    const tip = makeTmp('adhdev-r4-rename-tip-');
    buildRepoTree(tip, [newSpec]);
    const mid = makeTmp('adhdev-r4-rename-mid-');
    buildRepoTree(mid, [{ ...newSpec, files: { 'renamed.md': 'mid' } }]);
    const publishedDigest = digestFor(published, oldSpec.category, oldSpec.dirname);
    expect(digestFor(tip, newSpec.category, newSpec.dirname)).not.toBe(publishedDigest);

    const TIP = 'b'.repeat(40);
    const MID = 'c'.repeat(40);
    const PUBLISHED = 'a'.repeat(40);
    const physical = `${newSpec.category}/${newSpec.dirname}`;
    let serving: string | null = null;
    let peak = 0;
    const retained = new Set<string>();
    const store = new ProviderChannelStore(makeTmp('adhdev-r4-rename-store-'));
    const runtime = new ProviderChannelRuntime({
      store,
      registryBaseUrl: 'https://registry.test/api/v1/registry',
      providerTarballUrl: VENDOR_URL,
      fetchJson: async () => ({
        channel: 'preview',
        providers: [makeRegistryRow(newSpec, publishedDigest)],
      }),
      fetchTransportMetaJson: async (url) => {
        if (!url.includes('path=')) {
          // Tip probe + full-repo fallback both omit path=.
          return [{ sha: TIP }, { sha: MID }, { sha: PUBLISHED }];
        }
        expect(url).toContain(encodeURIComponent(physical));
        // Nonempty current-path history that does NOT include PUBLISHED.
        return [{ sha: TIP }, { sha: MID }];
      },
      downloadFile: async (url) => {
        serving = /\/archive\/([0-9a-f]{40})\.tar\.gz$/.exec(url)?.[1] ?? null;
        if (serving) {
          retained.add(serving);
          peak = Math.max(peak, retained.size);
        }
      },
      extractTarball: async (_tar, dest) => {
        const source = serving === PUBLISHED ? published : serving === MID ? mid : tip;
        const inner = join(dest, 'adhdev-providers-test');
        mkdirSync(inner, { recursive: true });
        cpSync(source, inner, { recursive: true });
      },
    });
    // Patch release observation: peakRetainedArchives is stamped on the report.
    const report = await runtime.sync({
      channel: PREVIEW,
      targetTypes: new Set([type]),
    });
    expect(report.errors).toEqual([]);
    expect(store.getPointer(PREVIEW, type)?.active.digest).toBe(publishedDigest);
    const stamped = (report as { _peakRetainedArchives?: number })._peakRetainedArchives;
    expect(stamped).toBeLessThanOrEqual(2); // tip + one historical (R4-02)
  });

  it('activates two legacy rows that both require the same historical SHA (R5-01)', async () => {
    // Tip mismatches both rows; published digests live only at historical H.
    // Row A must not ban H for row B (global triedUrls regression).
    const alpha: FixtureProviderSpec = {
      category: 'cli', dirname: 'alpha-cli', type: 'alpha-cli', version: '1.0.0',
    };
    const beta: FixtureProviderSpec = {
      category: 'cli', dirname: 'beta-cli', type: 'beta-cli', version: '1.0.0',
    };
    const published = makeTmp('adhdev-r5-shared-pub-');
    buildRepoTree(published, [alpha, beta]);
    const tip = makeTmp('adhdev-r5-shared-tip-');
    buildRepoTree(tip, [
      { ...alpha, files: { 'tip.md': 'alpha tip drift' } },
      { ...beta, files: { 'tip.md': 'beta tip drift' } },
    ]);
    const alphaDigest = digestFor(published, alpha.category, alpha.dirname);
    const betaDigest = digestFor(published, beta.category, beta.dirname);
    expect(digestFor(tip, alpha.category, alpha.dirname)).not.toBe(alphaDigest);
    expect(digestFor(tip, beta.category, beta.dirname)).not.toBe(betaDigest);

    const TIP = 'b'.repeat(40);
    const HIST = 'a'.repeat(40);
    const downloaded = new Set<string>();
    let serving: string | null = null;
    const store = new ProviderChannelStore(makeTmp('adhdev-r5-shared-store-'));
    const runtime = new ProviderChannelRuntime({
      store,
      registryBaseUrl: 'https://registry.test/api/v1/registry',
      providerTarballUrl: VENDOR_URL,
      fetchJson: async () => ({
        channel: 'preview',
        providers: [
          makeRegistryRow(alpha, alphaDigest),
          makeRegistryRow(beta, betaDigest),
        ],
      }),
      fetchTransportMetaJson: async (url) => {
        if (!url.includes('path=')) return [{ sha: TIP }, { sha: HIST }];
        return [{ sha: TIP }, { sha: HIST }];
      },
      downloadFile: async (url) => {
        serving = /\/archive\/([0-9a-f]{40})\.tar\.gz$/.exec(url)?.[1] ?? null;
        if (serving) downloaded.add(serving);
      },
      extractTarball: async (_tar, dest) => {
        const source = serving === HIST ? published : tip;
        const inner = join(dest, 'adhdev-providers-test');
        mkdirSync(inner, { recursive: true });
        cpSync(source, inner, { recursive: true });
      },
    });
    const report = await runtime.sync({
      channel: PREVIEW,
      targetTypes: new Set([alpha.type, beta.type]),
    });
    expect(report.errors).toEqual([]);
    expect(store.getPointer(PREVIEW, alpha.type)?.active.digest).toBe(alphaDigest);
    expect(store.getPointer(PREVIEW, beta.type)?.active.digest).toBe(betaDigest);
    // Shared tip + one historical staging pass for both rows.
    expect(downloaded.has(TIP)).toBe(true);
    expect(downloaded.has(HIST)).toBe(true);
    expect((report as { _peakRetainedArchives?: number })._peakRetainedArchives).toBeLessThanOrEqual(2);
  });

  it('keeps typed path-history staging failure and never opens repo fallback (R5-02)', async () => {
    // Tip mismatches → path candidate H fails object staging (EACCES). A
    // distinct full-repo fallback SHA must never be fetched, and the report
    // must retain TRANSPORT_FAILED (not ENTRY_ARTIFACT_NOT_FOUND from fallback).
    const spec: FixtureProviderSpec = {
      category: 'cli', dirname: 'lease-cli', type: 'lease-cli', version: '1.0.0',
    };
    const tip = makeTmp('adhdev-r5-term-tip-');
    buildRepoTree(tip, [{ ...spec, files: { 'tip.md': 'drift' } }]);
    const hist = makeTmp('adhdev-r5-term-hist-');
    buildRepoTree(hist, [spec]);
    const publishedDigest = digestFor(hist, spec.category, spec.dirname);
    expect(digestFor(tip, spec.category, spec.dirname)).not.toBe(publishedDigest);

    const TIP = 'b'.repeat(40);
    const PATH_HIST = 'a'.repeat(40);
    const REPO_FALLBACK = 'c'.repeat(40);
    const physical = `${spec.category}/${spec.dirname}`;
    const metaCalls: string[] = [];
    const downloaded = new Set<string>();
    let serving: string | null = null;
    const store = new ProviderChannelStore(makeTmp('adhdev-r5-term-store-'));
    const origCreate = store.createStagingDir.bind(store);
    // Tip must complete DIGEST_MISMATCH (enter history). Fail only on the
    // subsequent historical object-staging attempt.
    let objStagingCalls = 0;
    store.createStagingDir = ((kind: string) => {
      if (kind.startsWith(`obj-${spec.type}`)) {
        objStagingCalls += 1;
        if (objStagingCalls > 1) {
          const err = new Error('EACCES: permission denied');
          (err as NodeJS.ErrnoException).code = 'EACCES';
          throw err;
        }
      }
      return origCreate(kind);
    }) as typeof store.createStagingDir;

    const runtime = new ProviderChannelRuntime({
      store,
      registryBaseUrl: 'https://registry.test/api/v1/registry',
      providerTarballUrl: VENDOR_URL,
      fetchJson: async () => ({
        channel: 'preview',
        providers: [makeRegistryRow(spec, publishedDigest)],
      }),
      fetchTransportMetaJson: async (url) => {
        metaCalls.push(url.includes('path=') ? `path:${new URL(url).searchParams.get('path')}` : 'repo');
        if (!url.includes('path=')) {
          // Tip probe (limit=1) vs full-repo fallback — both omit path=.
          return [{ sha: TIP }, { sha: PATH_HIST }, { sha: REPO_FALLBACK }];
        }
        expect(url).toContain(encodeURIComponent(physical));
        return [{ sha: TIP }, { sha: PATH_HIST }];
      },
      downloadFile: async (url) => {
        serving = /\/archive\/([0-9a-f]{40})\.tar\.gz$/.exec(url)?.[1] ?? null;
        if (serving) downloaded.add(serving);
        if (serving === REPO_FALLBACK) {
          throw new Error(`repo fallback archive must never be fetched: ${url}`);
        }
      },
      extractTarball: async (_tar, dest) => {
        const source = serving === PATH_HIST ? hist : tip;
        const inner = join(dest, 'adhdev-providers-test');
        mkdirSync(inner, { recursive: true });
        cpSync(source, inner, { recursive: true });
      },
    });
    const report = await runtime.sync({
      channel: PREVIEW,
      targetTypes: new Set([spec.type]),
    });
    expect(report.status).toBe('error');
    expect(report.errors).toEqual([
      expect.objectContaining({ providerType: spec.type, code: 'TRANSPORT_FAILED' }),
    ]);
    expect(downloaded.has(REPO_FALLBACK)).toBe(false);
    // Tip probe once; path history once; no second path-less (repo) walk.
    expect(metaCalls.filter((c) => c === 'repo')).toHaveLength(1);
    expect(metaCalls.some((c) => c.startsWith('path:'))).toBe(true);
  });

  it('bounds peak retained staging during a deep mismatch walk (R4-02)', async () => {
    const spec: FixtureProviderSpec = {
      category: 'cli', dirname: 'deep-cli', type: 'deep-cli', version: '1.0.0',
    };
    const tipTree = makeTmp('adhdev-r4-peak-tip-');
    buildRepoTree(tipTree, [{ ...spec, files: { 'n.md': 'tip' } }]);
    const wrongDigest = `sha256:${'f'.repeat(64)}`;
    const shas = Array.from({ length: 12 }, (_, i) =>
      (i + 1).toString(16).padStart(40, '0'),
    );
    const TIP = shas[0];
    let serving: string | null = null;
    const store = new ProviderChannelStore(makeTmp('adhdev-r4-peak-store-'));
    const runtime = new ProviderChannelRuntime({
      store,
      registryBaseUrl: 'https://registry.test/api/v1/registry',
      providerTarballUrl: VENDOR_URL,
      fetchJson: async () => ({
        channel: 'preview',
        providers: [makeRegistryRow(spec, wrongDigest)],
      }),
      fetchTransportMetaJson: async (url) => {
        if (!url.includes('path=')) return shas.map((sha) => ({ sha }));
        return shas.map((sha) => ({ sha }));
      },
      downloadFile: async (url) => {
        serving = /\/archive\/([0-9a-f]{40})\.tar\.gz$/.exec(url)?.[1] ?? null;
      },
      extractTarball: async (_tar, dest) => {
        const inner = join(dest, 'adhdev-providers-test');
        mkdirSync(inner, { recursive: true });
        cpSync(tipTree, inner, { recursive: true });
      },
    });
    const report = await runtime.sync({
      channel: PREVIEW,
      targetTypes: new Set([spec.type]),
    });
    expect(report.status).toBe('error');
    expect(report.errors.map((e) => e.code)).toEqual(['DIGEST_MISMATCH']);
    expect((report as { _peakRetainedArchives?: number })._peakRetainedArchives).toBeLessThanOrEqual(2);
    expect(serving === null || serving === TIP || shas.includes(serving)).toBe(true);
  });

  it('recovers when dirname ≠ type via full-repo fallback for empty type-path (R3-01)', async () => {
    // Manifest type `kimi` lives in dirname `kimi-cli`. Tip lacks the artifact
    // so physical dirname is unknown; history for cli/kimi is empty and must
    // fall back to bounded full-repo commits that still include the publish SHA.
    const spec: FixtureProviderSpec = {
      category: 'cli', dirname: 'kimi-cli', type: 'kimi', version: '1.0.11',
    };
    const published = makeTmp('adhdev-r3-dirname-pub-');
    buildRepoTree(published, [spec]);
    const tipEmpty = makeTmp('adhdev-r3-dirname-tip-');
    buildRepoTree(tipEmpty, []); // no artifact at tip
    const publishedDigest = digestFor(published, spec.category, spec.dirname);
    const TIP = 'b'.repeat(40);
    const PUBLISHED = 'a'.repeat(40);
    const store = new ProviderChannelStore(makeTmp('adhdev-r3-dirname-store-'));
    let serving: string | null = null;
    const pathQueries: string[] = [];
    const runtime = new ProviderChannelRuntime({
      store,
      registryBaseUrl: 'https://registry.test/api/v1/registry',
      providerTarballUrl: VENDOR_URL,
      fetchJson: async () => ({
        channel: 'preview',
        providers: [makeRegistryRow(spec, publishedDigest)],
      }),
      fetchTransportMetaJson: async (url) => {
        if (!url.includes('path=')) return [{ sha: TIP }, { sha: PUBLISHED }];
        const pathParam = new URL(url).searchParams.get('path') ?? '';
        pathQueries.push(pathParam);
        if (pathParam === `${spec.category}/${spec.type}`) return [];
        // Full-repo fallback (path=null) is a separate request without path=.
        return [{ sha: TIP }, { sha: PUBLISHED }];
      },
      downloadFile: async (url) => {
        serving = /\/archive\/([0-9a-f]{40})\.tar\.gz$/.exec(url)?.[1] ?? null;
      },
      extractTarball: async (_tar, dest) => {
        const source = serving === PUBLISHED ? published : tipEmpty;
        const inner = join(dest, 'adhdev-providers-test');
        mkdirSync(inner, { recursive: true });
        cpSync(source, inner, { recursive: true });
      },
    });
    const report = await runtime.sync({
      channel: PREVIEW,
      targetTypes: new Set([spec.type]),
    });
    expect(pathQueries).toContain(`${spec.category}/${spec.type}`);
    expect(report.errors).toEqual([]);
    expect(store.getPointer(PREVIEW, spec.type)?.active.digest).toBe(publishedDigest);
  });

  it('round-robins multi-path history and retries ENTRY_ARTIFACT_NOT_FOUND (R1-02)', async () => {
    const alpha: FixtureProviderSpec = {
      category: 'cli', dirname: 'alpha-cli', type: 'alpha-cli', version: '1.0.0',
    };
    const beta: FixtureProviderSpec = {
      category: 'cli', dirname: 'beta-cli', type: 'beta-cli', version: '1.0.0',
    };
    const oldOnly = makeTmp('adhdev-multi-old-');
    buildRepoTree(oldOnly, [alpha]);
    const both = makeTmp('adhdev-multi-both-');
    buildRepoTree(both, [alpha, beta]);
    const alphaDigest = digestFor(oldOnly, alpha.category, alpha.dirname);
    const betaDigest = digestFor(both, beta.category, beta.dirname);
    expect(digestFor(both, alpha.category, alpha.dirname)).toBe(alphaDigest);

    const COMMIT_OLD = '1'.repeat(40);
    const COMMIT_NEW = '2'.repeat(40);
    // Alpha path lists OLD first (deep history); beta path lists NEW tip.
    // Round-robin places NEW early; ENTRY_ARTIFACT_NOT_FOUND on OLD must retry.
    const treeByCommit = new Map([[COMMIT_OLD, oldOnly], [COMMIT_NEW, both]]);
    let serving: string | null = null;
    const store = new ProviderChannelStore(makeTmp('adhdev-multi-store-'));
    const runtime = new ProviderChannelRuntime({
      store,
      registryBaseUrl: 'https://registry.test/api/v1/registry',
      providerTarballUrl: VENDOR_URL,
      fetchJson: async () => ({
        channel: 'preview',
        providers: [
          makeRegistryRow(alpha, alphaDigest),
          makeRegistryRow(beta, betaDigest),
        ],
      }),
      fetchTransportMetaJson: async (url) => {
        if (url.includes(encodeURIComponent('cli/beta-cli'))) return [{ sha: COMMIT_NEW }];
        return [{ sha: COMMIT_OLD }, { sha: COMMIT_NEW }];
      },
      downloadFile: async (url) => {
        serving = /\/archive\/([0-9a-f]{40})\.tar\.gz$/.exec(url)?.[1] ?? null;
      },
      extractTarball: async (_tar, dest) => {
        const source = serving ? treeByCommit.get(serving) : undefined;
        if (!source) throw new Error(`no tree for ${serving}`);
        const inner = join(dest, 'adhdev-providers-test');
        mkdirSync(inner, { recursive: true });
        cpSync(source, inner, { recursive: true });
      },
    });
    const report = await runtime.sync({
      channel: PREVIEW,
      targetTypes: new Set(),
      bootstrapAll: true,
    });
    expect(report.errors).toEqual([]);
    expect(report.status).toBe('activated');
    expect(store.getPointer(PREVIEW, alpha.type)?.active.digest).toBe(alphaDigest);
    expect(store.getPointer(PREVIEW, beta.type)?.active.digest).toBe(betaDigest);
  });

  it('still fails closed when path history exceeds the bound without a matching digest', async () => {
    const repo = makeTmp('adhdev-pin-path-nomatch-');
    buildRepoTree(repo, [SPEC]);
    const onlyTip = Array.from({ length: 5 }, (_, i) => ({
      sha: (i + 1).toString(16).padStart(40, '0'),
    }));
    const store = new ProviderChannelStore(makeTmp('adhdev-pin-path-nomatch-store-'));
    const runtime = new ProviderChannelRuntime({
      store,
      registryBaseUrl: 'https://registry.test/api/v1/registry',
      providerTarballUrl: VENDOR_URL,
      fetchJson: async () => ({
        channel: 'preview',
        providers: [makeRegistryRow(SPEC, `sha256:${'f'.repeat(64)}`)],
      }),
      fetchTransportMetaJson: async () => onlyTip,
      downloadFile: async () => {},
      extractTarball: async (_tar, dest) => {
        const inner = join(dest, 'adhdev-providers-test');
        mkdirSync(inner, { recursive: true });
        cpSync(repo, inner, { recursive: true });
      },
    });
    const report = await runtime.sync({ channel: PREVIEW, targetTypes: new Set([SPEC.type]) });
    expect(report.status).toBe('error');
    expect(report.activated).toEqual([]);
    expect(report.errors.map((e) => e.code)).toEqual(['DIGEST_MISMATCH']);
  });

  it('mid-body disconnect retries through ProviderChannelSync syncTail (R3-04)', async () => {
    let hits = 0;
    const server = createServer((req, res) => {
      hits += 1;
      if (hits % 2 === 1) {
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        res.write('partial-bytes', () => {
          setTimeout(() => res.destroy(), 20);
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/gzip' });
      res.end('ok-full-body');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('expected TCP address');
    const base = `http://127.0.0.1:${addr.port}`;
    const published = makeTmp('adhdev-synctail-pub-');
    buildRepoTree(published, [SPEC]);
    const digest = digestFor(published, SPEC.category, SPEC.dirname);
    const store = new ProviderChannelStore(makeTmp('adhdev-synctail-store-'));
    const host: ProviderChannelSyncHost = {
      upstreamDir: makeTmp('adhdev-synctail-up-'),
      defaultProvidersDir: makeTmp('adhdev-synctail-prov-'),
      log: () => {},
      reload: () => {},
      loadDir: () => 0,
      hasLoadedProvider: () => false,
      hasUpstream: () => false,
      providerSourceDir: () => null,
      detectedCliVersion: () => null,
    };
    let syncHits = 0;
    const sync = new ProviderChannelSync(host, store, {
      channel: PREVIEW,
      channelIsExplicit: true,
      registryBaseUrl: 'https://registry.test/api/v1/registry',
      providerTarballUrl: `${base}/providers.tar.gz`,
      logFn: () => {},
      daemonVersion: '1.0.81',
      channelSyncIO: {
        fetchJson: async () => ({
          channel: 'preview',
          providers: [makeRegistryRow(SPEC, digest)],
        }),
        downloadFile: downloadProviderArchive,
        extractTarball: async (_tar, dest) => {
          syncHits += 1;
          const inner = join(dest, 'adhdev-providers-test');
          mkdirSync(inner, { recursive: true });
          cpSync(published, inner, { recursive: true });
        },
      },
    });
    try {
      const failReport = await sync.syncVerifiedChannel({
        onlyTargetTypes: [SPEC.type],
        mode: 'explicit',
      });
      expect(failReport.status).toBe('error');
      expect(failReport.errors.some((e) => e.code === 'TRANSPORT_FAILED')).toBe(true);
      expect(syncHits).toBe(0);
      const okReport = await sync.syncVerifiedChannel({
        onlyTargetTypes: [SPEC.type],
        mode: 'explicit',
      });
      expect(okReport.status).toBe('activated');
      expect(syncHits).toBe(1);
      expect(store.getPointer(PREVIEW, SPEC.type)?.active.digest).toBe(digest);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('mid-body disconnect rejects download and a later sync still runs (R1-04/R2-03)', async () => {
    let hits = 0;
    const server = createServer((req, res) => {
      hits += 1;
      if (hits % 2 === 1) {
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        // Write partial body, then destroy after the drain callback so the
        // client has attached pipeline and received bytes (R2-03).
        res.write('partial-bytes', () => {
          setTimeout(() => res.destroy(), 20);
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/gzip' });
      res.end('ok-full-body');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('expected TCP address');
    const base = `http://127.0.0.1:${addr.port}`;
    const dir = join(tmpdir(), `adhdev-midbody-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const dest1 = join(dir, 'first.tar.gz');
    const dest2 = join(dir, 'second.tar.gz');
    try {
      await expect(downloadProviderArchive(`${base}/providers.tar.gz`, dest1)).rejects.toThrow();
      expect(existsSync(dest1)).toBe(false);
      expect(existsSync(`${dest1}.${process.pid}.part`)).toBe(false);
      await downloadProviderArchive(`${base}/providers.tar.gz`, dest2);
      expect(readFileSync(dest2, 'utf-8')).toBe('ok-full-body');

      // Same runtime instance: fail then succeed (serialized syncTail reuse).
      const published = makeTmp('adhdev-midbody-pub-');
      buildRepoTree(published, [SPEC]);
      const digest = digestFor(published, SPEC.category, SPEC.dirname);
      let syncHits = 0;
      hits = 0;
      const store = new ProviderChannelStore(makeTmp('adhdev-midbody-store-'));
      const runtime = new ProviderChannelRuntime({
        store,
        registryBaseUrl: 'https://registry.test/api/v1/registry',
        providerTarballUrl: `${base}/providers.tar.gz`,
        fetchJson: async () => ({
          channel: 'preview',
          providers: [makeRegistryRow(SPEC, digest)],
        }),
        fetchTransportMetaJson: async () => [{ sha: COMMIT_PUBLISHED }],
        downloadFile: downloadProviderArchive,
        extractTarball: async (_tar, dest) => {
          syncHits += 1;
          const inner = join(dest, 'adhdev-providers-test');
          mkdirSync(inner, { recursive: true });
          cpSync(published, inner, { recursive: true });
        },
      });
      const failReport = await runtime.sync({
        channel: PREVIEW,
        targetTypes: new Set([SPEC.type]),
      });
      expect(failReport.status).toBe('error');
      expect(failReport.errors.some((e) => e.code === 'TRANSPORT_FAILED')).toBe(true);
      expect(syncHits).toBe(0);

      const okReport = await runtime.sync({
        channel: PREVIEW,
        targetTypes: new Set([SPEC.type]),
      });
      expect(okReport.status).toBe('activated');
      expect(okReport.errors).toEqual([]);
      expect(syncHits).toBe(1);
      expect(store.getPointer(PREVIEW, SPEC.type)?.active.digest).toBe(digest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('discardDownloadPartial never deletes a promoted final archive', () => {
    const dir = join(tmpdir(), `adhdev-dl-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, 'providers.tar.gz');
    const partial = `${dest}.${process.pid}.part`;
    try {
      writeFileSync(partial, 'archive-bytes', 'utf-8');
      promoteDownloadPartial(partial, dest);
      expect(existsSync(dest)).toBe(true);
      expect(existsSync(partial)).toBe(false);
      discardDownloadPartial(partial); // leftover cleanup after success must be a no-op
      expect(existsSync(dest)).toBe(true);
      expect(readFileSync(dest, 'utf-8')).toBe('archive-bytes');
      // Failed-run cleanup removes only the partial, never a sibling final.
      writeFileSync(partial, 'corrupt', 'utf-8');
      discardDownloadPartial(partial);
      expect(existsSync(partial)).toBe(false);
      expect(readFileSync(dest, 'utf-8')).toBe('archive-bytes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * ★ The property: a push to main must not invalidate an already-published
   * registry row.
   */
  it('still activates a published row after an unpublished push moves main', async () => {
    // Commit A — the tree the registry published a digest for.
    const repoAtPublished = makeTmp('adhdev-pin-published-');
    buildRepoTree(repoAtPublished, [SPEC]);
    const publishedDigest = digestFor(repoAtPublished, SPEC.category, SPEC.dirname);

    // Commit B — someone edits the provider and pushes to main WITHOUT
    // republishing. Different bytes ⇒ genuinely different tree digest.
    const repoAtTip = makeTmp('adhdev-pin-tip-');
    buildRepoTree(repoAtTip, [{ ...SPEC, files: { 'extra.md': 'unpublished edit pushed to main' } }]);
    const tipDigest = digestFor(repoAtTip, SPEC.category, SPEC.dirname);
    expect(tipDigest).not.toBe(publishedDigest); // the push really did change the tree

    const treeByCommit = new Map([
      [COMMIT_TIP, repoAtTip],
      [COMMIT_PUBLISHED, repoAtPublished],
    ]);

    const downloadedUrls: string[] = [];
    let servingCommit: string | null = null;

    const store = new ProviderChannelStore(makeTmp('adhdev-pin-store-'));
    const runtime = new ProviderChannelRuntime({
      store,
      registryBaseUrl: 'https://registry.test/api/v1/registry',
      providerTarballUrl: VENDOR_URL,
      // Registry seam: publishes the digest frozen at commit A.
      fetchJson: async () => ({
        channel: 'preview',
        providers: [makeRegistryRow(SPEC, publishedDigest)],
      }),
      // Transport-meta seam: GitHub commit history, newest first.
      fetchTransportMetaJson: async () => [{ sha: COMMIT_TIP }, { sha: COMMIT_PUBLISHED }],
      downloadFile: async (url: string) => {
        downloadedUrls.push(url);
        // Serve the bytes of whichever commit the URL pins to — as GitHub does.
        const sha = /\/archive\/([0-9a-f]{40})\.tar\.gz$/.exec(url)?.[1] ?? null;
        servingCommit = sha;
      },
      extractTarball: async (_tarPath: string, destDir: string) => {
        const source = servingCommit ? treeByCommit.get(servingCommit) : undefined;
        if (!source) throw new Error(`no tree for commit ${servingCommit}`);
        const inner = join(destDir, 'adhdev-providers-test');
        mkdirSync(inner, { recursive: true });
        cpSync(source, inner, { recursive: true });
      },
    });

    const report = await runtime.sync({ channel: PREVIEW, targetTypes: new Set([SPEC.type]) });

    // The property: the published row activated, despite main having moved.
    expect(report.status).toBe('activated');
    expect(report.errors).toEqual([]);
    expect(report.activated.map((a) => a.providerType)).toEqual([SPEC.type]);
    // And it activated at the PUBLISHED digest — not whatever main happens to
    // hold. This is what makes the assertion about identity, not liveness.
    expect(report.activated[0].digest).toBe(publishedDigest);

    // It reached the published commit by walking back from the tip, and every
    // fetch was commit-pinned — never the moving ref.
    expect(downloadedUrls).toEqual([
      buildPinnedArchiveUrl(parseGitHubArchiveUrl(VENDOR_URL)!, COMMIT_TIP),
      buildPinnedArchiveUrl(parseGitHubArchiveUrl(VENDOR_URL)!, COMMIT_PUBLISHED),
    ]);
    expect(downloadedUrls.some((u) => u.includes('refs/heads/main'))).toBe(false);
  });

  /**
   * The common case must not pay for the fallback: when the registry and main
   * agree, exactly one download happens.
   */
  it('downloads once when the tip already matches the published digest', async () => {
    const repo = makeTmp('adhdev-pin-agree-');
    buildRepoTree(repo, [SPEC]);
    const publishedDigest = digestFor(repo, SPEC.category, SPEC.dirname);

    const downloadedUrls: string[] = [];
    const store = new ProviderChannelStore(makeTmp('adhdev-pin-store2-'));
    const runtime = new ProviderChannelRuntime({
      store,
      registryBaseUrl: 'https://registry.test/api/v1/registry',
      providerTarballUrl: VENDOR_URL,
      fetchJson: async () => ({ channel: 'preview', providers: [makeRegistryRow(SPEC, publishedDigest)] }),
      fetchTransportMetaJson: async () => [{ sha: COMMIT_TIP }, { sha: COMMIT_PUBLISHED }],
      downloadFile: async (url: string) => { downloadedUrls.push(url); },
      extractTarball: async (_tarPath: string, destDir: string) => {
        const inner = join(destDir, 'adhdev-providers-test');
        mkdirSync(inner, { recursive: true });
        cpSync(repo, inner, { recursive: true });
      },
    });

    const report = await runtime.sync({ channel: PREVIEW, targetTypes: new Set([SPEC.type]) });
    expect(report.status).toBe('activated');
    expect(downloadedUrls).toHaveLength(1);
    expect(downloadedUrls[0]).toContain(COMMIT_TIP);
  });

  /**
   * Fail-closed is preserved: exhausting history never activates an unverified
   * tree. A digest that no commit reproduces stays a DIGEST_MISMATCH.
   */
  it('still fails closed when no commit reproduces the published digest', async () => {
    const repo = makeTmp('adhdev-pin-nomatch-');
    buildRepoTree(repo, [SPEC]);

    const store = new ProviderChannelStore(makeTmp('adhdev-pin-store3-'));
    const runtime = new ProviderChannelRuntime({
      store,
      registryBaseUrl: 'https://registry.test/api/v1/registry',
      providerTarballUrl: VENDOR_URL,
      fetchJson: async () => ({ channel: 'preview', providers: [makeRegistryRow(SPEC, `sha256:${'f'.repeat(64)}`)] }),
      fetchTransportMetaJson: async () => [{ sha: COMMIT_TIP }, { sha: COMMIT_PUBLISHED }],
      downloadFile: async () => {},
      extractTarball: async (_tarPath: string, destDir: string) => {
        const inner = join(destDir, 'adhdev-providers-test');
        mkdirSync(inner, { recursive: true });
        cpSync(repo, inner, { recursive: true });
      },
    });

    const report = await runtime.sync({ channel: PREVIEW, targetTypes: new Set([SPEC.type]) });
    expect(report.status).toBe('error');
    expect(report.activated).toEqual([]);
    expect(report.errors.map((e) => e.code)).toEqual(['DIGEST_MISMATCH']);
  });

  /**
   * Backward compatibility for self-hosters: a non-GitHub transport is used
   * verbatim, with no GitHub API call and no behavior change.
   */
  it('leaves a self-hosted transport URL untouched and makes no API call', async () => {
    const selfHosted = 'https://mirror.internal.example/providers.tar.gz';
    const apiCalls: string[] = [];
    const candidates = await resolveTransportCandidates(selfHosted, async (url) => {
      apiCalls.push(url);
      return [];
    });
    expect(candidates).toEqual([selfHosted]);
    expect(apiCalls).toEqual([]);
  });

  it('treats an already-pinned SHA URL as final', async () => {
    const pinned = `https://github.com/vilmire/adhdev-providers/archive/${COMMIT_PUBLISHED}.tar.gz`;
    expect(parseGitHubArchiveUrl(pinned)?.pinned).toBe(true);
    const apiCalls: string[] = [];
    const candidates = await resolveTransportCandidates(pinned, async (url) => {
      apiCalls.push(url);
      return [];
    });
    expect(candidates).toEqual([pinned]);
    expect(apiCalls).toEqual([]);
  });

  /**
   * An unreachable GitHub API must not be a HARDER failure than the unpinned
   * behavior it replaces — it degrades to the original moving-ref URL.
   */
  it('falls back to the configured URL when the commit history is unreadable', async () => {
    const candidates = await resolveTransportCandidates(VENDOR_URL, async () => {
      throw new Error('rate limited');
    });
    expect(candidates).toEqual([VENDOR_URL]);
  });

  it('parses the vendor default archive URL as an unpinned moving ref', () => {
    const ref = parseGitHubArchiveUrl(VENDOR_URL);
    expect(ref).toEqual({ owner: 'vilmire', repo: 'adhdev-providers', ref: 'refs/heads/main', pinned: false });
  });
});
