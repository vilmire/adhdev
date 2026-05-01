import { describe, expect, it } from 'vitest';
import { createGitCompactSummary } from '../../src/git/git-summary.js';
import type { GitDiffSummary, GitRepoStatus } from '../../src/git/git-types.js';

function status(overrides: Partial<GitRepoStatus> = {}): GitRepoStatus {
  return {
    workspace: '/repo',
    repoRoot: '/repo',
    isGitRepo: true,
    branch: 'main',
    headCommit: 'abc123',
    headMessage: 'initial',
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    untracked: 0,
    deleted: 0,
    renamed: 0,
    hasConflicts: false,
    conflictFiles: [],
    stashCount: 0,
    lastCheckedAt: 10,
    ...overrides,
  };
}

function diff(overrides: Partial<GitDiffSummary> = {}): GitDiffSummary {
  return {
    workspace: '/repo',
    repoRoot: '/repo',
    isGitRepo: true,
    files: [],
    totalInsertions: 0,
    totalDeletions: 0,
    truncated: false,
    lastCheckedAt: 10,
    ...overrides,
  };
}

describe('createGitCompactSummary', () => {
  it('summarizes a clean repository without marking it dirty', () => {
    expect(createGitCompactSummary(status())).toEqual({
      isGitRepo: true,
      repoRoot: '/repo',
      branch: 'main',
      dirty: false,
      changedFiles: 0,
      ahead: 0,
      behind: 0,
      hasConflicts: false,
      lastCheckedAt: 10,
      error: undefined,
      reason: undefined,
    });
  });

  it('marks dirty from status counts and preserves ahead/behind', () => {
    const summary = createGitCompactSummary(status({ staged: 1, modified: 2, ahead: 1, behind: 3 }));

    expect(summary.dirty).toBe(true);
    expect(summary.changedFiles).toBe(3);
    expect(summary.ahead).toBe(1);
    expect(summary.behind).toBe(3);
  });

  it('uses diff file count when it has more detail than aggregate status counts', () => {
    const summary = createGitCompactSummary(
      status({ modified: 1, lastCheckedAt: 10 }),
      diff({
        files: [
          { path: 'a.ts', status: 'modified', staged: false, insertions: 1, deletions: 0 },
          { path: 'b.ts', status: 'untracked', staged: false, insertions: 3, deletions: 0 },
        ],
        lastCheckedAt: 12,
      }),
    );

    expect(summary.dirty).toBe(true);
    expect(summary.changedFiles).toBe(2);
    expect(summary.lastCheckedAt).toBe(12);
  });

  it('preserves not-git and error surfaces explicitly', () => {
    const summary = createGitCompactSummary(
      status({
        repoRoot: null,
        isGitRepo: false,
        branch: null,
        headCommit: null,
        headMessage: null,
        upstream: null,
        error: 'not a git repository',
        reason: 'not_git_repo',
      }),
    );

    expect(summary).toMatchObject({
      isGitRepo: false,
      repoRoot: null,
      branch: null,
      dirty: false,
      changedFiles: 0,
      error: 'not a git repository',
      reason: 'not_git_repo',
    });
  });

  it('treats conflicts as dirty even when aggregate counts are zero', () => {
    const summary = createGitCompactSummary(status({ hasConflicts: true, conflictFiles: ['src/a.ts'] }));

    expect(summary.dirty).toBe(true);
    expect(summary.hasConflicts).toBe(true);
    expect(summary.changedFiles).toBe(1);
  });
});
