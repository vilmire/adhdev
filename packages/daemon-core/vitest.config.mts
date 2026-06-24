import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Shrinks production-sized mesh P2P probe windows (25–45s) to the 1s clamp
    // minimum so timeout-path tests resolve fast instead of waiting the real
    // cross-machine budget. See helpers/setup-env.ts for the full rationale.
    setupFiles: ['./test/helpers/setup-env.ts'],
    // Many suites spawn real `git` subprocesses (mesh status/refine fixtures build
    // temp repos with several commits + submodules). On win32 process spawn and the
    // surrounding fs work are markedly slower than on macOS/Linux, so the vitest
    // default 5s deadline false-times-out work that completes in 5–9s — a pure
    // environment flake that masks real regressions. Raise the per-test/hook
    // deadline to a realistic 30s. This does not weaken any assertion: a genuine
    // hang is bounded elsewhere (mesh peer probes self-cap at 25s) and still fails;
    // we only stop charging slow-but-correct Windows I/O against an unrealistic 5s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      enabled: false,
    },
  },
});
