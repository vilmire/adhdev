/**
 * ADHDev Git surface types.
 *
 * Runtime-free type definitions shared by daemon-core, cloud/standalone
 * transports, and web-core. Git state is daemon-owned product truth; do not
 * infer these values from agent transcripts in frontend code.
 */

export type GitFailureReason =
  | 'not_git_repo'
  | 'git_not_installed'
  | 'timeout'
  | 'path_outside_repo'
  | 'dirty_index_required'
  | 'conflict'
  | 'invalid_args'
  | 'nothing_to_commit'
  | 'git_command_failed';

export interface GitRepoIdentity {
  workspace: string;
  repoRoot: string | null;
  isGitRepo: boolean;
}

export interface GitSubmoduleStatus {
  /** Submodule path relative to repo root */
  path: string;
  /** Current commit SHA the submodule is at */
  commit: string;
  /** Path to the submodule repo (absolute) */
  repoPath: string;
  /** Whether the submodule has uncommitted changes */
  dirty: boolean;
  /** Whether the submodule commit differs from what the parent repo expects */
  outOfSync: boolean;
  /** Last checked timestamp */
  lastCheckedAt: number;
  /** Error message if submodule status could not be read */
  error?: string;
}

export type GitUpstreamFreshness = 'fresh' | 'unchecked' | 'stale' | 'no_upstream' | 'unavailable';

export interface GitRepoStatus extends GitRepoIdentity {
  branch: string | null;
  headCommit: string | null;
  headMessage: string | null;
  upstream: string | null;
  /** Whether ahead/behind was verified against a freshly fetched upstream ref. */
  upstreamStatus: GitUpstreamFreshness;
  /** Timestamp for the fetch that refreshed upstream refs when upstreamStatus === 'fresh'. */
  upstreamFetchedAt?: number;
  /** Error from the last refresh attempt when upstreamStatus === 'stale'. */
  upstreamFetchError?: string;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  deleted: number;
  renamed: number;
  /** Aggregate dirty flag including root worktree changes, conflicts, stash, and submodule drift. */
  dirty: boolean;
  hasConflicts: boolean;
  conflictFiles: string[];
  stashCount: number;
  lastCheckedAt: number;
  /** Submodule statuses when auto-discover is enabled */
  submodules?: GitSubmoduleStatus[];
  /**
   * Set when the running daemon's build commit is a STRICT ancestor of this
   * repo's HEAD (or a submodule HEAD) — i.e. the live daemon predates committed
   * code in this workspace and is awaiting a deploy/restart to catch up.
   * Omitted entirely when no staleness is provable (unknown build, commit not
   * present in repo, or build commit == HEAD) to avoid over-warning.
   */
  daemonBuildBehind?: DaemonBuildBehind;
  error?: string;
  reason?: GitFailureReason;
}

export interface DaemonBuildBehind {
  /** Full build commit baked into the running daemon. */
  buildCommit: string;
  /** Short build commit. */
  buildCommitShort: string;
  /** HEAD commit the build commit is behind (repo or submodule). */
  head: string;
  /** Where the comparison matched: 'root' or the submodule path. */
  scope: string;
  warning: string;
}

export type GitFileChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflict';

export interface GitFileChange {
  path: string;
  oldPath?: string;
  status: GitFileChangeStatus;
  staged: boolean;
  insertions: number;
  deletions: number;
  binary?: boolean;
  truncated?: boolean;
}

export interface GitDiffSummary extends GitRepoIdentity {
  files: GitFileChange[];
  totalInsertions: number;
  totalDeletions: number;
  truncated: boolean;
  lastCheckedAt: number;
  error?: string;
  reason?: GitFailureReason;
}

export type GitSnapshotReason =
  | 'session_baseline'
  | 'before_user_input_dispatch'
  | 'before_agent_work'
  | 'after_agent_work'
  | 'manual';

export interface GitSnapshot {
  id: string;
  workspace: string;
  repoRoot: string;
  sessionId?: string;
  turnId?: string;
  reason: GitSnapshotReason;
  status: GitRepoStatus;
  diffSummary: GitDiffSummary;
  createdAt: number;
}

export interface GitSnapshotCompareSummary {
  beforeSnapshotId: string;
  afterSnapshotId: string;
  workspace: string;
  repoRoot: string;
  changedFiles: number;
  addedFiles: string[];
  modifiedFiles: string[];
  deletedFiles: string[];
  renamedFiles: Array<{ oldPath: string; path: string }>;
  untrackedFiles: string[];
  conflictFiles: string[];
  totalInsertions: number;
  totalDeletions: number;
  hasConflicts: boolean;
  currentStatus: GitRepoStatus;
  summaryText: string;
}

export interface GitCompactSummary {
  isGitRepo: boolean;
  repoRoot: string | null;
  branch: string | null;
  upstreamStatus: GitUpstreamFreshness;
  upstreamFetchedAt?: number;
  upstreamFetchError?: string;
  dirty: boolean;
  changedFiles: number;
  ahead: number;
  behind: number;
  hasConflicts: boolean;
  lastCheckedAt: number;
  error?: string;
  reason?: GitFailureReason;
}

export interface WorkspaceGitSubscriptionParams {
  workspace: string;
  includeDiffSummary?: boolean;
  intervalMs?: number;
}

export interface GitWorkspaceUpdate {
  topic: 'workspace.git';
  key: string;
  workspace: string;
  status: GitRepoStatus;
  diffSummary?: GitDiffSummary;
  seq: number;
  timestamp: number;
}

export type GitCommandName =
  | 'git_status'
  | 'git_diff_summary'
  | 'git_diff_file'
  | 'git_snapshot_create'
  | 'git_snapshot_compare'
  | 'git_log'
  | 'git_checkpoint'
  | 'git_stash_push'
  | 'git_stash_pop'
  | 'git_checkout_files'
  | 'git_remote_url'
  | 'git_push';
