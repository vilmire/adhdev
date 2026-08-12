import { join } from 'node:path';
import type { DaemonBuildBehind, GitRepoStatus, GitSubmoduleStatus, GitUpstreamFreshness } from './git-types.js';
import { GIT_STATUS_TIMEOUT_MS, GitCommandError, resolveGitRepository, runGit } from './git-executor.js';
import { getDaemonBuildInfo, type DaemonBuildInfo } from '../build-info.js';
import {
  type ChangeImpactConfig,
  type ChangeImpactKind,
  type ChangeImpactTarget,
  globToRegExp,
  loadChangeImpactConfig,
} from './change-impact-config.js';

type ResolvedGitRepo = { workspace: string; repoRoot: string | null; isGitRepo: boolean };

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
}
const lastKnownGoodStatus = new Map<string, CachedStatusEntry>();

/** Cache key folding in only the option fields that change the result shape. */
function statusCacheKey(workspace: string, options: GitStatusOptions): string {
  const includeSubmodules = options.includeSubmodules !== false;
  const refreshUpstream = options.refreshUpstream === true;
  return `${workspace}\0sub=${includeSubmodules ? 1 : 0}\0up=${refreshUpstream ? 1 : 0}`;
}

/**
 * Memoized Change Impact evaluation, keyed by the inputs that can change the
 * verdict: the scope repo path, the buildCommit..HEAD pair, and the resolved
 * config source. The daemonBuildBehind probe runs on every mesh_status /
 * mesh_git_status / fast_forward / git-monitor hit; without this, each hit
 * re-shells `git diff` for the identical commit range. The cache stays correct
 * because HEAD or a config edit perturbs the key, forcing re-evaluation.
 */
interface ChangeImpactEvalEntry {
  isDaemonAffecting: boolean;
  affectedPackages: string[];
}
const changeImpactEvalCache = new Map<string, ChangeImpactEvalEntry>();

/**
 * Best-effort cache of the loaded Change Impact config per repo root, keyed by the
 * config sourceKey (path+mtime). A new sourceKey (config edited/added/removed)
 * supersedes the entry. Avoids re-reading + re-parsing the config file on every
 * status probe while still honoring on-disk edits.
 */
interface ChangeImpactConfigCacheEntry {
  sourceKey: string;
  config: ChangeImpactConfig | null;
}
const changeImpactConfigCache = new Map<string, ChangeImpactConfigCacheEntry>();

/**
 * C3: memoized ancestry verdict for the daemon-build-behind probe, keyed by
 * `${repoPath}::${buildCommit}::${headOid}`. For a fixed (build commit, HEAD oid) pair
 * the ancestry relationship (is build an ancestor of HEAD? equal? unrelated?) is
 * immutable, so the verdict can be cached indefinitely — it auto-invalidates the moment
 * HEAD moves (new oid → new key). This removes the steady-state `cat-file` +
 * `rev-parse` + `merge-base` spawns (2-3 per scope) when HEAD has not moved between
 * probes. A value of `false` means "build is NOT a strict ancestor of HEAD" (current,
 * ahead, or unrelated — no warning); `true` means a strict-ancestor relationship was
 * proven for that pair.
 */
const buildBehindAncestryCache = new Map<string, boolean>();

/** Test seam: clear the last-known-good status cache between cases. */
export function __resetGitStatusCacheForTests(): void {
  lastKnownGoodStatus.clear();
  changeImpactEvalCache.clear();
  changeImpactConfigCache.clear();
  upstreamFetchedAt.clear();
  buildBehindAncestryCache.clear();
}

/** Alias matching the task's requested name. */
export const __resetGitStatusCache = __resetGitStatusCacheForTests;

/** Test-only introspection: number of memoized Change Impact evaluations. */
export function __changeImpactEvalCacheSizeForTests(): number {
  return changeImpactEvalCache.size;
}

/**
 * git failure reasons that are transient/environmental rather than a real statement
 * that the workspace is not a repo. On these we prefer the last-known-good status so a
 * single slow git call cannot make a healthy node vanish from the graph.
 */
