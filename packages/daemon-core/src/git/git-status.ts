import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { GitRepoStatus, GitSubmoduleStatus, GitUpstreamFreshness } from './git-types.js';
import { GIT_STATUS_TIMEOUT_MS, GitCommandError, resolveGitRepository, runGit } from './git-executor.js';
import {
  buildBehindAncestryCache,
  type ChangedPackageClassification,
  changeImpactConfigCache,
  changeImpactEvalCache,
  classifyChangedPackages,
  detectDaemonBuildBehind,
  type GitStatusOptions,
  type ResolvedGitRepo,
} from './git-status-change-impact.js';

export { classifyChangedPackages, type ChangedPackageClassification, type GitStatusOptions };

/**
 * TTL for the happy-path result cache (C1). reconcile fires every 4s and mesh_status
 * is polled; a single getGitRepoStatus on a 1-submodule repo spawns ~13-15 git
 * processes (+ optional network fetch) which on Windows is ~10-15s. Within this short
 * window, repeat callers that share the same option shape are served the already
 * collected status instead of re-shelling. Kept well under the 4s reconcile cadence so
 * a genuinely fresh probe still happens at least roughly once per reconcile tick.
 */
export const GIT_STATUS_CACHE_TTL_MS = 1500;

/**
 * Last successfully-collected status per (workspace, option-shape), used for two things:
 *   1. C1 TTL result cache — on the happy path, a cached entry younger than
 *      GIT_STATUS_CACHE_TTL_MS is returned directly (gated by `cachedAt`).
 *   2. Transient-failure fallback — survive a transient git failure (timeout, slow
 *      Windows spawn under load, a momentary lock) WITHOUT dropping the node out of the
 *      mesh graph by re-serving the last good status, re-stamped as stale.
 * A genuine "not a git repository" answer is NOT a transient failure — it never
 * populates this cache and always reports isGitRepo:false. Only a successful, fully
 * populated status is ever cached; error/empty results never are.
 *
 * The key folds in the option fields that change the SHAPE of the collected result
 * (includeSubmodules, refreshUpstream) so different callers don't read each other's
 * partial results. Fields that only affect timing/policy (timeoutMs, daemonBuildInfo,
 * changeImpactConfig, submoduleIgnorePaths) are NOT part of the key — they don't change
 * what a fresh same-shape collection would currently return for the happy path, and the
 * sub-caches (changeImpactEvalCache) already key on their own invalidators.
 */
interface CachedStatusEntry {
  status: GitRepoStatus;
  cachedAt: number;
  startedAtPerf?: number;
}
interface InFlightStatusEntry {
  promise: Promise<GitRepoStatus>;
  timeoutMs: number;
  startedAtPerf: number;
}
const lastKnownGoodStatus = new Map<string, CachedStatusEntry>();
const inFlightStatusReads = new Map<string, InFlightStatusEntry>();
const inFlightUpstreamFetches = new Map<string, Promise<GitUpstreamProbe>>();
const branchRemoteCache = new Map<string, string | null>();

/**
 * Resolve any workspace path (including `/var` vs `/private/var` symlink aliases and
 * nested subdirectories inside a checkout) to its canonical worktree root. Linked
 * worktrees (`git worktree add`) and submodules have their own `.git` entry at their
 * checkout root, so they remain strictly distinct cohorts.
 */
function resolveCanonicalWorktreeRoot(workspace: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(workspace);
  } catch {
    return resolve(workspace);
  }
  let current = canonical;
  while (true) {
    try {
      if (existsSync(join(current, '.git'))) {
        return current;
      }
    } catch {
      // Ignore permission/stat errors while walking upward.
    }
    const parent = dirname(current);
    if (parent === current) {
      return canonical;
    }
    current = parent;
  }
}

