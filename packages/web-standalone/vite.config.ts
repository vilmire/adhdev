import { defineConfig, searchForWorkspaceRoot } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

import packageJson from './package.json'

const localWebCoreIndex = fileURLToPath(new URL('../web-core/src/index.ts', import.meta.url))
const localWebCoreCss = fileURLToPath(new URL('../web-core/src/index.css', import.meta.url))
const localWebCoreSupported = fileURLToPath(new URL('../web-core/src/constants/supported.ts', import.meta.url))
const localWebCoreRoot = fileURLToPath(new URL('../web-core', import.meta.url))
const workspaceRoot = searchForWorkspaceRoot(process.cwd())

// Dev-only: point the proxy at a non-default daemon port so a second standalone
// stack can run beside an existing daemon that already holds 3847 (common on a
// machine whose real daemon is live). Default unchanged.
const standaloneDaemonPort = process.env.ADHDEV_STANDALONE_DAEMON_PORT?.trim() || '3847'
const daemonHttpTarget = `http://localhost:${standaloneDaemonPort}`
const daemonWsTarget = `ws://localhost:${standaloneDaemonPort}`

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: [
            { find: /^@adhdev\/web-core$/, replacement: localWebCoreIndex },
            { find: /^@adhdev\/web-core\/index\.css$/, replacement: localWebCoreCss },
            { find: /^@adhdev\/web-core\/constants\/supported$/, replacement: localWebCoreSupported },
        ],
    },
    define: {
        __APP_VERSION__: JSON.stringify(packageJson.version),
    },
    build: {
        rollupOptions: {
            external: (id) =>
                id.startsWith('node:') ||
                id === 'readdirp' ||
                id === 'chokidar' ||
                id === 'path' ||
                id === 'fs' ||
                id === 'fs/promises' ||
                id === 'os' ||
                id === 'net' ||
                id === 'stream' ||
                id === 'crypto' ||
                id === 'child_process' ||
                id === 'util' ||
                id === 'events' ||
                id === 'http' ||
                id === 'module',
            output: {
                manualChunks(id) {
                    if (
                        id.includes('packages/terminal-render-web') ||
                        id.includes('ghostty-web') ||
                        id.includes('@xterm') ||
                        id.includes('xterm')
                    ) return 'terminal'
                    if (!id.includes('node_modules')) return
                    return 'vendor'
                },
            },
        },
    },
    server: {
        port: 3000,
        fs: {
            allow: [workspaceRoot, localWebCoreRoot],
        },
        proxy: {
            '/api': daemonHttpTarget,
            '/auth': daemonHttpTarget,
            '/ws': { target: daemonWsTarget, ws: true },
            // Marketplace registry — proxied to production API so the dev origin
            // (localhost:3000) doesn't hit production CORS. See
            // StandaloneMarketplace.tsx.
            '/registry': {
                target: 'https://api.adhf.dev',
                changeOrigin: true,
                secure: true,
                rewrite: (p: string) => p.replace(/^\/registry/, '/api/v1/registry'),
            },
        },
    },
})
