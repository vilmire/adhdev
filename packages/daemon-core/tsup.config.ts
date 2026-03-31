import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/status/normalize.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  target: 'node18',
  splitting: false,
  sourcemap: true,
  // Bundle everything into a single file — daemon-core has no external deps except ws/chalk/conf
  external: ['ws', 'chalk', 'conf', 'node-pty'],
  noExternal: [],
});
