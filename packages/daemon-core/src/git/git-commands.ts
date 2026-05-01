import * as path from 'node:path';

import { getGitDiffSummary, getGitFileDiff } from './git-diff.js';
import { GitCommandError, isPathInside, resolveGitRepository, runGit } from './git-executor.js';
import { createGitSnapshotStore } from './git-snapshot-store.js';
import { getGitRepoStatus } from './git-status.js';
import type {
  GitCommandName,
  GitDiffSummary,
  GitFailureReason,
  GitRepoIdentity,
  GitRepoStatus,
  GitSnapshot,
  GitSnapshotCompareSummary,
  GitSnapshotReason,
} from './git-types.js';

export interface GitFileDiff extends GitRepoIdentity {
  path: string;
  oldPath?: string;
  staged?: boolean;
  diff: string;
  binary?: boolean;
  truncated?: boolean;
  lastCheckedAt: number;
}

export interface GitLogEntry {
  commit: string;
  message: string;
  authorName?: string;
  authorEmail?: string;
  authoredAt?: number;
  committedAt?: number;
}

export interface GitLogResult extends GitRepoIdentity {
  entries: GitLogEntry[];
  limit: number;
  truncated: boolean;
  lastCheckedAt: number;
}

export interface GitCommandServices {
  getStatus?: (params: { workspace: string }) => Promise<GitRepoStatus> | GitRepoStatus;
  getDiffSummary?: (params: { workspace: string; staged?: boolean }) => Promise<GitDiffSummary> | GitDiffSummary;
  getDiffFile?: (params: { workspace: string; path: string; staged?: boolean }) => Promise<GitFileDiff> | GitFileDiff;
  createSnapshot?: (params: {
    workspace: string;
    reason: GitSnapshotReason;
    sessionId?: string;
    turnId?: string;
  }) => Promise<GitSnapshot> | GitSnapshot;
  compareSnapshots?: (params: {
    workspace: string;
    beforeSnapshotId: string;
    afterSnapshotId: string;
  }) => Promise<GitSnapshotCompareSummary> | GitSnapshotCompareSummary;
  getLog?: (params: {
    workspace: string;
    limit: number;
    path?: string;
    since?: string;
    until?: string;
  }) => Promise<GitLogResult> | GitLogResult;
}

type GitCommandFailure = {
  success: false;
  reason: GitFailureReason;
  error: string;
};

type GitCommandSuccess =
  | { success: true; status: GitRepoStatus }
  | { success: true; diffSummary: GitDiffSummary }
  | { success: true; diff: GitFileDiff }
  | { success: true; snapshot: GitSnapshot }
  | { success: true; compare: GitSnapshotCompareSummary }
  | { success: true; log: GitLogResult };

export type GitCommandResult = GitCommandSuccess | GitCommandFailure;

const GIT_COMMAND_NAMES = new Set<GitCommandName>([
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
]);

const MUTATING_COMMAND_NAMES = new Set<GitCommandName>([
  'git_checkpoint',
  'git_stash_push',
  'git_stash_pop',
  'git_checkout_files',
]);

const SNAPSHOT_REASONS = new Set<GitSnapshotReason>([
  'session_baseline',
  'before_user_input_dispatch',
  'before_agent_work',
  'after_agent_work',
  'manual',
]);

const FAILURE_REASONS = new Set<GitFailureReason>([
  'not_git_repo',
  'git_not_installed',
  'timeout',
  'path_outside_repo',
  'dirty_index_required',
  'conflict',
  'invalid_args',
  'git_command_failed',
]);

function failure(reason: GitFailureReason, error: string): GitCommandFailure {
  return { success: false, reason, error };
}

function serviceNotImplemented(command: string): GitCommandFailure {
  return failure('invalid_args', `${command} is not implemented: daemon-core Git service is not configured`);
}

const defaultSnapshotStore = createGitSnapshotStore({
  getStatus: (workspace) => getGitRepoStatus(workspace),
  getDiffSummary: (workspace) => getGitDiffSummary(workspace),
});

