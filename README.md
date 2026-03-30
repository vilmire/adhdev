# 🦦 ADHDev — Agent Dashboard Hub for Dev

[![npm](https://img.shields.io/npm/v/@adhdev/daemon-standalone?label=npm)](https://www.npmjs.com/package/@adhdev/daemon-standalone)
[![CI](https://github.com/vilmire/adhdev/actions/workflows/ci.yml/badge.svg)](https://github.com/vilmire/adhdev/actions)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

> Your AI sidekick otter 🦦 — control your IDE's AI agents from anywhere.

ADHDev is an **open-source** local dashboard for managing AI coding agents across multiple IDEs.
Run it on your machine — no cloud account required.

## ✨ What Does It Do?

```
┌──────────────────────────────────────┐      ┌──────────────────┐
│  Your Local Machine                  │      │  Web Dashboard   │
│  ┌──────────┐    ┌────────────────┐  │      │  (React SPA)     │
│  │ IDE      │    │ ADHDev Daemon  │──┼──────┼▶ Chat, Commands, │
│  │ + AI Ext │CDP │ localhost:3847 │  │ HTTP │  Screenshots,    │
│  └──────────┘    └────────────────┘  │  /WS │  Remote Control  │
│                                      │      │                  │
│  CLI Agents  ◄─PTY─►  Daemon         │      │                  │
│  ACP Agents  ◄─stdio─► Daemon        │      └──────────────────┘
└──────────────────────────────────────┘
       Everything runs locally — no cloud required
```

- **Read & send messages** to AI agents (Cursor, Cline, Roo Code, Claude Code, Gemini CLI, etc.)
- **See IDE screenshots** in real-time via Chrome DevTools Protocol
- **Remote desktop** — click, type, scroll in your IDE from the browser
- **Manage CLI agents** — interactive terminal view with xterm.js
- **Multi-IDE support** — manage 9 different IDEs simultaneously
- **Provider system** — extensible via `provider.json` & `scripts.js` files (no TypeScript changes needed)

## 🚀 Quick Start

```bash
# One-line installer (recommended — handles Node.js check + install + setup)
curl -fsSL https://adhf.dev/install | sh

# Or install via npm directly
npm install -g @adhdev/daemon-standalone

# One-liner — starts dashboard at http://localhost:3847
adhdev-standalone

# With options
adhdev-standalone --port 8080 --host  # LAN access
adhdev-standalone --token mysecret     # Token auth
```

That's it! Open `http://localhost:3847` and your connected IDEs will appear automatically.

### CLI Options

| Flag | Description |
|------|-------------|
| `--port, -p <port>` | Port to listen on (default: `3847`) |
| `--host, -H` | Listen on all interfaces — enables LAN access (`0.0.0.0`) |
| `--no-open` | Don't open browser automatically on start |
| `--token <secret>` | Enable token authentication for API and WebSocket |
| `--dev` | Enable DevServer on port `19280` (provider debugging, CDP tools) |

## 📦 Packages

| Package | Description |
|---------|-------------|
| `packages/daemon-core` | Core engine — CDP, IDE detection, providers, CLI/ACP adapters, command handler, lifecycle |
| `packages/daemon-standalone` | Self-hosted local server — HTTP REST + WebSocket + bundled dashboard |
| `packages/web-core` | Shared UI — Dashboard, Chat, System views, CSS design system |
| `packages/web-standalone` | Self-hosted React dashboard — localhost-first, no auth |
| `packages/web-devconsole` | DevConsole — provider debugging and testing tools |

> 💡 **Cloud version** with remote access and team features available at [adhf.dev](https://adhf.dev)

## 🔌 Supported IDEs & Agents

### IDE Support Status
We are actively building out providers. Here is the current capability tracking:

- 🟢 **Antigravity** — Stable (CDP)
- 🟢 **Cursor** — Stable (CDP, including Composer)
- 🟢 **Windsurf** — Stable (CDP)
- 🟢 **Kiro** — Stable (webview CDP)
- 🟡 **PearAI** — Beta (webview CDP)
- 🟡 **Trae** — Beta (webview CDP)
- 🟢 **VS Code / VSCodium** — Stable (CDP)

### AI Extensions (via Agent Stream CDP scraping)
- 🟢 **Cline** — Independent Stream
- 🟢 **Roo Code (3.x, 4.x)** — Independent Stream
- 🟢 **Codex Extension** — Independent Stream


### Standalone CLI Agents (via Daemon CLI Adapters)
All CLI agents support interactive Terminal mode. Chat mode (UI abstraction) availability is listed below:

- 🟢 **Claude Code** — Terminal + Chat Mode
- 🟢 **Codex CLI** — Terminal + Chat Mode
- 🟡 **Aider** — Terminal only (Chat Mode WIP)
- 🟡 **Cursor CLI** — Terminal only (Chat Mode WIP)
- 🟡 **Gemini CLI** — Terminal only (Chat Mode WIP)
- 🟡 **GitHub Copilot CLI** — Terminal only (Chat Mode WIP)
- 🟡 **Goose CLI** — Terminal only (Chat Mode WIP)
- 🟡 **OpenCode CLI** — Terminal only (Chat Mode WIP)

### ACP Agents (Agent Client Protocol — 35 agents)
- ✅ **35 ACP agents** supported (Gemini, Codex, Claude Agent, Cursor, Cline, GitHub Copilot, Goose, Kimi, Kiro, Mistral Vibe, OpenCode, Qwen Code, and 21 more)

## 🛠️ Development

```bash
# Clone and install
git clone https://github.com/vilmire/adhdev.git
cd adhdev
npm install

# Build all packages (order matters)
npm run build

# Run standalone (daemon + dashboard)
npm run dev

# Individual services
npm run dev:daemon    # daemon-standalone only
npm run dev:web       # web-standalone only (Vite dev server)
```

### Project Structure

```
packages/
├── daemon-core/        # Core engine (CDP, providers, CLI/ACP adapters, lifecycle)
├── daemon-standalone/  # HTTP/WS server (localhost:3847)
├── web-core/           # Shared React components, pages, CSS design system
├── web-standalone/     # Standalone React dashboard (Vite)
└── web-devconsole/     # DevConsole — provider debugging tools
```

## 🔗 Local API

The standalone daemon exposes a REST API at `http://localhost:3847`:

```bash
# Get daemon status (connected IDEs, system info)
curl http://localhost:3847/api/v1/status

# Send a chat message to an IDE agent
curl -X POST http://localhost:3847/api/v1/command \
  -H 'Content-Type: application/json' \
  -d '{"type": "send_chat", "payload": {"message": "Fix the login bug"}, "target": "ide:cursor_12345"}'

# Read current chat
curl -X POST http://localhost:3847/api/v1/command \
  -H 'Content-Type: application/json' \
  -d '{"type": "read_chat", "target": "ide:cursor_12345"}'

# Take a screenshot
curl -X POST http://localhost:3847/api/v1/command \
  -H 'Content-Type: application/json' \
  -d '{"type": "screenshot", "target": "ide:cursor_12345"}'

# List connected IDEs
curl http://localhost:3847/api/v1/ides

# List CLI sessions
curl http://localhost:3847/api/v1/clis
```

Full API spec: [docs/openapi.yml](docs/openapi.yml) (OpenAPI 3.0)

## 🧩 Web Dashboard Features

| Feature | Description |
|---------|-------------|
| Dashboard | Real-time agent chat, CLI terminal, agent management |
| IDE Detail | Full IDE control — chat, remote desktop, view modes |
| Machine View | IDE/CLI instance listing & management |
| CLI Terminal | Interactive terminal with xterm.js (Catppuccin Mocha theme) |
| Mobile UI | Responsive design — works on phones and tablets |
| Provider Settings | Per-provider configurable settings with runtime hot-reload |

## 🔌 Provider Development & DevConsole

Providers are dynamically loaded from the [vilmire/adhdev-providers](https://github.com/vilmire/adhdev-providers) repository.
Your local daemon automatically downloads the latest providers on startup.

### 🛠️ Using the DevConsole to Fix Providers

If an IDE updates its UI and ADHDev's chat integration breaks, you can easily fix the provider scripts live using the built-in **DevConsole**:

1. Stop your background daemon and run it in dev mode:
   ```bash
   adhdev-standalone --dev
   ```
2. Open **http://127.0.0.1:19280** in your browser to access the DevConsole UI.
3. The DevConsole allows you to:
   - **Inspect CDP Sessions:** View running IDEs and attach directly to their DOM.
   - **Test Scripts Real-time:** Edit Javascript functions (like `sendMessage` or `readChat`) inside the browser and execute them instantly in the target IDE without reloading.
   - **Inspect Errors:** Validate DOM selector changes seamlessly through the interactive tools.

### Adding Custom Local Providers

Providers are loaded dynamically. The legacy builtin directory has been deprecated in favor of a dynamic workspace model. 
If you want to create a custom provider locally or test your fixes before submitting a PR to the providers repository, place your edited files in `~/.adhdev/providers/<category>/<type>/`. Local user providers will always overwrite upstream auto-updated ones, allowing for rapid reloading and local testing without rebuilding the daemon.

```text
~/.adhdev/providers/ide/my-ide/
  provider.json
  scripts/
    1.0/
      scripts.js
```

## 🗺️ Roadmap

- [x] IDE detection (8 IDEs — Cursor, Antigravity, Kiro, PearAI, Trae, Windsurf, VS Code, VSCodium)
- [x] CDP integration (Chrome DevTools Protocol)
- [x] Agent Independent Chat Streams (Cline, Roo Code — real-time CDP scraping)
- [x] CLI Agent Adapters (Gemini CLI, Claude Code, Codex CLI — PTY-based)
- [x] ACP 35 agents (Agent Client Protocol — MCP stdio)
- [x] Interactive Terminal View (xterm.js — full TUI rendering)
- [x] Provider architecture (4-category provider.json & scripts.js system)
- [x] Model/Mode selection (CDP-based switching for all IDEs)
- [x] Mobile responsive UI
- [x] Provider Settings System (per-provider configurable settings)
- [ ] MCP server integration
- [ ] JetBrains plugin

## 📚 Documentation

🌐 **[docs.adhf.dev](https://docs.adhf.dev)** — User guides, feature docs, troubleshooting

- [docs/openapi.yml](docs/openapi.yml) — Standalone REST API specification (OpenAPI 3.0)
- [CONTRIBUTING.md](CONTRIBUTING.md) — How to contribute to ADHDev core
- **Provider Development**: See [vilmire/adhdev-providers](https://github.com/vilmire/adhdev-providers) for the provider contribution guide.

## ☁️ Cloud Version — [adhf.dev](https://adhf.dev)

Need remote access, team collaboration, or API integration?

| Feature | OSS (this repo) | Cloud |
|---------|:--:|:--:|
| IDE/CLI agent chat & control | ✅ | ✅ |
| 9 IDE + 35 ACP support | ✅ | ✅ |
| Remote access (outside LAN) | ❌ | ✅ |
| Multi-machine management | ❌ | ✅ |
| **Session Sharing** (live link) | ❌ | ✅ |
| **Team / Organization** | ❌ | ✅ |
| REST API + Webhooks | Local only | ✅ Cloud API |
| OAuth (GitHub/Google) | ❌ | ✅ |
| Push notifications | ❌ | ✅ |

→ **[Get started with ADHDev Cloud](https://adhf.dev)**

## 📜 License

AGPL-3.0 — See [LICENSE](LICENSE) for details.
