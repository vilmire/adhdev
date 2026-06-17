import { execFile, type ExecFileException } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { GitFailureReason, GitRepoIdentity } from './git-types.js';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

/**
 * Timeout for status-collection git commands (status/log/submodule/stash/fetch).
 * The default 5s is fine for porcelain status, but on Windows the `git` subprocess
 * spawn itself is pathologically slow (measured: `submodule status` ~3.5s, cold
 * `log -1` ~4.2s) and overlaps with refreshUpstream fetches — a single command
 * routinely exceeds 5s, which previously collapsed the whole status to all-null and
 * dropped the node from the mesh graph. Give the collection path a much larger
 * budget so a slow-but-healthy repo never reads as "not a git repo". Windows gets a
 * larger budget than POSIX because the spawn cost is OS-specific, not repo-specific.
 */
export const GIT_STATUS_TIMEOUT_MS = process.platform === 'win32' ? 30_000 : 20_000;

export interface GitExecutorOptions {
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface RunGitOptions extends GitExecutorOptions {
  cwd?: string;
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export class GitCommandError extends Error {
  readonly reason: GitFailureReason;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number | string;
  readonly signal?: NodeJS.Signals | string;
  readonly argv?: string[];
  readonly cwd?: string;

  constructor(
    reason: GitFailureReason,
    message: string,
    details: {
      stdout?: unknown;
      stderr?: unknown;
      exitCode?: number | string;
      signal?: NodeJS.Signals | string;
      argv?: readonly string[];
      cwd?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    if (details.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = details.cause;
    }
    this.name = 'GitCommandError';
    this.reason = reason;
    this.stdout = normalizeGitOutput(details.stdout);
    this.stderr = normalizeGitOutput(details.stderr);
    this.exitCode = details.exitCode;
    this.signal = details.signal;
    this.argv = details.argv ? [...details.argv] : undefined;
    this.cwd = details.cwd;
  }
}

export async function resolveGitRepository(
  workspace: string,
  options: GitExecutorOptions = {},
): Promise<GitRepoIdentity> {
  const normalizedWorkspace = await validateWorkspace(workspace);
  const result = await execGitRaw(normalizedWorkspace, ['rev-parse', '--show-toplevel'], options, {
    mapNotGitRepo: true,
  });
  const repoRoot = path.resolve(result.stdout.trim());

  if (!repoRoot) {
    throw new GitCommandError('not_git_repo', 'Git did not return a repository root', {
      stdout: result.stdout,
      stderr: result.stderr,
      argv: ['rev-parse', '--show-toplevel'],
      cwd: normalizedWorkspace,
    });
  }

  return {
    workspace: normalizedWorkspace,
    repoRoot,
    isGitRepo: true,
  };
}

export async function runGit(
  repoOrWorkspace: GitRepoIdentity | string,
  argv: readonly string[],
  options: RunGitOptions = {},
): Promise<GitCommandResult> {
  validateGitArgv(argv);

  const repo = typeof repoOrWorkspace === 'string'
    ? await resolveGitRepository(repoOrWorkspace, options)
    : repoOrWorkspace;

  if (!repo.repoRoot || !repo.isGitRepo) {
    throw new GitCommandError('not_git_repo', 'Workspace is not a Git repository', {
      argv,
      cwd: repo.workspace,
    });
  }

  const cwd = options.cwd ? await validateWorkspace(options.cwd) : await validateWorkspace(repo.workspace);
  const canonicalRepoRoot = await realpath(repo.repoRoot);
  const canonicalCwd = await realpath(cwd);
  if (!isPathInside(canonicalRepoRoot, canonicalCwd)) {
    throw new GitCommandError('path_outside_repo', 'Git cwd is outside the repository root', {
      argv,
      cwd,
    });
  }

  return execGitRaw(cwd, argv, options);
}

export function normalizeGitOutput(value: unknown): string {
  if (typeof value === 'string') return value.replace(/\r\n/g, '\n');
  if (Buffer.isBuffer(value)) return value.toString('utf8').replace(/\r\n/g, '\n');
  if (value == null) return '';
  return String(value).replace(/\r\n/g, '\n');
}

export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function validateWorkspace(workspace: string): Promise<string> {
  if (typeof workspace !== 'string' || workspace.length === 0 || workspace.includes('\0')) {
    throw new GitCommandError('invalid_args', 'Workspace must be a non-empty path');
  }
  if (!path.isAbsolute(workspace)) {
    throw new GitCommandError('invalid_args', 'Workspace must be an absolute path', { cwd: workspace });
  }

  const normalizedWorkspace = path.resolve(workspace);
  try {
    const info = await stat(normalizedWorkspace);
    if (!info.isDirectory()) {
      throw new GitCommandError('invalid_args', 'Workspace must be an existing directory', {
        cwd: normalizedWorkspace,
      });
    }
    await access(normalizedWorkspace, constants.R_OK);
  } catch (error) {
    if (error instanceof GitCommandError) throw error;
    throw new GitCommandError('invalid_args', 'Workspace must be an existing directory', {
      cwd: normalizedWorkspace,
      cause: error,
    });
  }

  return normalizedWorkspace;
}

function validateGitArgv(argv: readonly string[]): void {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new GitCommandError('invalid_args', 'Git argv must be a non-empty string array', { argv });
  }

  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.length === 0 || arg.includes('\0')) {
      throw new GitCommandError('invalid_args', 'Git argv contains an invalid argument', { argv });
    }
  }