/** Cache key folding in canonical worktree root, git config signature, and option fields that change result shape. */
function statusCacheKey(canonicalWorktree: string, configSig: string, options: GitStatusOptions): string {
  const includeSubmodules = options.includeSubmodules !== false;
  const refreshUpstream = options.refreshUpstream === true;
  const ignoreKey = options.submoduleIgnorePaths && options.submoduleIgnorePaths.length > 0
    ? `\0ign=${JSON.stringify([...new Set(options.submoduleIgnorePaths)].sort())}`
    : '';
  return `${canonicalWorktree}\0cfg=${configSig}\0sub=${includeSubmodules ? 1 : 0}\0up=${refreshUpstream ? 1 : 0}${ignoreKey}`;
}

/** Test seam: clear the last-known-good status cache between cases. */
export function __resetGitStatusCacheForTests(): void {
  lastKnownGoodStatus.clear();
  inFlightStatusReads.clear();
  inFlightUpstreamFetches.clear();
  branchRemoteCache.clear();
  changeImpactEvalCache.clear();
  changeImpactConfigCache.clear();
  upstreamFetchedAt.clear();
  buildBehindAncestryCache.clear();
}

/** Test-only introspection: number of memoized Change Impact evaluations. */
export function __changeImpactEvalCacheSizeForTests(): number {
  return changeImpactEvalCache.size;
}

/** Test-only introspection: number of coalesced in-flight status reads currently active. */
export function __inFlightStatusReadCountForTests(): number {
  return inFlightStatusReads.size;
}

/**
 * git failure reasons that are transient/environmental rather than a real statement
 * that the workspace is not a repo. On these we prefer the last-known-good status so a
 * single slow git call cannot make a healthy node vanish from the graph.
 */
function isTransientGitFailure(error: GitCommandError): boolean {
  return error.reason === 'timeout' || error.reason === 'git_command_failed';
}

/**
 * C2: minimum interval between actual `git fetch` network calls per workspace. A
 * refreshUpstream caller within this window does NOT re-fetch; it serves ahead/behind
 * from the locally-re-read porcelain (which is always fresh every call). So
 * refreshUpstream becomes "fetch if the local remote-tracking ref is stale" rather than
 * "always pay a network round trip". Only the upstream ahead/behind can age up to this
 * throttle; local working-tree status never does.
 */
export const GIT_FETCH_THROTTLE_MS = 30_000;

/**
 * Cap the network `git fetch` timeout during `refreshUpstream` so a slow/stalled
 * remote does not consume the entire 20s status budget or starve the IPC deadline;
 * on fetch timeout `refreshTrackedUpstream` degrades gracefully to `upstreamStatus: 'stale'`
 * while still returning fresh local working-tree status.
 */
export const GIT_UPSTREAM_FETCH_TIMEOUT_MS = 10_000;

/** Wall-clock of the last successful `git fetch` per workspace+upstream+remote (C2 throttle gate). */
const upstreamFetchedAt = new Map<string, number>();

interface GitUpstreamProbe {
  upstreamStatus: GitUpstreamFreshness;
  upstreamFetchedAt?: number;
  upstreamFetchError?: string;
  /** True only when this probe performed an actual network fetch (porcelain re-read needed). */
  didFetch?: boolean;
}

function buildStatusFailureResult(
  workspace: string,
  cacheKey: string,
  lastCheckedAt: number,
  gitError: GitCommandError,
): GitRepoStatus {
  // A transient/environmental failure (timeout, slow-spawn-under-load) must NOT make
  // a healthy node lose its repo identity and drop out of the mesh graph. Prefer the
  // last status we successfully collected for this workspace, re-stamped as stale.
  if (isTransientGitFailure(gitError)) {
    const cached = lastKnownGoodStatus.get(cacheKey)?.status;
    if (cached) {
      return {
        ...cached,
        lastCheckedAt,
        upstreamStatus: 'unavailable',
        error: gitError.stderr || gitError.message,
        reason: gitError.reason,
      };
    }
  }
  return emptyStatus(workspace, lastCheckedAt, gitError);
}

