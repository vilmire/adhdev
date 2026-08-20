/**
 * MCP tool schema definitions for the mesh_* tool family.
 *
 * Pure data: per-tool input schemas plus the ALL_MESH_TOOLS registry. Physically
 * split out of mesh-tools.ts (which keeps the handler implementations) — see
 * RF-SURVEY candidate C1. No behavior change: mesh-tools.ts re-exports every symbol
 * below so existing `./tools/mesh-tools.js` import paths stay intact.
 */

/**
 * MESH-IMAGE-DISPATCH: optional structured input accompanying a task instruction.
 *
 * `message` stays the required, unchanged text channel — every existing caller and
 * every text-only task behaves exactly as before. `input` is strictly ADDITIVE: when
 * present it carries a multipart envelope (e.g. a screenshot) that is delivered to the
 * worker's provider instance instead of being flattened to text.
 *
 * Support is per-provider and enforced at dispatch, not here: 7 of 8 CLI providers
 * declare image input (opencode does not), and every ACP provider is text-only. An
 * unsupported target is REFUSED with a provider-named error rather than silently
 * dropping the attachment — a prompt that says "look at this screenshot" must never
 * arrive with no screenshot.
 *
 * Shared by mesh_send_task / mesh_enqueue_task / mesh_enqueue_batch so the three
 * entry points cannot drift in what they accept.
 */
const MESH_TASK_INPUT_SCHEMA = {
    type: 'object' as const,
    description: 'Optional structured multipart input delivered alongside `message` — use to attach an image (e.g. a screenshot) to the task. '
        + 'Shape: {parts: [{type: "text", text}, {type: "image", mimeType, data (base64) | uri}]}. '
        + 'The target provider must declare image support (most CLI providers do; opencode and all ACP providers are text-only) — an unsupported target is refused with an explicit error, never silently stripped. '
        + 'Large attachments are chunked automatically across the mesh transport. Omit entirely for ordinary text tasks.',
    properties: {
        parts: {
            type: 'array' as const,
            description: 'Ordered content parts. A text part carries {type:"text", text}; an image part carries {type:"image", mimeType, and either base64 `data` or a `uri`}.',
            items: { type: 'object' as const },
        },
    },
};

export const MESH_STATUS_TOOL = {
    name: 'mesh_status',
    description: 'Get the current status of all nodes in the repo mesh — health, git state, active sessions, recovery hints, and recommended next steps. Use this to decide which node to send work to or how to recover from failures. Also reports the running daemon build per daemonId under top-level daemonBuilds ({commit, commitShort, version, track}); track is stable/preview when explicitly reported by that daemon and unknown for legacy peers — it is never inferred from an rc version suffix. When a live daemon was built from a commit BEHIND its workspace HEAD it adds staleDaemonBuilds[] + staleDaemonBuildWarning — meaning a just-merged refinery/mesh-tool fix is NOT yet live on that daemon (awaiting deploy/restart; a local dist rebuild does not update a cloud daemon). When a daemon has a durable failed-upgrade notice on record it adds daemonUpgradeFailures{daemonId → {summary, recordedAt, ageLabel, targetVersion, noticePath, logPath}} + daemonUpgradeFailureWarning — meaning that daemon\'s LAST upgrade attempt failed and was rolled back, so it is still on the PREVIOUS version (an upgrade/restart response only ever reports "scheduled", never success). Do not repeatedly call this to wait for generating delegated work; wait for pendingCoordinatorEvents/completion events or an explicit user status request.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            _gemini_compat: { type: 'string', description: 'Dummy property for Gemini compatibility. Ignore this.' },
            includeStaleDirectWorkDetails: { type: 'boolean', description: 'Opt in to the full staleDirectWork array. Defaults false; normal status returns compact staleDirectWorkSummary only.' },
            includeSessions: { type: 'boolean', description: 'Opt in to per-node live session arrays. Default false: compact mode returns a per-node sessionSummary (counts) and de-duplicated full session lists under top-level daemonSessions keyed by daemonId (sessions are not repeated for every node that shares a daemon). Set true to also include the full session array on each node.' },
            includeUsage: { type: 'boolean', description: 'Opt in to the token/cost usage rollup for this mesh (usage.total, usage.retained, usage.byNode, usage.costCoverage). Default false — usage is not read on ordinary status polls. Token counts come from each provider native transcript; costUsd is only present for providers that compute one themselves (hermes), so costCoverage reports how many sessions contributed a cost.' },
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

/**
 * GRAPH-ORCHESTRATION Phase F — enqueue discovery metadata (design "Tool
 * registry/discovery changes" 2 + 3).
 *
 * Carried under MCP's spec-sanctioned `_meta` record (ToolSchema declares
 * `_meta: z.record(z.string(), z.unknown()).optional()`), so a client that does not
 * understand these hints simply ignores them and the published tool list stays
 * protocol-valid. Two independent mechanisms, both defense in depth behind the
 * prompt rule in coordinator-prompt.ts:
 *
 *   `discoveryKeywords` — both tools share the same query vocabulary, so a search
 *     for "enqueue"/"delegate"/"task"/"graph"/"dependency" matches BOTH. Without the
 *     shared vocabulary a search for "enqueue" could match only the tool whose name
 *     contains it, which is exactly how the fallback got selected alone.
 *   `discoveryRank` — LOWER sorts first. Batch is 0 and task is 10 for the
 *     `enqueue`/`delegate` queries listed in `discoveryRankQueries`, so a ranked
 *     client returns batch as the first candidate.
 *   `toolGroup: 'mesh.enqueue'` + `toolGroupMembers` — providers that support tool
 *     groups expose the siblings together, so loading the fallback also exposes
 *     batch. The group is declared identically on both members.
 *
 * This is NOT an enforcement layer: nothing here rejects a single enqueue, and
 * `batch_required` is not implemented (Phase F is warn-only by design).
 */
const ENQUEUE_TOOL_GROUP = 'mesh.enqueue';
const ENQUEUE_TOOL_GROUP_MEMBERS = ['mesh_enqueue_batch', 'mesh_enqueue_task'] as const;
const ENQUEUE_DISCOVERY_KEYWORDS = ['enqueue', 'delegate', 'task', 'graph', 'dependency'] as const;
/** Queries for which batch must outrank the single-task fallback. */
const ENQUEUE_RANK_QUERIES = ['enqueue', 'delegate'] as const;

const ENQUEUE_BATCH_DISCOVERY_META = {
    toolGroup: ENQUEUE_TOOL_GROUP,
    toolGroupMembers: ENQUEUE_TOOL_GROUP_MEMBERS,
    discoveryKeywords: ENQUEUE_DISCOVERY_KEYWORDS,
    discoveryRankQueries: ENQUEUE_RANK_QUERIES,
    discoveryRank: 0,
    enqueueRole: 'default',
} as const;

const ENQUEUE_TASK_DISCOVERY_META = {
    toolGroup: ENQUEUE_TOOL_GROUP,
    toolGroupMembers: ENQUEUE_TOOL_GROUP_MEMBERS,
    discoveryKeywords: ENQUEUE_DISCOVERY_KEYWORDS,
    discoveryRankQueries: ENQUEUE_RANK_QUERIES,
    discoveryRank: 10,
    enqueueRole: 'single_task_fallback',
} as const;

export const MESH_ENQUEUE_TASK_TOOL = {
    name: 'mesh_enqueue_task',
    description: 'SINGLE-TASK FALLBACK. Use only when exactly one new worker task is currently known and no downstream graph step can yet be declared. If two or more steps are known—including steps that need outputs, worktree preparation, a condition, or a coordinator action—load and use mesh_enqueue_batch instead. Same-session continuation belongs in mesh_send_task. '
        + 'Adds the task to the mesh work queue; idle nodes automatically pull and execute from it. Use this instead of mesh_send_task when you do not need to target a specific node. '
        + 'Supports task-level priority (high tasks are pulled ahead of older normal/low tasks), not_before delayed execution (hold a task pending until a time), maxRetries (auto-fail after N requeues), and duplicate detection '
        + '(by default warns in the response when an in-flight task with the same message+target already exists; pass block_duplicate=true to refuse instead, or allow_duplicate=true to silence the warning).',
    _meta: ENQUEUE_TASK_DISCOVERY_META,
    inputSchema: {
        type: 'object' as const,
        properties: {
            message: { type: 'string', description: 'The task instruction for the agent.' },
            input: MESH_TASK_INPUT_SCHEMA,
            task_mode: { type: 'string', enum: ['code_change', 'validation', 'live_debug_readonly', 'launch_app', 'convergence'], description: 'Optional task-mode contract. live_debug_readonly rejects obvious write/commit/push/deploy/destructive instructions before dispatch — and in exchange runs without the one-active-per-node write isolation (N read-only tasks may run in parallel on one busy node, no worktree needed) under a separate, larger read-only concurrency cap. Prefer it for investigation/diagnosis: it is the cheaper mode to schedule, not just the restricted one.' },
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
            mission_id: { type: 'string', description: 'Mission this task belongs to (mesh_mission record id, full/exact). An unresolvable id is REJECTED at enqueue (mission_not_found), never silently attached — use mesh_mission_list to get a valid full id.' },
            missionId: { type: 'string', description: 'CamelCase alias for mission_id.' },
            priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'G6 (task-level scheduling priority). Within the claim tier a high task is pulled ahead of an older normal/low task (created_at is the tie-break); low is pulled last. Defaults to normal. This is the TASK priority (which task a node pulls first) — distinct from a node\'s schedulingPriority (which node work goes to). Use high to jump an urgent fix ahead of a backlog without cancelling the queue.' },
            model: { type: 'string', description: 'Optional model override for the agent that runs this task, e.g. opus, sonnet, haiku. Best-effort: applied at launch for providers that support a model flag (claude-cli --model, ACP setConfigOption); ignored by providers that cannot honor it. Use a cheaper model for simple tasks to save tokens, a stronger one for hard work. Blank = the provider default.' },
            thinkingLevel: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Optional reasoning-effort level for this task. Best-effort: applied at launch for providers that support it (claude-cli --effort, codex-cli reasoning effort, ACP thought_level); ignored otherwise. Use low for simple tasks (fewer tokens), high for hard reasoning.' },
            difficulty: { type: 'string', enum: ['easy', 'medium', 'difficult', 'freeform'], description: 'REQUIRED task execution difficulty — a ROUTING HINT, not a model selector. It is matched against each node\'s capability slots so the task lands on a slot configured for that difficulty, and THAT SLOT\'s own model + thinkingLevel are what launch. It does not by itself mean a cheaper or stronger model: to change what a difficulty runs on, edit the node\'s slots (mesh_node_slots_set) rather than picking a different difficulty. Classify each task by how hard the work actually is. An explicit model/thinkingLevel above always wins.' },
            notBefore: { type: 'number', description: 'CamelCase alias for not_before. Also accepts an ISO-8601 timestamp string.' },
            max_retries: { type: 'number', description: 'P3 (retry cap). Max automatic requeue attempts before the task auto-fails instead of returning to pending. When requeueCount reaches this, mesh_queue_requeue auto-fails the task unless force=true. Omit to use the mesh policy default (maxTaskRetries, typically 1).' },
            maxRetries: { type: 'number', description: 'CamelCase alias for max_retries.' },
            block_duplicate: { type: 'boolean', description: 'G4 (duplicate detection, block mode). Default false = warn-only: if an in-flight (pending/assigned) task with the same message (+ target node when pinned) already exists, the task is still enqueued but the response carries duplicateSuspect. Set true to REFUSE the enqueue with code duplicate_suspect instead (structural TASKBUBBLE-DUP defense — use when re-sending a task that a slow prior turn may have already enqueued).' },
            blockDuplicate: { type: 'boolean', description: 'CamelCase alias for block_duplicate.' },
            allow_duplicate: { type: 'boolean', description: 'G4. Set true to skip duplicate detection entirely (no warning, no block) for an intentional re-enqueue of the same instruction.' },
            allowDuplicate: { type: 'boolean', description: 'CamelCase alias for allow_duplicate.' },
            // design :692 — "The single tool should require an orchestration_decision".
            // OPTIONAL here on purpose: Phase F is warn-only (see the discovery-meta note
            // above), and a required field would break legacy/external clients that
            // predate it. An omitted record degrades to decision_missing, which is itself
            // the signal — never an enqueue failure.
            orchestration_decision: {
                type: 'object',
                description: 'Record of your planning decision, for adoption measurement: {decision, ready_worker_tasks, known_graph_steps, single_reason, capability_blockers}. On this single-task surface, single_reason says why one task was right — one of only_one_step_known, future_step_not_specifiable, same_session_continuation, legacy_client, operator_override. '
                    + 'output_needed / workspace_unresolved / coordinator_action_between are NOT blockers any more (mesh_enqueue_batch covers them via inputs_from, workspace_ref and coordinator gates); reporting one returns a batch_capability_available warning. '
                    + 'Optional and never rejected: omitting it is recorded as decision_missing, and declaring known_graph_steps >= 2 here is recorded as a declared eligible single. Provenance only — it never changes execution.',
            },
            orchestrationDecision: { type: 'object', description: 'CamelCase alias for orchestration_decision.' },
        },
        required: ['message', 'difficulty'],
    },
};

