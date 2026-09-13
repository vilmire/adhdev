/**
 * MCP tool behavior annotations — the single source of truth for every tool's
 * `annotations` block.
 *
 * ─── What these are ─────────────────────────────────────────────────────
 *
 * MCP defines four optional behavior hints on a tool definition. Clients use
 * them for real safety decisions: whether to auto-run a tool without asking,
 * whether to warn before running it, whether a retry after a timeout is safe.
 * They are hints about the tool's CAPABILITY, not a sandbox — nothing here
 * enforces anything. The daemon-side gates (dry-run defaults, `execute` flags,
 * ownership checks) remain the actual enforcement.
 *
 *   readOnlyHint    — the tool does not modify any state.
 *   destructiveHint — the tool can destroy or irreversibly overwrite state.
 *                     Only meaningful when readOnlyHint is false. Per spec the
 *                     DEFAULT is true, so a non-read-only tool that is merely
 *                     additive must say `destructiveHint: false` explicitly.
 *   idempotentHint  — calling it twice with the same args has no additional
 *                     effect beyond the first call.
 *   openWorldHint   — the tool interacts with an open, unbounded external
 *                     world (spawning agents, git remotes, other machines)
 *                     rather than a closed local domain.
 *
 * ─── Why one central map instead of inline literals ─────────────────────
 *
 * Tool definitions live in 19 files, and `mesh-tool-schemas.ts` alone holds 61
 * of them. Inlining an `annotations` object in each definition would put the
 * safety classification 1,500 lines away from the next one, where nobody can
 * diff "everything we call destructive" in one read. Worse, it makes OMISSION
 * invisible: a new tool without annotations looks exactly like a tool that was
 * considered and left alone. Here, `assertEveryToolAnnotated()` (exercised by
 * tool-annotations.test.ts) fails the build for an unannotated tool, so the
 * classification cannot silently rot as tools are added.
 *
 * ─── How each tool was classified ───────────────────────────────────────
 *
 * From the tool's own documented behavior, not from its name. Three rules the
 * classifications below apply consistently:
 *
 * 1. DRY-RUN DEFAULTS DO NOT MAKE A TOOL READ-ONLY. `mesh_refine_node`,
 *    `mesh_prune_stale_direct` and `mesh_fast_forward_node` all default to a
 *    plan-only response, but each takes an `execute`/`dry_run` flag that
 *    merges, deletes or pushes for real. The hint describes what the tool CAN
 *    do when called, and a client deciding "may I auto-run this?" must see the
 *    capability, not the default. Annotating the safe default would be exactly
 *    the kind of hint that gets someone hurt.
 *
 * 2. IDEMPOTENT MEANS "THE SECOND CALL CHANGES NOTHING MORE", not "safe to
 *    retry". Deletes are idempotent (removing an already-removed node leaves
 *    the same end state); enqueues are NOT (a second call is a second task).
 *
 * 3. OPEN-WORLD MEANS LEAVING THIS DAEMON'S CLOSED DOMAIN. Reaching a REMOTE
 *    mesh node over P2P, spawning a CLI agent, or touching a git remote is
 *    open-world. Reading this daemon's own local ledger or config file is not.
 */

/** MCP tool behavior hints. Mirrors the `ToolAnnotations` shape in the MCP spec. */
export interface ToolBehaviorAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * A read-only tool that stays inside this daemon's own local state.
 * Destructive/idempotent are pinned to the only values consistent with
 * read-only (nothing is destroyed; repeating a read changes nothing).
 */
const READ_LOCAL: ToolBehaviorAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** A read-only tool that reaches a remote node / external agent to do the read. */
const READ_REMOTE: ToolBehaviorAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * A tool that writes, but only additively — it appends or overwrites one
 * caller-named value and destroys nothing else. `destructiveHint: false` is
 * load-bearing here: the spec default is true, so staying silent would mark
 * every one of these as destructive.
 */
