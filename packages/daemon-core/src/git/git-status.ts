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
/**
 * Package names that, when changed, mean the daemon runtime is stale and must be
 * rebuilt/redeployed + restarted. Everything NOT in this set (web-core,
 * web-standalone, web-devconsole, terminal-render-web) is web-only — a daemon
 * restart is not required for those, only a web redeploy. mcp-server runs in the
 * same process surface as the daemon tooling, so it is classified as
 * daemon-affecting (conservative). Unknown package → daemon-affecting.
 */
const DAEMON_RUNTIME_PACKAGES = new Set([
  'daemon-core',
  'daemon-standalone',
  'session-host-core',
  'session-host-daemon',
  'terminal-mux-core',
  'terminal-mux-control',
  'terminal-mux-cli',
  'ghostty-vt-node',
  'mcp-server',
]);

const WEB_ONLY_PACKAGES = new Set([
  'web-core',
  'web-standalone',
  'web-devconsole',
  'terminal-render-web',
]);

/**
 * Root-level (non-package) files that demonstrably cannot change what the daemon
 * runtime executes: convergence/verify markers, documentation, and license/notice
 * text. A root commit that moves the oss gitlink while the oss commit only touched
 * one of these is NOT a reason to rebuild/restart the daemon — flagging it produces
 * the staleDaemonBuild false-positive this guard exists to suppress.
 *
 * Deliberately conservative: anything NOT matched here (root config like
 * package.json / tsconfig / build scripts, `.txt` fixtures, lockfiles, unknown
 * dotfiles) stays daemon-affecting, because a false-negative — staying silent when
 * the daemon really IS stale — is worse than an over-warn. Markers are the common
 * real-world case (e.g. `.verify-patch-equiv-rc292`), so they are matched broadly;
 * docs are matched by the `docs/` prefix or a markdown/text-doc extension at a
 * filename we recognize as documentation (README/CHANGELOG/LICENSE/NOTICE).
 */
function isNonRuntimeRootFile(file: string): boolean {
  const base = file.slice(file.lastIndexOf('/') + 1);
  // Verify/convergence markers: dotfiles whose name signals a transient marker.
  if (/^\.(?:verify|marker|converge|ff-verify|patch-equiv|live-verify)\b/i.test(base)) return true;
  // Documentation living under a docs/ tree (any depth, root or nested).
  if (/(?:^|\/)docs\//i.test(file)) return true;
  // Recognized top-level documentation / license files.
  if (/^(?:README|CHANGELOG|LICENSE|NOTICE|AUTHORS|CONTRIBUTING|CODEOWNERS)(?:\.[A-Za-z0-9]+)?$/i.test(base)) {
    return true;
  }
  return false;
}

/**
 * Determine whether the changes between buildCommit..HEAD touch any daemon-runtime
 * package. Returns isDaemonAffecting:true conservatively when the changed-file set
 * can't be obtained or any changed path is outside the known web-only package set
 * AND is not a recognized non-runtime root file (marker/doc/license).
 */
async function classifyDaemonBuildChange(
  repoPath: string,
  buildCommit: string,
  options: GitStatusOptions,
): Promise<{ isDaemonAffecting: boolean; affectedPackages: string[] }> {
  try {
    const diff = await runGit(repoPath, ['diff', '--name-only', `${buildCommit}..HEAD`], options);
    const files = diff.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (files.length === 0) {
      // No file diff (e.g. only merge metadata) — nothing actionable, but stay
      // conservative and treat as daemon-affecting so we don't suppress a real warning.
      return { isDaemonAffecting: true, affectedPackages: [] };
    }
    const pkgs = new Set<string>();
    // A non-package path that is NOT a recognized benign root file (marker/doc).
    // Only these force daemon-affecting; benign markers/docs are ignored so a
    // gitlink-moving root commit over a marker-only oss commit no longer over-warns.
    let sawRuntimeAmbiguousNonPackage = false;
    for (const file of files) {
      const match = file.match(/(?:^|\/)packages\/([^/]+)\//);
      if (!match) {
        if (!isNonRuntimeRootFile(file)) sawRuntimeAmbiguousNonPackage = true;
        continue;
      }
      pkgs.add(match[1]);
    }
    const affectedPackages = [...pkgs].sort();
    // Daemon-affecting if: any runtime-ambiguous non-package file changed, any
    // unknown package changed, or any explicit daemon-runtime package changed.
    // The daemon is unaffected only when every changed file is either a known
    // web-only package or a recognized benign root file (and at least one such
    // file changed) — i.e. nothing runtime-ambiguous remains.
    const allBenign =
      !sawRuntimeAmbiguousNonPackage &&
      affectedPackages.every((p) => WEB_ONLY_PACKAGES.has(p) && !DAEMON_RUNTIME_PACKAGES.has(p));
    return { isDaemonAffecting: !allBenign, affectedPackages };
  } catch {
    // diff probe failed → can't prove web-only; stay conservative.
    return { isDaemonAffecting: true, affectedPackages: [] };
  }
}

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
      // Inspect WHICH packages changed in buildCommit..HEAD. A daemon rebuild/restart
      // is only actually required when a daemon-runtime package changed; if only web /
      // render packages changed, the daemon is unaffected and just the web deploy is
      // pending. Conservative: any probe failure → treat as daemon-affecting.
      const { isDaemonAffecting, affectedPackages } = await classifyDaemonBuildChange(
        repoPath,
        build.commit,
        options,
      );
      const scopeLabel = scope === 'root' ? 'workspace' : scope;
      const benignDetail = affectedPackages.length > 0
        ? `only web packages changed (${affectedPackages.join(', ')})`
        : 'only non-runtime files changed (markers/docs)';
      const warning = isDaemonAffecting
        ? `Live daemon was built from ${build.commitShort} which is behind ${scopeLabel} HEAD ${head.slice(0, 7)}. ` +
          `Merged code is NOT live until the daemon is rebuilt/redeployed and restarted — a local dist rebuild alone does not update a cloud daemon.`
        : `Live daemon was built from ${build.commitShort} which is behind ${scopeLabel} HEAD ${head.slice(0, 7)}, ` +
          `but ${benignDetail}. ` +
          `Daemon restart NOT required — redeploy the web app to reflect the change.`;
      return {
        buildCommit: build.commit,
        buildCommitShort: build.commitShort,
        head,
        scope,
        isDaemonAffecting,
        ...(affectedPackages && affectedPackages.length > 0 ? { affectedPackages } : {}),
        warning,
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