export const MESH_ENQUEUE_BATCH_TOOL = {
    name: 'mesh_enqueue_batch',
    description: 'DEFAULT enqueue surface for a plan with two or more known graph steps. Atomically persists the graph plan and worker queue entries. Supports batch-local refs, completion dependencies, selected predecessor outputs through `inputs_from`, declarative `run_if`, delayed `workspace_ref` preparation, and coordinator gates. Worker dispatch still requires the shared dependency predicate: all active worker dependencies completed and no system block. Git workspace preparation is a compensated saga and is reported separately from DB atomicity. '
        + 'Atomicity in detail: either EVERY task in the batch is inserted or NONE is (a mid-batch error such as a dependency cycle, invalid difficulty, or guardrail violation rolls the whole batch back). '
        + 'Give each task a batch-local `ref` label and name sibling refs in `depends_on` (forward references allowed — array order does not matter). '
        + 'A depends_on value that is not a ref in this batch must be an EXISTING queue task id; anything else is rejected. Per-task fields are the same as mesh_enqueue_task. Top-level mission_id applies to every task that lacks its own. '
        + '`inputs_from` binds selected predecessor outputs into a later task (no hand-copying worker text), `run_if` branches on those outputs, `gates` declare steps that stop for a coordinator action '
        + '(Refinery landing, approval, CI wait, publish, deploy) with downstream tasks pointing at them via `gated_by`, and `workspaces` + `workspace_ref` prepare a worktree later for a task that needs one. '
        + 'These are strictly additive: a batch using only message/depends_on behaves exactly as before. Only graph-using batches create a graph, inspectable with mesh_graph_view.',
    _meta: ENQUEUE_BATCH_DISCOVERY_META,
    inputSchema: {
        type: 'object' as const,
        properties: {
            tasks: {
                type: 'array',
                description: 'The tasks to enqueue atomically (max 50). Each entry accepts the same fields as mesh_enqueue_task, plus an optional batch-local `ref`.',
                items: {
                    type: 'object',
                    properties: {
                        ref: { type: 'string', description: 'Batch-local label other entries\' depends_on may name (e.g. "investigate", "fix", "verify"). Never persisted — resolved to the generated task id at insert.' },
                        message: { type: 'string', description: 'The task instruction for the agent.' },
                        input: MESH_TASK_INPUT_SCHEMA,
                        task_mode: { type: 'string', enum: ['code_change', 'validation', 'live_debug_readonly', 'launch_app', 'convergence'], description: 'Optional task-mode contract (same semantics as mesh_enqueue_task).' },
                        taskMode: { type: 'string', enum: ['code_change', 'validation', 'live_debug_readonly', 'launch_app', 'convergence'], description: 'CamelCase alias for task_mode.' },
                        readonly: { type: 'boolean', description: 'Optional read-only axis (orthogonal to task_mode); same semantics as mesh_enqueue_task.' },
                        read_only: { type: 'boolean', description: 'Snake-case alias for readonly.' },
                        requiredTags: { type: 'array', items: { type: 'string' }, description: 'Optional capability tags every eligible node must have, e.g. os=darwin, provider=codex-cli, worktree=<branch>.' },
                        required_tags: { type: 'array', items: { type: 'string' }, description: 'Snake_case alias for requiredTags.' },
                        target_node_id: { type: 'string', description: 'Optional HARD pin: only this node may claim the task. An unresolvable id rejects the WHOLE batch (atomic).' },
                        targetNodeId: { type: 'string', description: 'CamelCase alias for target_node_id.' },
                        prefer_worktree: { type: 'boolean', description: 'Route to the most recently cloned idle worktree node (no-op when none exists).' },
                        preferWorktree: { type: 'boolean', description: 'CamelCase alias for prefer_worktree.' },
                        depends_on: { type: 'array', items: { type: 'string' }, description: 'Refs of sibling entries in THIS batch (forward references allowed) and/or EXISTING queue task ids that must complete before this task becomes claimable. Cycles and unknown values reject the whole batch.' },
                        dependsOn: { type: 'array', items: { type: 'string' }, description: 'CamelCase alias for depends_on.' },
                        mission_id: { type: 'string', description: 'Per-task mission override (full/exact id); defaults to the top-level mission_id. An unresolvable id rejects the WHOLE batch (atomic).' },
                        missionId: { type: 'string', description: 'CamelCase alias for mission_id.' },
                        priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'G6 task-level scheduling priority (same semantics as mesh_enqueue_task).' },
                        model: { type: 'string', description: 'Optional model override for the agent that runs this task (best-effort at launch).' },
                        thinkingLevel: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Optional reasoning-effort level (best-effort at launch).' },
                        difficulty: { type: 'string', enum: ['easy', 'medium', 'difficult', 'freeform'], description: 'REQUIRED per task — routing hint matched against node capability slots (same semantics as mesh_enqueue_task).' },
                        not_before: { type: 'number', description: 'G7 delayed execution: hold the task pending until this time (epoch-ms, relative-ms, or ISO string).' },
                        notBefore: { type: 'number', description: 'CamelCase alias for not_before. Also accepts an ISO-8601 timestamp string.' },
                        max_retries: { type: 'number', description: 'P3 retry cap (same semantics as mesh_enqueue_task).' },
                        maxRetries: { type: 'number', description: 'CamelCase alias for max_retries.' },
                        // ── batch v2 graph fields (design :568-570). All optional; a batch
                        //    using none of them takes the unchanged compatibility path. ──
                        inputs_from: {
                            type: 'array',
                            description: 'Bind SELECTED outputs of predecessor steps into this task, instead of hand-copying a worker\'s text into the instruction. Each entry is {from: <ref of a predecessor task or gate>, select: <RFC-6901 JSON Pointer into that step\'s completion envelope>, as: <binding name>, required?: bool}. Bound values are appended to your immutable instruction inside a clearly-marked untrusted-evidence envelope with provenance and a digest — they can never alter routing, permissions, task mode or model. Using this makes the task wait for the graph to bind it before it becomes claimable.',
                            items: { type: 'object' },
                        },
                        inputsFrom: { type: 'array', description: 'CamelCase alias for inputs_from.', items: { type: 'object' } },
                        run_if: { type: 'object', description: 'Declarative condition deciding whether this task runs at all, evaluated against predecessor outputs and released gate outcomes (e.g. only run the deploy when the gate outcome was `passed`). A condition that is false SKIPS the task — skipped is terminal and, deliberately, is NOT treated as completed, so it never satisfies a downstream dependency. A malformed condition fails closed rather than defaulting to true.' },
                        runIf: { type: 'object', description: 'CamelCase alias for run_if.' },
                        on_false: { type: 'string', enum: ['skip'], description: 'What to do when run_if is false. Only `skip` is defined (and is the default).' },
                        onFalse: { type: 'string', enum: ['skip'], description: 'CamelCase alias for on_false.' },
                        on_upstream_skip: { type: 'string', enum: ['skip', 'omit_dependency'], description: 'What happens to this task when an upstream step is SKIPPED. `skip` (default) propagates the skip. `omit_dependency` drops that edge from this task\'s dependency projection so it can still run — the explicit way to say "run anyway if that branch was not taken".' },
                        onUpstreamSkip: { type: 'string', enum: ['skip', 'omit_dependency'], description: 'CamelCase alias for on_upstream_skip.' },
                        workspace_ref: { type: 'string', description: 'Run this task in a worktree declared in the top-level `workspaces` array, prepared LATER rather than before the batch is accepted. The task stays held until that worktree is ready, then it is pinned to it automatically. Worktree preparation is a compensated saga: it is reported separately as workspacePreparation and is never part of the batch\'s DB atomicity.' },
                        workspaceRef: { type: 'string', description: 'CamelCase alias for workspace_ref.' },
                        gated_by: { type: 'array', items: { type: 'string' }, description: 'Refs of gates in this batch\'s `gates` array that must be RELEASED before this task may run. This is how you say "do not start until I have landed/approved/deployed". Do NOT put a gate ref in depends_on — a gate is an intentional stop, not an ordinary queue dependency, and listing one there is rejected.' },
                        gatedBy: { type: 'array', items: { type: 'string' }, description: 'CamelCase alias for gated_by.' },
                    },
                    required: ['message', 'difficulty'],
                },
            },
            gates: {
                type: 'array',
                description: 'Coordinator GATES: graph steps that intentionally stop progress until YOU act (Refinery landing, approval, CI wait, publish, deploy). The daemon never performs the action and never auto-passes a gate — you claim it (mesh_graph_gate_claim), do the thing, then release it (mesh_graph_gate_release). Declare the gate here and point downstream tasks at it with gated_by, so the whole plan can be submitted at once instead of waiting to enqueue the later steps by hand. Gate refs share ONE namespace with task and workspace refs.',
                items: {
                    type: 'object',
                    properties: {
                        ref: { type: 'string', description: 'Label for this gate; downstream tasks name it in gated_by.' },
                        action: { type: 'string', enum: ['refinery', 'approval', 'ci_wait', 'publish', 'deploy', 'custom'], description: 'What kind of action this gate is waiting for. A metadata label only — it tells you (and the view) what the gate means; the daemon never executes it.' },
                        instructions: { type: 'string', description: 'What the coordinator must do at this gate, shown when the gate opens.' },
                        depends_on: { type: 'array', items: { type: 'string' }, description: 'Refs of tasks/gates in this batch that must complete before this gate OPENS for a coordinator.' },
                        on_timeout: { type: 'string', enum: ['hold', 'cancel_downstream', 'fail_graph'], description: 'What happens when the gate passes its deadline. `hold` (default) keeps downstream blocked for an explicit reclaim; `cancel_downstream` cancels the pending downstream branch; `fail_graph` fails the graph. There is deliberately NO auto-release option: a timeout is never treated as the action having succeeded.' },
                        deadline_seconds: { type: 'number', description: 'Seconds from when the gate OPENS until its on_timeout policy fires.' },
                        lease_seconds: { type: 'number', description: 'Default claim lease length for this gate (a claim may override it).' },
                        eligible_coordinator_session_id: { type: 'string', description: 'Restrict claiming to one coordinator session.' },
                    },
                    required: ['ref'],
                },
            },
            workspaces: {
                type: 'array',
                description: 'Worktrees to prepare LATER for tasks that name them via workspace_ref — the way to plan "clone a worktree, then work in it" as one batch instead of enqueueing, waiting, and enqueueing again. Preparation is a compensated saga with owned-resource cleanup: it happens outside the batch transaction and is reported as workspacePreparation, so `atomic: true` never claims the git side effects happened.',
                items: {
                    type: 'object',
                    properties: {
                        ref: { type: 'string', description: 'Label tasks use in workspace_ref. Shares one namespace with task and gate refs.' },
                        source_node_id: { type: 'string', description: 'Node whose workspace the worktree is cloned from.' },
                        purpose: { type: 'string', description: 'Short label folded into the derived branch name.' },
                        base_revision: { type: 'string', description: 'Base revision to prepare from.' },
                        desired_path: { type: 'string', description: 'Optional explicit worktree path.' },
                        cleanup_on_graph_failure: { type: 'boolean', description: 'Remove the worktree this graph created if the graph fails. Only ever removes a worktree the saga itself owns.' },
                    },
                    required: ['ref'],
                },
            },
            batch_id: { type: 'string', description: 'Your own idempotency key for this batch. Re-sending the SAME batch_id with an identical plan replays and inserts nothing new; the same batch_id with a different plan is rejected (batch_id_conflict). Use it whenever a retry might duplicate work. Supplying it records the batch as a graph (so the key can be enforced), which is why the response then carries graphId — task behavior is unchanged.' },
            batchId: { type: 'string', description: 'CamelCase alias for batch_id.' },
            orchestration_decision: {
                type: 'object',
                description: 'Optional record of your planning decision, for adoption measurement: {decision, ready_worker_tasks, known_graph_steps, single_reason, capability_blockers}. It is stored as provenance with the graph and never changes execution.',
            },
            orchestrationDecision: { type: 'object', description: 'CamelCase alias for orchestration_decision.' },
            mission_id: { type: 'string', description: 'Mission every task in this batch belongs to unless an entry overrides it (full/exact id). For multi-task work, create the mission first (mesh_mission_upsert) and pass it here. An unresolvable id rejects the WHOLE batch (atomic) before anything is inserted.' },
            missionId: { type: 'string', description: 'CamelCase alias for mission_id.' },
            block_duplicate: { type: 'boolean', description: 'G4: when any entry matches an in-flight task with the same message+target, refuse the WHOLE batch (it is atomic) with code duplicate_suspect. Default false = warn-only via duplicateSuspects in the response.' },
            blockDuplicate: { type: 'boolean', description: 'CamelCase alias for block_duplicate.' },
            allow_duplicate: { type: 'boolean', description: 'G4: skip duplicate detection entirely for every entry (intentional re-enqueue).' },
            allowDuplicate: { type: 'boolean', description: 'CamelCase alias for allow_duplicate.' },
            on_dependency_failure: {
                type: 'string',
                enum: ['block', 'cancel'],
                description: 'on_dependency_failure controls downstream tasks when a required worker task fails or is cancelled. `block` (default) keeps downstream pending and automatically recovers if the predecessor is retried and later completes. `cancel` terminally cancels the dependent branch; it is not revived by predecessor retry.',
            },
            onDependencyFailure: {
                type: 'string',
                enum: ['block', 'cancel'],
                description: 'CamelCase alias for on_dependency_failure.',
            },
        },
        required: ['tasks'],
    },
};