const WRITE_LOCAL_SAFE: ToolBehaviorAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Additive local write whose repetition accumulates (a new record each call). */
const WRITE_LOCAL_ACCUMULATING: ToolBehaviorAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/** A destructive local write: deletes or irreversibly overwrites existing state. */
const DESTRUCTIVE_LOCAL: ToolBehaviorAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

/** A destructive operation that reaches a remote node / git remote / live session. */
const DESTRUCTIVE_REMOTE: ToolBehaviorAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * Dispatches work to an agent in the outside world. Not destructive by itself
 * (it creates a task), but NOT idempotent — calling it twice runs the work
 * twice — and unambiguously open-world: it spawns a CLI agent that can do
 * anything the agent can do.
 */
const DISPATCH: ToolBehaviorAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * Acts on a live remote session but converges on one end state (approve a
 * pending prompt, answer a question, release a gate): repeating it does not
 * add a second effect.
 */
const CONTROL_REMOTE_IDEMPOTENT: ToolBehaviorAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * Per-tool classification. Every tool the server can publish MUST appear here;
 * `assertEveryToolAnnotated()` enforces it.
 */
export const TOOL_ANNOTATIONS: Record<string, ToolBehaviorAnnotations> = {
  // ── Standard mode: inspection ────────────────────────────────────────
  list_daemons: READ_LOCAL,
  list_sessions: READ_LOCAL,
  check_pending: READ_LOCAL,
  // Reads a live agent session's transcript/screen through the daemon.
  read_chat: READ_REMOTE,
  read_chat_debug: READ_REMOTE,
  spec_debug: READ_REMOTE,
  screenshot: READ_REMOTE,

  // ── Standard mode: session control ───────────────────────────────────
  // Spawns a CLI/ACP agent process — the canonical open-world action.
  launch_session: DISPATCH,
  // Terminates a running agent process: destructive (in-flight work is lost),
  // idempotent (stopping an already-stopped session converges).
  stop_session: DESTRUCTIVE_REMOTE,
  // Delivers a message into a live agent's context. Not destructive, but each
  // call is an additional message, so not idempotent.
  send_chat: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  // Resolves a pending approval prompt to a single decided state.
  approve: CONTROL_REMOTE_IDEMPOTENT,

  // ── Git (read) ───────────────────────────────────────────────────────
  git_status: READ_LOCAL,
  git_log: READ_LOCAL,
  git_diff: READ_LOCAL,

  // ── Git (write) ──────────────────────────────────────────────────────
  // Creates a commit. Additive — it does not rewrite or drop history — but a
  // second call creates a second commit.
  git_checkpoint: WRITE_LOCAL_ACCUMULATING,
  // Publishes to a git REMOTE: open-world, and irreversible once other people
  // fetch it. Idempotent in that re-pushing the same commits is a no-op.
  git_push: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },

  // ── Mesh: read-only inspection ───────────────────────────────────────
  // These reach across the mesh (remote nodes over P2P) but only to read.
  mesh_status: READ_REMOTE,
  mesh_list_nodes: READ_LOCAL,
  // Explicitly documented as read-only and fetch-free — a pure scoring preview.
  mesh_route_preview: READ_LOCAL,
  mesh_view_queue: READ_LOCAL,
  mesh_graph_view: READ_LOCAL,
  mesh_task_history: READ_LOCAL,
  mesh_ledger_query: READ_LOCAL,
  mesh_mission_list: READ_LOCAL,
  mesh_review_inbox: READ_LOCAL,
  mesh_node_slots_list: READ_LOCAL,
  mesh_magi_kind_panel_list: READ_LOCAL,
  mesh_coordinator_prompt_append_get: READ_LOCAL,
  // Read-only config helpers (all three modes — schema/validate/suggest —
  // return a draft; neither writes the config file).
  mesh_refine_config: READ_LOCAL,
  mesh_change_impact_config: READ_LOCAL,
  // Documented read-only discovery/planning.
  mesh_plan_onboarding: READ_LOCAL,
  mesh_refine_plan: READ_LOCAL,
  // Read-only, but probes the node's installed CLIs to draft a profile.
  mesh_node_slots_propose: READ_REMOTE,
  // Reads that cross to a (possibly remote) node.
  mesh_read_chat: READ_REMOTE,
  mesh_read_debug: READ_REMOTE,
  mesh_read_terminal: READ_REMOTE,
  mesh_read_node_logs: READ_REMOTE,
  mesh_git_status: READ_REMOTE,
  mesh_list_pending_approvals: READ_REMOTE,

  // ── Mesh: dispatch (spawns delegated agents) ─────────────────────────
  mesh_enqueue_task: DISPATCH,
  mesh_enqueue_batch: DISPATCH,
  mesh_send_task: DISPATCH,
  mesh_launch_session: DISPATCH,
  // Fans a read-only investigation out to a PANEL of agents on other machines.
  // The investigation is read-only; dispatching it is not.
  mesh_magi_review: DISPATCH,
  // Collects an already-dispatched fan-out. Re-collecting re-synthesizes the
  // same replicas rather than dispatching more.
  mesh_magi_collect: CONTROL_REMOTE_IDEMPOTENT,
  // Delivers a memo to a worker's next tool call — one more memo per call.
  mesh_notify_worker: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },

  // ── Mesh: live session control ───────────────────────────────────────
  mesh_approve: CONTROL_REMOTE_IDEMPOTENT,
  mesh_answer_question: CONTROL_REMOTE_IDEMPOTENT,
  // Injects raw keystrokes into a live PTY. Not idempotent (keys repeat), and
  // destructive-capable: the keys can be anything, including an interrupt.
  mesh_send_keys: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },

  // ── Mesh: queue mutation ─────────────────────────────────────────────
  // Cancels queued/assigned work — the pending task is discarded.
  mesh_queue_cancel: DESTRUCTIVE_LOCAL,
  // Returns a task to pending, optionally REWRITING its instruction (the
  // previous instruction is overwritten).
  mesh_queue_requeue: DESTRUCTIVE_LOCAL,
  // Restores held events back to pending. Explicitly documented as lossless.
  mesh_requeue_held_events: WRITE_LOCAL_SAFE,

  // ── Mesh: graph gates ────────────────────────────────────────────────
  // Takes/releases a lease. Lease-guarded and convergent, not destructive.
  mesh_graph_gate_claim: WRITE_LOCAL_SAFE,
  mesh_graph_gate_release: WRITE_LOCAL_SAFE,
  // Gives up on a gate so the graph reaches a TERMINAL state — the work behind
  // it is abandoned, which is not recoverable by releasing it later.
  mesh_graph_gate_abandon: DESTRUCTIVE_LOCAL,

  // ── Mesh: lifecycle / bootstrap ──────────────────────────────────────
  // Creates new mesh/node records. Additive; a repeat creates another.
  mesh_create: WRITE_LOCAL_ACCUMULATING,
  mesh_add_node: WRITE_LOCAL_ACCUMULATING,
  // Creates a git WORKTREE on disk for a (possibly remote) node.
  mesh_clone_node: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  // Deregisters a node.
  mesh_remove_node: DESTRUCTIVE_LOCAL,
  // Removes worktree nodes — deletes on-disk worktrees on the target machine.
  mesh_cleanup_worktree_nodes: DESTRUCTIVE_REMOTE,
  // Deletes delegated session records (reviewable history is discarded).
  mesh_cleanup_sessions: DESTRUCTIVE_LOCAL,
  // Deletes orphaned dispatch records when execute=true (see rule 1 above).
  mesh_prune_stale_direct: DESTRUCTIVE_LOCAL,
  // Restarts a daemon process: in-flight sessions on that daemon go away.
  mesh_restart_daemon: DESTRUCTIVE_REMOTE,

  // ── Mesh: git convergence ────────────────────────────────────────────
  // The Refinery: validate → MERGE → PUSH → clean up the worktree when
  // executed. Reaches a git remote and removes the worktree afterwards.
  mesh_refine_node: DESTRUCTIVE_REMOTE,
  mesh_refine_batch: DESTRUCTIVE_REMOTE,
  // Merges/pushes when executed — strictly fast-forward (never force-pushes,
  // rebases, resets or cleans), but it does publish to a remote.
  mesh_fast_forward_node: DESTRUCTIVE_REMOTE,
  // Creates a commit on a node workspace.
  mesh_checkpoint: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },

  // ── Mesh: config writes ──────────────────────────────────────────────
  // Writes the repo `.adhdev/*` config families. `mesh_init` is the
  // first-time path; `mesh_reinit` is documented as OVERWRITE semantics on an
  // already-initialized repo, so it can replace a config the user edited.
  mesh_init: WRITE_LOCAL_SAFE,
  mesh_reinit: DESTRUCTIVE_LOCAL,
  // Writes `.adhdev/mesh.json` from the machine-local entry — overwrites the
  // committed file.
  mesh_write_mesh_json_config: DESTRUCTIVE_LOCAL,
  // Sets one named value, replacing only that value.
  mesh_node_slots_set: WRITE_LOCAL_SAFE,
  mesh_magi_kind_panel_set: WRITE_LOCAL_SAFE,
  mesh_coordinator_prompt_append_set: WRITE_LOCAL_SAFE,

  // ── Mesh: notes / missions / ledger ──────────────────────────────────
  // Appends a durable note; each call records another.
  mesh_record_note: WRITE_LOCAL_ACCUMULATING,
  // Retracts a note — the note stops being inherited by future coordinators.
  mesh_forget_note: DESTRUCTIVE_LOCAL,
  // Upsert: creates or updates one mission by id, converging on the given value.
  mesh_mission_upsert: WRITE_LOCAL_SAFE,
  // Imports MISSING ledger entries from peers — additive by construction.
  mesh_reconcile_ledger: WRITE_LOCAL_SAFE,

  // ── Worker mode ──────────────────────────────────────────────────────
  // Files this worker's terminal completion report. Idempotent by design: the
  // daemon reports a duplicate as accepted rather than as a failure.
  report_completion: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  // Each progress note is an additional note.
  progress_update: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  // Pulls context from peer workers — a read that crosses to other sessions.
  peer_context_pull: READ_REMOTE,
};

