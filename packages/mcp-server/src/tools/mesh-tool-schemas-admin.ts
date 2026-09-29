/**
 * MCP tool schemas — mesh administration (mesh-tools-mission.ts / mesh-tools-merged.ts
 * handlers): missions, approvals and questions, mesh / node lifecycle, session and
 * worktree cleanup, task history, ledger query, notes and ledger reconcile.
 * Pure data; ALL_MESH_TOOLS in mesh-tool-schemas.ts is the registry.
 */
import { enumOf, MESH_SESSION_CLEANUP_MODES } from '@adhdev/mesh-shared';

export const MESH_MISSION_UPSERT_TOOL = {
    name: 'mesh_mission_upsert',
    description: 'Create or update a persistent mission record so the plan survives coordinator restarts. Optional — tasks do not require a mission; use one when you want the plan tracked as a durable, named unit of work. '
        + 'Recommended for multi-task work: create a mission first, then attach every task to it with mission_id (mesh_enqueue_task, or a top-level mission_id on mesh_enqueue_batch, which applies to every entry). Update status to completed/abandoned when the outcome is decided. Progress is derived from task statuses — there is no separate progress field. '
        + 'Single mission: pass title (and optionally mission_id to update an existing one). '
        + 'Bulk status transition (e.g. one-time stale cleanup): pass mission_ids (array) + status to apply that status to many missions at once; title/goal are ignored and a per-mission result array is returned. mission_ids takes precedence over mission_id when both are given.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            mission_id: { type: 'string', description: 'Full mission id (exact match) to update. Omit to create a new mission — do not guess/truncate an id to force a create. An id that does not resolve to an existing mission is REJECTED (mission_not_found), never silently created under that id — use mesh_mission_list to get a valid full id. Ignored when mission_ids is provided.' },
            mission_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Bulk mode: apply `status` to every listed mission id in one call (stale cleanup). Requires `status`. Returns a per-mission { id, ok, status?, error? } result array. Overrides mission_id/title/goal.',
            },
            title: { type: 'string', description: 'Short mission title. Required to create/update a single mission; ignored in bulk (mission_ids) mode.' },
            goal: { type: 'string', description: 'Free-text mission goal/definition of done. Ignored in bulk (mission_ids) mode.' },
            status: { type: 'string', enum: ['active', 'paused', 'completed', 'abandoned'], description: 'Mission lifecycle status. Defaults to active on create. Required in bulk (mission_ids) mode.' },
            brief: {
                type: 'object',
                description: 'H2 (mission brief). Optional structured brief, rendered into every task dispatched under this mission\'s worker-protocol footer so a freshly launched worker sees it without a separate lookup. {goal (required — a brief with no goal is dropped, not stored empty), constraints?, doneCriteria?, handoffNotes?, ownedPaths?} — each of the four optional fields is a string array; done_criteria/handoff_notes/owned_paths snake_case aliases are also accepted though not published. Ignored in bulk (mission_ids) mode. When a non-empty brief is dropped (no goal, or a field of the wrong type), the response carries `briefIgnored: {reason, field?}` instead of silently discarding it. This is DISTINCT from the top-level `goal` field: `goal` is the mission record\'s short free-text summary shown in mesh_mission_list; `brief` is the longer structured packet a worker actually reads.',
                properties: {
                    goal: { type: 'string', description: 'What this mission is trying to accomplish. Required for the brief to be stored — an object with no goal is treated as no brief.' },
                    constraints: { type: 'array', items: { type: 'string' }, description: 'Hard constraints a worker must respect, e.g. "do not touch daemon-core", "no npm install".' },
                    doneCriteria: { type: 'array', items: { type: 'string' }, description: 'How to know the mission is actually done.' },
                    handoffNotes: { type: 'array', items: { type: 'string' }, description: 'Standing notes for whoever picks up mission work next.' },
                    ownedPaths: { type: 'array', items: { type: 'string' }, description: 'Paths this mission\'s tasks collectively own — surfaced to workers, not itself enforced (per-task owned_paths on mesh_enqueue_task/mesh_enqueue_batch/mesh_send_task is what claim-time enforcement reads).' },
                },
            },
        },
        // No hard-required field: the single path requires `title` and the bulk path
        // requires `mission_ids` + `status`; the handler enforces the mode-specific rule
        // and returns a clear error, rather than the schema forcing `title` on bulk calls.
        required: [],
    },
};

