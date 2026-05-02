import { describe, expect, it, vi } from 'vitest';
import {
  handleGitCommand,
  isGitCommandName,
  type GitCheckpointResult,
  type GitCommandServices,
  type GitStashPushResult,
} from '../../src/git/git-commands.js';

const workspace = '/tmp/repo';

function makeCheckpointResult(overrides: Partial<GitCheckpointResult> = {}): GitCheckpointResult {
  return {
    workspace,
    repoRoot: workspace,
    isGitRepo: true,
    commit: 'abc1234',
    message: 'adhdev: checkpoint my change',
    lastCheckedAt: 1,
    ...overrides,
  };
}

function makeStashResult(overrides: Partial<GitStashPushResult> = {}): GitStashPushResult {
  return {
    workspace,
    repoRoot: workspace,
    isGitRepo: true,
    stashRef: 'stash@{0}',
    message: 'my stash',
    lastCheckedAt: 1,
    ...overrides,
  };
}

describe('git_checkpoint', () => {
  it('returns invalid_args when message is empty', async () => {
    const checkpoint = vi.fn(async () => makeCheckpointResult());
    const services: GitCommandServices = { checkpoint };

    const result = await handleGitCommand('git_checkpoint', { workspace, message: '' }, services);
    expect(result).toMatchObject({ success: false, reason: 'invalid_args' });
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it('returns invalid_args when message is missing', async () => {
    const checkpoint = vi.fn(async () => makeCheckpointResult());
    const services: GitCommandServices = { checkpoint };

    const result = await handleGitCommand('git_checkpoint', { workspace }, services);
    expect(result).toMatchObject({ success: false, reason: 'invalid_args' });
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it('returns invalid_args when message exceeds 200 chars', async () => {
    const checkpoint = vi.fn(async () => makeCheckpointResult());
    const services: GitCommandServices = { checkpoint };

    const result = await handleGitCommand(
      'git_checkpoint',
      { workspace, message: 'a'.repeat(201) },
      services,
    );
    expect(result).toMatchObject({ success: false, reason: 'invalid_args' });
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it('returns conflict failure when service throws conflict error', async () => {
    const { GitCommandError } = await import('../../src/git/git-executor.js');
    const services: GitCommandServices = {
      checkpoint: () => {
        throw new GitCommandError('conflict', 'Repository has conflicts — resolve before checkpointing');
      },
    };

    const result = await handleGitCommand(
      'git_checkpoint',
      { workspace, message: 'save' },
      services,
    );
    expect(result).toMatchObject({ success: false, reason: 'conflict' });
  });

  it('calls checkpoint service with correct args including includeUntracked', async () => {
    const checkpoint = vi.fn(async () => makeCheckpointResult());
    const services: GitCommandServices = { checkpoint };

    const result = await handleGitCommand(
      'git_checkpoint',
      { workspace, message: 'my change', includeUntracked: true },
      services,
    );
    expect(result).toMatchObject({ success: true, checkpoint: makeCheckpointResult() });
    expect(checkpoint).toHaveBeenCalledWith({
      workspace,
      message: 'my change',
      includeUntracked: true,
    });
  });

  it('returns serviceNotImplemented when checkpoint service is not configured', async () => {
    const result = await handleGitCommand('git_checkpoint', { workspace, message: 'test' }, {});
    expect(result).toMatchObject({
      success: false,
      reason: 'invalid_args',
      error: expect.stringContaining('not implemented'),
    });
  });
});

describe('git_stash_push', () => {
  it('returns invalid_args when message is empty', async () => {
    const stashPush = vi.fn(async () => makeStashResult());
    const services: GitCommandServices = { stashPush };

    const result = await handleGitCommand('git_stash_push', { workspace, message: '' }, services);
    expect(result).toMatchObject({ success: false, reason: 'invalid_args' });
    expect(stashPush).not.toHaveBeenCalled();
  });

  it('calls stashPush service with correct args', async () => {
    const stashPush = vi.fn(async () => makeStashResult());
    const services: GitCommandServices = { stashPush };

    const result = await handleGitCommand(
      'git_stash_push',
      { workspace, message: 'my stash', includeUntracked: false },
      services,
    );
    expect(result).toMatchObject({ success: true, stash: makeStashResult() });
    expect(stashPush).toHaveBeenCalledWith({
      workspace,
      message: 'my stash',
      includeUntracked: false,
    });
  });

  it('returns serviceNotImplemented when stashPush service is not configured', async () => {
    const result = await handleGitCommand('git_stash_push', { workspace, message: 'test' }, {});
    expect(result).toMatchObject({
      success: false,
      reason: 'invalid_args',
      error: expect.stringContaining('not implemented'),
    });
  });
});

describe('git_stash_pop', () => {
  it('accepts valid stashRef format', async () => {
    const stashPop = vi.fn(async () => {});
    const services: GitCommandServices = { stashPop };

    const result = await handleGitCommand(
      'git_stash_pop',
      { workspace, stashRef: 'stash@{0}' },
      services,
    );
    expect(result).toMatchObject({ success: true, stashPopped: true });
    expect(stashPop).toHaveBeenCalledWith({ workspace, stashRef: 'stash@{0}' });
  });

  it('accepts valid stashRef with higher index', async () => {
    const stashPop = vi.fn(async () => {});
    const services: GitCommandServices = { stashPop };

    const result = await handleGitCommand(
      'git_stash_pop',
      { workspace, stashRef: 'stash@{3}' },
      services,
    );
    expect(result).toMatchObject({ success: true, stashPopped: true });
  });

  it('rejects invalid stashRef format', async () => {
    const stashPop = vi.fn(async () => {});
    const services: GitCommandServices = { stashPop };

    for (const invalidRef of ['invalid', 'stash@0', 'stash{0}', 'stash@{abc}']) {
      const result = await handleGitCommand(
        'git_stash_pop',
        { workspace, stashRef: invalidRef },
        services,
      );
      expect(result).toMatchObject({ success: false, reason: 'invalid_args' });
    }
    expect(stashPop).not.toHaveBeenCalled();
  });

  it('works without stashRef (pop latest)', async () => {
    const stashPop = vi.fn(async () => {});
    const services: GitCommandServices = { stashPop };

    const result = await handleGitCommand('git_stash_pop', { workspace }, services);
    expect(result).toMatchObject({ success: true, stashPopped: true });
    expect(stashPop).toHaveBeenCalledWith({ workspace, stashRef: undefined });
  });

  it('returns serviceNotImplemented when stashPop service is not configured', async () => {
    const result = await handleGitCommand('git_stash_pop', { workspace }, {});
    expect(result).toMatchObject({
      success: false,
      reason: 'invalid_args',
      error: expect.stringContaining('not implemented'),
    });
  });
});

describe('git_checkout_files', () => {
  it('rejects empty paths array', async () => {
    const checkoutFiles = vi.fn(async () => ({ checkedOut: [] }));
    const services: GitCommandServices = { checkoutFiles };

    const result = await handleGitCommand(
      'git_checkout_files',
      { workspace, paths: [] },
      services,
    );
    expect(result).toMatchObject({ success: false, reason: 'invalid_args' });
    expect(checkoutFiles).not.toHaveBeenCalled();
  });

  it('rejects when paths is not an array', async () => {
    const checkoutFiles = vi.fn(async () => ({ checkedOut: [] }));
    const services: GitCommandServices = { checkoutFiles };

    const result = await handleGitCommand(
      'git_checkout_files',
      { workspace, paths: 'src/file.ts' },
      services,
    );
    expect(result).toMatchObject({ success: false, reason: 'invalid_args' });
    expect(checkoutFiles).not.toHaveBeenCalled();
  });

  it('rejects more than 50 paths', async () => {
    const checkoutFiles = vi.fn(async () => ({ checkedOut: [] }));
    const services: GitCommandServices = { checkoutFiles };
    const paths = Array.from({ length: 51 }, (_, i) => `src/file${i}.ts`);

    const result = await handleGitCommand(
      'git_checkout_files',
      { workspace, paths },
      services,
    );
    expect(result).toMatchObject({ success: false, reason: 'invalid_args' });
    expect(checkoutFiles).not.toHaveBeenCalled();
  });

  it('calls checkoutFiles service with valid paths', async () => {
    const checkoutFiles = vi.fn(async () => ({ checkedOut: ['src/index.ts'] }));
    const services: GitCommandServices = { checkoutFiles };

    const result = await handleGitCommand(
      'git_checkout_files',
      { workspace, paths: ['src/index.ts'] },
      services,
    );
    expect(result).toMatchObject({ success: true, checkedOut: ['src/index.ts'] });
    expect(checkoutFiles).toHaveBeenCalledWith({ workspace, paths: ['src/index.ts'] });
  });

  it('returns serviceNotImplemented when checkoutFiles service is not configured', async () => {
    const result = await handleGitCommand(
      'git_checkout_files',
      { workspace, paths: ['src/index.ts'] },
      {},
    );
    expect(result).toMatchObject({
      success: false,
      reason: 'invalid_args',
      error: expect.stringContaining('not implemented'),
    });
  });
});

describe('MUTATING_COMMAND_NAMES stub removal', () => {
  it('mutating commands are no longer blocked by an early-return stub', async () => {
    // Each command must reach serviceNotImplemented (service routing), not the old
    // "not implemented in daemon-core read-only Git routing" stub message.
    for (const cmd of ['git_checkpoint', 'git_stash_push', 'git_stash_pop', 'git_checkout_files'] as const) {
      const args: any = { workspace }
      if (cmd === 'git_checkpoint' || cmd === 'git_stash_push') args.message = 'test'
      if (cmd === 'git_checkout_files') args.paths = ['src/index.ts']
      const result = await handleGitCommand(cmd, args, {});
      expect(result).toMatchObject({ success: false, reason: 'invalid_args' });
      // The old stub message contained "daemon-core read-only Git routing"
      expect((result as any).error).not.toContain('read-only Git routing');
    }
  });

  it('isGitCommandName returns true for all 10 git command names', () => {
    const expected = [
      'git_status',
      'git_diff_summary',
      'git_diff_file',
      'git_snapshot_create',
      'git_snapshot_compare',
      'git_log',
      'git_checkpoint',
      'git_stash_push',
      'git_stash_pop',
      'git_checkout_files',
    ] as const;

    for (const name of expected) {
      expect(isGitCommandName(name)).toBe(true);
    }
  });
});
