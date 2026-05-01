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
});
