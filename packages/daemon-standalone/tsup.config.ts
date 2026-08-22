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
  external: ['ws', 'node-pty', 'open', 'better-sqlite3', '@adhdev/session-host-daemon'],
  noExternal: [/^@adhdev\/(?!session-host-daemon(?:\/|$))/, 'chalk', 'conf'],
  banner: {
    js: '#!/usr/bin/env node',
  },
  esbuildOptions(options) {
    options.alias = {
      ...(options.alias || {}),
      '@adhdev/daemon-core': path.resolve(__dirname, '../daemon-core/dist/index.js'),
      // esbuild `alias` is exact-match, so the barrel entry above does NOT
      // cover subpath imports. bootstrap-config-dir.ts deliberately imports
      // the config-dir LEAF (it must not evaluate the barrel before the pin
      // lands), so map that subpath explicitly or the bundle fails to resolve.
      '@adhdev/daemon-core/config/config-dir': path.resolve(__dirname, '../daemon-core/dist/config/config-dir.js'),
    };
  },
});