/**
 * Attach the classified annotations to a tool definition.
 *
 * Returns a NEW object rather than mutating: the `*_TOOL` consts are module
 * singletons shared by every mode, and several are published in more than one
 * registry (e.g. GIT_STATUS_TOOL appears in both standard and worker mode).
 *
 * Throws on an unclassified tool. A tool whose safety properties nobody has
 * stated is precisely the tool a client should not be guessing about, and a
 * silent passthrough here would publish it with no hints at all.
 */
export function withAnnotations<T extends { name: string }>(tool: T): T & { annotations: ToolBehaviorAnnotations } {
  const annotations = TOOL_ANNOTATIONS[tool.name];
  if (!annotations) {
    throw new Error(
      `[adhdev-mcp] Tool '${tool.name}' has no entry in TOOL_ANNOTATIONS. `
      + `Add one to src/tools/tool-annotations.ts classifying its read-only/destructive/idempotent/open-world behavior.`,
    );
  }
  return { ...tool, annotations };
}

/** Apply {@link withAnnotations} across a registry. */
export function annotateAll<T extends { name: string }>(tools: readonly T[]): Array<T & { annotations: ToolBehaviorAnnotations }> {
  return tools.map(withAnnotations);
}

/**
 * Assert that every tool in `tools` is classified, returning the names that are
 * not. Used by the test suite to fail the build when a tool is added without a
 * classification — the omission case that a per-tool inline literal cannot catch.
 */
export function findUnannotatedTools(tools: ReadonlyArray<{ name: string }>): string[] {
  return tools.filter(tool => !TOOL_ANNOTATIONS[tool.name]).map(tool => tool.name);
}
