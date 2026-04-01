# libghostty-vt Integration Notes

We use `TerminalScreen` in [provider-cli-adapter.ts](../packages/daemon-core/src/cli-adapters/provider-cli-adapter.ts)
purely as a VT parser + screen snapshot model. This is the same layer that
`libghostty-vt` is designed to replace.

## Current state

- Default backend: `auto`
  - prefer `ghostty-vt` when the native binding is installed
  - fall back to `xterm` otherwise
- Optional backend selector: `ADHDEV_TERMINAL_BACKEND=ghostty-vt`
- Force legacy backend: `ADHDEV_TERMINAL_BACKEND=xterm`
- Auto binding lookup:
  - `ADHDEV_GHOSTTY_VT_BINDING=<module-or-path>`
  - fallback package name: `@adhdev/ghostty-vt-node`
- Native workspace package: [packages/ghostty-vt-node](../packages/ghostty-vt-node)

If `ADHDEV_TERMINAL_BACKEND=ghostty-vt` is set and no binding is available,
daemon startup fails fast instead of silently drifting back to a different
parser. If the backend is left at the default `auto`, we prefer Ghostty and
quietly fall back to xterm only when the native binding is unavailable.

## Binding contract

The Node binding only needs to expose one factory:

```ts
createTerminal(options: {
  cols: number;
  rows: number;
  scrollback: number;
}): {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  formatPlainText(options?: { trim?: boolean }): string;
  dispose(): void;
}
```

This mirrors the official `libghostty-vt` examples:

- `ghostty_terminal_new(...)`
- `ghostty_terminal_vt_write(...)`
- `ghostty_formatter_terminal_new(...)`
- `ghostty_formatter_format_alloc(...)`

Useful upstream references:

- `ghostty-org/ghostling` main.c: minimal libghostty terminal embedding
- `ghostty-org/ghostling#6`: Windows ConPTY wiring around the same C API

## Why this layer first

`libghostty-vt` does not provide runtime/session management. We already handle
that in `adhdev-sessiond`. The first safe integration point is only:

- VT parsing
- terminal state
- plain text formatting for provider scripts

That lets us evaluate correctness and performance without entangling the
session-host work.

## Current native package

`packages/ghostty-vt-node` is a minimal Node addon built with:

- `cmake-js`
- `node-addon-api`
- `FetchContent(ghostty)` at build time

It exposes only:

- `createTerminal`
- `write`
- `resize`
- `formatPlainText`
- `dispose`

This is intentionally narrower than the full C API. It matches exactly what
`TerminalScreen` needs today.

### Build prerequisites

- `cmake`
- `zig`
- a C/C++ toolchain supported by CMake

Example:

```sh
npm install -w packages/ghostty-vt-node
npm run build -w packages/ghostty-vt-node
```

Then:

```sh
ADHDEV_TERMINAL_BACKEND=ghostty-vt npm run dev:daemon
```
