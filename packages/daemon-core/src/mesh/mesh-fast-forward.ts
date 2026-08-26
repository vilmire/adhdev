import type { GitRepoStatus, GitSubmoduleStatus } from '../git/git-types.js';
import { getGitRepoStatus } from '../git/git-status.js';
import { GitCommandError, runGit } from '../git/git-executor.js';
import { resolveSubmoduleDefaultBranch } from './worktree-bootstrap-config.js';

export interface MeshFastForwardNodeArgs {
  nodeId?: string;
  meshId?: string;
  workspace: string;
  branch?: string;
  execute?: boolean;
  dryRun?: boolean;
  updateSubmodules?: boolean;
  submoduleIgnorePaths?: string[];
  timeoutMs?: number;
  trigger?: 'manual' | 'idle_auto' | string;
  /**
   * Operation mode. 'merge' (default) absorbs upstream commits into the local
   * branch via git merge --ff-only (requires ahead=0, behind>0). 'push' publishes
   * local commits to origin via a strict ff-only push (requires HEAD to be a
   * descendant of origin/<branch>); it never force-pushes, resets, or rebases.
   */
  mode?: 'merge' | 'push';
  /**
   * When mode='push', also fast-forward push submodule (e.g. oss) HEADs to their
   * origin main branch. Gated by allowAutoPublishSubmoduleMainCommits — skipped
   * unless that policy is true. Each submodule must still pass the descendant gate.
   * Defaults false (root push only).
   */
  pushSubmodules?: boolean;
  /**
   * Mesh policy flag mirrored from RepoMeshPolicy.allowAutoPublishSubmoduleMainCommits.
   * Submodule pushes are refused unless this is true.
   */
  allowAutoPublishSubmoduleMainCommits?: boolean;
}

export interface MeshFastForwardPlannedStep {
  operation: 'refresh_upstream' | 'verify_clean_worktree' | 'verify_fast_forward' | 'merge_ff_only'
    | 'submodule_update' | 'verify_post_status' | 'verify_push_descendant' | 'push_ff_only' | 'push_submodules_ff_only';
  description: string;
  safe: true;
  willMutateWorktree: boolean;
}

export interface MeshFastForwardSubmodulePushResult {
  path: string;
  commit?: string;
  remote: string;
  remoteBranch: string;
  pushed: boolean;
  skipped: boolean;
  code: string;
  refspec?: string;
  error?: string;
}

export interface MeshFastForwardResult {
  success: boolean;
  code: string;
  nodeId?: string;
  meshId?: string;
  workspace: string;
  mode: 'merge' | 'push';
  allowed: boolean;
  dryRun: boolean;
  willRun: boolean;
  executed: boolean;
  updateSubmodules: boolean;
  blockingReasons: string[];
  plannedSteps: MeshFastForwardPlannedStep[];
  current?: GitRepoStatus;
  preStatus?: GitRepoStatus;
  postStatus?: GitRepoStatus;
  /** Push target derived from the tracked upstream (mode='push'). */
  pushTarget?: { remote: string; remoteBranch: string; refspec: string };
  /** Submodule ff-only push outcomes (mode='push' with pushSubmodules). */
  submodulePushes?: MeshFastForwardSubmodulePushResult[];
  finalBranchConvergenceState?: Record<string, unknown>;
  operationError?: string;
  ledgerError?: string;
  nextStep?: string;
  trigger?: string;
}

type MeshFastForwardBase = Pick<
  MeshFastForwardResult,
  'workspace' | 'mode' | 'dryRun' | 'updateSubmodules' | 'plannedSteps' | 'trigger'
> & Pick<Partial<MeshFastForwardResult>, 'nodeId' | 'meshId'>;

// forceFresh: fast-forward is a mutating/decision path — its preflight blockers and its
// post-merge re-reads MUST see live git state, never a TTL-cached status from a
// concurrent reconcile/mesh_status probe. It also bypasses the fetch throttle so
// ahead/behind reflects a true upstream at decision time.
const STATUS_OPTIONS = { refreshUpstream: true, includeSubmodules: true, timeoutMs: 15_000, forceFresh: true } as const;

