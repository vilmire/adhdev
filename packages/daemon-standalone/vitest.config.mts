import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.vitest.ts'],
    setupFiles: ['./test/setup-tmp-guard.ts'],
  },
});
