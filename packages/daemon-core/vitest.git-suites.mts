/**
 * Git-heavy test suites — files that spawn real `git` subprocesses to build
 * temp repos (commits, submodules, worktrees). On win32 each git spawn costs
 * ~3-4s, so these files dominate full-suite wall-clock (minutes) while the
 * remaining ~415 files finish fast.
 *
 * Consumed by vitest.fast.config.mts (excludes them) and
 * vitest.git.config.mts (runs only them). The default `vitest run`
 * (vitest.config.mts) still runs EVERYTHING — CI coverage is unchanged.
 *
 * When adding a test that spawns real git, add its path here. A missed entry
 * only makes `test:fast` slower — it never loses coverage.
 * Classification probe: does the file import child_process (directly or via
 * fixtures) and pass 'git' to it?
 */
export const GIT_HEAVY_SUITES: string[] = [
  'test/commands/mesh-clone-node-registration.test.ts',
  'test/commands/mesh-coordinator.test.ts',
  'test/commands/mesh-crud-clone-sync-submodule-generic.test.ts',
  'test/commands/mesh-crud-oss-clone-sync-guard.test.ts',
  'test/commands/mesh-fast-forward-node.test.ts',
  'test/commands/mesh-refine-batch.test.ts',
  'test/commands/mesh-refine-no-op-guard.test.ts',
  'test/commands/mesh-refine-validation.test.ts',
  'test/commands/mesh-session-cleanup.test.ts',
  'test/commands/mesh-status.test.ts',
  'test/commands/mesh-worktree-bootstrap.test.ts',
  'test/commands/refine-diverged-gitlink-converge.test.ts',
  'test/commands/refine-gitlink-trivial-ff.test.ts',
  'test/commands/refine-patch-equivalence-classification.test.ts',
  'test/commands/refine-trivial-ff-gitlink-rebase.test.ts',
  'test/commands/router-direct-mesh-truth.test.ts',
  'test/commands/worktree-cleanup-legacy-path-hint.test.ts',
  'test/commands/worktree-cleanup-patch-equivalence.test.ts',
  'test/git/git-checkpoint-integration.test.ts',
  'test/git/git-diff.test.ts',
  'test/git/git-executor.test.ts',
  'test/git/git-status.test.ts',
  'test/mesh/mesh-onboarding-plan.test.ts',
  'test/mesh/preview-freshness.test.ts',
  'test/mesh/submodule-default-branch.test.ts',
  'test/mesh/worktree-bootstrap-stale-running.test.ts',
  'test/scripts/check-submodule-sync.test.ts',
];
