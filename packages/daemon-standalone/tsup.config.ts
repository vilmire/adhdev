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
});
