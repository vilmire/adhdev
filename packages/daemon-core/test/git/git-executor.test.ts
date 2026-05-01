import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitCommandError, resolveGitRepository, runGit } from '../../src/git/git-executor.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('safe git executor', () => {
  const roots: string[] = [];

  function tempDir(name: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), `adhdev-${name}-`)));
    roots.push(dir);
    return dir;
  }

  function initRepo(): string {
    const repo = tempDir('git-executor');
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'ADHDev Test']);
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-m', 'initial commit']);
    return repo;
  }

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires an absolute existing workspace directory', async () => {
    await expect(resolveGitRepository('relative/path')).rejects.toMatchObject({
      reason: 'invalid_args',
    });

    await expect(resolveGitRepository(join(tmpdir(), 'missing-adhdev-workspace'))).rejects.toMatchObject({
      reason: 'invalid_args',
    });
  });

  it('reports non-git directories with an explicit reason', async () => {
    const dir = tempDir('not-git');

    await expect(resolveGitRepository(dir)).rejects.toMatchObject({
      reason: 'not_git_repo',
    });
  });

  it('resolves the repository root from a nested workspace and executes with cwd', async () => {
    const repo = initRepo();
    const nested = join(repo, 'packages', 'daemon-core');
    mkdirSync(nested, { recursive: true });

    const resolved = await resolveGitRepository(nested);
    expect(resolved).toMatchObject({
      workspace: nested,
      repoRoot: repo,
      isGitRepo: true,
    });

    const result = await runGit(resolved, ['rev-parse', '--show-prefix']);
    expect(result.stdout).toBe('packages/daemon-core/\n');
    expect(result.stderr).toBe('');
  });

  it('rejects unsafe or malformed argv before spawning git', async () => {
    const repo = initRepo();

    await expect(runGit(repo, [])).rejects.toMatchObject({ reason: 'invalid_args' });
    await expect(runGit(repo, ['-C', '/tmp', 'status'])).rejects.toMatchObject({
      reason: 'invalid_args',
    });
    await expect(runGit(repo, ['status\0--porcelain'])).rejects.toMatchObject({
      reason: 'invalid_args',
    });
  });

  it('normalizes git command failures into GitCommandError', async () => {
    const repo = initRepo();

    await expect(runGit(repo, ['definitely-not-a-real-subcommand'])).rejects.toBeInstanceOf(
      GitCommandError,
    );
    await expect(runGit(repo, ['definitely-not-a-real-subcommand'])).rejects.toMatchObject({
      reason: 'git_command_failed',
    });
  });
});
