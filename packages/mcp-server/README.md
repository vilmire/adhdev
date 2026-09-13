# @adhdev/mcp-server

An [MCP](https://modelcontextprotocol.io) stdio server that exposes running [ADHDev](https://github.com/vilmire/adhdev) agent sessions as tools.

ADHDev supervises AI coding agents — CLI agents (Claude Code, Codex CLI, and others), ACP agents, and IDE copilots — on your machines. This package lets an MCP client drive that supervision: list live sessions, read what an agent is doing, answer an approval prompt it is blocked on, and inspect the workspace it is working in.

It talks to an ADHDev daemon already running on your machine. It is a client of that daemon, not a standalone service — start the daemon first.

## Install

The server is wrapped by the main CLI:

```bash
adhdev mcp
```

Direct package entrypoint (compatibility bin, same server):

```bash
npx @adhdev/mcp-server
```

Or install the package globally; the binary is `adhdev-mcp`:

```bash
npm install -g @adhdev/mcp-server
```

It speaks MCP over stdio, so it is normally launched by an MCP client rather than run by hand.

## Connecting a client

Point your MCP client at the wrapper or the binary. For example:

```json
{
  "mcpServers": {
    "adhdev": {
      "command": "adhdev",
      "args": ["mcp", "--mode", "local"]
    }
  }
}
```

Register it with Codex:

```bash
codex mcp add adhdev -- adhdev mcp
```

Run `adhdev mcp --help` (or `adhdev-mcp --help`) for the full flag list.

## Transports

The `--mode` flag selects which daemon to talk to. It is a transport choice, independent of which toolset is published.

| Mode | Talks to | Default port |
|------|----------|--------------|
| `local` | Standalone daemon (`adhdev standalone`) | 3847 |
| `ipc` | Cloud daemon's local IPC (`adhdev daemon`) | 19222 (stable) / 19223 (preview) |

The IPC port is derived from the daemon's release track, so a preview coordinator does not have to be told which port its own daemon is on.

Defaults to `local`. Override the port with `--port`, and supply a standalone password with `--password` or `ADHDEV_PASSWORD`. `ADHDEV_MCP_TRANSPORT` sets the mode from the environment.

If the daemon is unreachable, the server exits at startup with a message naming which daemon it expected — it does not come up with a dead transport.

## Toolsets

Which tools are published depends on how the server is started. The three sets are disjoint by design, not merely by convention.

### Standard (default) — 19 tools

Direct supervision of agent sessions on one machine.

- **Inspect** — `list_daemons`, `list_sessions`, `check_pending`, `read_chat`, `read_chat_debug`, `spec_debug`, `screenshot` (local mode only)
- **Control** — `launch_session`, `stop_session`, `send_chat`, `approve`
- **Git** — `git_status`, `git_log`, `git_diff`, `git_checkpoint`, `git_push`
- **Mesh bootstrap** — `mesh_plan_onboarding`, `mesh_create`, `mesh_add_node`. Exposed here precisely because this is the no-mesh-yet context: mesh mode refuses to start without an existing mesh id.

### Repo Mesh (`--repo-mesh <id>`) — 60 tools

The coordinator surface for [Repo Mesh](https://github.com/vilmire/adhdev/blob/main/docs/guides/REPO_MESH_GUIDE.md), where work is delegated across multiple machines and agents. Also exposes the coordinator system prompt as an MCP resource at `coordinator://system-prompt`.

Broadly: mesh and node status (`mesh_status`, `mesh_list_nodes`, `mesh_route_preview`), task dispatch and queue management (`mesh_enqueue_task`, `mesh_enqueue_batch`, `mesh_send_task`, `mesh_view_queue`, `mesh_queue_cancel`), reading delegated sessions (`mesh_read_chat`, `mesh_read_terminal`, `mesh_read_node_logs`), approvals (`mesh_approve`, `mesh_answer_question`), node lifecycle (`mesh_clone_node`, `mesh_remove_node`), git convergence via the Refinery (`mesh_refine_node`, `mesh_fast_forward_node`), graph orchestration gates, missions, and the durable task ledger.

The mesh id also comes from `ADHDEV_MESH_ID`.

### Worker (`--worker`) — 6 tools

The minimal surface for a *delegated* agent: `report_completion`, `progress_update`, `peer_context_pull`, plus read-only `git_status` / `git_log` / `git_diff`.

Worker mode publishes no mesh tools and no coordinator prompt resource. A worker therefore cannot delegate work of its own — that restriction is a tool that does not exist rather than an instruction it might not follow. `--worker` deliberately overrides `--repo-mesh`, so a repo whose committed config carries a mesh id cannot hand a worker the coordinator surface.

Worker mode requires a daemon-issued credential (`ADHDEV_WORKER_SESSION_BIND` or `ADHDEV_WORKER_TASK_TOKEN`) in its environment and exits at startup without one.

## Tool annotations

Every published tool carries the four MCP behavior hints — `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` — so a client can decide what to auto-run and what to confirm first.

They describe what a tool *can* do, not what it does by default. Several tools (`mesh_refine_node`, `mesh_fast_forward_node`, `mesh_prune_stale_direct`) return a plan unless explicitly told to execute, and are still annotated destructive: a hint that described only the safe default would be the kind of hint that gets someone hurt.

The hints are advisory. Actual enforcement stays in the daemon — dry-run defaults, explicit `execute` flags, and ownership checks.

## Security notes

- The server runs locally and connects to a local daemon. It opens no listening socket of its own; MCP traffic is stdio.
- Standalone (`local`) connections authenticate with the daemon password when one is configured.
- Tools reach only what the daemon already exposes — the sessions, workspaces, and mesh nodes it manages.

## Client Configuration

Claude-style clients auto-import a repo-local `.mcp.json`; Hermes needs a manual `mcp_servers` YAML entry. See [Self-hosted configuration — Repo Mesh with Hermes Agent](../../docs/self-hosted/configuration.md) for the exact snippets.

## Development

```bash
npm run build -w packages/mcp-server
npm test -w packages/mcp-server
```

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE).
