import tailwindcss from '@tailwindcss/vite'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    plugins: [tailwindcss()],
    // Keep CommonJS conversion deterministic instead of rediscovering dependencies mid-test.
    optimizeDeps: {
        noDiscovery: true,
        include: [
            'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime',
            'react-router-dom', 'react-i18next', 'i18next', 'react-markdown', 'remark-breaks',
            'remark-gfm', 'remark-github-blockquote-alert', 'clsx', 'tailwind-merge', 'void-elements',
        ],
    },
    oxc: { jsx: { runtime: 'automatic' } },
    test: {
        include: [
            'test-browser/components/assistant-mobile-controls.browser.test.tsx',
            'test-browser/components/mobile-inbox-row-menu-overlay.browser.test.tsx',
            'test-browser/components/mobile-approvals-entry.browser.test.tsx',
            'test-browser/components/artifact-viewer.browser.test.tsx',
        ],
        testTimeout: 30_000,
        browser: {
            enabled: true,
            // Match the largest tested iframe so screenshots are saved at scale 1.
            provider: playwright({ contextOptions: { viewport: { width: 1280, height: 844 } } }),
            headless: true,
            instances: [{ browser: 'chromium' }],
        },
    },
})
