# ADHDev OSS

[![npm](https://img.shields.io/npm/v/@adhdev/daemon-standalone?label=npm)](https://www.npmjs.com/package/@adhdev/daemon-standalone)
[![CI](https://github.com/vilmire/adhdev/actions/workflows/ci.yml/badge.svg)](https://github.com/vilmire/adhdev/actions)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

ADHDev OSS is the self-hosted, local-first edition of ADHDev.

This repo contains:

- the standalone local server and dashboard
- the shared daemon/runtime packages used by both standalone and cloud
- the session-host and terminal-mux stack for hosted CLI runtimes

Cloud deployment lives separately at [`vilmire/adhdev-cloud`](https://github.com/vilmire/adhdev-cloud).

## What It Runs

ADHDev OSS is built around three local layers:

1. `daemon-standalone` exposes a local HTTP/WebSocket server and serves the web UI.
2. `daemon-core` manages IDE, CLI, extension, and ACP integrations.
3. `session-host-daemon` (`adhdev-sessiond`) owns long-lived PTY runtimes so CLI sessions can survive daemon restarts.

Everything runs on your machine by default. There is no cloud account requirement for the standalone path.

## Quick Start

Recommended path:

```bash
npm install -g adhdev
adhdev standalone
```

Direct standalone package:

```bash
npm install -g @adhdev/daemon-standalone
adhdev-standalone
```

Open `http://localhost:3847`.

Useful flags:

```bash
adhdev standalone --host
adhdev standalone --port 8080
adhdev standalone --token mysecret
adhdev standalone --no-open
adhdev standalone --dev
```

Windows note:

- Windows + Node.js 24+ is currently blocked for normal startup/install paths.
- Use Node.js 22.x, or use the PowerShell installer path described in the docs.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `packages/daemon-core` | Shared engine: providers, CDP, command routing, session/runtime state |
| `packages/daemon-standalone` | Local HTTP/WS server and bundled standalone UI |
| `packages/web-core` | Shared React pages, components, hooks, and transport abstractions |
| `packages/web-standalone` | Standalone dashboard app |
| `packages/web-devconsole` | Provider/dev diagnostics UI |
| `packages/session-host-core` | Session-host protocol, client, registry, ring buffer, labels |
| `packages/session-host-daemon` | Long-lived PTY runtime owner process |
| `packages/terminal-mux-*` | Local terminal mux stack |
| `packages/terminal-render-web` | Browser-side terminal rendering support |
| `packages/ghostty-vt-node` | Ghostty VT bindings used by runtime/mux layers |

## Provider Inventory

ADHDev ships a broad built-in inventory of IDE, extension, CLI, and ACP integrations, including 35 ACP adapters.

Important distinction:

- built-in means the integration exists in the shipped inventory
- verified means it has explicit validation evidence

Do not treat inventory presence as blanket support. Current verification policy lives here:

- [Supported Providers](https://docs.adhf.dev/reference/supported-providers)
- [Supported IDEs](https://docs.adhf.dev/reference/supported-ides)
- [Compatibility & Caveats](https://docs.adhf.dev/guide/compatibility)

## Standalone API Surface

The standalone server currently exposes:

- `GET /api/v1/status`
- `POST /api/v1/command`
- `GET /api/v1/runtime/:sessionId/snapshot`
- `GET /api/v1/runtime/:sessionId/events`
- `GET /api/v1/mux/:workspace/state`
- `GET /api/v1/mux/:workspace/socket-info`
- `POST /api/v1/mux/:workspace/control`
- `GET /api/v1/mux/:workspace/events`
- `ws://localhost:3847/ws`

Canonical runtime contract:

- `GET /api/v1/status` and its `sessions[]` array are the source of truth
- runtime targeting should use raw `targetSessionId`
- older per-surface projections should be treated as convenience views, not the canonical model

Reference:

- [docs/openapi.yml](docs/openapi.yml)
- [Self-hosted API docs](https://docs.adhf.dev/self-hosted/local-api)

## Session Host

Hosted CLI runtimes are managed through `adhdev-sessiond`.

Key properties of the current design:

- PTY ownership is separated from the main daemon process
- CLI sessions can reconnect after daemon restarts
- write ownership is explicit and single-owner
- diagnostics and recovery actions are exposed through the daemon control plane and standalone UI

See:

- [Self-hosted setup](https://docs.adhf.dev/self-hosted/setup)
- [Self-hosted local API](https://docs.adhf.dev/self-hosted/local-api)
- [Compatibility & caveats](https://docs.adhf.dev/guide/compatibility)

## Development

From source:

```bash
git clone https://github.com/vilmire/adhdev.git
cd adhdev
npm install
npm run build
npm run dev
```

Useful workspace scripts:

```bash
npm run dev:daemon
npm run dev:web
npm run dev -w packages/web-devconsole
```

## Documentation

- [Self-hosted setup](https://docs.adhf.dev/self-hosted/setup)
- [Self-hosted local API](https://docs.adhf.dev/self-hosted/local-api)
- [Supported providers](https://docs.adhf.dev/reference/supported-providers)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## Cloud Comparison

| Feature | OSS | Cloud |
| --- | :--: | :--: |
| Local-only dashboard | ✅ | ✅ |
| Remote access outside LAN | ❌ | ✅ |
| Multi-machine management | ❌ | ✅ |
| API keys and webhooks | Local-only | ✅ |
| OAuth / account system | ❌ | ✅ |
| Push notifications | ❌ | ✅ |
| Team / sharing features | ❌ | ✅ |

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
