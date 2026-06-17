# P0-1 — Seed Fidelity Verification (wterm vs xterm)

**Verdict: PASS.** The wterm (@wterm/ghostty libghostty WASM) renderer reproduces
the daemon's `formatVT` seed equivalently to the incumbent xterm renderer across
all tested cases, including the decisive **alt-screen full-screen TUI final state**
and **seed→reset→write→live-incremental cursor continuity**. P0-1 was the sole
real Phase-1 blocker; it is cleared.

## What was tested

`gen-daemon-seeds.test.ts` reproduces the daemon seed generator **byte-for-byte**:
identical `@xterm/xterm@6.0.0` + `@xterm/addon-serialize@0.14.0` (the exact deps
session-host-daemon uses) and the identical `serializeXtermViewport` logic
(`serialize({ range: {start,end}, excludeModes: true })` + trailing
`formatCursorRestore` `\x1b[r;cH`) from
`session-host-daemon/src/runtime.ts:146-161`. Output == live daemon `formatVT()`.

> Path chosen: **(b) faithful reproduction**, not (a) full standalone daemon.
> Rationale: the daemon's seed is produced by `createXtermMirror` = headless
> xterm + addon-serialize. Reproducing that with identical versions/options is
> byte-equivalent to capturing a live `get_snapshot` (no `sinceSeq`) response,
> without the flakiness of building native ghostty-vt-node + authenticating a
> real CLI agent. The `__testing.createXtermMirror` export and the existing
> `runtime-snapshot.test.ts` confirm this is exactly how the daemon serializes.

Seeds (`seeds.json`) replayed via the production seed path
(`reset()` → `write(seedAnsi)` → optional `write(liveAnsi)`, mirroring
`CliTerminalPane.tsx:254,257,258` + live continuation) into BOTH backends, then
screenshotted in headless Chrome (CDP). Evidence: `evidence/seed-<case>-<backend>.png`.

## Cases & results

| Case | What it exercises | wterm vs xterm |
|---|---|---|
| **sgr_basic** | SGR fg/bg, 256-color, bold/italic/underline/reverse, CRLF rows | PASS — all attributes render; only palette-shade differs (theme, P0-2) |
| **scrollback_strip** | active-viewport-only seed (no stale scrollback replay) | PASS — identical 4-row viewport, red `CLAUDE` |
| **altscreen_box** ★ | enter alt-screen (`?1049h`) + boxed full-screen TUI final state + cursor parked mid-box; seed also contains pre-altscreen noise bytes | PASS — box lines/colors/layout match; cursor at same mid-box cell; **NO stale-logo duplication** (the runtime.ts:213-218 failure mode does NOT reproduce — libghostty honors `?1049h`+clear) |
| **cursor_continuity** ★ | trailing cursor-restore `\x1b[r;cH` then live-incremental relative write must land on the right row, with correct SGR on overwritten cells | PASS — live chunk lands on identical row/col in both; `done`=green, `ing`=yellow in BOTH (verified via DOM span colors, not just eye) |

### Color note (investigated, not a defect)
In `cursor_continuity` the wterm screenshot's green initially read as "yellow" by
eye. DOM span-color probe disproved it:
- xterm `done` = `rgb(166,227,161)` (catppuccin green), `ing` = `rgb(249,226,175)` (yellow)
- wterm `done` = `rgb(181,189,104)` (wterm-default-theme green), `ing` = `rgb(240,198,116)` (yellow)

Both apply green to the live-overwritten `done` and retain yellow on the
non-overwritten `ing`. **SGR-state handoff is correct in wterm.** The shade
difference is the default `@wterm/dom` palette vs ADHDev's catppuccin — a
theme-variable mapping task (P0-2), not a parser bug.

## Reproduce

```bash
# 1. regenerate daemon-equivalent seeds
npx tsx --test oss/packages/terminal-render-web/poc-playground/gen-daemon-seeds.test.ts
# 2. serve playground
node_modules/.bin/vite --config oss/packages/terminal-render-web/poc-playground/vite.config.ts
# 3. open per case/backend:
#    http://localhost:5199/seed-test.html?case=altscreen_box&backend=wterm
#    http://localhost:5199/seed-test.html?case=altscreen_box&backend=xterm
```

## Conclusion

P0-1 **PASS** — proceed to P0-2 (load `@wterm/dom/css` + map ADHDev theme vars)
and the settings-panel opt-in toggle. No alt-screen/cursor blocker found. The
remaining gaps from the scoping report are all known-fix (CSS/theme, fontSize,
measured-resize, web-standalone manualChunks) — none are seed-fidelity blockers.
