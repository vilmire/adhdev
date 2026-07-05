# Repo Mesh — OSS Developer Notes

Repo Mesh lets one **coordinator** agent orchestrate work across many **nodes**
(daemons, worktrees, or remote machines) that share a repo. The coordinator is a
normal CLI/ACP agent session given a set of `mesh_*` MCP tools and a generated
system prompt; the nodes are worker sessions it dispatches tasks to. All of the
persistence, queueing, ledgering, refinery (auto-convergence), and event delivery
logic for that lives in OSS packages and is documented here.

## OSS vs cloud boundary

| Concern | Lives in |
| --- | --- |
| Mesh engine — config, queue, ledger, missions, refinery, delivery policy, events | `oss/packages/daemon-core/src/mesh/` + `repo-mesh-types.ts` |
| MCP tool handlers (`mesh_*`) | `oss/packages/mcp-server/src/tools/mesh-tools.ts` |
| Dashboard UI (list, detail, queue, review inbox) | `oss/packages/web-core/src/pages/repo-mesh/` |
| Shared status/git normalizers | `oss/packages/mesh-shared` (`@adhdev/mesh-shared`) |
| Cloud transport (P2P relay, CF DO signaling, billing/plan gating) | `packages/` (proprietary) |
| **Operator & policy guide / internals walkthrough** | `docs/guides/REPO_MESH_GUIDE.md`, `docs/guides/REPO_MESH_DEV.md` (cloud superproject) |

The operational rules (mission lifecycle, refine workflow, fast-forward bypass,
delegated-worker policy, when to reuse vs. relaunch a session) are documented in
the cloud superproject under `docs/guides/REPO_MESH_GUIDE.md` (operations) and
`docs/guides/REPO_MESH_DEV.md` (developer internals). This file documents only the
OSS code surface those guides build on.

## Code structure

### `daemon-core/src/mesh/`

| File | Responsibility |
| --- | --- |
| `coordinator-prompt.ts` | Builds the coordinator system prompt from live mesh state. Expands `{{meshName}}`, `{{nodes}}`, `{{mission}}`, `{{policy}}`, `{{tools}}`, `{{workflow}}`, `{{rules}}` placeholders; supports user overrides in `~/.adhdev/coordinator-prompts/`. |
| `coordinator-registry.ts` | Tracks which daemon/session currently owns the coordinator role for a mesh. |
| `contracts.ts` | Internal contracts/interfaces shared across mesh modules. |
| `mesh-ledger.ts` | Append-only event ledger (task dispatch/complete/fail, session/node lifecycle, checkpoints) + completion-evidence builders. JSONL on disk, SQLite at runtime. |
| `mesh-ledger-reconciliation.ts` | Reconciles ledger state vs. live runtime to detect missed terminal events. |
| `mesh-work-queue.ts` | Task queue: enqueue/claim/update, task modes & guardrails (`live_debug_readonly` forbidden-op detection), capability-tag matching, dependencies. |
| `mesh-runtime-store.ts` | `better-sqlite3` runtime store — the source of truth for queue, dispatches, deliveries, events, missions, fingerprints. |
| `mesh-missions.ts` | Mission records (multi-task goals). Progress is *derived* from queue task statuses, never stored. |
| `mesh-active-work.ts` | Computes the live "active work" view (queue + direct dispatch) with per-task status/staleness. |
| `mesh-delivery-policy.ts` | Decides whether a task delivers `immediate` / `queued` / `rejected` based on target session state; tracks delivery records. |
| `mesh-host-ownership.ts` | Resolves host vs. member daemon role and which daemon may own the coordinator/queue. |
| `mesh-events-coordinator.ts` | The event hub: routes worker terminal/approval events back to the right coordinator (local inject vs. pending-event queue), with workspace→mesh recovery. |
| `mesh-events-pending.ts` | Pending-event inbox the coordinator drains via `get_pending_mesh_events`. |
| `mesh-events-stale.ts` | Stale/long-generating completion reconciliation helpers. |
| `mesh-events-utils.ts` | Shared event parsing/identity helpers. |
| `mesh-routing.ts` | Resolves delegate-worker routing metadata; records unroutable delegate events. |
| `mesh-review-inbox.ts` | Review-inbox model (work awaiting human approval/merge). |
| `mesh-fast-forward.ts` | Deterministic clean-node fast-forward (ff-only catch-up without a session). |
| `mesh-refine-status.ts` | Summarizes async refine jobs (`accepted`/`running`/`completed`/`failed`) from ledger + pending events. |
| `mesh-refine-batch.ts` | Batch convergence of multiple sibling worktrees through the refine path. |
| `refine-config.ts` | Parses `.adhdev/refine.{json,yaml}` — validation command plans, submodule auto-publish opt-in, bootstrap sourcing. |
| `worktree-bootstrap-config.ts` | Parses/evaluates worktree bootstrap config + staleness (sha256 of `staleInputs`). |
| `mesh-task-stats.ts` | Aggregate task statistics for status/summary views. |
| `mesh-visualization.ts` | Graph/visualization shaping for the dashboard. |
| `preview-freshness.ts` | Tracks preview-deploy freshness relative to node commits. |
| `p2p-relay-failure.ts` | Classifies P2P relay failures for delegated dispatch. |

