import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

import packageJson from './package.json'

export default defineConfig({
    plugins: [react(), tailwindcss()],
    define: {
        __APP_VERSION__: JSON.stringify(packageJson.version),
    },
    build: {
        rollupOptions: {
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
        proxy: {
            '/api': 'http://localhost:3847',
            '/auth': 'http://localhost:3847',
            '/ws': { target: 'ws://localhost:3847', ws: true },
        },
    },
})