export async function fastForwardMeshNode(args: MeshFastForwardNodeArgs): Promise<MeshFastForwardResult> {
  const workspace = typeof args.workspace === 'string' ? args.workspace.trim() : '';
  const nodeId = normalizeOptionalString(args.nodeId);
  const meshId = normalizeOptionalString(args.meshId);
  const requestedBranch = normalizeOptionalString(args.branch);
  const trigger = normalizeOptionalString(args.trigger) || 'manual';
  const updateSubmodules = args.updateSubmodules === true;
  const dryRun = args.dryRun === true || args.execute !== true;
  const mode: 'merge' | 'push' = args.mode === 'push' ? 'push' : 'merge';
  const pushSubmodules = mode === 'push' && args.pushSubmodules === true;
  const plannedSteps = buildPlannedSteps(mode, updateSubmodules, pushSubmodules);
  const base: MeshFastForwardBase = {
    ...(nodeId ? { nodeId } : {}),
    ...(meshId ? { meshId } : {}),
    workspace,
    mode,
    dryRun,
    updateSubmodules,
    plannedSteps,
    trigger,
  };

  if (!workspace) {
    return block(base, 'invalid_workspace', ['workspace_required']);
  }

  const current = await getGitRepoStatus(workspace, {
    ...STATUS_OPTIONS,
    submoduleIgnorePaths: args.submoduleIgnorePaths,
    timeoutMs: args.timeoutMs ?? STATUS_OPTIONS.timeoutMs,
  });

  if (mode === 'push') {
    return pushMeshNode(base, args, current, {
      pushSubmodules,
      allowAutoPublishSubmoduleMainCommits: args.allowAutoPublishSubmoduleMainCommits === true,
    });
  }

  const earlyBlockers = collectPreflightBlockers(current, requestedBranch, updateSubmodules);
  if (earlyBlockers.length > 0) {
    const blockCode = chooseBlockCode(current, earlyBlockers);
    const result: MeshFastForwardResult = {
      ...block(base, blockCode, earlyBlockers),
      current,
      finalBranchConvergenceState: buildConvergenceState(current, codeToConvergenceStatus(blockCode)),
    };
    // Pure ahead (local commits not yet on origin, nothing to merge in) is not a
    // hard failure — it's a push-needed case. Reclassify so the coordinator can
    // route to push mode without launching an agent session.
    if (blockCode === 'branch_ahead' && current.ahead > 0 && current.behind === 0 && otherBlockersAreOnlyAhead(earlyBlockers)) {
      result.code = 'ahead_needs_push';
      result.nextStep = 'Local branch is ahead of origin with nothing to merge. Re-run mesh_fast_forward_node with mode="push" (execute=true) to ff-only push the local commits to origin.';
    }
    await appendFastForwardLedger(result, 'blocked');
    return result;
  }

  if (current.behind === 0) {
    const result: MeshFastForwardResult = {
      ...base,
      success: true,
      code: 'already_up_to_date',
      allowed: true,
      willRun: false,
      executed: false,
      blockingReasons: [],
      current,
      preStatus: current,
      postStatus: current,
      finalBranchConvergenceState: buildConvergenceState(current, 'up_to_date'),
    };
    await appendFastForwardLedger(result, 'noop');
    return result;
  }

  const ancestorCheck = await verifyHeadIsAncestorOfUpstream(workspace, current.upstream || '', args.timeoutMs);
  if (!ancestorCheck.ok) {
    const result: MeshFastForwardResult = {
      ...block(base, 'non_fast_forward', ['head_is_not_ancestor_of_upstream']),
      current,
      preStatus: current,
      operationError: ancestorCheck.error,
      finalBranchConvergenceState: buildConvergenceState(current, 'not_mergeable'),
    };
    await appendFastForwardLedger(result, 'blocked');
    return result;
  }

  if (dryRun) {
    const result: MeshFastForwardResult = {
      ...base,
      success: true,
      code: 'fast_forward_available',
      allowed: true,
      willRun: false,
      executed: false,
      blockingReasons: [],
      current,
      preStatus: current,
      finalBranchConvergenceState: buildConvergenceState(current, 'fast_forward_available'),
    };
    await appendFastForwardLedger(result, 'dry_run');
    return result;
  }

  try {
    await runGit(workspace, ['merge', '--ff-only', current.upstream || ''], { timeoutMs: args.timeoutMs ?? 30_000 });
  } catch (error) {
    const result: MeshFastForwardResult = {
      ...block(base, 'merge_ff_only_failed', ['merge_ff_only_failed']),
      current,
      preStatus: current,
      operationError: formatGitError(error),
      finalBranchConvergenceState: buildConvergenceState(current, 'not_mergeable'),
    };
    await appendFastForwardLedger(result, 'failed');
    return result;
  }

  let postStatus = await getGitRepoStatus(workspace, {
    ...STATUS_OPTIONS,
    submoduleIgnorePaths: args.submoduleIgnorePaths,
    timeoutMs: args.timeoutMs ?? STATUS_OPTIONS.timeoutMs,
  });

  const submoduleIssues = collectSubmoduleBlockers(postStatus, 'post');
  let submoduleFollowUpRequired = false;
  let operationError: string | undefined;
  if (submoduleIssues.length > 0) {
    if (updateSubmodules) {
      try {
        await runGit(workspace, ['submodule', 'update', '--init', '--recursive'], { timeoutMs: args.timeoutMs ?? 60_000 });
        postStatus = await getGitRepoStatus(workspace, {
          ...STATUS_OPTIONS,
          submoduleIgnorePaths: args.submoduleIgnorePaths,
          timeoutMs: args.timeoutMs ?? STATUS_OPTIONS.timeoutMs,
        });
      } catch (error) {
        operationError = formatGitError(error);
      }
    } else {
      submoduleFollowUpRequired = true;
    }
  }

  const postBlockers = collectPostExecutionBlockers(postStatus);
  if (operationError) postBlockers.push('submodule_update_failed');
  if (submoduleFollowUpRequired) postBlockers.push('submodule_update_required');

  const success = postBlockers.length === 0 || submoduleFollowUpRequired;
  const code = postBlockers.length === 0
    ? 'fast_forward_applied'
    : submoduleFollowUpRequired
      ? 'fast_forward_applied_submodule_update_required'
      : 'post_verify_failed';
  const result: MeshFastForwardResult = {
    ...base,
    success,
    code,
    allowed: true,
    willRun: true,
    executed: true,
    blockingReasons: postBlockers,
    current,
    preStatus: current,
    postStatus,
    ...(operationError ? { operationError } : {}),
    finalBranchConvergenceState: buildConvergenceState(
      postStatus,
      postBlockers.length === 0 ? 'fast_forwarded' : submoduleFollowUpRequired ? 'follow_up_required' : 'post_verify_failed',
    ),
  };
  await appendFastForwardLedger(result, success ? 'executed' : 'failed');
  return result;
}

