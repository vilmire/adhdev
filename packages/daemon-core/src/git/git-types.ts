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
  | 'git_command_failed';

export interface GitRepoIdentity {
  workspace: string;
  repoRoot: string | null;
  isGitRepo: boolean;
}

export interface GitRepoStatus extends GitRepoIdentity {
  branch: string | null;
  headCommit: string | null;
  headMessage: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  deleted: number;
  renamed: number;
  hasConflicts: boolean;
  conflictFiles: string[];
  stashCount: number;
  lastCheckedAt: number;
  error?: string;
  reason?: GitFailureReason;
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
  | 'git_checkout_files';