function awaitWithCallerDeadline(
  sharedPromise: Promise<GitRepoStatus>,
  callerTimeoutMs: number,
  signal: AbortSignal | undefined,
  workspace: string,
  cacheKey: string,
  lastCheckedAt: number,
  elapsedMs = 0,
): Promise<GitRepoStatus> {
  const hasTimer = Number.isFinite(callerTimeoutMs) && callerTimeoutMs > 0;
  if (!hasTimer && !signal) {
    return sharedPromise;
  }
  if (signal?.aborted) {
    return Promise.resolve(
      buildStatusFailureResult(
        workspace,
        cacheKey,
        lastCheckedAt,
        new GitCommandError('timeout', 'Git status request aborted'),
      ),
    );
  }
  if (hasTimer && elapsedMs >= callerTimeoutMs) {
    return Promise.resolve(
      buildStatusFailureResult(
        workspace,
        cacheKey,
        lastCheckedAt,
        new GitCommandError('timeout', `Git status timed out after ${callerTimeoutMs}ms`),
      ),
    );
  }

  const remainingMs = hasTimer ? Math.max(1, Math.ceil(callerTimeoutMs - elapsedMs)) : 0;

  return new Promise<GitRepoStatus>((resolveCaller) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveCaller(
        buildStatusFailureResult(
          workspace,
          cacheKey,
          lastCheckedAt,
          new GitCommandError('timeout', 'Git status request aborted'),
        ),
      );
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (hasTimer) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveCaller(
          buildStatusFailureResult(
            workspace,
            cacheKey,
            lastCheckedAt,
            new GitCommandError('timeout', `Git status timed out after ${callerTimeoutMs}ms`),
          ),
        );
      }, remainingMs);
    }
    sharedPromise.then(
      (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveCaller(result);
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        const gitError = err instanceof GitCommandError
          ? err
          : new GitCommandError('git_command_failed', 'Failed to read Git status', { cause: err });
        resolveCaller(buildStatusFailureResult(workspace, cacheKey, lastCheckedAt, gitError));
      },
    );
  });
}