interface PushOptions {
  pushSubmodules: boolean;
  allowAutoPublishSubmoduleMainCommits: boolean;
}

/**
 * Strict ff-only push of a node's local commits to origin/<branch>. Only proceeds
 * when HEAD is a descendant of origin/<branch> (origin/<branch> is an ancestor of
 * HEAD). Never force-pushes, resets, rebases, cleans, or checks out. Optionally
 * ff-only pushes submodule HEADs to their origin main when policy allows.
 */
async function pushMeshNode(
  base: MeshFastForwardBase,
  args: MeshFastForwardNodeArgs,
  current: GitRepoStatus,
  options: PushOptions,
): Promise<MeshFastForwardResult> {
  const workspace = base.workspace;
  const requestedBranch = normalizeOptionalString(args.branch);
  const dryRun = base.dryRun;

  const blockers = collectPushPreflightBlockers(current, requestedBranch);
  if (blockers.length > 0) {
    const code = choosePushBlockCode(current, blockers);
    const result: MeshFastForwardResult = {
      ...block(base, code, blockers),
      current,
      preStatus: current,
      finalBranchConvergenceState: buildConvergenceState(current, codeToConvergenceStatus(code)),
    };
    await appendFastForwardLedger(result, 'blocked');
    return result;
  }

  const target = parseUpstreamTarget(current.upstream || '');
  if (!target) {
    const result: MeshFastForwardResult = {
      ...block(base, 'upstream_unparseable', ['upstream_unparseable']),
      current,
      preStatus: current,
      finalBranchConvergenceState: buildConvergenceState(current, 'blocked'),
    };
    await appendFastForwardLedger(result, 'blocked');
    return result;
  }
  const refspec = `HEAD:refs/heads/${target.remoteBranch}`;
  const pushTarget = { remote: target.remote, remoteBranch: target.remoteBranch, refspec };

  if (current.ahead <= 0) {
    // Nothing local to publish.
    const result: MeshFastForwardResult = {
      ...base,
      success: true,
      code: 'nothing_to_push',
      allowed: true,
      willRun: false,
      executed: false,
      blockingReasons: [],
      current,
      preStatus: current,
      postStatus: current,
      pushTarget,
      finalBranchConvergenceState: buildConvergenceState(current, 'up_to_date'),
    };
    await appendFastForwardLedger(result, 'noop');
    return result;
  }

  // Strict ff-only gate: origin/<branch> must be an ancestor of HEAD.
  const descendant = await verifyUpstreamIsAncestorOfHead(workspace, current.upstream || '', args.timeoutMs);
  if (!descendant.ok) {
    const result: MeshFastForwardResult = {
      ...block(base, 'non_fast_forward_push', ['head_is_not_descendant_of_upstream']),
      current,
      preStatus: current,
      pushTarget,
      operationError: descendant.error,
      nextStep: 'origin/<branch> has commits not in local HEAD; a ff-only push would lose them. Converge by rebasing onto origin first, then re-run. This operation never force-pushes.',
      finalBranchConvergenceState: buildConvergenceState(current, 'not_mergeable'),
    };
    await appendFastForwardLedger(result, 'blocked');
    return result;
  }

  if (dryRun) {
    const result: MeshFastForwardResult = {
      ...base,
      success: true,
      code: 'push_available',
      allowed: true,
      willRun: false,
      executed: false,
      blockingReasons: [],
      current,
      preStatus: current,
      pushTarget,
      ...(options.pushSubmodules ? { submodulePushes: await planSubmodulePushes(current, options, args.timeoutMs) } : {}),
      finalBranchConvergenceState: buildConvergenceState(current, 'push_available'),
    };
    await appendFastForwardLedger(result, 'dry_run');
    return result;
  }

  // Execute the root ff-only push.
  try {
    await runGit(workspace, ['push', target.remote, refspec], { timeoutMs: args.timeoutMs ?? 30_000 });
  } catch (error) {
    const result: MeshFastForwardResult = {
      ...block(base, 'push_ff_only_failed', ['push_ff_only_failed']),
      current,
      preStatus: current,
      pushTarget,
      operationError: formatGitError(error),
      finalBranchConvergenceState: buildConvergenceState(current, 'not_mergeable'),
    };
    await appendFastForwardLedger(result, 'failed');
    return result;
  }

  let submodulePushes: MeshFastForwardSubmodulePushResult[] | undefined;
  if (options.pushSubmodules) {
    submodulePushes = await executeSubmodulePushes(current, options, args.timeoutMs);
  }

  const postStatus = await getGitRepoStatus(workspace, {
    ...STATUS_OPTIONS,
    submoduleIgnorePaths: args.submoduleIgnorePaths,
    timeoutMs: args.timeoutMs ?? STATUS_OPTIONS.timeoutMs,
  });

  const submodulePushFailed = (submodulePushes || []).some((entry) => !entry.pushed && !entry.skipped);
  const blockingReasons: string[] = [];
  if (postStatus.ahead !== 0) blockingReasons.push('post_branch_ahead');
  if (submodulePushFailed) blockingReasons.push('submodule_push_failed');

  const success = blockingReasons.length === 0;
  const code = success
    ? 'push_applied'
    : submodulePushFailed && postStatus.ahead === 0
      ? 'push_applied_submodule_push_failed'
      : 'post_push_verify_failed';
  const result: MeshFastForwardResult = {
    ...base,
    success,
    code,
    allowed: true,
    willRun: true,
    executed: true,
    blockingReasons,
    current,
    preStatus: current,
    postStatus,
    pushTarget,
    ...(submodulePushes ? { submodulePushes } : {}),
    finalBranchConvergenceState: buildConvergenceState(postStatus, success ? 'pushed' : 'post_verify_failed'),
  };
  await appendFastForwardLedger(result, success ? 'executed' : 'failed');
  return result;
}

