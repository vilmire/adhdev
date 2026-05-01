import { describe, expect, it } from 'vitest';
import { compareGitSnapshots, createGitSnapshotStore } from '../../src/git/git-snapshot-store.js';
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

describe('GitSnapshotStore', () => {
  it('creates deterministic in-memory snapshots from injected providers', async () => {
    let now = 1000;
    const store = createGitSnapshotStore({
      now: () => now,
      getStatus: () => status({ modified: 1 }),
      getDiffSummary: () => diff({ files: [{ path: 'src/a.ts', status: 'modified', staged: false, insertions: 4, deletions: 1 }] }),
    });

    const first = await store.create({ workspace: '/repo', reason: 'session_baseline', sessionId: 's1', turnId: 't1' });
    now = 1001;
    const second = await store.create({ workspace: '/repo', reason: 'manual' });

    expect(first.id).toBe('git-snapshot-1000-1');
    expect(second.id).toBe('git-snapshot-1001-2');
    expect(store.get(first.id)).toBe(first);
    expect(first).toMatchObject({ workspace: '/repo', repoRoot: '/repo', sessionId: 's1', turnId: 't1', reason: 'session_baseline' });
  });

  it('enforces bounded capacity and evicts the oldest snapshots', async () => {
    let now = 1;
    const store = createGitSnapshotStore({
      capacity: 2,
      now: () => now++,
      getStatus: () => status(),
    });

    const one = await store.create({ workspace: '/repo', reason: 'manual' });
    const two = await store.create({ workspace: '/repo', reason: 'manual' });
    const three = await store.create({ workspace: '/repo', reason: 'manual' });

    expect(store.get(one.id)).toBeUndefined();
    expect(store.list({ limit: 10 }).map((snapshot) => snapshot.id)).toEqual([two.id, three.id]);
  });

  it('compares snapshots by changed file sets using the after snapshot status', async () => {
    const diffs = [
      diff({ files: [{ path: 'already-dirty.ts', status: 'modified', staged: false, insertions: 1, deletions: 0 }] }),
      diff({
        files: [
          { path: 'already-dirty.ts', status: 'modified', staged: false, insertions: 10, deletions: 2 },
          { path: 'src/new.ts', status: 'added', staged: true, insertions: 5, deletions: 0 },
          { path: 'src/edit.ts', status: 'modified', staged: false, insertions: 3, deletions: 1 },
          { path: 'src/untracked.ts', status: 'untracked', staged: false, insertions: 7, deletions: 0 },
          { oldPath: 'src/old.ts', path: 'src/renamed.ts', status: 'renamed', staged: true, insertions: 0, deletions: 0 },
        ],
      }),
    ];
    const statuses = [status({ modified: 1 }), status({ staged: 2, modified: 2, untracked: 1 })];
    const store = createGitSnapshotStore({
      now: () => 100,
      getStatus: () => statuses.shift() ?? status(),
      getDiffSummary: () => diffs.shift() ?? diff(),
    });

    const before = await store.create({ workspace: '/repo', reason: 'session_baseline' });
    const after = await store.create({ workspace: '/repo', reason: 'after_agent_work' });
    const comparison = store.compare(before.id, after.id);

    expect(comparison.beforeSnapshotId).toBe(before.id);
    expect(comparison.afterSnapshotId).toBe(after.id);
    expect(comparison.changedFiles).toBe(4);
    expect(comparison.addedFiles).toEqual(['src/new.ts']);
    expect(comparison.modifiedFiles).toEqual(['src/edit.ts']);
    expect(comparison.untrackedFiles).toEqual(['src/untracked.ts']);
    expect(comparison.renamedFiles).toEqual([{ oldPath: 'src/old.ts', path: 'src/renamed.ts' }]);
    expect(comparison.totalInsertions).toBe(15);
    expect(comparison.totalDeletions).toBe(1);
    expect(comparison.currentStatus).toBe(after.status);
    expect(comparison.summaryText).toContain('4 files changed');
  });

  it('reports current conflicts from the after snapshot', () => {
    const before = {
      id: 'before',
      workspace: '/repo',
      repoRoot: '/repo',
      reason: 'manual' as const,
      status: status(),
      diffSummary: diff(),
      createdAt: 1,
    };
    const after = {
      id: 'after',
      workspace: '/repo',
      repoRoot: '/repo',
      reason: 'manual' as const,
      status: status({ hasConflicts: true, conflictFiles: ['src/conflict.ts'] }),
      diffSummary: diff({ files: [{ path: 'src/conflict.ts', status: 'conflict', staged: false, insertions: 0, deletions: 0 }] }),
      createdAt: 2,
    };

    expect(compareGitSnapshots(before, after)).toMatchObject({
      changedFiles: 1,
      conflictFiles: ['src/conflict.ts'],
      hasConflicts: true,
    });
  });
});
