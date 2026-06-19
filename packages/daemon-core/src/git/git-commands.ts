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

export interface GitCheckpointResult extends GitRepoIdentity {
  commit?: string;
  message: string;
  status?: 'created' | 'skipped';
  skipped?: boolean;
  noop?: boolean;
  reason?: 'nothing_to_commit';
  lastCheckedAt: number;
}

export interface GitStashPushResult extends GitRepoIdentity {
  stashRef: string;
  message: string;
  lastCheckedAt: number;
}

export interface GitPushResult extends GitRepoIdentity {
  remote: string;
  branch: string;
  output: string;
  newBranch: boolean;
  lastCheckedAt: number;
}

export interface GitCommandServices {
  getStatus?: (params: { workspace: string; refreshUpstream?: boolean; includeSubmodules?: boolean; submoduleIgnorePaths?: string[] }) => Promise<GitRepoStatus> | GitRepoStatus;
  getDiffSummary?: (params: { workspace: string; staged?: boolean; base?: string }) => Promise<GitDiffSummary> | GitDiffSummary;
  getDiffFile?: (params: { workspace: string; path: string; staged?: boolean; base?: string }) => Promise<GitFileDiff> | GitFileDiff;
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
  checkpoint?: (params: {
    workspace: string;
    message: string;
    includeUntracked?: boolean;
  }) => Promise<GitCheckpointResult> | GitCheckpointResult;
  stashPush?: (params: {
    workspace: string;
    message: string;
    includeUntracked?: boolean;
  }) => Promise<GitStashPushResult> | GitStashPushResult;
  stashPop?: (params: { workspace: string; stashRef?: string }) => Promise<void>;
  checkoutFiles?: (params: { workspace: string; paths: string[] }) => Promise<{ checkedOut: string[] }>;
  getRemoteUrl?: (params: { workspace: string; remote?: string }) => Promise<{ remoteUrl: string; remote: string }>;
  push?: (params: { workspace: string; remote?: string; branch?: string; setUpstream?: boolean }) => Promise<GitPushResult>;
}

type GitCommandFailure = {
  success: false;
  reason: GitFailureReason;
  error: string;
};