function collectPushPreflightBlockers(status: GitRepoStatus, requestedBranch?: string): string[] {
  const blockers: string[] = [];
  if (!status.isGitRepo) blockers.push('not_git_repo');
  if (!status.branch) blockers.push('detached_head_or_unknown_branch');
  if (requestedBranch && status.branch !== requestedBranch) blockers.push('branch_mismatch');
  if (!status.upstream) blockers.push('upstream_missing');
  if (status.upstreamStatus !== 'fresh') blockers.push('upstream_not_fresh');
  if (status.hasConflicts) blockers.push('conflicts_present');
  if (status.staged > 0) blockers.push('staged_changes_present');
  if (status.modified > 0) blockers.push('modified_changes_present');
  if (status.untracked > 0) blockers.push('untracked_changes_present');
  if (status.deleted > 0) blockers.push('deleted_changes_present');
  if (status.renamed > 0) blockers.push('renamed_changes_present');
  if (status.stashCount > 0) blockers.push('stash_entries_present');
  // A diverged branch (ahead>0 AND behind>0) cannot ff-only push: origin has
  // commits not in HEAD. The descendant gate also catches this, but flagging it
  // in preflight gives a clearer code.
  if (status.ahead > 0 && status.behind > 0) blockers.push('branch_diverged_from_upstream');
  else if (status.behind > 0) blockers.push('branch_behind_upstream');
  return blockers;
}

function choosePushBlockCode(status: GitRepoStatus, blockers: string[]): string {
  if (blockers.includes('not_git_repo')) return 'not_git_repo';
  if (blockers.includes('branch_mismatch')) return 'branch_mismatch';
  if (blockers.includes('upstream_missing')) return 'upstream_missing';
  if (blockers.includes('upstream_not_fresh')) return 'upstream_not_fresh';
  if (blockers.includes('branch_diverged_from_upstream')) return 'branch_diverged';
  if (blockers.includes('branch_behind_upstream')) return 'non_fast_forward_push';
  if (blockers.some((reason) => reason.includes('changes') || reason.includes('conflicts') || reason.includes('stash'))) return 'dirty_worktree';
  return 'preflight_blocked';
}