// ── GRAPH-ORCHESTRATION Phase E: the coordinator gate + graph view surface ──
// design :759-763 (view), :407-421 (claim/release), :425-439 (timeout policy).

export const MESH_GRAPH_GATE_CLAIM_TOOL = {
    name: 'mesh_graph_gate_claim',
    description: 'Take the lease on a coordinator GATE that is awaiting a coordinator. A gate is a graph step that intentionally STOPS progress '
        + 'until a human/coordinator does something the daemon must not do itself — a Refinery landing, an approval, waiting on CI, a publish, a deploy. '
        + 'The daemon NEVER performs a gate action and NEVER auto-passes a gate: the only way through is your own mesh_graph_gate_release. '
        + 'Claim returns a monotonically increasing leaseGeneration and an opaque fencingToken — you MUST present both at release, so keep them. '
        + 'A gate whose lease has lapsed can be taken over by a new claim at a HIGHER generation; when that happens the response sets '
        + 'ambiguousExternalOutcome, meaning the previous owner may already have performed the external side effect — reconcile external evidence '
        + '(did the merge/publish already land?) before doing it again. Use mesh_graph_view to find gates awaiting a coordinator.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            gate_id: { type: 'string', description: 'The gate to claim (from mesh_graph_view or the mesh_enqueue_batch response).' },
            gateId: { type: 'string', description: 'CamelCase alias for gate_id.' },
            lease_seconds: { type: 'number', description: 'How long to hold the lease before it lapses. Defaults to the gate spec\'s lease_seconds, then 900s. Pick a duration that covers the real action — a lapsed lease cannot release (elapsed time is never completion evidence).' },
            leaseSeconds: { type: 'number', description: 'CamelCase alias for lease_seconds.' },
            extend_deadline_seconds: { type: 'number', description: 'Push the gate DEADLINE out by this many seconds from now. Distinct from the lease: the deadline is when the on_timeout policy (hold / cancel_downstream / fail_graph) fires. Reclaiming a gate that expired under on_timeout=hold does NOT refresh its deadline unless you pass this, so the next sweep would expire it again.' },
            extendDeadlineSeconds: { type: 'number', description: 'CamelCase alias for extend_deadline_seconds.' },
            coordinator_session_id: { type: 'string', description: 'Owner session for the lease. Defaults to this coordinator session; pass explicitly only when driving a gate on behalf of another session.' },
            coordinatorSessionId: { type: 'string', description: 'CamelCase alias for coordinator_session_id.' },
        },
        required: ['gate_id'],
    },
};

