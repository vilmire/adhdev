# @adhdev/daemon-standalone

ADHDev standalone packages the local dashboard, local HTTP/WebSocket API, and standalone session-host-backed runtime stack into a single self-hosted binary.

## Quick Start

Recommended path via the main CLI:

```bash
npm install -g adhdev
adhdev standalone
```

Direct standalone package:

```bash
npm install -g @adhdev/daemon-standalone
adhdev-standalone
```

One-shot without a global install:

```bash
npx @adhdev/daemon-standalone
```

Then open `http://localhost:3847`.

## What It Runs

The standalone package runs these local layers together:

- bundled standalone dashboard UI
- local HTTP command/status API
- local WebSocket transport for real-time updates
- standalone session-host namespace for hosted CLI runtime recovery
- terminal-mux routes for local workspace terminal flows

Everything runs on your machine. No cloud account is required for this package.

## Current Local Surface

Standalone currently exposes:

- `GET /api/v1/status`
- `POST /api/v1/command`
- `GET /api/v1/runtime/:sessionId/snapshot`
- `GET /api/v1/runtime/:sessionId/events`
- `GET /api/v1/mux/:workspaceName/state`
- `GET /api/v1/mux/:workspaceName/socket-info`
- `POST /api/v1/mux/:workspaceName/control`
- `GET /api/v1/mux/:workspaceName/events`
- `GET /auth/session`
- `POST /auth/login`
- `POST /auth/logout`
- `POST /auth/password`
- `GET /api/v1/standalone/preferences`
- `POST /api/v1/standalone/preferences`
- `ws://localhost:3847/ws`

Canonical runtime contract:

- `GET /api/v1/status` and its `sessions[]` array are the source of truth
- raw `targetSessionId` is the canonical runtime identifier for command routing
- older per-surface projections should be treated as convenience views, not the main runtime model

## Options

| Flag | Description |
|------|-------------|
| `--port, -p <port>` | Change the local HTTP and WebSocket port (default: `3847`) |
| `--host, -H` | Bind to `0.0.0.0` so other devices on your LAN can open the dashboard |
| `--no-open` | Do not auto-open the browser on startup |
| `--token <secret>` | Enable token auth for dashboard, API, and WebSocket access |
| `--dev` | Enable DevConsole and provider debugging helpers |
| `--public <path>` | Serve the dashboard from a custom build directory |

### What These Choices Mean In Practice

| Choice | End-user effect |
|--------|-----------------|
| `adhdev-standalone` | Dashboard is reachable only from the same machine via localhost |
| `adhdev-standalone --host` | Dashboard is also reachable from other devices on the same LAN |
| `adhdev-standalone --token mysecret` | Browser/API/WebSocket access must authenticate with that token |
| dashboard password enabled in Settings | Browser users see a password prompt and then get a local session cookie |
| `--host` with no token and no password | Standalone warns that the dashboard is exposed to the LAN without protection |
| `--no-open` | Server starts normally, but does not auto-launch a browser window |

Environment variables:

- `ADHDEV_TOKEN` — token auth fallback when `--token` is not passed
- `ADHDEV_SESSION_HOST_NAME` — override the standalone session-host namespace (default: `adhdev-standalone`)
- `ADHDEV_RESTORE_HOSTED_SESSIONS_ON_STARTUP=1` — opt into restoring hosted runtimes on startup; ordinary standalone launch stays fresh by default

## Auth And Network Behavior

For end-user behavior, the canonical docs are:

- setup and startup flags → https://docs.adhf.dev/self-hosted/setup
- password auth and saved network defaults → https://docs.adhf.dev/self-hosted/configuration
- local route contract and examples → https://docs.adhf.dev/self-hosted/local-api

By default, standalone binds to localhost only.

For LAN access:

```bash
adhdev-standalone --host
```

If you expose standalone on `0.0.0.0` without either token auth or a dashboard password, startup logs warn that anyone on your LAN can open and control the dashboard until you secure it.

`--host` does not publish your machine to the public internet by itself. It only changes the bind address from localhost to all interfaces on the current network. Whether that is reachable outside your LAN still depends on your router/firewall setup.

Standalone supports two local auth patterns:

1. token auth via `--token` or `ADHDEV_TOKEN`
2. dashboard-managed password auth for browser sessions

Use token auth for scripts, curl, and explicit operator access. Use the dashboard password when you want normal browser users on the machine or LAN to see a login prompt and get a local session cookie after signing in.

You can set or rotate the dashboard password from:

- `Settings` → `Dashboard Security`

You can also save the default network bind preference from:

- `Settings` → `Network Access`

That preference is stored locally under `~/.adhdev/` and controls whether future launches default to localhost-only or LAN bind mode.

Common end-user patterns:

- using ADHDev only from the same machine → run plain `adhdev-standalone`
- opening the dashboard from another device on the same Wi-Fi → use `--host`, then set a dashboard password from `Settings` → `Dashboard Security`
- calling the local API from scripts or curl → use `--token`

## Runtime Helpers

The standalone package itself exposes lightweight session-host helpers:

```bash
adhdev-standalone list
adhdev-standalone list --all
adhdev-standalone attach <sessionId>
adhdev-standalone attach <sessionId> --read-only
adhdev-standalone attach <sessionId> --takeover
```

Notes:

- `list` and `runtimes` are equivalent helper commands
- the standalone package does not currently expose a direct `open` helper command
- for the fuller hosted-runtime workflow (`runtime recover`, `runtime restart`, `runtime snapshot`, `runtime open`), use the main `adhdev` CLI docs

## Notes

- standalone uses its own default session-host namespace: `adhdev-standalone`
- cloud/global daemon defaults to `adhdev`
- keeping those separate avoids standalone and cloud-connected runtimes fighting over the same hosted sessions on one machine
- built-in provider inventory means shipped inventory, not blanket verified support
- on Windows, Node.js 24+ is currently blocked for the normal install/start path; use Node.js 22.x instead

## Links

- [Self-hosted setup](https://docs.adhf.dev/self-hosted/setup)
- [Self-hosted configuration](https://docs.adhf.dev/self-hosted/configuration)
- [Self-hosted local API](https://docs.adhf.dev/self-hosted/local-api)
- [Self-hosted session host](https://docs.adhf.dev/self-hosted/session-host)
- [GitHub](https://github.com/vilmire/adhdev)

## License

AGPL-3.0-or-later
