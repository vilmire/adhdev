import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';
import { daemonBuildDefine } from './build-stamp.mjs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  // config-dir is a separate entry (not only re-exported from index) so
  // daemon-standalone's bootstrap can import the LEAF without evaluating the
  // barrel — the barrel pulls in the logger, which fixes its log dir at module
  // load, and the bootstrap must run before that happens.
  entry: [
    'src/index.ts',
    'src/status/normalize.ts',
    'src/chat/chat-signatures.ts',
    'src/config/config-dir.ts',
    // Portable (no Node builtins) leaves §8 unit 5 exposes so
    // `oss/packages/web-core`'s browser-worker transcript adapter can import
    // them without dragging the rest of daemon-core (logger/fs) into a
    // browser bundle — see each file's own header for the portability note.
    'src/seqscribe/transcript-revision-codec.ts',
    'src/mesh/transcript-read-model-consumers.ts',
    // The projection allow-list (design §2.4). Same portability property as the
    // codec beside it — its only import is `seqscribe`, no Node builtins — and
    // it is the producer step that runs BEFORE the codec
    // (`transcript-publisher.ts:376-377`). Exposed as a leaf because
    // `test:seqscribe-asymmetric` must drive the real encoder across a process
    // boundary: a gate that asserts the content boundary while re-implementing
    // the projection would assert only against its own copy.
    'src/seqscribe/transcript-projection.ts',
  ],
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
  // `seqscribe` is bundled for the same reason, and additionally because it is a
  // `file:` link into vendor/: a consumer installing @adhdev/daemon-core from npm
  // has no way to resolve it, so an external require would throw MODULE_NOT_FOUND.
  noExternal: ['@adhdev/mesh-shared', 'seqscribe'],
  // Bake the git commit/version into __DAEMON_BUILD_* (read by src/build-info.ts)
  // so this dist — which daemon-standalone ships verbatim — reports its build.
  define: daemonBuildDefine({ version: pkg.version }),
});