export const MESH_GRAPH_GATE_RELEASE_TOOL = {
    name: 'mesh_graph_gate_release',
    description: 'Release a coordinator gate you hold the lease on — the ONLY way a gate lets its downstream work run. Requires the leaseGeneration + fencingToken '
        + 'from your mesh_graph_gate_claim: a stale generation or wrong token is refused (stale_fence), and an EXPIRED lease can never release (re-claim first, '
        + 'and reconcile whether the external action already happened). Pass an idempotency_key of your choosing: re-sending the identical release with the same key '
        + 'is a safe no-op success, while the same key with a DIFFERENT payload is rejected as a conflict. `outcome` (passed / failed / rejected, or an action-specific label) '
        + 'and any structured `result` / `evidence` become readable by downstream tasks through run_if and inputs_from, so a gate decision can steer the rest of the graph. '
        + 'Validation failures roll the WHOLE release back: the gate stays claimed and downstream stays blocked.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            gate_id: { type: 'string', description: 'The gate being released.' },
            gateId: { type: 'string', description: 'CamelCase alias for gate_id.' },
            fencing_token: { type: 'string', description: 'The opaque token returned by mesh_graph_gate_claim. Required.' },
            fencingToken: { type: 'string', description: 'CamelCase alias for fencing_token.' },
            lease_generation: { type: 'number', description: 'The leaseGeneration returned by mesh_graph_gate_claim. Required — a stale generation is refused.' },
            leaseGeneration: { type: 'number', description: 'CamelCase alias for lease_generation.' },
            idempotency_key: { type: 'string', description: 'Your own key for this release. Re-sending the identical release with the same key is a no-op success; the same key with a different payload is a conflict. Required.' },
            idempotencyKey: { type: 'string', description: 'CamelCase alias for idempotency_key.' },
            outcome: { type: 'string', description: 'The gate outcome: passed | failed | rejected, or an action-specific structured label. Downstream run_if conditions read it as /gate_outcome.' },
            result: { type: 'object', description: 'Optional action-specific structured result, exposed to downstream bindings as /result/... (e.g. the merged commit sha).' },
            evidence: { type: 'object', description: 'Optional evidence references/digests, exposed to downstream bindings as /evidence/... .' },
            patches: {
                type: 'array',
                description: 'Optional pre-assignment patches to DIRECT downstream nodes. Only run_if, on_false, inputs_from and workspace_ref may be patched — message, routing, permissions, task mode and model are immutable by policy, and a task that is already claimed cannot be patched at all.',
                items: {
                    type: 'object',
                    properties: {
                        node: { type: 'string', description: 'Ref or node id of a DIRECT downstream node of this gate.' },
                        base_spec_patch: { type: 'object', description: 'Keys to merge into that node\'s spec. Allowed keys: run_if, on_false, inputs_from, workspace_ref.' },
                        baseSpecPatch: { type: 'object', description: 'CamelCase alias for base_spec_patch.' },
                    },
                    required: ['node'],
                },
            },
        },
        required: ['gate_id', 'fencing_token', 'lease_generation', 'idempotency_key', 'outcome'],
    },
};

