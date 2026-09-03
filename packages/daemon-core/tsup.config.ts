import { defineConfig } from 'tsup';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { daemonBuildDefine } from './build-stamp.mjs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

const OSS_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(OSS_ROOT, '..');

/**
 * Deps of the bundled `seqscribe` leaf that must resolve from ONE fixed place,
 * regardless of how npm happened to lay out this checkout. See `pin-seqscribe-deps`.
 */
const PINNED_SEQSCRIBE_DEPS = ['@noble/hashes', 'canonicalize'];

/**
 * Locate a package in a FIXED preference order — oss/node_modules, then the repo
 * root — ignoring wherever else npm may also have installed it (in particular
 * `oss/vendor/seqscribe/node_modules`). Returns the base whose `node_modules`
 * holds it, or undefined if absent from both, in which case resolution is left
 * to esbuild's default.
 */
function pinnedResolveBase(spec: string): string | undefined {
  for (const base of [OSS_ROOT, REPO_ROOT]) {
    if (existsSync(path.join(base, 'node_modules', spec))) return base;
  }
  return undefined;
}

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
  esbuildPlugins: [
    {
      // REPRODUCIBILITY — pin seqscribe's transitive deps to ONE canonical
      // install dir, so this dist is byte-identical regardless of install state.
      //
      // `seqscribe` is bundled inline (see noExternal above) and is a `file:`
      // dep symlinked to oss/vendor/seqscribe. esbuild resolves through the
      // symlink's REAL path, so seqscribe's own bare imports of @noble/hashes
      // and canonicalize resolve by walking up from oss/vendor/seqscribe:
      //   - nested install present → oss/vendor/seqscribe/node_modules/...
      //   - nested install absent  → oss/node_modules (hoisted)
      // Both are valid installs of the same semver range, but they are
      // DIFFERENT absolute paths, and esbuild bakes whichever it picked into
      // the emitted `__esm`/`__commonJS` module-path comment keys.
      //
      // That made the output a function of install state rather than of source.
      // And the nested state is not stable: neither lockfile declares
      // `vendor/seqscribe/node_modules/*` entries, so every `npm install` in oss
      // prunes the nested copies as extraneous, after which the next build flips
      // the paths back. The committed vendor bundles inherit this dist verbatim,
      // so check-vendor-drift byte-compared against a moving target and went red
      // on branches that changed nothing (the committed style flipped 4 times
      // historically: 945529ea4 → c703e619e → dc1eed092 → 1450ac5df).
      //
      // Fixing it HERE is what works. mcp-server has a `pin-seqscribe-deps`
      // plugin of its own, but it can never fire: mcp-server aliases
      // @adhdev/daemon-core to this prebuilt dist, in which these module paths
      // are already frozen string literals — there is no resolve left to
      // intercept downstream. daemon-core is where the resolve actually happens.
      //
      // Note this fires for seqscribe as the importer, which is the case that
      // matters; daemon-core's own src does not import either package directly.
      name: 'pin-seqscribe-deps',
      setup(build) {
        for (const spec of PINNED_SEQSCRIBE_DEPS) {
          const base = pinnedResolveBase(spec);
          if (!base) continue;
          const filter = new RegExp(`^${spec.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}(/.*)?$`);
          build.onResolve({ filter }, async (args) => {
            // Guard against recursing on the resolve() call we make below.
            if (args.pluginData?.pinnedSeqscribeDep) return undefined;
            // Re-resolve the SAME bare specifier from the pinned base. Keeping
            // the specifier bare (rather than rewriting it to a relative path)
            // preserves the package `exports` map, so subpaths still land on the
            // entry points the package intends — e.g. @noble/hashes/sha256 →
            // esm/sha256.js, not the CJS root file a relative rewrite picks.
            const r = await build.resolve(args.path, {
              resolveDir: base,
              kind: args.kind,
              pluginData: { pinnedSeqscribeDep: true },
            });
            if (r.errors.length > 0) return undefined;
            return { path: r.path, external: r.external };
          });
        }
      },
    },
  ],
});
