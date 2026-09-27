import { defineConfig, searchForWorkspaceRoot } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

import packageJson from './package.json'

const localWebCoreIndex = fileURLToPath(new URL('../web-core/src/index.ts', import.meta.url))
const localWebCoreCss = fileURLToPath(new URL('../web-core/src/index.css', import.meta.url))
const localWebCoreSupported = fileURLToPath(new URL('../web-core/src/constants/supported.ts', import.meta.url))
const localWebCoreRoot = fileURLToPath(new URL('../web-core', import.meta.url))
const CRYPTO_BROWSER_SHIM = fileURLToPath(new URL('./src/stubs/crypto-browser-shim.ts', import.meta.url))
const workspaceRoot = searchForWorkspaceRoot(process.cwd())

// Dev-only: point the proxy at a non-default daemon port so a second standalone
// stack can run beside an existing daemon that already holds 3847 (common on a
// machine whose real daemon is live). Default unchanged.
const standaloneDaemonPort = process.env.ADHDEV_STANDALONE_DAEMON_PORT?.trim() || '3847'
const daemonHttpTarget = `http://localhost:${standaloneDaemonPort}`
const daemonWsTarget = `ws://localhost:${standaloneDaemonPort}`

type ModuleInfoLookup = (id: string) => { isEntry: boolean; importedIds: readonly string[] } | null

let staticallyReachable: { lookup: ModuleInfoLookup; ids: Set<string> } | null = null

/**
 * True when `id` is reachable from an entry through STATIC imports only (the
 * eager critical path). Computed once per build from the full module graph.
 * The cloud dashboard build carries the same helper.
 */
function isStaticallyReachable(
    id: string,
    getModuleInfo: ModuleInfoLookup,
    getModuleIds: () => IterableIterator<string>,
): boolean {
    if (!staticallyReachable || staticallyReachable.lookup !== getModuleInfo) {
        const reachable = new Set<string>()
        const stack: string[] = []
        for (const moduleId of getModuleIds()) {
            if (getModuleInfo(moduleId)?.isEntry) stack.push(moduleId)
        }
        while (stack.length > 0) {
            const next = stack.pop()!
            if (reachable.has(next)) continue
            reachable.add(next)
            for (const imported of getModuleInfo(next)?.importedIds ?? []) {
                if (!reachable.has(imported)) stack.push(imported)
            }
        }
        staticallyReachable = { lookup: getModuleInfo, ids: reachable }
    }
    return staticallyReachable.ids.has(id)
}

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: [
            { find: /^@adhdev\/web-core$/, replacement: localWebCoreIndex },
            { find: /^@adhdev\/web-core\/index\.css$/, replacement: localWebCoreCss },
            { find: /^@adhdev\/web-core\/constants\/supported$/, replacement: localWebCoreSupported },
            // @noble/hashes (inlined via daemon-core's seqscribe codec) resolves under the
            // node condition to cryptoNode.js, which bare-imports 'crypto'. Keeping it
            // external emitted `import "crypto"` into the entry chunk, which a browser
            // cannot resolve. Map it to Web Crypto instead (same shim as web-cloud).
            { find: /^crypto$/, replacement: CRYPTO_BROWSER_SHIM },
        ],
    },
    // The transcript worker (web-core transcript-worker-entry.ts) loads
    // @sqlite.org/sqlite-wasm, whose ESM loader resolves sqlite3.wasm next to
    // its own module URL. Vite's dev pre-bundling moves the module into
    // .vite/deps/, where no .wasm sits, so the fetch falls through to the SPA
    // index.html ('expected magic word 00 61 73 6d, found 3c 21 44 4f').
    // Production builds emit the wasm as an asset and are unaffected.
    optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
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
                id === 'child_process' ||
                id === 'util' ||
                id === 'events' ||
                id === 'http' ||
                id === 'module',
            output: {
                manualChunks(id, { getModuleInfo, getModuleIds }) {
                    if (
                        id.includes('packages/terminal-render-web') ||
                        id.includes('ghostty-web') ||
                        id.includes('@xterm') ||
                        id.includes('xterm')
                    ) return 'terminal'
                    // The mesh graph stack (elkjs + @xyflow/react) is only reached
                    // through web-core's lazily imported DashboardMeshGraphDialog —
                    // keep it out of the eager `vendor` chunk.
                    if (/[\\/]node_modules[\\/](elkjs|@xyflow)[\\/]/.test(id)) return 'mesh-graph'
                    if (!id.includes('node_modules')) return
                    // A dependency reachable only through a dynamic import stays with
                    // Rollup's automatic splitting instead of the eager `vendor` chunk.
                    if (!isStaticallyReachable(id, getModuleInfo, getModuleIds)) return
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
