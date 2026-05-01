import { describe, expect, it } from 'vitest';
import {
  GitWorkspaceMonitor,
  MIN_GIT_WORKSPACE_POLL_INTERVAL_MS,
  normalizeGitWorkspaceSubscriptionParams,
} from '../../src/git/git-monitor.js';
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

describe('GitWorkspaceMonitor', () => {
  it('refreshes status, caches compact summary, and emits sequential updates without mandatory intervals', async () => {
    const emitted: number[] = [];
    const monitor = new GitWorkspaceMonitor({
      now: () => 500,
      getStatus: () => status({ modified: 1 }),
    });
    monitor.onUpdate((update, cacheEntry) => {
      emitted.push(update.seq);
      expect(cacheEntry.compactSummary.dirty).toBe(true);
    });

    const update = await monitor.refresh('/repo');

    expect(update).toMatchObject({
      topic: 'workspace.git',
      key: 'git:/repo',
      workspace: '/repo',
      seq: 1,
      timestamp: 500,
    });
    expect(update.diffSummary).toBeUndefined();
    expect(emitted).toEqual([1]);
    expect(monitor.getCached('/repo')?.status.modified).toBe(1);
    expect(monitor.getCompactSummary('/repo')).toMatchObject({ dirty: true, changedFiles: 1 });
  });

  it('includes diff summaries on explicit refresh when requested', async () => {
    let diffCalls = 0;
    const monitor = new GitWorkspaceMonitor({
      now: () => 501,
      getStatus: () => status({ modified: 1 }),
      getDiffSummary: () => {
        diffCalls += 1;
        return diff({ files: [{ path: 'src/a.ts', status: 'modified', staged: false, insertions: 2, deletions: 1 }] });
      },
    });

    const update = await monitor.refresh({ workspace: '/repo', includeDiffSummary: true });

    expect(diffCalls).toBe(1);
    expect(update.diffSummary?.files).toHaveLength(1);
    expect(monitor.getCached('/repo')?.compactSummary.changedFiles).toBe(1);
  });

  it('normalizes subscription params and clamps short intervals', () => {
    expect(
      normalizeGitWorkspaceSubscriptionParams({ workspace: '/repo', includeDiffSummary: true, intervalMs: 10 }),
    ).toEqual({
      workspace: '/repo',
      includeDiffSummary: true,
      intervalMs: MIN_GIT_WORKSPACE_POLL_INTERVAL_MS,
    });

    expect(normalizeGitWorkspaceSubscriptionParams({ workspace: '/repo' })).toEqual({
      workspace: '/repo',
      includeDiffSummary: false,
      intervalMs: 5000,
    });
  });

  it('creates explicit subscriptions that only refresh when called', async () => {
    let statusCalls = 0;
    const monitor = new GitWorkspaceMonitor({
      getStatus: () => {
        statusCalls += 1;
        return status({ modified: statusCalls });
      },
      minIntervalMs: 250,
      defaultIntervalMs: 1000,
    });

    const subscription = monitor.createSubscription({ workspace: '/repo', intervalMs: 1 });

    expect(subscription.params.intervalMs).toBe(250);
    expect(statusCalls).toBe(0);

    await subscription.refresh();

    expect(statusCalls).toBe(1);
    expect(subscription.getCached()?.status.modified).toBe(1);
    subscription.dispose();
  });
});
