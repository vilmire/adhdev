import { STAGE_REVIEW_RECOVERY_SCHEMA } from './mesh-tools-review-recovery.js';
/**
 * MCP tool schemas — queue domain (mesh-tools-queue.ts / mesh-tools-queue-manage.ts
 * handlers): enqueue task / batch with their discovery metadata, and queue view /
 * cancel / requeue. Pure data; ALL_MESH_TOOLS in mesh-tool-schemas.ts is the registry.
 */
import { MESH_TASK_INPUT_SCHEMA } from './mesh-tool-input-schemas.js';
import { enumOf, STAGE_DECIDE_ACTIONS, CANCEL_REASONS, MESH_TASK_MODES, MESH_TASK_PRIORITIES, MESH_THINKING_LEVELS, MESH_TASK_DIFFICULTIES } from '@adhdev/mesh-shared';

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
        + 'grow the plan as results arrive. Omit provider/model/thinking for ordinary new tasks; classify difficulty honestly. Node targeting is branch affinity only. Provider pins are honored with warnings. '
        + 'mesh_enqueue_batch enqueues several such tasks at once. Same-session continuation belongs in mesh_send_task. '
        + 'Warns on in-flight duplicates.',
    _meta: ENQUEUE_TASK_DISCOVERY_META,
    inputSchema: {
        type: 'object' as const,
        properties: {
            message: { type: 'string', description: 'The task instruction.' },
            input: MESH_TASK_INPUT_SCHEMA,
            task_mode: { ...enumOf(MESH_TASK_MODES), description: 'live_debug_readonly lints instruction TEXT (rejects write/push/deploy wording). Does NOT remove worker tools — verify with mesh_git_status.' },
            readonly: { type: 'boolean', description: 'Read-only axis, composable with task_mode: own parallel cap, no write isolation, exempt from node write limit and dirty/stale gates. '
                + 'Text is linted; worker tools NOT restricted.' },
            required_tags: { type: 'array', items: { type: 'string' }, description: 'Capability constraints, e.g. os=darwin; omit provider= unless pinning.' },
            owned_paths: { type: 'array', items: { type: 'string' }, description: 'code_change only: repo-relative files/dirs this task will touch (dir/** = subtree). Overlap with in-flight tasks refused (owned_paths_conflict).' },
            light: { type: 'boolean', description: 'Temp workspace on the coordinator machine; needs owned_paths. Land via mesh_light_land.' },
            target_node_id: { type: 'string', description: 'HARD pin: only this node may claim; unknown id rejected.' },
            prefer_worktree: { type: 'boolean', description: 'Route to the newest idle worktree node.' },
            depends_on: { type: 'array', items: { type: 'string' }, description: 'Task ids that must finish first; summaries appended. Cycles rejected.' },
            input_artifact_ids: { type: 'array', items: { type: 'string' }, description: 'Artifact ids this task may read (any mission).' },
            inherit_artifacts: { type: 'boolean', description: 'Default true: mission tasks also get the ≤12 newest earlier same-mission artifacts; false = off.' },
            review: { type: ['boolean', 'object'], description: 'In-task review; default on for medium/difficult code_change. false=off.' },
            mission_id: { type: 'string', description: 'Full mission id; unknown id rejected.' },
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
        + 'Default to automatic routing: omit provider/model/thinking overrides unless intentional. Node targeting is affinity only; explicit provider pins return per-task informational warnings. Never invent steps to fill a batch — when later steps are not known yet, chain mesh_enqueue_task with depends_on as results arrive.',
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
                        required_tags: { type: 'array', items: { type: 'string' }, description: 'Omit provider= for automatic routing; node/worktree affinity does not pin a provider.' },
                        owned_paths: { type: 'array', items: { type: 'string' }, description: 'code_change path ownership, as in mesh_enqueue_task.' },
                        target_node_id: { type: 'string', description: 'HARD pin; an unresolvable id rejects the batch.' },
                        prefer_worktree: { type: 'boolean' },
                        depends_on: { type: 'array', items: { type: 'string' }, description: 'Sibling refs and/or existing task ids that must complete first.' },
                        input_artifact_ids: { type: 'array', items: { type: 'string' }, description: 'Artifact ids this task may read (any mission).' },
                        inherit_artifacts: { type: 'boolean', description: 'As mesh_enqueue_task: false opts out of same-mission artifact auto-inherit.' },
                        review: { type: ['boolean', 'object'], description: 'As mesh_enqueue_task: review-in-task option (default on for medium/difficult code_change).' },
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
    description: 'View the mesh work queue with source-of-truth active counts separated from historical completed/blocked/failed/cancelled records. Do not repeatedly call this to wait for generating assigned work; wait for pendingCoordinatorEvents/completion events or an explicit user status request.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            refresh: { type: 'boolean', description: 'Ask the coordinator to nudge members whose held runtime is old to push now (never a read of a member; the answer is still the held state). Default false.' },
            status: {
                type: 'array',
                items: { type: 'string' },
                description: 'Explicit row filter by task status: pending, assigned, completed, blocked, failed, cancelled. Overall counts stay unfiltered; the visible* counts and visibleSummary (compact mode: only when a view or status filter is applied) describe the returned rows.',
            },
            view: {
                type: 'string',
                enum: ['all', 'active', 'historical'],
                description: 'Optional row view. active returns pending/assigned rows, historical returns completed/blocked/failed/cancelled rows, all returns every persisted queue row. Defaults to all for compatibility.',
            },
            compact: { type: 'boolean', description: 'Slim payload for LLM callers. Default true. Drops large historical (completed/blocked/failed/cancelled) queue row arrays, the full staleDirectWork orphan array (kept as staleDirectWorkSummary counts), and per-row maintenance cleanupCandidates in favor of counts; pending/assigned active rows are retained. Set false (or verbose=true) for the full dashboard-grade payload.' },
            include_stage_children: { type: 'boolean', description: 'List review-in-task review children as separate rows (default: folded under the parent, which carries a `stage` summary).' },
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

export const MESH_TASK_STAGE_DECIDE_TOOL = {
    name: 'mesh_task_stage_decide',
    description: 'Decide a BLOCKED review-in-task stage task (blocked reason review_unresolved | review_rejected_approach | review_unavailable | self_check_failed | stage_pipeline_ceiling). accept = take the current head as done (unresolved findings stay on record); revise_once = one more revise round; rereview = review again with a different reviewer; abandon = cancel it. Without recovery, only for blocked stage tasks. With action=rereview and versioned recovery, repair ONE existing pending never-started child by owner answer and parent/child CAS; only difficult→medium. Dry-run first; no automatic dispatch.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            task_id: { type: 'string', description: 'The blocked stage (parent) task id.' },
            action: enumOf(STAGE_DECIDE_ACTIONS),
            recovery: STAGE_REVIEW_RECOVERY_SCHEMA,
            note: { type: 'string', description: 'Optional reason, recorded with the decision.' },
        },
        required: ['task_id', 'action'],
    },
};

