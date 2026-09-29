/**
 * MCP tool schemas — queue and graph domain (mesh-tools-queue.ts / mesh-tools-graph.ts
 * handlers): enqueue task / batch with their discovery metadata, graph view / gate /
 * node patch, and queue view / cancel / requeue. Pure data; ALL_MESH_TOOLS in
 * mesh-tool-schemas.ts is the registry.
 */
import { MESH_TASK_INPUT_SCHEMA, MESH_INPUT_BINDING_SCHEMA } from './mesh-tool-input-schemas.js';
import { enumOf, MESH_TASK_MODES, MESH_TASK_PRIORITIES, MESH_THINKING_LEVELS, MESH_TASK_DIFFICULTIES } from '@adhdev/mesh-shared';

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
 *   `discoveryRank` — LOWER sorts first. Task is 0 and batch is 10 for the
 *     `enqueue`/`delegate` queries listed in `discoveryRankQueries`, so a ranked
 *     client returns the incremental default (`mesh_enqueue_task` + `depends_on`)
 *     as the first candidate. graph-orchestration-simplification D1 (2026-09-25)
 *     reversed Phase F's batch-first ranking: batch is the settled-plan
 *     exception, and the shared vocabulary below still surfaces it alongside.
 *   `toolGroup: 'mesh.enqueue'` + `toolGroupMembers` — providers that support tool
 *     groups expose the siblings together, so loading the fallback also exposes
 *     batch. The group is declared identically on both members.
 *
 * This is NOT an enforcement layer: nothing here rejects a single enqueue, and
 * `batch_required` is not implemented (Phase F is warn-only by design).
 */
const ENQUEUE_TOOL_GROUP = 'mesh.enqueue';
const ENQUEUE_TOOL_GROUP_MEMBERS = ['mesh_enqueue_task', 'mesh_enqueue_batch'] as const;
const ENQUEUE_DISCOVERY_KEYWORDS = ['enqueue', 'delegate', 'task', 'graph', 'dependency'] as const;
/** Queries for which the incremental default must outrank the settled-plan batch. */
const ENQUEUE_RANK_QUERIES = ['enqueue', 'delegate'] as const;

const ENQUEUE_BATCH_DISCOVERY_META = {
    toolGroup: ENQUEUE_TOOL_GROUP,
    toolGroupMembers: ENQUEUE_TOOL_GROUP_MEMBERS,
    discoveryKeywords: ENQUEUE_DISCOVERY_KEYWORDS,
    discoveryRankQueries: ENQUEUE_RANK_QUERIES,
    discoveryRank: 10,
    enqueueRole: 'settled_plan',
} as const;

const ENQUEUE_TASK_DISCOVERY_META = {
    toolGroup: ENQUEUE_TOOL_GROUP,
    toolGroupMembers: ENQUEUE_TOOL_GROUP_MEMBERS,
    discoveryKeywords: ENQUEUE_DISCOVERY_KEYWORDS,
    discoveryRankQueries: ENQUEUE_RANK_QUERIES,
    discoveryRank: 0,
    enqueueRole: 'default',
} as const;

/**
 * graph-orchestration-simplification D2 (2026-09-25)
 * — the enqueue schema diet.
 *
 *  - ONE canonical snake_case name per field. The camelCase / alternate spellings
 *    (dependsOn, missionId, targetNode, read_only, …) are NOT published any more, but
 *    the pre-dispatch validator still ACCEPTS them silently — see
 *    `MESH_ACCEPTED_ARG_ALIASES` in validate-tool-args.ts — and the handlers keep
 *    reading both spellings, so existing coordinators do not break.
 *  - `run_if` / `on_false` / `on_upstream_skip` are retired at the surface: the
 *    validator REJECTS them with a pointer at depends_on + on_dependency_failure
 *    (`MESH_RETIRED_ARGS`). The daemon engine keeps its evaluator for now.
 *  - Descriptions are size-capped: task ≤ 4 KB, batch ≤ 6 KB of JSON
 *    (mesh-enqueue-schema-diet.test.ts pins both ceilings).
 */
