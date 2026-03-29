# Changelog

All notable changes to ADHDev will be documented in this file.

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
