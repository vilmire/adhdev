/**
 * MCP tool schema definitions for the mesh_* tool family.
 *
 * Pure data: per-tool input schemas plus the ALL_MESH_TOOLS registry. Physically
 * split out of mesh-tools.ts (which keeps the handler implementations) — see
 * RF-SURVEY candidate C1. No behavior change: mesh-tools.ts re-exports every symbol
 * below so existing `./tools/mesh-tools.js` import paths stay intact.
 */

export const MESH_STATUS_TOOL = {
    name: 'mesh_status',
    description: 'Get the current status of all nodes in the repo mesh — health, git state, active sessions, recovery hints, and recommended next steps. Use this to decide which node to send work to or how to recover from failures. Also reports the running daemon build per daemonId under top-level daemonBuilds ({commit, commitShort, version}); when a live daemon was built from a commit BEHIND its workspace HEAD it adds staleDaemonBuilds[] + staleDaemonBuildWarning — meaning a just-merged refinery/mesh-tool fix is NOT yet live on that daemon (awaiting deploy/restart; a local dist rebuild does not update a cloud daemon). Do not repeatedly call this to wait for generating delegated work; wait for pendingCoordinatorEvents/completion events or an explicit user status request.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            _gemini_compat: { type: 'string', description: 'Dummy property for Gemini compatibility. Ignore this.' },
            includeStaleDirectWorkDetails: { type: 'boolean', description: 'Opt in to the full staleDirectWork array. Defaults false; normal status returns compact staleDirectWorkSummary only.' },
            includeSessions: { type: 'boolean', description: 'Opt in to per-node live session arrays. Default false: compact mode returns a per-node sessionSummary (counts) and de-duplicated full session lists under top-level daemonSessions keyed by daemonId (sessions are not repeated for every node that shares a daemon). Set true to also include the full session array on each node.' },
            compact: { type: 'boolean', description: 'Slim payload for LLM callers. Default true. Folds per-node session arrays to sessionSummary and de-duplicates daemon-shared sessions into daemonSessions. Set false (or verbose=true) for the full dashboard-grade payload.' },
            verbose: { type: 'boolean', description: 'Force the full payload; overrides compact.' },
        },
    },
};

export const MESH_LIST_NODES_TOOL = {
    name: 'mesh_list_nodes',
    description: 'List all nodes in the mesh with their capabilities, platform, and workspace paths.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            _gemini_compat: { type: 'string', description: 'Dummy property for Gemini compatibility. Ignore this.' },
        },
    },
};

export const MESH_ENQUEUE_TASK_TOOL = {
    name: 'mesh_enqueue_task',
    description: 'Add a new task to the mesh work queue. Idle nodes will automatically pull and execute tasks from this queue. Use this instead of mesh_send_task when you do not need to target a specific node. '
        + 'Supports task-level priority (high tasks are pulled ahead of older normal/low tasks), not_before delayed execution (hold a task pending until a time), maxRetries (auto-fail after N requeues), and duplicate detection '
        + '(by default warns in the response when an in-flight task with the same message+target already exists; pass block_duplicate=true to refuse instead, or allow_duplicate=true to silence the warning).',
    inputSchema: {
        type: 'object' as const,
        properties: {
            message: { type: 'string', description: 'The task instruction for the agent.' },
            task_mode: { type: 'string', enum: ['code_change', 'validation', 'live_debug_readonly', 'launch_app', 'convergence'], description: 'Optional task-mode contract. live_debug_readonly rejects obvious write/commit/push/deploy/destructive instructions before dispatch.' },
            taskMode: { type: 'string', enum: ['code_change', 'validation', 'live_debug_readonly', 'launch_app', 'convergence'], description: 'CamelCase alias for task_mode.' },
            readonly: { type: 'boolean', description: 'Optional read-only axis (orthogonal to task_mode). When true the task runs without the one-active-per-node write isolation (N read-only tasks may run in parallel on one node), is counted under the read-only safety cap, and rejects write/commit/push/deploy/destructive instructions like live_debug_readonly. Equivalent to task_mode=live_debug_readonly but composable with any task_mode.' },
            read_only: { type: 'boolean', description: 'Snake-case alias for readonly.' },
            requiredTags: { type: 'array', items: { type: 'string' }, description: 'Optional capability tags that every eligible node must have, e.g. os=darwin, provider=codex-cli, gpu.' },
            required_tags: { type: 'array', items: { type: 'string' }, description: 'Snake_case alias for requiredTags.' },
            target_node_id: { type: 'string', description: 'Optional HARD constraint: ONLY this node may claim the task. No other node (especially a different machine) will ever claim it — if the target node has no idle session the task stays pending until it does. Use to route a queued task to a specific (e.g. freshly cloned) worktree node instead of letting the first idle base node claim it. Takes priority over prefer_worktree. An unresolvable target id is rejected at enqueue (no silent unpin).' },
            targetNodeId: { type: 'string', description: 'CamelCase alias for target_node_id.' },
            target_node: { type: 'string', description: 'Alias for target_node_id.' },
            targetNode: { type: 'string', description: 'CamelCase alias for target_node_id.' },
            prefer_worktree: { type: 'boolean', description: 'Optional: when true, route this task to the most recently cloned idle worktree node (avoids the main/base workspace preemptively claiming an isolated task). No-op if no worktree node exists; resolves to a target_node_id when one does.' },
            preferWorktree: { type: 'boolean', description: 'CamelCase alias for prefer_worktree.' },
            depends_on: { type: 'array', items: { type: 'string' }, description: 'Task ids that must complete before this task becomes claimable. Cycles are rejected at enqueue.' },
            dependsOn: { type: 'array', items: { type: 'string' }, description: 'CamelCase alias for depends_on.' },
            mission_id: { type: 'string', description: 'Mission this task belongs to (mesh_mission record id).' },
            missionId: { type: 'string', description: 'CamelCase alias for mission_id.' },
            priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'G6 (task-level scheduling priority). Within the claim tier a high task is pulled ahead of an older normal/low task (created_at is the tie-break); low is pulled last. Defaults to normal. This is the TASK priority (which task a node pulls first) — distinct from a node\'s schedulingPriority (which node work goes to). Use high to jump an urgent fix ahead of a backlog without cancelling the queue.' },
            model: { type: 'string', description: 'Optional model override for the agent that runs this task, e.g. opus, sonnet, haiku. Best-effort: applied at launch for providers that support a model flag (claude-cli --model, ACP setConfigOption); ignored by providers that cannot honor it. Use a cheaper model for simple tasks to save tokens, a stronger one for hard work. Blank = the provider default.' },
            thinkingLevel: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Optional reasoning-effort level for this task. Best-effort: applied at launch for providers that support it (claude-cli --effort, codex-cli reasoning effort, ACP thought_level); ignored otherwise. Use low for simple tasks (fewer tokens), high for hard reasoning.' },
            difficulty: { type: 'string', enum: ['easy', 'medium', 'difficult', 'freeform'], description: 'Optional task execution difficulty. When set, the mesh per-difficulty brain preset fills in the model + thinkingLevel you did not pass explicitly (easy → cheap model / low effort to save tokens; difficult → strong model / high effort). Classify each task you enqueue so simple work runs cheaply. An explicit model/thinkingLevel above always wins over the preset.' },
            notBefore: { type: 'number', description: 'CamelCase alias for not_before. Also accepts an ISO-8601 timestamp string.' },
            max_retries: { type: 'number', description: 'P3 (retry cap). Max automatic requeue attempts before the task auto-fails instead of returning to pending. When requeueCount reaches this, mesh_queue_requeue auto-fails the task unless force=true. Omit to use the mesh policy default (maxTaskRetries, typically 1).' },
            maxRetries: { type: 'number', description: 'CamelCase alias for max_retries.' },
            block_duplicate: { type: 'boolean', description: 'G4 (duplicate detection, block mode). Default false = warn-only: if an in-flight (pending/assigned) task with the same message (+ target node when pinned) already exists, the task is still enqueued but the response carries duplicateSuspect. Set true to REFUSE the enqueue with code duplicate_suspect instead (structural TASKBUBBLE-DUP defense — use when re-sending a task that a slow prior turn may have already enqueued).' },
            blockDuplicate: { type: 'boolean', description: 'CamelCase alias for block_duplicate.' },
            allow_duplicate: { type: 'boolean', description: 'G4. Set true to skip duplicate detection entirely (no warning, no block) for an intentional re-enqueue of the same instruction.' },
            allowDuplicate: { type: 'boolean', description: 'CamelCase alias for allow_duplicate.' },
        },
        required: ['message'],
    },
};

