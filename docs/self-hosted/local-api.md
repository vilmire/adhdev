# Local API

This page is the canonical contract for standalone HTTP/WebSocket/SSE routes. Use [Setup](setup.md) for first-run flags and [Configuration](configuration.md) for password/network settings behavior.

The standalone server exposes local HTTP, WebSocket, and SSE endpoints at `http://localhost:3847`.

The canonical runtime contract is `GET /api/v1/status` and its `sessions[]` array. Treat older per-surface projections as convenience shapes, not the main contract.

## HTTP Endpoints

### Status

```http
GET /api/v1/status
```

Returns the current standalone snapshot, including machine metadata, runtime sessions, and available providers.

Example shape (trimmed):

```json
{
  "id": "standalone_mach_123",
  "type": "standalone",
  "hostname": "studio-mac",
  "machine": {
    "hostname": "studio-mac",
    "platform": "darwin"
  },
  "sessions": [
    {
      "id": "session_abc",
      "providerType": "claude",
      "transport": "pty",
      "status": "idle",
      "title": "Claude Code"
    }
  ],
  "availableProviders": [
    {
      "type": "claude",
      "installed": true
    }
  ]
}
```

### Standalone Auth Status

```http
GET /auth/session
```

Returns the current local auth posture for the standalone dashboard and API, including whether auth is required, whether the current request is authenticated, whether token auth is configured, whether dashboard password auth is configured, and whether the current bind mode is exposing a public-host warning.

Example response:

```json
{
  "required": true,
  "authenticated": false,
  "hasTokenAuth": false,
  "hasPasswordAuth": true,
  "publicHostWarning": false,
  "boundHost": "127.0.0.1"
}
```

### Dashboard Login

```http
POST /auth/login
Content-Type: application/json

{
  "password": "correct horse battery staple"
}
```

Successful response:

```json
{
  "required": true,
  "authenticated": true,
  "hasTokenAuth": false,
  "hasPasswordAuth": true,
  "publicHostWarning": false,
  "boundHost": "127.0.0.1"
}
```

### Command Router

```http
POST /api/v1/command
Content-Type: application/json

{
  "type": "send_chat",
  "payload": {
    "targetSessionId": "7d9fca29-a5d3-46ab-b16b-272f0187a8d5",
    "message": "Fix the login bug"
  }
}
```

Use raw `targetSessionId` from `sessions[]` whenever possible. Synthetic route ids are transport helpers, not the canonical runtime identity.

### Runtime Snapshot

```http
GET /api/v1/runtime/{sessionId}/snapshot
```

Returns the latest session-host text snapshot for CLI runtimes, including `seq`, `text`, `truncated`, `cols`, and `rows`.

### Runtime Events

```http
GET /api/v1/runtime/{sessionId}/events
```

Server-Sent Events stream for a hosted CLI runtime. The stream sends:

- `runtime_snapshot` immediately when available
- session-host events such as `session_output`, `session_exit`, `write_owner_changed`

### Standalone Preferences

```http
GET /api/v1/standalone/preferences
POST /api/v1/standalone/preferences
```

Reads or updates standalone-local preferences such as:

- saved default bind host (`127.0.0.1` vs `0.0.0.0`)
- whether token auth is configured
- whether dashboard password auth is configured
- whether the saved/current host mode should surface a LAN/public warning

Example response:

```json
{
  "standaloneBindHost": "0.0.0.0",
  "currentBindHost": "127.0.0.1",
  "hasPasswordAuth": true,
  "hasTokenAuth": false,
  "publicHostWarning": false
}
```

Example update request:

```http
POST /api/v1/standalone/preferences
Content-Type: application/json

{
  "standaloneBindHost": "0.0.0.0"
}
```

### Workspace Mux State

```http
GET /api/v1/mux/{workspaceName}/state
GET /api/v1/mux/{workspaceName}/socket-info
POST /api/v1/mux/{workspaceName}/control
GET /api/v1/mux/{workspaceName}/events
```

These routes expose the local terminal mux workspace state and control/event channels for standalone/local workflows.

For the user-facing explanation of `adhmux`, workspace files, and mux control sockets, see [Terminal Mux](terminal-mux.md).

## WebSocket

Connect to `ws://localhost:3847/ws` for real-time standalone updates.