type GitCommandSuccess =
  // reporterPlatform/reporterArch carry the responding daemon's process.platform/
  // process.arch so a mesh coordinator probing this node over P2P can self-heal the
  // node's userOverrides.platform/arch (the fields capability-tag routing reads).
  | { success: true; status: GitRepoStatus; reporterPlatform?: string; reporterArch?: string }
  | { success: true; diffSummary: GitDiffSummary }
  | { success: true; diff: GitFileDiff }
  | { success: true; snapshot: GitSnapshot }
  | { success: true; compare: GitSnapshotCompareSummary }
  | { success: true; log: GitLogResult }
  | { success: true; checkpoint: GitCheckpointResult }
  | { success: true; stash: GitStashPushResult }
  | { success: true; stashPopped: true }
  | { success: true; checkedOut: string[] }
  | { success: true; remoteUrl: string; remote: string }
  | { success: true; push: GitPushResult };

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
  'git_remote_url',
  'git_push',
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
  'nothing_to_commit',
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
    getStatus: ({ workspace, refreshUpstream }) => getGitRepoStatus(workspace, { refreshUpstream }),
    getDiffSummary: ({ workspace, base }) => getGitDiffSummary(workspace, base ? { baseRef: base } : {}),
    getDiffFile: ({ workspace, path: filePath, base }) => getGitFileDiff(workspace, filePath, base ? { baseRef: base } : {}),
    createSnapshot: ({ workspace, reason, sessionId, turnId }) => defaultSnapshotStore.create({
      workspace,
      reason,
      sessionId,
      turnId,
    }),
    compareSnapshots: ({ beforeSnapshotId, afterSnapshotId }) => defaultSnapshotStore.compare(beforeSnapshotId, afterSnapshotId),
    getLog: ({ workspace, limit, path: filePath, since, until }) => getGitLog(workspace, { limit, path: filePath, since, until }),
    checkpoint: async ({ workspace, message, includeUntracked = false }) => gitCheckpoint(workspace, message, includeUntracked),
    stashPush: async ({ workspace, message, includeUntracked = false }) => gitStashPush(workspace, message, includeUntracked),
    stashPop: async ({ workspace, stashRef }) => gitStashPop(workspace, stashRef),
    checkoutFiles: async ({ workspace, paths }) => gitCheckoutFiles(workspace, paths),
    getRemoteUrl: async ({ workspace, remote = 'origin' }) => gitGetRemoteUrl(workspace, remote),
    push: async ({ workspace, remote = 'origin', branch, setUpstream = false }) =>
      gitPush(workspace, remote, branch, setUpstream),
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

  const workspaceResult = validateWorkspace(args);
  if ('success' in workspaceResult) return workspaceResult;
  const { workspace } = workspaceResult;

  switch (command) {
    case 'git_status': {
      if (!services.getStatus) return serviceNotImplemented(command);
      const submoduleIgnorePaths = Array.isArray(args?.submoduleIgnorePaths)
        ? args.submoduleIgnorePaths.filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
        : undefined;
      const statusParams: { workspace: string; refreshUpstream?: boolean; includeSubmodules?: boolean; submoduleIgnorePaths?: string[] } = { workspace };
      const refreshUpstream = optionalBoolean(args?.refreshUpstream);
      const includeSubmodules = optionalBoolean(args?.includeSubmodules);
      if (refreshUpstream !== undefined) statusParams.refreshUpstream = refreshUpstream;
      if (includeSubmodules !== undefined) statusParams.includeSubmodules = includeSubmodules;
      if (submoduleIgnorePaths && submoduleIgnorePaths.length > 0) statusParams.submoduleIgnorePaths = submoduleIgnorePaths;
      const status = await runService(() => services.getStatus!(statusParams));
      if ('success' in status) return status;
      // Carry the responding daemon's real platform/arch alongside the git
      // status. A mesh coordinator dispatches `git_status` to each member over
      // P2P on every explicit graph refresh, so this is the recurring live
      // channel that lets a member self-report its OS to the coordinator — which
      // stamps it onto the node's userOverrides.platform/arch (the fields
      // buildMeshNodeCapabilityTags reads). These are siblings of `status`, not
      // part of GitRepoStatus, so the git payload shape is untouched.
      return { success: true, status, reporterPlatform: process.platform, reporterArch: process.arch };
    }

    case 'git_diff_summary': {
      if (!services.getDiffSummary) return serviceNotImplemented(command);
      const diffSummary = await runService(() => services.getDiffSummary!({ workspace, staged: optionalBoolean(args?.staged), base: optionalString(args?.base) }));
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

    case 'git_checkpoint': {
      if (!services.checkpoint) return serviceNotImplemented(command);
      const msg = validateMutatingMessage(args?.message);
      if (typeof msg !== 'string') return msg;
      const includeUntracked = Boolean(args?.includeUntracked);
      const checkpoint = await runService(() => services.checkpoint!({ workspace, message: msg, includeUntracked }));
      return 'success' in checkpoint ? checkpoint : { success: true, checkpoint };
    }

    case 'git_stash_push': {
      if (!services.stashPush) return serviceNotImplemented(command);
      const msg = validateMutatingMessage(args?.message);
      if (typeof msg !== 'string') return msg;
      const includeUntracked = Boolean(args?.includeUntracked);
      const stash = await runService(() => services.stashPush!({ workspace, message: msg, includeUntracked }));
      return 'success' in stash ? stash : { success: true, stash };
    }

    case 'git_stash_pop': {
      if (!services.stashPop) return serviceNotImplemented(command);
      const stashRef = optionalString(args?.stashRef);
      if (stashRef !== undefined && !/^stash@\{\d+\}$/.test(stashRef)) {
        return failure('invalid_args', 'stashRef must match stash@{N} format');
      }
      const popResult = await runService(() => services.stashPop!({ workspace, stashRef }));
      if (popResult !== undefined && 'success' in (popResult as object)) return popResult as GitCommandFailure;
      return { success: true, stashPopped: true };
    }

    case 'git_checkout_files': {
      if (!services.checkoutFiles) return serviceNotImplemented(command);
      const paths = args?.paths;
      if (!Array.isArray(paths) || paths.length === 0) {
        return failure('invalid_args', 'paths must be a non-empty array');
      }
      if (paths.length > 50) {
        return failure('invalid_args', 'paths array exceeds maximum of 50 entries');
      }
      const checkoutResult = await runService(() => services.checkoutFiles!({ workspace, paths }));
      return 'success' in checkoutResult ? checkoutResult : { success: true, checkedOut: (checkoutResult as { checkedOut: string[] }).checkedOut };
    }

    case 'git_remote_url': {
      if (!services.getRemoteUrl) return serviceNotImplemented(command);
      const remote = typeof args?.remote === 'string' && args.remote.trim() ? args.remote.trim() : 'origin';
      const remoteResult = await runService(() => services.getRemoteUrl!({ workspace, remote }));
      if ('success' in remoteResult) return remoteResult;
      return { success: true, remoteUrl: remoteResult.remoteUrl, remote: remoteResult.remote };
    }

    case 'git_push': {
      if (!services.push) return serviceNotImplemented(command);
      const remote = typeof args?.remote === 'string' && args.remote.trim() ? args.remote.trim() : 'origin';
      const branch = typeof args?.branch === 'string' && args.branch.trim() ? args.branch.trim() : undefined;
      const setUpstream = Boolean(args?.setUpstream);
      if (!/^[a-zA-Z0-9_.\-]+$/.test(remote)) {
        return failure('invalid_args', 'remote must contain only alphanumeric characters, dots, hyphens, and underscores');
      }
      if (branch !== undefined && !/^[a-zA-Z0-9/_.\-]+$/.test(branch)) {
        return failure('invalid_args', 'branch must contain only alphanumeric characters, slashes, dots, hyphens, and underscores');
      }
      const pushResult = await runService(() => services.push!({ workspace, remote, branch, setUpstream }));
      return 'success' in pushResult ? pushResult : { success: true, push: pushResult };
    }

    default:
      return failure('invalid_args', `Unknown Git command: ${command}`);
  }
}

