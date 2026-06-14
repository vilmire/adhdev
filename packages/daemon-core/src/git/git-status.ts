import type { DaemonBuildBehind, GitRepoStatus, GitSubmoduleStatus, GitUpstreamFreshness } from './git-types.js';
import { GitCommandError, resolveGitRepository, runGit } from './git-executor.js';
import { getDaemonBuildInfo, type DaemonBuildInfo } from '../build-info.js';

type ResolvedGitRepo = { workspace: string; repoRoot: string | null; isGitRepo: boolean };

export interface GitStatusOptions {
  timeoutMs?: number;
  /** When true, include submodule status in the result. Defaults to true. */
  includeSubmodules?: boolean;
  /** Optional filter to exclude specific submodule paths from status */
  submoduleIgnorePaths?: string[];
  /**
   * When true, refresh the tracked remote before trusting ahead/behind.
   * Callers should opt into this only for convergence-critical surfaces.
   */
  refreshUpstream?: boolean;
  /**
   * Test/override seam for the daemon build stamp used by the stale-build
   * detector. Production callers omit this so the real baked-in build commit
   * (getDaemonBuildInfo) is used.
   */
  daemonBuildInfo?: DaemonBuildInfo;
}

interface GitUpstreamProbe {
  upstreamStatus: GitUpstreamFreshness;
  upstreamFetchedAt?: number;
  upstreamFetchError?: string;
}