export const MESH_MISSION_LIST_TOOL = {
    name: 'mesh_mission_list',
    description: 'List missions with their goal, status, and live task progress (total/pending/assigned/completed/failed). '
        + 'Default (no `status`): non-terminal missions (active/paused) return in detail, while completed/abandoned missions are '
        + 'folded into a `historyFold` summary (counts by status + newest-first `missionIds`) rather than listed one-by-one — this '
        + 'keeps the payload bounded as a mesh accumulates hundreds of finished missions. To read finished missions in full, pass '
        + '`status` explicitly (e.g. ["completed"]); those are returned in detail but still capped by `limit` (default 50), with '
        + 'overflow reported as truncated=true + overflowIds. '
        + 'Per-mission stats (ledger-scanned durations/attempts) are OMITTED by default — the `tasks` aggregate carries progress; '
        + 'pass include_stats=true (or verbose=true) to attach them. '
        + 'Compact (default) elides the full goal to a capped preview; pass verbose=true for full goal text. Read-only.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            status: {
                type: 'array',
                items: { type: 'string', enum: ['active', 'paused', 'completed', 'abandoned'] },
                description: 'Optional status filter. Omit for the default folded view (active/paused in detail, completed/abandoned summarized). '
                    + 'Provide it (e.g. ["completed"]) to list those missions in detail — bounded by `limit`.',
            },
            limit: {
                type: 'number',
                description: 'Max missions returned in detail (default 50). Overflow beyond the cap is reported as truncated=true + overflowIds.',
            },
            verbose: { type: 'boolean', description: 'Return full goal text instead of a capped preview (also attaches stats). Defaults to false (compact).' },
            include_stats: { type: 'boolean', description: 'Attach per-mission ledger stats (durations/attempts). Off by default; tasks aggregate is usually enough.' },
        },
    },
};

export const MESH_APPROVE_TOOL = {
    name: 'mesh_approve',
    description: 'Approve or reject a pending action on a delegated agent session.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            session_id: { type: 'string', description: 'Agent session ID with pending approval.' },
            action: { type: 'string', enum: ['approve', 'reject'], description: 'Action to take.' },
        },
        required: ['node_id', 'session_id', 'action'],
    },
};

export const MESH_ANSWER_QUESTION_TOOL = {
    name: 'mesh_answer_question',
    description: 'Answer a multi-choice QUESTION (AskUserQuestion) a delegated agent session is waiting on. '
        + 'This is the counterpart to mesh_approve: a QUESTION (surfaced as an agent:waiting_choice event / status "awaiting_choice") is NOT a yes/no approval — '
        + 'it offers labelled options (optionally multi-select, optionally a freeform "Type something") and must be answered here, never with mesh_approve. '
        + 'Supply the promptId from the waiting_choice event and `answers`: an array with one entry per question, in question order. '
        + 'For a single-question prompt, the simplest valid form is answers: ["<exact label>"] or answers: [<1-based index>] — the bare label/index IS the entry. '
        + 'Each entry may instead be an object { select, freeform? } (questionId optional; entries match by position when omitted): '
        + '`select` is an option label (string), a 1-based index (number), or an array of labels/indices for a multi-select question; '
        + 'a freeform answer sets `freeform` to the text instead of `select`. '
        + 'The daemon drives the correct keystrokes into the provider TUI to submit the selection. '
        + 'RETURN CONTRACT: success:true means the answer RESOLVED against the session\'s active prompt and the submit keystrokes were DISPATCHED (submitted:true) — it does not prove the TUI finished redrawing, so confirm the session left awaiting_choice on a later status read. '
        + 'An unmatched option label, a stale promptId, or a provider that cannot answer questions returns success:false with the live option list in activePrompt — re-answer using one of those labels or its 1-based index.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID (from the waiting_choice event / mesh_list_nodes).' },
            session_id: { type: 'string', description: 'Agent session ID that is awaiting the question answer.' },
            promptId: { type: 'string', description: 'The InteractivePrompt promptId from the agent:waiting_choice event. Ensures the answer matches the active prompt.' },
            answers: {
                type: 'array',
                description: 'One entry per question in the prompt (in question order). Each entry answers a single question by selecting option label(s)/index(es), or by supplying freeform text. '
                    + 'An entry may be a bare option label (string) or 1-based index (number) — equivalent to { select: <that value> } — or the full { questionId?, select?, freeform? } object.',
                items: {
                    oneOf: [
                        { type: 'string', description: 'Shorthand: the exact option label to select.' },
                        { type: 'number', description: 'Shorthand: the 1-based option index to select.' },
                        {
                            type: 'object',
                            properties: {
                                questionId: { type: 'string', description: 'Optional question id from the prompt payload. When omitted, entries are matched to the prompt questions by array position.' },
                                select: {
                                    description: 'The chosen option(s): an option label (string), a 1-based option index (number), or an array of labels/indices for a multi-select question.',
                                    oneOf: [
                                        { type: 'string' },
                                        { type: 'number' },
                                        { type: 'array', items: { type: ['string', 'number'] } },
                                    ],
                                },
                                freeform: { type: 'string', description: 'Freeform text answer (for a "Type something" option). Mutually exclusive with select.' },
                            },
                        },
                    ],
                },
            },
        },
        required: ['node_id', 'session_id', 'promptId', 'answers'],
    },
};

