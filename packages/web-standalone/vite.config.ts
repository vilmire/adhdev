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
                    // The opt-in @wterm/ghostty renderer is dynamically imported
                    // (React.lazy) so its ~428KB WASM + JS never load unless the
                    // user selects it. Keep wterm-view and the @wterm/* packages
                    // OUT of the eager 'terminal' chunk — forcing them in here
                    // would defeat that code-split and load them for everyone.
                    if (
                        id.includes('terminal-render-web/src/wterm-view') ||
                        id.includes('@wterm/')
                    ) return 'terminal-wterm'
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
            '/api': 'http://localhost:3847',
            '/auth': 'http://localhost:3847',
            '/ws': { target: 'ws://localhost:3847', ws: true },
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
