import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  dts: false,
  clean: true,
  target: 'node18',
  splitting: false,
  sourcemap: true,
  external: [
    '@adhdev/daemon-core',
    'ws', 'chalk', 'conf', 'node-pty',
  ],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