export const MESH_LIST_PENDING_APPROVALS_TOOL = {
    name: 'mesh_list_pending_approvals',
    description: 'List every session across the mesh that is currently awaiting an approval decision (status awaiting_approval) — the mesh-wide approval inbox. '
        + 'mesh_approve resolves ONE (node_id, session_id) at a time; this read-only tool enumerates the full pending set so you can see all blocked sessions at once and drive a mesh_approve for each. '
        + 'Each row carries nodeId, sessionId, providerType, taskTitle, and how long it has been waiting (waitingSince/waitingMs), longest-waiting first. Does not mutate anything.',
    inputSchema: {
        type: 'object' as const,
        properties: {},
    },
};

export const MESH_CREATE_TOOL = {
    name: 'mesh_create',
    description: 'Bootstrap a brand-new mesh for a Git repository, or (mode="plan") dry-run the onboarding plan first. Mirrors `adhdev mesh create <name>`. A mesh groups one repo\'s workspaces/nodes so the coordinator can delegate work across them.\n'
        + '• mode="plan" — READ-ONLY Git-aware discovery + dry-run plan for a workspace path: Git root, normalized remotes/repo identity, current/default branch, main checkout vs linked worktree, dirty/conflict state, existing mesh/node membership. '
        + 'Returns a typed create+onboarding, add-existing-workspace, or clone-new-worktree plan with suggested .adhdev configs. Never fetches, writes config, or creates a mesh/node/branch/worktree. Run it before creating a mesh, adding a node (mesh_add_node) or cloning a worktree (mesh_clone_node).\n'
        + '• mode="create" (default) — a persistent write: run mode="plan" first and obtain explicit user approval. Pass workspace to auto-detect Git identity/branch/worktree through the read-only planner, or pass repo_remote_url / repo_identity explicitly. add_current:true also registers a node in the same call (workspace if given, else the daemon\'s cwd). Returns mesh_id (and node_id with add_current).\n'
        + 'BOOT-GATE: reachable in STANDARD mode (adhdev mcp, no --repo-mesh) — the no-mesh-yet bootstrap context — and in mesh mode (where create makes a SEPARATE additional mesh). `adhdev mcp --repo-mesh <id>` refuses to start without an existing meshId, so the flow is: standard-mode MCP → mesh_create → mesh_add_node → relaunch as `adhdev mcp --repo-mesh <returned mesh_id>`.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            mode: {
                type: 'string',
                enum: ['create', 'plan'],
                description: 'create (default) = create the mesh; plan = read-only onboarding discovery/dry-run plan. Each mode accepts only its own arguments — see the tool description.',
            },
            name: { type: 'string', description: 'create: human-readable mesh name (e.g. "adhdev-main"). Trimmed, max 100 chars. Required for create.' },
            repo_remote_url: { type: 'string', description: 'create: optional explicit Git remote URL. When omitted with repo_identity, identity is read-only auto-detected from workspace.' },
            repo_identity: { type: 'string', description: 'create: optional explicit normalized repo identity. Wins over repo_remote_url; when both are omitted, workspace is auto-detected.' },
            default_branch: { type: 'string', description: 'create: default branch for the repo (e.g. "main"). Optional; used as the merge/convergence target.' },
            add_current: { type: 'boolean', description: 'create: also register a node in this same call (parity with CLI --add-current). Uses `workspace` if provided, otherwise the daemon\'s current working directory.' },
            workspace: { type: 'string', description: 'Absolute workspace path on the daemon. plan: the checkout to inspect (required). create: used for Git auto-detection and, with add_current:true, node registration; defaults to the daemon cwd.' },
            mesh_id: { type: 'string', description: 'plan: optional existing mesh to validate against. In mesh mode defaults to the active mesh.' },
            operation: {
                type: 'string',
                enum: ['auto', 'add_existing', 'clone_worktree', 'create_mesh'],
                description: 'plan: planning intent. auto chooses create+onboard when no compatible mesh exists, otherwise add existing. clone_worktree requires branch and a clean source.',
            },
            branch: { type: 'string', description: 'plan: new branch name when operation=clone_worktree.' },
        },
    },
};