export const MESH_VIEW_QUEUE_TOOL = {
    name: 'mesh_view_queue',
    description: 'View the mesh work queue with source-of-truth active counts separated from historical completed/failed/cancelled records. Do not repeatedly call this to wait for generating assigned work; wait for pendingCoordinatorEvents/completion events or an explicit user status request.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            status: {
                type: 'array',
                items: { type: 'string' },
                description: 'Explicit row filter by task status: pending, assigned, completed, failed, cancelled. Source-of-truth counts remain unfiltered; visible* counts describe returned rows.',
            },
            view: {
                type: 'string',
                enum: ['all', 'active', 'historical'],
                description: 'Optional row view. active returns pending/assigned rows, historical returns completed/failed/cancelled rows, all returns every persisted queue row. Defaults to all for compatibility.',
            },
            compact: { type: 'boolean', description: 'Slim payload for LLM callers. Default true. Drops large historical (completed/failed/cancelled) queue row arrays, the full staleDirectWork orphan array (kept as staleDirectWorkSummary counts), and per-row maintenance cleanupCandidates in favor of counts; pending/assigned active rows are retained. Set false (or verbose=true) for the full dashboard-grade payload.' },
            verbose: { type: 'boolean', description: 'Force the full payload; overrides compact.' },
        },
    },
};

export const MESH_QUEUE_CANCEL_TOOL = {
    name: 'mesh_queue_cancel',
    description: 'Cancel a pending/assigned/completed/failed mesh queue task without deleting audit history. Use this to retire stale queue items that target dead sessions.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            task_id: { type: 'string', description: 'Queue task ID to cancel.' },
            reason: { type: 'string', description: 'Optional operator-visible reason for cancellation.' },
        },
        required: ['task_id'],
    },
};

export const MESH_QUEUE_REQUEUE_TOOL = {
    name: 'mesh_queue_requeue',
    description: 'Return a mesh queue task to pending for retry. By default clears stale assigned owner and target session so another live session can claim it. When the task has exceeded its retry cap it is auto-failed instead; use force=true to override.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            task_id: { type: 'string', description: 'Queue task ID to requeue.' },
            reason: { type: 'string', description: 'Optional operator-visible reason for requeueing.' },
            target_node_id: { type: 'string', description: 'Optional replacement target node ID.' },
            target_session_id: { type: 'string', description: 'Optional replacement target runtime session ID.' },
            clear_target_node: { type: 'boolean', description: 'When true, remove any existing target node constraint.' },
            keep_target_session: { type: 'boolean', description: 'When true, preserve an existing target session if target_session_id is not provided. Defaults false to avoid stale session targets.' },
            force: { type: 'boolean', description: 'When true, bypass the retry cap and requeue even if maxRetries has been exceeded. Use only for explicit operator recovery.' },
        },
        required: ['task_id'],
    },
};

export const MESH_SEND_TASK_TOOL = {
    name: 'mesh_send_task',
    description: 'Legacy push-based task assignment. Enqueues a task specifically targeted at a given node. The node will pull it immediately if idle.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID (from mesh_list_nodes).' },
            session_id: { type: 'string', description: 'Agent session ID on the target node.' },
            message: { type: 'string', description: 'Natural-language task to send to the agent.' },
            task_mode: { type: 'string', enum: ['code_change', 'validation', 'live_debug_readonly', 'launch_app', 'convergence'], description: 'Optional task-mode contract. live_debug_readonly rejects obvious write/commit/push/deploy/destructive instructions before local or remote direct dispatch.' },
            taskMode: { type: 'string', enum: ['code_change', 'validation', 'live_debug_readonly', 'launch_app', 'convergence'], description: 'CamelCase alias for task_mode.' },
            readonly: { type: 'boolean', description: 'Optional read-only axis (orthogonal to task_mode). When true the task runs without write isolation, is counted under the read-only cap, and rejects write/commit/push/deploy/destructive instructions like live_debug_readonly. Composable with any task_mode.' },
            read_only: { type: 'boolean', description: 'Snake-case alias for readonly.' },
            mission_id: { type: 'string', description: 'Mission this task belongs to (mesh_mission record id). When set, the directly dispatched task is attributed to the mission task aggregates exactly like mesh_enqueue_task, including terminal completion. Omit for an unattributed direct dispatch.' },
            missionId: { type: 'string', description: 'CamelCase alias for mission_id.' },
        },
        required: ['node_id', 'session_id', 'message'],
    },
};

export const MESH_READ_CHAT_TOOL = {
    name: 'mesh_read_chat',
    description: 'Read recent chat messages from a delegated agent session on a mesh node. Use compact=true for coordinator context-efficient review: it filters tool/internal/debug chatter and returns the final user-visible summary plus recent key messages. If the runtime session has completed, provider_session_id can explicitly target provider transcript history.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            session_id: { type: 'string', description: 'Agent session ID to read from.' },
            provider_session_id: { type: 'string', description: 'Optional provider transcript/session ID for completed sessions.' },
            tail: { type: 'number', description: 'Number of recent messages to return (default: 10).' },
            compact: { type: 'boolean', description: 'When true, return a compact coordinator summary instead of the full transcript: tool/internal/control/debug messages are excluded and only recent user-visible key messages plus the final assistant summary are included.' },
        },
        required: ['node_id', 'session_id'],
    },
};

export const MESH_READ_DEBUG_TOOL = {
    name: 'mesh_read_debug',
    description: 'Collect a daemon-side chat/parser debug bundle for a delegated agent session on a mesh node without opening the browser UI. Defaults to daemon_file delivery and returns a saved bundle locator.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            session_id: { type: 'string', description: 'Agent session ID to debug.' },
            provider_session_id: { type: 'string', description: 'Optional provider transcript/session ID for completed session history.' },
            tail: { type: 'number', description: 'Number of recent read_chat messages to embed (default: 40).' },
            delivery: { type: 'string', enum: ['daemon_file', 'inline'], description: 'daemon_file saves the full sanitized bundle on the daemon; inline returns it directly. Default: daemon_file.' },
        },
        required: ['node_id', 'session_id'],
    },
};

