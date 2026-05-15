import type { GitRepoStatus, GitSubmoduleStatus } from './git-types.js';
import { GitCommandError, resolveGitRepository, runGit } from './git-executor.js';

export interface GitStatusOptions {
  timeoutMs?: number;
  /** When true, include submodule status in the result. Defaults to true. */
  includeSubmodules?: boolean;
  /** Optional filter to exclude specific submodule paths from status */
  submoduleIgnorePaths?: string[];
}

export async function getGitRepoStatus(
  workspace: string,
  options: GitStatusOptions = {},
): Promise<GitRepoStatus> {
  const lastCheckedAt = Date.now();
  const includeSubmodules = options.includeSubmodules !== false;

  try {
    const repo = await resolveGitRepository(workspace, options);
    const statusOutput = await runGit(repo, ['status', '--porcelain=v2', '--branch'], options);
    const parsed = parsePorcelainV2Status(statusOutput.stdout);
    const head = await readHead(repo, options);
    const stashCount = await readStashCount(repo, options);

    let submodules: GitSubmoduleStatus[] | undefined;
    if (includeSubmodules) {
      submodules = await getSubmoduleStatuses(repo, options);
    }

    return {
      workspace: repo.workspace,
      repoRoot: repo.repoRoot,
      isGitRepo: true,
      branch: parsed.branch,
      headCommit: head.commit,
      headMessage: head.message,
      upstream: parsed.upstream,
      ahead: parsed.ahead,
      behind: parsed.behind,
      staged: parsed.staged,
      modified: parsed.modified,
      untracked: parsed.untracked,
      deleted: parsed.deleted,
      renamed: parsed.renamed,
      hasConflicts: parsed.conflictFiles.length > 0,
      conflictFiles: parsed.conflictFiles,
      stashCount,
      lastCheckedAt,
      submodules,
    };
  } catch (error) {
    if (error instanceof GitCommandError) {
      return emptyStatus(workspace, lastCheckedAt, error);
    }
    return emptyStatus(
      workspace,
      lastCheckedAt,
      new GitCommandError('git_command_failed', 'Failed to read Git status', { cause: error }),
    );
  }
}

interface ParsedPorcelainStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  deleted: number;
  renamed: number;
  conflictFiles: string[];
}

export function parsePorcelainV2Status(output: string): ParsedPorcelainStatus {
  const parsed: ParsedPorcelainStatus = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    untracked: 0,
    deleted: 0,
    renamed: 0,
    conflictFiles: [],
  };

  for (const line of output.split('\n')) {
    if (!line) continue;

    if (line.startsWith('# branch.head ')) {
      const branch = line.slice('# branch.head '.length).trim();
      parsed.branch = branch && branch !== '(detached)' ? branch : null;
      continue;
    }

    if (line.startsWith('# branch.upstream ')) {
      parsed.upstream = line.slice('# branch.upstream '.length).trim() || null;
      continue;
    }

    if (line.startsWith('# branch.ab ')) {
      const match = line.match(/\+(-?\d+)\s+-(-?\d+)/);
      if (match) {
        parsed.ahead = Number.parseInt(match[1] ?? '0', 10) || 0;
        parsed.behind = Number.parseInt(match[2] ?? '0', 10) || 0;
      }
      continue;
    }

    if (line.startsWith('? ')) {
      parsed.untracked += 1;
      continue;
    }

    if (line.startsWith('u ')) {
      const fields = line.split(' ');
      const filePath = fields.slice(10).join(' ');
      if (filePath) parsed.conflictFiles.push(filePath);
      continue;
    }

    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const fields = line.split(' ');
      const xy = fields[1] ?? '..';
      const indexStatus = xy[0] ?? '.';
      const worktreeStatus = xy[1] ?? '.';

      if (isStagedStatus(indexStatus)) parsed.staged += 1;
      if (worktreeStatus === 'M' || worktreeStatus === 'T') parsed.modified += 1;
      if (indexStatus === 'D' || worktreeStatus === 'D') parsed.deleted += 1;
      if (indexStatus === 'R' || worktreeStatus === 'R') parsed.renamed += 1;
      if (xy.includes('U')) {
        const filePath = fields.slice(line.startsWith('2 ') ? 9 : 8).join(' ').split('\t')[0] ?? '';
        if (filePath) parsed.conflictFiles.push(filePath);
      }
    }
  }

  parsed.conflictFiles = Array.from(new Set(parsed.conflictFiles));
  return parsed;
}

async function readHead(
  repo: { workspace: string; repoRoot: string | null; isGitRepo: boolean },
  options: GitStatusOptions,
): Promise<{ commit: string | null; message: string | null }> {
  try {
    const result = await runGit(repo, ['log', '-1', '--pretty=%h%x00%s'], options);
    const text = result.stdout.trimEnd();
    if (!text) return { commit: null, message: null };
    const [commit, ...messageParts] = text.split('\0');
    return {
      commit: commit || null,
      message: messageParts.join('\0') || null,
    };
  } catch {
    return { commit: null, message: null };
  }
}

async function readStashCount(
  repo: { workspace: string; repoRoot: string | null; isGitRepo: boolean },
  options: GitStatusOptions,
): Promise<number> {
  try {
    const result = await runGit(repo, ['stash', 'list', '--format=%gd'], options);
    return result.stdout.split('\n').filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

function isStagedStatus(status: string): boolean {
  return status !== '.' && status !== '?' && status !== 'U';
}

function emptyStatus(workspace: string, lastCheckedAt: number, error: GitCommandError): GitRepoStatus {
  return {
    workspace,
    repoRoot: null,
    isGitRepo: false,
    branch: null,
    headCommit: null,
    headMessage: null,
    upstream: null,
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
    lastCheckedAt,
    error: error.stderr || error.message,
    reason: error.reason,
  };
}

// ─── Submodule Status ───────────────────────────

async function getSubmoduleStatuses(
  repo: { workspace: string; repoRoot: string | null; isGitRepo: boolean },
  options: GitStatusOptions,
): Promise<GitSubmoduleStatus[]> {
  if (!repo.repoRoot) return [];

  try {
    const result = await runGit(repo, ['submodule', 'status', '--recursive'], options);
    return parseSubmoduleStatusOutput(result.stdout, repo.repoRoot, options.submoduleIgnorePaths);
  } catch {
    return [];
  }
}

function parseSubmoduleStatusOutput(
  output: string,
  repoRoot: string,
  ignorePaths?: string[],
): GitSubmoduleStatus[] {
  const submodules: GitSubmoduleStatus[] = [];
  const ignoreSet = new Set(ignorePaths || []);

  for (const line of output.split('\n')) {
    if (!line.trim()) continue;

    // Format: [+- ]<commit> <path> (<branch>)
    // - = out of sync, + = dirty, ' ' = clean
    const match = line.match(/^([\-+\s])([0-9a-f]{40})\s+(\S+)(?:\s+\(([^)]+)\))?/);
    if (!match) continue;

    const prefix = match[1];
    const commit = match[2];
    const path = match[3];

    if (ignoreSet.has(path)) continue;

    submodules.push({
      path,
      commit,
      repoPath: repoRoot + '/' + path,
      dirty: prefix === '+',
      outOfSync: prefix === '-',
      lastCheckedAt: Date.now(),
    });
  }

  return submodules;
}