```js
const ws = new WebSocket('ws://localhost:3847/ws');

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  console.log(message);
};
```

The standalone WebSocket currently carries:

- initial status payloads
- command results
- shared transport topic subscriptions

Like the HTTP API, the WebSocket requires either:

- a valid local dashboard session cookie, or
- token auth on the upgrade request (for example `?token=...`, or an authorization bearer header when your client supports custom headers)

Supported shared subscription topics:

- `session.chat_tail`
- `machine.runtime`
- `session_host.diagnostics`
- `session.modal`
- `daemon.metadata`

## Capability-Driven Clients

If you are building against the local API, rely on runtime metadata instead of hardcoded provider assumptions.

- `sessions[].capabilities` tells you which commands are valid
- `sessions[].providerControls` describes provider-declared controls such as model/mode selectors
- `sessions[].controlValues` carries the provider's current selected control values when available
- `sessions[].summaryMetadata` carries compact always-visible provider metadata when available
- `availableProviders[]` tells you which built-in providers are present and installed on this machine

## Common Command Types

Available commands depend on the target session. Read `sessions[].capabilities` before assuming a command is valid.

Common command types:

| Command | Description |
|---------|-------------|
| `send_chat` | Send a message to the target session |
| `read_chat` | Read current chat state |
| `new_chat` | Start a new chat when supported |
| `list_chats` | List available chats when supported |
| `switch_chat` | Switch to another chat/session when supported |
| `resolve_action` | Approve or reject a pending action |
| `change_model` | Change model when exposed by the provider |
| `set_mode` | Change mode when exposed by the provider |
| `set_thought_level` | Change ACP thought-level style controls |
| `launch_cli` | Launch a CLI or ACP session |
| `stop_cli` | Stop a CLI or ACP session |

Session-host operator actions are also routed through the same command surface:

- `session_host_get_diagnostics`
- `session_host_resume_session`
- `session_host_restart_session`
- `session_host_stop_session`
- `session_host_prune_duplicate_sessions`
- `session_host_force_detach_client`
- `session_host_acquire_write`
- `session_host_release_write`

For recovery workflows and diagnostics meaning, see [Session Host](session-host.md).

## Authentication

By default the local API follows the standalone auth state.

- if no token and no dashboard password are configured, the local API is open
- if token auth is enabled, API calls can use bearer auth or a `?token=` query parameter
- if dashboard password auth is enabled, browser sessions use a local cookie-backed login flow
- unauthenticated `/api/*` requests return `401 Unauthorized. Provide dashboard session cookie or token auth.`

Relevant auth routes:

```http
GET  /auth/session
POST /auth/login
POST /auth/logout
POST /auth/password
```

Password management examples:

Set or rotate the dashboard password:

```http
POST /auth/password
Content-Type: application/json

{
  "currentPassword": "old-secret",
  "newPassword": "new-secret"
}
```

Clear the dashboard password:

```http
POST /auth/password
Content-Type: application/json

{
  "currentPassword": "current-secret",
  "clear": true
}
```

Successful password mutation response shape:

```json
{
  "success": true,
  "required": true,
  "authenticated": true,
  "hasTokenAuth": false,
  "hasPasswordAuth": true,
  "publicHostWarning": false,
  "boundHost": "127.0.0.1"
}
```

For operator/API access, token auth is still the main direct mechanism:

```bash
adhdev standalone --token mysecret
```

Then send either a bearer token or query token:

```bash
curl -H "Authorization: Bearer mysecret" \
  http://localhost:3847/api/v1/status
```

```bash
curl "http://localhost:3847/api/v1/status?token=mysecret"
```

Standalone also allows a same-origin bootstrap path for the initial dashboard password/network-preference mutation when no auth exists yet. Once token auth or password auth is configured, those mutations require an authenticated request.

Practical examples:

- use `/auth/session` to decide whether the local dashboard should show a password prompt
- use `/auth/password` to set, rotate, or clear the local dashboard password
- use `/api/v1/standalone/preferences` to read or change the saved default bind host

## Practical Rules

- `sessions[]` is canonical
- raw `sessionId` is the canonical runtime identity
- chat/screenshot/terminal live state should be treated as transport-specific live data, not something mirrored into every status payload
- inventory presence is not the same as verified support; use the compatibility pages to set expectations
