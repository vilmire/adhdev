import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/defaults.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  target: 'node18',
  splitting: false,
  sourcemap: true,
  external: [],
  noExternal: [],
});
