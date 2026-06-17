# @wterm/ghostty Phase0 PoC

Experimental, opt-in alternative terminal renderer backed by
[`@wterm/ghostty`](https://www.npmjs.com/package/@wterm/ghostty) (browser
libghostty — Ghostty's VT core compiled to WASM + a DOM grid renderer from
`@wterm/dom`). This is a **proof of concept**, not a replacement. The proven
xterm.js renderer (`GhosttyTerminalView`) is unchanged and remains the default.

## What was added

- `src/types.ts` — shared `TerminalRendererHandle` / `GhosttyTerminalViewProps`
  (extracted from `index.tsx`, re-exported for back-compat).
- `src/wterm-view.tsx` — `WtermTerminalView`, same handle/props contract as the
  xterm renderer, driving `@wterm/dom`'s `WTerm` with a `GhosttyCore`.
- `index.tsx` — `TerminalView` dispatcher + `selectTerminalRendererBackend()`
  (localStorage `adhdev:terminalRenderer` → Vite `VITE_TERMINAL_RENDERER` →
  `'xterm'` default). The wterm backend is `React.lazy`-code-split so its ~428KB
  WASM never loads unless selected.
- `CliTerminal.tsx` (web-core) now loads `TerminalView` instead of
  `GhosttyTerminalView` directly.

## Run the playground

```bash
# from repo root
node_modules/.bin/vite --config oss/packages/terminal-render-web/poc-playground/vite.config.ts
# open http://localhost:5199/            (wterm-ghostty backend)
# open http://localhost:5199/?backend=xterm   (xterm backend)
```

The playground feeds a representative byte stream (SGR colors, 256-color,
box-drawing, unicode/emoji, CRLF, cursor) through the renderer's `write()` API —
the same path the dashboard uses.

## Live verification result (PASS)

Both backends render the same feed in a real browser DOM (headless Chrome via
CDP):

- `?backend=wterm` → `[terminal-render-web] renderer=wterm-ghostty`,
  `data-terminal-renderer="wterm-ghostty"`, DOM = `.term-grid > .term-row >
  <span style="color:rgb(...);font-weight:bold">` — full SGR + true-color +
  emoji rendered. See `evidence/wterm-ghostty-render.png`.
- `?backend=xterm` → `renderer=dom`, `.xterm` DOM, same feed — unchanged.

WASM (428KB) loads 200 via Vite `new URL(..., import.meta.url)`; only 404 is
`favicon.ico`.

## Blocker findings

**(a) feed-data API fit / 0.x stability — PASS (with caveats).**
`WTerm.write(string | Uint8Array)` maps cleanly to our `write(data)` byte feed;
`onData` → `onInput`. BUT the package set is split across `@wterm/core` +
`@wterm/dom` + `@wterm/ghostty` + (`@wterm/react`), all pinned to a single
`0.3.0` release with **no version range** published (v0.2.1 from earlier scouting
is already gone). API surface is far thinner than xterm: no `clear`/`reset`
(emulated via RIS `ESC c`), no `scrollToTop`, no selection model, no fit addon.
High churn risk.

**(b) addon-serialize equivalent — FAIL (decisive).**
`session-host-daemon` runs **headless xterm in Node** with
`@xterm/addon-serialize` to emit an **ANSI escape string** replaying the viewport
(the full-screen-TUI splash-skip mechanism). `@wterm/ghostty` offers no
`serialize()`. Its `TerminalCore` exposes only **cell reads** (`getCell`,
`getScrollbackCell`, `getViewport` → packed 16-byte cell structs). The WASM core
*does* instantiate headless in Node (DOM-free; only the `fetch`-based loader and
`WTerm` DOM renderer are browser-bound), so a Node port is theoretically
possible — but matching addon-serialize would require **writing a cell→SGR
serializer ourselves** (true-color fg/bg, flag→SGR, cursor restore). That is net
new code with no upstream support.

## Phase0 conclusion: conditional FAIL

- **Front-end renderer swap (terminal-render-web): feasible.** The wterm DOM
  renderer drops into our handle contract and renders live. If we wanted browser
  libghostty for the dashboard view alone, it works today (modulo missing
  clear/scroll/selection ergonomics and 0.x churn).
- **session-host-daemon mirror swap: not feasible** without building our own
  cell→ANSI serializer and a headless Node loader. The addon-serialize seam — the
  whole reason xterm exists in the daemon — has **no @wterm/ghostty equivalent**.

Since the daemon mirror is the load-bearing reason xterm is in the tree (and the
front-end already routes through the authoritative `ghostty-vt-node` parser
server-side), Phase0 does not clear the bar for a full replacement. Recommend
**keeping the xterm path** and only revisiting if (1) wterm reaches a stable 1.x
with a serialize/headless story, or (2) we decide the dashboard-only DOM
renderer benefit (selection/accessibility) justifies maintaining two renderers.
