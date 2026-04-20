# Session Host

This page is the canonical self-hosted guide for hosted runtime recovery, session-host diagnostics, and namespace isolation. Use [Setup](setup.md) for startup flags, [Configuration](configuration.md) for auth/network defaults, and [Local API](local-api.md) for raw route examples.

The session host is the local runtime owner behind hosted CLI runtimes in standalone ADHDev.

If the daemon is the coordinator, the session host is the layer that actually keeps long-lived runtimes alive, stores recovery state, and tracks who is attached.

For most user-facing recovery work, start with `adhdev runtime ...` or the dashboard's hosted runtime recovery UI first. Reach for raw session-host tools when you need deeper operator diagnostics or manual control.

## What It Does

The session host is responsible for:

- keeping hosted CLI runtimes alive across reconnects
- preserving terminal snapshots and scrollback state
- tracking attached clients and write ownership
- allowing a runtime to be resumed or restarted after daemon interruption
- exposing diagnostics for recovery and operator tooling

This is why CLI recovery in modern ADHDev is no longer just “launch it again”.

## Recommended Surfaces

Use the runtime surface first:

```bash
adhdev runtime list
adhdev runtime attach <runtimeTarget>
adhdev runtime recover <runtimeTarget>
adhdev runtime restart <runtimeTarget>
adhdev runtime snapshot <runtimeTarget>
```

`<runtimeTarget>` can be the session ID, runtime key, display name, or a unique prefix from `adhdev runtime list`.

For the common operator flow, `adhdev attach <runtimeTarget>` and `adhdev recover|resume <runtimeTarget>` are also available as top-level shortcuts.

These commands are the primary user-facing runtime surface for answering:

- what is live right now?
- what can I recover?
- which record is just a snapshot or stale inactive entry?

Use the raw session-host surface only when you need operator-level diagnostics or manual repair work.

Hosted runtime recovery is intentionally explicit. Ordinary standalone startup stays fresh by default and does not automatically restore hosted CLI sessions unless you opt in.

If you intentionally want startup restore for a local operator setup, enable:

```bash
ADHDEV_RESTORE_HOSTED_SESSIONS_ON_STARTUP=1 adhdev-standalone
```

## Where You See It

You can reach session-host-backed recovery flows in a few places:

- the hosted runtime recovery tab in the dashboard machine detail view
- `adhdev runtime ...` from the CLI
- `adhdev daemon:session-host` for advanced operator diagnostics
- standalone/self-hosted helper commands such as `adhdev-standalone list` and `adhdev-standalone attach`

## Advanced Operator Actions

The raw session-host workflows are:

```bash
adhdev daemon:session-host
adhdev daemon:session-host --session <sessionId> --resume
adhdev daemon:session-host --session <sessionId> --restart
adhdev daemon:session-host --session <sessionId> --stop
adhdev daemon:session-host --prune-duplicates
```

Use them when:

- a CLI session survived but the dashboard or runtime surface lost track of it
- a runtime is stuck in `interrupted`
- you accidentally ended up with duplicate hosted runtimes
- write ownership or attached-client state looks wrong
- you need raw diagnostics payloads rather than the grouped user-facing runtime view

## Diagnostics Model

The dashboard and CLI both expose the same general session-host picture:

- host start time
- active runtime count
- attached client count
- recent host requests
- recent runtime transitions
- current runtime lifecycle for each hosted session

The user-facing runtime surface groups these into live runtimes, recovery snapshots, and inactive records. The raw session-host surface keeps the lower-level diagnostics and control plane view.

## Local Storage

Persisted runtime state lives under:

```text
~/.adhdev/session-host/adhdev-standalone/runtimes/
```

Each hosted runtime is stored as its own JSON snapshot so the host can recover state after local restarts.

## Local IPC

The session host exposes a local IPC endpoint.

- macOS/Linux: `/tmp/adhdev-standalone-session-host.sock`
- Windows: `\\\\.\\pipe\\adhdev-standalone-session-host`

This is an implementation detail for local tools and the standalone daemon, but it is useful to know when you are debugging a broken runtime stack.

## Namespace Isolation

Self-hosted standalone now uses its own session-host namespace by default:

- standalone default: `adhdev-standalone`
- cloud/global daemon default: `adhdev`

That separation matters if you run both standalone and the cloud-connected daemon on the same machine. Keeping distinct namespaces avoids both processes attaching to the same hosted runtimes and fighting over write ownership or recovery state.

If you intentionally need a different namespace, set:

```bash
ADHDEV_SESSION_HOST_NAME=my-custom-standalone adhdev-standalone
```

Do not point standalone back at plain `adhdev` unless you explicitly want it to share the global daemon's session-host namespace.

## Related API And Commands

These local command/router actions map to session-host operator flows:

- `session_host_get_diagnostics`
- `session_host_resume_session`
- `session_host_restart_session`
- `session_host_stop_session`
- `session_host_prune_duplicate_sessions`
- `session_host_force_detach_client`
- `session_host_acquire_write`
- `session_host_release_write`

The standalone API reference covers the raw route surface. This page is the practical operator guide.

## Practical Guidance

- Prefer **recover / resume** when the runtime still exists and you want continuity.
- Prefer **restart** when the runtime state is corrupted or the upstream tool is wedged.
- Use **prune duplicates** before manually killing random sessions if the same provider session was recovered more than once.
- If the dashboard looks wrong but the runtime is still alive, inspect the runtime surface first and only then drop into raw session-host diagnostics.

## Related Pages

- [CLI Commands](/reference/cli-commands)
- [Terminal Mux](terminal-mux.md)
- [Local API](local-api.md)
- [Troubleshooting](/guide/troubleshooting)