export async function getGitRepoStatus(
  workspace: string,
  options: GitStatusOptions = {},
): Promise<GitRepoStatus> {
  const callerStartedAtPerf = performance.now();
  const lastCheckedAt = Date.now();
  const includeSubmodules = options.includeSubmodules !== false;
  const callerTimeoutMs = options.timeoutMs ?? GIT_STATUS_TIMEOUT_MS;
  // Status collection fans out into several git subprocesses (status, head, stash,
  // submodule, optionally fetch). On Windows the per-spawn cost alone can exceed the
  // 5s default, so unless the caller pinned a timeout, give the whole collection path
  // the larger status budget. Strip caller-local `signal` from the shared options so one
  // caller aborting never kills subprocesses shared with concurrent waiters.
  const { signal, ...sharedBaseOptions } = options;
  const effectiveOptions: GitStatusOptions =
    options.timeoutMs === undefined
      ? { ...sharedBaseOptions, timeoutMs: GIT_STATUS_TIMEOUT_MS }
      : sharedBaseOptions;

  const canonicalWorktree = resolveCanonicalWorktreeRoot(workspace);
  const configSig = resolveGitConfigSignature(canonicalWorktree);
  const cacheKey = statusCacheKey(canonicalWorktree, configSig, options);

  if (signal?.aborted) {
    return buildStatusFailureResult(
      workspace,
      cacheKey,
      lastCheckedAt,
      new GitCommandError('timeout', 'Git status request aborted'),
    );
  }
  if (Number.isFinite(callerTimeoutMs) && (callerTimeoutMs <= 0 || performance.now() - callerStartedAtPerf >= callerTimeoutMs)) {
    return buildStatusFailureResult(
      workspace,
      cacheKey,
      lastCheckedAt,
      new GitCommandError('timeout', `Git status timed out after ${callerTimeoutMs}ms`),
    );
  }

  // C1: happy-path TTL result cache. A non-forceFresh caller within the TTL window is
  // served the last successfully-collected status for this exact option shape instead
  // of re-shelling ~14 git processes. Only successful, fully-populated results are ever
  // stored (see the .set below + the never-cache-error rule in the catch), so a cache
  // hit can never serve an error/empty status.
  if (!options.forceFresh) {
    const cached = lastKnownGoodStatus.get(cacheKey);
    if (cached && lastCheckedAt - cached.cachedAt < GIT_STATUS_CACHE_TTL_MS) {
      return cached.status;
    }
    // Single-flight coalescing: join an existing in-flight collection ONLY when its
    // subprocess budget is at least as large as this caller's budget (so a short-budget
    // initiator can never drag normal joiners into a premature timeout failure) and it has
    // not already outlived its own budget, while awaitWithCallerDeadline enforces every
    // caller's own total wait deadline locally.
    const inFlight = inFlightStatusReads.get(cacheKey);
    if (
      inFlight
      && inFlight.timeoutMs >= callerTimeoutMs
      && callerStartedAtPerf - inFlight.startedAtPerf < inFlight.timeoutMs
    ) {
      return awaitWithCallerDeadline(
        inFlight.promise,
        callerTimeoutMs,
        signal,
        workspace,
        cacheKey,
        lastCheckedAt,
        performance.now() - callerStartedAtPerf,
      );
    }
  }

  const runPromise = (async (): Promise<GitRepoStatus> => {
    try {
      const repo = await resolveGitRepository(canonicalWorktree, effectiveOptions);
      const status = await collectGitRepoStatus(repo, includeSubmodules, lastCheckedAt, effectiveOptions);
      // Cache the fresh, fully-populated success. Stamp cachedAt at completion (with
      // Math.max(lastCheckedAt, Date.now()) so mocked clocks remain deterministic) so
      // a slow collection (>1.5s) is not already expired the moment it finishes.
      const completedAt = Math.max(lastCheckedAt, Date.now());
      const existingCached = lastKnownGoodStatus.get(cacheKey);
      const currentInFlight = inFlightStatusReads.get(cacheKey);
      const supersededByNewerInFlight =
        currentInFlight !== undefined && currentInFlight.startedAtPerf > callerStartedAtPerf;
      if (
        !supersededByNewerInFlight
        && (
          !existingCached
          || existingCached.startedAtPerf === undefined
          || existingCached.startedAtPerf <= callerStartedAtPerf
        )
      ) {
        lastKnownGoodStatus.set(cacheKey, {
          status,
          cachedAt: completedAt,
          startedAtPerf: callerStartedAtPerf,
        });
      } else if (supersededByNewerInFlight && !existingCached) {
        lastKnownGoodStatus.set(cacheKey, {
          status,
          cachedAt: 0,
          startedAtPerf: callerStartedAtPerf,
        });
      }
      return status;
    } catch (error) {
      const gitError = error instanceof GitCommandError
        ? error
        : new GitCommandError('git_command_failed', 'Failed to read Git status', { cause: error });
      return buildStatusFailureResult(workspace, cacheKey, lastCheckedAt, gitError);
    }
  })();

  const existingInFlight = inFlightStatusReads.get(cacheKey);
  const existingExpired =
    existingInFlight !== undefined
    && callerStartedAtPerf - existingInFlight.startedAtPerf >= existingInFlight.timeoutMs;
  if (
    !existingInFlight
    || existingExpired
    || existingInFlight.timeoutMs < callerTimeoutMs
    || (options.forceFresh && existingInFlight.timeoutMs <= callerTimeoutMs)
  ) {
    inFlightStatusReads.set(cacheKey, {
      promise: runPromise,
      timeoutMs: callerTimeoutMs,
      startedAtPerf: callerStartedAtPerf,
    });
  }
  const cleanupPromise = runPromise.finally(() => {
    if (inFlightStatusReads.get(cacheKey)?.promise === runPromise) {
      inFlightStatusReads.delete(cacheKey);
    }
  });

  return awaitWithCallerDeadline(
    cleanupPromise,
    callerTimeoutMs,
    signal,
    workspace,
    cacheKey,
    lastCheckedAt,
    performance.now() - callerStartedAtPerf,
  );
}

