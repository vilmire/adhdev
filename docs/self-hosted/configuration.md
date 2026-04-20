# Configuration

Standalone reuses the shared `~/.adhdev/` data directory, but the important part for self-hosted users is local runtime behavior, not cloud auth.

## Config Files

Shared daemon settings live in:

```text
~/.adhdev/config.json
```

Runtime state such as recent activity and saved session metadata lives in:

```text
~/.adhdev/state.json
```

Session-host runtime data is stored separately under:

```text
~/.adhdev/session-host/adhdev-standalone/
```

Terminal mux state is stored separately under:

```text
~/.adhdev/terminal-mux/
```

## Fields That Matter For Standalone

The standalone UI and local daemon primarily care about fields like these:

```json
{
  "machineNickname": "Studio Mac",
  "workspaces": [
    {
      "id": "ws_example",
      "label": "remote_vs",
      "path": "~/Work/remote_vs",
      "addedAt": 1710000000000
    }
  ],
  "defaultWorkspaceId": "ws_example",
  "providerSettings": {},
  "ideSettings": {},
  "providerSourceMode": "normal",
  "providerDir": "~/Work/adhdev-providers",
  "terminalSizingMode": "measured"
}
```

Relevant standalone-facing fields:

| Field | Meaning |
|-------|---------|
| `machineNickname` | Friendly name shown in the dashboard |
| `workspaces` | Saved launch targets for IDE, CLI, and ACP launches |
| `defaultWorkspaceId` | Default saved workspace selection |
| `providerSettings` | Per-provider user settings |
| `ideSettings` | Per-IDE extension enablement settings |
| `providerSourceMode` | Provider source policy: `normal` (upstream cache + overrides) or `no-upstream` (skip upstream fetch/load) |
| `providerDir` | Optional explicit override root. Set this if you want a local `adhdev-providers` checkout to shadow upstream providers. |
| `terminalSizingMode` | `measured` by default, or `fit` for the legacy xterm fit path |

## Practical Self-hosted Settings

If you only care about the settings that most affect day-to-day standalone behavior, focus on these:

- `machineNickname` so the dashboard shows a meaningful machine label
- `workspaces` and `defaultWorkspaceId` so launch flows start in the right places
- `providerSettings` for per-provider behavior and auth-related settings
- `providerSourceMode` if you want to keep local user overrides but disable upstream fetch/load on this machine
- `providerDir` if you want ADHDev to use an explicit local provider override root instead of the default `~/.adhdev/providers`
- `terminalSizingMode` if terminal rendering behaves poorly in your environment

## Shared Fields You Can Usually Ignore

`config.json` is shared between standalone and cloud-capable codepaths, so you may also see fields such as:

- `serverUrl`
- `allowServerApiProxy`
- `userEmail`
- `userName`
- `machineSecret`
- `registeredMachineId`
- `setupCompleted`

Those are not required to run standalone locally. They only matter if the same machine also participates in the cloud flow.

## Runtime State vs Static Config

A useful rule:

- `config.json` is for durable user intent
- `state.json` is for runtime-oriented state
- `session-host/` is for hosted runtime recovery under the standalone session-host namespace
- `terminal-mux/` is for local mux workspace persistence

This distinction matters when you are debugging local state drift. Not every runtime symptom should send you back to `config.json`.

## Authentication For Standalone

This page is the canonical reference for standalone auth and saved network defaults.

Standalone now supports two self-hosted auth patterns:

1. `--token` / `ADHDEV_TOKEN` for operator-style API or URL-token access
2. a dashboard-managed password for browser sessions

Use them for different jobs:

| Option | Best for | What the user sees |
|--------|----------|--------------------|
| token auth | scripts, curl, automation, opening the dashboard with an explicit token | requests must include the token; no interactive browser password prompt is required |
| dashboard password | normal browser use on a local/LAN dashboard | the dashboard shows a password prompt and then uses a local session cookie |
| both enabled | mixed browser + automation setups | browser users can sign in with the password while scripts can keep using the token |

Token auth remains process-scoped.

```bash
adhdev standalone --token mysecret
```

```bash
ADHDEV_TOKEN=*** adhdev-standalone
```

If you open the dashboard without a configured password, you can set one from:

- `Settings` → `Dashboard Security`

You can also choose the default network bind mode from:

- `Settings` → `Network Access`

That setting controls whether future standalone launches default to localhost-only or all-interfaces bind mode, without requiring `--host` every time.

Practical meaning:

- `127.0.0.1` / localhost-only = only this machine can open the dashboard
- `0.0.0.0` / all interfaces = other devices on the same LAN can also open it
- if you save `0.0.0.0` and do not configure token auth or a dashboard password, standalone warns because the dashboard is exposed to the LAN without protection

The standalone password and network-default preference are stored only in local standalone state under `~/.adhdev/` and are not part of cloud auth.

When standalone is bound to `0.0.0.0` without either token auth or password auth, startup logs and the dashboard settings page show a warning because anyone on the same LAN can open the dashboard until auth is enabled.

## CLI Flags vs Environment Variables

For normal self-hosted use, prefer CLI flags over environment variables.

Documented standalone runtime inputs:

| Input | Meaning |
|-------|---------|
| `--port` | HTTP and WebSocket port |
| `--host` | Bind to `0.0.0.0` for LAN access |
| `--token` | Require dashboard/API token auth |
| `--no-open` | Skip automatic browser open |
| `ADHDEV_TOKEN` | Token auth fallback when no `--token` flag is passed |
| `ADHDEV_SESSION_HOST_NAME` | Override the standalone session-host namespace (default: `adhdev-standalone`) |
| `ADHDEV_RESTORE_HOSTED_SESSIONS_ON_STARTUP` | Opt into restoring hosted runtimes on startup; ordinary standalone launch stays fresh by default |

## Logs

Local logs are stored in:

```text
~/.adhdev/logs/
```

They are also printed to stdout when the standalone server runs in the foreground.

## Related Local State

If you are operating self-hosted seriously, these other local state areas are worth knowing:

- `~/.adhdev/session-host/adhdev-standalone/runtimes/` for hosted runtime snapshots
- `~/.adhdev/terminal-mux/workspaces/` for mux workspace layouts
- `~/.adhdev/terminal-mux/state.json` for last-workspace client state

## Provider Directories

Provider roots use a category-based layout:

- `~/.adhdev/providers/<category>/<type>/` for local overrides and user providers
- `~/.adhdev/providers/.upstream/<category>/<type>/` for downloaded upstream providers
- bundled providers ship with the same `category/type` layout inside the installed packages

## Related Pages

- [Self-hosted Setup](setup.md)
- [Session Host](session-host.md)
- [Terminal Mux](terminal-mux.md)
- [Local API](local-api.md)