export const MESH_ENQUEUE_TASK_TOOL = {
    name: 'mesh_enqueue_task',
    description: 'Enqueue ONE worker task; an idle node claims it. The default way to delegate: when a step needs queued work to finish first, pass depends_on with those task ids — '
        + 'grow the plan as results arrive. '
        + 'Use mesh_enqueue_batch only for a settled plan of 3+ steps that needs coordinator gates or deferred worktrees. Same-session continuation belongs in mesh_send_task. '
        + 'Warns when an in-flight task has the same message+target.',
    _meta: ENQUEUE_TASK_DISCOVERY_META,
    inputSchema: {
        type: 'object' as const,
        properties: {
            message: { type: 'string', description: 'The task instruction.' },
            input: MESH_TASK_INPUT_SCHEMA,
            task_mode: { ...enumOf(MESH_TASK_MODES), description: 'live_debug_readonly rejects write/push/deploy instructions and may run in parallel on a busy node (cheap for investigation).' },
            readonly: { type: 'boolean', description: 'Read-only, composable with task_mode: no write isolation; write instructions rejected.' },
            required_tags: { type: 'array', items: { type: 'string' }, description: 'Capability tags every eligible node must have, e.g. os=darwin, provider=codex-cli.' },
            owned_paths: { type: 'array', items: { type: 'string' }, description: 'code_change only: repo-relative files/dirs this task will touch (dir/** = subtree). A claim overlapping another in-flight code_change task\'s paths is refused (owned_paths_conflict).' },
            target_node_id: { type: 'string', description: 'HARD pin: only this node may claim. Beats prefer_worktree; unresolvable id rejected.' },
            prefer_worktree: { type: 'boolean', description: 'Route to the most recently cloned idle worktree node (no-op if none).' },
            depends_on: { type: 'array', items: { type: 'string' }, description: 'Task ids that must complete first; their completion summaries are appended ("Upstream results"). Cycles rejected.' },
            mission_id: { type: 'string', description: 'Mission id (full, exact); an unknown id is rejected (mission_not_found).' },
            priority: { ...enumOf(MESH_TASK_PRIORITIES), description: 'high jumps older normal/low work; default normal.' },
            model: { type: 'string', description: 'Model override, e.g. opus (best-effort).' },
            thinking_level: { ...enumOf(MESH_THINKING_LEVELS), description: 'Reasoning effort (best-effort).' },
            difficulty: { ...enumOf(MESH_TASK_DIFFICULTIES), description: 'REQUIRED routing hint matched to node capability slots (the slot\'s model launches). Classify by real difficulty.' },
            not_before: { type: ['number', 'string'], description: 'Hold pending until: epoch-ms, relative ms, or ISO-8601.' },
            max_retries: { type: 'number', description: 'Requeues before auto-fail.' },
            block_duplicate: { type: 'boolean', description: 'Refuse (duplicate_suspect) instead of warning on a duplicate.' },
            allow_duplicate: { type: 'boolean', description: 'Skip duplicate detection.' },
            // design :692 — "The single tool should require an orchestration_decision".
            // OPTIONAL here on purpose (D1 of the simplification design): a required
            // field would break legacy/external clients. An omitted record degrades to
            // decision_missing, which is itself the signal — never an enqueue failure.
            orchestration_decision: {
                type: 'object',
                description: 'Optional provenance: {decision, known_graph_steps, single_reason, capability_blockers}. '
                    + 'single_reason: only_one_step_known | future_step_not_specifiable | same_session_continuation | legacy_client | operator_override. '
                    + 'output_needed / workspace_unresolved / coordinator_action_between are not blockers (batch covers them).',
            },
        },
        required: ['message', 'difficulty'],
    },
};

