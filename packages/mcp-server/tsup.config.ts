import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineConfig } from 'tsup';

const OSS_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(OSS_ROOT, '..');

/**
 * Locate a package in a FIXED preference order — oss/node_modules, then the repo
 * root — ignoring wherever else npm may also have installed it. Returns the
 * package dir, or undefined if absent from both (in which case resolution is
 * left to esbuild's default). See the `pin-seqscribe-deps` plugin for why.
 */
function pinnedPackageDir(spec: string): { dir: string; base: string } | undefined {
  for (const base of [OSS_ROOT, REPO_ROOT]) {
    const dir = path.join(base, 'node_modules', spec);
    if (fs.existsSync(dir)) return { dir, base };
  }
  return undefined;
}

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  dts: false,
  clean: true,
  target: 'node18',
  splitting: false,
  sourcemap: true,
  // daemon-core is bundled INLINE, matching daemon-cloud and daemon-standalone.
  //
  // It used to be `external`, which only ever worked because every consumer
  // happened to have a daemon-core alongside: the two vendored copies sit next
  // to the host package's own dependency, and an in-repo install resolves it
  // through workspace node_modules. A standalone `npm i @adhdev/mcp-server` has
  // neither, so the dependency was declared as `"@adhdev/daemon-core": "*"` —
  // which npm resolves to the `latest` dist-tag, i.e. the last STABLE release,
  // never the rc being shipped. The moment mcp-server imported a daemon-core
  // subpath added in the current cycle (`./mesh/transcript-read-model-consumers`),
  // the isolated install died with ERR_PACKAGE_PATH_NOT_EXPORTED and blocked the
  // preview deploy: `latest` (1.0.57) has no such export.
  //
  // Inlining is safe here because mcp-server is a SEPARATE PROCESS that reaches
  // the daemon over HTTP/IPC (see transports/). It shares no in-process daemon
  // state with daemon-core — every daemon-core symbol it imports is either a
  // pure function (isTaskReadonly, DEFAULT_QUOTA_ROUTING_POLICY, isWorkerMcpEnabled,
  // buildMeshRoutePreview) or a disk reader (getMesh, loadConfig read
  // ~/.adhdev/*.json). A second copy of that code in the bundle therefore
  // observes exactly the same state as the daemon's copy. Live daemon state is
  // always fetched through `transport.command(...)`, never through a shared module.
  //
  // `@adhdev/session-host-core` was also listed external but is imported nowhere
  // in src/ and is not a declared dependency — a stale entry, now dropped.
  // `@adhdev/session-host-daemon` stays external: daemon-core reaches it via
  // `require.resolve()` to locate the sessiond binary on disk, which esbuild
  // cannot rewrite into a bundle (same exclusion daemon-standalone's config
  // makes, for the same reason).
  //
  // The native addons (better-sqlite3, node-pty, ghostty-vt-node) stay external
  // because a .node binding cannot be inlined — but they are deliberately NOT
  // added to `dependencies`. Every surviving `require()` of them in this bundle
  // is lazy and try/catch-guarded (daemon-core's sqlite loader, execUnderPty,
  // the node-pty runtime transport), and mcp-server is a client that talks to
  // the daemon over HTTP/IPC — it never opens the daemon's SQLite and never
  // spawns a PTY, so those branches are unreachable here. Declaring them would
  // force every consumer to compile two native addons for dead code. If a future
  // change makes mcp-server actually reach one of these paths, add it to
  // `dependencies` at that point — `check:publish-install` boots the shipped bin
  // from an isolated install, so a genuinely-reached missing native fails there.
  noExternal: [/^@adhdev\/(?!session-host-daemon(?:\/|$))/],
  external: ['@adhdev/session-host-daemon', 'better-sqlite3', 'node-pty', '@adhdev/ghostty-vt-node'],
  banner: {
    js: '#!/usr/bin/env node',
  },
  esbuildPlugins: [
    {
      // Neutralize daemon-core's build stamp in THIS bundle.
      //
      // This bundle's bytes are committed (packages/daemon-cloud/vendor/mcp-server,
      // oss/packages/daemon-standalone/vendor/mcp-server) and byte-compared against
      // a fresh rebuild by scripts/check-vendor-drift.mjs. Inlining daemon-core
      // dragged in its `__DAEMON_BUILD_*` stamp — the git HEAD and wall-clock of
      // whenever daemon-core's dist was built. For a COMMITTED artifact the commit
      // stamp is a fixed-point paradox: a green gate would require the file to
      // contain the hash of the commit that contains it, so every commit re-stales
      // the copy it just refreshed. `builtAt` can never match either.
      //
      // A tsup `define` cannot fix this: daemon-core's dist has the identifiers
      // ALREADY substituted into string literals, so there is no `__DAEMON_BUILD_*`
      // token left for esbuild to replace. Hence an onLoad pass over that one dist
      // file, rewriting the literals back to 'unknown'.
      //
      // Safe here: mcp-server is a CLIENT process that reports the *daemon's* build
      // via the transport (`status.daemonBuildBehind` → `staleDaemonBuild`), never
      // its own inlined copy. build-info.ts already treats 'unknown' as the
      // no-stamp path. The shipped daemons (daemon-core dist, daemon-cloud,
      // daemon-standalone) are untouched and keep a real stamp, so
      // staleDaemonBuild detection is unaffected.
      name: 'strip-daemon-build-stamp',
      setup(build) {
        const distIndex = path.resolve(__dirname, '../daemon-core/dist/index.js');
        build.onLoad({ filter: /daemon-core[\\/]dist[\\/]index\.js$/ }, async (args) => {
          if (path.resolve(args.path) !== distIndex) return undefined;
          const src = await fs.promises.readFile(args.path, 'utf8');
          // Rewrite only the stamp reads emitted by build-info.ts. The version is
          // deliberately preserved — it comes from package.json, not from git, so
          // it is already reproducible and is genuinely useful to report.
          const patched = src
            .replace(/__DAEMON_BUILD_COMMIT__\s*=\s*"[0-9a-f]{7,40}"/g, '__DAEMON_BUILD_COMMIT__ = "unknown"')
            .replace(/readInjected\(true \? "[0-9a-f]{40}" : void 0\)/g, 'readInjected(true ? "unknown" : void 0)')
            .replace(/readInjected\(true \? "[0-9a-f]{7,8}" : void 0\)/g, 'readInjected(true ? "unknown" : void 0)')
            .replace(
              /readInjected\(true \? "\d{4}-\d{2}-\d{2}T[0-9:.]+Z" : void 0\)/g,
              'readInjected(true ? "unknown" : void 0)',
            );
          return { contents: patched, loader: 'js' };
        });
      },
    },
    {
      // Pin seqscribe's transitive deps (@noble/hashes, canonicalize) to ONE
      // canonical install dir, so the bundle is byte-identical across machines.
      //
      // seqscribe is a `file:` dep pointing at a nested submodule
      // (oss/vendor/seqscribe) whose node_modules is untracked install state.
      // npm nests a real @noble/hashes + canonicalize install there on some
      // machines and hoists on others; both are valid installs of the same
      // semver range, but they are DIFFERENT absolute paths, and esbuild bakes
      // whichever it picked into the bundle's `__esm`/`__commonJS` module-path
      // comment keys. Same source, byte-different output per machine — which
      // pinned check-vendor-drift red no matter how often the copy was re-synced.
      //
      // A resolver flag cannot fix this (the nested copy is a genuinely different
      // file), and an `alias` entry cannot either (exact-match only, while these
      // are imported by subpath: `@noble/hashes/sha256`). Hence an explicit
      // onResolve that rewrites the package root and lets esbuild handle the rest.
      name: 'pin-seqscribe-deps',
      setup(build) {
        for (const spec of ['@noble/hashes', 'canonicalize']) {
          const pinned = pinnedPackageDir(spec);
          if (!pinned) continue;
          const { dir, base } = pinned;
          const filter = new RegExp(`^${spec.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}(/.*)?$`);
          build.onResolve({ filter }, async (args) => {
            // Guard against recursing on the resolve() call we make below.
            if (args.pluginData?.pinned) return undefined;
            // Re-resolve the SAME bare specifier, but from the pinned package's
            // parent node_modules. Keeping the specifier bare (rather than
            // rewriting it to a relative path) preserves the package `exports`
            // map, so subpaths still land on the entry points the package
            // intends — e.g. @noble/hashes/sha256 → esm/sha256.js, not the CJS
            // root file a relative rewrite would pick.
            const r = await build.resolve(args.path, {
              resolveDir: base,
              kind: args.kind,
              pluginData: { pinned: true },
            });
            if (r.errors.length) return undefined;
            return { path: r.path, external: r.external };
          });
        }
      },
    },
  ],
  esbuildOptions(options) {
    // REPRODUCIBILITY — keep the emitted module-path comments environment-independent.
    //
    // daemon-core bundles `seqscribe`, a `file:` dependency symlinked from
    // node_modules into oss/vendor/seqscribe. esbuild resolves through the
    // symlink's REAL path by default, so seqscribe's own deps (@noble/hashes,
    // canonicalize) resolve by walking up from oss/vendor/seqscribe — landing in
    // oss/vendor/seqscribe/node_modules when npm nested an install there, and in
    // oss/node_modules or the hoisted root when it did not. That choice is an
    // artifact of install state, not of source, and it is baked verbatim into the
    // bundle's `__commonJS`/`__esm` module-path comment keys. Three environments
    // produced three byte-different bundles from identical source, which pinned
    // check-vendor-drift red no matter how many times the copy was re-synced.
    //
    // `absWorkingDir` fixes the base that the emitted comment paths are made
    // relative to, so they don't shift with the directory the build was invoked
    // from. That alone is NOT enough: when npm has nested a real install under
    // oss/vendor/seqscribe/node_modules, esbuild resolves to a genuinely
    // different file on disk, and no resolver flag can normalize that away
    // (verified — `preserveSymlinks` merely relabels it via the symlink path).
    // So the dep locations are pinned explicitly below.
    options.absWorkingDir = __dirname;
    // esbuild resolves a workspace package through its `exports` map, which for
    // daemon-core points at dist/. Alias the barrel and the subpaths explicitly
    // so the bundle pulls from daemon-core SOURCE rather than depending on
    // node_modules symlink layout. Exact-match only — each subpath needs its
    // own entry (same constraint daemon-standalone's config documents).
    //
    // dist, NOT src. Bundling daemon-core from source would also work for the
    // build stamp, but it re-resolves every transitive dep under THIS package's
    // conditions rather than daemon-core's — flipping deps such as chokidar from
    // their CJS to their ESM entry and reshuffling ~3k lines of output. That is a
    // much wider behavior change than this fix needs, so the dist alias stays and
    // the stamp is neutralized by the `strip-daemon-build-stamp` plugin below.
    const daemonCore = path.resolve(__dirname, '../daemon-core/dist');
    options.alias = {
      ...(options.alias || {}),
      '@adhdev/daemon-core': path.join(daemonCore, 'index.js'),
      '@adhdev/daemon-core/mesh/transcript-read-model-consumers': path.join(
        daemonCore,
        'mesh/transcript-read-model-consumers.js',
      ),
      // Pin seqscribe's transitive deps to ONE canonical directory. seqscribe is a
      // `file:` dep pointing at a nested submodule (oss/vendor/seqscribe) whose
      // node_modules is untracked install state: npm nests a real @noble/hashes +
      // canonicalize install there on some machines and hoists on others. Both are
      // valid installs of the same semver range, but they are different absolute
      // paths, and esbuild bakes whichever it picked into the bundle's module-path
      // comment keys — so the same source produced byte-different bundles per
      // machine and pinned check-vendor-drift permanently red.
      //
      // Pinning happens in the `pin-seqscribe-deps` plugin below rather than here,
      // because esbuild aliases are exact-match and these deps are imported by
      // subpath (`@noble/hashes/sha256`, `.../utils`, ...).
    };
  },
});
