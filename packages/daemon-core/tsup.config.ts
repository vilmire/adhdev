import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/status/normalize.ts', 'src/chat/chat-signatures.ts'],
  format: ['cjs', 'esm'],
  dts: false,
  clean: true,
  target: 'node18',
  splitting: false,
  sourcemap: true,
  // Keep native modules external so their bindings resolve from their package roots.
  external: ['ws', 'chalk', 'conf', 'node-pty', 'better-sqlite3'],
  noExternal: [],
});
