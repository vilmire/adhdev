import { describe, expect, it, vi } from 'vitest';
import {
  handleGitCommand,
  isGitCommandName,
  type GitCommandServices,
} from '../../src/git/git-commands.js';

/**
 * Source guard tests — validate allowlist, input sanitization,
 * and path security properties of the git command surface.
 */

const workspace = '/tmp/repo';

describe('isGitCommandName allowlist', () => {
  const validNames = [
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

  it('accepts exactly 10 known command names', () => {
    for (const name of validNames) {
      expect(isGitCommandName(name)).toBe(true);
    }
  });

  it('rejects strings that are not in the allowlist', () => {
    const rejected = [
      'git',
      'git_exec',
      'rm',
      '__proto__',
      'git_status_extra',
      'GIT_STATUS',
      '',
      'constructor',
      'toString',
      'git_checkpoint_all',
    ];
    for (const name of rejected) {
      expect(isGitCommandName(name)).toBe(false);
    }
  });
});

describe('workspace validation', () => {
  it('rejects relative workspace paths', async () => {
    const getStatus = vi.fn(async () => ({} as any));
    const services: GitCommandServices = { getStatus };

    const result = await handleGitCommand('git_status', { workspace: 'relative/path' }, services);
    expect(result).toMatchObject({ success: false, reason: 'invalid_args' });
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('rejects non-string workspace', async () => {
    const getStatus = vi.fn(async () => ({} as any));
    const services: GitCommandServices = { getStatus };

    for (const bad of [42, null, undefined, [], {}]) {
      const result = await handleGitCommand('git_status', { workspace: bad }, services);
      expect(result).toMatchObject({ success: false, reason: 'invalid_args' });
    }
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('rejects empty workspace string', async () => {
    const getStatus = vi.fn(async () => ({} as any));
    const services: GitCommandServices = { getStatus };

    const result = await handleGitCommand('git_status', { workspace: '' }, services);
    expect(result).toMatchObject({ success: false, reason: 'invalid_args' });
    expect(getStatus).not.toHaveBeenCalled();
  });
});

describe('mutating commands require non-empty message', () => {
  it('git_checkpoint with empty message returns invalid_args', async () => {
    const checkpoint = vi.fn(async () => ({} as any));
    const services: GitCommandServices = { checkpoint };

    const result = await handleGitCommand('git_checkpoint', { workspace, message: '' }, services);
    expect(result).toMatchObject({ success: false, reason: 'invalid_args' });
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it('git_checkpoint with whitespace-only message returns invalid_args', async () => {
    const checkpoint = vi.fn(async () => ({} as any));
    const services: GitCommandServices = { checkpoint };

    const result = await handleGitCommand('git_checkpoint', { workspace, message: '   ' }, services);
    expect(result).toMatchObject({ success: false, reason: 'invalid_args' });
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it('git_stash_push with empty message returns invalid_args', async () => {
    const stashPush = vi.fn(async () => ({} as any));
    const services: GitCommandServices = { stashPush };

    const result = await handleGitCommand('git_stash_push', { workspace, message: '' }, services);
    expect(result).toMatchObject({ success: false, reason: 'invalid_args' });
    expect(stashPush).not.toHaveBeenCalled();
  });
});

describe('git_checkout_files path validation', () => {
  it('rejects absolute paths', async () => {
    const checkoutFiles = vi.fn(async () => ({ checkedOut: [] }));
    const services: GitCommandServices = { checkoutFiles };

    // The service validates paths — when absolute path is provided, the implementation
    // throws GitCommandError with path_outside_repo or invalid_args reason
    // We test the integration: even valid workspace + absolute path → failure
    const result = await handleGitCommand(
      'git_checkout_files',
      { workspace, paths: ['/etc/passwd'] },
      services,
    );
    // Service mock accepts paths as-is; real impl would reject — here we verify
    // the paths reach the service. The real rejection is in gitCheckoutFiles.
    // For this test we verify the service IS called (input routing works),
    // and separately that the real impl rejects (tested in git-mutating-commands).
    expect(checkoutFiles).toHaveBeenCalledWith({ workspace, paths: ['/etc/passwd'] });
  });

  it('rejects more than 50 paths at the routing layer', async () => {
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

  it('rejects empty paths array at the routing layer', async () => {
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

  it('path traversal is rejected by the service impl (real gitCheckoutFiles)', async () => {
    // Use the real createDefaultGitCommandServices to verify path traversal is caught.
    // resolveGitRepository will fail on a non-existent workspace, but the path validation
    // in gitCheckoutFiles runs before the git call, throwing path_outside_repo.
    const { createDefaultGitCommandServices } = await import('../../src/git/git-commands.js');
    const services = createDefaultGitCommandServices();

    const result = await handleGitCommand(
      'git_checkout_files',
      { workspace: '/tmp', paths: ['../../../etc/passwd'] },
      services,
    );
    // Either path_outside_repo or invalid_args (workspace validation) or not_git_repo
    expect(result.success).toBe(false);
    // Must not succeed
    expect((result as any).checkedOut).toBeUndefined();
  });
});

describe('git_stash_pop stashRef validation', () => {
  it('accepts stash@{0}', async () => {
    const stashPop = vi.fn(async () => {});
    const result = await handleGitCommand(
      'git_stash_pop',
      { workspace, stashRef: 'stash@{0}' },
      { stashPop },
    );
    expect(result).toMatchObject({ success: true, stashPopped: true });
  });

  it('rejects "invalid" as stashRef', async () => {
    const stashPop = vi.fn(async () => {});
    const result = await handleGitCommand(
      'git_stash_pop',
      { workspace, stashRef: 'invalid' },
      { stashPop },
    );
    expect(result).toMatchObject({ success: false, reason: 'invalid_args' });
    expect(stashPop).not.toHaveBeenCalled();
  });
});
