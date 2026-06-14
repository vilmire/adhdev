import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getGitRepoStatus } from '../../src/git/git-status.js';

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
});