/** Parse an upstream ref like "origin/main" into { remote, remoteBranch }. */
function parseUpstreamTarget(upstream: string): { remote: string; remoteBranch: string } | null {
  const trimmed = upstream.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash >= trimmed.length - 1) return null;
  return { remote: trimmed.slice(0, slash), remoteBranch: trimmed.slice(slash + 1) };
}

async function verifyUpstreamIsAncestorOfHead(workspace: string, upstream: string, timeoutMs?: number): Promise<{ ok: boolean; error?: string }> {
  if (!upstream) return { ok: false, error: 'missing upstream' };
  try {
    await runGit(workspace, ['merge-base', '--is-ancestor', upstream, 'HEAD'], { timeoutMs: timeoutMs ?? 15_000 });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: formatGitError(error) };
  }
}

/** Dry-run plan for submodule pushes: classify each as would-push / skipped / blocked. */
async function planSubmodulePushes(status: GitRepoStatus, options: PushOptions, timeoutMs?: number): Promise<MeshFastForwardSubmodulePushResult[]> {
  return resolveSubmodulePushes(status, options, false, timeoutMs);
}

async function executeSubmodulePushes(status: GitRepoStatus, options: PushOptions, timeoutMs?: number): Promise<MeshFastForwardSubmodulePushResult[]> {
  return resolveSubmodulePushes(status, options, true, timeoutMs);
}

async function resolveSubmodulePushes(
  status: GitRepoStatus,
  options: PushOptions,
  execute: boolean,
  timeoutMs?: number,
): Promise<MeshFastForwardSubmodulePushResult[]> {
  const submodules = Array.isArray(status.submodules) ? status.submodules : [];
  const results: MeshFastForwardSubmodulePushResult[] = [];
  for (const submodule of submodules) {
    const base: MeshFastForwardSubmodulePushResult = {
      path: submodule.path,
      commit: submodule.commit,
      remote: 'origin',
      remoteBranch: 'main',
      pushed: false,
      skipped: true,
      code: 'submodule_push_skipped',
    };
    if (!options.allowAutoPublishSubmoduleMainCommits) {
      results.push({ ...base, code: 'submodule_push_policy_disabled', error: 'allowAutoPublishSubmoduleMainCommits is not enabled' });
      continue;
    }
    if (submodule.error || submodule.dirty) {
      results.push({ ...base, code: 'submodule_not_clean', error: submodule.error || 'submodule worktree is dirty' });
      continue;
    }
    const repoPath = submodule.repoPath;
    if (!repoPath || !submodule.commit) {
      results.push({ ...base, code: 'submodule_status_incomplete' });
      continue;
    }
    // Generalize the submodule's default branch (F18): '.gitmodules' branch →
    // local remote HEAD → remote-advertised HEAD → 'main'. On a main-default
    // submodule this resolves to 'main', keeping every ref below byte-identical.
    const remoteBranch = await resolveSubmoduleDefaultBranch({
      submoduleRepoPath: repoPath,
      superprojectWorkspace: status.repoRoot ?? status.workspace,
      submodulePath: submodule.path,
      timeoutMs,
    });
    base.remoteBranch = remoteBranch;
    const remoteRef = `refs/remotes/origin/${remoteBranch}`;
    const fetchRefspec = `refs/heads/${remoteBranch}:${remoteRef}`;
    // Refresh the submodule's origin/<branch>, then require it to be an ancestor of
    // the gitlink commit (strict ff-only).
    try {
      await runGit(repoPath, ['-c', 'protocol.file.allow=always', 'fetch', 'origin', fetchRefspec], { timeoutMs: timeoutMs ?? 30_000 });
    } catch (error) {
      results.push({ ...base, code: 'submodule_fetch_failed', error: formatGitError(error) });
      continue;
    }
    let alreadyReachable = false;
    try {
      await runGit(repoPath, ['merge-base', '--is-ancestor', submodule.commit, remoteRef], { timeoutMs: timeoutMs ?? 15_000 });
      alreadyReachable = true;
    } catch { /* not yet on origin/<branch> — candidate for push */ }
    if (alreadyReachable) {
      results.push({ ...base, pushed: false, skipped: true, code: 'submodule_already_reachable' });
      continue;
    }
    // Strict ff-only: origin/<branch> must be an ancestor of the commit we publish.
    try {
      await runGit(repoPath, ['merge-base', '--is-ancestor', remoteRef, submodule.commit], { timeoutMs: timeoutMs ?? 15_000 });
    } catch (error) {
      results.push({ ...base, pushed: false, skipped: false, code: 'submodule_non_fast_forward', error: formatGitError(error) });
      continue;
    }
    const refspec = `${submodule.commit}:refs/heads/${remoteBranch}`;
    if (!execute) {
      results.push({ ...base, pushed: false, skipped: false, code: 'submodule_push_available', refspec });
      continue;
    }
    try {
      await runGit(repoPath, ['push', 'origin', refspec], { timeoutMs: timeoutMs ?? 30_000 });
      // Verify reachability after the push.
      await runGit(repoPath, ['-c', 'protocol.file.allow=always', 'fetch', 'origin', fetchRefspec], { timeoutMs: timeoutMs ?? 30_000 });
      await runGit(repoPath, ['merge-base', '--is-ancestor', submodule.commit, remoteRef], { timeoutMs: timeoutMs ?? 15_000 });
      results.push({ ...base, pushed: true, skipped: false, code: 'submodule_pushed', refspec });
    } catch (error) {
      results.push({ ...base, pushed: false, skipped: false, code: 'submodule_push_failed', refspec, error: formatGitError(error) });
    }
  }
  return results;
}

