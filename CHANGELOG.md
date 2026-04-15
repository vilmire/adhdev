# Changelog

All notable changes to ADHDev will be documented in this file.

## [0.8.63] - 2026-04-16

### Fixed
- Fixed the shared web-core status-transform typing so merged session `activeChat` state always normalizes to `null` instead of leaking `undefined`, unblocking downstream cloud/web builds during release verification.

### Changed
- Followed up the `v0.8.62` standalone CLI/dashboard fixes with a release-compatibility patch so the same shared surfaces build cleanly in downstream cloud consumers.

## [0.8.62] - 2026-04-16

### Added
- Added focused regression coverage for Hermes CLI waiting-state parsing, standalone compact session control metadata, CLI view-mode overrides, and dashboard conversation refresh invalidation.

### Fixed
- Fixed Hermes CLI turn completion handling so waiting-state providers keep long-running responses open until detectStatus truly settles and parse/detect scripts can see `isWaitingForResponse`.
- Fixed shared standalone/dashboard CLI conversations so top-level CLI and ACP sessions preserve controls/chat metadata and completed replies appear in chat view without requiring a terminal/chat toggle refresh.

### Changed
- Tightened shared standalone status merging and dashboard conversation caching so live session snapshots preserve richer active-chat state more reliably.

## [0.8.61] - 2026-04-15

### Added
- Added shared chat-message normalization/builders plus provider-effect persistence helpers so richer semantic kinds can be emitted and preserved consistently across daemon-core provider categories.
- Added regression coverage for chat-message normalization, CLI fallback message shaping, provider-effect persistence, command-output rendering, and live chat-cache refresh behavior.

### Fixed
- Fixed CLI/IDE/extension/ACP runtime plumbing so richer message kinds such as `tool`, `terminal`, `thought`, and `system` are no longer collapsed during runtime merge/persistence paths.
- Fixed shared dashboard command-output/chat surfaces so fuller tool/terminal output and fresher live conversation copies survive cache merges and render without unintended clipping.

### Changed
- Unified shared daemon-core/web-core message-kind handling around reusable builders and richer effect-bubble metadata instead of ad-hoc per-provider literals.

## [0.8.60] - 2026-04-15

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.59] - 2026-04-15

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.58] - 2026-04-14

### Added
- Added richer saved-history continuity helpers across shared web surfaces, including selected-session summaries, recent-launch saved-history cues, compact recent-use timestamps, text/workspace/model filters, sort controls, and resume-ready-only filtering.
- Added first-class shared utilities and regression coverage for saved-history filtering/state, recent-launch presentation, and wrapped workspace-browse responses.

### Fixed
- Fixed hosted web CLI terminal input routing by accepting the actual session target id consistently across PTY input and resize paths.
- Fixed workspace browsing in cloud-backed launch flows by unwrapping wrapped command-envelope responses before reading directory entries.

### Changed
- Refined shared dashboard/machine/mobile continuity UX so saved-history search/filter/sort state persists across reopen flows within the same scope and normal resume paths stay subtle but easier to scan.
## [0.8.57] - 2026-04-14

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.56] - 2026-04-14

### Fixed
- Kept the standalone/published runtime surface coherent by using `runtimeTarget`-style targeting and clearer attach vs recover behavior for hosted runtime commands.

### Changed
- Made ordinary CLI launches fresh by default while keeping saved-history resume and hosted runtime recovery explicit.
- Unified runtime, dashboard, and machine wording around `Start fresh`, `Resume saved history`, `Recover hosted runtime`, and `Saved History`.
## [0.8.55] - 2026-04-14

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.54] - 2026-04-14

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.53] - 2026-04-14

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.52] - 2026-04-13

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.51] - 2026-04-13

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.50] - 2026-04-13

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.49] - 2026-04-13

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.48] - 2026-04-13

### Added
- Added Hermes CLI provider control confirmations and session-reset handling so dashboard actions can safely trigger `new`, `retry`, and `undo`-style commands.