export const MESH_DIRECT_CANCEL_TOOL = {
    name: 'mesh_direct_cancel',
    description: 'Cancel a mesh_direct (mesh_send_task) attempt through the turn ledger: records cancel evidence and starts the proof-fenced stop of the exact writer session. It never force-releases a claim — stopPending:true means the stop is durable but the writer is not yet proven stopped (it settles on its own). An already-finished attempt is a no-op; attempts owned by another daemon and queue tasks are refused (use mesh_queue_cancel for queue tasks). Pass exactly one of task_id or attempt_id.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            task_id: { type: 'string', description: 'The direct-dispatch task ID (taskId returned by mesh_send_task) whose latest attempt to cancel.' },
            attempt_id: { type: 'string', description: 'Exact turn attempt ID to cancel (alternative to task_id).' },
            reason: { ...enumOf(CANCEL_REASONS), description: 'Cancel reason recorded on the attempt. Default operator_cancel. intentional_cleanup is bookkeeping only (no session stop is sent for it).' },
        },
        required: [] as string[],
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

export const MESH_QUEUE_REVISE_TOOL = {
    name: 'mesh_queue_revise',
    description: 'Atomically revise an existing PENDING task by expected revision (legacy revision is 0). Preserves id, mission, history and dependents. Edits message, ownership, source/integration phase or dependency graph; releases stale holds and reschedules immediately. Physical source migration requires an existing local node pin, attested by the host. Assigned/open attempts refuse; no force or active handoff in version 1. Source completion is uncommitted/not_mergeable, never release acceptance.',
    inputSchema: {
        type: 'object' as const, additionalProperties: false,
        required: ['task_id', 'expected_revision', 'patch'],
        properties: {
            task_id: { type: 'string' }, expected_revision: { type: 'integer', minimum: 0 },
            patch: { type: 'object', additionalProperties: false, minProperties: 1,
                properties: {
                    message: { type: 'string', minLength: 1 },
                    ownedPaths: { type: 'array', minItems: 1, items: { type: 'string' } },
                    phase: { type: 'string', enum: ['source', 'integration'] },
                    dependsOn: { type: 'array', items: { type: 'string' } },
                    routingPreferences: { type: 'object', additionalProperties: false, properties: {
                        nodeIds: { type: 'array', items: { type: 'string' } }, providers: { type: 'array', items: { type: 'string' } },
                    } },
                    review: { type: 'object', additionalProperties: false, required: ['sourceTaskId', 'differentProvider'], properties: {
                        sourceTaskId: { type: 'string' }, differentProvider: { const: true },
                    } },
                    requestQuotaOverride: { const: true, description: 'Alone: ask the OWNER to let this quota-held task run despite the quota reserve (raises an owner decision; you cannot grant it).' },
                },
            },
        },
    },
};

export const MESH_LIGHT_LAND_TOOL = {
    name: 'mesh_light_land',
    description: 'Land finished light tasks (mesh_enqueue_task light=true) whose result is `ready`. Default mode refine: composes the results on the current base and runs the refinery with the repo\'s fast validation profile '
        + '(publish approval and push guards still apply). apply_to_checkout (interactive MCP sessions only) stages the patches in your own checkout, uncommitted. Use dry_run first; conflicts are resolved in the task\'s own session via mesh_send_task.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            task_ids: { type: 'array', items: { type: 'string' }, description: 'Light task ids, landed in this order.' },
            mode: { type: 'string', enum: ['refine', 'apply_to_checkout'], description: 'Default refine.' },
            dry_run: { type: 'boolean', description: 'Show what would land and any conflict; change nothing.' },
            accept_paths_outside_owned: { type: 'boolean', description: 'Required when a result touched paths outside its owned_paths.' },
            partial: { type: 'boolean', description: 'Land the tasks before the first conflicting one.' },
            approved_publish_shas: { type: 'array', items: { type: 'string' }, description: 'Submodule commit SHAs approved for publication (as mesh_refine_node).' },
        },
        required: ['task_ids'],
    },
};

export const MESH_LIGHT_DISCARD_TOOL = {
    name: 'mesh_light_discard',
    description: 'Discard finished (unlanded) light task results: removes their workspaces and branches. The patches are not kept.',
    inputSchema: {
        type: 'object' as const,
        properties: { task_ids: { type: 'array', items: { type: 'string' } } },
        required: ['task_ids'],
    },
};