async function collectGitRepoStatus(
  repo: ResolvedGitRepo,
  includeSubmodules: boolean,
  lastCheckedAt: number,
  options: GitStatusOptions,
): Promise<GitRepoStatus> {
    let parsed = await readPorcelainStatus(repo, options);
    let upstreamProbe: GitUpstreamProbe = getInitialUpstreamProbe(parsed);

    const upstreamRefreshPromise = options.refreshUpstream
      ? (async () => {
          upstreamProbe = await refreshTrackedUpstream(repo, parsed, options);
          // Re-read the porcelain (to pick up the updated ahead/behind) ONLY when this probe
          // actually fetched. When the fetch was throttled (C2), the remote-tracking ref is
          // unchanged, so the ahead/behind already parsed is still correct — re-reading would
          // be a wasted spawn.
          if (upstreamProbe.upstreamStatus === 'fresh' && upstreamProbe.didFetch) {
            parsed = await readPorcelainStatus(repo, options);
          }
        })()
      : Promise.resolve();

    const [_, head, stashCount, subResult] = await Promise.all([
      upstreamRefreshPromise,
      readHead(repo, options),
      readStashCount(repo, options),
      includeSubmodules ? getSubmoduleStatuses(repo, options) : Promise.resolve(undefined),
    ]);

    const submodules = subResult?.submodules;
    const submoduleHeadOids = subResult?.headOidByPath ?? new Map<string, string>();
    const submoduleDirty = (submodules || []).some(submodule => submodule.dirty || submodule.outOfSync || !!submodule.error);
    const dirty = parsed.staged + parsed.modified + parsed.untracked + parsed.deleted + parsed.renamed > 0
      || parsed.conflictFiles.length > 0
      || stashCount > 0
      || submoduleDirty;

    const daemonBuildBehind = await detectDaemonBuildBehind(repo, submodules, options, {
      rootHeadOid: parsed.headOid,
      submoduleHeadOids,
    });

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
}

interface ParsedPorcelainStatus {
  branch: string | null;
  /** Full HEAD object id from `# branch.oid`, or null when detached/unborn. */
  headOid: string | null;
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

  const canonicalWorktree = resolveCanonicalWorktreeRoot(repo.workspace);
  const configSig = resolveGitConfigSignature(canonicalWorktree);
  const remoteName =
    (await readBranchRemote(repo, canonicalWorktree, configSig, parsed.branch, parsed.upstream, options))
    ?? inferRemoteName(parsed.upstream);
  if (!remoteName) {
    return {
      upstreamStatus: 'stale',
      upstreamFetchError: `Unable to resolve remote for upstream '${parsed.upstream}'`,
    };
  }

  const fetchKey = `${canonicalWorktree}\0${parsed.branch}\0${parsed.upstream}\0${remoteName}\0${configSig}`;

  // C2: throttle the actual network fetch per (canonicalWorktree, branch, upstream, remote, configSig).
  // If we fetched this exact tracking target and remote URL/config within GIT_FETCH_THROTTLE_MS,
  // skip the fetch and serve ahead/behind from the local porcelain (re-read fresh every call by the
  // caller). Retargeting a branch to a different upstream remote or changing a remote's URL in
  // git config changes fetchKey so the new target is fetched immediately. forceFresh callers
  // (convergence-critical: ff / refine) always re-fetch — they need true upstream.
  const now = Date.now();
  const lastFetch = upstreamFetchedAt.get(fetchKey);
  if (!options.forceFresh && lastFetch !== undefined && now - lastFetch < GIT_FETCH_THROTTLE_MS) {
    return {
      upstreamStatus: 'fresh',
      upstreamFetchedAt: lastFetch,
      didFetch: false,
    };
  }

  if (!options.forceFresh) {
    const existingFetch = inFlightUpstreamFetches.get(fetchKey);
    if (existingFetch) {
      return existingFetch;
    }
  }