export const MESH_LAUNCH_SESSION_TOOL = {
    name: 'mesh_launch_session',
    description: 'Launch a new agent session on a mesh node. Returns the session ID for subsequent send_task/read_chat calls. If the user names a provider, preserve it exactly: Hermes = hermes-cli, Claude Code/Claude = claude-cli, Codex = codex-cli, Gemini = gemini-cli. If type is omitted, resolve strictly from the node policy providerPriority and provider detection; fail closed when no configured provider is usable. Do not default to claude-cli.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            type: { type: 'string', description: 'Optional provider type to launch. Use hermes-cli for Hermes, claude-cli for Claude Code, codex-cli for Codex, gemini-cli for Gemini. When omitted, node.policy.providerPriority is probed in order.' },
            force: { type: 'boolean', description: 'Set true to launch an ADDITIONAL session even when this node already has a live mesh-owned worker session. Default false: if a live worker session for this mesh+node already exists (e.g. an enqueue auto-launch just spawned one), the existing session is returned idempotently instead of creating an empty duplicate. Only pass force when you intentionally want a second concurrent provider/session on the node.' },
        },
        required: ['node_id'],
    },
};

export const MESH_GIT_STATUS_TOOL = {
    name: 'mesh_git_status',
    description: 'Get git status for a mesh node workspace — branch, dirty state, changed files.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
        },
        required: ['node_id'],
    },
};

export const MESH_READ_NODE_LOGS_TOOL = {
    name: 'mesh_read_node_logs',
    description: 'Fetch a recent daemon LOG tail directly from a (possibly remote) mesh node over P2P — no session launch, no PowerShell/shell grep on the remote machine. '
        + 'Use this to debug a node\'s daemon: read its error/warn lines, grep for a pattern, or read since a timestamp. '
        + 'The reply is byte-bounded (≤128KB, default 64KB; truncated:true when the file was larger, newest lines kept) and secrets (API keys, machine secrets, bearer tokens, JWTs, TURN credentials) are redacted before transmission. '
        + 'This reads the DAEMON log, not an agent session transcript — for a session transcript use mesh_read_chat / mesh_read_debug.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID (the daemon owning it serves its own log).' },
            grep: { type: 'string', description: 'Optional regex (case-insensitive) — only matching log lines are returned. Invalid regex falls back to a literal substring match.' },
            since_ms: { type: 'number', description: 'Optional epoch-ms floor — only log lines at/after this time are returned (lines without a parseable timestamp are kept).' },
            tail_bytes: { type: 'number', description: 'Max bytes of log tail to read (default 65536, capped at 131072). Larger files are truncated to the newest tail_bytes.' },
            date: { type: 'string', description: 'Optional YYYY-MM-DD log date (defaults to today). Falls back to the size-rotation backup when the active file is absent.' },
        },
        required: ['node_id'],
    },
};

export const MESH_FAST_FORWARD_NODE_TOOL = {
    name: 'mesh_fast_forward_node',
    description: 'Safely dry-run or execute an obvious direct fast-forward for a mesh node without launching an agent session. '
        + 'mode="merge" (default) absorbs upstream commits into the local branch via git merge --ff-only (ahead=0, behind>0). '
        + 'mode="push" publishes local commits to origin via a strict ff-only push (HEAD must be a descendant of origin/<branch>). '
        + 'Defaults to dry-run; execution requires execute=true. Never force-pushes, rebases, resets, cleans, or checks out arbitrary revisions. '
        + 'When the merge path finds the branch ahead with nothing to merge, it returns code "ahead_needs_push" pointing at mode="push".',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            mode: { type: 'string', enum: ['merge', 'push'], description: 'merge (default): git merge --ff-only to absorb upstream. push: strict ff-only push of local commits to origin/<branch>; refuses any non-fast-forward.' },
            branch: { type: 'string', description: 'Optional guard: require the node\'s current branch to match this branch before planning/executing.' },
            execute: { type: 'boolean', description: 'When true, apply the fast-forward/push if all safety gates pass. Defaults false/dry-run.' },
            dry_run: { type: 'boolean', description: 'Preview only. Defaults true unless execute=true; dry_run=true overrides execute.' },
            update_submodules: { type: 'boolean', description: 'mode="merge" only: when true, if the root fast-forward changes gitlinks, run only git submodule update --init --recursive and verify submodules clean.' },
            push_submodules: { type: 'boolean', description: 'mode="push" only: also ff-only push submodule HEADs to their origin main. Gated by mesh policy allowAutoPublishSubmoduleMainCommits — skipped unless that policy is enabled. Defaults false (root push only).' },
        },
        required: ['node_id'],
    },
};

export const MESH_RESTART_DAEMON_TOOL = {
    name: 'mesh_restart_daemon',
    description: 'Update a mesh node\'s daemon to the latest published version on its release channel and restart it — the same path as the dashboard "preview update" button, exposed as a mesh command so a coordinator can roll a worker daemon onto a freshly deployed version without a manual restart round-trip. No agent session is launched. '
        + 'Idle-gated: a node whose daemon has an active session (generating / waiting_approval / starting) is refused with code "blocking_sessions" so an in-flight turn is never interrupted. '
        + 'If the node is already on the latest version it is a no-op (no restart), matching the dashboard button (returns alreadyLatest:true). '
        + 'Targets a single node — call other (idle) nodes first; restarting the coordinator\'s OWN daemon is naturally refused while its calling turn is active. '
        + 'Passing channel switches the daemon\'s release channel (and server URL) before restarting; omit it to keep the daemon on its configured channel.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID — the daemon that owns this node is updated and restarted.' },
            channel: { type: 'string', enum: ['stable', 'preview'], description: 'Optional release channel to update from. Defaults to the daemon\'s configured updateChannel. Setting it also repoints the daemon\'s server URL to that channel.' },
        },
        required: ['node_id'],
    },
};

export const MESH_CHECKPOINT_TOOL = {
    name: 'mesh_checkpoint',
    description: 'Create a git checkpoint (commit) on a mesh node workspace.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            message: { type: 'string', description: 'Checkpoint commit message.' },
        },
        required: ['node_id', 'message'],
    },
};