function isTransientGitFailure(error: GitCommandError): boolean {
  return error.reason === 'timeout' || error.reason === 'git_command_failed';
}

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
   * When true, bypass the C1 TTL result cache: always re-collect a fresh status
   * (ignoring any cached entry younger than GIT_STATUS_CACHE_TTL_MS). The freshly
   * collected result still UPDATES the cache so subsequent normal callers benefit.
   *
   * Mutating / decision callers (mesh_fast_forward preflight + post-merge re-read,
   * refine submodule alignment pre/post status) MUST set this — acting on a stale
   * ahead/behind or submodule sync verdict is the primary correctness hazard of the
   * cache. Read-only/observe callers (mesh_status, git-monitor, reconcile) leave it
   * unset and enjoy the dedup.
   */
  forceFresh?: boolean;
  /**
   * Test/override seam for the daemon build stamp used by the stale-build
   * detector. Production callers omit this so the real baked-in build commit
   * (getDaemonBuildInfo) is used.
   */
  daemonBuildInfo?: DaemonBuildInfo;
  /**
   * Change Impact policy override. When provided, the daemonBuildBehind
   * classifier uses this declarative config instead of auto-loading the repo's
   * `.adhdev/change-impact.*` file. When omitted, getGitRepoStatus auto-loads the
   * repo config (cached); when neither is present the built-in ADHDev default
   * policy applies, preserving the legacy behavior exactly.
   *
   * Pass `null` to force the built-in default policy and skip auto-loading (used
   * to assert legacy parity in tests).
   */
  changeImpactConfig?: ChangeImpactConfig | null;
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

/** Wall-clock of the last successful `git fetch` per workspace (C2 throttle gate). */
const upstreamFetchedAt = new Map<string, number>();

interface GitUpstreamProbe {
  upstreamStatus: GitUpstreamFreshness;
  upstreamFetchedAt?: number;
  upstreamFetchError?: string;
  /** True only when this probe performed an actual network fetch (porcelain re-read needed). */
  didFetch?: boolean;
}

export async function getGitRepoStatus(
  workspace: string,
  options: GitStatusOptions = {},
): Promise<GitRepoStatus> {
  const lastCheckedAt = Date.now();
  const includeSubmodules = options.includeSubmodules !== false;
  // Status collection fans out into several git subprocesses (status, head, stash,
  // submodule, optionally fetch). On Windows the per-spawn cost alone can exceed the
  // 5s default, so unless the caller pinned a timeout, give the whole collection path
  // the larger status budget. A caller that explicitly sets timeoutMs (e.g. a test
  // injecting 1ms to exercise the transient-failure path) is respected.
  const effectiveOptions: GitStatusOptions =
    options.timeoutMs === undefined ? { ...options, timeoutMs: GIT_STATUS_TIMEOUT_MS } : options;

  const cacheKey = statusCacheKey(workspace, options);

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
  }

  try {
    const repo = await resolveGitRepository(workspace, effectiveOptions);
    const status = await collectGitRepoStatus(repo, includeSubmodules, lastCheckedAt, effectiveOptions);
    // Cache the fresh, fully-populated success. forceFresh callers still refresh the
    // cache so the next normal caller benefits from their freshly-collected status.
    lastKnownGoodStatus.set(cacheKey, { status, cachedAt: lastCheckedAt });
    return status;
  } catch (error) {
    const gitError = error instanceof GitCommandError
      ? error
      : new GitCommandError('git_command_failed', 'Failed to read Git status', { cause: error });

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
}