export const MESH_GRAPH_GATE_ABANDON_TOOL = {
    name: 'mesh_graph_gate_abandon',
    description: 'Give up on a coordinator gate that can never be opened, so its graph can reach a terminal state. Use this when the work behind a gate was cancelled or is no longer wanted — '
        + 'e.g. you cancelled the implementation tasks and the refinery/land gate is now stranded with nothing to land. Without it that gate stays awaiting_coordinator forever and the graph can '
        + 'reach NO terminal state at all, not even cancelled. '
        + '★ ABANDON IS NOT A PASS. It materializes NOTHING: every downstream task this gate was holding is CANCELLED, not opened, and no outcome/result/evidence is produced for downstream run_if or inputs_from. '
        + 'If you actually want the downstream work to run, use mesh_graph_gate_release instead — that is the only way through a gate, and this tool is deliberately not a shortcut around it. '
        + 'Needs no fencing token (it grants no passage), but a gate whose lease is still LIVE under another coordinator is refused unless you pass force=true — that holder may be mid-action on a real '
        + 'external side effect (a merge, a publish, a deploy). Abandoning an already-abandoned gate is a safe no-op; a RELEASED gate can never be abandoned, because its downstream already ran.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            gate_id: { type: 'string', description: 'The gate to abandon (from mesh_graph_view).' },
            gateId: { type: 'string', description: 'CamelCase alias for gate_id.' },
            reason: { type: 'string', description: 'Why this gate is being given up — recorded on the gate node, on every cancelled downstream row, and in the provenance ledger. Required: an abandon with no stated reason is indistinguishable from a mistake later.' },
            force: { type: 'boolean', description: 'Abandon even though another coordinator holds a LIVE lease. Only when you know that holder is dead — otherwise you may strand an external side effect it is mid-way through.' },
            coordinator_session_id: { type: 'string', description: 'Recorded as who abandoned the gate. Defaults to this coordinator session.' },
            coordinatorSessionId: { type: 'string', description: 'CamelCase alias for coordinator_session_id.' },
        },
        required: ['gate_id', 'reason'],
    },
};

export const MESH_GRAPH_VIEW_TOOL = {
    name: 'mesh_graph_view',
    description: 'Inspect orchestration GRAPHS on this mesh: node states and refs, active edges, materialization receipts, coordinator gates (with who holds the lease and what is blocked), '
        + 'delayed workspace sagas, derived dependency failures, and the next action a coordinator actually has to take. Read-only. Defaults to in-flight graphs; pass include_terminal=true for completed ones. '
        + 'Only mesh_enqueue_batch requests that use graph features (gates, inputs_from, run_if, workspace_ref) create a graph — a plain depends_on batch runs on the ordinary queue and appears in mesh_view_queue instead. '
        + 'Do not poll this waiting for generating work; use it when you need to know why something is blocked or which gate is waiting on you.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            graph_id: { type: 'string', description: 'Show exactly this graph (including terminal ones).' },
            graphId: { type: 'string', description: 'CamelCase alias for graph_id.' },
            batch_id: { type: 'string', description: 'Show the graph committed under this batch_id.' },
            batchId: { type: 'string', description: 'CamelCase alias for batch_id.' },
            include_terminal: { type: 'boolean', description: 'Include completed/failed/cancelled graphs. Default false (in-flight only).' },
            includeTerminal: { type: 'boolean', description: 'CamelCase alias for include_terminal.' },
            limit: { type: 'number', description: 'Max graphs to return (default 20).' },
        },
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
    description: 'Return a mesh queue task to pending for retry, optionally re-targeting it and/or REWRITING its instruction. By default clears stale assigned owner and target session so another live session can claim it. When the task has exceeded its retry cap it is auto-failed instead; use force=true to override. '
        + 'This is also the way OUT of parking: a task whose target-session pin went stale is PARKED (held, still addressed, claimable by nobody) and any requeue unparks it — see parkedTasks in mesh_view_queue.',
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
            message: { type: 'string', description: 'Optional REPLACEMENT instruction for the task. Use when the situation moved on while the task waited — the common case for a parked delta, e.g. the worker already finished the part your correction was about, so the original wording would now be wrong or redundant. Preserves the task id, mission linkage and dependents (unlike cancel + re-enqueue). Omitted or blank leaves the existing message untouched.' },
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
            input: MESH_TASK_INPUT_SCHEMA,
            task_mode: { type: 'string', enum: ['code_change', 'validation', 'live_debug_readonly', 'launch_app', 'convergence'], description: 'Optional task-mode contract. live_debug_readonly rejects obvious write/commit/push/deploy/destructive instructions before local or remote direct dispatch.' },
            taskMode: { type: 'string', enum: ['code_change', 'validation', 'live_debug_readonly', 'launch_app', 'convergence'], description: 'CamelCase alias for task_mode.' },
            readonly: { type: 'boolean', description: 'Optional read-only axis (orthogonal to task_mode). When true the task runs without write isolation, is counted under the read-only cap, and rejects write/commit/push/deploy/destructive instructions like live_debug_readonly. Composable with any task_mode.' },
            read_only: { type: 'boolean', description: 'Snake-case alias for readonly.' },
            mission_id: { type: 'string', description: 'Mission this task belongs to (mesh_mission record id, full/exact). When set, the directly dispatched task is attributed to the mission task aggregates exactly like mesh_enqueue_task, including terminal completion. Omit for an unattributed direct dispatch. An unresolvable id is REJECTED before dispatch (mission_not_found), never silently attached.' },
            missionId: { type: 'string', description: 'CamelCase alias for mission_id.' },
            difficulty: { type: 'string', enum: ['easy', 'medium', 'difficult', 'freeform'], description: 'REQUIRED task execution difficulty. Classify each task by how hard the work actually is. On a direct dispatch the target node/session is already chosen, so difficulty is not used to ROUTE — it is recorded on the task so scheduling analytics, mission aggregates and (critically) failure-recovery relaunch all see the same axis a queued task carries. A recovery relaunch inherits this value from the ledger, so an unclassified direct dispatch would silently downgrade its own retry.' },
            delivery_mode: {
                type: 'string',
                enum: ['when_idle', 'interrupt'],
                description: "How to deliver when the target session is BUSY. Default 'when_idle': never disturbs the running turn — the task is queued and auto-delivered the moment the session goes idle. "
                    + "★'interrupt' ABORTS the turn currently in flight by pressing the provider's own stop control (Ctrl-C, or ESC on antigravity-cli), then delivers this task once the session settles. "
                    + 'THE WORK IN PROGRESS IS DISCARDED — whatever the agent had not yet finished is lost, and any partial edits it was mid-way through are left as they are. Use it only when the running turn is genuinely going the wrong way and finishing it is worse than losing it. '
                    + "If the target provider cannot interrupt (no stop control declared, or an empty stop key), the dispatch is REJECTED rather than quietly falling back to when_idle — so a steering attempt never reports success while the session actually runs on to completion under the old instructions. Re-send with 'when_idle' if delivery-after-completion is acceptable. "
                    + 'Has no effect on an idle session (delivered immediately either way).',
            },
            deliveryMode: { type: 'string', enum: ['when_idle', 'interrupt'], description: 'CamelCase alias for delivery_mode.' },
        },
        required: ['node_id', 'session_id', 'message', 'difficulty'],
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

