# Self-hosted

Run ADHDev without the hosted cloud account layer.

The self-hosted path bundles:

- a local dashboard served from your machine
- the local standalone HTTP/WebSocket API
- the same daemon/session-host runtime stack used by the cloud-connected flow

Use self-hosted when you want:

- a fully local deployment
- LAN-only browser access
- local scripting against the standalone API
- no cloud account dependency
- fresh-by-default local launches with explicit saved-history resume when you want continuity

Self-hosted does **not** include the hosted cloud features such as:

- remote access outside your network
- multi-machine cloud dashboards
- API keys and hosted webhooks
- push notifications

## Start Here

Use these pages as the canonical self-hosted path:

- [Setup](setup.md) — install, start, flags, first-run behavior
- [Configuration](configuration.md) — password auth, token auth, host/network defaults, local state
- [Local API](local-api.md) — concrete HTTP/WebSocket/SSE route contract and examples

## Power Tools

If you are running self-hosted as a serious local control plane, these are the two extra pages worth keeping nearby:

- [Session Host](session-host.md)
- [Terminal Mux](terminal-mux.md)

## Current Standalone UX Defaults

- ordinary CLI/ACP launches start fresh by default
- use `Open saved history` when you want to continue the same provider conversation
- use hosted runtime recovery only after interruptions; it is no longer mixed into the normal new-session flow
- the local dashboard settings now also include standalone-only font overrides under `Appearance` → `Fonts`
- if the local websocket drops, the dashboard banner exposes `Reconnect now`

## Quick Comparison

| Capability | Self-hosted | Cloud |
|-----------|:-----------:|:-----:|
| Local dashboard | ✅ | ✅ |
| Local runtime/session-host stack | ✅ | ✅ |
| Local standalone REST/WebSocket API | ✅ | ❌ |
| Hosted cloud REST API | ❌ | ✅ |
| Remote access outside LAN | ❌ | ✅ |
| Multi-machine account view | ❌ | ✅ |
| API keys + hosted webhooks | ❌ | ✅ |
| Push notifications | ❌ | ✅ |

## Notes

- Self-hosted is an option inside the broader ADHDev product docs.
- Cloud-focused guides may mention features that do not apply to standalone.
- When in doubt, treat this section as the canonical standalone reference set.
- The pages in this section intentionally go deeper than the cloud guides because standalone users often need local operator workflows.