  const fetchTimeoutMs =
    options.timeoutMs !== undefined
      ? Math.min(options.timeoutMs, GIT_UPSTREAM_FETCH_TIMEOUT_MS)
      : GIT_UPSTREAM_FETCH_TIMEOUT_MS;
  const fetchOptions: GitStatusOptions = { ...options, timeoutMs: fetchTimeoutMs };

  const fetchPromise = (async (): Promise<GitUpstreamProbe> => {
    try {
      await runGit(repo, ['fetch', '--quiet', '--prune', '--no-tags', remoteName], fetchOptions);
      const fetchedAt = Date.now();
      upstreamFetchedAt.set(fetchKey, fetchedAt);
      return {
        upstreamStatus: 'fresh',
        upstreamFetchedAt: fetchedAt,
        didFetch: true,
      };
    } catch (error) {
      return {
        upstreamStatus: 'stale',
        upstreamFetchError: formatGitError(error),
      };
    }
  })();

  if (!inFlightUpstreamFetches.has(fetchKey)) {
    inFlightUpstreamFetches.set(fetchKey, fetchPromise);
  }
  try {
    return await fetchPromise;
  } finally {
    if (inFlightUpstreamFetches.get(fetchKey) === fetchPromise) {
      inFlightUpstreamFetches.delete(fetchKey);
    }
  }
}

function statAndHashConfigFile(cfgPath: string): string {
  const cfg = statSync(cfgPath);
  const raw = readFileSync(cfgPath, 'utf8');
  const digest = createHash('sha1').update(raw).digest('hex');
  return `${cfg.mtimeMs}:${cfg.size}:${digest}`;
}

function resolveGitConfigSignature(canonicalWorktree: string): string {
  try {
    const dotGit = join(canonicalWorktree, '.git');
    const st = statSync(dotGit);
    if (st.isDirectory()) {
      return statAndHashConfigFile(join(dotGit, 'config'));
    }
    if (st.isFile()) {
      const content = readFileSync(dotGit, 'utf8').trim();
      const match = /^gitdir:\s*(.+)$/m.exec(content);
      if (!match) return 'unknown';
      const gitDir = resolve(canonicalWorktree, match[1].trim());
      const parts: string[] = [];
      try {
        parts.push(`g:${statAndHashConfigFile(join(gitDir, 'config'))}`);
      } catch {
        // Optional in linked worktrees
      }
      try {
        parts.push(`w:${statAndHashConfigFile(join(gitDir, 'config.worktree'))}`);
      } catch {
        // Optional
      }
      try {
        const commonDirRaw = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
        const commonDir = resolve(gitDir, commonDirRaw);
        parts.push(`c:${statAndHashConfigFile(join(commonDir, 'config'))}`);
      } catch {
        // Not a linked worktree with commondir
      }
      return parts.length > 0 ? parts.join('|') : 'unknown';
    }
  } catch {
    // Ignore stat/read errors
  }
  return 'unknown';
}

async function readBranchRemote(
  repo: ResolvedGitRepo,
  canonicalWorktree: string,
  configSig: string,
  branch: string,
  upstream: string,
  options: GitStatusOptions,
): Promise<string | null> {
  const remoteKey = `${canonicalWorktree}\0${branch}\0${upstream}\0${configSig}`;
  if (!options.forceFresh && branchRemoteCache.has(remoteKey)) {
    return branchRemoteCache.get(remoteKey) ?? null;
  }
  try {
    const result = await runGit(repo, ['config', '--get', `branch.${branch}.remote`], options);
    const remote = result.stdout.trim() || null;
    branchRemoteCache.set(remoteKey, remote);
    return remote;
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
    headOid: null,
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

    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length).trim();
      // `(initial)` is git's sentinel for an unborn HEAD — not a real object id.
      parsed.headOid = oid && oid !== '(initial)' && /^[0-9a-f]{7,64}$/.test(oid) ? oid : null;
      continue;
    }

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

