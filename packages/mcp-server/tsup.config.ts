import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineConfig } from 'tsup';
import { PINNED_SEQSCRIBE_DEPS, resolvePinnedDepBase } from '../../scripts/pinned-dep-base.mjs';

const OSS_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(OSS_ROOT, '..');

/**
 * Locate the ONE canonical base whose `node_modules` a pinned dep is taken from,
 * ignoring wherever else npm may also have installed it. See the
 * `pin-seqscribe-deps` plugin for why pinning is needed at all.
 *
 * ★ This deliberately does NOT fall back silently. The old version walked
 * [OSS_ROOT, REPO_ROOT] and took the first hit, so a missing oss install quietly
 * produced repo-root-relative module paths (`../../../node_modules/...`) where
 * the committed vendor bundles encode oss-relative ones (`../../`). The build
 * reported success and the damage surfaced much later as an unexplained vendor
 * gate failure (2026-09-20). resolvePinnedDepBase throws on the layouts that
 * cannot yield correct bytes and still permits a genuine root-only build — see
 * oss/scripts/pinned-dep-base.mjs for the three-state rule.
 *
 * ★ Fixing this here is necessary but NOT sufficient on its own: daemon-core's
 * config carries the same rule, and it is the one that actually bakes these paths
 * (this bundle aliases @adhdev/daemon-core onto daemon-core's prebuilt dist,
 * where the paths are already frozen literals). Both sites share this module so
 * they cannot enforce different conditions.
 */