### `daemon-core/src/repo-mesh-types.ts`

The shared type surface (see **Data models** below). Notably, the live
`RepoMeshSessionStatus` shape is re-exported from `@adhdev/mesh-shared` so the
standalone and cloud paths resolve the same definition.

### `daemon-core/src/commands/mesh-coordinator.ts`

Resolves how a given provider registers the mesh MCP server before a coordinator
session starts. `resolveMeshCoordinatorSetup()` returns one of `auto_import`
(write to the CLI's MCP config file), `manual` (print a template the user pastes),
`cli_command` (e.g. `codex mcp add` / `gemini mcp add`), or `unsupported`.
`applyMeshCoordinatorSystemPromptInjection()` injects the generated prompt, and
`buildMeshCoordinatorRegistrationPlan()` assembles the full launch plan.

### `mcp-server/src/tools/mesh-tools.ts`

Defines and implements every `mesh_*` MCP tool the coordinator calls. The tool
set (~30 tools) includes:

- **Inspection** — `mesh_status`, `mesh_list_nodes`, `mesh_git_status`,
  `mesh_view_queue`, `mesh_task_history`, `mesh_review_inbox`,
  `mesh_read_chat`, `mesh_read_debug`
- **Dispatch** — `mesh_enqueue_task`, `mesh_send_task`, `mesh_launch_session`,
  `mesh_queue_cancel`, `mesh_queue_requeue`, `mesh_approve`
- **Missions** — `mesh_mission_upsert`
- **Git / convergence** — `mesh_checkpoint`, `mesh_fast_forward_node`,
  `mesh_refine_node`, `mesh_refine_batch`, `mesh_refine_plan`,
  `mesh_refine_config_schema`, `mesh_validate_refine_config`,
  `mesh_suggest_refine_config`
- **Topology / housekeeping** — `mesh_clone_node`, `mesh_remove_node`,
  `mesh_cleanup_sessions`, `mesh_reconcile_ledger`, `mesh_prune_stale_direct`

Most read tools accept `compact` (default `true`) to bound token output.

### `web-core/src/pages/repo-mesh/`

Shared React surface used by both standalone and cloud dashboards:

- `MeshListView` — mesh selector / overview
- `MeshDetailView` — single mesh: nodes, queue, host, graph
- `MeshNodeList`, `MeshHostDaemonSection`, `MeshQueueSection`,
  `ReviewInboxSection` — sections within the detail view
- `MeshHermesMcpConfig` — coordinator MCP-config helper UI
- Hooks: `useMeshList`, `useMeshGraph`, `useMeshQueue`, `useMeshReviewInbox`,
  `useMeshNodeActions`
- `types.ts` — UI-facing `MeshNode` / `MeshEntry` / `MeshQueueEntry` shapes

## Data models (`repo-mesh-types.ts`)

### `LocalMeshEntry` — the persisted mesh

Stored in `~/.adhdev/meshes.json` (`{ meshes: LocalMeshEntry[] }`). Key fields:

- `id`, `name`, `repoIdentity`, `repoRemoteUrl?`, `defaultBranch?`
- `policy: RepoMeshPolicy` — checkpoint/approval requirements, `maxParallelTasks`,
  `allowedProviders`, `spawnedSessionVisibility`, `delegatedWorkerAutoApprove`,
  `autoFastForward`, `allowAutoPublishSubmoduleMainCommits`, dirty-workspace
  behavior
- `coordinator: RepoMeshCoordinatorConfig` — coordinator CLI/registration config
- `meshHost?: RepoMeshHostMetadata` — host/member role + pairing state
- `nodes: LocalMeshNodeEntry[]`, `createdAt`, `updatedAt`

`LocalMeshNodeEntry` describes each node: `workspace`, `repoRoot?`, `daemonId?`,
`machineId?`, `capabilities?` (matching tags), `userOverrides`, `policy`,
`systemPrompt?` (per-node prompt line), `isLocalWorktree?`, `worktreeBranch?`,
`clonedFromNodeId?`, `worktreeBootstrap?`, `relatedRepos?`, `role?`.

`RepoMeshStatus` / `RepoMeshNodeStatus` are the **runtime, non-persisted**
projections (health, git status, active sessions, fast-forward eligibility,
peer connection state) computed on demand from the live mesh.

### `MeshWorkQueueEntry` — a queued task (`mesh-work-queue.ts`)

`id`, `meshId`, `message`, `status` (`pending`/`assigned`/`completed`/`failed`/
`cancelled`), `taskMode?` (`code_change` | `validation` | `live_debug_readonly` |
`launch_app` | `convergence`), `targetNodeId?`, `targetSessionId?`,
`requiredTags?`, `dependsOn?`, `missionId?`, `blockedReason?`, `assignedNodeId?`,
`assignedSessionId?`, `requeueCount?`/`maxRetries?`, `autoLaunch?`,
`dispatchTimestamp?`, `createdAt`, `updatedAt`.

`DirectDispatchRecord` is the row shape for `mesh_send_task` direct dispatches
(distinct from queued tasks — see the `mesh_direct_dispatches` table).

### `MeshMissionRecord` — a multi-task goal (`mesh-missions.ts`)

`id`, `meshId`, `title`, `goal`, `status` (`active` | `paused` | `completed` |
`abandoned`), `createdAt`, `updatedAt`. Progress (`MeshMissionTaskAggregate`) is
computed from queue tasks carrying `missionId`, never persisted on the mission.

### `MeshLedgerEntry` — an event record (`mesh-ledger.ts`)

`id`, `meshId`, `timestamp`, `kind` (`task_dispatched`, `task_completed`,
`task_failed`, `task_stalled`, `task_approval_needed`, `session_launched`,
`node_cloned`, `coordinator_started`, `direct_fast_forward`, … — see
`MeshLedgerKind`), `nodeId?`, `sessionId?`, `providerType?`, and a free-form
`payload`. Completion events carry a richer `MeshTaskCompletionEvidence`
(worker result, changed files, validation/git deferral, checkpoint).

## Persistence contract

Everything is rooted at the daemon config dir (`getConfigDir()`, default
`~/.adhdev/`):

- **Mesh config** — `~/.adhdev/meshes.json` (`LocalMeshConfig`).
- **Runtime store** — `~/.adhdev/mesh-ledger/mesh-runtime.db`
  (`better-sqlite3`; migrated from the legacy `beads.db`). This is the runtime
  source of truth. Tables include:
  - `mesh_queue` — work-queue rows (full entry in a `payload` JSON column)
  - `mesh_direct_dispatches` — `mesh_send_task` direct dispatch records
  - `mesh_session_delivery` — delivery decisions/records per task (queued/acked/…)
  - `mesh_event_ledger` — runtime event ledger (G2: source of truth; JSONL is a
    legacy/export artifact)
  - `mesh_pending_events` — coordinator inbox drained via `get_pending_mesh_events`
  - `mesh_completion_fingerprints` — idempotency (dedup of completion events).
    The former `mesh_direct_delivered_events` table (retired R3 direct-delivered
    marker) was dropped by a one-shot `DROP TABLE IF EXISTS` migration in
    `MeshRuntimeStore.migrateMeshIsolationColumns` — no live code references it.
  - `mesh_completion_conflicts`, `mesh_tool_call_log`, `mesh_missions`,
    `remote_idle_sessions`
- **JSONL ledger** — `~/.adhdev/mesh-ledger/<meshId>.jsonl` (+ rotated
  `.<n>.jsonl` / `.archive.jsonl`), mode `0o600`, atomic append. Retained as
  export/import/debug/legacy; the SQLite `mesh_event_ledger` is authoritative.
- **Legacy queue file** — `~/.adhdev/mesh-ledger/<meshId>.queue.json` (migrated
  into `mesh_queue` on first runtime-store open).
- **Coordinator prompt overrides** — `~/.adhdev/coordinator-prompts/<cliType>.md`,
  `<cliType>.append.md`, `default.md`, `default.append.md`.
- **Refine / bootstrap config** — `.adhdev/refine.{json,yaml,yml}` and the
  worktree-bootstrap config, read from the repo working tree (not `~/.adhdev`).

## `@adhdev/mesh-shared`

A pure, dependency-free leaf package (`oss/packages/mesh-shared`) that exists to
kill a recurring divergence bug: the cloud (P2P) and standalone (local/IPC)
transports each used to carry their own hand-synced copy of the mesh/git status
normalizers, and they drifted — one path would strip or reshape fields the other
kept. Both cores now import this single source of truth.

It must stay a pure leaf: types + pure functions on plain JS objects, **no
Node/DOM APIs, no git exec, no transport, empty dependency set**. Exports:

- `json` — safe JSON helpers
- `types` — shared status types, incl. `RepoMeshSessionStatus`
  (re-exported by `daemon-core`'s `repo-mesh-types.ts`)
- `git-normalize`, `git-summarize` — git status normalization/summarization
- `session-normalize` — session status normalization

`daemon-core` imports it for the canonical session/git status shapes; `web-core`
imports the same normalizers so the dashboard renders identically regardless of
which transport delivered the data.

## Extension points

### Add a new `mesh_*` MCP tool

1. Add the tool definition (name, description, input schema) and its handler in
   `mcp-server/src/tools/mesh-tools.ts`. Default new read tools to `compact: true`
   to keep coordinator token cost bounded.
2. Implement the engine logic in the relevant `daemon-core/src/mesh/` module
   (queue mutation → `mesh-work-queue.ts`, persisted state → `mesh-runtime-store.ts`,
   an event → `mesh-ledger.ts` + `mesh-events-coordinator.ts`). Keep the MCP
   handler thin — orchestration only.
3. If the coordinator should know the tool exists, add a row to the `{{tools}}`
   table in `coordinator-prompt.ts` so it appears in the generated prompt.
4. Surface any new persisted shape in `repo-mesh-types.ts` (and in
   `@adhdev/mesh-shared` if both transports must read it identically).

### Customize the coordinator prompt

Per the `{{placeholder}}` system in `coordinator-prompt.ts`, operators can drop
override/append files under `~/.adhdev/coordinator-prompts/` without code changes.
CLI-specific files (`<cliType>.md`) take precedence over `default.*`, and the
node/policy facts are still substituted into overrides via the same placeholders.
To add a new prompt layer in code, extend `buildCoordinatorSystemPrompt()` and
register the placeholder so overrides can reference it.
