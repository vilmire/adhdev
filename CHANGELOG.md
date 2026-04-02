# Changelog

All notable changes to ADHDev will be documented in this file.

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
