export type {
  GitCommandName,
  GitCompactSummary,
  GitDiffSummary,
  GitFailureReason,
  GitFileChange,
  GitFileChangeStatus,
  GitRepoIdentity,
  GitRepoStatus,
  GitSnapshot,
  GitSnapshotCompareSummary,
  GitSnapshotReason,
  GitWorkspaceUpdate,
  WorkspaceGitSubscriptionParams,
} from './git-types.js';

export {
  GitCommandError,
  isPathInside,
  normalizeGitOutput,
  resolveGitRepository,
  runGit,
} from './git-executor.js';
export type { GitCommandResult as GitExecutorCommandResult, GitExecutorOptions, RunGitOptions } from './git-executor.js';

export { getGitRepoStatus, parsePorcelainV2Status } from './git-status.js';
export type { GitStatusOptions } from './git-status.js';

export { getGitDiffSummary, getGitFileDiff } from './git-diff.js';
export type { GitDiffOptions, GitFileDiffResult } from './git-diff.js';

export { createGitCompactSummary, summarizeGitStatus } from './git-summary.js';

export {
  compareGitSnapshots,
  createGitSnapshotStore,
  InMemoryGitSnapshotStore,
} from './git-snapshot-store.js';
export type {
  GitDiffSummaryProvider,
  GitSnapshotCreateInput,
  GitSnapshotListQuery,
  GitSnapshotStore,
  GitSnapshotStoreOptions,
  GitStatusProvider,
  MaybePromise,
} from './git-snapshot-store.js';

export {
  createGitWorkspaceMonitor,
  DEFAULT_GIT_WORKSPACE_POLL_INTERVAL_MS,
  GitWorkspaceMonitor,
  MIN_GIT_WORKSPACE_POLL_INTERVAL_MS,
  normalizeGitWorkspaceSubscriptionParams,
} from './git-monitor.js';
export type {
  GitWorkspaceCacheEntry,
  GitWorkspaceMonitorOptions,
  GitWorkspaceSubscription,
  GitWorkspaceUpdateListener,
  NormalizedWorkspaceGitSubscriptionParams,
  NormalizeGitWorkspaceSubscriptionOptions,
} from './git-monitor.js';

export { createDefaultGitCommandServices, handleGitCommand, isGitCommandName } from './git-commands.js';
export type {
  GitCommandResult,
  GitCommandServices,
  GitFileDiff,
  GitLogEntry,
  GitLogResult,
} from './git-commands.js';

export { TurnSnapshotTracker } from './turn-snapshot-tracker.js';
export type { TurnCompletedCallback } from './turn-snapshot-tracker.js';

export {
  createWorktree,
  listWorktrees,
  parseWorktreeListOutput,
  removeWorktree,
  resolveWorktreePath,
} from './git-worktree.js';
export type {
  WorktreeCreateOptions,
  WorktreeCreateResult,
  WorktreeEntry,
  WorktreeRemoveResult,
} from './git-worktree.js';
