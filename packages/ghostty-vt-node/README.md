# @adhdev/ghostty-vt-node

Native Node binding for `libghostty-vt` — exposes a headless ghostty virtual
terminal (`createTerminal`) used by daemon-core's `GhosttyVtTerminalBackend`.

## ABI portability (read this first)

The addon is a pure **Node-API (N-API)** binding (it exports
`napi_register_module_v1`). N-API is **ABI-stable across Node major versions**, so
a single compiled `.node` loads on every Node runtime that supports the N-API
version it targets — **independent of `process.versions.modules`**
(`NODE_MODULE_VERSION`, a.k.a. the "ABI" number: 115 ≈ node20, 127 ≈ node22,
137 ≈ node24).

Practically: you do **not** need a separate native build per Node version. The
per-`nodeNNN` directory names under `prebuilt/` are an addressing convenience, not
a hard requirement — the binaries are byte-identical per platform/arch.

### Why prebuilts are committed

`prebuilt/` is committed to git (only the `*-node137` triplet per platform) so
that worktree/CI clones load the binding **without a build toolchain**. A clone
with no committed prebuilt would fall through to compiling from source
(cmake-js + zig + a `libghostty` fetch); when that toolchain is absent the loader
throws `ghostty-vt binding unavailable`, which previously surfaced as an
environment blocker on node24/ABI137 runners.

Shipped triplets:

```
prebuilt/darwin-arm64-node137/   # macOS Apple Silicon
prebuilt/linux-x64-node137/      # Linux x64
prebuilt/win32-x64-node137/      # Windows x64
```

## Loader resolution order (`index.js`)

1. `ADHDEV_GHOSTTY_VT_PREBUILT_DIR/<triplet>/ghostty_vt_node.node` (explicit override)
2. `ADHDEV_GHOSTTY_VT_PREBUILT_DIR/ghostty_vt_node.node`
3. `build/Release` or `build/Debug` (a local compile)
4. `prebuilt/<exact-triplet>/ghostty_vt_node.node`
5. **N-API fallback** — any `prebuilt/<platform>-<arch>-node*/ghostty_vt_node.node`
   for the same platform/arch (this is what makes a brand-new ABI such as a
   future node26 work without shipping a new directory).

If nothing loads, the thrown error **names the running triplet and the list of
available prebuilt triplets**, so an environment-blocker report is precise:

```
Unable to load @adhdev/ghostty-vt-node native binding for running triplet
"darwin-arm64-node137". Available prebuilt triplets: [darwin-arm64-node137,
linux-x64-node137, win32-x64-node137]. ...
```

## Viewport / cursor / cell reads (API level 2)

Each terminal handle also exposes an exact-read API. All rows and the cursor are
in an explicit coordinate space; nothing is derived from formatter strings.

- `getViewport({ includeRows: 'none' | 'cursor' | 'all', cells })` — one native
  snapshot: `cursorRow`/`cursorCol` (ACTIVE space), `activeScreen`
  (`'primary'`/`'alternate'`), `scrollbar` (`total`/`offset`/`len`), the derived
  `scrollbackRows` / `activeOriginRow` / `viewportOriginRow` /
  `viewportScrollbackOffset` / `cursorViewportRow`, a per-terminal `revision`,
  and the requested ACTIVE rows. Metadata and rows come from the same call.
- `readRow(row, { space: 'active' | 'viewport', cells, expectedRevision })` — one
  row with `wrapped` / `wrapContinuation`; with `cells`, exactly `cols` cells of
  `{ col, text, width, wideKind }` (`text` is the full stored grapheme).
- `scrollViewport('top' | 'bottom' | delta)` — moves the VIEWPORT only; ACTIVE
  rows and `cursorRow` do not change.

**ACTIVE vs VIEWPORT.** ACTIVE is the rows x cols area the cursor moves in.
VIEWPORT is what is visible and differs only while scrolled into history.
`formatPlainText()` output is SCREEN-origin (history + active, trailing blank
rows dropped): the cursor's row is at index `activeOriginRow + cursorRow` there,
not at `cursorRow`. The legacy `formatPlainText` / `formatVT` /
`getCursorPosition` outputs are unchanged (see `test/fixtures/legacy-golden.json`).

**Feature detection.** A binary built before API level 2 still loads and serves
the legacy methods but has no `getViewport`/`readRow`/`scrollViewport`. Check
`require('@adhdev/ghostty-vt-node').capabilities.viewport` (or `typeof
handle.getViewport === 'function'`) and treat exact reads as unavailable —
never fall back to guessing from formatter output. `bindingInfo` reports the
loaded binary's `apiLevel`, embedded `sourceDigest` and `ghosttyRevision`.