function buildPlannedSteps(mode: 'merge' | 'push', updateSubmodules: boolean, pushSubmodules: boolean): MeshFastForwardPlannedStep[] {
  const steps: MeshFastForwardPlannedStep[] = [
    {
      operation: 'refresh_upstream',
      description: 'Refresh the tracked upstream remote ref before trusting ahead/behind state.',
      safe: true,
      willMutateWorktree: false,
    },
    {
      operation: 'verify_clean_worktree',
      description: 'Require clean staged/modified/untracked/deleted/renamed/conflict/stash/submodule state.',
      safe: true,
      willMutateWorktree: false,
    },
  ];
  if (mode === 'push') {
    steps.push({
      operation: 'verify_push_descendant',
      description: 'Require HEAD to be a descendant of origin/<branch> (origin/<branch> is an ancestor of HEAD); refuse any non-fast-forward push.',
      safe: true,
      willMutateWorktree: false,
    });
    steps.push({
      operation: 'push_ff_only',
      description: 'Run git push origin HEAD:<branch> as a strict ff-only push; never --force, --force-with-lease, reset, or rebase. Does not mutate the worktree.',
      safe: true,
      willMutateWorktree: false,
    });
    if (pushSubmodules) {
      steps.push({
        operation: 'push_submodules_ff_only',
        description: 'For each submodule, if allowAutoPublishSubmoduleMainCommits is enabled and the submodule HEAD is a descendant of its origin main, ff-only push it to submodule origin main; otherwise skip.',
        safe: true,
        willMutateWorktree: false,
      });
    }
    steps.push({
      operation: 'verify_post_status',
      description: 'Re-read daemon-owned git status and report final branch convergence state.',
      safe: true,
      willMutateWorktree: false,
    });
    return steps;
  }
  steps.push({
    operation: 'verify_fast_forward',
    description: 'Require ahead=0, behind>0, and HEAD to be an ancestor of the upstream ref.',
    safe: true,
    willMutateWorktree: false,
  });
  steps.push({
    operation: 'merge_ff_only',
    description: 'Apply git merge --ff-only against the tracked upstream; no force, reset, rebase, push, or deploy.',
    safe: true,
    willMutateWorktree: true,
  });
  if (updateSubmodules) {
    steps.push({
      operation: 'submodule_update',
      description: 'If the fast-forward changes gitlinks, run git submodule update --init --recursive and re-verify submodules.',
      safe: true,
      willMutateWorktree: true,
    });
  }
  steps.push({
    operation: 'verify_post_status',
    description: 'Re-read daemon-owned git status and report final branch convergence state.',
    safe: true,
    willMutateWorktree: false,
  });
  return steps;
}

/**
 * True when every preflight blocker is attributable purely to the branch being
 * ahead of its upstream (local commits not yet pushed) — i.e. nothing dirty,
 * diverged, or submodule-broken. Used to reclassify branch_ahead → ahead_needs_push.
 */
function otherBlockersAreOnlyAhead(blockers: string[]): boolean {
  const aheadOnly = new Set(['branch_has_local_commits']);
  return blockers.every((reason) => aheadOnly.has(reason));
}