export function createDefaultGitCommandServices(): GitCommandServices {
  return {
    getStatus: ({ workspace }) => getGitRepoStatus(workspace),
    getDiffSummary: ({ workspace }) => getGitDiffSummary(workspace),
    getDiffFile: ({ workspace, path: filePath }) => getGitFileDiff(workspace, filePath),
    createSnapshot: ({ workspace, reason, sessionId, turnId }) => defaultSnapshotStore.create({
      workspace,
      reason,
      sessionId,
      turnId,
    }),
    compareSnapshots: ({ beforeSnapshotId, afterSnapshotId }) => defaultSnapshotStore.compare(beforeSnapshotId, afterSnapshotId),
    getLog: ({ workspace, limit, path: filePath, since, until }) => getGitLog(workspace, { limit, path: filePath, since, until }),
  };
}

const defaultGitCommandServices = createDefaultGitCommandServices();

function validateWorkspace(args: any): { workspace: string } | GitCommandFailure {
  if (typeof args?.workspace !== 'string') {
    return failure('invalid_args', 'workspace must be a non-empty absolute path');
  }

  const workspace = args.workspace.trim();
  if (!workspace || !path.isAbsolute(workspace)) {
    return failure('invalid_args', 'workspace must be a non-empty absolute path');
  }

  return { workspace };
}

function validateRepoPath(args: any): { path: string } | GitCommandFailure {
  if (typeof args?.path !== 'string' || !args.path.trim()) {
    return failure('invalid_args', 'path must be a non-empty repository-relative path');
  }
  return { path: args.path.trim() };
}

function validateSnapshotId(args: any, key: 'beforeSnapshotId' | 'afterSnapshotId'): string | GitCommandFailure {
  if (typeof args?.[key] !== 'string' || !args[key].trim()) {
    return failure('invalid_args', `${key} must be a non-empty string`);
  }
  return args[key].trim();
}

function parseSnapshotReason(args: any): GitSnapshotReason | GitCommandFailure {
  if (args?.reason === undefined || args?.reason === null || args?.reason === '') {
    return 'manual';
  }
  if (typeof args.reason !== 'string' || !SNAPSHOT_REASONS.has(args.reason as GitSnapshotReason)) {
    return failure('invalid_args', 'reason must be a valid GitSnapshotReason');
  }
  return args.reason as GitSnapshotReason;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function boundedLogLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') return 50;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 50;
  return Math.max(1, Math.min(200, Math.floor(numeric)));
}

function failureReasonFromError(error: any): GitFailureReason {
  return typeof error?.reason === 'string' && FAILURE_REASONS.has(error.reason)
    ? error.reason
    : 'git_command_failed';
}

async function runService<T>(fn: () => Promise<T> | T): Promise<T | GitCommandFailure> {
  try {
    return await fn();
  } catch (error: any) {
    return failure(failureReasonFromError(error), error?.message || 'Git command failed');
  }
}

export function isGitCommandName(command: string): command is GitCommandName {
  return GIT_COMMAND_NAMES.has(command as GitCommandName);
}

