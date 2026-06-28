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

## Producing / refreshing a prebuilt

Build on the **target platform/arch** (cross-builds are not wired here) with the
toolchain present (`cmake`, a C/C++ compiler, and `zig` for `libghostty`; set
`ZIG_EXECUTABLE` if zig is not on `PATH`):

```bash
# Build for the running platform-arch and emit it into prebuilt/<triplet>/
ADHDEV_GHOSTTY_VT_EMIT_PREBUILT=1 npm run build -w oss/packages/ghostty-vt-node

# Then keep the node137-named dir (per ABI-portability) and commit it:
#   git add oss/packages/ghostty-vt-node/prebuilt/<platform>-<arch>-node137/
```

Because the output is ABI-portable, you only need to build **once per
platform/arch**; rename/keep the directory as the `node137` triplet and the
runtime fallback covers all other Node versions on that platform.

- macOS arm64 and Linux x64 can be produced on the corresponding native runner.
- Windows x64 must be built on a Windows runner (MSVC; see the `if(MSVC)` block in
  `CMakeLists.txt` for the required dynamic-CRT link flags).

## Skipping the native build

Set `ADHDEV_SKIP_GHOSTTY_VT_BUILD=1` to skip compilation when no prebuilt matches
(useful in environments that intentionally run without the terminal backend).