export const MESH_ENQUEUE_BATCH_TOOL = {
    name: 'mesh_enqueue_batch',
    description: 'Atomically enqueue a SETTLED plan. Use only when 3+ steps are already known AND they need coordinator gates or deferred worktrees (workspace_ref); otherwise chain mesh_enqueue_task with depends_on. Never invent steps to fill a batch. '
        + 'All tasks insert or none do (any invalid entry rolls back the batch). Entries name each other by batch-local `ref` in depends_on (forward refs OK; a non-ref value must be an existing task id). '
        + 'Worktree preparation is a compensated saga and is reported separately from DB atomicity. Inspect with mesh_graph_view.',
    _meta: ENQUEUE_BATCH_DISCOVERY_META,
    inputSchema: {
        type: 'object' as const,
        properties: {
            tasks: {
                type: 'array',
                description: 'Tasks (max 50). Fields mean the same as in mesh_enqueue_task.',
                items: {
                    type: 'object',
                    properties: {
                        ref: { type: 'string', description: 'Batch-local label for depends_on / inputs_from.' },
                        message: { type: 'string' },
                        input: { type: 'object' },
                        task_mode: enumOf(MESH_TASK_MODES),
                        readonly: { type: 'boolean' },
                        required_tags: { type: 'array', items: { type: 'string' } },
                        owned_paths: { type: 'array', items: { type: 'string' }, description: 'code_change path ownership, as in mesh_enqueue_task.' },
                        target_node_id: { type: 'string', description: 'HARD pin; an unresolvable id rejects the batch.' },
                        prefer_worktree: { type: 'boolean' },
                        depends_on: { type: 'array', items: { type: 'string' }, description: 'Sibling refs and/or existing task ids that must complete first.' },
                        mission_id: { type: 'string', description: 'Overrides the top-level mission_id.' },
                        priority: enumOf(MESH_TASK_PRIORITIES),
                        model: { type: 'string' },
                        thinking_level: enumOf(MESH_THINKING_LEVELS),
                        difficulty: { ...enumOf(MESH_TASK_DIFFICULTIES), description: 'REQUIRED routing hint.' },
                        not_before: { type: ['number', 'string'] },
                        max_retries: { type: 'number' },
                        // ── graph fields (design :568-570). All optional; a batch using
                        //    none of them takes the unchanged compatibility path. ──
                        inputs_from: {
                            type: 'array',
                            description: 'Bind predecessor outputs (JSON Pointer) into this task as untrusted evidence; validated at acceptance. Only when an exact field is needed.',
                            items: MESH_INPUT_BINDING_SCHEMA,
                        },
                        workspace_ref: { type: 'string', description: 'Run in a `workspaces` worktree prepared later; the task waits until it is ready, then is pinned to it.' },
                        gated_by: { type: 'array', items: { type: 'string' }, description: 'Gate refs that must be RELEASED first. Never put a gate ref in depends_on (rejected).' },
                    },
                    required: ['message', 'difficulty'],
                },
            },
            gates: {
                type: 'array',
                description: 'Coordinator gates: stop until YOU claim (mesh_graph_gate action=claim), act, and release (action=release); never auto-passed. Refs share one namespace with tasks/workspaces.',
                items: {
                    type: 'object',
                    properties: {
                        ref: { type: 'string' },
                        action: { type: 'string', enum: ['refinery', 'approval', 'ci_wait', 'publish', 'deploy', 'custom'], description: 'Label only; never executed.' },
                        instructions: { type: 'string', description: 'What to do when the gate opens.' },
                        depends_on: { type: 'array', items: { type: 'string' }, description: 'Refs that must complete before the gate opens.' },
                        on_timeout: { type: 'string', enum: ['hold', 'cancel_downstream', 'fail_graph'], description: 'At the deadline. Default hold; never auto-releases.' },
                        deadline_seconds: { type: 'number', description: 'Seconds after opening until on_timeout fires.' },
                        lease_seconds: { type: 'number', description: 'Default claim lease.' },
                        eligible_coordinator_session_id: { type: 'string', description: 'Restrict claiming to one coordinator session.' },
                    },
                    required: ['ref'],
                },
            },
            workspaces: {
                type: 'array',
                description: 'Worktrees prepared LATER for tasks naming them in workspace_ref (outside the DB transaction).',
                items: {
                    type: 'object',
                    properties: {
                        ref: { type: 'string' },
                        source_node_id: { type: 'string', description: 'Node whose workspace is cloned.' },
                        purpose: { type: 'string', description: 'Folded into the branch name.' },
                        base_revision: { type: 'string' },
                        desired_path: { type: 'string' },
                        cleanup_on_graph_failure: { type: 'boolean', description: 'Remove the worktree this graph created if the graph fails.' },
                    },
                    required: ['ref'],
                },
            },
            batch_id: { type: 'string', description: 'Idempotency key: same id + same plan replays as a no-op; a different plan is rejected.' },
            orchestration_decision: { type: 'object', description: 'Optional provenance record; never changes execution.' },
            mission_id: { type: 'string', description: 'Mission for every entry without its own (full, exact); unknown id rejects the batch.' },
            block_duplicate: { type: 'boolean', description: 'Refuse the whole batch on a duplicate instead of warning.' },
            allow_duplicate: { type: 'boolean', description: 'Skip duplicate detection.' },
            on_dependency_failure: {
                type: 'string',
                enum: ['block', 'cancel'],
                description: 'On a failed/cancelled dependency: block (default; recovers if the predecessor is retried and completes) or cancel the dependent branch.',
            },
        },
        required: ['tasks'],
    },
};