function collectPreflightBlockers(status: GitRepoStatus, requestedBranch?: string, updateSubmodules?: boolean): string[] {
  const blockers: string[] = [];
  if (!status.isGitRepo) blockers.push('not_git_repo');
  if (!status.branch) blockers.push('detached_head_or_unknown_branch');
  if (requestedBranch && status.branch !== requestedBranch) blockers.push('branch_mismatch');
  if (!status.upstream) blockers.push('upstream_missing');
  if (status.upstreamStatus !== 'fresh') blockers.push('upstream_not_fresh');
  if (status.hasConflicts) blockers.push('conflicts_present');
  if (status.staged > 0) blockers.push('staged_changes_present');
  // A submodule whose checked-out commit differs from the recorded gitlink shows up as
  // its own `M` entry in the ROOT's `git status --porcelain`, on top of the per-submodule
  // outOfSync flag collectSubmoduleBlockers checks below — the same drift double-counts
  // across both signals. When updateSubmodules:true is set (the post-merge update step
  // will resolve the drift in this same cycle), subtract one from `modified` for each
  // submodule that is purely out-of-sync (not dirty, not errored) before deciding whether
  // real file modifications remain. A genuinely dirty submodule's `M` entry is NOT
  // subtracted — collectSubmoduleBlockers already hard-blocks that case unconditionally.
  const tolerateGitlinkDriftAlone = updateSubmodules === true;
  const pureDriftSubmoduleCount = tolerateGitlinkDriftAlone
    ? (Array.isArray(status.submodules) ? status.submodules : []).filter(
        (submodule) => submodule.outOfSync && !submodule.dirty && !submodule.error,
      ).length
    : 0;
  if (status.modified - pureDriftSubmoduleCount > 0) blockers.push('modified_changes_present');
  if (status.untracked > 0) blockers.push('untracked_changes_present');
  if (status.deleted > 0) blockers.push('deleted_changes_present');
  if (status.renamed > 0) blockers.push('renamed_changes_present');
  if (status.stashCount > 0) blockers.push('stash_entries_present');
  // Pure gitlink drift (submodule working tree clean, only checked-out commit differs
  // from what the parent tree records) is NOT a hard preflight blocker when the caller
  // has opted into updateSubmodules:true — the post-merge submodule update step below
  // resolves it in the same cycle. A genuinely dirty or errored submodule still blocks
  // unconditionally; only the 'outOfSync-alone' case is relaxed, and only pre-merge.
  blockers.push(...collectSubmoduleBlockers(status, 'pre', tolerateGitlinkDriftAlone));
  if (status.ahead > 0 && status.behind > 0) {
    blockers.push('branch_diverged_from_upstream');
    blockers.push('branch_has_local_commits');
  } else if (status.ahead > 0) blockers.push('branch_has_local_commits');
  return blockers;
}

function collectPostExecutionBlockers(status: GitRepoStatus): string[] {
  const blockers: string[] = [];
  if (!status.isGitRepo) blockers.push('post_not_git_repo');
  if (status.hasConflicts) blockers.push('post_conflicts_present');
  if (status.ahead !== 0) blockers.push('post_branch_ahead');
  if (status.behind !== 0) blockers.push('post_branch_still_behind');
  if (status.staged > 0 || status.modified > 0 || status.untracked > 0 || status.deleted > 0 || status.renamed > 0) {
    blockers.push('post_working_tree_not_clean');
  }
  if (status.stashCount > 0) blockers.push('post_stash_entries_present');
  blockers.push(...collectSubmoduleBlockers(status, 'post'));
  return blockers;
}

function collectSubmoduleBlockers(status: GitRepoStatus, phase: 'pre' | 'post', tolerateGitlinkDriftAlone = false): string[] {
  const submodules = Array.isArray(status.submodules) ? status.submodules : [];
  const blockers: string[] = [];
  for (const submodule of submodules) {
    if (submodule.error) blockers.push(`${phase}_submodule_status_error:${submodule.path}`);
    if (submodule.dirty) blockers.push(`${phase}_submodule_dirty:${submodule.path}`);
    // outOfSync-alone (clean working tree, checked-out commit merely differs from the
    // gitlink) is tolerated at the pre-merge phase when the caller will run
    // `git submodule update --init --recursive` right after — see collectPreflightBlockers.
    const outOfSyncIsToleratedDrift = tolerateGitlinkDriftAlone && submodule.outOfSync && !submodule.dirty && !submodule.error;
    if (submodule.outOfSync && !outOfSyncIsToleratedDrift) blockers.push(`${phase}_submodule_out_of_sync:${submodule.path}`);
  }
  return blockers;
}

function chooseBlockCode(status: GitRepoStatus, blockers: string[]): string {
  if (blockers.includes('not_git_repo')) return 'not_git_repo';
  if (blockers.includes('branch_mismatch')) return 'branch_mismatch';
  if (blockers.includes('upstream_missing')) return 'upstream_missing';
  if (blockers.includes('upstream_not_fresh')) return 'upstream_not_fresh';
  if (blockers.some((reason) => reason.includes('submodule'))) return 'submodule_not_clean';
  if (blockers.includes('branch_diverged_from_upstream')) return 'branch_diverged';
  if (blockers.includes('branch_has_local_commits') || status.ahead > 0) return 'branch_ahead';
  if (blockers.some((reason) => reason.includes('changes') || reason.includes('conflicts') || reason.includes('stash'))) return 'dirty_worktree';
  return 'preflight_blocked';
}