function validateMutatingMessage(value: unknown): string | GitCommandFailure {
  if (typeof value !== 'string' || !value.trim()) {
    return failure('invalid_args', 'message must be a non-empty string');
  }
  const msg = value.trim();
  if (msg.length > 200) {
    return failure('invalid_args', 'message must be 200 characters or fewer');
  }
  return msg;
}

async function gitCheckpoint(
  workspace: string,
  message: string,
  includeUntracked: boolean,
): Promise<GitCheckpointResult> {
  const repo = await resolveGitRepository(workspace);
  const repoRoot = repo.repoRoot!;

  const statusResult = await getGitRepoStatus(workspace);
  if (statusResult.hasConflicts) {
    throw new GitCommandError('conflict', 'Repository has conflicts — resolve before checkpointing');
  }
  const dirtySubmodules = (statusResult.submodules || []).filter(submodule => submodule.dirty);
  if (dirtySubmodules.length > 0) {
    const paths = dirtySubmodules.map(submodule => submodule.path).join(', ');
    throw new GitCommandError(
      'dirty_index_required',
      `Repository has dirty submodules that must be checkpointed first: ${paths}. ` +
      'Checkpoint or commit each dirty submodule, then checkpoint this repository to record gitlink changes.',
    );
  }

  const addArgs = includeUntracked ? ['-A'] : ['-u'];
  await runGit(repo, ['add', ...addArgs], { cwd: repoRoot });

  const fullMsg = `adhdev: checkpoint ${message}`;
  let commitSha: string;
  try {
    await runGit(repo, ['commit', '-m', fullMsg], { cwd: repoRoot });
    const revResult = await runGit(repo, ['rev-parse', 'HEAD'], { cwd: repoRoot });
    commitSha = revResult.stdout.trim();
  } catch (err: any) {
    const output = (err?.stdout || '') + (err?.stderr || '');
    if (/nothing to commit/i.test(output)) {
      return {
        workspace: repo.workspace,
        repoRoot,
        isGitRepo: true,
        message: fullMsg,
        status: 'skipped',
        skipped: true,
        noop: true,
        reason: 'nothing_to_commit',
        lastCheckedAt: Date.now(),
      };
    }
    throw err;
  }

  return {
    workspace: repo.workspace,
    repoRoot,
    isGitRepo: true,
    commit: commitSha,
    message: fullMsg,
    status: 'created',
    lastCheckedAt: Date.now(),
  };
}

async function gitStashPush(
  workspace: string,
  message: string,
  includeUntracked: boolean,
): Promise<GitStashPushResult> {
  const repo = await resolveGitRepository(workspace);
  const repoRoot = repo.repoRoot!;

  const stashArgs = ['stash', 'push', '-m', message];
  if (includeUntracked) stashArgs.push('--include-untracked');

  const result = await runGit(repo, stashArgs, { cwd: repoRoot });
  if (/No local changes to save/i.test(result.stdout + result.stderr)) {
    throw new GitCommandError('git_command_failed', 'Nothing to stash');
  }

  return {
    workspace: repo.workspace,
    repoRoot,
    isGitRepo: true,
    stashRef: 'stash@{0}',
    message,
    lastCheckedAt: Date.now(),
  };
}

