# Changelog

All notable changes to ADHDev will be documented in this file.

## [0.8.33] - 2026-04-10

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.32] - 2026-04-10

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.31] - 2026-04-10

### Added
- 

### Fixed
- 

### Changed
- 
## [Unreleased]

### Changed
- Removed internal-only design notes from the public OSS docs set and normalized the remaining web-core UI copy/comments to English.

## [0.8.30] - 2026-04-10

### Fixed
- Auto-approve now works consistently across ACP, IDE, CLI, and extension-backed approval flows, with silent auto-approval history bubbles instead of approval alerts when auto-approve is enabled.
- Approval polling no longer surfaces transient `waiting_approval` UI states when the action was auto-approved immediately.

### Changed
- Enabled auto-approve by default for provider settings and added provider-specific positive-action hint matching so each provider can customize approval button selection priority.
## [0.8.29] - 2026-04-10

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.28] - 2026-04-09

### Added
- `adhdev service install / uninstall / status` — register the daemon as an OS-level auto-start service (macOS LaunchAgent, Windows Startup folder).
- Session host duplicate prune actions exposed through the daemon control plane.

### Fixed
- Codex extension session switching now works against the Recent tasks history view; `list_sessions` and `switch_session` flows validated.
- Codex CLI promoted to `partial` after validating fresh launch, live send/read, saved-session resume, daemon-restart reconnect, and stop.

### Changed
- Removed legacy `AccentColor` configuration field from daemon settings in favor of the existing CSS custom-property theme system.
## [0.8.27] - 2026-04-09

### Fixed
- Added the remaining mobile dashboard chat and launch-confirm updates that were left out of the `0.8.26` release.
- Surface reconnecting and connecting states in the mobile inbox and expose optional model/CLI argument inputs in the launch confirm dialog.

## [0.8.26] - 2026-04-09

### Fixed
- Standardized provider `sendMessage` payloads around `params.message` while preserving legacy string fallback for older routers.
- Hardened daemon provider-script dispatch so legacy IDE providers no longer leak `[object Object]` when receiving object params.
- Fixed terminal mux and mobile dashboard typing regressions that were blocking the OSS release build.

## [0.8.25] - 2026-04-09

### Fixed
- Reconcile live IDE and extension runtime sessions back into the daemon session registry so Codex child sessions recover without relying on a full daemon restart.
- Hard-fail session-scoped extension commands when `targetSessionId` is stale instead of falling back to string-based route guesses.
- Prefer active extension stream conversations over empty native IDE tabs in the dashboard so Codex chats open on the conversation that actually has messages.

## [0.8.24] - 2026-04-08

### Fixed
- Removed the xterm canvas fallback dependency from `terminal-render-web` so release builds no longer depend on the incompatible `@xterm/addon-canvas` + xterm 5 pairing.

## [0.8.23] - 2026-04-08

### Added
- Provider-driven controls, control values, effects, and notification routing for CLI/IDE/extension providers.
- CLI saved-session resume flow from both the machine page and the dashboard new-session dialog.
- Config-only terminal sizing escape hatch via `terminalSizingMode: "fit"` while keeping the dashboard GUI locked to the measured default.

### Fixed
- Standalone empty-state copy and machine-registration gating so install guidance only appears when no machines are registered.
- macOS Cursor launch/restart handling and process detection for standalone daemon IDE launch.
- Claude CLI parsing, startup state handling, generating hold behavior, restart transcript restore, and timestamp ordering for persisted chat history.
- Terminal renderer module loading so the xterm-based terminal initializes correctly under Vite dev/HMR.

### Changed
- Replaced `ghostty-web` with xterm.js-based terminal rendering with WebGL and DOM fallback paths.
- Made dashboard terminal sizing daemon-authoritative by default and removed frontend transcript re-parsing from chat rendering.
- Simplified CLI transcript rendering so providers own parsing and the web renderer only decides presentation from explicit metadata.

## [0.8.22] - 2026-04-08

### Added
- 

### Fixed
- 

### Changed
- 

## [0.8.21] - 2026-04-08

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.20] - 2026-04-08

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.19] - 2026-04-08

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.16] - 2026-04-08

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.15] - 2026-04-07

### Fixed
- **Windows CLI Isolation** — Lazy-load `node-pty` only when the local PTY backend is actually used, so session-host based CLI launches do not pull the native PTY module into the daemon process on Windows/Node 24.
- **Mobile PWA Header Insets** — Removed duplicate top safe-area padding on mobile chat and machine detail screens when running in standalone/PWA mode.

