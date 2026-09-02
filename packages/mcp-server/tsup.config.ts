import * as path from 'node:path';
import { defineConfig } from 'tsup';

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
  esbuildOptions(options) {
    // esbuild resolves a workspace package through its `exports` map, which for
    // daemon-core points at dist/. Alias the barrel and the subpaths explicitly
    // so the bundle pulls from the freshly built dist rather than depending on
    // node_modules symlink layout. Exact-match only — each subpath needs its
    // own entry (same constraint daemon-standalone's config documents).
    const daemonCore = path.resolve(__dirname, '../daemon-core/dist');
    options.alias = {
      ...(options.alias || {}),
      '@adhdev/daemon-core': path.join(daemonCore, 'index.js'),
      '@adhdev/daemon-core/mesh/transcript-read-model-consumers': path.join(
        daemonCore,
        'mesh/transcript-read-model-consumers.js',
      ),
    };
  },
});
