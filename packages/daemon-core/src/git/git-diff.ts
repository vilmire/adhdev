import { readFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import type { GitDiffSummary, GitFileChange, GitFileChangeStatus } from './git-types.js';
import { GitCommandError, isPathInside, resolveGitRepository, runGit } from './git-executor.js';

const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_BYTES = 200_000;

export interface GitDiffOptions {
  timeoutMs?: number;
  maxFiles?: number;
  maxBytes?: number;
}

export interface GitFileDiffResult {
  workspace: string;
  repoRoot: string;
  isGitRepo: true;
  path: string;
  diff: string;
  truncated: boolean;
  lastCheckedAt: number;
}

interface NameStatusEntry {
  path: string;
  oldPath?: string;
  status: GitFileChangeStatus;
}

interface NumstatEntry {
  path: string;
  insertions: number;
  deletions: number;
  binary: boolean;
}

export async function getGitDiffSummary(
  workspace: string,
  options: GitDiffOptions = {},
): Promise<GitDiffSummary> {
  const lastCheckedAt = Date.now();

  try {
    const repo = await resolveGitRepository(workspace, options);
    const repoRoot = repo.repoRoot!;
    const [unstagedNameStatus, unstagedNumstat, stagedNameStatus, stagedNumstat, untracked] = await Promise.all([
      runGit(repo, ['diff', '--no-ext-diff', '--name-status'], { ...options, cwd: repoRoot }),
      runGit(repo, ['diff', '--no-ext-diff', '--numstat'], { ...options, cwd: repoRoot }),
      runGit(repo, ['diff', '--cached', '--no-ext-diff', '--name-status'], { ...options, cwd: repoRoot }),
      runGit(repo, ['diff', '--cached', '--no-ext-diff', '--numstat'], { ...options, cwd: repoRoot }),
      runGit(repo, ['ls-files', '--others', '--exclude-standard'], { ...options, cwd: repoRoot }),
    ]);

    const outputBytes = byteLength(
      unstagedNameStatus.stdout + unstagedNumstat.stdout + stagedNameStatus.stdout + stagedNumstat.stdout + untracked.stdout,
    );
    const changes = [
      ...combineDiffEntries(unstagedNameStatus.stdout, unstagedNumstat.stdout, false),
      ...combineDiffEntries(stagedNameStatus.stdout, stagedNumstat.stdout, true),
      ...parseUntrackedFiles(untracked.stdout),
    ];

    const maxFiles = normalizePositiveInteger(options.maxFiles, DEFAULT_MAX_FILES);
    const maxBytes = normalizePositiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
    const files = changes.slice(0, maxFiles);
    const truncated = changes.length > files.length || outputBytes > maxBytes;

    return {
      workspace: repo.workspace,
      repoRoot,
      isGitRepo: true,
      files,
      totalInsertions: files.reduce((sum, file) => sum + file.insertions, 0),
      totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
      truncated,
      lastCheckedAt,
    };
  } catch (error) {
    const gitError = error instanceof GitCommandError
      ? error
      : new GitCommandError('git_command_failed', 'Failed to read Git diff summary', { cause: error });
    return {
      workspace,
      repoRoot: null,
      isGitRepo: false,
      files: [],
      totalInsertions: 0,
      totalDeletions: 0,
      truncated: false,
      lastCheckedAt,
      error: gitError.stderr || gitError.message,
      reason: gitError.reason,
    };
  }
}

export async function getGitFileDiff(
  workspace: string,
  filePath: string,
  options: GitDiffOptions = {},
): Promise<GitFileDiffResult> {
  const lastCheckedAt = Date.now();
  const repo = await resolveGitRepository(workspace, options);
  const repoRoot = repo.repoRoot!;
  const selected = await resolveRepoFilePath(repoRoot, filePath);
  const maxBytes = normalizePositiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);

  const [unstaged, staged] = await Promise.all([
    runGit(repo, ['diff', '--no-ext-diff', '--', selected.relativePath], { ...options, cwd: repoRoot }),
    runGit(repo, ['diff', '--cached', '--no-ext-diff', '--', selected.relativePath], { ...options, cwd: repoRoot }),
  ]);

  let diff = [unstaged.stdout, staged.stdout].filter((part) => part.length > 0).join('\n');

  if (!diff) {
    const untracked = await runGit(repo, ['ls-files', '--others', '--exclude-standard', '--', selected.relativePath], {
      ...options,
      cwd: repoRoot,
    });
    const untrackedFiles = untracked.stdout.split('\n').filter(Boolean);
    if (untrackedFiles.includes(selected.relativePath)) {
      diff = await buildUntrackedDiff(selected.absolutePath, selected.relativePath, maxBytes + 1);
    }
  }

  const bounded = truncateText(diff, maxBytes);
  return {
    workspace: repo.workspace,
    repoRoot,
    isGitRepo: true,
    path: selected.relativePath,
    diff: bounded.text,
    truncated: bounded.truncated,
    lastCheckedAt,
  };
}

