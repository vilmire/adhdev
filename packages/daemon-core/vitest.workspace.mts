import { defineConfig, defineProject } from 'vitest/config';
import { GIT_HEAVY_SUITES } from './vitest.git-suites.mts';

/**
 * Per-directory vitest projects for scoped ("affected") runs.
 *
 * Why this exists: a full `npm run test:daemon-core` run is 113s wall here
 * (987 files) even for a change confined to one src directory, because the
 * default config (vitest.config.mts) has a single flat `include`. The
 * investigation behind this file (scripts/affected-projects.mjs) found
 * strong directory locality — most test files' relative imports resolve
 * into 1-2 src directories, with only 8/987 files crossing more than 3.
 *
 * This file does NOT replace vitest.config.mts. `npm run test:daemon-core`
 * (plain `vitest run`, no --project flag) still uses vitest.config.mts and
 * its single flat include — the full gate is unchanged. This workspace file
 * is consumed only via `vitest run --workspace vitest.workspace.mts --project
 * <name>` (wired up by scripts/affected-projects.mjs + verify-affected.mjs)
 * for scoped, faster reruns.
 *
 * Directory choice mirrors test/<dir> (see scripts/affected-projects.mjs'
 * TEST_DIR_PROJECTS for the exact list); anything not under one of those
 * dirs falls into "rest" so every test file is still covered by exactly one
 * project — `check:shape-guards` walks test files BY PATH, so no test file
 * may move as part of this split (verified: none did).
 *
 * Each project keeps the SAME git-heavy exclusion as the default git/fast
 * split (vitest.git-suites.mts is the single source of truth — imported,
 * never duplicated) so a scoped "fast" run still skips real-git subprocess
 * suites, and a scoped "git" run (see the `:git` project family below) can
 * still run just the git-heavy suites that fall inside the affected
 * directories.
 */

// Shared test options every project needs (mirrors vitest.config.mts).
const SHARED = {
  environment: 'node' as const,
  setupFiles: ['./test/helpers/setup-env.ts'],
  testTimeout: 30_000,
  hookTimeout: 30_000,
  coverage: { enabled: false },
};

const GIT_HEAVY_SET = new Set(GIT_HEAVY_SUITES);

/** Test directories that get their own project. Everything else → "rest". */
const PROJECT_DIRS = [
  'mesh',
  'turn-ledger',
  'providers',
  'commands',
  'boot',
  'seqscribe',
  'sessions',
  'status',
] as const;

function includeGlobsFor(dir: string): string[] {
  return [`test/${dir}/**/*.test.ts`];
}

/** "rest" = every test file NOT under one of PROJECT_DIRS (loose top-level
 * files like test/version-compare.test.ts, test/windows-hide.test.ts, and
 * directories with no dedicated project such as test/git, test/quota,
 * test/config, test/cli-adapters, etc). Expressed as excludes of the other
 * dirs rather than an enumerated list, so a newly added directory is
 * automatically covered by "rest" until it earns its own project. */
const REST_EXCLUDE = PROJECT_DIRS.map((d) => `test/${d}/**`);

function projectFor(dir: string, fast: boolean) {
  const include = includeGlobsFor(dir);
  return defineProject({
    test: {
      ...SHARED,
      name: fast ? dir : `${dir}:git`,
      include,
      exclude: fast
        ? ['**/node_modules/**', ...GIT_HEAVY_SUITES]
        : undefined,
      // git-tier project: only the git-heavy suites that also fall inside
      // this directory's include glob. Vitest intersects include/exclude
      // rather than OR-ing separate lists, so for the git tier we instead
      // narrow `include` down to the literal heavy-suite paths within dir.
      ...(fast
        ? {}
        : {
            include: [...GIT_HEAVY_SET].filter((p) => p.startsWith(`test/${dir}/`)),
          }),
    },
  });
}

export default defineConfig({
  test: {
    projects: [
      ...PROJECT_DIRS.map((dir) => projectFor(dir, true)),
      // git-heavy tier per directory — only meaningful for dirs that actually
      // own git-heavy suites (commands, mesh, git); empty include arrays are
      // harmless (vitest reports 0 matched files for that project).
      ...PROJECT_DIRS.map((dir) => projectFor(dir, false)),
      defineProject({
        test: {
          ...SHARED,
          name: 'rest',
          include: ['test/**/*.test.ts'],
          exclude: ['**/node_modules/**', ...REST_EXCLUDE, ...GIT_HEAVY_SUITES],
        },
      }),
      defineProject({
        test: {
          ...SHARED,
          name: 'rest:git',
          include: [...GIT_HEAVY_SET].filter(
            (p) => !PROJECT_DIRS.some((dir) => p.startsWith(`test/${dir}/`)),
          ),
        },
      }),
    ],
  },
});
