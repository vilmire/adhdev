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
 *
 * ★A STALE entry, unlike a missed one, DOES lose coverage — silently. vitest
 * exits 1 when EVERY include misses, but a PARTIAL miss is green with no
 * warning, so `test:git` just runs fewer files than the list claims. That
 * happened: 'test/scripts/check-submodule-sync.test.ts' was moved out of this
 * package by oss d7b6751e (2026-08-04) to packages/daemon-cloud/test/, and
 * `test:git` ran 28/29 for 17 days without a signal. The entry is removed here
 * rather than repointed because the file now lives in a different package with
 * its own suite (`test:daemon-cloud`), outside this config's roots.
 *
 * Guard against a repeat: every path below must exist. If you remove or move a
 * suite, update this list in the same commit — a stale entry is invisible at
 * runtime.
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
  'test/commands/refine-base-cas-fetch-undeterminable.test.ts',
  'test/commands/refine-diverged-gitlink-converge.test.ts',
  'test/commands/refine-gitlink-ff-undeterminable.test.ts',
  'test/commands/refine-gitlink-trivial-ff.test.ts',
  'test/commands/refine-patch-equivalence-classification.test.ts',
  'test/commands/refine-reachability-fetch-undeterminable.test.ts',
  'test/commands/refine-trivial-ff-gitlink-rebase.test.ts',
  'test/commands/router-direct-mesh-truth.test.ts',
  'test/commands/worktree-cleanup-ghost-convergence.test.ts',
  'test/commands/worktree-cleanup-legacy-path-hint.test.ts',
  'test/commands/worktree-cleanup-patch-equivalence.test.ts',
  'test/git/git-checkpoint-integration.test.ts',
  'test/git/git-diff.test.ts',
  'test/git/git-executor.test.ts',
  'test/git/git-locale.test.ts',
  'test/git/git-status.test.ts',
  'test/mesh/mesh-completion-side-effect-evidence.test.ts',
  'test/mesh/mesh-onboarding-plan.test.ts',
  'test/mesh/preview-freshness.test.ts',
  'test/mesh/submodule-default-branch.test.ts',
  'test/mesh/worktree-bootstrap-stale-running.test.ts',
];
