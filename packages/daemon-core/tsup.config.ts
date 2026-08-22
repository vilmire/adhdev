import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';
import { daemonBuildDefine } from './build-stamp.mjs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  // config-dir is a separate entry (not only re-exported from index) so
  // daemon-standalone's bootstrap can import the LEAF without evaluating the
  // barrel — the barrel pulls in the logger, which fixes its log dir at module
  // load, and the bootstrap must run before that happens.
  entry: ['src/index.ts', 'src/status/normalize.ts', 'src/chat/chat-signatures.ts', 'src/config/config-dir.ts'],
  format: ['cjs', 'esm'],
  dts: false,
  clean: true,
  target: 'node18',
  splitting: false,
  sourcemap: true,
  // Keep native modules external so their bindings resolve from their package roots.
  external: ['ws', 'chalk', 'conf', 'node-pty', 'better-sqlite3'],
  // Bundle the pure mesh-shared leaf inline so this dist — which daemon-standalone
  // ships verbatim — is self-contained and doesn't need mesh-shared resolvable at
  // the consumer's node_modules root.
  noExternal: ['@adhdev/mesh-shared'],
  // Bake the git commit/version into __DAEMON_BUILD_* (read by src/build-info.ts)
  // so this dist — which daemon-standalone ships verbatim — reports its build.
  define: daemonBuildDefine({ version: pkg.version }),
});
