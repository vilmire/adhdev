/**
 * MCP tool schemas — mesh administration (mesh-tools-mission.ts / mesh-tools-merged.ts
 * handlers): missions, approvals and questions, mesh / node lifecycle, session and
 * worktree cleanup, task history, ledger query, notes and ledger reconcile.
 * Pure data; ALL_MESH_TOOLS in mesh-tool-schemas.ts is the registry.
 */
import { enumOf, MESH_SESSION_CLEANUP_MODES } from '@adhdev/mesh-shared';

export const MESH_MISSION_UPSERT_TOOL = {
    name: 'mesh_mission_upsert',
    description: 'Create or update a persistent mission so a plan survives coordinator restarts. Optional — tasks need no mission; recommended for multi-task work: create it first, then attach each task with mission_id (mesh_enqueue_task, or one top-level mission_id on mesh_enqueue_batch for every entry). Set completed/abandoned when the outcome is decided. Progress is derived from task statuses (no progress field). '
        + 'Single: title (+ mission_id to update). Bulk status change (e.g. stale cleanup): mission_ids + status — title/goal ignored, per-mission results returned; mission_ids wins over mission_id.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            mission_id: { type: 'string', description: 'Full/exact id to update (from mesh_mission_list); omit to create. Unknown/truncated ids are REJECTED (mission_not_found), never created.' },
            mission_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Bulk mode: apply `status` (required) to every listed id; returns per-mission { id, ok, status?, error? }. Overrides mission_id/title/goal.',
            },
            title: { type: 'string', description: 'Short title. Required for a single create/update; ignored in bulk.' },
            goal: { type: 'string', description: 'Free-text goal/definition of done (the short summary mesh_mission_list shows). Ignored in bulk.' },
            status: { type: 'string', enum: ['active', 'paused', 'completed', 'abandoned'], description: 'Defaults to active on create. Required in bulk.' },
            brief: {
                type: 'object',
                description: 'Structured packet rendered into every task dispatched under this mission (unlike `goal`, which is the list summary): {goal (required — no goal = dropped), constraints?, doneCriteria?, handoffNotes?, ownedPaths?} string arrays (snake_case aliases accepted). Ignored in bulk. A dropped brief returns `briefIgnored: {reason, field?}`.',
                properties: {
                    goal: { type: 'string', description: 'Required for the brief to be stored.' },
                    constraints: { type: 'array', items: { type: 'string' }, description: 'Hard constraints a worker must respect, e.g. "do not touch daemon-core".' },
                    doneCriteria: { type: 'array', items: { type: 'string' }, description: 'How to know the mission is done.' },
                    handoffNotes: { type: 'array', items: { type: 'string' }, description: 'Standing notes for whoever picks up mission work next.' },
                    ownedPaths: { type: 'array', items: { type: 'string' }, description: 'Shown to workers, not enforced (claims check per-task owned_paths).' },
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
    description: 'Answer a multi-choice QUESTION (AskUserQuestion — agent:waiting_choice / status "awaiting_choice"; labelled options, maybe multi-select or freeform "Type something"). Not a yes/no approval: never mesh_approve. '
        + 'Pass the event\'s promptId and `answers`, one entry per question in order — e.g. ["<exact label>"] or [<1-based index>]; the daemon keys the selection into the TUI. '
        + 'success:true = resolved and submit keys dispatched (submitted:true), not proof the TUI redrew — confirm the session left awaiting_choice later. An unmatched label, stale promptId or a provider that cannot answer returns success:false with live options in activePrompt; re-answer with one.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID (from the waiting_choice event).' },
            session_id: { type: 'string', description: 'Session awaiting the answer.' },
            promptId: { type: 'string', description: 'promptId from the agent:waiting_choice event; must match the active prompt.' },
            answers: {
                type: 'array',
                description: 'One entry per question, in order: a bare option label (string) or 1-based index (number), or { questionId?, select?, freeform? }.',
                items: {
                    oneOf: [
                        { type: 'string', description: 'Shorthand: the exact option label.' },
                        { type: 'number', description: 'Shorthand: the 1-based option index.' },
                        {
                            type: 'object',
                            properties: {
                                questionId: { type: 'string', description: 'Optional; entries match questions by position when omitted.' },
                                select: {
                                    description: 'Option label, 1-based index, or an array of them for a multi-select question.',
                                    oneOf: [
                                        { type: 'string' },
                                        { type: 'number' },
                                        { type: 'array', items: { type: ['string', 'number'] } },
                                    ],
                                },
                                freeform: { type: 'string', description: 'Freeform text (a "Type something" option); instead of select.' },
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
    description: 'Bootstrap a new mesh (one repo\'s nodes; = `adhdev mesh create <name>`) or dry-run the onboarding plan.\n'
        + '• mode="plan" — READ-ONLY Git-aware discovery of a workspace (git root, repo identity, branches, main checkout vs linked worktree, dirty/conflict state, existing mesh/node membership) → a typed create+onboarding / add-existing / clone-new-worktree plan with suggested .adhdev configs. Never fetches, writes config, or creates a mesh/node/branch/worktree. Run before creating a mesh, mesh_add_node or mesh_clone_node.\n'
        + '• mode="create" (default) — persistent write: plan first, then explicit user approval. Identity from workspace auto-detection or repo_remote_url / repo_identity; add_current:true also registers a node. Returns mesh_id (+ node_id).\n'
        + 'BOOT-GATE: works in STANDARD mode (adhdev mcp, no --repo-mesh) and in mesh mode (creates a SEPARATE mesh); `adhdev mcp --repo-mesh <id>` needs an existing mesh, so: standard-mode MCP → mesh_create → mesh_add_node → relaunch with `--repo-mesh <mesh_id>`.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            mode: {
                type: 'string',
                enum: ['create', 'plan'],
                description: 'create (default) or plan (read-only discovery). Each mode takes only its own arguments.',
            },
            name: { type: 'string', description: 'create (required): mesh name, e.g. "adhdev-main"; trimmed, max 100 chars.' },
            repo_remote_url: { type: 'string', description: 'create: optional explicit Git remote URL (else auto-detected from workspace).' },
            repo_identity: { type: 'string', description: 'create: optional normalized repo identity; wins over repo_remote_url.' },
            default_branch: { type: 'string', description: 'create: optional default branch (merge/convergence target), e.g. "main".' },
            add_current: { type: 'boolean', description: 'create: also register a node (CLI --add-current) at `workspace`, else the daemon cwd.' },
            workspace: { type: 'string', description: 'Absolute path on the daemon. plan (required): checkout to inspect. create: detection + add_current node (default: daemon cwd).' },
            mesh_id: { type: 'string', description: 'plan: optional existing mesh to validate against (mesh mode: the active mesh).' },
            operation: {
                type: 'string',
                enum: ['auto', 'add_existing', 'clone_worktree', 'create_mesh'],
                description: 'plan intent; auto = create+onboard if no compatible mesh, else add existing. clone_worktree needs branch + clean source.',
            },
            branch: { type: 'string', description: 'plan: new branch name for operation=clone_worktree.' },
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
            task_id: { type: 'string', description: 'The queue task this worktree is for, when it already exists. Shortly after an idle-mission reminder the daemon refuses a clone without task_id or reason.' },
            reason: { type: 'string', description: 'Why this clone is needed (e.g. "user asked for two parallel features"). Required instead of task_id shortly after an idle-mission reminder — clone BEFORE enqueueing so the task can be pinned with target_node_id.' },
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
    description: 'Read this mesh\'s ledger — dispatched tasks, completions, failures, checkpoints, node lifecycle, mission lifecycle (mission_created / mission_status_changed / mission_goal_updated). Use it before deciding next steps, to detect repeated failures, audit mission changes and inform recovery. Filters compose (AND): kind, since and node narrow the entries (e.g. "what happened on node X", "what failed since <time>"), tail keeps the most recent N. Returns entries oldest→newest, count, the resolved query, a summary and per-task taskStats. Read-only.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            tail: { type: 'number', description: 'Most recent N matching entries (default 20; clamped to 30 in compact mode — 20 when more than 50 is requested — and to 500 in verbose).' },
            kind: { type: 'string', description: 'One entry kind or a comma-separated list (e.g. "task_failed,task_stalled"). Kinds include: task_dispatched, task_completed, task_failed, task_stalled, task_approval_needed, session_launched, session_stopped, checkpoint_created, node_cloned, node_joined, node_removed, direct_fast_forward, ledger_reconciled, event_held, mission_created, mission_status_changed, mission_goal_updated.' },
            since: { type: 'string', description: 'Only entries at/after this time: ISO-8601 or epoch-milliseconds.' },
            node: { type: 'string', description: 'Only entries from this node (nodeId); any identifier form (mach_X / daemon_mach_X) resolves.' },
            compact: { type: 'boolean', description: 'Slim payload for LLM callers. Default true. Truncates long payload strings (message/taskSummary ≤200, finalSummary ≤300) and elides any large nested evidence blob (>2KB serialized — e.g. validationSummary/result/patchEquivalence/submoduleReachability) to a {_elided,_kind,_bytes,_hint} placeholder; full evidence stays accessible via mesh_reconcile_ledger. Set false (or verbose=true) for full untruncated payloads.' },
            verbose: { type: 'boolean', description: 'Force the full untruncated payload; overrides compact.' },
        },
    },
};

// 2026-10-08: the kind / since / node query axes moved onto mesh_task_history.
// Kept published for ONE release so older coordinator prompts and transcripts that
// call it still work; it forwards to mesh_task_history with verbose=true and its
// old tail defaults (50, max 500). Remove it in the next release (mesh-shared
// CANONICAL_MESH_TOOL_NAMES, ALL_MESH_TOOLS, dispatch, annotations, prompt index).
export const MESH_LEDGER_QUERY_TOOL = {
    name: 'mesh_ledger_query',
    description: 'Deprecated alias of mesh_task_history (same filters, full payloads, tail default 50); removed next release — call mesh_task_history.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            kind: { type: 'string' },
            since: { type: 'string' },
            node: { type: 'string' },
            tail: { type: 'number' },
        },
    },
};

