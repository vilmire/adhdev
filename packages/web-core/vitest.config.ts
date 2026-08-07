import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        // Most suites are plain node (176 files); only tests that touch `window`
        // opt into jsdom per-file via a `// @vitest-environment jsdom` comment
        // (Vitest 4 dropped environmentMatchGlobs) instead of flipping the
        // default, which would slow down every node-only suite.
        include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
        exclude: ['**/node_modules/**', '**/.git/**'],
        setupFiles: ['./test/setup.ts'],
    },
});
