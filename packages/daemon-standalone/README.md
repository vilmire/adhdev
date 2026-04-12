# @adhdev/daemon-standalone

ADHDev standalone packages the local dashboard, local HTTP/WebSocket API, and session-host-backed CLI runtime management into a single binary.

## Quick Start

```bash
npx @adhdev/daemon-standalone
```

Or install it directly:

```bash
npm install -g @adhdev/daemon-standalone
adhdev-standalone
```

Open `http://localhost:3847`.

## What It Exposes

- Bundled standalone dashboard
- Local API routes such as `GET /api/v1/status` and `POST /api/v1/command`
- Runtime snapshot and event streams for hosted CLI sessions
- Workspace mux routes for local terminal flows
- `ws://localhost:3847/ws` for real-time updates
- Local runtime commands: `list`, `attach`, and `open`

## Options

| Flag | Description |
|------|-------------|
| `--port, -p <port>` | Port to listen on (default: `3847`) |
| `--host, -H` | Listen on all interfaces and bind to `0.0.0.0` |
| `--no-open` | Don't open browser automatically on start |
| `--token <secret>` | Enable token authentication for API and WebSocket |
| `--dev` | Enable DevConsole and provider debugging helpers |
| `--public <path>` | Serve the dashboard from a custom build directory |

## Runtime Commands

```bash
adhdev-standalone list
adhdev-standalone attach <sessionId>
adhdev-standalone open <sessionId>
```

## Notes

- The canonical runtime model is `GET /api/v1/status` and its `sessions[]` array.
- Treat built-in provider inventory as shipped inventory, not blanket verified support.
- On Windows, Node.js 24+ is currently blocked for the normal install/start path. Use Node.js 22.x instead.

## Links

- [Self-hosted setup](https://docs.adhf.dev/self-hosted/setup)
- [Self-hosted local API](https://docs.adhf.dev/self-hosted/local-api)
- [GitHub](https://github.com/vilmire/adhdev)

## License

AGPL-3.0-or-later
