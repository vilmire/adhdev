import type { GitRepoStatus, GitSubmoduleStatus } from '../git/git-types.js';
import { getGitRepoStatus } from '../git/git-status.js';
import { GitCommandError, runGit } from '../git/git-executor.js';

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
}

export interface MeshFastForwardPlannedStep {
  operation: 'refresh_upstream' | 'verify_clean_worktree' | 'verify_fast_forward' | 'merge_ff_only' | 'submodule_update' | 'verify_post_status';
  description: string;
  safe: true;
  willMutateWorktree: boolean;
}

export interface MeshFastForwardResult {
  success: boolean;
  code: string;
  nodeId?: string;
  meshId?: string;
  workspace: string;
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
  finalBranchConvergenceState?: Record<string, unknown>;
  operationError?: string;
  ledgerError?: string;
}

type MeshFastForwardBase = Pick<
  MeshFastForwardResult,
  'workspace' | 'dryRun' | 'updateSubmodules' | 'plannedSteps'
> & Pick<Partial<MeshFastForwardResult>, 'nodeId' | 'meshId'>;

const STATUS_OPTIONS = { refreshUpstream: true, includeSubmodules: true, timeoutMs: 15_000 } as const;

export async function fastForwardMeshNode(args: MeshFastForwardNodeArgs): Promise<MeshFastForwardResult> {
  const workspace = typeof args.workspace === 'string' ? args.workspace.trim() : '';
  const nodeId = normalizeOptionalString(args.nodeId);
  const meshId = normalizeOptionalString(args.meshId);
  const requestedBranch = normalizeOptionalString(args.branch);
  const updateSubmodules = args.updateSubmodules === true;
  const dryRun = args.dryRun === true || args.execute !== true;
  const plannedSteps = buildPlannedSteps(updateSubmodules);
  const base: MeshFastForwardBase = {
    ...(nodeId ? { nodeId } : {}),
    ...(meshId ? { meshId } : {}),
    workspace,
    dryRun,
    updateSubmodules,
    plannedSteps,
  };

  if (!workspace) {
    return block(base, 'invalid_workspace', ['workspace_required']);
  }

  const current = await getGitRepoStatus(workspace, {
    ...STATUS_OPTIONS,
    submoduleIgnorePaths: args.submoduleIgnorePaths,
    timeoutMs: args.timeoutMs ?? STATUS_OPTIONS.timeoutMs,
  });

  const earlyBlockers = collectPreflightBlockers(current, requestedBranch);
  if (earlyBlockers.length > 0) {
    return {
      ...block(base, chooseBlockCode(current, earlyBlockers), earlyBlockers),
      current,
      finalBranchConvergenceState: buildConvergenceState(current, codeToConvergenceStatus(chooseBlockCode(current, earlyBlockers))),
    };
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

function buildPlannedSteps(updateSubmodules: boolean): MeshFastForwardPlannedStep[] {
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
    {
      operation: 'verify_fast_forward',
      description: 'Require ahead=0, behind>0, and HEAD to be an ancestor of the upstream ref.',
      safe: true,
      willMutateWorktree: false,
    },
    {
      operation: 'merge_ff_only',
      description: 'Apply git merge --ff-only against the tracked upstream; no force, reset, rebase, push, or deploy.',
      safe: true,
      willMutateWorktree: true,
    },
  ];
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

function collectPreflightBlockers(status: GitRepoStatus, requestedBranch?: string): string[] {
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
  blockers.push(...collectSubmoduleBlockers(status, 'pre'));
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

function collectSubmoduleBlockers(status: GitRepoStatus, phase: 'pre' | 'post'): string[] {
  const submodules = Array.isArray(status.submodules) ? status.submodules : [];
  const blockers: string[] = [];
  for (const submodule of submodules) {
    if (submodule.error) blockers.push(`${phase}_submodule_status_error:${submodule.path}`);
    if (submodule.dirty) blockers.push(`${phase}_submodule_dirty:${submodule.path}`);
    if (submodule.outOfSync) blockers.push(`${phase}_submodule_out_of_sync:${submodule.path}`);
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
  if (code === 'branch_diverged' || code === 'branch_ahead' || code === 'non_fast_forward') return 'not_mergeable';
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

async function appendFastForwardLedger(result: MeshFastForwardResult, outcome: 'noop' | 'blocked' | 'executed' | 'failed'): Promise<void> {
  if (!result.meshId) return;
  try {
    const { appendLedgerEntry } = await import('./mesh-ledger.js');
    appendLedgerEntry(result.meshId, {
      kind: 'direct_fast_forward',
      ...(result.nodeId ? { nodeId: result.nodeId } : {}),
      payload: {
        operation: 'mesh_fast_forward_node',
        outcome,
        code: result.code,
        workspace: result.workspace,
        allowed: result.allowed,
        dryRun: result.dryRun,
        willRun: result.willRun,
        executed: result.executed,
        branch: result.postStatus?.branch ?? result.current?.branch,
        upstream: result.postStatus?.upstream ?? result.current?.upstream,
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
        blockingReasons: result.blockingReasons,
      },
    });
  } catch (error) {
    result.ledgerError = error instanceof Error ? error.message : String(error);
  }
}
