import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// Separate config from vitest.config.ts (node/jsdom): browser-mode tests need
// a real Chromium page (OPFS SyncAccessHandle Pool VFS + dedicated Worker
// global scope have no Node/jsdom equivalent), and Vitest 4's `test.browser`
// cannot coexist with the default node environment in one config. CI-only —
// see `test:web-core:browser` in the root package.json.
export default defineConfig({
    server: {
        fs: {
            // sqlite-wasm's .wasm asset is hoisted to the repo-root node_modules;
            // Vite's default allow-list only covers this package + its ancestors.
            allow: ['../../..'],
        },
        headers: {
            // Required for SharedArrayBuffer / FileSystemSyncAccessHandle
            // (OPFS SAH pool VFS) inside the dedicated worker under test.
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
        },
    },
    test: {
        include: ['test-browser/**/*.test.ts'],
        exclude: ['**/node_modules/**', '**/.git/**'],
        browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
        },
    },
});
