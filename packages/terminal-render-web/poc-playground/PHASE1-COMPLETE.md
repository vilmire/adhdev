# wterm Renderer — Phase 1 (production-grade opt-in) COMPLETE

Strategy: keep the daemon mirror on xterm (no custom serializer); make the
**front-end terminal renderer** swappable to @wterm/ghostty (libghostty WASM) as
an opt-in. The xterm renderer and handle are untouched and remain the default.

## Gaps closed

| ID | Gap | Status |
|----|-----|--------|
| P0-1 | Daemon `formatVT` seed fidelity (alt-screen TUI, cursor restore) | PASS (prior session) |
| P0-2a | `@wterm/dom` CSS not loaded → no scroll / no selection styling | DONE — import the `.css` |
| P0-2b | ADHDev catppuccin theme parity | DONE — `--term-color-*` vars + a core proxy remapping libghostty's baked Tomorrow-Night palette RGB → catppuccin (the WASM resolves ANSI to RGB internally, bypassing CSS vars for live output) |
| P1-3 | fontSize not wired | DONE — `--term-font-size` + reflow on change |
| P1-4 | measured-mode resize | DONE — container ResizeObserver → per-char measure → core resize; pin-to-bottom across frames so reflow doesn't blank the viewport |
| P1-5 | selection/copy | DONE — native browser selection scoped to the terminal (verified returns real glyph text) |
| P1-6 | clear/reset | DONE — RIS (`ESC c`); alt-screen reset confirmed by P0-1 |
| P1-7 | write onProcessed | DONE — fires synchronously after wterm parse |
| P2 | web-standalone manualChunks pulled wterm into the eager chunk | DONE — separate `terminal-wterm` chunk; dynamic-imported; 0 `@wterm` in eager chunk (web-cloud too) |
| Ship | settings opt-in toggle | DONE — shared `TerminalRendererSection` (web-core) wired into web-cloud + web-standalone settings; default xterm |
| Dev | ghostty WASM 404/magic-word in dev | DONE — `optimizeDeps.exclude` @wterm/* + `fs.allow` repo root |

## Live verification (real standalone, real CLI session)

Standalone daemon (`:3847`) + web-standalone (`:3000`), a real `claude-cli`
session, renderer toggled to wterm via the settings key:

- **wterm**: `renderer=wterm-ghostty`, the live **Claude Code v2.1.170 welcome
  TUI** (rounded box, mascot art, colored tips, `>` prompt, "plan mode on",
  "Update available!") renders through libghostty — 3148 chars of real session
  output. See `evidence/live-standalone-wterm-claude-cli.png`.
- **xterm** (default): `renderer=dom`, same session renders unchanged. See
  `evidence/live-standalone-xterm-claude-cli.png`.
- WASM served `200 application/wasm` (428KB); production builds emit it as a
  separate hashed asset and the wterm JS is dynamic-imported, so default-xterm
  users load **zero** wterm JS/WASM.

Also verified: seed fidelity (P0-1 re-captured with catppuccin parity — DOM span
colors match xterm exactly), scroll/scrollToTop, fontSize reflow (44×11 @20px),
measured width reflow (27×11), native selection, settings-toggle loop
(localStorage → selectTerminalRendererBackend → renderer).

## Reproduce

```bash
npm run build -w oss/packages/daemon-core   # + mesh-shared, session-host-core/daemon
npx tsx oss/packages/daemon-standalone/src/index.ts --dev --no-open   # :3847
npm run dev -w oss/packages/web-standalone -- --port 3000 --strictPort  # :3000
# Settings → Appearance → Terminal → enable "Experimental Ghostty renderer", reload.
```
