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

import { describe, expect, it } from 'vitest';
import { cpSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ProviderChannelStore } from '../../../src/providers/channel/store.js';
import { ProviderChannelRuntime } from '../../../src/providers/channel/runtime.js';
import {
  buildPinnedArchiveUrl,
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
