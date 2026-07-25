import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.mts';
import { GIT_HEAVY_SUITES } from './vitest.git-suites.mts';

/**
 * Git tier: ONLY the git-heavy suites (vitest.git-suites.mts) — real git
 * subprocess fixtures (temp repos, submodules, worktrees). Slow on win32;
 * the complement lives in vitest.fast.config.mts. fast + git = the default
 * full suite.
 *
 * NOTE: plain spread override (not mergeConfig) — mergeConfig concatenates
 * arrays, which would merge the base include glob back in.
 */
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: GIT_HEAVY_SUITES,
  },
});
