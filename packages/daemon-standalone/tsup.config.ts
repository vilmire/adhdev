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
  external: ['ws', 'chalk', 'conf', 'node-pty'],
  noExternal: [/^@adhdev\//],
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
