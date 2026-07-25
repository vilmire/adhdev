import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.mts';
import { GIT_HEAVY_SUITES } from './vitest.git-suites.mts';

/**
 * Fast tier: everything EXCEPT the git-heavy suites (vitest.git-suites.mts).
 * Use for quick iteration and delegated-worker runs on slow-spawn platforms
 * (win32). Run `npm run test:git` (or plain `npm test`) before landing
 * anything that touches git/refine/worktree code paths.
 *
 * NOTE: plain spread override (not mergeConfig) — mergeConfig concatenates
 * arrays, which would keep the excluded suites reachable.
 */
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    exclude: ['**/node_modules/**', ...GIT_HEAVY_SUITES],
  },
});
