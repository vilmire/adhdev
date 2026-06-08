import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleGitCommand } from '../../src/git/git-commands.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('git checkpoint integration', () => {
  const roots: string[] = [];

  function initRepo(name: string): string {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), `adhdev-${name}-`)));
    roots.push(repo);
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'ADHDev Test']);
    writeFileSync(join(repo, 'README.md'), 'initial\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-m', 'initial commit']);
    return repo;
  }

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('commits tracked and untracked files with an exact multiword checkpoint message', async () => {
    const repo = initRepo('checkpoint-untracked');
    writeFileSync(join(repo, 'README.md'), 'initial\ntracked change\n');
    writeFileSync(join(repo, '.repo-mesh-smoke.txt'), 'created by mesh smoke\n');

    const result = await handleGitCommand('git_checkpoint', {
      workspace: repo,
      message: 'checkpoint: rc21 fresh global repo mesh e2e smoke',
      includeUntracked: true,
    });

    expect(result).toMatchObject({
      success: true,
      checkpoint: {
        isGitRepo: true,
        repoRoot: repo,
        message: 'adhdev: checkpoint checkpoint: rc21 fresh global repo mesh e2e smoke',
      },
    });
    if (result.success !== true || !('checkpoint' in result)) {
      throw new Error('checkpoint result was not successful');
    }
    expect(result.checkpoint.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(git(repo, ['log', '-1', '--pretty=%B'])).toBe(
      'adhdev: checkpoint checkpoint: rc21 fresh global repo mesh e2e smoke',
    );
    expect(git(repo, ['ls-files', '.repo-mesh-smoke.txt'])).toBe('.repo-mesh-smoke.txt');
    expect(git(repo, ['show', 'HEAD:README.md'])).toBe('initial\ntracked change');
    expect(git(repo, ['status', '--short'])).toBe('');
  });

  it('returns a successful typed no-op result for a clean worktree', async () => {
    const repo = initRepo('checkpoint-clean');

    const result = await handleGitCommand('git_checkpoint', {
      workspace: repo,
      message: 'checkpoint: clean smoke',
      includeUntracked: true,
    });

    expect(result).toMatchObject({
      success: true,
      checkpoint: {
        isGitRepo: true,
        repoRoot: repo,
        message: 'adhdev: checkpoint checkpoint: clean smoke',
        status: 'skipped',
        skipped: true,
        noop: true,
        reason: 'nothing_to_commit',
      },
    });
    expect(git(repo, ['log', '--oneline'])).toContain('initial commit');
  });

  it('fails instead of no-op when a nested submodule working tree is dirty', async () => {
    const submoduleRepo = initRepo('checkpoint-submodule-child');
    writeFileSync(join(submoduleRepo, 'child.txt'), 'child\n');
    git(submoduleRepo, ['add', 'child.txt']);
    git(submoduleRepo, ['commit', '-m', 'child init']);

    const repo = initRepo('checkpoint-submodule-parent');
    git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleRepo, 'oss']);
    git(repo, ['commit', '-m', 'add oss submodule']);

    writeFileSync(join(repo, 'oss', 'child.txt'), 'child\nlocal dirty\n');

    const result = await handleGitCommand('git_checkpoint', {
      workspace: repo,
      message: 'checkpoint: parent should not hide dirty submodule',
      includeUntracked: true,
    });

    expect(result).toMatchObject({
      success: false,
      reason: 'dirty_index_required',
      error: expect.stringContaining('oss'),
    });
    expect(git(repo, ['log', '-1', '--pretty=%B'])).toBe('add oss submodule');
  });
});
