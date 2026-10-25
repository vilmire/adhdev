import { useSyntheticPublicPushPatterns, bindPushDestination } from '../helpers/public-push-patterns'
import { describe, expect, it, vi } from 'vitest';
import { DaemonCommandHandler } from '../../src/commands/handler.js';
import {
  handleGitCommand,
  type GitCommandServices,
} from '../../src/git/git-commands.js';
import type {
  GitDiffSummary,
  GitRepoStatus,
  GitSnapshot,
  GitSnapshotCompareSummary,
} from '../../src/git/git-types.js';

const workspace = '/tmp/repo';

function status(overrides: Partial<GitRepoStatus> = {}): GitRepoStatus {
  return {
    workspace,
    repoRoot: workspace,
    isGitRepo: true,
    branch: 'main',
    headCommit: 'abc123',
    headMessage: 'initial',
    upstream: 'origin/main',
    ahead: 1,
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
    ...overrides,
  };
}

function diffSummary(overrides: Partial<GitDiffSummary> = {}): GitDiffSummary {
  return {
    workspace,
    repoRoot: workspace,
    isGitRepo: true,
    files: [
      {
        path: 'src/index.ts',
        status: 'modified',
        staged: false,
        insertions: 2,
        deletions: 1,
      },
    ],
    totalInsertions: 2,
    totalDeletions: 1,
    truncated: false,
    lastCheckedAt: 1,
    ...overrides,
  };
}

function snapshot(overrides: Partial<GitSnapshot> = {}): GitSnapshot {
  return {
    id: 'snap-1',
    workspace,
    repoRoot: workspace,
    reason: 'manual',
    status: status(),
    diffSummary: diffSummary(),
    createdAt: 1,
    ...overrides,
  };
}

function compare(overrides: Partial<GitSnapshotCompareSummary> = {}): GitSnapshotCompareSummary {
  return {
    beforeSnapshotId: 'before',
    afterSnapshotId: 'after',
    workspace,
    repoRoot: workspace,
    changedFiles: 1,
    addedFiles: [],
    modifiedFiles: ['src/index.ts'],
    deletedFiles: [],
    renamedFiles: [],
    untrackedFiles: [],
    conflictFiles: [],
    totalInsertions: 2,
    totalDeletions: 1,
    hasConflicts: false,
    currentStatus: status(),
    summaryText: '1 file changed',
    ...overrides,
  };
}

