import * as path from 'node:path';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  dts: false,
  clean: true,
  target: 'node18',
  splitting: false,
  sourcemap: true,
  // Bundle daemon-core and ESM-only runtime deps into the published CJS CLI.
  // Leaving chalk external makes the standalone bin crash with require(esm)
  // before even `adhdev-standalone --help` can render from a fresh install.
  external: ['ws', 'node-pty', 'open'],
  noExternal: [/^@adhdev\//, 'chalk', 'conf'],
  banner: {
    js: '#!/usr/bin/env node',
  },
  esbuildOptions(options) {
    options.alias = {
      ...(options.alias || {}),
      '@adhdev/daemon-core': path.resolve(__dirname, '../daemon-core/dist/index.js'),
    };
  },
});