export const MESH_ADD_NODE_TOOL = {
    name: 'mesh_add_node',
    description: 'Register a workspace as a node in an EXISTING mesh — the second bootstrap step after mesh_create (or to add more nodes later). '
        + 'Mirrors `adhdev mesh add-node <mesh_id>` with --workspace / --read-only / --provider-priority. A node is a repo checkout on a daemon that the coordinator can launch agents on and delegate tasks to. '
        + 'mesh_id is REQUIRED in standard mode (pass the id returned by mesh_create); in mesh mode it defaults to the active mesh. workspace is the absolute path to the repo checkout ON THE DAEMON that owns it — the local base node is added by the daemon that created the mesh. '
        + 'This is a persistent mesh write: call mesh_create with mode="plan" first and obtain explicit user approval. The implementation re-runs that preflight before writing. NOTE: this registers an EXISTING directory as a node (including auto-detected linked worktrees). To CREATE a fresh git worktree + branch for isolated parallel work, use mesh_clone_node instead — that runs the actual `git worktree add`. '
        + 'Returns node_id + workspace so you can immediately target the node with mesh_launch_session / mesh_send_task / mesh_enqueue_task. '
        + 'That immediate-targeting path is right when the node is the only thing you were waiting on; when the work behind it is a multi-step plan, prefer declaring the whole plan in one mesh_enqueue_batch instead of registering, then enqueueing step by step.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            mesh_id: { type: 'string', description: 'Target mesh id (from mesh_create / mesh_status). Required in standard mode; defaults to the active mesh in mesh mode.' },
            workspace: { type: 'string', description: 'Absolute path to the repo checkout on the owning daemon (e.g. /Users/me/work/repo). Must be unique within the mesh.' },
            read_only: { type: 'boolean', description: 'Mark the node read-only (no launches/mutations targeted here). Parity with CLI --read-only.' },
            provider_priority: {
                type: 'array',
                items: { type: 'string' },
                description: 'Ordered provider types this node prefers when mesh_launch_session omits an explicit type (e.g. ["claude-cli","codex"]). Parity with CLI --provider-priority. A comma-separated string is also accepted.',
            },
            is_worktree: { type: 'boolean', description: 'Mark this workspace as an existing local git worktree (parity with CLI --worktree). This only tags an already-present worktree dir; it does NOT create one — use mesh_clone_node to create a worktree+branch.' },
        },
        required: ['workspace'],
    },
};

