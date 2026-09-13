# @adhdev/mcp-server

ADHDev MCP server — exposes your ADHDev agent sessions as [Model Context Protocol](https://modelcontextprotocol.io/) tools over stdio, so external MCP clients (Claude Code, Codex, Hermes, …) can list, launch, read, and steer sessions running under an ADHDev daemon.

## Quick Start

The server is wrapped by the main CLI:

```bash
adhdev mcp
```

Direct package entrypoint (compatibility bin, same server):

```bash
npx @adhdev/mcp-server
```

Register it with an MCP client, e.g. Codex:

```bash
codex mcp add adhdev -- adhdev mcp
```

The server pings the daemon **before** registering any tools and exits if none is reachable. Local mode targets the standalone daemon on port 3847 (`adhdev standalone`); IPC mode targets the cloud daemon.

## Modes

```bash
adhdev mcp                                    # local mode (requires a running standalone daemon)
adhdev mcp --mode ipc --repo-mesh <mesh_id>   # mesh mode — mesh-scoped coordinator tools only
adhdev mcp --mode ipc --worker                # worker mode — minimal delegated-worker toolset
```

| Option | Description |
| --- | --- |
| `--mode <mode>` | Transport: `local` or `ipc` |
| `--port <n>` | Daemon port (defaults: local 3847, ipc 19222) |
| `--password <pass>` | Standalone daemon password (if set) |
| `--repo-mesh <mesh_id>` | Mesh mode — exposes only mesh-scoped coordinator tools |
| `--worker` | Worker mode — overrides `--repo-mesh`; a worker never gets coordinator tools |

Environment variables: `ADHDEV_PASSWORD`, `ADHDEV_MESH_ID`, `ADHDEV_MCP_TRANSPORT`, `ADHDEV_WORKER_SESSION_BIND`, `ADHDEV_WORKER_TASK_TOKEN`.

## Standard Tools

`list_daemons`, `list_sessions`, `launch_session`, `stop_session`, `check_pending`, `read_chat`, `read_chat_debug`, `send_chat`, `approve`, `git_status`, `git_log`, `git_diff`, `git_checkpoint`, `git_push`, `screenshot`.

Mesh and worker modes expose their own scoped toolsets instead — run `adhdev mcp --help` for the full roster.

## Client Configuration

Claude-style clients auto-import a repo-local `.mcp.json`; Hermes needs a manual `mcp_servers` YAML entry. See [Self-hosted configuration — Repo Mesh with Hermes Agent](../../docs/self-hosted/configuration.md) for the exact snippets.

## Development

```bash
npm run build -w packages/mcp-server
npm test -w packages/mcp-server
```
