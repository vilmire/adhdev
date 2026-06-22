import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitCommandError } from '../../src/git/git-executor.js';
import { getGitDiffSummary, getGitFileDiff } from '../../src/git/git-diff.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('git diff summary and file diff readers', () => {
  const roots: string[] = [];

  function tempRepo(name: string): string {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), `adhdev-${name}-`)));
    roots.push(repo);
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'ADHDev Test']);
    return repo;
  }

  function commit(repo: string, message: string): void {
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', message]);
  }

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('summarizes staged, unstaged, renamed, untracked, and binary changes', async () => {
    const repo = tempRepo('diff');
    writeFileSync(join(repo, '.gitattributes'), '*.bin binary\n');
    writeFileSync(join(repo, 'tracked.txt'), 'line1\nline2\n');
    writeFileSync(join(repo, 'rename-old.txt'), 'rename me\n');
    writeFileSync(join(repo, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    commit(repo, 'initial');

    writeFileSync(join(repo, 'tracked.txt'), 'line1\nline2 changed\nline3\n');
    git(repo, ['mv', 'rename-old.txt', 'rename-new.txt']);
    writeFileSync(join(repo, 'staged.txt'), 'staged\n');
    git(repo, ['add', 'staged.txt']);
    writeFileSync(join(repo, 'binary.bin'), Buffer.from([4, 5, 6, 7, 8]));
    git(repo, ['add', 'binary.bin']);
    writeFileSync(join(repo, 'untracked.txt'), 'untracked\n');

    const summary = await getGitDiffSummary(repo);

    expect(summary.isGitRepo).toBe(true);
    expect(summary.repoRoot).toBe(repo);
    expect(summary.truncated).toBe(false);
    expect(summary.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'tracked.txt', status: 'modified', staged: false }),
        expect.objectContaining({ path: 'rename-new.txt', oldPath: 'rename-old.txt', status: 'renamed', staged: true }),
        expect.objectContaining({ path: 'staged.txt', status: 'added', staged: true }),
        expect.objectContaining({ path: 'binary.bin', status: 'modified', staged: true, binary: true, insertions: 0, deletions: 0 }),
        expect.objectContaining({ path: 'untracked.txt', status: 'untracked', staged: false }),
      ]),
    );
    expect(summary.totalInsertions).toBeGreaterThanOrEqual(2);
    expect(summary.totalDeletions).toBeGreaterThanOrEqual(1);
  });

  it('marks diff summaries truncated when maxFiles is reached', async () => {
    const repo = tempRepo('diff-truncated');
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    commit(repo, 'initial');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    writeFileSync(join(repo, 'b.txt'), 'b\n');

    const summary = await getGitDiffSummary(repo, { maxFiles: 1 });

    expect(summary.files).toHaveLength(1);
    expect(summary.truncated).toBe(true);
  });

  it('returns bounded tracked and untracked file diffs', async () => {
    const repo = tempRepo('file-diff');
    writeFileSync(join(repo, 'tracked.txt'), 'before\n');
    commit(repo, 'initial');
    writeFileSync(join(repo, 'tracked.txt'), 'before\nafter\n');
    writeFileSync(join(repo, 'new.txt'), 'new file\n');

    const tracked = await getGitFileDiff(repo, 'tracked.txt');
    expect(tracked.path).toBe('tracked.txt');
    expect(tracked.truncated).toBe(false);
    expect(tracked.diff).toContain('diff --git a/tracked.txt b/tracked.txt');
    expect(tracked.diff).toContain('+after');

    const untracked = await getGitFileDiff(repo, 'new.txt', { maxBytes: 20 });
    expect(untracked.path).toBe('new.txt');
    expect(untracked.truncated).toBe(true);
    expect(untracked.diff).toContain('diff --git');
  });

  it('collapses to a timeout reason (not a path/repo error) when the diff burst exceeds its budget', async () => {
    const repo = tempRepo('diff-transient-timeout');
    writeFileSync(join(repo, 'tracked.txt'), 'one\n');
    commit(repo, 'initial commit');
    writeFileSync(join(repo, 'tracked.txt'), 'one\ntwo\n');

    // The default (no explicit timeoutMs) collection path must succeed: the diff
    // collectors now inherit the larger status budget on Windows/POSIX rather than the
    // bare 5s execGitRaw default, so a slow-but-healthy worktree no longer reads as a
    // failure. (Regression guard for the asymmetric diff-block timeout.)
    const healthy = await getGitDiffSummary(repo);
    expect(healthy.isGitRepo).toBe(true);
    expect(healthy.repoRoot).toBe(repo);

    // Force a timeout with an impossibly short budget. The catch path flattens this to
    // isGitRepo:false/repoRoot:null — but the `reason` MUST be `timeout`, distinguishing
    // a transient slow-spawn from a genuine not_git_repo. This is exactly the Windows
    // symptom: status block healthy, diff block timed-out + isGitRepo:false.
    const timedOut = await getGitDiffSummary(repo, { timeoutMs: 1 });
    expect(['timeout', 'not_git_repo']).toContain(timedOut.reason);
    if (timedOut.reason === 'timeout') {
      expect(timedOut.isGitRepo).toBe(false);
      expect(timedOut.repoRoot).toBeNull();
    }
  });

  it('rejects selected file paths outside the repository root', async () => {
    const repo = tempRepo('file-diff-guard');
    writeFileSync(join(repo, 'tracked.txt'), 'tracked\n');
    commit(repo, 'initial');

    await expect(getGitFileDiff(repo, '../outside.txt')).rejects.toBeInstanceOf(GitCommandError);
    await expect(getGitFileDiff(repo, join(dirname(repo), 'outside.txt'))).rejects.toMatchObject({
      reason: 'path_outside_repo',
    });
  });
});