export const MESH_READ_TERMINAL_TOOL = {
    name: 'mesh_read_terminal',
    description: 'Read the CURRENT raw terminal screen (the rendered PTY viewport — what a human would see on screen right now) of a delegated agent session on a mesh node. '
        + 'This is the LIVE screen, not the parsed chat transcript: use it to see exactly what the worker is showing — a prompt it is parked on, a modal, a spinner, or unparsed output that mesh_read_chat does not surface. For the conversation transcript use mesh_read_chat instead. '
        + 'The reply is byte-bounded (default 32KiB, max 64KiB; the BOTTOM of the screen — prompt/modal/recent output — is kept when truncated) and returns truncated/original_bytes/returned_bytes plus the cursor position and viewport size. '
        + 'Scoped to coordinator-spawned mesh worker sessions only. NOTE: the raw screen can contain tokens / command args / env values, so treat the returned text as sensitive.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            session_id: { type: 'string', description: 'Agent session ID whose live terminal viewport to read.' },
            max_bytes: { type: 'number', description: 'Optional UTF-8 byte cap for the returned screen text (default 32768, clamped to [1024, 65536]). When the screen exceeds it, the bottom (most recent) lines are kept.' },
        },
        required: ['node_id', 'session_id'],
    },
};

export const MESH_SEND_KEYS_TOOL = {
    name: 'mesh_send_keys',
    description: 'Inject a STRUCTURED key sequence into a delegated worker session\'s live PTY (keystrokes a human would type). '
        + 'Use for interactions mesh_send_task cannot express: dismiss/answer a non-approval prompt, navigate a picker (arrows/TAB), submit an already-typed line (ENTER), correct input (BACKSPACE), or interrupt a runaway command (CTRL_C). For sending a task/message, use mesh_send_task; for an APPROVAL modal, use mesh_approve (send_keys is refused on an actionable approval modal by design). '
        + 'Each sequence item is either {"text":"literal"} or {"key":NAME} where NAME ∈ ENTER|ESC|CTRL_C|UP|DOWN|LEFT|RIGHT|TAB|BACKSPACE. text+ENTER is submitted atomically. '
        + 'DESTRUCTIVE keys (CTRL_C, ESC) can kill/derail the worker and require BOTH confirm_destructive=true AND mesh policy allowSendKeysDestructive — otherwise refused. '
        + 'The injection is refused if the session has a pending submit/echo race, or (for non-destructive keys) an actionable approval modal. Scoped to coordinator-spawned mesh worker sessions. Each injection is audited (key enums + result; the literal text body is NOT recorded).',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            session_id: { type: 'string', description: 'Agent session ID whose PTY to inject into.' },
            sequence: {
                type: 'array',
                description: 'Ordered key sequence. Each item is {"text":"literal UTF-8"} OR {"key":"ENTER|ESC|CTRL_C|UP|DOWN|LEFT|RIGHT|TAB|BACKSPACE"}. Max 64 items, 4096 total text bytes.',
                items: {
                    type: 'object',
                    properties: {
                        text: { type: 'string', description: 'Literal UTF-8 text to type.' },
                        key: { type: 'string', enum: ['ENTER', 'ESC', 'CTRL_C', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'TAB', 'BACKSPACE'], description: 'Named key.' },
                    },
                },
            },
            confirm_destructive: { type: 'boolean', description: 'Required true when the sequence contains a destructive key (CTRL_C/ESC). Also requires mesh policy allowSendKeysDestructive.' },
            allow_modal_override: { type: 'boolean', description: 'Override the actionable-approval-modal fail-closed refusal for NON-destructive keys. Use only when you deliberately need to inject into a modal-parked session that is NOT an approval you should route through mesh_approve.' },
        },
        required: ['node_id', 'session_id', 'sequence'],
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
    description: 'Restart a mesh node\'s daemon, optionally updating it first — the same path as the dashboard "preview update" button, exposed as a mesh command so a coordinator can roll a worker daemon without a manual restart round-trip. No agent session is launched. '
        + 'mode="upgrade" (default): update to the latest published version on the release channel, then restart; already-latest is a no-op (no restart, returns alreadyLatest:true). mode="restart": pure re-spawn with no reinstall — restarts even when already latest, with much shorter downtime; use it to reset wedged daemon state (memory leaks, zombie sessions). '
        + 'Idle-gated: a node whose daemon has an active session (generating / waiting_approval / starting) is refused with code "blocking_sessions" so an in-flight turn is never interrupted. '
        + 'self_only=true waives ONLY this mesh\'s own coordinator session (the structural self-deadlock case — the coordinator is always generating while it calls). Other sessions still refuse. force=true bypasses the gate entirely: in-flight turns die and the unpersisted pendingOutboundQueue is lost. '
        + 'when_idle=true schedules the restart to run automatically once the daemon goes idle (the safest path — no queue loss); cancel_when_idle=true cancels it and every response reports the schedule under deferredRestart. '
        + 'kill_session_host=true additionally stops the session-host process, destroying ALL hosted CLI sessions (hard refresh; this is what Windows already does on every upgrade). Default off. '
        + 'Note: on Windows any daemon restart/upgrade terminates all hosted sessions regardless of options; on POSIX hosted sessions survive a plain restart and rebind on next boot. '
        + 'Upgrade mode refuses a DOWNGRADE: if the target version resolved from the daemon\'s build track is OLDER than the running daemon, the call fails with code "downgrade_refused" and reports currentVersion / targetVersion / channel instead of rolling the node back. Pass allow_downgrade=true only for a deliberate rollback. '
        + 'The channel parameter is DEPRECATED and ignored: since Phase 3 the release channel is a build-time identity of the installed binary (stable = adhdev/@latest, preview = adhdev-preview/@next), so an upgrade always targets the daemon\'s own build track and can never switch channels. When you pass a channel that conflicts with the node\'s build track, the response now carries a channelOverride object saying so — the request is not silently honored. '
        + 'The response compares meshAttachedDaemon (the daemon that answered status immediately before the command) with restartTargetDaemon (the daemon process that accepted the lifecycle operation). daemonMismatch/trackMismatch=true and trackWarning surface a split but do not block the operation; null means an older/unreachable daemon did not report enough identity.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID — the daemon that owns this node is restarted (and updated, in upgrade mode).' },
            channel: { type: 'string', enum: ['stable', 'preview'], description: 'DEPRECATED and ignored (upgrade mode only). Since Phase 3 the release channel is a build-time identity of the installed binary, so the daemon always upgrades on its own build track. Kept optional so older callers do not break. A value conflicting with the node\'s build track is reported back as channelOverride rather than silently dropped — it does NOT switch the node\'s channel.' },
            allow_downgrade: { type: 'boolean', description: 'Permit an upgrade whose resolved target is OLDER than the running daemon (upgrade mode only). Default false: such a call is refused with code "downgrade_refused" so a mis-resolved track cannot silently roll a node back. Set true only for a deliberate rollback.' },
            mode: { type: 'string', enum: ['upgrade', 'restart'], description: 'upgrade (default): update to latest on channel, then restart (already-latest is a no-op). restart: pure re-spawn, no reinstall — restarts even when already latest.' },
            force: { type: 'boolean', description: 'Bypass the idle-gate entirely. Destructive: in-flight turns are killed and the in-memory pendingOutboundQueue is permanently lost. Default false.' },
            self_only: { type: 'boolean', description: 'Waive only this mesh\'s own coordinator session when it blocks the restart (the coordinator self-deadlock). Other nodes\' active sessions still refuse. Default false.' },
            when_idle: { type: 'boolean', description: 'If blocked, schedule the restart to execute automatically once the daemon goes idle (safest — no pendingOutboundQueue loss). The schedule expires after timeout_ms (default 30 min). Default false.' },
            cancel_when_idle: { type: 'boolean', description: 'Cancel a previously scheduled when_idle restart on the owning daemon.' },
            timeout_ms: { type: 'number', description: 'Expiry for a when_idle schedule in milliseconds (default 1800000 = 30 min, max 6 h).' },
            kill_session_host: { type: 'boolean', description: 'Hard refresh: also stop the session-host process, destroying ALL hosted CLI sessions on the machine. Default false.' },
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
        + 'Create a mission before enqueueing a multi-task batch, then submit that plan as ONE mesh_enqueue_batch carrying the mission_id (a top-level mission_id applies to every entry; mesh_enqueue_task is the single-step fallback). Update status to completed/abandoned when the outcome is decided. Progress is derived from task statuses — there is no separate progress field. '
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

