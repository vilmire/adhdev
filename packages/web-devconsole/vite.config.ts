import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 19281,
    proxy: {
      '/api': 'http://127.0.0.1:19280',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
