# Terminal Mux

`adhmux` is the local terminal mux client used for ADHDev hosted runtimes.

This is a self-hosted and power-user surface, not a primary cloud product workflow.

## What It Is

Terminal mux sits on top of session-host runtimes and gives you a local multi-pane workspace model for terminal sessions.

In practice, that means:

- one mux workspace can contain multiple hosted runtimes
- panes can be split, resized, swapped, zoomed, or replaced
- workspace state can be persisted locally
- local tools and the standalone API can inspect or control a workspace

## `adhmux` Exists And Is Real

The binary is still shipped as part of the OSS/self-hosted stack:

```text
adhmux
```

It is not just a leftover internal name. It is the CLI for the terminal mux packages.

## When To Use It

`adhmux` is useful when you want to:

- inspect local mux workspaces directly
- build a multi-pane terminal view around hosted runtimes
- debug mux state without going through the browser UI
- script local terminal workspace operations

If you only want to monitor sessions from the dashboard, you usually do not need it.

## Core Concepts

The naming model is:

- **runtime**: the hosted CLI runtime owned by session host
- **workspace**: one mux layout with panes
- **session**: a higher-level grouping of mux windows/workspaces
- **window**: a named workspace inside a session

## Useful Commands

List raw session-host records visible to `adhmux`:

```bash
adhmux list
```

This is not the same thing as the primary `adhdev runtime list` surface. `adhmux list` may include recovery snapshots and other non-live records that are visible to session host but are not directly openable right now.

List saved mux sessions and workspaces:

```bash
adhmux sessions
adhmux workspaces
adhmux tree
```

Inspect a workspace:

```bash
adhmux state <workspaceName> --json
adhmux socket-info <workspaceName> --json
adhmux events <workspaceName>
```

Open or reattach a workspace:

```bash
adhmux open <runtimeKey>
adhmux attach-session <sessionName>
```

`adhmux open` only accepts live runtimes. If a target is a recovery snapshot or an inactive stopped record, recover or restart it first through `adhdev runtime recover` / `adhdev runtime restart` instead of trying to open it directly.

Create or change pane layouts:

```bash
adhmux new-session <sessionName> <runtimeKey> [moreRuntimeKeys...]
adhmux new-window <sessionName> -n <windowName> <runtimeKey>
adhmux split-window <sessionName> ...
adhmux select-layout <sessionName> even
```

Read the current terminal snapshot for a hosted runtime:

```bash
adhmux snapshot <sessionId>
```

## Local Storage

Terminal mux stores local state under:

```text
~/.adhdev/terminal-mux/
```

Important paths:

- `workspaces/*.json` for persisted workspace layouts
- `state.json` for client-side “last workspace” state

## Control Sockets

Each workspace also has a local control socket.

- macOS/Linux: `/tmp/adhmux-<workspace>.sock`
- Windows: `\\\\.\\pipe\\adhmux-<workspace>`

This is what powers both `adhmux events` and the standalone mux control API.

## Relationship To The Standalone API

The local mux API maps closely to `adhmux`:

- `GET /api/v1/mux/{workspace}/state`
- `GET /api/v1/mux/{workspace}/socket-info`
- `POST /api/v1/mux/{workspace}/control`
- `GET /api/v1/mux/{workspace}/events`

The API is useful for browser or script clients. `adhmux` is useful when you want the local terminal-first tool.

## Practical Guidance

- Use the dashboard or `adhdev runtime ...` for normal session supervision and recovery.
- Use session-host tools when the runtime itself is broken or you need lower-level diagnostics.
- Use `adhmux` when the runtime is healthy but you want direct local workspace and pane control.

## Related Pages

- [Session Host](session-host.md)
- [Local API](local-api.md)
- [Self-hosted Setup](setup.md)
