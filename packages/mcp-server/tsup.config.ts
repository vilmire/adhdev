import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  dts: false,
  clean: true,
  target: 'node18',
  splitting: false,
  sourcemap: true,
  noExternal: [],
  external: ['@adhdev/daemon-core', '@adhdev/session-host-core'],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