// 2026-09-26 tool consolidation: record / forget operating notes as one tool.
export const MESH_NOTE_TOOL = {
    name: 'mesh_note',
    description: 'Record or retract a durable operating note: a lesson persisted in the mesh ledger and injected into every future coordinator\'s system prompt at launch, whatever its provider. `action` (REQUIRED):\n'
        + '• record — when you learn something durable (provider quirk, pattern to avoid, recovery lesson), and before closing a mission that taught one. One concrete, reusable fact per note; not for transient task status (use missions/checkpoints).\n'
        + '• forget — when an injected note is stale or wrong: appends a tombstone so it stops riding into prompts (append-only, history kept). Target by note_id or exact text.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            action: {
                type: 'string',
                enum: ['record', 'forget'],
                description: 'record = add a note; forget = retract one. Each action takes only its own arguments.',
            },
            text: { type: 'string', description: 'record (required): the fact, actionable without this conversation. forget: retract notes whose trimmed text matches exactly.' },
            category: {
                type: 'string',
                enum: ['provider_quirk', 'pattern_to_avoid', 'recovery_lesson'],
                description: 'record: sets prompt retention — recovery_lesson ~14 d, pattern_to_avoid ~30 d, provider_quirk/none never expire (ledger keeps all).',
            },
            pinned: {
                type: 'boolean',
                description: 'record: ALWAYS ride into every prompt — never TTL-expired, kept ahead of unpinned notes at the injection cap.',
            },
            ttl_days: {
                type: 'number',
                description: 'record: prompt lifespan (absolute expiry fixed at record time) after which an unpinned note is hidden; overrides the category default.',
            },
            expiresAt: {
                type: 'string',
                description: 'record: ISO-8601 expiry (or expires_at); wins over ttl_days. Both ignored when pinned.',
            },
            supersedes: {
                type: 'string',
                description: 'record: earlier note_id or shared subject_key to replace — those LIVE notes are hidden (not pinned ones; ledger kept).',
            },
            subject_key: {
                type: 'string',
                description: 'record: drives supersede and folding (same category + subject_key → newest one injected); default = leading [tag] in text.',
            },
            note_id: { type: 'string', description: 'forget: exact note id (record\'s noteId; also in mesh_task_history) — no prefix match; unknown → note_not_found.' },
            reason: { type: 'string', description: 'forget: optional reason, kept on the tombstone.' },
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