interface SubmoduleStatusResult {
  submodules: GitSubmoduleStatus[];
  /** Actual checked-out HEAD oid per submodule path (for the C3 ancestry cache key). */
  headOidByPath: Map<string, string>;
}

async function getSubmoduleStatuses(
  repo: ResolvedGitRepo,
  options: GitStatusOptions,
): Promise<SubmoduleStatusResult> {
  if (!repo.repoRoot) return { submodules: [], headOidByPath: new Map() };

  try {
    // Do NOT shell out to `git submodule status`. That porcelain wrapper is a
    // shell script (`git-submodule`) that, per submodule, spawns several child
    // `git` processes; on Windows the wrapper + per-spawn cost alone measured
    // 6.9–62.4s under AV, which dominated the whole collectGitRepoStatus budget
    // and stalled the mesh graph cold-open. The information it gives us — the
    // gitlink sync state (path / recorded SHA / +/-/U prefix) and the dirty
    // verdict — is fully derivable from plumbing/porcelain commands that don't
    // go through the shell wrapper:
    //   • paths           ← `.gitmodules` (git config --file, plumbing)
    //   • expected SHA     ← ONE batched `git ls-tree -z HEAD -- <paths...>` (the
    //                        gitlinks the superproject's HEAD tree records)
    //   • actual SHA       ← `# branch.oid` of the per-submodule porcelain read
    //                        (previously a separate `rev-parse HEAD` spawn)
    //   • dirty            ← the same per-submodule porcelain read
    // Comparing expected vs actual reproduces `+` (out of sync); a checked-out
    // submodule whose worktree is absent/uninitialized reproduces `-`. The `U`
    // (conflict) prefix is surfaced separately via the superproject porcelain
    // status that the caller already parses, and a conflicted submodule's own
    // status read here also flags it dirty — so no row is lost.
    const paths = await readSubmodulePaths(repo, options);
    const ignoreSet = new Set(options.submoduleIgnorePaths || []);
    const visiblePaths = paths.filter(path => !ignoreSet.has(path));
    const [expectedByPath, worktrees] = await Promise.all([
      readGitlinkExpectedShas(repo, visiblePaths, options),
      Promise.all(
        visiblePaths.map(async (path) => {
          const repoPath = repo.repoRoot + '/' + path;
          const worktree = await readSubmoduleWorktreeStatus(repo, repoPath, options);
          return { path, repoPath, worktree };
        }),
      ),
    ]);
    const lastCheckedAt = Date.now();
    const headOidByPath = new Map<string, string>();

    const submodules = worktrees.map(({ path, repoPath, worktree }): GitSubmoduleStatus => {
      const expected = expectedByPath.get(path) ?? null;
      const actual = worktree.headOid;
      // Reuse the actual checked-out HEAD oid for the C3 build-behind ancestry
      // cache key — it's the submodule HEAD the daemon build commit is tested
      // against, and it now rides the porcelain read the dirty check already
      // paid for (no separate rev-parse spawn).
      if (actual) headOidByPath.set(path, actual);
      // Uninitialized / no checked-out HEAD reproduces `git submodule status`'s
      // `-` prefix; a present-but-divergent HEAD reproduces the `+` prefix.
      const outOfSync = actual === null
        ? true
        : expected !== null && expected !== actual;
      return {
        path,
        // Prefer the recorded gitlink SHA (matches the legacy column); fall back
        // to the checked-out SHA so the field is never empty when both are known.
        commit: expected ?? actual ?? '',
        repoPath,
        dirty: worktree.dirty,
        outOfSync,
        lastCheckedAt,
        ...(worktree.error ? { error: worktree.error } : {}),
      };
    });
    return { submodules, headOidByPath };
  } catch {
    return { submodules: [], headOidByPath: new Map() };
  }
}