function pinnedPackageDir(spec: string): { dir: string; base: string } | undefined {
  return resolvePinnedDepBase(spec, { ossRoot: OSS_ROOT, repoRoot: REPO_ROOT });
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
      //
      // ── Release stamp (version + channel) ────────────────────────────────
      //
      // The commit/builtAt scrub above was not sufficient. daemon-core's dist
      // ALSO carries two release-stamp literals, and they leak by the same path:
      //
      //   const version2 = readInjected(true ? "1.0.59" : void 0) ?? ...
      //   const injected = true ? "" : void 0;   ← ADHDEV_BUILD_CHANNEL
      //
      // `deploy:preview` builds daemon-core with ADHDEV_BUILD_CHANNEL=preview at
      // an rc version and LEAVES that dist on disk. Every later vendor operation —
      // the CI gate (check-vendor-drift), the pre-commit hook, bundle:vendor:all,
      // or a bare `npm run bundle:vendor` — then re-bundles those rc/preview bytes
      // into the COMMITTED vendor copies and dirties the worktree, with no deploy
      // involved at all. Measured 2026-09-18: four manual `git checkout --`
      // cleanups in one day, one of which blocked a Refinery merge ("local changes
      // would be overwritten") AFTER validation and patch_equivalence had passed.
      //
      // Neutralizing HERE (rather than post-hoc over the vendored files) is what
      // keeps the emitted .js and its .map self-consistent: esbuild generates both
      // from this patched source, so no byte offsets shift underneath the
      // sourcemap. Rewriting the vendored index.js afterwards left index.js.map's
      // `mappings` stream off by one column — clean .js, still-dirty worktree.
      //
      // ★ This is NOT "removing the stamp". The SHIPPED artifact keeps a real one:
      // daemon-cloud and daemon-standalone bundle daemon-core themselves, with
      // their own tsup `define`, and their dist/ is what carries the published
      // channel (asserted by assertPreviewBuildStamp / assertStableBuildStamp in
      // the deploy scripts). This bundle is the vendored MCP CLIENT, whose own
      // stamp is never published as a track identity — it is committed bytes that
      // must be reproducible. The `version` is pinned to daemon-core's own
      // package.json version for the same reason the commit hash is scrubbed:
      // a committed artifact cannot contain the identity of the release that
      // supersedes it.
      name: 'strip-daemon-build-stamp',
      setup(build) {
        const distIndex = path.resolve(__dirname, '../daemon-core/dist/index.js');
        // Pin the version stamp to daemon-core's package.json version.
        //
        // ★ Read from the WORKTREE, deliberately — not from git HEAD. A release is
        // exactly the case where they differ: scripts/version-bump.sh bumps every
        // package.json, re-syncs the vendor bundles and STAGES them, and only then
        // runs `npm run ci` (whose check:vendor rebuilds and diffs). Pinning to
        // HEAD there would bake the PRE-bump version into the freshly staged
        // bundles and fail the gate the bump exists to satisfy.
        //
        // The deploy's temporary rc rewrite is handled at the other end instead:
        // restoreNeutralVendorBuildState() in scripts/deploy-preview-local.mjs
        // rebuilds and re-vendors AFTER withTemporaryFileEdits has restored
        // package.json, so the rc version never survives in the committed copy.
        const daemonCoreVersion: string = JSON.parse(
          fs.readFileSync(path.resolve(__dirname, '../daemon-core/package.json'), 'utf8'),
        ).version;
        build.onLoad({ filter: /daemon-core[\\/]dist[\\/]index\.js$/ }, async (args) => {
          if (path.resolve(args.path) !== distIndex) return undefined;
          const src = await fs.promises.readFile(args.path, 'utf8');
          // Rewrite only the stamp reads emitted by build-info.ts.
          //
          // ★ The version was ORIGINALLY left alone here, on the reasoning that it
          // comes from package.json rather than git and is therefore already
          // reproducible. That reasoning held only while package.json was stable at
          // build time. It is not: `deploy:preview` TEMPORARILY rewrites every
          // package.json to the rc version (withTemporaryFileEdits in
          // scripts/deploy-preview-local.mjs) and builds daemon-core inside that
          // window, so the dist left on disk carries "1.0.60-rc.N" — and every
          // later vendor run copies it into the committed bundle. Pinning the
          // version to daemon-core's CURRENT package.json version below restores
          // the reproducibility the original comment assumed: after the deploy
          // restores package.json, a rebuild reproduces the committed bytes.
          //
          // ★ The short-hash pattern is ONE {7,40} range, not a {40} + {7,8} pair.
          // The pair left a hole at 9..39 chars, and the repo grew straight into
          // it: `git rev-parse --short HEAD` (build-stamp.mjs) emits git's
          // AUTO-SCALED abbreviation, whose length rises with the object count to
          // keep hashes unambiguous. This repo has crossed into 9 characters, so
          // the {7,8} branch silently stopped matching and a real hash began
          // surviving into the committed bundle — re-staling the vendor copy on
          // every commit and blocking the refine gate. A committed artifact can
          // never contain the hash of the commit containing it, so an unscrubbed
          // stamp is unfixable by any number of re-sync commits; only scrubbing
          // it at build time makes the bytes reproducible.
          //
          // Matching the full 7..40 range means no future abbreviation growth can
          // reopen this. Scrubbing is still strictly narrower than the enclosing
          // `readInjected(true ? "…" : void 0)` shape, so nothing but a build
          // stamp can be caught by it.
          const patched = src
            .replace(/__DAEMON_BUILD_COMMIT__\s*=\s*"[0-9a-f]{7,40}"/g, '__DAEMON_BUILD_COMMIT__ = "unknown"')
            .replace(/readInjected\(true \? "[0-9a-f]{7,40}" : void 0\)/g, 'readInjected(true ? "unknown" : void 0)')
            .replace(
              /readInjected\(true \? "\d{4}-\d{2}-\d{2}T[0-9:.]+Z" : void 0\)/g,
              'readInjected(true ? "unknown" : void 0)',
            )
            // Version stamp → daemon-core's own package.json version, so a deploy's
            // temporary rc rewrite cannot survive into the committed bundle.
            // Anchored on the `const <name> = readInjected(` shape emitted by
            // build-info.ts's version read; the commit/builtAt reads above are bare
            // `readInjected(...)` calls and are already rewritten, so they cannot
            // be caught here.
            .replace(
              /(\bconst version\d* = readInjected\(true \? )"[^"]*"( : void 0\))/g,
              `$1"${daemonCoreVersion}"$2`,
            );
          // ★ The CHANNEL stamp is deliberately NOT rewritten above.
          //
          // It is load-bearing in the shipped bundle. vendor/mcp-server/index.js is
          // the published runtime (daemon-standalone's `bin.adhdev-mcp` points
          // straight at it), and daemon-cloud spawns it with `{ ...process.env }` —
          // no explicit ADHDEV_CONFIG_DIR (packages/daemon-cloud/src/cli/
          // mcp-commands.ts). So when a user runs `adhdev-preview mcp` from a clean
          // shell, this bundle's own inlined resolveBuildTrack() is the only thing
          // deciding ~/.adhdev vs ~/.adhdev-preview. Neutralizing it would make a
          // preview MCP server silently read the stable config dir.
          //
          // It does not need rewriting for reproducibility either: the channel is ''
          // in every build EXCEPT one run with ADHDEV_BUILD_CHANNEL set, and the
          // deploy scripts scope that env to the publish commands — plus
          // restoreNeutralVendorBuildState() rebuilds it away afterwards. Pinning the
          // version above removes the drift that actually recurred.
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
        for (const spec of PINNED_SEQSCRIBE_DEPS) {
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
