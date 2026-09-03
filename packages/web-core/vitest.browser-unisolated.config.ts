import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// ★ Deliberately serves NO Cross-Origin-Opener-Policy /
// Cross-Origin-Embedder-Policy headers — the opposite of
// `vitest.browser.config.ts`.
//
// This is not a variant for its own sake: it reproduces the ACTUAL production
// condition of `packages/web-cloud`, which cannot send those headers. Its
// `index.html` loads Paddle.js and opens a cross-origin `buy.paddle.com`
// checkout iframe, and nested cross-origin iframes must send their own COEP
// under both `require-corp` and `credentialless` — Paddle's does not. Turning
// COEP on there would break billing.
//
// The transcript worker's OPFS SAH pool VFS must therefore work WITHOUT
// cross-origin isolation. `test-browser-unisolated/` holds the tests that pin
// that, and they only mean anything when served from a page that is genuinely
// not isolated — which is why this needs a separate config rather than a flag:
// the property under test is a response header, and Vitest applies
// `server.headers` per config.
export default defineConfig({
    server: {
        fs: {
            // sqlite-wasm's .wasm asset is hoisted to the repo-root node_modules;
            // Vite's default allow-list only covers this package + its ancestors.
            allow: ['../../..'],
        },
    },
    test: {
        include: ['test-browser-unisolated/**/*.test.ts'],
        exclude: ['**/node_modules/**', '**/.git/**'],
        browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
        },
    },
});
