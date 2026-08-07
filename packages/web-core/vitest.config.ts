import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        // .tsx is included deliberately: three component test files already
        // existed under test/ and were silently never run, because the glob only
        // matched .test.ts. mobile-dashboard-mode.test.tsx is excluded for now —
        // it needs a DOM (`window`) and this project runs `environment: 'node'`,
        // so it fails on environment rather than on product behaviour. Giving it
        // a jsdom environment is a separate change from the loading/empty-state
        // fixes this glob was widened for.
        include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
        exclude: [
            '**/node_modules/**',
            '**/.git/**',
            'test/components/settings/mobile-dashboard-mode.test.tsx',
        ],
        setupFiles: ['./test/setup.ts'],
    },
});