// ── GRAPH-ORCHESTRATION Phase E: the coordinator gate + graph view surface ──
// design :759-763 (view), :407-421 (claim/release), :425-439 (timeout policy).

// 2026-09-26 tool consolidation: claim / release / abandon / extend were four
// verbs on one object (a coordinator gate) spread over three tools plus an
// extend-only flag on claim. They are one tool now, selected by `action`; the
// per-action argument sets are enforced by validate-tool-args.ts
// (MESH_TOOL_ACTIONS), so an argument that belongs to another action is refused
// with a message naming the action it belongs to instead of being ignored.
export const MESH_GRAPH_GATE_TOOL = {
    name: 'mesh_graph_gate',
    description: 'Drive a coordinator GATE — a graph step that intentionally STOPS progress until you do something the daemon must not do itself (a Refinery landing, an approval, waiting on CI, a publish, a deploy). '
        + 'The daemon NEVER performs a gate action and NEVER auto-passes a gate. Use it when a gate notice arrives or mesh_graph_view shows a gate blocking downstream work. Select the verb with `action` (REQUIRED); each action accepts only its own arguments (see each property\'s description for which):\n'
        + '• claim — take the lease on a gate awaiting a coordinator. Returns a monotonically increasing leaseGeneration and an opaque fencingToken: keep both, release needs them. '
        + 'A lapsed lease can be taken over at a HIGHER generation; the response then sets ambiguousExternalOutcome — the previous owner may already have performed the side effect, so reconcile external evidence (did the merge/publish land?) before doing it again.\n'
        + '• release — pass a gate you hold: the ONLY way a gate lets downstream run. Needs lease_generation + fencing_token from claim (stale generation / wrong token → stale_fence; an EXPIRED lease never releases — re-claim and reconcile first) and your own idempotency_key '
        + '(identical re-send = no-op success; same key, different payload = conflict). `outcome` and any `result`/`evidence` are readable downstream through run_if and inputs_from. A validation failure rolls the WHOLE release back.\n'
        + '• abandon — give up on a gate that can never open (the work behind it was cancelled) so its graph can go terminal. NOT a pass: it materializes nothing and CANCELS every downstream task the gate held. '
        + 'Needs no fencing token, but a LIVE lease held by another coordinator is refused unless force=true. Re-abandoning is a no-op; a RELEASED gate can never be abandoned.\n'
        + '• extend — push the gate DEADLINE out without taking a lease (e.g. extend_seconds=86400 for a gate that expired, or is about to, under on_timeout=hold, that you still intend to act on).',
    inputSchema: {
        type: 'object' as const,
        properties: {
            action: {
                type: 'string',
                enum: ['claim', 'release', 'abandon', 'extend'],
                description: 'Which gate verb to run (required). Each action accepts only its own arguments — see the tool description.',
            },
            gate_id: { type: 'string', description: 'The gate (from mesh_graph_view, a gate notice, or the mesh_enqueue_batch response). All actions.' },
            lease_seconds: { type: 'number', description: 'claim: how long to hold the lease. Defaults to the gate spec\'s lease_seconds, then 900s. Cover the real action — a lapsed lease cannot release (elapsed time is never completion evidence).' },
            extend_deadline_seconds: { type: 'number', description: 'claim: also push the gate DEADLINE out by this many seconds from now. The deadline is when on_timeout (hold / cancel_downstream / fail_graph) fires; reclaiming a gate that expired under hold does NOT refresh it unless you pass this.' },
            extend_seconds: { type: 'number', description: 'extend: push the deadline out by this many seconds (positive). Takes NO lease. Extending only delays on_timeout; it is never completion evidence.' },
            fencing_token: { type: 'string', description: 'release: the opaque token returned by claim. Required for release.' },
            lease_generation: { type: 'number', description: 'release: the leaseGeneration returned by claim. Required for release — a stale generation is refused.' },
            idempotency_key: { type: 'string', description: 'release: your own key for this release. Required for release.' },
            outcome: { type: 'string', description: 'release: passed | failed | rejected, or an action-specific label. Downstream run_if reads it as /gate_outcome. Required for release.' },
            result: { type: 'object', description: 'release: optional action-specific structured result, exposed downstream as /result/... (e.g. the merged commit sha).' },
            evidence: { type: 'object', description: 'release: optional evidence references/digests, exposed downstream as /evidence/... .' },
            patches: {
                type: 'array',
                description: 'release: optional pre-assignment patches to DIRECT downstream nodes. Only run_if, on_false, inputs_from and workspace_ref may be patched — message, routing, permissions, task mode and model are immutable, and a claimed task cannot be patched.',
                items: {
                    type: 'object',
                    properties: {
                        node: { type: 'string', description: 'Ref or node id of a DIRECT downstream node of this gate. node_id/ref are equivalent aliases (nodeId, camelCase, is also accepted though not published) — any one resolves the target; an entry naming none of them is REJECTED (the whole release refuses) rather than silently dropped.' },
                        node_id: { type: 'string', description: 'Alias for node.' },
                        ref: { type: 'string', description: 'Alias for node — the batch-local ref of the downstream node.' },
                        base_spec_patch: { type: 'object', description: 'Keys to merge into that node\'s spec. Allowed keys: run_if, on_false, inputs_from, workspace_ref.' },
                    },
                    required: ['node'],
                },
            },
            reason: { type: 'string', description: 'abandon: why the gate is given up — recorded on the gate, every cancelled downstream row, and the provenance ledger. Required for abandon.' },
            force: { type: 'boolean', description: 'abandon: abandon even though another coordinator holds a LIVE lease. Only when you know that holder is dead.' },
            coordinator_session_id: { type: 'string', description: 'claim / abandon: owner (claim) or recorded abandoner. Defaults to this coordinator session.' },
        },
        required: ['action', 'gate_id'],
    },
};

