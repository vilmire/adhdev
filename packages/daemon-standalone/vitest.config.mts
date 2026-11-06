import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // A suite imports the daemon graph in beforeAll; on a loaded machine that alone passes 10 s.
    hookTimeout: 30_000,
    environment: 'node',
    include: ['test/**/*.vitest.ts'],
    setupFiles: ['./test/setup-tmp-guard.ts'],
  },
});