function codeToConvergenceStatus(code: string): string {
  if (code === 'branch_diverged' || code === 'branch_ahead' || code === 'non_fast_forward'
    || code === 'non_fast_forward_push' || code === 'upstream_unparseable') return 'not_mergeable';
  if (code === 'dirty_worktree' || code === 'submodule_not_clean') return 'blocked_review';
  return 'blocked';
}

async function verifyHeadIsAncestorOfUpstream(workspace: string, upstream: string, timeoutMs?: number): Promise<{ ok: boolean; error?: string }> {
  if (!upstream) return { ok: false, error: 'missing upstream' };
  try {
    await runGit(workspace, ['merge-base', '--is-ancestor', 'HEAD', upstream], { timeoutMs: timeoutMs ?? 15_000 });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: formatGitError(error) };
  }
}

function block(
  base: MeshFastForwardBase,
  code: string,
  blockingReasons: string[],
): MeshFastForwardResult {
  const normalizedReasons = normalizeBlockingReasons(blockingReasons);
  return {
    ...base,
    success: false,
    code,
    allowed: false,
    willRun: false,
    executed: false,
    blockingReasons: normalizedReasons,
  };
}

function normalizeBlockingReasons(reasons: string[]): string[] {
  const normalized = new Set<string>();
  for (const reason of reasons) {
    normalized.add(reason);
  }
  if ([
    'conflicts_present',
    'staged_changes_present',
    'modified_changes_present',
    'untracked_changes_present',
    'deleted_changes_present',
    'renamed_changes_present',
  ].some((reason) => normalized.has(reason))) {
    normalized.add('working_tree_not_clean');
  }
  return Array.from(normalized);
}

function buildConvergenceState(status: GitRepoStatus, convergenceStatus: string): Record<string, unknown> {
  return {
    status: convergenceStatus,
    branch: status.branch,
    headCommit: status.headCommit,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    dirty: status.staged + status.modified + status.untracked + status.deleted + status.renamed > 0 || status.hasConflicts,
    stashCount: status.stashCount,
    submodules: summarizeSubmodules(status.submodules),
  };
}

function summarizeSubmodules(submodules: GitSubmoduleStatus[] | undefined): Array<Record<string, unknown>> {
  return (submodules || []).map((submodule) => ({
    path: submodule.path,
    commit: submodule.commit,
    dirty: submodule.dirty,
    outOfSync: submodule.outOfSync,
    ...(submodule.error ? { error: submodule.error } : {}),
  }));
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function formatGitError(error: unknown): string {
  if (error instanceof GitCommandError) {
    return error.stderr || error.stdout || error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

async function appendFastForwardLedger(result: MeshFastForwardResult, outcome: 'noop' | 'blocked' | 'dry_run' | 'executed' | 'failed'): Promise<void> {
  if (!result.meshId) return;
  try {
    const { appendLedgerEntry } = await import('./mesh-ledger.js');
    appendLedgerEntry(result.meshId, {
      kind: 'direct_fast_forward',
      ...(result.nodeId ? { nodeId: result.nodeId } : {}),
      payload: {
        operation: 'mesh_fast_forward_node',
        mode: result.mode,
        trigger: result.trigger || 'manual',
        outcome,
        code: result.code,
        workspace: result.workspace,
        allowed: result.allowed,
        dryRun: result.dryRun,
        willRun: result.willRun,
        executed: result.executed,
        branch: result.postStatus?.branch ?? result.current?.branch,
        upstream: result.postStatus?.upstream ?? result.current?.upstream,
        ...(result.pushTarget ? { pushTarget: result.pushTarget } : {}),
        before: result.current ? {
          headCommit: result.current.headCommit,
          ahead: result.current.ahead,
          behind: result.current.behind,
        } : undefined,
        after: result.postStatus ? {
          headCommit: result.postStatus.headCommit,
          ahead: result.postStatus.ahead,
          behind: result.postStatus.behind,
        } : undefined,
        ...(result.submodulePushes ? {
          submodulePushes: result.submodulePushes.map((entry) => ({
            path: entry.path,
            commit: entry.commit,
            pushed: entry.pushed,
            skipped: entry.skipped,
            code: entry.code,
            ...(entry.refspec ? { refspec: entry.refspec } : {}),
          })),
        } : {}),
        blockingReasons: result.blockingReasons,
      },
    });
  } catch (error) {
    result.ledgerError = error instanceof Error ? error.message : String(error);
  }
}