export const MESH_MISSION_UPSERT_TOOL = {
    name: 'mesh_mission_upsert',
    description: 'Create or update a persistent mission record so the plan survives coordinator restarts. '
        + 'Create a mission before enqueueing a multi-task batch, attach tasks via mesh_enqueue_task mission_id, and update status to completed/abandoned when the outcome is decided. Progress is derived from task statuses — there is no separate progress field. '
        + 'Single mission: pass title (and optionally mission_id to update an existing one). '
        + 'Bulk status transition (e.g. one-time stale cleanup): pass mission_ids (array) + status to apply that status to many missions at once; title/goal are ignored and a per-mission result array is returned. mission_ids takes precedence over mission_id when both are given.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            mission_id: { type: 'string', description: 'Mission id to update. Omit to create a new mission. Ignored when mission_ids is provided.' },
            mission_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Bulk mode: apply `status` to every listed mission id in one call (stale cleanup). Requires `status`. Returns a per-mission { id, ok, status?, error? } result array. Overrides mission_id/title/goal.',
            },
            title: { type: 'string', description: 'Short mission title. Required to create/update a single mission; ignored in bulk (mission_ids) mode.' },
            goal: { type: 'string', description: 'Free-text mission goal/definition of done. Ignored in bulk (mission_ids) mode.' },
            status: { type: 'string', enum: ['active', 'paused', 'completed', 'abandoned'], description: 'Mission lifecycle status. Defaults to active on create. Required in bulk (mission_ids) mode.' },
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
        + 'Completed MAGI cross-verification missions (one auto-created per mesh_magi_review) are hidden by default to keep the list '
        + 'coordinator-focused — in-progress MAGI missions still show; pass include_magi=true to list completed ones too. '
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
            include_magi: { type: 'boolean', description: 'Include completed MAGI cross-verification missions (hidden by default). Defaults to false.' },
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

export const MESH_CLONE_NODE_TOOL = {
    name: 'mesh_clone_node',
    description: 'Create a new worktree-based node from an existing node for isolated parallel work. '
        + 'Creates a git worktree on a new branch so multiple tasks can run on separate branches simultaneously.',
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
                type: 'string',
                enum: ['preserve', 'stop', 'delete_stopped', 'stop_and_delete'],
                description: 'Optional override for cleanup of delegated sessions attached to this node. preserve keeps history/processes; stop stops live runtimes only; delete_stopped removes completed transcripts only; stop_and_delete stops live runtimes and deletes records.',
            },
            force: { type: 'boolean', description: 'Override the coordinator-base-node guard. Only set true to intentionally tear down this mesh; the coordinator must then be re-registered/restarted. Worktree nodes never need force.' },
        },
        required: ['node_id'],
    },
};

export const MESH_CLEANUP_SESSIONS_TOOL = {
    name: 'mesh_cleanup_sessions',
    description: 'Manually clean up delegated session records for a mesh node without removing the node. Defaults should preserve reviewable history unless the caller chooses a mode explicitly.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Node ID whose delegated sessions should be considered for cleanup.' },
            mode: {
                type: 'string',
                enum: ['preserve', 'stop', 'delete_stopped', 'stop_and_delete'],
                description: 'preserve = no-op; stop = release process occupancy by stopping live runtimes; delete_stopped = remove completed/stopped records while leaving live runtimes alone; stop_and_delete = stop live runtimes and delete records.',
            },
            session_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional explicit session IDs to limit cleanup to. When omitted, sessions are matched by node/workspace metadata.',
            },
            dry_run: { type: 'boolean', description: 'Preview matched/stopped/deleted/skipped session IDs without mutating session-host state.' },
        },
        required: ['node_id', 'mode'],
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
            kind: { type: 'string', description: 'Filter by entry kind. Accepts one kind, or a comma-separated list (e.g. "task_failed,task_stalled"). Valid kinds include: task_dispatched, task_completed, task_failed, task_stalled, task_approval_needed, session_launched, session_stopped, checkpoint_created, node_cloned, node_joined, node_removed, direct_fast_forward, ledger_reconciled, event_held, mission_created, mission_status_changed, mission_goal_updated, magi_dispatched, magi_synthesis.' },
            since: { type: 'string', description: 'Only return entries at/after this time. ISO-8601 string (e.g. "2026-07-05T00:00:00Z") or epoch-milliseconds. Omit for no lower bound.' },
            node: { type: 'string', description: 'Only return entries originating from this node (nodeId). Matched by daemon-id equivalence, so any identifier form (mach_X / daemon_mach_X) resolves.' },
            tail: { type: 'number', description: 'Return only the most recent N matching entries (default 50; clamped to 500).' },
        },
    },
};

export const MESH_RECORD_NOTE_TOOL = {
    name: 'mesh_record_note',
    description: 'Record a durable operating note for this mesh — a runtime-accumulated lesson that future coordinators inherit. '
        + 'Unlike Claude-only memory/CLAUDE.md, this is provider-neutral: it persists in the mesh ledger and is injected into every coordinator\'s system prompt at launch (codex, hermes, antigravity, claude alike). '
        + 'Use it when you learn something durable: a provider quirk, a pattern to avoid, or a recovery lesson. Keep each note to one concrete, reusable fact. Not for transient task status — use missions/checkpoints for that.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            text: { type: 'string', description: 'The note — one concrete, reusable operating fact/lesson. Phrase it so a future coordinator can act on it without this conversation\'s context.' },
            category: {
                type: 'string',
                enum: ['provider_quirk', 'pattern_to_avoid', 'recovery_lesson'],
                description: 'Optional classification: provider_quirk (a provider/runtime behaves unexpectedly), pattern_to_avoid (an approach that caused problems), recovery_lesson (how a failure was recovered).',
            },
        },
        required: ['text'],
    },
};

export const MESH_FORGET_NOTE_TOOL = {
    name: 'mesh_forget_note',
    description: 'Retract a stale or wrong operating note recorded via mesh_record_note. '
        + 'Appends a tombstone to the mesh ledger so the targeted note(s) stop riding into future coordinators\' system prompts and drop out of the operating-notes list. '
        + 'History is preserved (append-only) — this suppresses, it does not rewrite. '
        + 'Target by note_id (from mesh_record_note / mesh_task_history) for an exact match, or by text to retract every note with that exact wording. Provide at least one.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            note_id: { type: 'string', description: 'The ledger note id to retract (exact). Returned by mesh_record_note as noteId, or visible in mesh_task_history entries.' },
            text: { type: 'string', description: 'Retract every operating note whose trimmed text exactly matches this string. Use when you do not have the note id.' },
            reason: { type: 'string', description: 'Optional short reason for the retraction, recorded on the tombstone for audit.' },
        },
    },
};

export const MESH_RECONCILE_LEDGER_TOOL = {
    name: 'mesh_reconcile_ledger',
    description: 'Reconcile daemon-local mesh ledgers by querying bounded ledger slices over P2P/DataChannel and importing missing entries into the coordinator local JSONL ledger. Cloud/D1 is not used as a ledger source of truth.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_ids: { type: 'array', items: { type: 'string' }, description: 'Optional node IDs to query. Defaults to all mesh nodes.' },
            limit: { type: 'number', description: 'Bounded slice size per node. Defaults to 100 and is clamped by daemon-core.' },
            after_id: { type: 'string', description: 'Optional cursor entry ID; remote slices return entries strictly after this ID when present.' },
            since: { type: 'string', description: 'Optional ISO timestamp lower bound for queried entries.' },
            import_entries: { type: 'boolean', description: 'When false, query and report evidence without importing remote entries. Defaults true.' },
        },
    },
};

