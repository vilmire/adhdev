/**
 * MCP tool schemas — queue domain (mesh-tools-queue.ts / mesh-tools-queue-manage.ts
 * handlers): enqueue task / batch with their discovery metadata, and queue view /
 * cancel / requeue. Pure data; ALL_MESH_TOOLS in mesh-tool-schemas.ts is the registry.
 */
import { MESH_TASK_INPUT_SCHEMA } from './mesh-tool-input-schemas.js';
import { enumOf, MESH_TASK_MODES, MESH_TASK_PRIORITIES, MESH_THINKING_LEVELS, MESH_TASK_DIFFICULTIES } from '@adhdev/mesh-shared';

/**
 * Enqueue discovery metadata.
 *
 * Carried under MCP's spec-sanctioned `_meta` record (ToolSchema declares
 * `_meta: z.record(z.string(), z.unknown()).optional()`), so a client that does not
 * understand these hints simply ignores them and the published tool list stays
 * protocol-valid. Two independent mechanisms, both defense in depth behind the
 * prompt rule in coordinator-prompt.ts:
 *
 *   `discoveryKeywords` — both tools share the same query vocabulary, so a search
 *     for "enqueue"/"delegate"/"task"/"dependency" matches BOTH. Without the
 *     shared vocabulary a search for "enqueue" could match only the tool whose name
 *     contains it, which is exactly how the fallback got selected alone.
 *   `discoveryRank` — LOWER sorts first. Task is 0 and batch is 10 for the
 *     `enqueue`/`delegate` queries listed in `discoveryRankQueries`, so a ranked
 *     client returns the incremental default (`mesh_enqueue_task` + `depends_on`)
 *     as the first candidate; batch is the several-steps-at-once convenience,
 *     and the shared vocabulary below still surfaces it alongside.
 *   `toolGroup: 'mesh.enqueue'` + `toolGroupMembers` — providers that support tool
 *     groups expose the siblings together, so loading the fallback also exposes
 *     batch. The group is declared identically on both members.
 *
 * This is NOT an enforcement layer: nothing here rejects a single enqueue.
 */
const ENQUEUE_TOOL_GROUP = 'mesh.enqueue';
const ENQUEUE_TOOL_GROUP_MEMBERS = ['mesh_enqueue_task', 'mesh_enqueue_batch'] as const;
const ENQUEUE_DISCOVERY_KEYWORDS = ['enqueue', 'delegate', 'task', 'dependency'] as const;
/** Queries for which the incremental default must outrank the batch. */
const ENQUEUE_RANK_QUERIES = ['enqueue', 'delegate'] as const;

const ENQUEUE_BATCH_DISCOVERY_META = {
    toolGroup: ENQUEUE_TOOL_GROUP,
    toolGroupMembers: ENQUEUE_TOOL_GROUP_MEMBERS,
    discoveryKeywords: ENQUEUE_DISCOVERY_KEYWORDS,
    discoveryRankQueries: ENQUEUE_RANK_QUERIES,
    discoveryRank: 10,
    enqueueRole: 'multi_enqueue',
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
 * The enqueue schema diet.
 *
 *  - ONE canonical snake_case name per field. The camelCase / alternate spellings
 *    (dependsOn, missionId, targetNode, read_only, …) are NOT published any more, but
 *    the pre-dispatch validator still ACCEPTS them silently — see
 *    `MESH_ACCEPTED_ARG_ALIASES` in validate-tool-args.ts — and the handlers keep
 *    reading both spellings, so existing coordinators do not break.
 *  - The retired graph-orchestration fields (gates, workspaces, inputs_from,
 *    run_if, …) are REJECTED by the validator with a pointer at depends_on
 *    (`MESH_RETIRED_ARGS`).
 *  - Descriptions are size-capped: task ≤ 4 KB, batch ≤ 6 KB of JSON
 *    (mesh-enqueue-schema-diet.test.ts pins both ceilings).
 */
export const MESH_ENQUEUE_TASK_TOOL = {
    name: 'mesh_enqueue_task',
    description: 'Enqueue ONE worker task; an idle node claims it. The default way to delegate: when a step needs queued work to finish first, pass depends_on with those task ids — '
        + 'grow the plan as results arrive. '
        + 'mesh_enqueue_batch enqueues several such tasks at once. Same-session continuation belongs in mesh_send_task. '
        + 'Warns when an in-flight task has the same message+target.',
    _meta: ENQUEUE_TASK_DISCOVERY_META,
    inputSchema: {
        type: 'object' as const,
        properties: {
            message: { type: 'string', description: 'The task instruction.' },
            input: MESH_TASK_INPUT_SCHEMA,
            task_mode: { ...enumOf(MESH_TASK_MODES), description: 'live_debug_readonly lints the instruction TEXT and rejects write/push/deploy wording before dispatch, and may run in parallel on a busy node (cheap for investigation). '
                + 'It does NOT remove the worker\'s Edit/Write/Bash tools — the worker stays read-only only if it follows the instruction; verify with mesh_git_status afterward.' },
            readonly: { type: 'boolean', description: 'Read-only axis, composable with task_mode: separate parallel cap, no write isolation, exempt from the per-node write limit and the dirty/stale gates. '
                + 'Instruction text is linted; the worker\'s own tools are NOT restricted.' },
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
        },
        required: ['message', 'difficulty'],
    },
};

export const MESH_ENQUEUE_BATCH_TOOL = {
    name: 'mesh_enqueue_batch',
    description: 'Enqueue several mesh_enqueue_task tasks at once, atomically: all insert or none do (any invalid entry rolls back the batch). '
        + 'Entries name each other by batch-local `ref` in depends_on (forward refs OK; a non-ref value must be an existing task id). '
        + 'Never invent steps to fill a batch — when later steps are not known yet, chain mesh_enqueue_task with depends_on as results arrive.',
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
                        ref: { type: 'string', description: 'Batch-local label for depends_on.' },
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
                    },
                    required: ['message', 'difficulty'],
                },
            },
            mission_id: { type: 'string', description: 'Mission for every entry without its own (full, exact); unknown id rejects the batch.' },
            block_duplicate: { type: 'boolean', description: 'Refuse the whole batch on a duplicate instead of warning.' },
            allow_duplicate: { type: 'boolean', description: 'Skip duplicate detection.' },
        },
        required: ['tasks'],
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