describe('git command skeleton', () => {
  it('rejects missing, empty, or non-absolute workspace args before calling services', async () => {
    const getStatus = vi.fn(async () => status());
    const services: GitCommandServices = { getStatus };

    for (const badWorkspace of [undefined, '', 'relative/repo']) {
      const result = await handleGitCommand('git_status', { workspace: badWorkspace }, services);
      expect(result).toMatchObject({ success: false, reason: 'invalid_args' });
    }
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('routes read-only commands to injected services and returns Batch 0 result shapes', async () => {
    const services: GitCommandServices = {
      getStatus: vi.fn(async () => status()),
      getDiffSummary: vi.fn(async () => diffSummary()),
      getDiffFile: vi.fn(async () => ({
        workspace,
        repoRoot: workspace,
        isGitRepo: true,
        path: 'src/index.ts',
        staged: false,
        diff: '@@ -1 +1 @@',
        truncated: false,
        binary: false,
        lastCheckedAt: 1,
      })),
      createSnapshot: vi.fn(async () => snapshot()),
      compareSnapshots: vi.fn(async () => compare()),
      getLog: vi.fn(async () => ({
        workspace,
        repoRoot: workspace,
        isGitRepo: true,
        entries: [
          {
            commit: 'abc123',
            message: 'initial',
            authorName: 'Ada',
            authorEmail: 'ada@example.test',
            authoredAt: 1,
          },
        ],
        limit: 50,
        truncated: false,
        lastCheckedAt: 1,
      })),
    };

    await expect(handleGitCommand('git_status', { workspace }, services)).resolves.toMatchObject({ success: true, status: status() });
    await expect(handleGitCommand('git_diff_summary', { workspace }, services)).resolves.toMatchObject({ success: true, diffSummary: diffSummary() });
    await expect(handleGitCommand('git_diff_file', { workspace, path: 'src/index.ts' }, services)).resolves.toMatchObject({ success: true, diff: { path: 'src/index.ts' } });
    await expect(handleGitCommand('git_snapshot_create', { workspace, reason: 'manual' }, services)).resolves.toMatchObject({ success: true, snapshot: snapshot() });
    await expect(handleGitCommand('git_snapshot_compare', { workspace, beforeSnapshotId: 'before', afterSnapshotId: 'after' }, services)).resolves.toMatchObject({ success: true, compare: compare() });
    await expect(handleGitCommand('git_log', { workspace }, services)).resolves.toMatchObject({ success: true, log: { entries: [{ commit: 'abc123' }], limit: 50 } });

    expect(services.getStatus).toHaveBeenCalledWith({ workspace });
    expect(services.getDiffSummary).toHaveBeenCalledWith({ workspace, staged: undefined });
    expect(services.getDiffFile).toHaveBeenCalledWith({ workspace, path: 'src/index.ts', staged: undefined });
    expect(services.createSnapshot).toHaveBeenCalledWith({ workspace, reason: 'manual', sessionId: undefined, turnId: undefined });
    expect(services.compareSnapshots).toHaveBeenCalledWith({ workspace, beforeSnapshotId: 'before', afterSnapshotId: 'after' });
    expect(services.getLog).toHaveBeenCalledWith({ workspace, limit: 50, path: undefined, since: undefined, until: undefined });
  });

  it('git_status carries the responding daemon platform/arch so a mesh coordinator can stamp it', async () => {
    const services: GitCommandServices = { getStatus: vi.fn(async () => status()) };
    const result = await handleGitCommand('git_status', { workspace }, services) as Record<string, unknown>;
    // These are siblings of `status`, computed on the daemon that ran the command
    // (process.platform/process.arch), and become the live channel a coordinator
    // reads to self-heal node.userOverrides.platform/arch.
    expect(result.success).toBe(true);
    expect(result.reporterPlatform).toBe(process.platform);
    expect(result.reporterArch).toBe(process.arch);
    // The git status payload itself is untouched (no platform leaking into it).
    expect(result.status).toMatchObject(status());
    expect((result.status as Record<string, unknown>).reporterPlatform).toBeUndefined();
  });

  it('bounds git_log and does not pass arbitrary raw args to the service', async () => {
    const getLog = vi.fn(async () => ({
      workspace,
      repoRoot: workspace,
      isGitRepo: true,
      entries: [],
      limit: 200,
      truncated: false,
      lastCheckedAt: 1,
    }));

    await handleGitCommand('git_log', { workspace, limit: 9999, args: ['--exec=bad'], command: 'git log --raw' }, { getLog });

    expect(getLog).toHaveBeenCalledWith({ workspace, limit: 200, path: undefined, since: undefined, until: undefined });
  });

  it('returns explicit unsupported failures for git_log without a bounded service and mutating commands', async () => {
    await expect(handleGitCommand('git_log', { workspace }, {})).resolves.toMatchObject({
      success: false,
      reason: 'invalid_args',
      error: expect.stringContaining('not implemented'),
    });

    for (const cmd of ['git_checkpoint', 'git_stash_push', 'git_stash_pop', 'git_checkout_files'] as const) {
      await expect(handleGitCommand(cmd, { workspace }, {})).resolves.toMatchObject({
        success: false,
        reason: 'invalid_args',
        error: expect.stringContaining('not implemented'),
      });
    }
  });

  it('handler routes git commands without ideType, targetSessionId, or CDP manager', async () => {
    const getStatus = vi.fn(async () => status());
    const handler = new DaemonCommandHandler({
      cdpManagers: new Map(),
      ideType: '',
      adapters: new Map(),
      gitCommandServices: { getStatus },
    } as any);

    await expect(handler.handle('git_status', { workspace })).resolves.toMatchObject({ success: true, status: status() });
    expect(getStatus).toHaveBeenCalledWith({ workspace });
  });
});

it.each(['foreign', 'valid'])('round4 P1-C: git_push refuses without approval and scans approved %s history in-process', async (identity) => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createDefaultGitCommandServices } = await import('../../src/git/git-commands.js');
  const root = mkdtempSync(join(tmpdir(), 'git-push-public-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-q', '-b', 'main');
    git('init', '-q', '--bare', '-b', 'main', join(root, 'origin.git'));
    git('--git-dir=' + join(root, 'origin.git'), 'config', 'remote.origin.url', 'https://github.com/vilmire/adhdev-cloud.git');
    git('remote', 'add', 'mirror', join(root, 'origin.git'));
    bindPushDestination(root, join(root, 'origin.git'), 'oss', 'mirror');
    git('config', 'user.name', identity === 'valid' ? 'vilmire' : 'Other'); git('config', 'user.email', identity === 'valid' ? 'vilmire@users.noreply.github.com' : 'other@example.com');
    mkdirSync(join(root, '.adhdev'));
    writeFileSync(join(root, '.adhdev/public-push-patterns.json'), JSON.stringify({ ownerNames: ['fixture-owner'], knownHosts: ['FixtureHostZ'] }));
    writeFileSync(join(root, 'file.txt'), 'clean\n');
    git('add', 'file.txt');
    // Intentional foreign-identity control must override inherited positive-fixture identity.
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root, env: {
      ...process.env,
      GIT_AUTHOR_NAME: identity === 'valid' ? 'vilmire' : 'Other',
      GIT_COMMITTER_NAME: identity === 'valid' ? 'vilmire' : 'Other',
      GIT_AUTHOR_EMAIL: identity === 'valid' ? 'vilmire@users.noreply.github.com' : 'other@example.com',
      GIT_COMMITTER_EMAIL: identity === 'valid' ? 'vilmire@users.noreply.github.com' : 'other@example.com',
    } });
    const sha = git('rev-parse', 'HEAD');
    const services = createDefaultGitCommandServices();
    const denied: any = await handleGitCommand('git_push', { workspace: root, remote: 'mirror' }, services);
    expect(denied.success).toBe(false);
    expect(denied.error).toContain('publish_approval_required');
    const extra: any = await handleGitCommand('git_push', { workspace: root, remote: 'mirror', approvedPublishShas: [sha, 'abcdef0'] }, services);
    expect(extra.success).toBe(false);
    expect(extra.error).toContain('publish_approval_required');
    const scanned: any = await handleGitCommand('git_push', { workspace: root, remote: 'mirror', approvedPublishShas: { oss: [sha] }, setUpstream: true }, services);
    if (identity === 'foreign') {
      expect(scanned.success).toBe(false);
      expect(scanned.error).toContain('publish_approval_required');
      await expect(services.push!({ workspace: root, remote: 'mirror', approvedPublishShas: { oss: [sha] } }))
        .rejects.toMatchObject({ approval: { commits: [{ sha, approved: true, guardScan: 'blocked',
          guardDetails: expect.arrayContaining([expect.stringContaining('identity: author'), expect.stringContaining('identity: committer')]) }] } });
      expect(() => git('--git-dir=' + join(root, 'origin.git'), 'rev-parse', '--verify', 'main')).toThrow();
    } else {
      expect(scanned.success, scanned.error).toBe(true);
      expect(git('--git-dir=' + join(root, 'origin.git'), 'rev-parse', '--verify', 'main')).toBe(sha);
      expect(git('config', 'branch.main.remote')).toBe('mirror');
      expect(git('config', 'branch.main.merge')).toBe('refs/heads/main');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

useSyntheticPublicPushPatterns()