export const MESH_REQUEUE_HELD_EVENTS_TOOL = {
    name: 'mesh_requeue_held_events',
    description: 'Restore recoverable held coordinator events back to the pending queue. T6 quarantine (v2 enforce) and the pending-events trim mirror a destructively-drained-but-undelivered event into the ledger as a recoverable `event_held` entry — this is the operator path that actually requeues them (event_held→pending), so a coordinator drains them on its next poll. Lossless: the full original event is restored, the pending-queue dedup suppresses any still-live duplicate, and each held entry is marked once so a second call does not requeue it again. Read-only by default? No — it mutates the pending queue; scope it with `filter` when you only want a subset.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            filter: {
                type: 'object',
                description: 'Optional narrowing filter within this mesh. Omit to requeue every not-yet-recovered held event.',
                properties: {
                    task_id: { type: 'string', description: 'Only requeue held events for this worker task id.' },
                    node_id: { type: 'string', description: 'Only requeue held events originating from this node.' },
                    event: { type: 'string', description: 'Only requeue held events of this event name (e.g. session:completed).' },
                    reason: { type: 'string', description: 'Only requeue held entries with this hold reason (e.g. pending_trim_dropped, v2_enforce_validation_failed_quarantined).' },
                    since: { type: 'string', description: 'Only requeue held entries recorded at/after this ISO timestamp.' },
                },
            },
        },
    },
};

export const MESH_PRUNE_STALE_DIRECT_TOOL = {
    name: 'mesh_prune_stale_direct',
    description: 'Prune orphaned staleDirect dispatch records — direct task dispatches whose original node/session is no longer present in the live mesh. dry_run (default) reports exactly which records would be pruned without mutating anything; pass execute=true to delete them. Active/pending/assigned/generating work and fresh unacknowledged dispatch failures (node/session still live) are always preserved. The append-only mesh ledger audit history is left intact.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            execute: { type: 'boolean', description: 'When true, actually delete the orphaned records. Defaults false (dry run). Ignored when dry_run=true.' },
            dry_run: { type: 'boolean', description: 'Force a preview without mutation even if execute=true. Defaults to dry-run behavior when execute is not set.' },
            include_terminal: { type: 'boolean', description: 'Also prune terminal (completed/failed) direct dispatch store rows in addition to orphans. Defaults false.' },
        },
    },
};

export const MESH_REFINE_NODE_TOOL = {
    name: 'mesh_refine_node',
    description: 'The Refinery: validate → merge → push → clean up a completed worktree node onto the base branch. '
        + 'Defaults to dry-run (plan only): returns the validation plan with mergeWillRun:false/cleanupWillRun:false and performs NO merge/push/cleanup. '
        + 'Pass execute=true to actually converge the node. execute=true is async: the immediate response includes async:true, status:\'accepted\', jobId, interactionId, target node, and startedAt; completion/failure evidence is delivered through pending mesh events and the mesh task ledger. '
        + 'dry_run=true overrides execute. Matches the mesh_refine_batch / mesh_fast_forward_node dry_run/execute contract.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Node ID of the completed worktree node to refine and merge.' },
            execute: { type: 'boolean', description: 'When true, run validation/merge/push/cleanup for this node. Defaults false/dry-run.' },
            dry_run: { type: 'boolean', description: 'Preview the validation plan without merging. Defaults true unless execute=true; dry_run=true overrides execute.' },
        },
        required: ['node_id'],
    },
};

export const MESH_REFINE_BATCH_TOOL = {
    name: 'mesh_refine_batch',
    description: 'Batch Refinery: converge multiple sibling worktree nodes onto the base branch in one conflict-aware sequential pipeline. '
        + 'Orders nodes by change-area (non-submodule nodes first, submodule-touching nodes serialized last) so each merged sibling advances the base and the next node auto-rebases + re-checks patch-equivalence before its own merge. '
        + 'Each node runs the same validation/patch-equivalence/submodule-reachability/merge/cleanup gates as mesh_refine_node. '
        + 'Conflicting or blocked nodes are isolated as blocked_review while the rest of the batch proceeds. Defaults to dry-run (plan only); set execute=true to converge. Never force-pushes or resets. '
        + 'execute=true is async: the immediate response is async:true / status:\'accepted\' with the batch jobId and ordered target node list; per-node convergence runs in the background and the aggregate completion/failure (with per-node merged / blocked_review / not_mergeable results) is delivered as a terminal refine event via pending mesh events and the ledger — do not re-invoke while a batch is in flight. dry_run returns the plan synchronously.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional explicit node IDs to converge, in any order (the tool computes the safe merge order). When omitted, all local worktree nodes that need convergence are auto-collected.',
            },
            execute: { type: 'boolean', description: 'When true, run validation/rebase/merge for each node in order. Defaults false/dry-run.' },
            dry_run: { type: 'boolean', description: 'Preview the ordering + per-node validation plan without executing. Defaults true unless execute=true; dry_run=true overrides execute.' },
        },
        required: [],
    },
};

// Unified read-only Refinery config helper. Consolidates the former
// mesh_refine_config_schema / mesh_validate_refine_config / mesh_suggest_refine_config
// tools into a single `mode`-dispatched tool (MESH-COMPLEXITY-AUDIT Part 8-4). The old
// three names remain dispatchable as 1-release hidden aliases (see server.ts), but only
// this unified tool is published in ALL_MESH_TOOLS. These are read-only helpers — they
// never run validation commands or git merges (that is mesh_refine_node / mesh_refine_plan).
export const MESH_REFINE_CONFIG_TOOL = {
    name: 'mesh_refine_config',
    description: 'Repo Mesh Refinery config helper — unified read-only entry for the three refine-config operations. Select the operation with `mode` (REQUIRED). '
        + 'mode=\'schema\': return the Refinery config JSON schema and supported repo-local config locations (the validation source of truth; heuristic command detection is suggestions-only) — takes no other parameters. '
        + 'mode=\'validate\': validate the repo mesh/refine config for a node/workspace without running validation commands or merging — accepts optional `node_id` (defaults to the first mesh node) and an optional inline `config` object (validated instead of loading from the repo). '
        + 'mode=\'suggest\': suggest a refine config scaffold from project context/package scripts (never executed until saved) — accepts optional `node_id`. '
        + 'Does NOT run validation commands or git merges — use mesh_refine_node / mesh_refine_plan for execution.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            mode: {
                type: 'string',
                enum: ['schema', 'validate', 'suggest'],
                description: 'Which config operation to run (required). schema: return the config JSON schema (no other params). validate: validate a node/workspace refine config (optional node_id, optional inline config). suggest: scaffold a config from project context (optional node_id).',
            },
            node_id: { type: 'string', description: 'Optional node/workspace. Used by mode=validate (config to load) and mode=suggest (context source); defaults to the first mesh node. Ignored by mode=schema.' },
            config: { type: 'object', description: 'Optional inline config object to validate instead of loading from the repo. Only used by mode=validate.' },
        },
        required: ['mode'],
    },
};

