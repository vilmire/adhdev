import type { GitCompactSummary, GitDiffSummary, GitRepoStatus } from './git-types.js';

function countStatusChangedFiles(status: GitRepoStatus): number {
  const conflictCount = status.conflictFiles.length > 0 ? status.conflictFiles.length : status.hasConflicts ? 1 : 0;
  return status.staged + status.modified + status.untracked + status.deleted + status.renamed + conflictCount;
}

/**
 * Build the small Git shape suitable for session lists and topic summaries.
 *
 * This helper intentionally preserves non-git/error information as plain fields
 * instead of turning expected states (for example `not_git_repo`) into alarming
 * derived messages.
 */
export function createGitCompactSummary(status: GitRepoStatus, diffSummary?: GitDiffSummary): GitCompactSummary {
  const statusChangedFiles = countStatusChangedFiles(status);
  const diffChangedFiles = diffSummary?.files.length ?? 0;
  const changedFiles = Math.max(statusChangedFiles, diffChangedFiles);
  const conflictCount = status.conflictFiles.length > 0 ? status.conflictFiles.length : status.hasConflicts ? 1 : 0;

  return {
    isGitRepo: status.isGitRepo,
    repoRoot: status.repoRoot,
    branch: status.branch,
    dirty:
      status.staged > 0 ||
      status.modified > 0 ||
      status.untracked > 0 ||
      status.deleted > 0 ||
      status.renamed > 0 ||
      conflictCount > 0 ||
      changedFiles > 0,
    changedFiles,
    ahead: status.ahead,
    behind: status.behind,
    hasConflicts: status.hasConflicts || conflictCount > 0,
    lastCheckedAt: Math.max(status.lastCheckedAt, diffSummary?.lastCheckedAt ?? status.lastCheckedAt),
    error: status.error ?? diffSummary?.error,
    reason: status.reason ?? diffSummary?.reason,
  };
}

export const summarizeGitStatus = createGitCompactSummary;
