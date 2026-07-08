import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __changeImpactEvalCacheSizeForTests,
  __resetGitStatusCacheForTests,
  GIT_FETCH_THROTTLE_MS,
  GIT_STATUS_CACHE_TTL_MS,
  getGitRepoStatus,
} from '../../src/git/git-status.js';
import * as gitExecutor from '../../src/git/git-executor.js';

function git(cwd: string, args: string[], allowFailure = false): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  } catch (error) {
    if (allowFailure) return String((error as { stdout?: string }).stdout ?? '');
    throw error;
  }
}

describe('git repo status parser', () => {
  const roots: string[] = [];

  function tempRepo(name: string): string {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), `adhdev-${name}-`)));
    roots.push(repo);
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'ADHDev Test']);
    return repo;
  }

  function commit(repo: string, message: string): string {
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', message]);
    return git(repo, ['rev-parse', '--short', 'HEAD']);
  }

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns a non-throwing not_git_repo status for non-git workspaces', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adhdev-status-not-git-'));
    roots.push(dir);

    const status = await getGitRepoStatus(dir);

    expect(status.isGitRepo).toBe(false);
    expect(status.repoRoot).toBeNull();
    expect(status.reason).toBe('not_git_repo');
    expect(status.branch).toBeNull();
    expect(status.lastCheckedAt).toBeGreaterThan(0);
  });

  it('parses branch, upstream, ahead/behind, head, stash, and dirty file counts', async () => {
    const repo = tempRepo('status');
    writeFileSync(join(repo, 'tracked.txt'), 'one\n');
    writeFileSync(join(repo, 'delete-me.txt'), 'delete\n');
    writeFileSync(join(repo, 'rename-me.txt'), 'rename\n');
    writeFileSync(join(repo, 'stash-me.txt'), 'stash\n');
    const head = commit(repo, 'initial commit');

    const bare = mkdtempSync(join(tmpdir(), 'adhdev-status-remote-'));
    roots.push(bare);
    git(bare, ['init', '--bare']);
    git(repo, ['remote', 'add', 'origin', bare]);
    git(repo, ['push', '-u', 'origin', 'HEAD']);

    writeFileSync(join(repo, 'ahead.txt'), 'ahead\n');
    commit(repo, 'ahead commit');

    writeFileSync(join(repo, 'stash-me.txt'), 'stashed\n');
    git(repo, ['stash', 'push', '-m', 'saved local work']);

    writeFileSync(join(repo, 'tracked.txt'), 'one\ntwo\n');
    git(repo, ['rm', 'delete-me.txt']);
    git(repo, ['restore', '--staged', 'delete-me.txt']);
    git(repo, ['mv', 'rename-me.txt', 'renamed.txt']);
    writeFileSync(join(repo, 'staged.txt'), 'new staged\n');
    git(repo, ['add', 'staged.txt']);
    writeFileSync(join(repo, 'untracked.txt'), 'new untracked\n');

    const status = await getGitRepoStatus(repo);

    expect(status.isGitRepo).toBe(true);
    expect(status.repoRoot).toBe(repo);
    expect(status.branch).toBeTruthy();
    expect(status.upstream).toMatch(/^origin\//);
    expect(status.ahead).toBe(1);
    expect(status.behind).toBe(0);
    expect(status.headCommit).not.toBe(head);
    expect(status.headMessage).toBe('ahead commit');
    expect(status.stashCount).toBe(1);
    expect(status.staged).toBe(2);
    expect(status.modified).toBe(1);
    expect(status.deleted).toBe(1);
    expect(status.renamed).toBe(1);
    expect(status.untracked).toBe(1);
    expect(status.hasConflicts).toBe(false);
    expect(status.conflictFiles).toEqual([]);
  });

  describe('transient git failure does not drop repo membership', () => {
    afterEach(() => {
      __resetGitStatusCacheForTests();
    });

    it('returns a non-collapsed not_git_repo status (with reason) when there is no cache', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'adhdev-status-transient-nocache-'));
      roots.push(dir);
      // Non-git dir → genuine not_git_repo. This path must still report isGitRepo:false
      // with the reason marker so mesh membership can distinguish it from a timeout.
      const status = await getGitRepoStatus(dir);
      expect(status.isGitRepo).toBe(false);
      expect(status.reason).toBe('not_git_repo');
    });

    it('preserves the last-known-good repo identity on a timeout instead of returning all-null', async () => {
      const repo = tempRepo('status-transient-timeout');
      writeFileSync(join(repo, 'tracked.txt'), 'one\n');
      const head = commit(repo, 'initial commit');

      // First collect a healthy status to seed the last-known-good cache.
      const healthy = await getGitRepoStatus(repo);
      expect(healthy.isGitRepo).toBe(true);
      expect(healthy.repoRoot).toBe(repo);
      expect(healthy.branch).toBeTruthy();
      expect(healthy.headCommit).toBe(head);

      // Force a timeout by giving the collection path an impossibly short budget.
      // forceFresh bypasses the C1 TTL result cache (timeoutMs is not part of the cache
      // key, so without this the just-seeded healthy status would be returned instead of
      // re-collecting and tripping the 1ms budget).
      const timedOut = await getGitRepoStatus(repo, { timeoutMs: 1, forceFresh: true });

      // Membership MUST survive: a single git timeout cannot make the node read as
      // "not a git repo" / repoRoot:null — that is exactly what dropped it from the graph.
      expect(timedOut.isGitRepo).toBe(true);
      expect(timedOut.repoRoot).toBe(repo);
      expect(timedOut.branch).toBe(healthy.branch);
      expect(timedOut.headCommit).toBe(head);
      // It is re-stamped as stale/unavailable and carries the transient reason marker.
      expect(timedOut.reason).toBe('timeout');
      expect(timedOut.upstreamStatus).toBe('unavailable');
      expect(timedOut.error).toBeTruthy();
    });

    it('falls back to all-null only when a timeout happens with no prior good status', async () => {
      const repo = tempRepo('status-transient-cold-timeout');
      writeFileSync(join(repo, 'tracked.txt'), 'one\n');
      commit(repo, 'initial commit');

      // No prior successful collection for this workspace → nothing to fall back to.
      // Resolve succeeds quickly but the porcelain status read times out; with an empty
      // cache the only safe answer is emptyStatus, still carrying the timeout reason.
      const timedOut = await getGitRepoStatus(repo, { timeoutMs: 1 });
      // Either the resolve or the first git read trips the 1ms budget; in both cases the
      // reason marker distinguishes it from a genuine not_git_repo.
      expect(['timeout', 'not_git_repo']).toContain(timedOut.reason);
      if (timedOut.reason === 'timeout') {
        expect(timedOut.isGitRepo).toBe(false);
      }
    });
  });

  it('detects merge conflicts from porcelain v2 unmerged records', async () => {
    const repo = tempRepo('status-conflict');
    writeFileSync(join(repo, 'conflict.txt'), 'base\n');
    commit(repo, 'base');

    git(repo, ['checkout', '-b', 'feature']);
    writeFileSync(join(repo, 'conflict.txt'), 'feature\n');
    commit(repo, 'feature change');

    git(repo, ['checkout', '-']);
    writeFileSync(join(repo, 'conflict.txt'), 'main\n');
    commit(repo, 'main change');
    git(repo, ['merge', 'feature'], true);

    const status = await getGitRepoStatus(repo);

    expect(status.hasConflicts).toBe(true);
    expect(status.conflictFiles).toEqual(['conflict.txt']);
  });

  it('discovers git submodules so mesh_status callers can surface subrepo nodes like oss', async () => {
    const submoduleRepo = tempRepo('status-submodule-child');
    writeFileSync(join(submoduleRepo, 'child.txt'), 'child\n');
    commit(submoduleRepo, 'child init');

    const repo = tempRepo('status-submodule-parent');
    writeFileSync(join(repo, 'README.md'), 'parent\n');
    commit(repo, 'parent init');
    git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleRepo, 'oss']);
    commit(repo, 'add oss submodule');

    const status = await getGitRepoStatus(repo);

    expect(status.submodules).toBeDefined();
    expect(status.submodules).toHaveLength(1);
    expect(status.submodules?.[0]).toMatchObject({
      path: 'oss',
      repoPath: join(repo, 'oss'),
      dirty: false,
      outOfSync: false,
    });
  });

  it('marks submodules dirty when their nested working tree has changes', async () => {
    const submoduleRepo = tempRepo('status-submodule-dirty-child');
    writeFileSync(join(submoduleRepo, 'child.txt'), 'child\n');
    commit(submoduleRepo, 'child init');

    const repo = tempRepo('status-submodule-dirty-parent');
    writeFileSync(join(repo, 'README.md'), 'parent\n');
    commit(repo, 'parent init');
    git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleRepo, 'oss']);
    commit(repo, 'add oss submodule');

    writeFileSync(join(repo, 'oss', 'child.txt'), 'child\nlocal dirty\n');

    const status = await getGitRepoStatus(repo);

    expect(status.dirty).toBe(true);
    expect(status.submodules?.[0]).toMatchObject({
      path: 'oss',
      dirty: true,
      outOfSync: false,
    });
  });

  it('marks submodules out of sync when the checked-out HEAD differs from the recorded gitlink (no `git submodule status` shell wrapper)', async () => {
    // Regression for the Windows cold-open stall: getSubmoduleStatuses no longer
    // shells out to `git submodule status` (a slow shell wrapper). The gitlink sync
    // state must still be derived purely from `.gitmodules` + ls-tree HEAD vs the
    // submodule's own rev-parse HEAD — this exercises the `+` (out of sync) case.
    const submoduleRepo = tempRepo('status-submodule-oos-child');
    writeFileSync(join(submoduleRepo, 'child.txt'), 'child\n');
    commit(submoduleRepo, 'child init');

    const repo = tempRepo('status-submodule-oos-parent');
    writeFileSync(join(repo, 'README.md'), 'parent\n');
    commit(repo, 'parent init');
    git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleRepo, 'oss']);
    commit(repo, 'add oss submodule');

    const recordedSha = git(repo, ['rev-parse', 'HEAD:oss']);

    // Advance the submodule's own HEAD past the SHA the superproject records, WITHOUT
    // staging the new gitlink in the parent — exactly the `+` out-of-sync condition.
    writeFileSync(join(repo, 'oss', 'child.txt'), 'child\nadvanced\n');
    git(join(repo, 'oss'), ['add', '.']);
    git(join(repo, 'oss'), ['commit', '-m', 'advance submodule HEAD']);
    const advancedSha = git(join(repo, 'oss'), ['rev-parse', 'HEAD']);
    expect(advancedSha).not.toBe(recordedSha);

    const status = await getGitRepoStatus(repo);

    expect(status.submodules).toHaveLength(1);
    expect(status.submodules?.[0]).toMatchObject({
      path: 'oss',
      // commit reflects the gitlink the superproject HEAD records, not the advanced HEAD.
      commit: recordedSha,
      outOfSync: true,
    });
    // An out-of-sync (or dirty) submodule makes the whole repo dirty.
    expect(status.dirty).toBe(true);
  });

  it('marks tracked upstream state as unchecked until refreshed and updates behind counts after a bounded fetch', async () => {
    const repo = tempRepo('status-upstream-refresh');
    writeFileSync(join(repo, 'tracked.txt'), 'base\n');
    commit(repo, 'initial');

    const bare = mkdtempSync(join(tmpdir(), 'adhdev-status-refresh-remote-'));
    roots.push(bare);
    git(bare, ['init', '--bare']);
    git(repo, ['remote', 'add', 'origin', bare]);
    git(repo, ['push', '-u', 'origin', 'HEAD']);

    const peerParent = mkdtempSync(join(tmpdir(), 'adhdev-status-refresh-peer-'));
    roots.push(peerParent);
    git(peerParent, ['clone', bare, 'peer']);
    const peer = join(peerParent, 'peer');
    git(peer, ['config', 'user.email', 'test@example.com']);
    git(peer, ['config', 'user.name', 'ADHDev Test']);
    writeFileSync(join(peer, 'remote.txt'), 'remote advance\n');
    git(peer, ['add', '.']);
    git(peer, ['commit', '-m', 'remote advance']);
    git(peer, ['push', 'origin', 'HEAD']);

    const unchecked = await getGitRepoStatus(repo);
    expect(unchecked.upstreamStatus).toBe('unchecked');
    expect(unchecked.behind).toBe(0);

    const refreshed = await getGitRepoStatus(repo, { refreshUpstream: true });
    expect(refreshed.upstreamStatus).toBe('fresh');
    expect(refreshed.behind).toBe(1);
    expect(refreshed.upstreamFetchedAt).toBeGreaterThan(0);
    expect(refreshed.upstreamFetchError).toBeUndefined();
  });

  it('refreshes tracked upstream state for submodule workspaces like oss without relying on the parent repo fetch', async () => {
    const submoduleRepo = tempRepo('status-submodule-refresh-source');
    writeFileSync(join(submoduleRepo, 'child.txt'), 'child\n');
    commit(submoduleRepo, 'child init');

    const submoduleBare = mkdtempSync(join(tmpdir(), 'adhdev-status-submodule-remote-'));
    roots.push(submoduleBare);
    git(submoduleBare, ['init', '--bare']);
    git(submoduleRepo, ['remote', 'add', 'origin', submoduleBare]);
    git(submoduleRepo, ['push', '-u', 'origin', 'HEAD']);

    const repo = tempRepo('status-submodule-refresh-parent');
    writeFileSync(join(repo, 'README.md'), 'parent\n');
    commit(repo, 'parent init');
    git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleBare, 'oss']);
    commit(repo, 'add oss submodule');

    const peerParent = mkdtempSync(join(tmpdir(), 'adhdev-status-submodule-peer-'));
    roots.push(peerParent);
    git(peerParent, ['clone', submoduleBare, 'peer']);
    const peer = join(peerParent, 'peer');
    git(peer, ['config', 'user.email', 'test@example.com']);
    git(peer, ['config', 'user.name', 'ADHDev Test']);
    writeFileSync(join(peer, 'child.txt'), 'child\nremote advance\n');
    git(peer, ['add', 'child.txt']);
    git(peer, ['commit', '-m', 'remote submodule advance']);
    git(peer, ['push', 'origin', 'HEAD']);

    const submoduleWorkspace = join(repo, 'oss');
    const unchecked = await getGitRepoStatus(submoduleWorkspace);
    expect(unchecked.upstreamStatus).toBe('unchecked');
    expect(unchecked.behind).toBe(0);

    const refreshed = await getGitRepoStatus(submoduleWorkspace, { refreshUpstream: true });
    expect(refreshed.upstreamStatus).toBe('fresh');
    expect(refreshed.behind).toBe(1);
  });

  describe('daemonBuildBehind (stale live daemon detection)', () => {
    function buildInfoFor(commit: string) {
      return { commit, commitShort: commit.slice(0, 7), version: 'test' };
    }

    it('flags a build commit that is a strict ancestor of HEAD', async () => {
      const repo = tempRepo('build-behind-ancestor');
      writeFileSync(join(repo, 'a.txt'), 'one\n');
      commit(repo, 'c1');
      const oldCommit = git(repo, ['rev-parse', 'HEAD']);
      writeFileSync(join(repo, 'b.txt'), 'two\n');
      commit(repo, 'c2 (merged fix)');

      const status = await getGitRepoStatus(repo, { daemonBuildInfo: buildInfoFor(oldCommit) });
      expect(status.daemonBuildBehind).toBeDefined();
      expect(status.daemonBuildBehind?.buildCommit).toBe(oldCommit);
      expect(status.daemonBuildBehind?.scope).toBe('root');
      expect(status.daemonBuildBehind?.head).toBe(git(repo, ['rev-parse', 'HEAD']));
      expect(status.daemonBuildBehind?.warning).toContain('behind');
      // Root-level (non-package) changes are daemon-affecting by the conservative default.
      expect(status.daemonBuildBehind?.isDaemonAffecting).toBe(true);
    });

    it('marks isDaemonAffecting:true when a daemon-runtime package changed', async () => {
      const repo = tempRepo('build-behind-daemon-pkg');
      writeFileSync(join(repo, 'seed.txt'), 'seed\n');
      commit(repo, 'c1');
      const oldCommit = git(repo, ['rev-parse', 'HEAD']);
      mkdirSync(join(repo, 'packages', 'daemon-core', 'src'), { recursive: true });
      writeFileSync(join(repo, 'packages', 'daemon-core', 'src', 'x.ts'), 'export const x = 1;\n');
      commit(repo, 'c2 (daemon-core change)');

      const status = await getGitRepoStatus(repo, { daemonBuildInfo: buildInfoFor(oldCommit) });
      expect(status.daemonBuildBehind).toBeDefined();
      expect(status.daemonBuildBehind?.isDaemonAffecting).toBe(true);
      expect(status.daemonBuildBehind?.affectedPackages).toContain('daemon-core');
      expect(status.daemonBuildBehind?.warning).toContain('rebuilt/redeployed and restarted');
    });

    it('marks isDaemonAffecting:false when only web packages changed', async () => {
      const repo = tempRepo('build-behind-web-only');
      writeFileSync(join(repo, 'seed.txt'), 'seed\n');
      commit(repo, 'c1');
      const oldCommit = git(repo, ['rev-parse', 'HEAD']);
      mkdirSync(join(repo, 'packages', 'web-core', 'src'), { recursive: true });
      writeFileSync(join(repo, 'packages', 'web-core', 'src', 'ui.ts'), 'export const ui = 1;\n');
      commit(repo, 'c2 (web-core change)');

      const status = await getGitRepoStatus(repo, { daemonBuildInfo: buildInfoFor(oldCommit) });
      expect(status.daemonBuildBehind).toBeDefined();
      expect(status.daemonBuildBehind?.isDaemonAffecting).toBe(false);
      expect(status.daemonBuildBehind?.affectedPackages).toEqual(['web-core']);
      expect(status.daemonBuildBehind?.warning).toContain('Daemon restart NOT required');
    });

    it('stays daemon-affecting when web and daemon packages both changed', async () => {
      const repo = tempRepo('build-behind-mixed-pkg');
      writeFileSync(join(repo, 'seed.txt'), 'seed\n');
      commit(repo, 'c1');
      const oldCommit = git(repo, ['rev-parse', 'HEAD']);
      mkdirSync(join(repo, 'packages', 'web-core', 'src'), { recursive: true });
      mkdirSync(join(repo, 'packages', 'daemon-standalone', 'src'), { recursive: true });
      writeFileSync(join(repo, 'packages', 'web-core', 'src', 'ui.ts'), 'export const ui = 1;\n');
      writeFileSync(join(repo, 'packages', 'daemon-standalone', 'src', 'y.ts'), 'export const y = 1;\n');
      commit(repo, 'c2 (mixed change)');

      const status = await getGitRepoStatus(repo, { daemonBuildInfo: buildInfoFor(oldCommit) });
      expect(status.daemonBuildBehind?.isDaemonAffecting).toBe(true);
    });

    it('marks isDaemonAffecting:false when only a verify/convergence marker changed', async () => {
      const repo = tempRepo('build-behind-marker-only');
      writeFileSync(join(repo, 'seed.txt'), 'seed\n');
      commit(repo, 'c1');
      const oldCommit = git(repo, ['rev-parse', 'HEAD']);
      // Mirrors the real-world gitlink-only superproject case: the oss commit that
      // moved HEAD only added a convergence marker, no runtime code.
      writeFileSync(join(repo, '.verify-patch-equiv-rc292'), 'marker\n');
      commit(repo, 'c2 (add verify marker)');

      const status = await getGitRepoStatus(repo, { daemonBuildInfo: buildInfoFor(oldCommit) });
      expect(status.daemonBuildBehind).toBeDefined();
      expect(status.daemonBuildBehind?.isDaemonAffecting).toBe(false);
      expect(status.daemonBuildBehind?.warning).toContain('non-runtime files changed');
      expect(status.daemonBuildBehind?.warning).toContain('Daemon restart NOT required');
    });

    it('marks isDaemonAffecting:false when only docs / a marker changed alongside web-core', async () => {
      const repo = tempRepo('build-behind-marker-plus-web');
      writeFileSync(join(repo, 'seed.txt'), 'seed\n');
      commit(repo, 'c1');
      const oldCommit = git(repo, ['rev-parse', 'HEAD']);
      mkdirSync(join(repo, 'docs'), { recursive: true });
      writeFileSync(join(repo, 'docs', 'NOTES.md'), '# notes\n');
      writeFileSync(join(repo, 'README.md'), '# readme\n');
      mkdirSync(join(repo, 'packages', 'web-core', 'src'), { recursive: true });
      writeFileSync(join(repo, 'packages', 'web-core', 'src', 'ui.ts'), 'export const ui = 1;\n');
      commit(repo, 'c2 (docs + web-core)');

      const status = await getGitRepoStatus(repo, { daemonBuildInfo: buildInfoFor(oldCommit) });
      expect(status.daemonBuildBehind?.isDaemonAffecting).toBe(false);
      expect(status.daemonBuildBehind?.affectedPackages).toEqual(['web-core']);
    });

    it('stays daemon-affecting when a marker changes alongside daemon-core', async () => {
      const repo = tempRepo('build-behind-marker-plus-daemon');
      writeFileSync(join(repo, 'seed.txt'), 'seed\n');
      commit(repo, 'c1');
      const oldCommit = git(repo, ['rev-parse', 'HEAD']);
      writeFileSync(join(repo, '.verify-marker'), 'm\n');
      mkdirSync(join(repo, 'packages', 'daemon-core', 'src'), { recursive: true });
      writeFileSync(join(repo, 'packages', 'daemon-core', 'src', 'x.ts'), 'export const x = 1;\n');
      commit(repo, 'c2 (marker + daemon-core)');

      const status = await getGitRepoStatus(repo, { daemonBuildInfo: buildInfoFor(oldCommit) });
      expect(status.daemonBuildBehind?.isDaemonAffecting).toBe(true);
      expect(status.daemonBuildBehind?.affectedPackages).toContain('daemon-core');
    });

    it('stays daemon-affecting for an unrecognized root file (conservative default)', async () => {
      const repo = tempRepo('build-behind-unknown-root');
      writeFileSync(join(repo, 'seed.txt'), 'seed\n');
      commit(repo, 'c1');
      const oldCommit = git(repo, ['rev-parse', 'HEAD']);
      // A root config/script change could affect the daemon build — not benign.
      writeFileSync(join(repo, 'tsconfig.base.json'), '{}\n');
      commit(repo, 'c2 (root config change)');

      const status = await getGitRepoStatus(repo, { daemonBuildInfo: buildInfoFor(oldCommit) });
      expect(status.daemonBuildBehind?.isDaemonAffecting).toBe(true);
    });

    it('does not flag when the build commit equals HEAD (daemon current)', async () => {
      const repo = tempRepo('build-behind-current');
      writeFileSync(join(repo, 'a.txt'), 'one\n');
      commit(repo, 'c1');
      const head = git(repo, ['rev-parse', 'HEAD']);

      const status = await getGitRepoStatus(repo, { daemonBuildInfo: buildInfoFor(head) });
      expect(status.daemonBuildBehind).toBeUndefined();
    });

    it('does not flag when the build commit is absent from the repo (different repo)', async () => {
      const repo = tempRepo('build-behind-absent');
      writeFileSync(join(repo, 'a.txt'), 'one\n');
      commit(repo, 'c1');

      const status = await getGitRepoStatus(repo, { daemonBuildInfo: buildInfoFor('0'.repeat(40)) });
      expect(status.daemonBuildBehind).toBeUndefined();
    });

    it('does not flag a build commit that is ahead of / diverged from HEAD', async () => {
      const repo = tempRepo('build-behind-ahead');
      writeFileSync(join(repo, 'a.txt'), 'one\n');
      commit(repo, 'c1');
      const head = git(repo, ['rev-parse', 'HEAD']);
      writeFileSync(join(repo, 'b.txt'), 'two\n');
      commit(repo, 'c2');
      const aheadCommit = git(repo, ['rev-parse', 'HEAD']);
      // Reset HEAD back to c1 so the build commit (c2) is a descendant, not an
      // ancestor, of HEAD.
      git(repo, ['reset', '--hard', head]);

      const status = await getGitRepoStatus(repo, { daemonBuildInfo: buildInfoFor(aheadCommit) });
      expect(status.daemonBuildBehind).toBeUndefined();
    });

    it('does not flag when the build commit is unknown', async () => {
      const repo = tempRepo('build-behind-unknown');
      writeFileSync(join(repo, 'a.txt'), 'one\n');
      commit(repo, 'c1');

      const status = await getGitRepoStatus(repo, {
        daemonBuildInfo: { commit: 'unknown', commitShort: 'unknown', version: 'unknown' },
      });
      expect(status.daemonBuildBehind).toBeUndefined();
    });
  });

  describe('change impact (config-driven daemonBuildBehind classification)', () => {
    function buildInfoFor(commit: string) {
      return { commit, commitShort: commit.slice(0, 7), version: 'test' };
    }

    /** Seed a repo whose HEAD advances one package dir past an old build commit. */
    function repoWithPackageChange(name: string, pkg: string): { repo: string; oldCommit: string } {
      const repo = tempRepo(name);
      writeFileSync(join(repo, 'seed.txt'), 'seed\n');
      commit(repo, 'c1');
      const oldCommit = git(repo, ['rev-parse', 'HEAD']);
      mkdirSync(join(repo, 'packages', pkg, 'src'), { recursive: true });
      writeFileSync(join(repo, 'packages', pkg, 'src', 'x.ts'), 'export const x = 1;\n');
      commit(repo, `c2 (${pkg} change)`);
      return { repo, oldCommit };
    }

    beforeEach(() => {
      __resetGitStatusCacheForTests();
    });
    afterEach(() => {
      __resetGitStatusCacheForTests();
    });

    it('honors an injected config: a package the config calls daemon-runtime is daemon-affecting', async () => {
      // "feature-engine" is unknown to the built-in default set (so the default would
      // conservatively call it daemon-affecting via the unknown-package path). Make it
      // EXPLICITLY web-only by config and add a separate daemon-runtime name, then prove
      // the config classification — not the hardcoded set — drives the verdict.
      const { repo, oldCommit } = repoWithPackageChange('ci-config-daemon', 'feature-engine');
      const status = await getGitRepoStatus(repo, {
        daemonBuildInfo: buildInfoFor(oldCommit),
        changeImpactConfig: { daemonRuntimePackages: ['feature-engine'], webOnlyPackages: [] },
      });
      expect(status.daemonBuildBehind?.isDaemonAffecting).toBe(true);
      expect(status.daemonBuildBehind?.affectedPackages).toEqual(['feature-engine']);
      expect(status.daemonBuildBehind?.recommendedAction).toBe('daemon');
    });

    it('honors an injected config: a package the config calls web-only is NOT daemon-affecting', async () => {
      const { repo, oldCommit } = repoWithPackageChange('ci-config-web', 'feature-ui');
      const status = await getGitRepoStatus(repo, {
        daemonBuildInfo: buildInfoFor(oldCommit),
        changeImpactConfig: { webOnlyPackages: ['feature-ui'] },
      });
      expect(status.daemonBuildBehind?.isDaemonAffecting).toBe(false);
      expect(status.daemonBuildBehind?.affectedPackages).toEqual(['feature-ui']);
      expect(status.daemonBuildBehind?.recommendedAction).toBe('web');
    });

    it('uses the config recommendedCommand for the matched impact kind', async () => {
      const { repo, oldCommit } = repoWithPackageChange('ci-config-command', 'feature-ui');
      const status = await getGitRepoStatus(repo, {
        daemonBuildInfo: buildInfoFor(oldCommit),
        changeImpactConfig: {
          webOnlyPackages: ['feature-ui'],
          impactTargets: { web: { recommendedCommand: 'deploy --target web --yes' } },
        },
      });
      expect(status.daemonBuildBehind?.recommendedAction).toBe('web');
      expect(status.daemonBuildBehind?.recommendedCommand).toBe('deploy --target web --yes');
    });

    it('honors config nonRuntimeRootFilePatterns globs (extra benign root files)', async () => {
      const repo = tempRepo('ci-config-rootglob');
      writeFileSync(join(repo, 'seed.txt'), 'seed\n');
      commit(repo, 'c1');
      const oldCommit = git(repo, ['rev-parse', 'HEAD']);
      // `.release-notes` is NOT benign under the built-in default → would be daemon-affecting.
      writeFileSync(join(repo, '.release-notes'), 'notes\n');
      commit(repo, 'c2 (release notes)');

      const withoutConfig = await getGitRepoStatus(repo, {
        daemonBuildInfo: buildInfoFor(oldCommit),
        changeImpactConfig: null,
      });
      expect(withoutConfig.daemonBuildBehind?.isDaemonAffecting).toBe(true);

      __resetGitStatusCacheForTests();
      const withConfig = await getGitRepoStatus(repo, {
        daemonBuildInfo: buildInfoFor(oldCommit),
        changeImpactConfig: { nonRuntimeRootFilePatterns: ['.release-notes'] },
      });
      expect(withConfig.daemonBuildBehind?.isDaemonAffecting).toBe(false);
      expect(withConfig.daemonBuildBehind?.recommendedAction).toBe('none');
    });

    it('falls back to the built-in default policy when no config is present (backward compat)', async () => {
      // daemon-core is in the built-in daemon-runtime set; web-core in the web-only set.
      const daemonPkg = repoWithPackageChange('ci-default-daemon', 'daemon-core');
      const webPkg = repoWithPackageChange('ci-default-web', 'web-core');

      const daemonStatus = await getGitRepoStatus(daemonPkg.repo, {
        daemonBuildInfo: buildInfoFor(daemonPkg.oldCommit),
        changeImpactConfig: null,
      });
      const webStatus = await getGitRepoStatus(webPkg.repo, {
        daemonBuildInfo: buildInfoFor(webPkg.oldCommit),
        changeImpactConfig: null,
      });

      expect(daemonStatus.daemonBuildBehind?.isDaemonAffecting).toBe(true);
      expect(daemonStatus.daemonBuildBehind?.recommendedAction).toBe('daemon');
      expect(webStatus.daemonBuildBehind?.isDaemonAffecting).toBe(false);
      expect(webStatus.daemonBuildBehind?.recommendedAction).toBe('web');
    });

    it('auto-loads a repo .adhdev/change-impact.json without an explicit option', async () => {
      // Commit the config at c1 so it is present on disk but OUTSIDE the
      // buildCommit..HEAD diff range (otherwise the config file itself, a non-package
      // root file, would conservatively force daemon-affecting).
      const repo = tempRepo('ci-autoload');
      mkdirSync(join(repo, '.adhdev'), { recursive: true });
      writeFileSync(
        join(repo, '.adhdev', 'change-impact.json'),
        JSON.stringify({ webOnlyPackages: ['feature-ui'] }),
      );
      writeFileSync(join(repo, 'seed.txt'), 'seed\n');
      commit(repo, 'c1 (seed + change-impact config)');
      const oldCommit = git(repo, ['rev-parse', 'HEAD']);
      mkdirSync(join(repo, 'packages', 'feature-ui', 'src'), { recursive: true });
      writeFileSync(join(repo, 'packages', 'feature-ui', 'src', 'x.ts'), 'export const x = 1;\n');
      commit(repo, 'c2 (feature-ui change)');

      // No changeImpactConfig option → must auto-load the on-disk config.
      const status = await getGitRepoStatus(repo, { daemonBuildInfo: buildInfoFor(oldCommit) });
      expect(status.daemonBuildBehind?.isDaemonAffecting).toBe(false);
      expect(status.daemonBuildBehind?.affectedPackages).toContain('feature-ui');
    });

    it('memoizes the impact evaluation for an identical diff + config (cache suppresses re-eval)', async () => {
      const { repo, oldCommit } = repoWithPackageChange('ci-cache', 'feature-ui');
      // forceFresh so the C1 TTL result cache doesn't mask the C3 change-impact eval
      // memo under test — we want each call to re-run detectDaemonBuildBehind.
      const opts = {
        daemonBuildInfo: buildInfoFor(oldCommit),
        changeImpactConfig: { webOnlyPackages: ['feature-ui'] },
        forceFresh: true,
      };

      expect(__changeImpactEvalCacheSizeForTests()).toBe(0);
      const first = await getGitRepoStatus(repo, opts);
      expect(__changeImpactEvalCacheSizeForTests()).toBe(1);
      const second = await getGitRepoStatus(repo, opts);
      // Same HEAD + same config → cache hit, size unchanged.
      expect(__changeImpactEvalCacheSizeForTests()).toBe(1);
      expect(second.daemonBuildBehind?.isDaemonAffecting).toBe(first.daemonBuildBehind?.isDaemonAffecting);
    });

    it('re-evaluates (new cache entry) when HEAD advances', async () => {
      const { repo, oldCommit } = repoWithPackageChange('ci-cache-head', 'feature-ui');
      // forceFresh so the C1 TTL result cache doesn't return the stale pre-HEAD-advance
      // status — this test verifies the C3 eval memo re-keys on HEAD movement.
      const opts = {
        daemonBuildInfo: buildInfoFor(oldCommit),
        changeImpactConfig: { webOnlyPackages: ['feature-ui'] },
        forceFresh: true,
      };
      await getGitRepoStatus(repo, opts);
      expect(__changeImpactEvalCacheSizeForTests()).toBe(1);

      // Advance HEAD with another change → different buildCommit..HEAD diff → new key.
      mkdirSync(join(repo, 'packages', 'daemon-core', 'src'), { recursive: true });
      writeFileSync(join(repo, 'packages', 'daemon-core', 'src', 'y.ts'), 'export const y = 1;\n');
      commit(repo, 'c3 (daemon-core change)');

      const after = await getGitRepoStatus(repo, opts);
      expect(__changeImpactEvalCacheSizeForTests()).toBe(2);
      // The new diff now includes a daemon-runtime package → daemon-affecting.
      expect(after.daemonBuildBehind?.isDaemonAffecting).toBe(true);
    });

    it('stays conservative (isDaemonAffecting:true) when the impact diff cannot be evaluated', async () => {
      // A build commit that exists and is a strict ancestor, but we force the diff probe
      // to fail by giving the whole collection an impossibly short timeout AFTER seeding
      // a healthy last-known-good. Instead, exercise the conservative path directly: a
      // root config change with no benign match is daemon-affecting under any policy
      // (empty config => default => conservative for unknown root files).
      const repo = tempRepo('ci-conservative');
      writeFileSync(join(repo, 'seed.txt'), 'seed\n');
      commit(repo, 'c1');
      const oldCommit = git(repo, ['rev-parse', 'HEAD']);
      writeFileSync(join(repo, 'tsconfig.base.json'), '{}\n');
      commit(repo, 'c2 (root config change)');

      const status = await getGitRepoStatus(repo, {
        daemonBuildInfo: buildInfoFor(oldCommit),
        changeImpactConfig: {},
      });
      expect(status.daemonBuildBehind?.isDaemonAffecting).toBe(true);
      expect(status.daemonBuildBehind?.recommendedAction).toBe('daemon');
    });
  });

  // ─── C1: TTL result cache ───────────────────────────
  describe('C1 TTL result cache', () => {
    beforeEach(() => {
      __resetGitStatusCacheForTests();
    });
    afterEach(() => {
      __resetGitStatusCacheForTests();
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('serves a cached result for a repeat caller within the TTL (no re-collection)', async () => {
      const repo = tempRepo('c1-hit');
      writeFileSync(join(repo, 'a.txt'), 'one\n');
      commit(repo, 'c1');

      const first = await getGitRepoStatus(repo);
      expect(first.isGitRepo).toBe(true);

      // Mutate the working tree AFTER the first (cached) read. A re-collection would see
      // the new untracked file; a cache hit returns the prior status unchanged.
      writeFileSync(join(repo, 'untracked.txt'), 'new\n');

      const second = await getGitRepoStatus(repo);
      // Same object reference proves it came straight from the cache (no re-collect).
      expect(second).toBe(first);
      expect(second.untracked).toBe(first.untracked);
    });

    it('re-collects after the TTL elapses', async () => {
      const repo = tempRepo('c1-expire');
      writeFileSync(join(repo, 'a.txt'), 'one\n');
      commit(repo, 'c1');

      const first = await getGitRepoStatus(repo);
      expect(first.untracked).toBe(0);

      // Mutate, then jump the clock past the TTL so the next call is forced to re-collect.
      writeFileSync(join(repo, 'untracked.txt'), 'new\n');
      const realNow = Date.now();
      const spy = vi.spyOn(Date, 'now').mockReturnValue(realNow + GIT_STATUS_CACHE_TTL_MS + 50);

      const second = await getGitRepoStatus(repo);
      spy.mockRestore();
      expect(second).not.toBe(first);
      expect(second.untracked).toBe(1);
    });

    it('forceFresh bypasses the cache and always re-collects', async () => {
      const repo = tempRepo('c1-forcefresh');
      writeFileSync(join(repo, 'a.txt'), 'one\n');
      commit(repo, 'c1');

      const first = await getGitRepoStatus(repo);
      expect(first.untracked).toBe(0);

      writeFileSync(join(repo, 'untracked.txt'), 'new\n');
      // Within the TTL a normal caller would get the stale cached status; forceFresh
      // must re-collect and observe the new untracked file immediately.
      const fresh = await getGitRepoStatus(repo, { forceFresh: true });
      expect(fresh).not.toBe(first);
      expect(fresh.untracked).toBe(1);
    });

    it('keys the cache on option shape so includeSubmodules/refreshUpstream do not collide', async () => {
      const repo = tempRepo('c1-keyshape');
      writeFileSync(join(repo, 'a.txt'), 'one\n');
      commit(repo, 'c1');

      const withSub = await getGitRepoStatus(repo, { includeSubmodules: true });
      const withoutSub = await getGitRepoStatus(repo, { includeSubmodules: false });
      // Different option shape → different cache key → not the same cached object.
      expect(withoutSub).not.toBe(withSub);
      // And a same-shape repeat is a cache hit again.
      const withSubAgain = await getGitRepoStatus(repo, { includeSubmodules: true });
      expect(withSubAgain).toBe(withSub);
    });

    it('never caches an error/empty result (timeout falls through, then a real read succeeds)', async () => {
      const repo = tempRepo('c1-no-cache-error');
      writeFileSync(join(repo, 'a.txt'), 'one\n');
      commit(repo, 'c1');

      // Cold timeout with no prior good status → empty/error status, which must NOT be
      // cached. Force the timeout DETERMINISTICALLY rather than racing a 1ms budget: a
      // fast CI runner finishes the status spawn inside the millisecond, the collector
      // returns healthy (reason: undefined), and the assertion flakes. Spy runGit — the
      // status-data primitive — to throw the executor's timeout error; resolveGitRepository
      // is a separate export and stays real, so the catch maps reason 'timeout'. forceFresh
      // ensures we exercise the collection path (not a cache hit).
      const spy = vi.spyOn(gitExecutor, 'runGit').mockRejectedValue(
        new gitExecutor.GitCommandError('timeout', 'Git command timed out', { signal: 'SIGTERM' }),
      );
      const timedOut = await getGitRepoStatus(repo, { forceFresh: true });
      expect(timedOut.reason).toBe('timeout');
      spy.mockRestore();

      // A subsequent normal read must succeed (it cannot have been served a cached error).
      const ok = await getGitRepoStatus(repo);
      expect(ok.isGitRepo).toBe(true);
      expect(ok.reason).toBeUndefined();
    });
  });

  // ─── C2: fetch throttle ───────────────────────────
  describe('C2 upstream fetch throttle', () => {
    beforeEach(() => {
      __resetGitStatusCacheForTests();
    });
    afterEach(() => {
      __resetGitStatusCacheForTests();
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    function fetchCount(spy: ReturnType<typeof vi.spyOn>): number {
      return spy.mock.calls.filter(call => Array.isArray(call[1]) && (call[1] as string[])[0] === 'fetch').length;
    }

    it('throttles the network fetch but keeps local working-tree status fresh', async () => {
      const submoduleRepo = tempRepo('c2-throttle-source');
      writeFileSync(join(submoduleRepo, 'a.txt'), 'one\n');
      commit(submoduleRepo, 'c1');

      const bare = mkdtempSync(join(tmpdir(), 'adhdev-c2-remote-'));
      roots.push(bare);
      git(bare, ['init', '--bare']);
      git(submoduleRepo, ['remote', 'add', 'origin', bare]);
      git(submoduleRepo, ['push', '-u', 'origin', 'HEAD']);

      const spy = vi.spyOn(gitExecutor, 'runGit');

      // First refreshUpstream call performs the real fetch.
      const r1 = await getGitRepoStatus(submoduleRepo, { refreshUpstream: true });
      expect(r1.upstreamStatus).toBe('fresh');
      const afterFirst = fetchCount(spy);
      expect(afterFirst).toBe(1);

      // Make a local change, then advance the clock past the C1 result-cache TTL (so the
      // next call MUST re-collect and see the new file) but stay within the C2 fetch
      // throttle window (so no second network fetch). This is the real steady-state: local
      // working-tree status is always re-read fresh, only the upstream fetch is throttled.
      writeFileSync(join(submoduleRepo, 'untracked.txt'), 'new\n');
      const realNow = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(realNow + GIT_STATUS_CACHE_TTL_MS + 50);

      const r2 = await getGitRepoStatus(submoduleRepo, { refreshUpstream: true });
      // C1 expired → re-collected local status (untracked visible); C2 still within 30s →
      // no second fetch.
      expect(fetchCount(spy)).toBe(afterFirst);
      expect(r2.upstreamStatus).toBe('fresh');
      expect(r2.untracked).toBe(1);
    });

    it('fetches again once the throttle window elapses', async () => {
      const repo = tempRepo('c2-window');
      writeFileSync(join(repo, 'a.txt'), 'one\n');
      commit(repo, 'c1');
      const bare = mkdtempSync(join(tmpdir(), 'adhdev-c2-window-remote-'));
      roots.push(bare);
      git(bare, ['init', '--bare']);
      git(repo, ['remote', 'add', 'origin', bare]);
      git(repo, ['push', '-u', 'origin', 'HEAD']);

      const spy = vi.spyOn(gitExecutor, 'runGit');

      await getGitRepoStatus(repo, { refreshUpstream: true });
      expect(fetchCount(spy)).toBe(1);

      // Advance past the throttle window → next refreshUpstream fetches again.
      const realNow = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(realNow + GIT_FETCH_THROTTLE_MS + 50);
      await getGitRepoStatus(repo, { refreshUpstream: true, forceFresh: true });
      expect(fetchCount(spy)).toBe(2);
    });

    it('forceFresh always re-fetches regardless of throttle window', async () => {
      const repo = tempRepo('c2-forcefresh-fetch');
      writeFileSync(join(repo, 'a.txt'), 'one\n');
      commit(repo, 'c1');
      const bare = mkdtempSync(join(tmpdir(), 'adhdev-c2-ff-remote-'));
      roots.push(bare);
      git(bare, ['init', '--bare']);
      git(repo, ['remote', 'add', 'origin', bare]);
      git(repo, ['push', '-u', 'origin', 'HEAD']);

      const spy = vi.spyOn(gitExecutor, 'runGit');
      // Convergence-critical callers (ff/refine) pass forceFresh and must always see a
      // true upstream — the throttle never suppresses their fetch.
      await getGitRepoStatus(repo, { refreshUpstream: true, forceFresh: true });
      await getGitRepoStatus(repo, { refreshUpstream: true, forceFresh: true });
      expect(fetchCount(spy)).toBe(2);
    });
  });

  // ─── C3: build-behind ancestry cache by HEAD oid ───────────────────────────
  describe('C3 build-behind ancestry cache', () => {
    function buildInfoFor(commit: string) {
      return { commit, commitShort: commit.slice(0, 7), version: 'test' };
    }

    beforeEach(() => {
      __resetGitStatusCacheForTests();
    });
    afterEach(() => {
      __resetGitStatusCacheForTests();
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    function ancestryProbeCount(spy: ReturnType<typeof vi.spyOn>): number {
      // cat-file / merge-base / rev-parse are the ancestry-resolution spawns C3 elides
      // on a memo hit.
      return spy.mock.calls.filter(call => {
        const argv = call[1] as string[] | undefined;
        if (!Array.isArray(argv)) return false;
        return argv[0] === 'cat-file' || argv[0] === 'merge-base' || argv[0] === 'rev-parse';
      }).length;
    }

    it('memo-hits on an unchanged HEAD: a repeat probe skips cat-file/merge-base/rev-parse', async () => {
      const repo = tempRepo('c3-memo-hit');
      writeFileSync(join(repo, 'a.txt'), 'one\n');
      commit(repo, 'c1');
      const oldCommit = git(repo, ['rev-parse', 'HEAD']);
      writeFileSync(join(repo, 'b.txt'), 'two\n');
      commit(repo, 'c2 (merged fix)');

      const opts = { daemonBuildInfo: buildInfoFor(oldCommit), forceFresh: true };

      const spy = vi.spyOn(gitExecutor, 'runGit');
      const first = await getGitRepoStatus(repo, opts);
      expect(first.daemonBuildBehind).toBeDefined();
      const firstProbes = ancestryProbeCount(spy);
      expect(firstProbes).toBeGreaterThan(0);

      // Second probe at the SAME HEAD (forceFresh re-runs detectDaemonBuildBehind, but the
      // C3 ancestry memo + change-impact memo are keyed on HEAD oid → no ancestry spawns).
      spy.mockClear();
      const second = await getGitRepoStatus(repo, opts);
      expect(second.daemonBuildBehind?.head).toBe(first.daemonBuildBehind?.head);
      expect(ancestryProbeCount(spy)).toBe(0);
    });

    it('reuses the porcelain HEAD oid instead of a separate rev-parse on the root scope', async () => {
      const repo = tempRepo('c3-no-revparse');
      writeFileSync(join(repo, 'a.txt'), 'one\n');
      commit(repo, 'c1');
      const oldCommit = git(repo, ['rev-parse', 'HEAD']);
      writeFileSync(join(repo, 'b.txt'), 'two\n');
      commit(repo, 'c2 (merged fix)');

      const spy = vi.spyOn(gitExecutor, 'runGit');
      const status = await getGitRepoStatus(repo, { daemonBuildInfo: buildInfoFor(oldCommit), forceFresh: true });
      expect(status.daemonBuildBehind?.scope).toBe('root');
      // The root-scope ancestry resolution must NOT spend a `rev-parse HEAD` — the HEAD oid
      // comes from porcelain v2 `# branch.oid`. (readHead uses `log`, not rev-parse, so any
      // rev-parse here would be the eliminated build-behind one.)
      const revParseCalls = spy.mock.calls.filter(call => {
        const argv = call[1] as string[] | undefined;
        return Array.isArray(argv) && argv[0] === 'rev-parse';
      });
      expect(revParseCalls.length).toBe(0);
    });

    it('invalidates the verdict when HEAD moves (re-resolves ancestry)', async () => {
      const repo = tempRepo('c3-head-move');
      writeFileSync(join(repo, 'a.txt'), 'one\n');
      commit(repo, 'c1');
      const oldCommit = git(repo, ['rev-parse', 'HEAD']);
      writeFileSync(join(repo, 'b.txt'), 'two\n');
      commit(repo, 'c2 (merged fix)');

      const opts = { daemonBuildInfo: buildInfoFor(oldCommit), forceFresh: true };
      const first = await getGitRepoStatus(repo, opts);
      const firstHead = first.daemonBuildBehind?.head;

      // Advance HEAD → new oid → new ancestry key → must re-resolve (spawns again).
      writeFileSync(join(repo, 'c.txt'), 'three\n');
      commit(repo, 'c3 (another change)');

      const spy = vi.spyOn(gitExecutor, 'runGit');
      const second = await getGitRepoStatus(repo, opts);
      expect(second.daemonBuildBehind?.head).not.toBe(firstHead);
      // HEAD moved → memo miss → ancestry probes ran again for the new oid.
      expect(ancestryProbeCount(spy)).toBeGreaterThan(0);
    });
  });
});