async function collectGitRepoStatus(
  repo: ResolvedGitRepo,
  includeSubmodules: boolean,
  lastCheckedAt: number,
  options: GitStatusOptions,
): Promise<GitRepoStatus> {
    let parsed = await readPorcelainStatus(repo, options);
    let upstreamProbe: GitUpstreamProbe = getInitialUpstreamProbe(parsed);

    if (options.refreshUpstream) {
      upstreamProbe = await refreshTrackedUpstream(repo, parsed, options);
      // Re-read the porcelain (to pick up the updated ahead/behind) ONLY when this probe
      // actually fetched. When the fetch was throttled (C2), the remote-tracking ref is
      // unchanged, so the ahead/behind already parsed is still correct — re-reading would
      // be a wasted spawn.
      if (upstreamProbe.upstreamStatus === 'fresh' && upstreamProbe.didFetch) {
        parsed = await readPorcelainStatus(repo, options);
      }
    }

    const head = await readHead(repo, options);
    const stashCount = await readStashCount(repo, options);

    let submodules: GitSubmoduleStatus[] | undefined;
    let submoduleHeadOids = new Map<string, string>();
    if (includeSubmodules) {
      const subResult = await getSubmoduleStatuses(repo, options);
      submodules = subResult.submodules;
      submoduleHeadOids = subResult.headOidByPath;
    }
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
const DEFAULT_DAEMON_RUNTIME_PACKAGES = [
  'daemon-core',
  'daemon-standalone',
  'session-host-core',
  'session-host-daemon',
  'terminal-mux-core',
  'terminal-mux-control',
  'terminal-mux-cli',
  'ghostty-vt-node',
  'mcp-server',
];

const DEFAULT_WEB_ONLY_PACKAGES = [
  'web-core',
  'web-standalone',
  'web-devconsole',
  'terminal-render-web',
];

/**
 * Built-in recommended action/command per impact classification. A change-impact
 * config may override any of these via `impactTargets`; missing keys fall back here.
 */
const DEFAULT_IMPACT_TARGETS: Record<ChangeImpactKind, ChangeImpactTarget> = {
  daemon: {
    recommendedCommand: 'Redeploy + restart the daemon (a local dist rebuild alone does not update a cloud daemon).',
  },
  web: {
    recommendedCommand: 'Redeploy the web app (no daemon restart required).',
  },
  none: {
    recommendedCommand: 'No action required.',
  },
};

/**
 * The resolved Change Impact policy: the built-in ADHDev defaults merged with any
 * config override. This is what the classifier consults — git-status only knows the
 * facts (changed files/packages), policy is data.
 */
interface ResolvedChangeImpactPolicy {
  daemonRuntimePackages: Set<string>;
  webOnlyPackages: Set<string>;
  /** Compiled config globs for additional non-runtime root files (on top of built-ins). */
  nonRuntimeRootFilePatterns: RegExp[];
  impactTargets: Record<ChangeImpactKind, ChangeImpactTarget>;
}

function resolveChangeImpactPolicy(config: ChangeImpactConfig | null | undefined): ResolvedChangeImpactPolicy {
  // A field provided in config REPLACES the built-in default for that field; an
  // omitted field falls back to the ADHDev default, so a repo with no config (or a
  // partial config) behaves exactly as before.
  const daemonRuntimePackages = new Set(
    config?.daemonRuntimePackages && config.daemonRuntimePackages.length
      ? config.daemonRuntimePackages
      : DEFAULT_DAEMON_RUNTIME_PACKAGES,
  );
  const webOnlyPackages = new Set(
    config?.webOnlyPackages && config.webOnlyPackages.length
      ? config.webOnlyPackages
      : DEFAULT_WEB_ONLY_PACKAGES,
  );
  const nonRuntimeRootFilePatterns = (config?.nonRuntimeRootFilePatterns || []).map(globToRegExp);
  const impactTargets: Record<ChangeImpactKind, ChangeImpactTarget> = {
    daemon: config?.impactTargets?.daemon ?? DEFAULT_IMPACT_TARGETS.daemon,
    web: config?.impactTargets?.web ?? DEFAULT_IMPACT_TARGETS.web,
    none: config?.impactTargets?.none ?? DEFAULT_IMPACT_TARGETS.none,
  };
  return { daemonRuntimePackages, webOnlyPackages, nonRuntimeRootFilePatterns, impactTargets };
}

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
 *
 * Config-supplied `nonRuntimeRootFilePatterns` are matched in ADDITION to these
 * built-ins, so a repo can extend (never narrow) the benign set declaratively.
 */
function isNonRuntimeRootFile(file: string, policy: ResolvedChangeImpactPolicy): boolean {
  const base = file.slice(file.lastIndexOf('/') + 1);
  // Verify/convergence markers: dotfiles whose name signals a transient marker.
  if (/^\.(?:verify|marker|converge|ff-verify|patch-equiv|live-verify)\b/i.test(base)) return true;
  // Documentation living under a docs/ tree (any depth, root or nested).
  if (/(?:^|\/)docs\//i.test(file)) return true;
  // Recognized top-level documentation / license files.
  if (/^(?:README|CHANGELOG|LICENSE|NOTICE|AUTHORS|CONTRIBUTING|CODEOWNERS)(?:\.[A-Za-z0-9]+)?$/i.test(base)) {
    return true;
  }
  // Config-declared additional non-runtime root globs.
  for (const re of policy.nonRuntimeRootFilePatterns) {
    if (re.test(file)) return true;
  }
  return false;
}

/** Coarse change-impact verdict produced from a changed-file list. */
export interface ChangedPackageClassification {
  isDaemonAffecting: boolean;
  affectedPackages: string[];
  /**
   * DOCS-ROOT: three-way change area, refining the binary isDaemonAffecting so a
   * docs-only branch is distinguishable from a code (web) branch:
   *   'daemon' — a daemon-runtime package (or an unknown/ambiguous path) changed;
   *              full validation + daemon rebuild/restart required.
   *   'web'    — only web-only packages changed; web validation but no daemon restart.
   *   'none'   — no package changed at all; every changed file is a benign non-runtime
   *              root file (docs/markers). No code validation is meaningful — only an
   *              explicit docs-scoped profile (e.g. docs:verify) should run.
   * Derived from the same facts as isDaemonAffecting, so it never contradicts it
   * (changeArea === 'daemon' ⇔ isDaemonAffecting === true).
   */
  changeArea: ChangeImpactKind;
}

/**
 * Derive the three-way {@link ChangeImpactKind} from the binary daemon verdict and the
 * affected-package set, using the exact rule the stale-build warning layer already
 * applies: daemon-affecting → 'daemon'; else any package changed → 'web'; else (only
 * benign non-runtime files, no package) → 'none'.
 */
function deriveChangeArea(isDaemonAffecting: boolean, affectedPackages: string[]): ChangeImpactKind {
  return isDaemonAffecting ? 'daemon' : affectedPackages.length > 0 ? 'web' : 'none';
}

/**
 * Same as {@link ChangedPackageClassification} but also carries the runtime-ambiguous
 * non-package paths that forced (or would force) a daemon-affecting verdict. Callers
 * with git access (classifyChangedPackages) inspect these to descend into submodule
 * gitlinks — a bare submodule path (e.g. `oss`) is runtime-ambiguous from the root's
 * point of view, but its *content* diff may be entirely web-only.
 */
// Intermediate verdict: carries the binary daemon signal + ambiguous paths, but NOT
// the derived `changeArea` — that is computed once at the final classifyChangedPackages
// boundary (`strip` / the submodule folds) so the file-list bucketer stays area-agnostic.
interface ChangedFileListClassification extends Omit<ChangedPackageClassification, 'changeArea'> {
  /** Non-package paths that were not recognized as benign root files. */
  ambiguousNonPackageFiles: string[];
}

/**
 * Pure bucketer: classify an already-collected changed-file list into the coarse
 * daemon-vs-web verdict, per the resolved policy. Shared by classifyDaemonBuildChange
 * (buildCommit..HEAD) and classifyChangedPackages (arbitrary ref range) so the
 * daemon/web boundary logic lives in exactly one place. An empty list stays
 * conservative (daemon-affecting) so an actionable warning is never suppressed.
 */
function classifyChangedFileList(
  files: string[],
  policy: ResolvedChangeImpactPolicy,
): ChangedFileListClassification {
  if (files.length === 0) {
    // No file diff (e.g. only merge metadata) — nothing actionable, but stay
    // conservative and treat as daemon-affecting so we don't suppress a real warning.
    return { isDaemonAffecting: true, affectedPackages: [], ambiguousNonPackageFiles: [] };
  }
  const pkgs = new Set<string>();
  // Non-package paths that are NOT recognized benign root files (marker/doc).
  // Only these force daemon-affecting; benign markers/docs are ignored so a
  // gitlink-moving root commit over a marker-only oss commit no longer over-warns.
  const ambiguousNonPackageFiles: string[] = [];
  for (const file of files) {
    const match = file.match(/(?:^|\/)packages\/([^/]+)\//);
    if (!match) {
      if (!isNonRuntimeRootFile(file, policy)) ambiguousNonPackageFiles.push(file);
      continue;
    }
    pkgs.add(match[1]);
  }
  const affectedPackages = [...pkgs].sort();
  // Daemon-affecting if: any runtime-ambiguous non-package file changed, any
  // unknown package changed, or any explicit daemon-runtime package changed.
  // The daemon is unaffected only when every changed file is either a known
  // web-only package or a recognized benign root file (and at least one such
  // file changed) — i.e. nothing runtime-ambiguous remains. Unlisted/new packages
  // therefore stay daemon-affecting (fail-safe default preserved).
  const allBenign =
    ambiguousNonPackageFiles.length === 0 &&
    affectedPackages.every((p) => policy.webOnlyPackages.has(p) && !policy.daemonRuntimePackages.has(p));
  return { isDaemonAffecting: !allBenign, affectedPackages, ambiguousNonPackageFiles };
}

/**
 * Determine whether the changes between buildCommit..HEAD touch any daemon-runtime
 * package, per the resolved policy. Returns isDaemonAffecting:true conservatively
 * when the changed-file set can't be obtained or any changed path is outside the
 * known web-only package set AND is not a recognized non-runtime root file.
 */
async function classifyDaemonBuildChange(
  repoPath: string,
  buildCommit: string,
  options: GitStatusOptions,
  policy: ResolvedChangeImpactPolicy,
): Promise<ChangedPackageClassification> {
  try {
    const diff = await runGit(repoPath, ['diff', '--name-only', `${buildCommit}..HEAD`], options);
    const files = diff.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const { isDaemonAffecting, affectedPackages } = classifyChangedFileList(files, policy);
    return { isDaemonAffecting, affectedPackages, changeArea: deriveChangeArea(isDaemonAffecting, affectedPackages) };
  } catch {
    // diff probe failed → can't prove web-only; stay conservative.
    return { isDaemonAffecting: true, affectedPackages: [], changeArea: 'daemon' };
  }
}

/**
 * Ref-parameterized change-impact classification for a repo/worktree, reusing the
 * exact daemon-vs-web bucketing that the stale-build detector uses — but over an
 * arbitrary `fromRef..toRef` range (e.g. a refine base head → branch head) instead
 * of the live daemon's build commit → HEAD, and WITHOUT any daemonBuildInfo caching.
 *
 * Policy is resolved the same way as getGitRepoStatus: an explicit
 * `options.changeImpactConfig` wins; otherwise the repo's `.adhdev/change-impact.*`
 * is auto-loaded; otherwise the built-in ADHDev default policy applies. The
 * classification uses `git diff --name-only fromRef..toRef`.
 *
 * FAIL-OPEN on error: if the diff can't be collected (bad ref, not a repo), the
 * caller should treat "no verdict" as "run everything" — so we throw rather than
 * returning a misleading benign verdict. Callers wrap this in try/catch and leave
 * changeImpact undefined on failure. Unclassified/new packages still default to
 * isDaemonAffecting:true (never silently skipped).
 */
export async function classifyChangedPackages(
  repoPath: string,
  fromRef: string,
  toRef: string,
  options: GitStatusOptions = {},
): Promise<ChangedPackageClassification> {
  const repo = await resolveGitRepository(repoPath, options);
  const { config } = resolveChangeImpactConfigForRepo(repo.repoRoot, options);
  const policy = resolveChangeImpactPolicy(config);
  const diff = await runGit(repoPath, ['diff', '--name-only', `${fromRef}..${toRef}`], options);
  const files = diff.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const rootVerdict = classifyChangedFileList(files, policy);
  return refineVerdictThroughSubmodules(repoPath, fromRef, toRef, options, policy, rootVerdict);
}

/**
 * A `.gitmodules`-registered submodule root path (e.g. `oss`) appears in the root diff
 * as a bare gitlink — no `packages/...` segment — so classifyChangedFileList treats it
 * as runtime-ambiguous and the root verdict is daemon-affecting. But the submodule's
 * *content* diff may be entirely web-only (a web-core-only oss commit) — in which case
 * the daemon genuinely isn't affected and the refine gate should skip daemon-scoped
 * validation. This descends into each submodule that is the *only* thing blocking a
 * benign verdict, classifies its own gitlink-range content diff with the SAME policy,
 * and folds the result back.
 *
 * Strictly conservative — a submodule verdict can only ever KEEP the root benign or
 * flip an otherwise-benign root back to daemon-affecting; it never overrides a root
 * that was daemon-affecting for its own reasons (a runtime package / unknown package /
 * a runtime-ambiguous non-submodule file). If ANY blocking non-package path is not a
 * registered submodule, or any submodule probe fails, we keep the conservative root
 * verdict (fail-safe: never silence a real warning on uncertainty).
 */
async function refineVerdictThroughSubmodules(
  repoPath: string,
  fromRef: string,
  toRef: string,
  options: GitStatusOptions,
  policy: ResolvedChangeImpactPolicy,
  rootVerdict: ChangedFileListClassification,
): Promise<ChangedPackageClassification> {
  const strip = ({ isDaemonAffecting, affectedPackages }: ChangedFileListClassification): ChangedPackageClassification =>
    ({ isDaemonAffecting, affectedPackages, changeArea: deriveChangeArea(isDaemonAffecting, affectedPackages) });
  const ambiguous = rootVerdict.ambiguousNonPackageFiles;
  // Fast path: nothing to descend into, or the root is daemon-affecting for a reason
  // other than an ambiguous path (an unknown/daemon package). Submodule descent only
  // ever addresses the ambiguous-non-package reason, so it cannot help here.
  if (ambiguous.length === 0) return strip(rootVerdict);

  let submodulePaths: Set<string>;
  try {
    submodulePaths = await listSubmodulePaths(repoPath, options);
  } catch {
    return strip(rootVerdict); // can't read .gitmodules → stay conservative.
  }
  // Every blocking ambiguous path must be a registered submodule for descent to be able
  // to clear the verdict — otherwise a non-submodule ambiguous file keeps it daemon.
  if (ambiguous.length === 0 || !ambiguous.every((f) => submodulePaths.has(f))) {
    return strip(rootVerdict);
  }

  const submoduleAffectedPackages: string[] = [];
  for (const subPath of ambiguous) {
    let range: { from: string; to: string };
    try {
      range = await resolveSubmoduleGitlinkRange(repoPath, fromRef, toRef, subPath, options);
    } catch {
      return strip(rootVerdict); // couldn't read the gitlink SHAs → conservative.
    }
    // A recursive classify inside the submodule reuses the SAME repo config resolution:
    // the submodule has its own packages/ layout and may carry its own change-impact
    // config; classifyChangedPackages(subRepo, ...) resolves it there.
    let subVerdict: ChangedPackageClassification;
    try {
      subVerdict = await classifyChangedPackages(join(repoPath, subPath), range.from, range.to, {
        ...options,
        // Do not force the root's injected config onto the submodule — let it resolve
        // its own .adhdev/change-impact.* (or fall back to defaults).
        changeImpactConfig: undefined,
      });
    } catch {
      return strip(rootVerdict); // submodule diff failed → conservative.
    }
    if (subVerdict.isDaemonAffecting) {
      // The submodule content really does touch daemon runtime → keep daemon-affecting,
      // surfacing the submodule packages so the reason is visible.
      const affectedPackages = [...new Set([...rootVerdict.affectedPackages, ...subVerdict.affectedPackages])].sort();
      return {
        isDaemonAffecting: true,
        affectedPackages,
        changeArea: deriveChangeArea(true, affectedPackages),
      };
    }
    submoduleAffectedPackages.push(...subVerdict.affectedPackages);
  }

  // Every ambiguous path was a submodule whose content is web-only. The remaining root
  // packages (if any) must themselves be benign web-only for the whole change to be
  // benign — reuse the exact same rule by re-checking the root package set.
  const rootPackagesBenign = rootVerdict.affectedPackages.every(
    (p) => policy.webOnlyPackages.has(p) && !policy.daemonRuntimePackages.has(p),
  );
  const affectedPackages = [...new Set([...rootVerdict.affectedPackages, ...submoduleAffectedPackages])].sort();
  return {
    isDaemonAffecting: !rootPackagesBenign,
    affectedPackages,
    changeArea: deriveChangeArea(!rootPackagesBenign, affectedPackages),
  };
}

/** Registered submodule paths from `.gitmodules` (empty set if none / unreadable). */
async function listSubmodulePaths(repoPath: string, options: GitStatusOptions): Promise<Set<string>> {
  // `git config -f .gitmodules --get-regexp path` lists `submodule.<name>.path <path>`.
  const res = await runGit(repoPath, ['config', '-f', '.gitmodules', '--get-regexp', 'path'], options);
  const paths = new Set<string>();
  for (const line of res.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(' ');
    if (idx === -1) continue;
    const p = trimmed.slice(idx + 1).trim();
    if (p) paths.add(p);
  }
  return paths;
}

/**
 * Read the old/new subproject SHAs a root gitlink moved between over `fromRef..toRef`.
 * `git diff <range> -- <subPath>` on a gitlink prints `-Subproject commit <old>` /
 * `+Subproject commit <new>`. Throws if either SHA can't be resolved.
 */
async function resolveSubmoduleGitlinkRange(
  repoPath: string,
  fromRef: string,
  toRef: string,
  subPath: string,
  options: GitStatusOptions,
): Promise<{ from: string; to: string }> {
  const res = await runGit(repoPath, ['diff', `${fromRef}..${toRef}`, '--', subPath], options);
  let from = '';
  let to = '';
  for (const line of res.stdout.split('\n')) {
    const m = line.match(/^([+-])Subproject commit ([0-9a-f]{7,40})/);
    if (!m) continue;
    if (m[1] === '-') from = m[2];
    else to = m[2];
  }
  if (!from || !to) throw new Error(`no gitlink range for submodule ${subPath}`);
  return { from, to };
}

/**
 * Resolve the Change Impact config to apply for this status read. Priority:
 *   - options.changeImpactConfig === null → force built-in default policy (no load).
 *   - options.changeImpactConfig provided → use it verbatim (override seam).
 *   - otherwise → auto-load the repo's `.adhdev/change-impact.*` (cached by sourceKey).
 * Returns the (possibly null) config plus the sourceKey used for cache invalidation.
 */
function resolveChangeImpactConfigForRepo(
  repoRoot: string | null,
  options: GitStatusOptions,
): { config: ChangeImpactConfig | null; sourceKey: string } {
  if (options.changeImpactConfig === null) {
    return { config: null, sourceKey: 'forced-default' };
  }
  if (options.changeImpactConfig !== undefined) {
    // Injected override — key it to its content so a different injected config
    // re-evaluates rather than reusing a prior verdict.
    let key = 'injected';
    try {
      key = `injected:${JSON.stringify(options.changeImpactConfig)}`;
    } catch {
      // Non-serializable override (shouldn't happen) — fall back to a constant key.
    }
    return { config: options.changeImpactConfig, sourceKey: key };
  }
  if (!repoRoot) {
    return { config: null, sourceKey: 'no-repo-root' };
  }
  const loaded = loadChangeImpactConfig(repoRoot);
  const cached = changeImpactConfigCache.get(repoRoot);
  if (cached && cached.sourceKey === loaded.sourceKey) {
    return { config: cached.config, sourceKey: loaded.sourceKey };
  }
  // An invalid config is conservatively ignored (built-in default policy applies),
  // mirroring the "fail safe" rule — never let a malformed config silence warnings.
  const config = loaded.sourceType === 'repo_file' ? loaded.config ?? null : null;
  changeImpactConfigCache.set(repoRoot, { sourceKey: loaded.sourceKey, config });
  return { config, sourceKey: loaded.sourceKey };
}

interface DaemonBuildBehindHeadOids {
  /** Root repo HEAD oid from porcelain `# branch.oid` (avoids a rev-parse spawn). */
  rootHeadOid: string | null;
  /** Per-submodule-path actual HEAD oid (already read during submodule collection). */
  submoduleHeadOids: Map<string, string>;
}

async function detectDaemonBuildBehind(
  repo: ResolvedGitRepo,
  submodules: GitSubmoduleStatus[] | undefined,
  options: GitStatusOptions,
  headOids: DaemonBuildBehindHeadOids = { rootHeadOid: null, submoduleHeadOids: new Map() },
): Promise<DaemonBuildBehind | undefined> {
  const build = options.daemonBuildInfo ?? getDaemonBuildInfo();
  if (!build.commit || build.commit === 'unknown') return undefined;

  const { config, sourceKey: configKey } = resolveChangeImpactConfigForRepo(repo.repoRoot, options);
  const policy = resolveChangeImpactPolicy(config);

  // Check the root repo first, then each submodule. The daemon build commit is
  // baked from the daemon-core (oss submodule) HEAD, so on an adhdev
  // superproject worktree the match is expected on the `oss` submodule, not the
  // root — checking both keeps the helper repo-agnostic. The known HEAD oid (from
  // porcelain for root, from the submodule rev-parse already paid during collection)
  // is threaded in so the C3 ancestry cache can short-circuit before any spawn.
  const scopes: Array<{ scope: string; repoPath: string; knownHeadOid: string | null }> = [
    { scope: 'root', repoPath: repo.repoRoot || repo.workspace, knownHeadOid: headOids.rootHeadOid },
  ];
  for (const sub of submodules || []) {
    if (sub.repoPath && !sub.error) {
      scopes.push({ scope: sub.path, repoPath: sub.repoPath, knownHeadOid: headOids.submoduleHeadOids.get(sub.path) ?? null });
    }
  }

  for (const { scope, repoPath, knownHeadOid } of scopes) {
    try {
      // C3 fast path: if we already know this scope's HEAD oid and have a cached
      // ancestry verdict for (repoPath, buildCommit, headOid), reuse it. A `false`
      // verdict (not a strict ancestor — current/ahead/unrelated) lets us skip the
      // cat-file + merge-base spawns entirely; the verdict auto-invalidates when HEAD
      // moves (new oid → new key). A `true` verdict still needs the diff
      // classification below, which is itself memoized on the same head oid.
      let head = knownHeadOid;
      const ancestryKey = head ? `${repoPath}::${build.commit}::${head}` : null;
      if (ancestryKey) {
        const cachedVerdict = buildBehindAncestryCache.get(ancestryKey);
        if (cachedVerdict === false) continue;
        if (cachedVerdict === undefined) {
          if (head === build.commit) {
            buildBehindAncestryCache.set(ancestryKey, false);
            continue;
          }
          // Build commit must be a real object in THIS repo, else it's a different repo.
          await runGit(repoPath, ['cat-file', '-e', `${build.commit}^{commit}`], options);
          try {
            await runGit(repoPath, ['merge-base', '--is-ancestor', build.commit, 'HEAD'], options);
          } catch {
            // Not a strict ancestor — cache the negative verdict so the next probe at
            // this same HEAD short-circuits, then move on to the next scope.
            buildBehindAncestryCache.set(ancestryKey, false);
            continue;
          }
          buildBehindAncestryCache.set(ancestryKey, true);
        }
        // cachedVerdict === true (or just proven true) → fall through to classification.
      } else {
        // No known HEAD oid for this scope — fall back to the original probe (resolve
        // HEAD via rev-parse). This keeps correctness when porcelain/submodule oid is
        // unavailable; the verdict is still cached once HEAD is known.
        await runGit(repoPath, ['cat-file', '-e', `${build.commit}^{commit}`], options);
        const headResult = await runGit(repoPath, ['rev-parse', 'HEAD'], options);
        head = headResult.stdout.trim();
        if (!head || head === build.commit) continue;
        await runGit(repoPath, ['merge-base', '--is-ancestor', build.commit, 'HEAD'], options);
        buildBehindAncestryCache.set(`${repoPath}::${build.commit}::${head}`, true);
      }
      // No throw → build commit IS an ancestor of HEAD → daemon is behind.
      // Inspect WHICH packages changed in buildCommit..HEAD. A daemon rebuild/restart
      // is only actually required when a daemon-runtime package changed; if only web /
      // render packages changed, the daemon is unaffected and just the web deploy is
      // pending. Conservative: any probe failure → treat as daemon-affecting. The
      // verdict is memoized on (repoPath, buildCommit, head, config) to suppress
      // re-evaluation on the hot status path.
      const evalKey = `${repoPath} ${build.commit} ${head} ${configKey}`;
      if (!head) continue; // proven non-empty oid here; every other branch above continued
      let evaluated = changeImpactEvalCache.get(evalKey);
      if (!evaluated) {
        evaluated = await classifyDaemonBuildChange(repoPath, build.commit, options, policy);
        changeImpactEvalCache.set(evalKey, evaluated);
      }
      const { isDaemonAffecting, affectedPackages } = evaluated;
      const kind: ChangeImpactKind = isDaemonAffecting
        ? 'daemon'
        : affectedPackages.length > 0
          ? 'web'
          : 'none';
      const target = policy.impactTargets[kind];
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
        recommendedAction: kind,
        recommendedCommand: target.recommendedCommand,
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

  // C2: throttle the actual network fetch. If we fetched this workspace within
  // GIT_FETCH_THROTTLE_MS, skip the fetch and serve ahead/behind from the local
  // porcelain (re-read fresh every call by the caller). forceFresh callers
  // (convergence-critical: ff / refine) always re-fetch — they need true upstream.
  const now = Date.now();
  const lastFetch = upstreamFetchedAt.get(repo.workspace);
  if (!options.forceFresh && lastFetch !== undefined && now - lastFetch < GIT_FETCH_THROTTLE_MS) {
    return {
      upstreamStatus: 'fresh',
      upstreamFetchedAt: lastFetch,
      didFetch: false,
    };
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
    const fetchedAt = Date.now();
    upstreamFetchedAt.set(repo.workspace, fetchedAt);
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
    const expectedByPath = await readGitlinkExpectedShas(repo, visiblePaths, options);
    const lastCheckedAt = Date.now();
    const headOidByPath = new Map<string, string>();

    const submodules = await Promise.all(
      visiblePaths.map(async (path): Promise<GitSubmoduleStatus> => {
        const repoPath = repo.repoRoot + '/' + path;
        const expected = expectedByPath.get(path) ?? null;
        const worktree = await readSubmoduleWorktreeStatus(repo, repoPath, options);
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
      }),
    );
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
    // paths that are absent or not gitlinks print nothing.
    const result = await runGit(repo, ['ls-tree', '-z', 'HEAD', '--', ...submodulePaths], options);
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