### Fixed
- Preserved CLI provider session metadata and cleared dashboard transcript state correctly when providers signal a fresh session.

## [0.8.47] - 2026-04-12

### Fixed
- Stabilized Claude Code VS Code webview targeting and preserved more live session control metadata across status refreshes.

### Changed
- Refreshed OSS and standalone documentation to match the current self-hosted runtime, session-host, mux, and local API surfaces.

## [0.8.46] - 2026-04-12

### Changed
- Refined dockview workspace controls and recovery behavior so dashboard layouts restore more cleanly after panel and reconnect churn.
## [0.8.45] - 2026-04-12

### Changed
- Version-only release to keep published OSS packages aligned. No standalone surface changes landed in this tag.
## [0.8.44] - 2026-04-12

### Fixed
- Narrowed dockview popout window typing to prevent popout-specific web-core regressions in dashboard and standalone builds.
## [0.8.43] - 2026-04-12

### Changed
- Refined dockview popout behavior, layout persistence, and related dashboard workspace interactions.
## [0.8.42] - 2026-04-12

### Changed
- Version-only release to keep published OSS packages aligned. No standalone surface changes landed in this tag.
## [0.8.41] - 2026-04-12

### Added
- Dashboard and standalone surfaces now enforce the version update policy and expose version update state more consistently.
## [0.8.40] - 2026-04-12

### Changed
- Version-only release to keep published OSS packages aligned. No standalone surface changes landed in this tag.
## [0.8.39] - 2026-04-11

### Changed
- Version-only release to keep published OSS packages aligned. No standalone surface changes landed in this tag.
## [0.8.38] - 2026-04-11

### Added
- Live last-message previews in dashboard conversation lists.
- CDP multi-window handling in `daemon-core` plus the Claude Code VS Code catalog entry used by the launcher inventory.
## [0.8.37] - 2026-04-11

### Changed
- Version-only release to keep published OSS packages aligned. No standalone surface changes landed in this tag.
## [0.8.36] - 2026-04-11

### Fixed
- Improved completed-state contrast in mobile inbox views.

### Changed
- Backfilled recent changelog entries.
- Reverted an experimental builtin vendor provider-loader fallback before release, so this version does not introduce a new fallback contract.
## [0.8.35] - 2026-04-10

### Fixed
- Remote dialog now keeps the tab you selected instead of snapping back to the preferred agent tab when conversations refresh.
- CLI and ACP dashboard sends no longer stack a web pending bubble on top of daemon-side optimistic user turns.
- CLI chat sends now commit the user turn only after the submit boundary is actually crossed, avoiding false "sent" states when the prompt was only typed but not submitted.
- Duplicate P2P `p2p_ready`/`connected` churn no longer fan out repeated full status reports to peers and the server.

### Changed
- Server compact session payloads now use an explicit typed schema and stop forwarding transient UI/control metadata that is only needed on the P2P path.
- Shared dashboard chrome and dialog surfaces now consistently use the SVG icon set instead of mixed emoji/text close affordances.
## [0.8.34] - 2026-04-10

### Fixed
- Mobile machine and inbox surfaces no longer show `Connected` until the P2P session is actually connected.
- CLI terminal-mode conversations hide the chat send bar instead of exposing chat input in terminal-only views.
- Dashboard guide access remains available from the lower-right corner after the initial hint collapses.

### Changed
- Polished dashboard and standalone shell presentation, including notification bulk toggles, remote dialog behavior, and capabilities page removal from the standalone surface.
## [0.8.33] - 2026-04-10

### Added
- Added initial Vitest coverage for `daemon-core` and `web-core`, covering state store, recent activity, provider loader settings, compact status transforms, dashboard message utilities, and mobile/dashboard helper contracts.

### Fixed
- Release preflight now catches downstream cloud integration regressions before the cloud version bump step.

### Changed
- Tightened `daemon-core` and `web-core` typing across provider loading, command routing, compact daemon status handling, and dashboard conversation/presenter layers.
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
