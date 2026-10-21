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

## Producing / refreshing a prebuilt

Build on the **target platform/arch** (cross-builds are not wired here) with the
toolchain present (`cmake`, a C/C++ compiler, and `zig` 0.15.2 for `libghostty`;
set `ZIG_EXECUTABLE` if zig is not on `PATH`):

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

Without `ADHDEV_GHOSTTY_VT_FORCE_COMPILE=1`, `npm run build` keeps an existing
local build or copies a usable prebuilt instead of compiling (`--plan` prints
which it would do).

- macOS arm64 and Linux x64 can be produced on the corresponding native runner.
- Windows x64 must be built on a Windows runner (MSVC; see the `if(MSVC)` block in
  `CMakeLists.txt` for the required dynamic-CRT link flags).

### Release-safety gate (`scripts/check-prebuilts.mjs`)

CMake embeds a **binding source digest** (sha256 over `CMakeLists.txt` and
`src/*`, LF-normalized; `scripts/binding-digest.mjs` reproduces it) into the
addon. Each shipped prebuilt carries a `manifest.json` stamped from the binary
itself plus file hashes. The gate fails unless:

- (a) all three shipped triplets carry a manifest matching the current digest,
  API level and ghostty pin, with matching file hashes. A triplet built from
  older sources reports **pending-rebuild**: after any bridge/addon change the
  tree is not shippable until every platform is rebuilt and re-stamped.
- (b) the host platform's committed prebuilt, loaded by path, embeds the
  current digest and its viewport API behaves.
- (c) the native CI build compiles from source (`ADHDEV_GHOSTTY_VT_FORCE_COMPILE`)
  and verifies + stamps the exact staged artifact, and the release job checks
  every prebuilt it publishes (`--all-present`).

## Skipping the native build

Set `ADHDEV_SKIP_GHOSTTY_VT_BUILD=1` to skip compilation when no prebuilt matches
(useful in environments that intentionally run without the terminal backend).