  if (argv.includes('-C') || argv.some((arg) => arg.startsWith('--git-dir') || arg.startsWith('--work-tree'))) {
    throw new GitCommandError('invalid_args', 'Git argv contains unsafe repository override arguments', {
      argv,
    });
  }
}

async function execGitRaw(
  cwd: string,
  argv: readonly string[],
  options: GitExecutorOptions,
  behavior: { mapNotGitRepo?: boolean } = {},
): Promise<GitCommandResult> {
  validateGitArgv(argv);

  try {
    const result = await execFileAsync('git', [...argv], {
      cwd,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
      windowsHide: true,
    });
    return {
      stdout: normalizeGitOutput(result.stdout),
      stderr: normalizeGitOutput(result.stderr),
    };
  } catch (error) {
    throw mapExecError(error, cwd, argv, behavior);
  }
}

function mapExecError(
  error: unknown,
  cwd: string,
  argv: readonly string[],
  behavior: { mapNotGitRepo?: boolean },
): GitCommandError {
  const execError = error as ExecFileException & {
    stdout?: unknown;
    stderr?: unknown;
    killed?: boolean;
    code?: number | string;
    signal?: NodeJS.Signals | string;
  };
  const stdout = normalizeGitOutput(execError.stdout);
  const stderr = normalizeGitOutput(execError.stderr);
  const code = execError.code;
  const signal = execError.signal;
  const message = [stderr.trim(), execError.message].filter(Boolean).join('\n');

  if (code === 'ENOENT') {
    return new GitCommandError('git_not_installed', 'Git executable was not found', {
      stdout,
      stderr,
      exitCode: code,
      signal,
      argv,
      cwd,
      cause: error,
    });
  }

  if (execError.killed || /timed out/i.test(execError.message)) {
    return new GitCommandError('timeout', 'Git command timed out', {
      stdout,
      stderr,
      exitCode: code,
      signal,
      argv,
      cwd,
      cause: error,
    });
  }

  if (behavior.mapNotGitRepo && /not a git repository/i.test(stderr + '\n' + execError.message)) {
    return new GitCommandError('not_git_repo', 'Workspace is not a Git repository', {
      stdout,
      stderr,
      exitCode: code,
      signal,
      argv,
      cwd,
      cause: error,
    });
  }

  return new GitCommandError('git_command_failed', message || 'Git command failed', {
    stdout,
    stderr,
    exitCode: code,
    signal,
    argv,
    cwd,
    cause: error,
  });
}