export const MESH_CLONE_NODE_TOOL = {
    name: 'mesh_clone_node',
    description: 'Create a new worktree-based node from an existing node for isolated parallel work. '
        + 'Creates a git worktree on a new branch so multiple tasks can run on separate branches simultaneously. This writes a branch, worktree and mesh node: call mesh_create with mode="plan", operation=clone_worktree and obtain explicit user approval first; the implementation re-runs the clean/source preflight. '
        + 'Then pin the tasks that should run there with target_node_id (the new node id in the response).',
    inputSchema: {
        type: 'object' as const,
        properties: {
            source_node_id: { type: 'string', description: 'Node ID to clone from (from mesh_list_nodes).' },
            branch: { type: 'string', description: 'Branch name for the new worktree (e.g. "feat/auth-refactor").' },
            base_branch: { type: 'string', description: 'Starting point for the branch (default: current HEAD).' },
        },
        required: ['source_node_id', 'branch'],
    },
};

export const MESH_REMOVE_NODE_TOOL = {
    name: 'mesh_remove_node',
    description: 'Remove a node from the mesh. If the node is a worktree, also cleans up the git worktree and directory. Session cleanup is controlled by mesh policy sessionCleanupOnNodeRemove unless session_cleanup_mode overrides it for this call. The coordinator\'s own local base node (same machine, NOT a worktree) is protected — removing it breaks live mesh membership and is rejected unless force:true is passed.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Node ID to remove.' },
            session_cleanup_mode: {
                ...enumOf(MESH_SESSION_CLEANUP_MODES),
                description: 'Optional override for cleanup of delegated sessions attached to this node. preserve keeps history/processes; stop stops live runtimes only; delete_stopped removes completed transcripts only; stop_and_delete stops live runtimes and deletes records.',
            },
            force: { type: 'boolean', description: 'Override the coordinator-base-node guard. Only set true to intentionally tear down this mesh; the coordinator must then be re-registered/restarted. Worktree nodes never need force.' },
        },
        required: ['node_id'],
    },
};

export const MESH_CLEANUP_WORKTREE_NODES_TOOL = {
    name: 'mesh_cleanup_worktree_nodes',
    description: 'Plan (dry-run, default) or execute safe removal of CONVERGED local worktree nodes (lifecycle retention). A node is eligible only when its feature branch is proven merged/pushed/converged AND every safety exclusion passes: no dirty/conflicted/stashed/submodule-drift state, no live session, no queue/direct-dispatch reference, no in-flight or blocked_review Refinery job, not the coordinator/base/cwd/evidence node. The automatic reconcile pass additionally requires two consecutive eligible ticks spanning a grace window (default 48h). Per-node reason codes are always returned; removal never uses force and branch refs are deleted only when proven fully merged.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Optional: restrict the plan/execute to a single node. When omitted, every node in the mesh is evaluated.' },
            dry_run: { type: 'boolean', description: 'Default true. true = read-only reason-coded plan (identical shape to the automatic pass); false = execute removal for every currently-eligible node (never forces; the non-destructive precheck re-runs immediately before each removal).' },
        },
        required: [],
    },
};

export const MESH_CLEANUP_SESSIONS_TOOL = {
    name: 'mesh_cleanup_sessions',
    description: 'Clean up delegated-session bookkeeping without removing nodes. Two families, selected by `mode` (REQUIRED):\n'
        + '• preserve / stop / delete_stopped / stop_and_delete — a node\'s delegated session records (needs node_id). Use when a node is cluttered with finished or stuck worker sessions. Defaults should preserve reviewable history unless you choose a mode explicitly.\n'
        + '• prune_stale_direct — mesh-wide: orphaned staleDirect dispatch records (direct task dispatches whose original node/session is gone from the live mesh). Use when mesh_status keeps listing stale direct dispatches. '
        + 'Dry-run by default; execute=true deletes. Active/pending/assigned/generating work and fresh unacknowledged dispatch failures (node/session still live) are always preserved, and the append-only ledger history is kept.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            mode: {
                type: 'string',
                enum: [...MESH_SESSION_CLEANUP_MODES, 'prune_stale_direct'],
                description: 'preserve = no-op; stop = release process occupancy by stopping live runtimes; delete_stopped = remove completed/stopped records while leaving live runtimes alone; stop_and_delete = stop live runtimes and delete records; '
                    + 'prune_stale_direct = prune orphaned staleDirect dispatch records mesh-wide (dry-run unless execute=true).',
            },
            node_id: { type: 'string', description: 'Node ID whose delegated sessions should be considered for cleanup. Required for every mode except prune_stale_direct (which is mesh-wide and does not take it).' },
            session_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Session modes: optional explicit session IDs to limit cleanup to. When omitted, sessions are matched by node/workspace metadata.',
            },
            dry_run: { type: 'boolean', description: 'Preview without mutating. Session modes: report matched/stopped/deleted/skipped session IDs. prune_stale_direct: forces a preview even with execute=true; dry_run=false alone is NOT an execute trigger (rejected with dry_run_false_requires_execute).' },
            execute: { type: 'boolean', description: 'prune_stale_direct: when true, actually delete the orphaned records. Defaults false (dry run). Ignored when dry_run=true.' },
            include_terminal: { type: 'boolean', description: 'prune_stale_direct: also prune terminal (completed/failed) direct dispatch store rows in addition to orphans. Defaults false.' },
        },
        required: ['mode'],
    },
};