// Unified read-only Change Impact config helper. Consolidates the former
// mesh_change_impact_config_schema / mesh_validate_change_impact_config /
// mesh_suggest_change_impact_config tools into a single `mode`-dispatched tool
// (MESH-COMPLEXITY-AUDIT, symmetric to the Part 8-4 refine-config consolidation). The old
// three names remain dispatchable as 1-release hidden aliases (see server.ts), but only this
// unified tool is published in ALL_MESH_TOOLS. These are read-only helpers — Change Impact
// config is declarative and parsed, never executed.
export const MESH_CHANGE_IMPACT_CONFIG_TOOL = {
    name: 'mesh_change_impact_config',
    description: 'Repo Mesh Change Impact config helper — unified read-only entry for the three change-impact config operations. '
        + 'Change Impact config declaratively classifies which package/file changes between the live daemon build and workspace HEAD require a daemon rebuild/restart vs. a web-only redeploy vs. nothing (parsed, never executed). Select the operation with `mode` (REQUIRED). '
        + 'mode=\'schema\': return the Change Impact config JSON schema and supported repo-local config locations — takes no other parameters. '
        + 'mode=\'validate\': validate a Change Impact config for a node/workspace and report valid/errors — loads .adhdev/change-impact.{json,yaml,yml} (or repo-mesh-change-impact.* alias) unless an inline `config` object is provided; accepts optional `node_id` (defaults to the first mesh node). '
        + 'mode=\'suggest\': suggest a Change Impact config scaffold from the repo package layout (web-* → web-only, others → daemon-runtime, plus docs/license markers as non-runtime) — the draft must be reviewed and saved before it takes effect; accepts optional `node_id`. '
        + 'Declarative only — nothing is executed.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            mode: {
                type: 'string',
                enum: ['schema', 'validate', 'suggest'],
                description: 'Which config operation to run (required). schema: return the config JSON schema (no other params). validate: validate a node/workspace change-impact config (optional node_id, optional inline config). suggest: scaffold a config from the repo package layout (optional node_id).',
            },
            node_id: { type: 'string', description: 'Optional node/workspace. Used by mode=validate (config to load) and mode=suggest (context source); defaults to the first mesh node. Ignored by mode=schema.' },
            config: { type: 'object', description: 'Optional inline config object to validate instead of loading from the repo. Only used by mode=validate.' },
        },
        required: ['mode'],
    },
};

export const MESH_INIT_TOOL = {
    name: 'mesh_init',
    description: 'One-click mesh onboarding for an existing git project. Detects installed CLI providers, suggests all three repo `.adhdev/*` config families — Refinery (.adhdev/refine.json), worktree bootstrap (.adhdev/worktree_bootstrap.json) AND change-impact (.adhdev/change-impact.json) — optionally writes them to disk, and recommends a node providerPriority from the detected providers. Also returns `currentConfig`: the currently-saved config per domain (repo files + machine-local magiKindPanels) so you can present a current-vs-suggested diff before overwriting. Suggestions are scaffold only and never execute until saved; providerPriority is a recommendation to apply to node policy, not auto-applied. Defaults to dry-run (no files written) and never overwrites an existing config unless overwrite=true. For an already-onboarded repo that needs refreshing, use mesh_reinit (overwrite semantics + enforced diff).',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Optional node/workspace to onboard. Defaults to the first mesh node with a workspace.' },
            write: { type: 'boolean', description: 'When true, persist the suggested configs to disk. Defaults false (dry-run preview only).' },
            overwrite: { type: 'boolean', description: 'When true, overwrite an existing config file. Defaults false (never clobber an existing refine/bootstrap config).' },
        },
    },
};

export const MESH_REINIT_TOOL = {
    name: 'mesh_reinit',
    description: 'Re-onboard an ALREADY-initialized repo: re-suggest the repo `.adhdev/*` configs (refine / worktree_bootstrap / change-impact) with OVERWRITE semantics and return a current-vs-suggested diff so you can replace stale config. This is NOT a new write engine — it reuses mesh_init\'s suggest→validate→gated-write with overwrite=true (default) plus the current-config echo (`currentConfig`). CONTRACT: overwrite is a WHOLESALE replacement, so it must NOT silently drop operator hand-edits — the first call (write=false, the default) is a DRY-RUN preview that surfaces the per-section diff; you MUST present that current-vs-suggested diff and get EXPLICIT per-section user approval, then re-invoke with write=true. Use mesh_init (not reinit) for a fresh, never-onboarded repo.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Optional node/workspace to re-onboard. Defaults to the first mesh node with a workspace.' },
            write: { type: 'boolean', description: 'When true, persist the overwritten configs. Defaults false (dry-run preview surfacing the current-vs-suggested diff — approve per-section first).' },
            overwrite: { type: 'boolean', description: 'Defaults true (reinit replaces existing config). Pass false to fall back to existing-wins (equivalent to mesh_init).' },
        },
    },
};

export const MESH_REFINE_PLAN_TOOL = {
    name: 'mesh_refine_plan',
    description: 'Dry-run Refinery plan for a worktree node: reports config source, validation commands, suggestions/unavailable reason, and merge/cleanup intent without executing validation or git merge.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Node ID of the worktree node to plan.' },
        },
        required: ['node_id'],
    },
};

export const MESH_REVIEW_INBOX_TOOL = {
    name: 'mesh_review_inbox',
    description: 'List local worktree nodes that need human review: merge candidates (pushed feature branches ready to merge) and Refinery-blocked review results. Returns evidence summaries, diff stats vs. the default branch, and suggested actions (Refine / Requeue / Dismiss). Remote nodes are excluded in M4.0.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            mesh_id: { type: 'string', description: 'Mesh ID (optional — inferred from active mesh if omitted).' },
        },
        required: [],
    },
};

// ─── MAGI — Multi-Agent Ground-truth Insight ──