export const MESH_ANSWER_QUESTION_TOOL = {
    name: 'mesh_answer_question',
    description: 'Answer a multi-choice QUESTION (AskUserQuestion) a delegated agent session is waiting on. '
        + 'This is the counterpart to mesh_approve: a QUESTION (surfaced as an agent:waiting_choice event / status "awaiting_choice") is NOT a yes/no approval — '
        + 'it offers labelled options (optionally multi-select, optionally a freeform "Type something") and must be answered here, never with mesh_approve. '
        + 'Supply the promptId from the waiting_choice event and one answer per question. Each answer selects option(s) by their exact label OR 1-based index; '
        + 'for a multi-select question pass an array of selections; a freeform answer passes text instead. '
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
                description: 'One entry per question in the prompt (in question order). Each entry answers a single question by selecting option label(s)/index(es), or by supplying freeform text.',
                items: {
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
    description: 'Bootstrap a brand-new mesh for a Git repository — the first step for an MCP-only agent that has no mesh yet. '
        + 'Mirrors `adhdev mesh create <name>`. A mesh groups one repo\'s workspaces/nodes so the coordinator can delegate work across them. '
        + 'Pass workspace to auto-detect Git identity/branch/worktree metadata through the read-only planner, or explicitly pass repo_remote_url / repo_identity for backward compatibility. '
        + 'This is a persistent write: call mesh_plan_onboarding first and obtain explicit user approval before invoking it. Set add_current:true to also register a node in the same call (uses workspace if given, else the daemon\'s current working directory). '
        + 'BOOT-GATE / WHEN CALLABLE: this tool is reachable in STANDARD mode (adhdev mcp, no --repo-mesh) — the bootstrap context where no mesh exists — and also in mesh mode (where it creates a SEPARATE additional mesh). It is NOT reachable before any mesh exists via mesh mode, because `adhdev mcp --repo-mesh <id>` refuses to start without an existing meshId. So the intended flow is: run standard-mode MCP → mesh_create → mesh_add_node → then relaunch as `adhdev mcp --repo-mesh <returned mesh_id>`. '
        + 'Returns mesh_id (and node_id when add_current is used); use mesh_id for the follow-up mesh_add_node call and to launch mesh mode.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            name: { type: 'string', description: 'Human-readable mesh name (e.g. "adhdev-main"). Trimmed, max 100 chars.' },
            repo_remote_url: { type: 'string', description: 'Optional explicit Git remote URL. When omitted with repo_identity, identity is read-only auto-detected from workspace.' },
            repo_identity: { type: 'string', description: 'Optional explicit normalized repo identity. Wins over repo_remote_url; when both are omitted, workspace is auto-detected.' },
            default_branch: { type: 'string', description: 'Default branch for the repo (e.g. "main"). Optional; used as the merge/convergence target.' },
            add_current: { type: 'boolean', description: 'Also register a node in this same call (parity with CLI --add-current). Uses `workspace` if provided, otherwise the daemon\'s current working directory.' },
            workspace: { type: 'string', description: 'Absolute workspace path used for Git auto-detection and, when add_current:true, node registration. Defaults to the daemon cwd.' },
        },
        required: ['name'],
    },
};

export const MESH_PLAN_ONBOARDING_TOOL = {
    name: 'mesh_plan_onboarding',
    description: 'Read-only Git-aware Repo Mesh discovery and dry-run planning for a workspace path. '
        + 'Detects the Git root, normalized remotes/repo identity, current/default branch, main checkout vs linked worktree/common-dir metadata, dirty/conflict state, and existing mesh/node membership. '
        + 'Returns a typed create+onboarding, add-existing-workspace, or clone-new-worktree plan with suggested .adhdev configs. It never fetches, writes config, creates a mesh/node/branch/worktree, or otherwise mutates state. '
        + 'Use this before mesh_create, mesh_add_node, or mesh_clone_node; execute write steps only after explicit user approval.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            workspace: { type: 'string', description: 'Absolute path on the daemon that owns the Git checkout.' },
            mesh_id: { type: 'string', description: 'Optional existing mesh to validate against. In mesh mode defaults to the active mesh.' },
            operation: {
                type: 'string',
                enum: ['auto', 'add_existing', 'clone_worktree', 'create_mesh'],
                description: 'Planning intent. auto chooses create+onboard when no compatible mesh exists, otherwise add existing. clone_worktree requires branch and a clean source.',
            },
            branch: { type: 'string', description: 'New branch name when operation=clone_worktree.' },
        },
        required: ['workspace'],
    },
};