export const MESH_GRAPH_NODE_PATCH_TOOL = {
    name: 'mesh_graph_node_patch',
    description: 'Fix a graph node that could NOT be materialized, and retry it in the same call — the recovery path for a task blocked on `materialization_error:*` (seen in mesh_graph_view / as the task\'s blockedReason). '
        + 'A node\'s `inputs_from` / `run_if` are baked in when the batch is accepted but only resolved once every predecessor has COMPLETED, so a binding that cannot be resolved strands the step; the graph retries it automatically but it re-reads the same spec and fails identically every time — it cannot heal itself, so use this to change the spec. '
        + 'The patch and the retry are ONE transaction: the response tells you immediately whether the node materialized (recovered: true) or is still blocked, and with which new reason. '
        + '★ Only run_if, on_false, inputs_from and workspace_ref may be patched — message, routing, permissions, task mode and model are immutable, and a task that is already claimed or finished cannot be patched at all (cancel and enqueue a corrected step instead). This is a repair tool, not a way to re-task a worker. '
        + 'Most shape errors are now rejected up front by mesh_enqueue_batch; the case that still needs this is `required_input_missing` — a well-formed binding whose source never produced that field.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node: { type: 'string', description: 'Node id or `ref` of the node to patch (from mesh_graph_view). A ref that matches several live graphs is refused — pass graph_id too, or the exact node id.' },
            node_id: { type: 'string', description: 'Alias for node (nodeId, camelCase, is also accepted though not published).' },
            ref: { type: 'string', description: 'Alias for node, spelled `ref` to match mesh_graph_view\'s own field name for a node\'s human-readable ref. A ref that matches several live graphs is refused — pass graph_id too, or the exact node id.' },
            graph_id: { type: 'string', description: 'Disambiguate which graph the ref belongs to. Optional when `node` is a node id.' },
            base_spec_patch: {
                type: 'object',
                description: 'Keys to REPLACE on the node\'s spec. Allowed: run_if, on_false, inputs_from, workspace_ref. A replacement inputs_from is validated before anything is written, '
                    + 'so swapping one malformed binding for another is rejected outright rather than silently re-blocking the node.',
                properties: {
                    inputs_from: { type: 'array', description: 'Replacement bindings — same shape as in mesh_enqueue_batch.', items: MESH_INPUT_BINDING_SCHEMA },
                    run_if: { type: 'object', description: 'Replacement condition.' },
                    on_false: { type: 'string', enum: ['skip'], description: 'What to do when run_if is false.' },
                    workspace_ref: { type: 'string', description: 'Replacement workspace ref.' },
                },
            },
        },
        required: ['node', 'base_spec_patch'],
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
            batch_id: { type: 'string', description: 'Show the graph committed under this batch_id.' },
            include_terminal: { type: 'boolean', description: 'Include completed/failed/cancelled graphs. Default false (in-flight only).' },
            probe_gate_evidence: { type: 'boolean', description: 'Attach convergence evidence to waiting gates: whether each upstream commit is already reachable from the mesh base workspace\'s local origin/main. Answers "did the guarded work already land?" without claiming. Runs bounded local git probes (first 5 waiting gates, no fetch) — default false keeps the view git-free. Evidence never releases a gate.' },
            limit: { type: 'integer', minimum: 0, description: 'Max graphs to return (default 20).' },
        },
    },
};

export const MESH_VIEW_QUEUE_TOOL = {
    name: 'mesh_view_queue',
    description: 'View the mesh work queue with source-of-truth active counts separated from historical completed/failed/cancelled records. Do not repeatedly call this to wait for generating assigned work; wait for pendingCoordinatorEvents/completion events or an explicit user status request.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            refresh: { type: 'boolean', description: 'Ask the coordinator to nudge members whose held runtime is old to push now (never a read of a member; the answer is still the held state). Default false.' },
            status: {
                type: 'array',
                items: { type: 'string' },
                description: 'Explicit row filter by task status: pending, assigned, completed, failed, cancelled. Overall counts stay unfiltered; the visible* counts and visibleSummary (compact mode: only when a view or status filter is applied) describe the returned rows.',
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