export const MESH_TASK_HISTORY_TOOL = {
    name: 'mesh_task_history',
    description: 'Read the task ledger for this mesh — dispatched tasks, completions, failures, checkpoints, node lifecycle events, and mission lifecycle (mission_created / mission_status_changed / mission_goal_updated). Use to understand what has been done before deciding next steps, to detect repeated failures, to audit mission goal/status changes, and to inform recovery decisions.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            tail: { type: 'number', description: 'Number of recent entries to return (default: 20; clamped to 40 in compact mode, 200 in verbose).' },
            kind: { type: 'string', description: 'Filter by entry kind: task_dispatched, task_completed, task_failed, task_stalled, session_launched, checkpoint_created, node_cloned, node_removed, direct_fast_forward, mission_created, mission_status_changed, mission_goal_updated.' },
            compact: { type: 'boolean', description: 'Slim payload for LLM callers. Default true. Truncates long payload strings (message/taskSummary ≤200, finalSummary ≤300) and elides any large nested evidence blob (>2KB serialized — e.g. validationSummary/result/patchEquivalence/submoduleReachability) to a {_elided,_kind,_bytes,_hint} placeholder; full evidence stays accessible via mesh_reconcile_ledger. Set false (or verbose=true) for full untruncated payloads.' },
            verbose: { type: 'boolean', description: 'Force the full untruncated payload; overrides compact.' },
        },
    },
};

export const MESH_LEDGER_QUERY_TOOL = {
    name: 'mesh_ledger_query',
    description: 'Read-only ledger query along the kind / time / node axes — the complement to mesh_task_history (which is task-axis-centric). Use this to answer "what happened on node X", "what failed since <time>", or "show every checkpoint_created" without scanning transcripts. Filters compose (AND): kind narrows to one or more entry kinds, since bounds the time window, node restricts to one node (identity-form-agnostic), tail caps the returned count to the most recent N. Returns the filtered ledger entries (oldest→newest) plus a small summary. Does not mutate anything.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            kind: { type: 'string', description: 'Filter by entry kind. Accepts one kind, or a comma-separated list (e.g. "task_failed,task_stalled"). Valid kinds include: task_dispatched, task_completed, task_failed, task_stalled, task_approval_needed, session_launched, session_stopped, checkpoint_created, node_cloned, node_joined, node_removed, direct_fast_forward, ledger_reconciled, event_held, mission_created, mission_status_changed, mission_goal_updated.' },
            since: { type: 'string', description: 'Only return entries at/after this time. ISO-8601 string (e.g. "2026-07-05T00:00:00Z") or epoch-milliseconds. Omit for no lower bound.' },
            node: { type: 'string', description: 'Only return entries originating from this node (nodeId). Matched by daemon-id equivalence, so any identifier form (mach_X / daemon_mach_X) resolves.' },
            tail: { type: 'number', description: 'Return only the most recent N matching entries (default 50; clamped to 500).' },
        },
    },
};

