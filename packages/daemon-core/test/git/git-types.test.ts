import { describe, expectTypeOf, it } from 'vitest';
import type {
  CompactSessionEntry,
  GitCompactSummary,
  GitCommandName,
  GitWorkspaceUpdate,
  SessionEntry,
  SubscribeRequest,
  TopicUpdateEnvelope,
  TransportTopic,
} from '../../src/shared-types.js';

describe('Git shared surface types', () => {
  it('includes workspace.git in transport subscription and update contracts', () => {
    const topic: TransportTopic = 'workspace.git';
    expectTypeOf(topic).toEqualTypeOf<TransportTopic>();

    const subscribe: SubscribeRequest = {
      type: 'subscribe',
      topic: 'workspace.git',
      key: 'git:/repo',
      params: {
        workspace: '/repo',
        includeDiffSummary: true,
        intervalMs: 2000,
      },
    };
    expectTypeOf(subscribe.params.workspace).toEqualTypeOf<string>();

    const update: GitWorkspaceUpdate = {
      topic: 'workspace.git',
      key: 'git:/repo',
      workspace: '/repo',
      status: {
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
        modified: 1,
        untracked: 0,
        deleted: 0,
        renamed: 0,
        hasConflicts: false,
        conflictFiles: [],
        stashCount: 0,
        lastCheckedAt: 1,
      },
      seq: 1,
      timestamp: 1,
    };
    expectTypeOf(update).toMatchTypeOf<TopicUpdateEnvelope>();
  });

  it('attaches compact git summaries to both rich and compact session entries', () => {
    const git: GitCompactSummary = {
      isGitRepo: true,
      repoRoot: '/repo',
      branch: 'main',
      dirty: true,
      changedFiles: 2,
      ahead: 1,
      behind: 0,
      hasConflicts: false,
      lastCheckedAt: 1,
    };

    expectTypeOf<{ git?: GitCompactSummary }>().toMatchTypeOf<Pick<SessionEntry, 'git'>>();
    expectTypeOf<{ git?: GitCompactSummary }>().toMatchTypeOf<Pick<CompactSessionEntry, 'git'>>();
    expectTypeOf(git).toMatchTypeOf<SessionEntry['git']>();
    expectTypeOf(git).toMatchTypeOf<CompactSessionEntry['git']>();
  });

  it('freezes public command names for later command routing batches', () => {
    const readOnlyCommands: GitCommandName[] = [
      'git_status',
      'git_diff_summary',
      'git_diff_file',
      'git_snapshot_create',
      'git_snapshot_compare',
      'git_log',
    ];
    expectTypeOf<typeof readOnlyCommands[number]>().toMatchTypeOf<GitCommandName>();
  });
});