export const MESH_MAGI_REVIEW_TOOL = {
    name: 'mesh_magi_review',
    description: 'Cross-verify a read-only investigation across a standing panel of independent mesh agents (different machines/providers), instead of sending a SINGLE read-only worker. Drop-in for any read-only investigation — bug RCA, defect/regression measurement, "why does this code do X?", or doc/design/API review. Fans the SAME question out to N independent (node × provider) replicas, then synthesizes consensus/disagreement/unique evidence into a needs_verification list — NOT a majority vote (high agreement among coupled agents ≠ correct). Read-only is FORCED (no execute/write flag exists). COST: multiplies token spend by the total replica count (the call is the opt-in). PANEL RESOLUTION: the panel is resolved SOLELY from the USER-CONFIGURED kind-panel binding for the given `task_kind` (mesh settings → magiKindPanels: task_kind → (node × provider × model) slots). `task_kind` is REQUIRED — there is NO named-panel, inline-members, or automatic-preset path. A task_kind with no configured kind-panel errors `magi_kind_not_configured` (configure slots in mesh settings first). The binding must resolve to ≥2 (node, provider) targets; never silently degrades to N=1 (errors magi_insufficient_targets if the live mesh cannot supply the configured slots).',
    inputSchema: {
        type: 'object' as const,
        properties: {
            question: { type: 'string', description: 'The single investigation question every agent answers — e.g. "What is the root cause of this defect?", "Refute this RCA.", "Why does this code do X?". Not only "review this".' },
            target: { type: 'string', description: 'What to investigate — file path(s), a bug symptom / error / stack trace, a code area / symbol, or omitted when the question is self-contained.' },
            artifacts: { type: 'array', items: { type: 'string' }, description: 'Inline content when not file-backed: a doc/diff, a log/error dump, or a prior single-worker RCA to refute.' },
            n: { type: 'number', description: 'Global replica override per slot (clamped by the total-replica guard cap, default 12).' },
            task_kind: { type: 'string', enum: ['claim_audit', 'rca', 'design', 'freeform'], description: 'REQUIRED. Selects (1) the SINGLE output schema injected into each replica prompt and the strict parser used at collection (no schema-on-schema conflict), AND (2) the user-configured kind-panel binding that supplies the fan-out slots (mesh settings → magiKindPanels; errors magi_kind_not_configured if that kind has no configured slots — no named-panel/inline/preset fallback). claim_audit: {claims[],top_findings[],open_questions[]}. rca: {rootCause,failsAt,mechanism,evidence[],fixDirection,confidence}. design: {recommendation,rationale,alternatives[],tradeoffs[],risks[],evidence[],confidence}. freeform: no schema — natural-language answer, parsing/evidence checks waived, cross-verification is weak. Every kind except freeform requires non-empty evidence[]; an empty-evidence or schema-invalid answer triggers ONE delta re-request before being dropped as unparseable. Do NOT also embed an output-format schema in the question — it collides with this contract (a warning is surfaced if detected).' },
            mode: { type: 'string', enum: ['rca', 'investigation', 'claim_audit', 'design_review', 'code_audit'], description: 'Synthesis emphasis hint — affects labels only, never the agent count or schema. Distinct from task_kind (which selects the output schema).' },
            use_judge: { type: 'boolean', description: 'Default false (clustering synthesis). STUB: judge synthesis is not yet implemented — passing true currently falls back to clustering with a warning. Reserved interface only.' },
            require_independent_evidence: { type: 'boolean', description: 'Default true — high-impact claims with no file:line/source evidence are routed to needs_verification.' },
            include_stale: { type: 'boolean', description: 'Default false. By default, panel slots whose node HEAD commit differs from the coordinator reference commit are EXCLUDED (they would investigate different code). Set true to fan out to them anyway — results will be git-skewed and a warning is surfaced. If exclusion drops the panel below 2 independent targets the call errors rather than degrading to N=1; include_stale=true is one way to recover.' },
            wait: { type: 'boolean', description: 'Default true — collect replica outputs and return the synthesis. Set false to dispatch async and return a consensusGroupId handle; collect later with mesh_magi_collect.' },
            wait_timeout_ms: { type: 'number', description: 'Max time to wait for replica completion before returning a partial "missing K of N" synthesis. Default ~4 min.' },
            auto_cleanup: { type: 'boolean', description: 'Default = mesh policy magiSessionCleanup (ON / stop_and_delete unless overridden). Once all replicas are terminal, stop+delete ONLY the worker sessions THIS fan-out auto-launched (marker-verified) so repeated reviews don\'t accumulate idle worker sessions. Reused/coordinator/other sessions are never touched. Set false to preserve auto-launched worker sessions for inspection. No effect on a partial (non-terminal) collection.' },
        },
        required: ['question', 'task_kind'],
    },
};

export const MESH_MAGI_COLLECT_TOOL = {
    name: 'mesh_magi_collect',
    description: 'Collect + synthesize a previously dispatched MAGI fan-out by its consensus group id — the async companion to mesh_magi_review({ wait:false }). Rediscovers the replica tasks from the queue and runs the SAME diversity-weighted synthesis (consensus/disagreement/unique-evidence → needs_verification list). Defaults to a SNAPSHOT (wait=false): returns whatever replicas are terminal right now, with a pending note if some are still generating; pass wait=true to block for the rest. Read-only. Drive off mission completion / pendingCoordinatorEvents rather than polling this in a tight loop.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            consensus_group_id: { type: 'string', description: 'The consensusGroupId returned by a wait=false mesh_magi_review.' },
            task_kind: { type: 'string', enum: ['claim_audit', 'rca', 'design', 'freeform'], description: 'Optional override of the task_kind used to parse replica answers. Normally recovered automatically from the original dispatch — only set this if the dispatched ledger entry was pruned and auto-recovery falls back to claim_audit incorrectly.' },
            require_independent_evidence: { type: 'boolean', description: 'Default true — high-impact claims with no file:line/source evidence are routed to needs_verification.' },
            wait: { type: 'boolean', description: 'Default false (snapshot). Set true to block for outstanding replicas up to wait_timeout_ms before synthesizing.' },
            wait_timeout_ms: { type: 'number', description: 'When wait=true, max time to wait for remaining replica completion. Default ~4 min.' },
            auto_cleanup: { type: 'boolean', description: 'Default = mesh policy magiSessionCleanup (ON / stop_and_delete). When the collection is terminal, stop+delete ONLY the worker sessions THIS fan-out auto-launched (marker-verified). Reused/coordinator/other sessions are never touched. Set false to preserve them. No effect on a partial (non-terminal) snapshot.' },
            verbose: { type: 'boolean', description: 'Default false. When true, each synthesis.replicas[] entry also carries rawAnswer — the replica\'s raw end-user answer text (capped). Omitted by default to keep the payload small; the structured clusters already carry the parsed claims.' },
        },
        required: ['consensus_group_id'],
    },
};

export const MESH_MAGI_KIND_PANEL_SET_TOOL = {
    name: 'mesh_magi_kind_panel_set',
    description: 'Bind a task_kind to its MAGI kind-panel slot list (machine-local ~/.adhdev/meshes.json `magiKindPanels`). This binding is what a `mesh_magi_review({ task_kind })` resolves to — it is the SOLE panel-resolution path (there is no named-panel or inline-members alternative). IMPORTANT — WHOLESALE REPLACEMENT: a task_kind has exactly one binding, so the `slots` you pass become the COMPLETE new slot set and any prior slots for that kind are dropped (not merged). Because it silently replaces the current binding, get EXPLICIT user approval before writing and present the current-vs-new slot lists (the dry-run returns `currentSlots`). Defaults to dry-run (write=false). Machine-local scope (NOT a repo-committed file).',
    inputSchema: {
        type: 'object' as const,
        properties: {
            task_kind: { type: 'string', description: 'The task_kind key to bind, e.g. claim_audit / rca / design / freeform.' },
            slots: {
                type: 'array',
                description: 'The COMPLETE desired slot list for this kind (wholesale replacement). Each slot: { provider (REQUIRED), nodeId?, model?, capabilityTags?, n? }.',
                items: {
                    type: 'object',
                    properties: {
                        provider: { type: 'string', description: 'REQUIRED — provider type, e.g. claude-cli / codex-cli / gemini-cli / hermes-cli.' },
                        nodeId: { type: 'string', description: 'Optional — pin to a specific mesh node id.' },
                        model: { type: 'string', description: 'Optional — pin a specific model for this slot.' },
                        capabilityTags: { type: 'array', items: { type: 'string' }, description: 'Optional routing tags (ANDed with the provider tag) when nodeId is absent.' },
                        n: { type: 'number', description: 'Optional per-slot replica count (default 1).' },
                    },
                    required: ['provider'],
                },
            },
            write: { type: 'boolean', description: 'When true, persist the slot list (wholesale replacement) to meshes.json. Defaults false (dry-run preview of the normalized slots + currentSlots).' },
        },
        required: ['task_kind', 'slots'],
    },
};

