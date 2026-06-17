import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Standalone Vite playground for the @wterm/ghostty PoC. Roots at this dir so
// index.html is the entry; serves the workspace node_modules so @wterm/* and
// its committed WASM asset resolve. assetsInclude keeps the .wasm as a fetchable
// URL (the ghostty core loads it via `new URL(..., import.meta.url)` + fetch).
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  assetsInclude: ['**/*.wasm'],
  server: { port: 5199, strictPort: true, fs: { allow: [path.resolve(__dirname, '../../../..')] } },
  optimizeDeps: { exclude: ['@wterm/ghostty', '@wterm/dom', '@wterm/core'] },
});