/** Read submodule paths from `.gitmodules` via plumbing (no shell wrapper). */
async function readSubmodulePaths(repo: ResolvedGitRepo, options: GitStatusOptions): Promise<string[]> {
  if (!repo.repoRoot) return [];
  const gitmodulesPath = repo.repoRoot + '/.gitmodules';
  try {
    const result = await runGit(
      repo,
      ['config', '--file', gitmodulesPath, '--get-regexp', '^submodule\\..*\\.path$'],
      options,
    );
    const paths: string[] = [];
    for (const line of result.stdout.split('\n')) {
      // Each line: `submodule.<name>.path <path>`
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx < 0) continue;
      const value = line.slice(spaceIdx + 1).trim();
      if (value) paths.push(value);
    }
    return paths;
  } catch {
    // No .gitmodules (not a superproject) or unreadable → no submodules.
    return [];
  }
}

/**
 * Expected gitlink SHAs recorded in the superproject HEAD tree for every given
 * submodule path, from ONE `git ls-tree -z HEAD -- <paths...>` spawn — constant
 * process cost no matter how many submodules the superproject has (previously
 * one ls-tree per submodule). `-z` keeps paths raw (no core.quotePath rewriting)
 * so they key the result map verbatim.
 */
async function readGitlinkExpectedShas(
  repo: ResolvedGitRepo,
  submodulePaths: string[],
  options: GitStatusOptions,
): Promise<Map<string, string>> {
  const expectedByPath = new Map<string, string>();
  if (submodulePaths.length === 0 || !repo.repoRoot) return expectedByPath;
  try {
    // Each NUL-terminated entry: `<mode> commit <sha>\t<path>` for a gitlink;
    // paths that are absent or not gitlinks print nothing. Always run relative to
    // repoRoot so submodule paths in .gitmodules resolve against the worktree root.
    const lsTreeOptions = repo.workspace !== repo.repoRoot ? { ...options, cwd: repo.repoRoot } : options;
    const result = await runGit(repo, ['ls-tree', '-z', 'HEAD', '--', ...submodulePaths], lsTreeOptions);
    for (const entry of result.stdout.split('\0')) {
      const match = entry.match(/^\d{6} commit ([0-9a-f]{40,64})\t(.+)$/s);
      if (match) expectedByPath.set(match[2], match[1]);
    }
  } catch {
    // Unreadable tree → no expected SHAs. Same verdict the per-path probes
    // produced when they failed individually: outOfSync falls back to the
    // actual-HEAD comparison (expected === null).
  }
  return expectedByPath;
}

interface SubmoduleWorktreeProbe {
  /** Checked-out HEAD oid from the porcelain `# branch.oid` header (null when absent/unborn/unreadable). */
  headOid: string | null;
  dirty: boolean;
  error?: string;
}

/**
 * ONE `git status --porcelain=v2 --branch` inside the submodule worktree yields
 * BOTH facts the legacy implementation paid two spawns for: the checked-out HEAD
 * oid (`# branch.oid`, replacing a separate `rev-parse HEAD`) and the dirty
 * verdict. Run via cwd (inside the superproject root, so the executor's
 * path-inside-repo guard is satisfied) rather than resolving the submodule as a
 * fresh repo — that would cost an extra `rev-parse --show-toplevel` spawn per
 * submodule, which is exactly the Windows spawn cost this path avoids.
 */
async function readSubmoduleWorktreeStatus(
  repo: ResolvedGitRepo,
  repoPath: string,
  options: GitStatusOptions,
): Promise<SubmoduleWorktreeProbe> {
  try {
    const result = await runGit(repo, ['status', '--porcelain=v2', '--branch'], {
      ...options,
      cwd: repoPath,
    });
    const parsed = parsePorcelainV2Status(result.stdout);
    const dirty = parsed.staged + parsed.modified + parsed.untracked + parsed.deleted + parsed.renamed > 0
      || parsed.conflictFiles.length > 0;
    return { headOid: parsed.headOid, dirty };
  } catch (error) {
    // Unreadable worktree (uninitialized, missing, locked): reproduces the legacy
    // verdict pair — no known HEAD (→ outOfSync via actual === null) + dirty with
    // the surfaced error.
    return { headOid: null, dirty: true, error: formatGitError(error) };
  }
}