export const MESH_MAGI_KIND_PANEL_LIST_TOOL = {
    name: 'mesh_magi_kind_panel_list',
    description: 'List the configured MAGI kind→panel slot bindings (machine-local). Read-only. Use to confirm what a `task_kind` resolves to before mesh_magi_review, and to diff current-vs-new before an overwrite via mesh_magi_kind_panel_set.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            task_kind: { type: 'string', description: 'Optional — show only this task_kind\'s binding. Omit to list all configured kind bindings.' },
        },
    },
};

export const MESH_NODE_SLOTS_SET_TOOL = {
    name: 'mesh_node_slots_set',
    description: 'PROPOSE (dry-run) or APPLY a mesh node\'s capability-slot list (policy.slots) — the orchestrator\'s surface for autonomously adjusting a node\'s AI-tool profile mid-run (ORCHESTRATION_NODE_SLOTS.md §5). A node\'s slots drive task→node fitness routing and MAGI fan-out, so changing them changes how work is distributed. IMPORTANT — WHOLESALE REPLACEMENT: the `slots` you pass become the node\'s COMPLETE new slot list; any prior slot not in the list is dropped (not merged). Because it silently replaces the profile, get EXPLICIT user approval before writing: the default dry-run (write=false) returns `currentSlots` vs `proposedSlots` for you to present as a diff — re-run with write=true ONLY after the user approves. Apply goes through update_mesh_node (machine-local node policy).',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'REQUIRED — the mesh node id whose capability slots to set.' },
            slots: {
                type: 'array',
                description: 'The COMPLETE desired capability-slot list for this node (wholesale replacement). Each slot: { provider (REQUIRED), model?, thinkingLevel?, difficulty?, capability?, maxParallel? }.',
                items: {
                    type: 'object',
                    properties: {
                        provider: { type: 'string', description: 'REQUIRED — provider type, e.g. claude-cli / codex-cli / gemini-cli / hermes-cli.' },
                        model: { type: 'string', description: 'Optional — model for this slot (best-effort at launch, e.g. opus / gpt-5-codex).' },
                        thinkingLevel: { type: 'string', description: 'Optional — provider-specific thinking level verbatim (e.g. low/medium/high/max, or codex minimal/xhigh).' },
                        difficulty: { type: 'array', items: { type: 'string' }, description: 'Optional — task difficulties this slot handles (easy/medium/difficult/freeform). Empty = all (general-purpose).' },
                        capability: { type: 'array', items: { type: 'string' }, description: 'Optional — capability tags this slot satisfies (matched against a task\'s requiredTags).' },
                        maxParallel: { type: 'number', description: 'Optional — per-node·per-slot max concurrent tasks. Omit = no per-slot cap.' },
                    },
                    required: ['provider'],
                },
            },
            reason: { type: 'string', description: 'Optional — a short rationale for the proposal, echoed in the dry-run so the user sees WHY the change is suggested.' },
            write: { type: 'boolean', description: 'When true, apply the slot list (wholesale replacement) to the node. Defaults false (dry-run preview of proposedSlots + currentSlots).' },
        },
        required: ['node_id', 'slots'],
    },
};

export const MESH_NODE_SLOTS_LIST_TOOL = {
    name: 'mesh_node_slots_list',
    description: 'List a mesh node\'s capability slots (policy.slots). Read-only. Use to confirm the current AI-tool profile of a node and to diff current-vs-proposed before a mesh_node_slots_set overwrite.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'REQUIRED — the mesh node id whose capability slots to list.' },
        },
        required: ['node_id'],
    },
};

export const MESH_WRITE_MESH_JSON_CONFIG_TOOL = {
    name: 'mesh_write_mesh_json_config',
    description: 'Write `.adhdev/mesh.json` (the repo-committed coordinator prompt override/append + declarative config) from the machine-local mesh entry. Gated WRITE sibling of the draft-only export_mesh_json_config. Follows the mesh_init write/overwrite/dry-run precedent: defaults to dry-run (write=false), never clobbers an existing repo mesh.json unless overwrite=true, and validates before writing. Overwrite silently replaces the file, so present a current-vs-suggested diff and get explicit approval first. REPO-COMMITTED scope (commit target) — distinct from the machine-local MAGI kind-panel writes.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            write: { type: 'boolean', description: 'When true, persist .adhdev/mesh.json to the repo (commit target). Defaults false (dry-run preview).' },
            overwrite: { type: 'boolean', description: 'When true, replace an existing .adhdev/mesh.json. Defaults false (never clobber an existing repo mesh.json).' },
            workspace: { type: 'string', description: 'Optional workspace path whose .adhdev/mesh.json is written. Defaults to the coordinator node workspace.' },
        },
    },
};

export const ALL_MESH_TOOLS = [
    MESH_STATUS_TOOL,
    MESH_LIST_NODES_TOOL,
    MESH_ENQUEUE_TASK_TOOL,
    MESH_VIEW_QUEUE_TOOL,
    MESH_QUEUE_CANCEL_TOOL,
    MESH_QUEUE_REQUEUE_TOOL,
    MESH_SEND_TASK_TOOL,
    MESH_READ_CHAT_TOOL,
    MESH_READ_DEBUG_TOOL,
    MESH_LAUNCH_SESSION_TOOL,
    MESH_GIT_STATUS_TOOL,
    MESH_READ_NODE_LOGS_TOOL,
    MESH_FAST_FORWARD_NODE_TOOL,
    MESH_RESTART_DAEMON_TOOL,
    MESH_CHECKPOINT_TOOL,
    MESH_APPROVE_TOOL,
    MESH_LIST_PENDING_APPROVALS_TOOL,
    MESH_CLONE_NODE_TOOL,
    MESH_REMOVE_NODE_TOOL,
    MESH_REFINE_NODE_TOOL,
    MESH_REFINE_BATCH_TOOL,
    MESH_REFINE_CONFIG_TOOL,
    MESH_CHANGE_IMPACT_CONFIG_TOOL,
    MESH_INIT_TOOL,
    MESH_REINIT_TOOL,
    MESH_WRITE_MESH_JSON_CONFIG_TOOL,
    MESH_REFINE_PLAN_TOOL,
    MESH_CLEANUP_SESSIONS_TOOL,
    MESH_PRUNE_STALE_DIRECT_TOOL,
    MESH_TASK_HISTORY_TOOL,
    MESH_LEDGER_QUERY_TOOL,
    MESH_RECORD_NOTE_TOOL,
    MESH_FORGET_NOTE_TOOL,
    MESH_RECONCILE_LEDGER_TOOL,
    MESH_REQUEUE_HELD_EVENTS_TOOL,
    MESH_MISSION_UPSERT_TOOL,
    MESH_MISSION_LIST_TOOL,
    MESH_REVIEW_INBOX_TOOL,
    MESH_MAGI_REVIEW_TOOL,
    MESH_MAGI_COLLECT_TOOL,
    MESH_MAGI_KIND_PANEL_SET_TOOL,
    MESH_MAGI_KIND_PANEL_LIST_TOOL,
    MESH_NODE_SLOTS_SET_TOOL,
    MESH_NODE_SLOTS_LIST_TOOL,
];