export const MESH_ADD_NODE_TOOL = {
    name: 'mesh_add_node',
    description: 'Register a workspace as a node in an EXISTING mesh — the second bootstrap step after mesh_create (or to add more nodes later). '
        + 'Mirrors `adhdev mesh add-node <mesh_id>` with --workspace / --read-only / --provider-priority. A node is a repo checkout on a daemon that the coordinator can launch agents on and delegate tasks to. '
        + 'mesh_id is REQUIRED in standard mode (pass the id returned by mesh_create); in mesh mode it defaults to the active mesh. workspace is the absolute path to the repo checkout ON THE DAEMON that owns it — the local base node is added by the daemon that created the mesh. '
        + 'This is a persistent mesh write: call mesh_plan_onboarding first and obtain explicit user approval. The implementation re-runs that preflight before writing. NOTE: this registers an EXISTING directory as a node (including auto-detected linked worktrees). To CREATE a fresh git worktree + branch for isolated parallel work, use mesh_clone_node instead — that runs the actual `git worktree add`. '
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
        + 'Creates a git worktree on a new branch so multiple tasks can run on separate branches simultaneously. This writes a branch, worktree and mesh node: call mesh_plan_onboarding with operation=clone_worktree and obtain explicit user approval first; the implementation re-runs the clean/source preflight. '
        + 'Call this directly when you need the worktree NOW and will target it right away. When the worktree only exists to host a plan you already know, that plan can be submitted as one mesh_enqueue_batch: declare the worktree in the top-level `workspaces` array and point its tasks at it with `workspace_ref`, so preparation happens as part of the graph instead of a manual clone followed by step-by-step enqueues.',
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
                description: 'Optional classification: provider_quirk (a provider/runtime behaves unexpectedly), pattern_to_avoid (an approach that caused problems), recovery_lesson (how a failure was recovered). Category also governs default read-side retention: recovery_lesson ages out of the injected prompt after ~14 days, pattern_to_avoid after ~30, provider_quirk and uncategorized are durable (never age out). The ledger entry is always kept for audit regardless.',
            },
            pinned: {
                type: 'boolean',
                description: 'Pin this note so it ALWAYS rides into every coordinator prompt: never dropped by TTL expiry and kept ahead of unpinned notes when the injection cap is hit. Use for durable, high-value operating knowledge you never want to lose from the prompt.',
            },
            ttl_days: {
                type: 'number',
                description: 'Optional explicit read-side lifespan in days. Resolved to an absolute expiry at record time; after it passes an UNPINNED note is hidden from the injected prompt (but retained in the ledger for audit). Overrides the category default TTL. Ignored when pinned is true.',
            },
            supersedes: {
                type: 'string',
                description: 'Optional version-supersede: the note_id of an earlier note this one replaces, OR a subject_key shared with earlier notes. At injection any earlier LIVE note matching this id/subject is hidden from the prompt (its ledger entry is retained for audit). Use when you record an updated lesson that makes a prior one obsolete. Pinned notes are never hidden by supersede.',
            },
            subject_key: {
                type: 'string',
                description: 'Optional stable subject key grouping notes about the same subject. Drives version-supersede targeting and read-side same-class folding (multiple live notes with the same category AND subject_key collapse to one injected entry, newest kept, older ids listed). When omitted, folding falls back to a leading [tag] bracket in the text.',
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
            note_id: { type: 'string', description: 'The ledger note id to retract (full/exact — no prefix matching). Returned by mesh_record_note as noteId, or visible in mesh_task_history entries. An id that does not match a live note returns success:false, code:note_not_found (the tombstone is still recorded, but nothing was actually retracted) — do not guess/truncate an id.' },
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
        + 'dry_run=true overrides execute. Matches the mesh_refine_batch / mesh_fast_forward_node dry_run/execute contract. '
        + 'Converges ONE node: to land two or more sibling worktrees that share a base branch, use mesh_refine_batch instead of calling this repeatedly — it orders the nodes conflict-aware and auto-rebases each one onto the base its predecessors advanced, which repeated single-node calls leave to you (and which can contend on the base lease as base_locked).',
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
    description: 'Bind a task_kind to its MAGI kind-panel slot list for THIS mesh (machine-local ~/.adhdev/meshes.json → `meshes[].magiKindPanels`). This binding is what a `mesh_magi_review({ task_kind })` resolves to — it is the SOLE panel-resolution path (there is no named-panel or inline-members alternative). SCOPE: PER MESH, stored machine-locally (NOT a repo-committed file). The write targets the calling coordinator\'s mesh only; another mesh on the same machine keeps its own independent binding for the same task_kind. IMPORTANT — WHOLESALE REPLACEMENT: a task_kind has exactly one binding per mesh, so the `slots` you pass become the COMPLETE new slot set and any prior slots for that kind are dropped (not merged). Because it silently replaces the current binding, get EXPLICIT user approval before writing and present the current-vs-new slot lists (the dry-run returns `currentSlots`). Defaults to dry-run (write=false). A slot\'s `nodeId`, when given, MUST name a node of this mesh — a foreign or unknown node id is rejected (invalid_magi_kind_panel).',
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
                        nodeId: { type: 'string', description: 'Optional — pin to a specific node OF THIS MESH (validated against the mesh node list; a node id from another mesh is rejected). Omit to let the fan-out pick any node offering the provider.' },
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
    description: 'List the MAGI kind→panel slot bindings configured for THIS mesh (machine-local, per mesh). Read-only. The response `scope` names the mesh the bindings belong to — panels are per mesh, so another mesh on this machine has its own independent set. Use to confirm what a `task_kind` resolves to before mesh_magi_review, and to diff current-vs-new before an overwrite via mesh_magi_kind_panel_set.',
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

export const MESH_NODE_SLOTS_PROPOSE_TOOL = {
    name: 'mesh_node_slots_propose',
    description: 'AUTO-DETECT a node\'s installed CLI agents and DRAFT a capability-slot profile from them — the "just allow it and it figures out the slots" path. READ-ONLY: it probes the node (get_status_metadata → availableProviders, filtered to category=cli + installed=true), maps each detected CLI through a seeded provider→(model/thinkingLevel/difficulty/maxParallel) table, and returns `proposedSlots` plus per-slot rationale. It NEVER writes — apply the draft with mesh_node_slots_set({ node_id, slots: proposedSlots, write: true }) after user approval. CRITICAL: slot writes are WHOLESALE replacements, so the response computes `droppedSlots` / `droppedProviders` / `destructive` — existing hand-tuned slots (capability tags, tuned maxParallel, providers not currently on PATH) are NOT preserved by the draft. Present those before approving. Detects nothing → proposes nothing (it will NOT propose an empty list that would wipe the profile). Optional include_magi drafts one cross-provider MAGI panel of the detected providers.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'REQUIRED — the mesh node id to detect installed CLI agents on and draft slots for.' },
            include_magi: { type: 'boolean', description: 'When true, also draft a MAGI panel (one slot per detected provider, pinned to this node, models unpinned) for binding via mesh_magi_kind_panel_set. Defaults false. Deliberately NOT a per-task_kind assignment — provider manifests carry no rca/design/claim_audit suitability data.' },
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

export const MESH_COORDINATOR_PROMPT_APPEND_GET_TOOL = {
    name: 'mesh_coordinator_prompt_append_get',
    description: 'Read the current user-level coordinator prompt APPEND text for a CLI type — the per-machine file at ~/.adhdev/coordinator-prompts/<cli>.append.md on this MCP server\'s daemon. Read this before mesh_coordinator_prompt_append_set so you know what you would be replacing. APPEND ONLY: this always stacks AFTER whichever base prompt wins (daemon default, or a mesh-level / user-level override) — there is no tool to read or write the OVERRIDE (base-replacing) file via MCP; that stays a dashboard-only, human-gated action by design.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            cli_type: { type: 'string', description: 'CLI type key, e.g. "claude-cli", "codex-cli". Defaults to "default" (applies to every CLI type without its own file).' },
        },
    },
};

export const MESH_COORDINATOR_PROMPT_APPEND_SET_TOOL = {
    name: 'mesh_coordinator_prompt_append_set',
    description: 'Write (or clear) the user-level coordinator prompt APPEND text for a CLI type — the per-machine file at ~/.adhdev/coordinator-prompts/<cli>.append.md on this MCP server\'s daemon. Applies to every mesh this daemon coordinates. Empty/omitted content deletes the file (reset to no append). WHOLESALE REPLACE: this replaces the entire append file, not an incremental add — read the current value first with mesh_coordinator_prompt_append_get if you want to preserve existing text. APPEND ONLY (safety boundary, not a missing feature): this can only ever add text after the base prompt; it can NEVER replace the daemon\'s base coordinator prompt (the OVERRIDE file), so a coordinator using this tool cannot erase its own core operating rules. There is no override parameter and none will be added.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            cli_type: { type: 'string', description: 'CLI type key, e.g. "claude-cli", "codex-cli". Defaults to "default".' },
            content: { type: 'string', description: 'The full append text to write. Omit or pass an empty string to clear (delete the file, falling back to no append at this layer).' },
        },
    },
};

export const ALL_MESH_TOOLS = [
    MESH_STATUS_TOOL,
    MESH_LIST_NODES_TOOL,
    // GRAPH-ORCHESTRATION Phase F — batch BEFORE task. Registry order is what a
    // client that lists tools without ranking sees first, so the default enqueue
    // surface leads and the single-task fallback follows it.
    MESH_ENQUEUE_BATCH_TOOL,
    MESH_ENQUEUE_TASK_TOOL,
    MESH_VIEW_QUEUE_TOOL,
    // GRAPH-ORCHESTRATION Phase E — placed next to the queue/enqueue tools so a
    // coordinator that loaded the batch schema also discovers how to pass a gate.
    MESH_GRAPH_VIEW_TOOL,
    MESH_GRAPH_GATE_CLAIM_TOOL,
    MESH_GRAPH_GATE_RELEASE_TOOL,
    MESH_GRAPH_GATE_ABANDON_TOOL,
    MESH_QUEUE_CANCEL_TOOL,
    MESH_QUEUE_REQUEUE_TOOL,
    MESH_SEND_TASK_TOOL,
    MESH_READ_CHAT_TOOL,
    MESH_READ_DEBUG_TOOL,
    MESH_READ_TERMINAL_TOOL,
    MESH_SEND_KEYS_TOOL,
    MESH_LAUNCH_SESSION_TOOL,
    MESH_GIT_STATUS_TOOL,
    MESH_READ_NODE_LOGS_TOOL,
    MESH_FAST_FORWARD_NODE_TOOL,
    MESH_RESTART_DAEMON_TOOL,
    MESH_CHECKPOINT_TOOL,
    MESH_APPROVE_TOOL,
    MESH_ANSWER_QUESTION_TOOL,
    MESH_LIST_PENDING_APPROVALS_TOOL,
    MESH_PLAN_ONBOARDING_TOOL,
    MESH_CREATE_TOOL,
    MESH_ADD_NODE_TOOL,
    MESH_CLONE_NODE_TOOL,
    MESH_REMOVE_NODE_TOOL,
    MESH_CLEANUP_WORKTREE_NODES_TOOL,
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
    MESH_NODE_SLOTS_PROPOSE_TOOL,
    MESH_COORDINATOR_PROMPT_APPEND_GET_TOOL,
    MESH_COORDINATOR_PROMPT_APPEND_SET_TOOL,
];