Every method on a terminal handle owns a share of the native state, so a method
taken off the handle (`const get = t.getViewport`) keeps working after the
handle is garbage-collected; the terminal is freed when the last of them is.
After `dispose()` every method throws `ERR_GHOSTTY_DISPOSED`.

## Producing / refreshing a prebuilt

Build on the **target platform/arch** (cross-builds are not wired here) with the
toolchain present (`cmake`, `git`, a C/C++ compiler, and the zig version pinned
in `toolchain.json` for `libghostty`; set `ZIG_EXECUTABLE` if zig is not on
`PATH`).

The configure step verifies the build's provenance and fails on any problem:
ghostty must come from the FetchContent-managed clone (a
`FETCHCONTENT_SOURCE_DIR_GHOSTTY` substitute or a `GHOSTTY_GIT_TAG` override is
refused) at the pinned revision with a clean tree; `zig version` must print
exactly the `toolchain.json` version (only surrounding whitespace is trimmed);
and `GHOSTTY_ZIG_BUILD_FLAGS` must be empty. Upstream's CMake wrapper is not
used: the `adhdev_ghostty_runtime` target runs `zig build` itself on every
build, with a private global cache, local cache and install prefix inside the
build tree (`build/ghostty-zig/`; passed as `--global-cache-dir`, `--cache-dir`
and `--prefix`, so `ZIG_GLOBAL_CACHE_DIR` / `ZIG_LOCAL_CACHE_DIR` are ignored),
and re-verifies the pinned, clean source before and after. For a release build
configure empties those caches first, so every dependency is fetched afresh
(zig verifies its package hash on fetch) and everything is compiled from
scratch: a stale `zig-out/`, a reused build directory or a poisoned shared zig
cache cannot reach the shipped runtime. What this does NOT cover: the zig
installation itself (only its version is checked) and concurrent writers.
The checks are check-then-use, so a release build needs exclusive ownership of
its build tree, the ghostty clone and the zig installation for the whole
configure + build; build release prebuilts where no other process writes to
them. For local experiments only, `ADHDEV_GHOSTTY_UNVERIFIED_DEV_BUILD=1` turns
a failure into a warning, and ALWAYS makes the build non-release: the binary
reports `releaseEligible: false` with its problem codes (at least
`unverified-dev-build`), and every release gate refuses it (`non-release`). The
addon also records the zig version, C/C++ compiler id and version, and build
type (`getBindingInfo()`, copied into the manifest).
`scripts/probe-build-provenance.mjs <dir>` exercises all of this against a
configured build in `<dir>/build`: stale runtime, poisoned ambient and private
zig caches (including a control showing the poison breaks a build that keeps
them), reconfigure, source edit, dev override, zig output parsing and source
override. It rebuilds twice from empty caches, so it needs network access and
about 1 GiB of free disk. Two fresh builds differ only in per-build debug
metadata (cache object paths, mtimes, image id, signature), so it compares
runtimes from different builds by their loaded sections.

```bash
# Compile from source and emit into the committed prebuilt for this
# platform-arch (prebuilt/<platform>-<arch>-node137/, whatever Node version runs
# the build), stamping prebuilt/<triplet>/manifest.json from the built binary:
ADHDEV_GHOSTTY_VT_FORCE_COMPILE=1 ADHDEV_GHOSTTY_VT_EMIT_PREBUILT=1 npm run build -w oss/packages/ghostty-vt-node

# Or, after any build: copy build/Release into the committed triplet + stamp
node oss/packages/ghostty-vt-node/scripts/prebuilt-manifest.mjs emit

# Verify exactly that directory, then the whole set
node oss/packages/ghostty-vt-node/scripts/verify-prebuilt.mjs oss/packages/ghostty-vt-node/prebuilt/<triplet>
node oss/packages/ghostty-vt-node/scripts/check-prebuilts.mjs
```

With `ADHDEV_GHOSTTY_VT_FORCE_COMPILE=1` the build is a clean `cmake-js
rebuild` (fresh configure and clone). Without it, `npm run build` keeps an
existing local build or copies a usable prebuilt, or compiles incrementally
(`--plan` prints which it would do).

