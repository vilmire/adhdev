# @adhdev/daemon-standalone

ADHDev standalone daemon — run a local AI agent dashboard without any cloud server.

## Quick Start

```bash
npx @adhdev/daemon-standalone
# → http://localhost:3847
```

## Features

- 🔍 **Auto-detects IDEs** — VS Code, Cursor, Windsurf, and more
- 💬 **Live agent chat** — read & send messages to AI agents (Cline, Roo Code, etc.)
- 🖥️ **Local dashboard** — bundled web UI, no internet required
- 🔒 **Privacy-first** — everything runs on your machine

## Options

| Flag | Description |
|------|-------------|
| `--port, -p <port>` | Port to listen on (default: `3847`) |
| `--host, -H` | Listen on all interfaces — enables LAN access (`0.0.0.0`) |
| `--no-open` | Don't open browser automatically on start |
| `--token <secret>` | Enable token authentication for API and WebSocket |
| `--dev` | Enable DevServer on port `19280` (provider debugging, CDP tools) |

## Links

- [ADHDev Cloud](https://adhf.dev) — Cloud version with remote access & P2P
- [GitHub](https://github.com/vilmire/adhdev) — Open source core
- [CONTRIBUTING.md](https://github.com/vilmire/adhdev/blob/main/CONTRIBUTING.md)

## License

AGPL-3.0-or-later