function combineDiffEntries(nameStatusOutput: string, numstatOutput: string, staged: boolean): GitFileChange[] {
  const statusEntries = parseNameStatus(nameStatusOutput);
  const numstatEntries = parseNumstat(numstatOutput);

  return statusEntries.map((entry, index) => {
    const stats = numstatEntries[index];
    return {
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      staged,
      insertions: stats?.insertions ?? 0,
      deletions: stats?.deletions ?? 0,
      binary: stats?.binary || undefined,
    };
  });
}

function parseNameStatus(output: string): NameStatusEntry[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const fields = line.split('\t');
      const code = fields[0] ?? '';
      const statusLetter = code[0] ?? 'M';

      if (statusLetter === 'R') {
        return {
          oldPath: fields[1] ?? '',
          path: fields[2] ?? fields[1] ?? '',
          status: 'renamed' as const,
        };
      }

      if (statusLetter === 'C') {
        return {
          oldPath: fields[1] ?? '',
          path: fields[2] ?? fields[1] ?? '',
          status: 'copied' as const,
        };
      }

      return {
        path: fields[1] ?? '',
        status: mapNameStatus(statusLetter),
      };
    })
    .filter((entry) => entry.path.length > 0);
}

function parseNumstat(output: string): NumstatEntry[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const fields = line.split('\t');
      const insertionsText = fields[0] ?? '0';
      const deletionsText = fields[1] ?? '0';
      const binary = insertionsText === '-' || deletionsText === '-';
      return {
        path: fields.slice(2).join('\t'),
        insertions: binary ? 0 : Number.parseInt(insertionsText, 10) || 0,
        deletions: binary ? 0 : Number.parseInt(deletionsText, 10) || 0,
        binary,
      };
    });
}

function parseUntrackedFiles(output: string): GitFileChange[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((filePath) => ({
      path: filePath,
      status: 'untracked',
      staged: false,
      insertions: 0,
      deletions: 0,
    }));
}

function mapNameStatus(status: string): GitFileChangeStatus {
  switch (status) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'U':
      return 'conflict';
    case 'M':
    case 'T':
    default:
      return 'modified';
  }
}

async function resolveRepoFilePath(repoRoot: string, filePath: string): Promise<{ absolutePath: string; relativePath: string }> {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) {
    throw new GitCommandError('invalid_args', 'File path must be a non-empty path');
  }

  const canonicalRepoRoot = await realpath(repoRoot).catch(() => path.resolve(repoRoot));
  const absolutePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(repoRoot, filePath);
  const checkPath = await realpath(absolutePath).catch(() => absolutePath);
  const relativeBase = isPathInside(canonicalRepoRoot, checkPath) ? canonicalRepoRoot : path.resolve(repoRoot);

  if (!isPathInside(canonicalRepoRoot, checkPath) && !isPathInside(repoRoot, absolutePath)) {
    throw new GitCommandError('path_outside_repo', 'Selected file path is outside the repository root', {
      cwd: repoRoot,
    });
  }

  const relativePath = path.relative(relativeBase, checkPath).split(path.sep).join('/');
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new GitCommandError('path_outside_repo', 'Selected file path is outside the repository root', {
      cwd: repoRoot,
    });
  }

  return { absolutePath, relativePath };
}

async function buildUntrackedDiff(absolutePath: string, relativePath: string, readLimit: number): Promise<string> {
  const content = await readFile(absolutePath, 'utf8');
  const limitedContent = content.length > readLimit ? content.slice(0, readLimit) : content;
  const lines = limitedContent.length > 0 ? limitedContent.split('\n') : [];
  const plusLines = lines
    .filter((line, index) => index < lines.length - 1 || line.length > 0)
    .map((line) => `+${line}`)
    .join('\n');
  const lineCount = plusLines ? plusLines.split('\n').length : 0;

  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    'new file mode 100644',
    'index 0000000..0000000',
    '--- /dev/null',
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${lineCount} @@`,
    plusLines,
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (byteLength(text) <= maxBytes) return { text, truncated: false };
  return { text: Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8'), truncated: true };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value == null || value <= 0) return fallback;
  return Math.floor(value);
}