Binaries embed absolute build paths (the private zig caches live in the build
tree), so a prebuilt you commit must be built outside any home directory, from
a fresh clone of the commit being stamped. Copy the package to a neutral
directory and point `HOME` there for cmake-js' Node headers (shown for
macOS/Linux; on Windows use e.g. `C:\gvn` and `C:\gvn-home` for
`HOME`/`USERPROFILE`, with zig installed outside the user profile). The zig
caches need no setup: the build always uses fresh private ones. Do not set
`FETCHCONTENT_SOURCE_DIR_GHOSTTY`, `GHOSTTY_GIT_TAG`, `GHOSTTY_ZIG_BUILD_FLAGS`
or `ADHDEV_GHOSTTY_UNVERIFIED_DEV_BUILD`, and let nothing else write to these
directories during the build:

```bash
rm -rf /tmp/gvn /tmp/gvn-home && mkdir -p /tmp/gvn/node_modules /tmp/gvn-home
rsync -a --exclude node_modules --exclude prebuilt --exclude build oss/packages/ghostty-vt-node/ /tmp/gvn/
cp -R oss/node_modules/node-addon-api /tmp/gvn/node_modules/   # or the package-local copy
(cd /tmp/gvn && HOME=/tmp/gvn-home node "$OLDPWD/oss/node_modules/cmake-js/bin/cmake-js" rebuild)
node oss/packages/ghostty-vt-node/scripts/probe-build-provenance.mjs /tmp/gvn   # optional, expect 13/13
node oss/packages/ghostty-vt-node/scripts/prebuilt-manifest.mjs emit /tmp/gvn/build/Release
node oss/packages/ghostty-vt-node/scripts/check-prebuilts.mjs
```

- macOS arm64 and Linux x64 can be produced on the corresponding native runner.
- Windows x64 must be built on a Windows runner (MSVC; see the `if(MSVC)` block in
  `CMakeLists.txt` for the required dynamic-CRT link flags).

### Release-safety gate (`scripts/check-prebuilts.mjs`)

CMake embeds a **binding source digest** (sha256 over `CMakeLists.txt`,
`toolchain.json` and `src/*`, LF-normalized; `scripts/binding-digest.mjs`
reproduces it) and the build provenance into the addon. Each shipped prebuilt
carries a `manifest.json` (schema 2) stamped from the binary itself plus file
hashes. The gate fails unless:

- (a) all three shipped triplets carry a manifest matching the current digest,
  API level, ghostty pin and zig pin, with matching file hashes, stamped as a
  release build from the pinned, clean ghostty checkout. A triplet built from
  older sources, another zig, or an older manifest schema reports
  **pending-rebuild**: after any bridge/addon/toolchain change the tree is not
  shippable until every platform is rebuilt and re-stamped. Without loading
  anything (release CI runs on Linux), the manifest's platform/arch must match
  the directory, the platform's runtime set must be complete (darwin: addon +
  `libghostty-vt.dylib` + `libghostty-vt.X.Y.Z.dylib`; linux: addon +
  `libghostty-vt.so`, `.so.0`, `.so.0.X.Y`; win32: addon + `ghostty-vt.dll`),
  and every file must be a thin Mach-O arm64 / ELF x86-64 (SONAME
  `libghostty-vt.so.0`, NEEDed by the addon) / PE32+ x64 DLL
  (`scripts/native-format.mjs`).
- (b) the host platform's committed prebuilt, loaded by path, embeds the
  current digest and release provenance, and its viewport API behaves.
- (c) the native CI build compiles from source (`ADHDEV_GHOSTTY_VT_FORCE_COMPILE`)
  as a clean `cmake-js rebuild` with the zig read from `toolchain.json` and no
  restored zig cache (`setup-zig` `use-cache: false`, no `ZIG_*_CACHE_DIR`),
  verifies + stamps the exact staged
  artifact, and the release job checks every prebuilt it publishes
  (`--all-present`).
- (d) no shipped native file (`.node`/`.dylib`/`.so*`/`.dll`) embeds a
  home-directory path (`/Users/<name>/`, `/home/<name>/`, `X:\Users\<name>\`),
  scanned as raw bytes in ASCII and UTF-16LE (`scripts/host-path-scan.mjs`; CI
  accounts `runner`/`runneradmin` are allowed). Build prebuilts from a neutral
  directory with a neutral zig cache (`ZIG_GLOBAL_CACHE_DIR`). Extra literals
  (hostnames) can be denied from an untracked file named by
  `ADHDEV_GHOSTTY_HOST_PATH_DENYLIST` or `.host-path-denylist` in this package.
  `verify-prebuilt.mjs` runs the same scan on the directory it verifies.

## Skipping the native build

Set `ADHDEV_SKIP_GHOSTTY_VT_BUILD=1` to skip compilation when no prebuilt matches
(useful in environments that intentionally run without the terminal backend).
