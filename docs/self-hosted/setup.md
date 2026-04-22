# Self-hosted Setup

Run ADHDev locally without any cloud dependency.

Standalone mode bundles the local dashboard, local HTTP/WebSocket API, and session-host runtime owner on one machine.

## Quick Start

This page is the canonical end-user guide for:

- installing standalone
- choosing startup flags
- understanding what `--host`, `--token`, and `--no-open` actually do
- first-run browser behavior

For password auth, saved host defaults, and local config files, continue to [Configuration](configuration.md).

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

One-shot without a global install:

```bash
npx @adhdev/daemon-standalone
```

Then open [http://localhost:3847](http://localhost:3847).

::: tip
The current public install-tested paths are macOS and Windows. Linux may work for standalone too, but it has not yet been validated enough to present as a supported path.
:::

::: warning
On Windows, **global npm install/startup under Node.js 24+ is temporarily unsupported**.
Use the PowerShell installer to bootstrap a portable **Node.js 22** runtime for setup, or install **Node.js 22.x** manually before using `npm install -g adhdev`.
:::

## From Source

```bash
git clone https://github.com/vilmire/adhdev.git
cd adhdev
npm install
npm run build
npm run dev
```

## Runtime Commands

The standalone package exposes lightweight local helpers for hosted CLI sessions:

```bash
adhdev-standalone list
adhdev-standalone list --all
adhdev-standalone attach <sessionId>
adhdev-standalone attach <sessionId> --read-only
adhdev-standalone attach <sessionId> --takeover
```

If you want the fuller hosted-runtime workflow (`runtime recover`, `runtime restart`, `runtime snapshot`, `runtime open`), use the main `adhdev` CLI surface instead of expecting every helper on the standalone package binary.

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--port, -p <port>` | `3847` | Change the local HTTP and WebSocket port |
| `--host, -H` | localhost only | Bind to `0.0.0.0` so other devices on your LAN can open the dashboard |
| `--token <token>` | none | Require token auth for dashboard, API, and WebSocket access |
| `--no-open` | false | Do not auto-open the browser on startup |

## What These Options Actually Change

| Choice | What the user experiences |
|--------|----------------------------|
| `adhdev standalone` | Dashboard is reachable only from the same machine via localhost |
| `adhdev standalone --host` | Dashboard is also reachable from other devices on the same LAN |
| `adhdev standalone --token mysecret` | Browser/API/WebSocket access must authenticate with that token |
| dashboard password enabled in Settings | Browser users see a login prompt and get a local session cookie after signing in |
| `--host` with no token and no password | Standalone warns that the dashboard is open to the LAN without protection |
| `--no-open` | Server starts normally, but does not pop open a browser window |

`--host` does not publish your machine to the public internet by itself. It only changes the bind address from localhost to all interfaces on the current network. Whether that is reachable outside your LAN still depends on your router/firewall setup.

If you run with `--host` and do not enable either token auth or a dashboard password, standalone prints a warning because the dashboard is open to your LAN until you secure it.

If you usually want LAN access, you can save that as the default from `Settings` → `Network Access` so future launches do not require `--host` each time.

If you want a browser-friendly login, set a dashboard password from `Settings` → `Dashboard Security`. If you want script/operator-style access, prefer `--token`.

## Example Configurations

```bash
# Local-only dashboard on this machine only
adhdev standalone

# LAN access for other devices on the same network
adhdev standalone --host

# Custom port with token auth for browser/API access
adhdev standalone --port 8080 --token mysecret123

# Standalone package without opening the browser
adhdev-standalone --no-open
```

Common end-user patterns:

- want to use ADHDev only from the same machine → run plain `adhdev standalone`
- want to open it from a laptop/tablet on the same Wi-Fi → use `--host`, then set a dashboard password from `Settings` → `Dashboard Security`
- want scripts/curl to access it reliably → use `--token`

## Dashboard Launch And Recovery Flow

Current standalone launch behavior is intentionally split by job:

- `Start fresh` is the default for ordinary CLI/ACP launches
- `Open saved history` is the continuity path when you want to re-enter the same provider conversation
- hosted runtime recovery is the interruption fallback when a long-lived runtime survived but needs explicit recovery

Practical rule of thumb:

- want a new conversation in the same workspace → start fresh
- want the same provider-side conversation and transcript continuity → open saved history
- want to repair an interrupted long-lived runtime → use the hosted runtime recovery surface from the machine detail/session-host flow

If the standalone dashboard temporarily loses its local websocket connection, the top connection banner now offers `Reconnect now` so you can retry the server link without a full page refresh.

## Architecture

```
┌────────────────────────────────────────────┐
│ Your Machine                               │
│                                            │
│  IDE / CLI surfaces                        │
│          │                                 │
│          v                                 │
│  daemon-core + session-host                │
│          │                                 │
│          v                                 │
│  standalone HTTP + WS server               │
│          │                                 │
│          v                                 │
│  browser dashboard at http://localhost:3847│
└────────────────────────────────────────────┘
```

## Differences from Cloud

| Feature | Self-hosted | Cloud |
|---------|:-----------:|:-----:|
| Remote access outside LAN | ❌ | ✅ |
| Multi-machine management | ❌ | ✅ |
| OAuth / account system | ❌ | ✅ |
| Push notifications | ❌ | ✅ |
| Local standalone REST API | ✅ | ❌ |
| Hosted cloud REST API | ❌ | ✅ |
| Local runtime commands | ✅ | ✅ |

## Next Steps

- [Configuration →](configuration.md)
- [Local API →](local-api.md)
- [Session Host →](session-host.md)
- [Terminal Mux →](terminal-mux.md)
