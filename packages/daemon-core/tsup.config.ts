import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';
import { daemonBuildDefine } from './build-stamp.mjs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

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
  // Bake the git commit/version into __DAEMON_BUILD_* (read by src/build-info.ts)
  // so this dist — which daemon-standalone ships verbatim — reports its build.
  define: daemonBuildDefine({ version: pkg.version }),
});