### Changed
- **Windows Node 24+ Standalone Guard** — Treat Windows + Node.js 24+ as unsupported for standalone install/startup until the PTY/session-host path is stable there.

## [0.8.14] - 2026-04-07

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.13] - 2026-04-07

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.12] - 2026-04-07

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.11] - 2026-04-07

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.10] - 2026-04-07

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.9] - 2026-04-07

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.8] - 2026-04-06

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.7] - 2026-04-06

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.6] - 2026-04-06

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.5] - 2026-04-06

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.4] - 2026-04-06

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.3] - 2026-04-06

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.2] - 2026-04-06

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.1] - 2026-04-05

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.0] - 2026-04-05

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.46] - 2026-04-05

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.45] - 2026-04-04

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.44] - 2026-04-04

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.43] - 2026-04-04

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.42] - 2026-04-04

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.41] - 2026-04-04

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.40] - 2026-04-04

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.39] - 2026-04-03

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.38] - 2026-04-03

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.37] - 2026-04-03

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.36] - 2026-04-03

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.35] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.34] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.33] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.32] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.31] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.30] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.29] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.28] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.27] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.26] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.25] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.24] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.23] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.22] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.21] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.17] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.16] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.15] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.14] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.6] - 2026-04-01

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.5] - 2026-04-01

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.4] - 2026-04-01

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.3] - 2026-04-01

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.2] - 2026-03-31

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.1] - 2026-03-31

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.0] - 2026-03-31

### Added
- 

### Fixed
- 

### Changed
- 
## [0.6.79] - 2026-03-31

### Added
- 

### Fixed
- 

### Changed
- 
## [0.6.77] - 2026-03-31

### Added
- 

### Fixed
- 

### Changed
- 
## [0.6.76] - 2026-03-31

### Added
- 

### Fixed
- 

### Changed
- 
## [0.6.75] - 2026-03-30

### Added
- 

### Fixed
- 

### Changed
- 
## [0.6.74] - 2026-03-30

### Added
- 

### Fixed
- 

### Changed
- 
## [0.6.73] - 2026-03-30

### Added
- 

### Fixed
- 

### Changed
- 
## [0.6.72] - 2026-03-30

### Added
- 

### Fixed
- 

### Changed
- 
## [0.6.71] - 2026-03-30

### Added
- 

### Fixed
- 

### Changed
- 
## [0.6.70] - 2026-03-30

### Added
- 

### Fixed
- 

### Changed
- 
## [0.6.69] - 2026-03-30

### Added
- 

### Fixed
- 

### Changed
- 
## [0.6.68] - 2026-03-30

### Added
- `scripts/version-bump.sh` — OSS-first version bump workflow
- Automated npm publish via CI on `v*` tags (daemon-core + daemon-standalone)

### Fixed
- Multi-window CDP detection: use `target.id` for stable manager keys
- Periodic scan no longer skips IDEs with existing connections (finds new windows)
- Extension settings now resolve correctly for multi-window manager keys

### Changed
- Provider loader: stable upstream directory independent of custom provider path
- DevServer: auto-load PROVIDER_GUIDE.md and CDP_SELECTOR_GUIDE.md for auto-implement
- Standalone daemon: enable provider hot-reload in `--dev` mode

## [0.6.67] - 2026-03-30

### Changed
- Replaced emoji icons with monochrome SVG components across settings and notification UI
- Updated `ToggleRow` to accept `ReactNode` labels for SVG icon support

### Fixed
- CI shebang verification for daemon-standalone build

## [0.6.66] - 2026-03-29

### Added
- ACP provider settings system with runtime hot-reload
- Provider clone/fix modals for machine detail page
- Version mismatch banner with one-click upgrade on dashboard
- `--help` flag support for daemon-standalone CLI

### Changed
- Improved agent stream polling with configurable intervals
- Enhanced status reporting with delta updates and heartbeat caching

## [0.6.65] - 2026-03-28

### Added
- Interactive terminal view with xterm.js for CLI agents
- Split-pane editor groups (up to 4 groups) with drag-to-resize
- Browser notification system with per-category toggles
- Sound effects for agent completion and approval events

### Fixed
- Dashboard routing for non-CLI agent types
- TUI artifact cleaning for chat history display
