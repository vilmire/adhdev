# @adhdev/daemon-core

ADHDev daemon core — the shared engine behind every ADHDev daemon: provider integrations, command routing, and session/runtime state. It is a library, not a standalone process; `@adhdev/daemon-standalone` embeds it for the self-hosted path, and the cloud daemon builds on the same core.

## What It Owns

- **Providers** — the four integration categories:
  - `ide` — IDEs driven over the Chrome DevTools Protocol (Cursor, VS Code, Windsurf, …)
  - `extension` — IDE extensions reached through CDP webviews (Claude Code, Cline, Roo Code, …)
  - `cli` — terminal agents driven over PTYs (Claude Code, Codex CLI, Kimi Code, Grok CLI, …)
  - `acp` — agents speaking the Agent Client Protocol over stdio
- **Provider SDK** (`src/providers/sdk`) — the versioned, typed contract that external provider manifests are authored against.
- **Command routing** — the typed command surface (`send_chat`, `approve`, launch/stop, git operations, …) that the HTTP/WebSocket API, the MCP server, and the dashboard all converge on.
- **Session & runtime state** — session lifecycle, runtime recovery, and the normalized status model shared with the web clients.
- **Terminal screen model** (`src/cli-adapters`) — the VT parser + screen snapshot layer (`TerminalScreen`, ghostty-vt/xterm backends) used to read CLI agent output. See [docs/libghostty-vt.md](../../docs/libghostty-vt.md).
- **Mesh & quota** — mesh event normalization and per-provider plan-quota fetchers.

## Layout (src/)

| Directory | Responsibility |
| --- | --- |
| `providers/` | Provider specs, detection, and the Provider SDK |
| `cli-adapters/` | PTY transport, `TerminalScreen`, CLI runtime plumbing |
| `cdp/` | Chrome DevTools Protocol clients for IDEs/extensions |
| `commands/` | Command handlers and stream commands |
| `sessions/` | Session lifecycle and state |
| `session-host/` | Client for the `adhdev-sessiond` PTY-owning runtime |
| `mesh/` | Repo-mesh event types and normalization |
| `quota/` | Provider plan-quota fetchers |

## Development

```bash
npm run build -w packages/daemon-core      # tsup + type declarations
npm test -w packages/daemon-core           # vitest
npm run typecheck -w packages/daemon-core
```

Consumers import the compiled entrypoints declared in `package.json` `exports` (e.g. `@adhdev/daemon-core`, `@adhdev/daemon-core/status/normalize`).
