import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { syncClonedWorktreeSubmodules } from '../../src/commands/med-family/mesh-crud.js';
import { getRegisteredSubmodulePaths } from '../../src/mesh/worktree-bootstrap-config.js';
import { runGit } from '../../src/git/git-executor.js';

/**
 * GENERALIZATION-AUDIT F16 — clone-sync submodule name generalization.
 *
 * The clone-time submodule sync used to hardcode the `oss` submodule name and this
 * repo's layout. syncClonedWorktreeSubmodules now enumerates submodules from
 * `.gitmodules` (via getRegisteredSubmodulePaths) and applies the same rewind guard
 * to EVERY registered submodule. These tests prove the sync works for a submodule
 * that is NOT named `oss` (here: `vendor`), so the generalization is real and not
 * accidentally still oss-specific.
 */
describe('clone-sync submodule generalization (F16)', () => {
  const roots: string[] = [];

  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  }

  function initRepo(name: string): string {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), `adhdev-${name}-`)));
    roots.push(repo);
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'ADHDev Test']);
    return repo;
  }

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('getRegisteredSubmodulePaths is name-agnostic — returns any registered submodule, not just oss', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'adhdev-gitmodules-generic-')));
    roots.push(dir);
    // A .gitmodules with submodules that are deliberately NOT named 'oss'.
    writeFileSync(
      join(dir, '.gitmodules'),
      [
        '[submodule "vendor"]',
        '\tpath = vendor',
        '\turl = https://example.com/vendor.git',
        '[submodule "libs-foo"]',
        '\tpath = libs/foo',
        '\turl = https://example.com/foo.git',
      ].join('\n') + '\n',
    );

    const paths = getRegisteredSubmodulePaths(dir);
    expect(paths.has('vendor')).toBe(true);
    expect(paths.has('libs/foo')).toBe(true);
    expect(paths.has('oss')).toBe(false);
    expect(paths.size).toBe(2);
  });

  // Build the shared submodule upstream with a linear history c1 -> c2 (c2 newer).
  function buildSubmoduleUpstream(): { upstream: string; c1: string; c2: string } {
    const upstream = initRepo('clone-sync-generic-upstream');
    const commit = (file: string, msg: string): string => {
      writeFileSync(join(upstream, file), `${msg}\n`);
      git(upstream, ['add', file]);
      git(upstream, ['commit', '-m', msg]);
      return git(upstream, ['rev-parse', 'HEAD']);
    };
    const c1 = commit('a', 'c1');
    const c2 = commit('b', 'c2');
    return { upstream, c1, c2 };
  }

  // Create a superproject with the upstream mounted at `vendor`, pinned to `pinSha`.
  function buildSuperproject(name: string, upstream: string, pinSha: string): string {
    const repo = initRepo(name);
    git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', upstream, 'vendor']);
    git(join(repo, 'vendor'), ['checkout', pinSha]);
    git(repo, ['add', 'vendor']);
    git(repo, ['commit', '-m', 'add vendor submodule']);
    return repo;
  }

  it('advances a non-oss submodule (vendor) to a strictly-newer source HEAD and commits the gitlink', async () => {
    const { upstream, c1, c2 } = buildSubmoduleUpstream();
    // Source node's vendor is at the newer c2; the fresh worktree's vendor is at c1.
    const source = buildSuperproject('clone-sync-generic-source', upstream, c2);
    const worktree = buildSuperproject('clone-sync-generic-worktree', upstream, c1);

    expect(git(join(worktree, 'vendor'), ['rev-parse', 'HEAD'])).toBe(c1);

    await syncClonedWorktreeSubmodules(worktree, source, runGit);

    // vendor advanced to the newer source SHA...
    expect(git(join(worktree, 'vendor'), ['rev-parse', 'HEAD'])).toBe(c2);
    // ...and the superproject recorded the gitlink move with the generalized message.
    expect(git(worktree, ['log', '-1', '--pretty=%B'])).toBe('chore: sync vendor to source node HEAD on clone');
    // Real `git submodule add` clones twice (source + worktree superproject); on win32
    // that alone is ~25s, so this integration test needs more than the 30s global floor.
  }, 60_000);

  it('does NOT rewind a non-oss submodule when the source HEAD is an older ancestor (guard preserved generically)', async () => {
    const { upstream, c1, c2 } = buildSubmoduleUpstream();
    // Fresh worktree vendor is at the newer c2; source lags at c1 → must NOT rewind.
    const source = buildSuperproject('clone-sync-generic-source-rewind', upstream, c1);
    const worktree = buildSuperproject('clone-sync-generic-worktree-rewind', upstream, c2);

    const headBefore = git(worktree, ['rev-parse', 'HEAD']);
    await syncClonedWorktreeSubmodules(worktree, source, runGit);

    // vendor stays at the fresher c2 and no sync commit was created.
    expect(git(join(worktree, 'vendor'), ['rev-parse', 'HEAD'])).toBe(c2);
    expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(headBefore);
  }, 60_000);
});