export async function handleGitCommand(
  command: GitCommandName,
  args: any,
  services?: GitCommandServices,
): Promise<GitCommandResult>;
export async function handleGitCommand(
  command: string,
  args: any,
  services?: GitCommandServices,
): Promise<GitCommandResult>;
export async function handleGitCommand(
  command: string,
  args: any,
  services: GitCommandServices = defaultGitCommandServices,
): Promise<GitCommandResult> {
  if (!isGitCommandName(command)) {
    return failure('invalid_args', `Unknown Git command: ${command}`);
  }

  if (MUTATING_COMMAND_NAMES.has(command)) {
    return failure('invalid_args', `${command} is not implemented in daemon-core read-only Git routing`);
  }

  const workspaceResult = validateWorkspace(args);
  if ('success' in workspaceResult) return workspaceResult;
  const { workspace } = workspaceResult;

  switch (command) {
    case 'git_status': {
      if (!services.getStatus) return serviceNotImplemented(command);
      const status = await runService(() => services.getStatus!({ workspace }));
      return 'success' in status ? status : { success: true, status };
    }

    case 'git_diff_summary': {
      if (!services.getDiffSummary) return serviceNotImplemented(command);
      const diffSummary = await runService(() => services.getDiffSummary!({ workspace, staged: optionalBoolean(args?.staged) }));
      return 'success' in diffSummary ? diffSummary : { success: true, diffSummary };
    }

    case 'git_diff_file': {
      if (!services.getDiffFile) return serviceNotImplemented(command);
      const pathResult = validateRepoPath(args);
      if (typeof pathResult !== 'object' || 'success' in pathResult) return pathResult;
      const diff = await runService(() => services.getDiffFile!({
        workspace,
        path: pathResult.path,
        staged: optionalBoolean(args?.staged),
      }));
      return 'success' in diff ? diff : { success: true, diff };
    }

    case 'git_snapshot_create': {
      if (!services.createSnapshot) return serviceNotImplemented(command);
      const reason = parseSnapshotReason(args);
      if (typeof reason !== 'string') return reason;
      const snapshot = await runService(() => services.createSnapshot!({
        workspace,
        reason,
        sessionId: optionalString(args?.sessionId),
        turnId: optionalString(args?.turnId),
      }));
      return 'success' in snapshot ? snapshot : { success: true, snapshot };
    }

    case 'git_snapshot_compare': {
      if (!services.compareSnapshots) return serviceNotImplemented(command);
      const beforeSnapshotId = validateSnapshotId(args, 'beforeSnapshotId');
      if (typeof beforeSnapshotId !== 'string') return beforeSnapshotId;
      const afterSnapshotId = validateSnapshotId(args, 'afterSnapshotId');
      if (typeof afterSnapshotId !== 'string') return afterSnapshotId;
      const compare = await runService(() => services.compareSnapshots!({ workspace, beforeSnapshotId, afterSnapshotId }));
      return 'success' in compare ? compare : { success: true, compare };
    }

    case 'git_log': {
      if (!services.getLog) {
        return failure('invalid_args', 'git_log is not implemented: bounded daemon-core Git log service is not configured');
      }
      const log = await runService(() => services.getLog!({
        workspace,
        limit: boundedLogLimit(args?.limit),
        path: optionalString(args?.path),
        since: optionalString(args?.since),
        until: optionalString(args?.until),
      }));
      return 'success' in log ? log : { success: true, log };
    }

    default:
      return failure('invalid_args', `Unknown Git command: ${command}`);
  }
}

function formatOptionalGitLogRangeArg(flag: '--since' | '--until', value: string | undefined): string[] {
  return value ? [`${flag}=${value}`] : [];
}

async function getGitLog(
  workspace: string,
  options: { limit: number; path?: string; since?: string; until?: string },
): Promise<GitLogResult> {
  const lastCheckedAt = Date.now();
  const repo = await resolveGitRepository(workspace);
  const repoRoot = repo.repoRoot!;
  const boundedLimit = Math.max(1, Math.min(200, Math.floor(options.limit || 50)));
  const selectedPath = options.path ? validateGitLogPath(repoRoot, options.path) : undefined;
  const result = await runGit(
    repo,
    [
      'log',
      `--max-count=${boundedLimit}`,
      '--format=%H%x00%an%x00%ae%x00%at%x00%ct%x00%s',
      ...formatOptionalGitLogRangeArg('--since', options.since),
      ...formatOptionalGitLogRangeArg('--until', options.until),
      '--',
      ...(selectedPath ? [selectedPath] : []),
    ],
    { cwd: repoRoot },
  );

  const entries = result.stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line): GitLogEntry => {
      const [commit = '', authorName, authorEmail, authoredAt, committedAt, ...messageParts] = line.split('\0');
      return {
        commit,
        message: messageParts.join('\0'),
        authorName: authorName || undefined,
        authorEmail: authorEmail || undefined,
        authoredAt: authoredAt ? Number.parseInt(authoredAt, 10) * 1000 : undefined,
        committedAt: committedAt ? Number.parseInt(committedAt, 10) * 1000 : undefined,
      };
    })
    .filter((entry) => entry.commit.length > 0);

  return {
    workspace: repo.workspace,
    repoRoot,
    isGitRepo: true,
    entries,
    limit: boundedLimit,
    truncated: entries.length >= boundedLimit,
    lastCheckedAt,
  };
}

function validateGitLogPath(repoRoot: string, filePath: string): string {
  if (!filePath.trim() || filePath.includes('\0')) {
    throw new GitCommandError('invalid_args', 'path must be a non-empty repository-relative path');
  }
  if (path.isAbsolute(filePath)) {
    throw new GitCommandError('invalid_args', 'path must be repository-relative');
  }
  const normalized = path.normalize(filePath).split(path.sep).join('/');
  const absolutePath = path.resolve(repoRoot, normalized);
  if (!isPathInside(repoRoot, absolutePath) || normalized.startsWith('../') || normalized === '..') {
    throw new GitCommandError('path_outside_repo', 'Git log path is outside the repository root');
  }
  return normalized;
}