export async function getGitRepoStatus(
  workspace: string,
  options: GitStatusOptions = {},
): Promise<GitRepoStatus> {
  const lastCheckedAt = Date.now();
  const includeSubmodules = options.includeSubmodules !== false;

  try {
    const repo = await resolveGitRepository(workspace, options);
    let parsed = await readPorcelainStatus(repo, options);
    let upstreamProbe: GitUpstreamProbe = getInitialUpstreamProbe(parsed);

    if (options.refreshUpstream) {
      upstreamProbe = await refreshTrackedUpstream(repo, parsed, options);
      if (upstreamProbe.upstreamStatus === 'fresh') {
        parsed = await readPorcelainStatus(repo, options);
      }
    }

    const head = await readHead(repo, options);
    const stashCount = await readStashCount(repo, options);

    let submodules: GitSubmoduleStatus[] | undefined;
    if (includeSubmodules) {
      submodules = await getSubmoduleStatuses(repo, options);
    }
    const submoduleDirty = (submodules || []).some(submodule => submodule.dirty || submodule.outOfSync || !!submodule.error);
    const dirty = parsed.staged + parsed.modified + parsed.untracked + parsed.deleted + parsed.renamed > 0
      || parsed.conflictFiles.length > 0
      || stashCount > 0
      || submoduleDirty;

    const daemonBuildBehind = await detectDaemonBuildBehind(repo, submodules, options);

    return {
      workspace: repo.workspace,
      repoRoot: repo.repoRoot,
      isGitRepo: true,
      branch: parsed.branch,
      headCommit: head.commit,
      headMessage: head.message,
      upstream: parsed.upstream,
      upstreamStatus: parsed.upstream ? upstreamProbe.upstreamStatus : 'no_upstream',
      upstreamFetchedAt: upstreamProbe.upstreamFetchedAt,
      upstreamFetchError: upstreamProbe.upstreamFetchError,
      ahead: parsed.ahead,
      behind: parsed.behind,
      staged: parsed.staged,
      modified: parsed.modified,
      untracked: parsed.untracked,
      deleted: parsed.deleted,
      renamed: parsed.renamed,
      dirty,
      hasConflicts: parsed.conflictFiles.length > 0,
      conflictFiles: parsed.conflictFiles,
      stashCount,
      lastCheckedAt,
      submodules,
      ...(daemonBuildBehind ? { daemonBuildBehind } : {}),
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

/**
 * Detect whether the running daemon's build commit is a STRICT ancestor of this
 * workspace's HEAD (root) or any of its submodules' HEAD. This surfaces the
 * "merged a fix to main but the live daemon still ships the old bundle" gap:
 * once the fix is committed, the workspace HEAD advances past the daemon's
 * baked-in build commit, but the daemon keeps the old behavior until it is
 * rebuilt/redeployed and restarted.
 *
 * Conservative by construction — returns undefined unless ancestry is provable:
 *   - build commit unknown → undefined
 *   - build commit not an object in this repo/submodule (different repo) → skip
 *   - build commit === HEAD (daemon is current) → undefined
 *   - build commit NOT an ancestor of HEAD (daemon ahead / diverged) → undefined
 * Any git error is swallowed (no warning) so a flaky probe never over-warns.
 */
async function detectDaemonBuildBehind(
  repo: ResolvedGitRepo,
  submodules: GitSubmoduleStatus[] | undefined,
  options: GitStatusOptions,
): Promise<DaemonBuildBehind | undefined> {
  const build = options.daemonBuildInfo ?? getDaemonBuildInfo();
  if (!build.commit || build.commit === 'unknown') return undefined;

  // Check the root repo first, then each submodule. The daemon build commit is
  // baked from the daemon-core (oss submodule) HEAD, so on an adhdev
  // superproject worktree the match is expected on the `oss` submodule, not the
  // root — checking both keeps the helper repo-agnostic.
  const scopes: Array<{ scope: string; repoPath: string }> = [
    { scope: 'root', repoPath: repo.repoRoot || repo.workspace },
  ];
  for (const sub of submodules || []) {
    if (sub.repoPath && !sub.error) scopes.push({ scope: sub.path, repoPath: sub.repoPath });
  }

  for (const { scope, repoPath } of scopes) {
    try {
      // Build commit must be a real object in THIS repo, else it's a different repo.
      await runGit(repoPath, ['cat-file', '-e', `${build.commit}^{commit}`], options);
      const headResult = await runGit(repoPath, ['rev-parse', 'HEAD'], options);
      const head = headResult.stdout.trim();
      if (!head || head === build.commit) continue;
      // Strict ancestor: build commit is reachable from HEAD but is not HEAD.
      await runGit(repoPath, ['merge-base', '--is-ancestor', build.commit, 'HEAD'], options);
      // No throw → build commit IS an ancestor of HEAD → daemon is behind.
      return {
        buildCommit: build.commit,
        buildCommitShort: build.commitShort,
        head,
        scope,
        warning:
          `Live daemon was built from ${build.commitShort} which is behind ${scope === 'root' ? 'workspace' : scope} HEAD ${head.slice(0, 7)}. ` +
          `Merged code is NOT live until the daemon is rebuilt/redeployed and restarted — a local dist rebuild alone does not update a cloud daemon.`,
      };
    } catch {
      // cat-file / merge-base non-zero exit (commit absent or not an ancestor)
      // or any git error → not a provable staleness for this scope; try next.
      continue;
    }
  }
  return undefined;
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

async function readPorcelainStatus(repo: ResolvedGitRepo, options: GitStatusOptions): Promise<ParsedPorcelainStatus> {
  const statusOutput = await runGit(repo, ['status', '--porcelain=v2', '--branch'], options);
  return parsePorcelainV2Status(statusOutput.stdout);
}

function getInitialUpstreamProbe(parsed: ParsedPorcelainStatus): GitUpstreamProbe {
  return {
    upstreamStatus: parsed.upstream ? 'unchecked' : 'no_upstream',
  };
}

async function refreshTrackedUpstream(
  repo: ResolvedGitRepo,
  parsed: ParsedPorcelainStatus,
  options: GitStatusOptions,
): Promise<GitUpstreamProbe> {
  if (!parsed.upstream || !parsed.branch) {
    return { upstreamStatus: 'no_upstream' };
  }

  const remoteName = (await readBranchRemote(repo, parsed.branch, options)) ?? inferRemoteName(parsed.upstream);
  if (!remoteName) {
    return {
      upstreamStatus: 'stale',
      upstreamFetchError: `Unable to resolve remote for upstream '${parsed.upstream}'`,
    };
  }

  try {
    await runGit(repo, ['fetch', '--quiet', '--prune', '--no-tags', remoteName], options);
    return {
      upstreamStatus: 'fresh',
      upstreamFetchedAt: Date.now(),
    };
  } catch (error) {
    return {
      upstreamStatus: 'stale',
      upstreamFetchError: formatGitError(error),
    };
  }
}

async function readBranchRemote(repo: ResolvedGitRepo, branch: string, options: GitStatusOptions): Promise<string | null> {
  try {
    const result = await runGit(repo, ['config', '--get', `branch.${branch}.remote`], options);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

function inferRemoteName(upstream: string): string | null {
  const [remoteName] = upstream.split('/');
  return remoteName?.trim() || null;
}

function formatGitError(error: unknown): string {
  if (error instanceof GitCommandError) {
    return error.stderr || error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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
  repo: ResolvedGitRepo,
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
  repo: ResolvedGitRepo,
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
    upstreamStatus: 'unavailable',
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    untracked: 0,
    deleted: 0,
    renamed: 0,
    dirty: false,
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
  repo: ResolvedGitRepo,
  options: GitStatusOptions,
): Promise<GitSubmoduleStatus[]> {
  if (!repo.repoRoot) return [];

  try {
    const result = await runGit(repo, ['submodule', 'status', '--recursive'], options);
    const submodules = parseSubmoduleStatusOutput(result.stdout, repo.repoRoot, options.submoduleIgnorePaths);
    await Promise.all(submodules.map(submodule => enrichSubmoduleWorktreeStatus(repo, submodule, options)));
    return submodules;
  } catch {
    return [];
  }
}

async function enrichSubmoduleWorktreeStatus(
  repo: ResolvedGitRepo,
  submodule: GitSubmoduleStatus,
  options: GitStatusOptions,
): Promise<void> {
  try {
    const result = await runGit(repo, ['status', '--porcelain=v2', '--branch'], {
      ...options,
      cwd: submodule.repoPath,
    });
    const parsed = parsePorcelainV2Status(result.stdout);
    const dirty = parsed.staged + parsed.modified + parsed.untracked + parsed.deleted + parsed.renamed > 0
      || parsed.conflictFiles.length > 0;
    submodule.dirty = submodule.dirty || dirty;
  } catch (error) {
    submodule.dirty = true;
    submodule.error = formatGitError(error);
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

    // Format: [+-U ]<commit> <path> (<branch>)
    // - = not initialized, + = gitlink out of sync, U = conflict, ' ' = aligned.
    const match = line.match(/^([\-+U\s])([0-9a-f]{40})\s+(\S+)(?:\s+\(([^)]+)\))?/);
    if (!match) continue;

    const prefix = match[1];
    const commit = match[2];
    const path = match[3];

    if (ignoreSet.has(path)) continue;

    submodules.push({
      path,
      commit,
      repoPath: repoRoot + '/' + path,
      dirty: prefix === 'U',
      outOfSync: prefix === '-' || prefix === '+',
      lastCheckedAt: Date.now(),
    });
  }

  return submodules;
}