// 2026-09-26 tool consolidation: record / forget operating notes as one tool.
export const MESH_NOTE_TOOL = {
    name: 'mesh_note',
    description: 'Record or retract a durable operating note for this mesh — a runtime-accumulated lesson every future coordinator inherits. '
        + 'Provider-neutral: it persists in the mesh ledger and is injected into every coordinator\'s system prompt at launch (codex, antigravity, claude alike). Select with `action` (REQUIRED):\n'
        + '• record — when you learn something durable (a provider quirk, a pattern to avoid, a recovery lesson), and before closing a mission that taught one. Keep each note to one concrete, reusable fact; not for transient task status (use missions/checkpoints).\n'
        + '• forget — when an injected note is stale or wrong. Appends a tombstone so the note(s) stop riding into future prompts; history is preserved (append-only). Target by note_id (exact) or by exact text; provide at least one.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            action: {
                type: 'string',
                enum: ['record', 'forget'],
                description: 'record = add a note; forget = retract one. Required. Each action accepts only its own arguments — see the tool description.',
            },
            text: { type: 'string', description: 'record: the note — one concrete, reusable operating fact, phrased so a future coordinator can act on it without this conversation (required for record). forget: retract every note whose trimmed text exactly matches this string (use when you do not have the id).' },
            category: {
                type: 'string',
                enum: ['provider_quirk', 'pattern_to_avoid', 'recovery_lesson'],
                description: 'record: optional classification. Also governs default read-side retention: recovery_lesson ages out of the injected prompt after ~14 days, pattern_to_avoid after ~30, provider_quirk and uncategorized never age out. The ledger entry is always kept for audit.',
            },
            pinned: {
                type: 'boolean',
                description: 'record: pin so it ALWAYS rides into every coordinator prompt — never dropped by TTL expiry and kept ahead of unpinned notes when the injection cap is hit.',
            },
            ttl_days: {
                type: 'number',
                description: 'record: optional read-side lifespan in days, resolved to an absolute expiry at record time; after it an UNPINNED note is hidden from the prompt (kept in the ledger). Overrides the category default. Ignored when pinned.',
            },
            expiresAt: {
                type: 'string',
                description: 'record: optional explicit ISO-8601 expiry, an alternative to ttl_days (expires_at, snake_case, is also accepted though not published). Wins over ttl_days. Ignored when pinned.',
            },
            supersedes: {
                type: 'string',
                description: 'record: optional version-supersede — the note_id of an earlier note this one replaces, OR a subject_key shared with earlier notes. Matching earlier LIVE notes are hidden from the prompt (ledger kept). Pinned notes are never hidden by supersede.',
            },
            subject_key: {
                type: 'string',
                description: 'record: optional stable subject key grouping notes about the same subject. Drives supersede targeting and read-side folding (same category AND subject_key collapse to one injected entry, newest kept). When omitted, folding falls back to a leading [tag] bracket in the text.',
            },
            note_id: { type: 'string', description: 'forget: the ledger note id to retract (full/exact — no prefix matching). Returned by record as noteId, or visible in mesh_task_history. An id that matches no live note returns success:false, code:note_not_found — do not guess/truncate an id.' },
            reason: { type: 'string', description: 'forget: optional short reason, recorded on the tombstone for audit.' },
        },
        required: ['action'],
    },
};

export const MESH_RECONCILE_LEDGER_TOOL = {
    name: 'mesh_reconcile_ledger',
    description: 'Report reconciliation evidence across daemon-local mesh ledgers by querying bounded ledger slices over P2P/DataChannel — read-only, it does NOT import entries (see import_entries). Each daemon\'s records stay on that daemon; the fleet view is the replicated mesh.<id>.events topic, and a peer\'s nested payload is read from the peer. Cloud/D1 is not used as a ledger source of truth.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_ids: { type: 'array', items: { type: 'string' }, description: 'Optional node IDs to query. Defaults to all mesh nodes.' },
            limit: { type: 'number', description: 'Bounded slice size per node. Defaults to 100 and is clamped by daemon-core.' },
            after_id: { type: 'string', description: 'Optional cursor entry ID; remote slices return entries strictly after this ID when present.' },
            since: { type: 'string', description: 'Optional ISO timestamp lower bound for queried entries.' },
            import_entries: { type: 'boolean', description: 'RETIRED (C-W9a) — accepted for backward compatibility but a no-op regardless of value. This tool never imports entries into a local ledger; it only reads and reports evidence. The response always carries an importRetired/note explanation, whether or not this flag is passed.' },
        },
    },
};