async function gitStashPop(workspace: string, stashRef?: string): Promise<void> {
  const repo = await resolveGitRepository(workspace);
  const repoRoot = repo.repoRoot!;

  const popArgs = stashRef ? ['stash', 'pop', stashRef] : ['stash', 'pop'];
  await runGit(repo, popArgs, { cwd: repoRoot });
}

async function gitCheckoutFiles(workspace: string, paths: string[]): Promise<{ checkedOut: string[] }> {
  const repo = await resolveGitRepository(workspace);
  const repoRoot = repo.repoRoot!;

  const normalizedPaths: string[] = [];
  for (const p of paths) {
    if (typeof p !== 'string' || !p.trim() || p.includes('\0')) {
      throw new GitCommandError('invalid_args', `Invalid path: ${String(p)}`);
    }
    if (path.isAbsolute(p)) {
      throw new GitCommandError('invalid_args', `Path must be repository-relative, not absolute: ${p}`);
    }
    const normalized = path.normalize(p.trim()).split(path.sep).join('/');
    if (normalized.startsWith('../') || normalized === '..') {
      throw new GitCommandError('path_outside_repo', `Path is outside repository root: ${p}`);
    }
    const absolutePath = path.resolve(repoRoot, normalized);
    if (!isPathInside(repoRoot, absolutePath)) {
      throw new GitCommandError('path_outside_repo', `Path is outside repository root: ${p}`);
    }
    normalizedPaths.push(normalized);
  }

  await runGit(repo, ['checkout', '--', ...normalizedPaths], { cwd: repoRoot });
  return { checkedOut: normalizedPaths };
}

async function gitGetRemoteUrl(workspace: string, remote: string): Promise<{ remoteUrl: string; remote: string }> {
  const repo = await resolveGitRepository(workspace);
  const result = await runGit(repo, ['remote', 'get-url', remote], { cwd: repo.repoRoot! });
  const remoteUrl = result.stdout.trim();
  if (!remoteUrl) {
    throw new GitCommandError('git_command_failed', `Remote '${remote}' has no URL`);
  }
  return { remoteUrl, remote };
}

async function gitPush(
  workspace: string,
  remote: string,
  branch: string | undefined,
  setUpstream: boolean,
): Promise<GitPushResult> {
  const lastCheckedAt = Date.now();
  const repo = await resolveGitRepository(workspace);
  const repoRoot = repo.repoRoot!;

  // Resolve branch name if not provided
  let resolvedBranch = branch;
  if (!resolvedBranch) {
    const branchResult = await runGit(repo, ['symbolic-ref', '--short', 'HEAD'], { cwd: repoRoot });
    resolvedBranch = branchResult.stdout.trim();
    if (!resolvedBranch) {
      throw new GitCommandError('git_command_failed', 'Cannot push: not on a branch (detached HEAD)');
    }
  }

  const pushArgs = ['push'];
  if (setUpstream) pushArgs.push('--set-upstream');
  pushArgs.push(remote, resolvedBranch);

  let output = '';
  let newBranch = false;
  try {
    const result = await runGit(repo, pushArgs, { cwd: repoRoot });
    output = (result.stdout + result.stderr).trim();
    newBranch = /\[new branch\]/i.test(output);
  } catch (err: any) {
    const errOutput = (err?.stdout ?? '') + (err?.stderr ?? '');
    // --set-upstream hint: retry with --set-upstream automatically
    if (!setUpstream && /no upstream branch|set-upstream/i.test(errOutput)) {
      const retryArgs = ['push', '--set-upstream', remote, resolvedBranch];
      const retryResult = await runGit(repo, retryArgs, { cwd: repoRoot });
      output = (retryResult.stdout + retryResult.stderr).trim();
      newBranch = /\[new branch\]/i.test(output);
    } else {
      throw new GitCommandError('git_command_failed', errOutput || err?.message || 'git push failed');
    }
  }

  return {
    workspace: repo.workspace,
    repoRoot,
    isGitRepo: true,
    remote,
    branch: resolvedBranch,
    output,
    newBranch,
    lastCheckedAt,
  };
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
