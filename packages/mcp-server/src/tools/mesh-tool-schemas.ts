/**
 * MCP tool schema definitions for the mesh_* tool family.
 *
 * Pure data: per-tool input schemas plus the ALL_MESH_TOOLS registry. Physically
 * split out of mesh-tools.ts (which keeps the handler implementations) — see
 * RF-SURVEY candidate C1. No behavior change: mesh-tools.ts re-exports every symbol
 * below so existing `./tools/mesh-tools.js` import paths stay intact.
 */

import { annotateAll } from './tool-annotations.js';
// Wiring-unification A3: every vocabulary enum is derived from the ONE tuple in
// mesh-shared via enumOf(), so the published schema cannot drift from the code.
// Tool-local enums (gate outcomes, mission status, key names, …) stay inline.
import {
    enumOf,
    MESH_DELIVERY_MODES,
    MESH_SESSION_CLEANUP_MODES,
    MESH_TASK_DIFFICULTIES,
    MESH_TASK_MODES,
    MESH_TASK_PRIORITIES,
    MESH_THINKING_LEVELS,
} from '@adhdev/mesh-shared';

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
    description: 'Multipart input, e.g. a screenshot: {parts:[{type:"text",text},{type:"image",mimeType,data(base64)|uri}]}. A text-only provider (opencode, ACP) refuses it explicitly.',
    properties: {
        parts: {
            type: 'array' as const,
            items: { type: 'object' as const },
        },
    },
};

/**
 * One `inputs_from` entry (design :204-246).
 *
 * ★ This schema used to be a bare `{ type: 'object' }` — the field shapes lived
 * ONLY in the prose description, so nothing machine-readable told a caller that
 * `from`/`select`/`as` are mandatory. daemon-core's `parseInputBindings` is
 * strict about all three, so a plausible-looking typo was accepted by the tool
 * boundary and rejected much later, during materialization. The schema now
 * states the contract the parser already enforces; daemon-core re-validates at
 * enqueue regardless (a schema is a hint to the model, never the boundary).
 *
 * Kept deliberately in step with `parseInputBindings`: same required fields,
 * same `as` pattern, same enums, same `max_bytes` ceiling. Descriptions are
 * terse on purpose (graph-orchestration-simplification D2: the batch schema is
 * size-capped, see mesh-enqueue-schema-diet.test.ts).
 */
const MESH_INPUT_BINDING_SCHEMA = {
    type: 'object' as const,
    properties: {
        from: { type: 'string' as const, description: 'Predecessor task/gate ref.' },
        select: { type: 'string' as const, description: 'RFC-6901 JSON Pointer into its completion envelope, e.g. /summary ("" = all).' },
        as: { type: 'string' as const, pattern: '^[A-Za-z][A-Za-z0-9_]{0,63}$', description: 'Unique binding name.' },
        required: { type: 'boolean' as const, description: 'true = block when empty.' },
        format: { type: 'string' as const, enum: ['text', 'json'] },
        // Snake_case ONLY — unlike the task-level fields, `parseInputBindings`
        // reads no camelCase alias for these, so advertising one would publish a
        // field the parser silently ignores.
        max_bytes: { type: 'number' as const, description: 'Default 16384, max 65536.' },
        overflow: { type: 'string' as const, enum: ['error', 'truncate'] },
    },
    required: ['from', 'select', 'as'],
};

export const MESH_STATUS_TOOL = {
    name: 'mesh_status',
    description: 'Get the current status of all nodes in the repo mesh — health, git state, active sessions, recovery hints, and recommended next steps. Node git is the coordinator daemon\'s held state (never a live remote probe); the per-node gitObservation {source, observedAt, refreshing, unreachableSince} and dataFreshness say how old it is. Use this to decide which node to send work to or how to recover from failures. Also reports the running daemon build per daemonId under top-level daemonBuilds ({commit, commitShort, version, track}); track is stable/preview when explicitly reported by that daemon and unknown for legacy peers — it is never inferred from an rc version suffix. When a live daemon was built from a commit BEHIND its workspace HEAD it adds staleDaemonBuilds[] + staleDaemonBuildWarning — meaning a just-merged refinery/mesh-tool fix is NOT yet live on that daemon (awaiting deploy/restart; a local dist rebuild does not update a cloud daemon). When a daemon has a durable failed-upgrade notice on record it adds daemonUpgradeFailures{daemonId → {summary, recordedAt, ageLabel, targetVersion, noticePath, logPath}} + daemonUpgradeFailureWarning — meaning that daemon\'s LAST upgrade attempt failed and was rolled back, so it is still on the PREVIOUS version (an upgrade/restart response only ever reports "scheduled", never success). Do not repeatedly call this to wait for generating delegated work; wait for pendingCoordinatorEvents/completion events or an explicit user status request.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            refresh: { type: 'boolean', description: 'Ask the coordinator daemon to refresh node git in the background (returns immediately; refreshing nodes show gitObservation.refreshing, results appear on a later call) and bypass the 5 s session-probe cache. Default false.' },
            _gemini_compat: { type: 'string', description: 'Dummy property for Gemini compatibility. Ignore this.' },
            includeStaleDirectWorkDetails: { type: 'boolean', description: 'Opt in to the full staleDirectWork array. Defaults false; normal status returns compact staleDirectWorkSummary only.' },
            includeTerminalDirectWork: { type: 'boolean', description: 'Include historical completed/failed direct dispatches (terminalDirectWork) in the response. Defaults false.' },
            includeSessions: { type: 'boolean', description: 'Opt in to per-node live session arrays. Default false: compact mode returns a per-node sessionSummary (counts) and de-duplicated full session lists under top-level daemonSessions keyed by daemonId (sessions are not repeated for every node that shares a daemon). Set true to also include the full session array on each node.' },
            includeUsage: { type: 'boolean', description: 'Opt in to the token/cost usage rollup for this mesh (usage.total, usage.retained, usage.byNode, usage.costCoverage). Default false — usage is not read on ordinary status polls. Token counts come from each provider native transcript; costUsd is only present for providers that compute one themselves (hermes), so costCoverage reports how many sessions contributed a cost.' },
            compact: { type: 'boolean', description: 'Slim payload for LLM callers. Default true. Folds per-node session arrays to sessionSummary and de-duplicates daemon-shared sessions into daemonSessions. Set false (or verbose=true) for the full dashboard-grade payload.' },
            verbose: { type: 'boolean', description: 'Force the full payload; overrides compact.' },
        },
    },
};

export const MESH_ROUTE_PREVIEW_TOOL = {
    name: 'mesh_route_preview',
    description: 'Preview where a hypothetical task would route, and why, from the current in-memory mesh/queue/quota-facts snapshot. Read-only and fetch-free: it does not enqueue, write, probe CLIs, or refresh quota. Returns the full unbounded slot breakdown (capacity-first order, hard difficulty floor, fitness components, quota bonus with zero reason, gate outcome, and Stage 3 quota reordering). Capacity is a point-in-time live queue reading and can change immediately after the response.',
    inputSchema: {
        type: 'object' as const,
        required: ['difficulty'],
        properties: {
            difficulty: {
                ...enumOf(MESH_TASK_DIFFICULTIES),
                description: 'Hypothetical task difficulty. Classified tasks enforce the hard difficulty floor; freeform contributes zero on every difficulty score axis.',
            },
            required_tags: {
                type: 'array' as const,
                items: { type: 'string' as const },
                description: 'Optional capability tags the hypothetical task requires.',
            },
            requiredTags: { type: 'array' as const, items: { type: 'string' as const }, description: 'CamelCase alias for required_tags.' },
            readonly: {
                type: 'boolean' as const,
                description: 'Whether to preview read-only scheduling semantics, including the reserved-last-slot capacity rule.',
            },
            target_node_id: {
                type: 'string' as const,
                description: 'Optional node pin. When omitted, preview all eligible nodes in scheduling order.',
            },
            targetNodeId: { type: 'string' as const, description: 'CamelCase alias for target_node_id.' },
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
        + 'The daemon NEVER performs a gate action and NEVER auto-passes a gate. Use it when a gate notice arrives or mesh_graph_view shows a gate blocking downstream work. Select the verb with `action` (REQUIRED):\n'
        + '• claim — take the lease on a gate awaiting a coordinator. Returns a monotonically increasing leaseGeneration and an opaque fencingToken: keep both, release needs them. '
        + 'A lapsed lease can be taken over at a HIGHER generation; the response then sets ambiguousExternalOutcome — the previous owner may already have performed the side effect, so reconcile external evidence (did the merge/publish land?) before doing it again. '
        + 'Args: gate_id, lease_seconds, extend_deadline_seconds, coordinator_session_id.\n'
        + '• release — pass a gate you hold: the ONLY way a gate lets downstream run. Needs lease_generation + fencing_token from claim (stale generation / wrong token → stale_fence; an EXPIRED lease never releases — re-claim and reconcile first) and your own idempotency_key '
        + '(identical re-send = no-op success; same key, different payload = conflict). `outcome` and any `result`/`evidence` are readable downstream through run_if and inputs_from. A validation failure rolls the WHOLE release back. '
        + 'Args: gate_id, fencing_token, lease_generation, idempotency_key, outcome, result, evidence, patches.\n'
        + '• abandon — give up on a gate that can never open (the work behind it was cancelled) so its graph can go terminal. NOT a pass: it materializes nothing and CANCELS every downstream task the gate held. '
        + 'Needs no fencing token, but a LIVE lease held by another coordinator is refused unless force=true. Re-abandoning is a no-op; a RELEASED gate can never be abandoned. Args: gate_id, reason, force, coordinator_session_id.\n'
        + '• extend — push the gate DEADLINE out without taking a lease (e.g. extend_seconds=86400 for a gate that expired, or is about to, under on_timeout=hold, that you still intend to act on). Args: gate_id, extend_seconds.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            action: {
                type: 'string',
                enum: ['claim', 'release', 'abandon', 'extend'],
                description: 'Which gate verb to run (required). Each action accepts only its own arguments — see the tool description.',
            },
            gate_id: { type: 'string', description: 'The gate (from mesh_graph_view, a gate notice, or the mesh_enqueue_batch response). All actions.' },
            gateId: { type: 'string', description: 'CamelCase alias for gate_id.' },
            lease_seconds: { type: 'number', description: 'claim: how long to hold the lease. Defaults to the gate spec\'s lease_seconds, then 900s. Cover the real action — a lapsed lease cannot release (elapsed time is never completion evidence).' },
            leaseSeconds: { type: 'number', description: 'CamelCase alias for lease_seconds.' },
            extend_deadline_seconds: { type: 'number', description: 'claim: also push the gate DEADLINE out by this many seconds from now. The deadline is when on_timeout (hold / cancel_downstream / fail_graph) fires; reclaiming a gate that expired under hold does NOT refresh it unless you pass this.' },
            extendDeadlineSeconds: { type: 'number', description: 'CamelCase alias for extend_deadline_seconds.' },
            extend_seconds: { type: 'number', description: 'extend: push the deadline out by this many seconds (positive). Takes NO lease. Extending only delays on_timeout; it is never completion evidence.' },
            fencing_token: { type: 'string', description: 'release: the opaque token returned by claim. Required for release.' },
            fencingToken: { type: 'string', description: 'CamelCase alias for fencing_token.' },
            lease_generation: { type: 'number', description: 'release: the leaseGeneration returned by claim. Required for release — a stale generation is refused.' },
            leaseGeneration: { type: 'number', description: 'CamelCase alias for lease_generation.' },
            idempotency_key: { type: 'string', description: 'release: your own key for this release. Required for release.' },
            idempotencyKey: { type: 'string', description: 'CamelCase alias for idempotency_key.' },
            outcome: { type: 'string', description: 'release: passed | failed | rejected, or an action-specific label. Downstream run_if reads it as /gate_outcome. Required for release.' },
            result: { type: 'object', description: 'release: optional action-specific structured result, exposed downstream as /result/... (e.g. the merged commit sha).' },
            evidence: { type: 'object', description: 'release: optional evidence references/digests, exposed downstream as /evidence/... .' },
            patches: {
                type: 'array',
                description: 'release: optional pre-assignment patches to DIRECT downstream nodes. Only run_if, on_false, inputs_from and workspace_ref may be patched — message, routing, permissions, task mode and model are immutable, and a claimed task cannot be patched.',
                items: {
                    type: 'object',
                    properties: {
                        node: { type: 'string', description: 'Ref or node id of a DIRECT downstream node of this gate. node_id/nodeId/ref are equivalent aliases — any one resolves the target; an entry naming none of them is REJECTED (the whole release refuses) rather than silently dropped.' },
                        node_id: { type: 'string', description: 'Alias for node.' },
                        nodeId: { type: 'string', description: 'CamelCase alias for node.' },
                        ref: { type: 'string', description: 'Alias for node — the batch-local ref of the downstream node.' },
                        base_spec_patch: { type: 'object', description: 'Keys to merge into that node\'s spec. Allowed keys: run_if, on_false, inputs_from, workspace_ref.' },
                        baseSpecPatch: { type: 'object', description: 'CamelCase alias for base_spec_patch.' },
                    },
                    required: ['node'],
                },
            },
            reason: { type: 'string', description: 'abandon: why the gate is given up — recorded on the gate, every cancelled downstream row, and the provenance ledger. Required for abandon.' },
            force: { type: 'boolean', description: 'abandon: abandon even though another coordinator holds a LIVE lease. Only when you know that holder is dead.' },
            coordinator_session_id: { type: 'string', description: 'claim / abandon: owner (claim) or recorded abandoner. Defaults to this coordinator session.' },
            coordinatorSessionId: { type: 'string', description: 'CamelCase alias for coordinator_session_id.' },
        },
        required: ['action', 'gate_id'],
    },
};



export const MESH_GRAPH_NODE_PATCH_TOOL = {
    name: 'mesh_graph_node_patch',
    description: 'Fix a graph node that could NOT be materialized, and retry it in the same call — the recovery path for a task blocked on `materialization_error:*` '
        + '(seen in mesh_graph_view / as the task\'s blockedReason). A node\'s `inputs_from` / `run_if` are baked in when the batch is accepted but only resolved once every '
        + 'predecessor has COMPLETED, so a binding that cannot be resolved strands the one step that was meant to consume all that finished work. The graph retries such a node '
        + 'automatically, but it re-reads the same spec and fails identically every time — it cannot heal itself, so use this to change the spec. '
        + 'The patch and the retry are ONE transaction: the response tells you immediately whether the node materialized (recovered: true) or is still blocked, and with which new reason. '
        + '★ Only run_if, on_false, inputs_from and workspace_ref may be patched — message, routing, permissions, task mode and model are immutable, and a task that is already '
        + 'claimed or finished cannot be patched at all (cancel and enqueue a corrected step instead). This is a repair tool, not a way to re-task a worker. '
        + 'Most shape errors are now rejected up front by mesh_enqueue_batch; the case that still needs this is `required_input_missing` — a well-formed binding whose source never produced that field.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node: { type: 'string', description: 'Node id or `ref` of the node to patch (from mesh_graph_view). A ref that matches several live graphs is refused — pass graph_id too, or the exact node id.' },
            node_id: { type: 'string', description: 'Alias for node.' },
            nodeId: { type: 'string', description: 'CamelCase alias for node_id.' },
            ref: { type: 'string', description: 'Alias for node, spelled `ref` to match mesh_graph_view\'s own field name for a node\'s human-readable ref. A ref that matches several live graphs is refused — pass graph_id too, or the exact node id.' },
            graph_id: { type: 'string', description: 'Disambiguate which graph the ref belongs to. Optional when `node` is a node id.' },
            graphId: { type: 'string', description: 'CamelCase alias for graph_id.' },
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
            baseSpecPatch: { type: 'object', description: 'CamelCase alias for base_spec_patch.' },
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
            graphId: { type: 'string', description: 'CamelCase alias for graph_id.' },
            batch_id: { type: 'string', description: 'Show the graph committed under this batch_id.' },
            batchId: { type: 'string', description: 'CamelCase alias for batch_id.' },
            include_terminal: { type: 'boolean', description: 'Include completed/failed/cancelled graphs. Default false (in-flight only).' },
            includeTerminal: { type: 'boolean', description: 'CamelCase alias for include_terminal.' },
            probe_gate_evidence: { type: 'boolean', description: 'Attach convergence evidence to waiting gates: whether each upstream commit is already reachable from the mesh base workspace\'s local origin/main. Answers "did the guarded work already land?" without claiming. Runs bounded local git probes (first 5 waiting gates, no fetch) — default false keeps the view git-free. Evidence never releases a gate.' },
            probeGateEvidence: { type: 'boolean', description: 'CamelCase alias for probe_gate_evidence.' },
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
            refresh: { type: 'boolean', description: 'Bypass the shared get_status_metadata probe cache (one probe per daemon, 5 s TTL — mesh-tools-internal.ts probeStatusMetadataForNode) and force a fresh probe. Default false.' },
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
            taskId: { type: 'string', description: 'CamelCase alias for task_id.' },
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
            taskId: { type: 'string', description: 'CamelCase alias for task_id.' },
            reason: { type: 'string', description: 'Optional operator-visible reason for requeueing.' },
            target_node_id: { type: 'string', description: 'Optional replacement target node ID.' },
            targetNodeId: { type: 'string', description: 'CamelCase alias for target_node_id.' },
            target_session_id: { type: 'string', description: 'Optional replacement target runtime session ID.' },
            targetSessionId: { type: 'string', description: 'CamelCase alias for target_session_id.' },
            clear_target_node: { type: 'boolean', description: 'When true, remove any existing target node constraint.' },
            clearTargetNode: { type: 'boolean', description: 'CamelCase alias for clear_target_node.' },
            keep_target_session: { type: 'boolean', description: 'When true, preserve an existing target session if target_session_id is not provided. Defaults false to avoid stale session targets.' },
            keepTargetSession: { type: 'boolean', description: 'CamelCase alias for keep_target_session.' },
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
            session_id: { type: 'string', description: 'Agent session ID on the target node. Optional: when omitted the task is dispatched to the node (a remote node scopes it to its own session for this workspace; a local node routes it through the queue pull).' },
            message: { type: 'string', description: 'Natural-language task to send to the agent.' },
            input: MESH_TASK_INPUT_SCHEMA,
            task_mode: { ...enumOf(MESH_TASK_MODES), description: 'Optional task-mode contract. live_debug_readonly rejects obvious write/commit/push/deploy/destructive instructions before local or remote direct dispatch.' },
            taskMode: { ...enumOf(MESH_TASK_MODES), description: 'CamelCase alias for task_mode.' },
            readonly: { type: 'boolean', description: 'Optional read-only axis (orthogonal to task_mode). When true the task runs without write isolation, is counted under the read-only cap, and rejects write/commit/push/deploy/destructive instructions like live_debug_readonly. Composable with any task_mode.' },
            read_only: { type: 'boolean', description: 'Snake-case alias for readonly.' },
            owned_paths: { type: 'array', items: { type: 'string' }, description: 'H1 (path ownership); same semantics as mesh_enqueue_task. Repo-relative files/dirs this code_change task will touch (a trailing /** claims the subtree). Optional and opt-in. A direct dispatch already targets a specific node/session, so this is recorded for the same code_change overlap check against OTHER in-flight tasks (queued or direct) and for the report_completion.touched_files comparison — it is not itself a routing input.' },
            ownedPaths: { type: 'array', items: { type: 'string' }, description: 'CamelCase alias for owned_paths.' },
            mission_id: { type: 'string', description: 'Mission this task belongs to (mesh_mission record id, full/exact). When set, the directly dispatched task is attributed to the mission task aggregates exactly like mesh_enqueue_task, including terminal completion. Omit for an unattributed direct dispatch. An unresolvable id is REJECTED before dispatch (mission_not_found), never silently attached.' },
            missionId: { type: 'string', description: 'CamelCase alias for mission_id.' },
            difficulty: { ...enumOf(MESH_TASK_DIFFICULTIES), description: 'REQUIRED task execution difficulty. Classify each task by how hard the work actually is. On a direct dispatch the target node/session is already chosen, so difficulty is not used to ROUTE — it is recorded on the task so scheduling analytics, mission aggregates and (critically) failure-recovery relaunch all see the same axis a queued task carries. A recovery relaunch inherits this value from the ledger, so an unclassified direct dispatch would silently downgrade its own retry.' },
            delivery_mode: {
                ...enumOf(MESH_DELIVERY_MODES),
                description: "How to deliver when the target session is BUSY. Default 'when_idle': never disturbs the running turn — the task is queued and auto-delivered the moment the session goes idle. "
                    + "★'interrupt' ABORTS the turn currently in flight by pressing the provider's own stop control (Ctrl-C, or ESC on antigravity-cli), then delivers this task once the session settles. "
                    + 'THE WORK IN PROGRESS IS DISCARDED — whatever the agent had not yet finished is lost, and any partial edits it was mid-way through are left as they are. Use it only when the running turn is genuinely going the wrong way and finishing it is worse than losing it. '
                    + "If the target provider cannot interrupt (no stop control declared, or an empty stop key), the dispatch is REJECTED rather than quietly falling back to when_idle — so a steering attempt never reports success while the session actually runs on to completion under the old instructions. Re-send with 'when_idle' if delivery-after-completion is acceptable. "
                    + 'Has no effect on an idle session (delivered immediately either way).',
            },
            deliveryMode: { ...enumOf(MESH_DELIVERY_MODES), description: 'CamelCase alias for delivery_mode.' },
            // GRAPH-MEASUREMENT-DIRECT — the decision record for the DIRECT surface.
            //
            // ★ WHY IT IS HERE AT ALL. This tool is the MAJORITY dispatch surface (~67%
            // of dispatches in the graph-adoption investigation) and it carried no
            // decision field, so two thirds of all routing judgements were structurally
            // unmeasurable. `decision_missing` on mesh_enqueue_task described only the
            // enqueue minority and was silent — not negative — about the rest.
            //
            // ★ OPTIONAL, exactly like mesh_enqueue_task's (see the note there): phase E
            // measures and does not enforce, and a required field would reject every
            // existing caller. Omission degrades to decision_missing, never an error.
            orchestration_decision: {
                type: 'object',
                description: 'Record of your dispatch decision, for adoption measurement: {decision, direct_reason, ready_worker_tasks, known_graph_steps, capability_blockers}. '
                    + 'On this DIRECT surface, direct_reason says why dispatching into an existing session beat queueing a task — one of same_subject_continuation, investigation_handoff, idle_session_reuse, queue_bypass_urgent, new_subject, legacy_client, operator_override. '
                    + 'These are the cases the operating rules name: same-subject continuation, the investigate→fix handoff, reusing an idle session for a follow-up/retry/cleanup delta, or a deliberate queue bypass. '
                    + 'new_subject is the one the rules do NOT endorse — a genuinely new topic should get its own task even when a session sits idle — and reporting it returns an unsanctioned_direct_dispatch advisory. Report it honestly anyway: it is recorded, never refused. '
                    + 'Optional and never rejected: omitting it is recorded as decision_missing. Provenance only — it never changes execution.',
            },
            orchestrationDecision: { type: 'object', description: 'CamelCase alias for orchestration_decision.' },
            allow_stale_node: { type: 'boolean', description: "GIT-GATE: a non-readonly direct dispatch is refused (dirty_workspace / node_stale_behind_upstream) when the target node's git telemetry shows an uncommitted working tree or a branch behind its upstream beyond the mesh's autoFastForward.maxBehind — the same predicates the claim-time and auto-launch spawn gates apply. Set true to dispatch anyway (e.g. a task whose job IS to fix the dirty/stale tree). Has no effect on a readonly dispatch, which is never gated. Default: false." },
            allowStaleNode: { type: 'boolean', description: 'CamelCase alias for allow_stale_node.' },
            allow_quota_exhausted: { type: 'boolean', description: "QUOTA-GATE (preview rc.43 run 10): a direct dispatch that NAMES a session_id is refused when that session's provider is measurably quota-exhausted on the target node — the same fresh/measured predicate (evaluateProviderQuotaGate) the queue claim path already applies before pulling a pending task onto an idle session, now also applied here so a coordinator does not spend minutes talking to a session that cannot work (e.g. 'You've hit your session limit'). A stale/missing/unmarked snapshot always fails OPEN (dispatch proceeds) — only a fresh measured block refuses. Set true to dispatch anyway (e.g. testing the provider's own quota error). Default: false. Has no effect on a sessionless dispatch that ends up in the queue — the claim-time gate already covers that path." },
            allowQuotaExhausted: { type: 'boolean', description: 'CamelCase alias for allow_quota_exhausted.' },
        },
        // session_id is deliberately NOT required: meshSendTask supports a sessionless
        // dispatch (node-scoped on the worker) and the required-arg gate enforces this list.
        required: ['node_id', 'message', 'difficulty'],
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
            dry_run: { type: 'boolean', description: 'Preview only. Defaults true unless execute=true; dry_run=true overrides execute. dry_run=false is NOT an execute trigger — it only declines to veto, so passing it alone is rejected with dry_run_false_requires_execute rather than silently previewing. Use execute=true to apply.' },
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
    description: 'Create or update a persistent mission record so the plan survives coordinator restarts. Optional — a mesh_enqueue_batch does not require a mission; use one when you want the plan tracked as a durable, named unit of work. '
        + 'Recommended for multi-task work: create a mission first, then submit that plan as ONE mesh_enqueue_batch carrying the mission_id (a top-level mission_id applies to every entry; mesh_enqueue_task is the single-step fallback). A one-off graph with no need for that tracking can call mesh_enqueue_batch directly without a mission_id. Update status to completed/abandoned when the outcome is decided. Progress is derived from task statuses — there is no separate progress field. '
        + 'Single mission: pass title (and optionally mission_id to update an existing one). '
        + 'Bulk status transition (e.g. one-time stale cleanup): pass mission_ids (array) + status to apply that status to many missions at once; title/goal are ignored and a per-mission result array is returned. mission_ids takes precedence over mission_id when both are given.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            mission_id: { type: 'string', description: 'Full mission id (exact match) to update. Omit to create a new mission — do not guess/truncate an id to force a create. An id that does not resolve to an existing mission is REJECTED (mission_not_found), never silently created under that id — use mesh_mission_list to get a valid full id. Ignored when mission_ids is provided.' },
            missionId: { type: 'string', description: 'CamelCase alias for mission_id.' },
            mission_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Bulk mode: apply `status` to every listed mission id in one call (stale cleanup). Requires `status`. Returns a per-mission { id, ok, status?, error? } result array. Overrides mission_id/title/goal.',
            },
            missionIds: { type: 'array', items: { type: 'string' }, description: 'CamelCase alias for mission_ids.' },
            title: { type: 'string', description: 'Short mission title. Required to create/update a single mission; ignored in bulk (mission_ids) mode.' },
            goal: { type: 'string', description: 'Free-text mission goal/definition of done. Ignored in bulk (mission_ids) mode.' },
            status: { type: 'string', enum: ['active', 'paused', 'completed', 'abandoned'], description: 'Mission lifecycle status. Defaults to active on create. Required in bulk (mission_ids) mode.' },
            brief: {
                type: 'object',
                description: 'H2 (mission brief). Optional structured brief, rendered into every task dispatched under this mission\'s worker-protocol footer so a freshly launched worker sees it without a separate lookup. {goal (required — a brief with no goal is dropped, not stored empty), constraints?, doneCriteria?, handoffNotes?, ownedPaths?} — each of the four optional fields is a string array; done_criteria/handoff_notes/owned_paths snake_case aliases are also accepted. Ignored in bulk (mission_ids) mode. When a non-empty brief is dropped (no goal, or a field of the wrong type), the response carries `briefIgnored: {reason, field?}` instead of silently discarding it. This is DISTINCT from the top-level `goal` field: `goal` is the mission record\'s short free-text summary shown in mesh_mission_list; `brief` is the longer structured packet a worker actually reads.',
                properties: {
                    goal: { type: 'string', description: 'What this mission is trying to accomplish. Required for the brief to be stored — an object with no goal is treated as no brief.' },
                    constraints: { type: 'array', items: { type: 'string' }, description: 'Hard constraints a worker must respect, e.g. "do not touch daemon-core", "no npm install".' },
                    doneCriteria: { type: 'array', items: { type: 'string' }, description: 'How to know the mission is actually done.' },
                    done_criteria: { type: 'array', items: { type: 'string' }, description: 'Snake_case alias for doneCriteria.' },
                    handoffNotes: { type: 'array', items: { type: 'string' }, description: 'Standing notes for whoever picks up mission work next.' },
                    handoff_notes: { type: 'array', items: { type: 'string' }, description: 'Snake_case alias for handoffNotes.' },
                    ownedPaths: { type: 'array', items: { type: 'string' }, description: 'Paths this mission\'s tasks collectively own — surfaced to workers, not itself enforced (per-task owned_paths on mesh_enqueue_task/mesh_enqueue_batch/mesh_send_task is what claim-time enforcement reads).' },
                    owned_paths: { type: 'array', items: { type: 'string' }, description: 'Snake_case alias for ownedPaths.' },
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
            includeStats: { type: 'boolean', description: 'CamelCase alias for include_stats.' },
            include_magi: { type: 'boolean', description: 'Include completed MAGI cross-verification missions (hidden by default). Defaults to false.' },
            includeMagi: { type: 'boolean', description: 'CamelCase alias for include_magi.' },
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
        + 'Returns a typed create+onboarding, add-existing-workspace, or clone-new-worktree plan with suggested .adhdev configs. Never fetches, writes config, or creates a mesh/node/branch/worktree. Run it before creating a mesh, adding a node (mesh_add_node) or cloning a worktree (mesh_clone_node). Args: workspace (required), mesh_id, operation, branch.\n'
        + '• mode="create" (default) — a persistent write: run mode="plan" first and obtain explicit user approval. Pass workspace to auto-detect Git identity/branch/worktree through the read-only planner, or pass repo_remote_url / repo_identity explicitly. add_current:true also registers a node in the same call (workspace if given, else the daemon\'s cwd). '
        + 'Returns mesh_id (and node_id with add_current). Args: name (required), repo_remote_url, repo_identity, default_branch, add_current, workspace.\n'
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
        + '• preserve / stop / delete_stopped / stop_and_delete — a node\'s delegated session records (needs node_id). Use when a node is cluttered with finished or stuck worker sessions. Defaults should preserve reviewable history unless you choose a mode explicitly. Args: node_id, session_ids, dry_run.\n'
        + '• prune_stale_direct — mesh-wide: orphaned staleDirect dispatch records (direct task dispatches whose original node/session is gone from the live mesh). Use when mesh_status keeps listing stale direct dispatches. '
        + 'Dry-run by default; execute=true deletes. Active/pending/assigned/generating work and fresh unacknowledged dispatch failures (node/session still live) are always preserved, and the append-only ledger history is kept. Args: execute, dry_run, include_terminal.',
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
            kind: { type: 'string', description: 'Filter by entry kind. Accepts one kind, or a comma-separated list (e.g. "task_failed,task_stalled"). Valid kinds include: task_dispatched, task_completed, task_failed, task_stalled, task_approval_needed, session_launched, session_stopped, checkpoint_created, node_cloned, node_joined, node_removed, direct_fast_forward, ledger_reconciled, event_held, mission_created, mission_status_changed, mission_goal_updated, magi_dispatched, magi_synthesis.' },
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
        + 'Provider-neutral: it persists in the mesh ledger and is injected into every coordinator\'s system prompt at launch (codex, hermes, antigravity, claude alike). Select with `action` (REQUIRED):\n'
        + '• record — when you learn something durable (a provider quirk, a pattern to avoid, a recovery lesson), and before closing a mission that taught one. Keep each note to one concrete, reusable fact; not for transient task status (use missions/checkpoints). '
        + 'Args: text (required), category, pinned, ttl_days, expiresAt, supersedes, subject_key.\n'
        + '• forget — when an injected note is stale or wrong. Appends a tombstone so the note(s) stop riding into future prompts; history is preserved (append-only). Target by note_id (exact) or by exact text; provide at least one. Args: note_id, text, reason.',
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
                description: 'record: optional explicit ISO-8601 expiry, an alternative to ttl_days. Wins over ttl_days. Ignored when pinned.',
            },
            expires_at: { type: 'string', description: 'Snake_case alias for expiresAt.' },
            supersedes: {
                type: 'string',
                description: 'record: optional version-supersede — the note_id of an earlier note this one replaces, OR a subject_key shared with earlier notes. Matching earlier LIVE notes are hidden from the prompt (ledger kept). Pinned notes are never hidden by supersede.',
            },
            subject_key: {
                type: 'string',
                description: 'record: optional stable subject key grouping notes about the same subject. Drives supersede targeting and read-side folding (same category AND subject_key collapse to one injected entry, newest kept). When omitted, folding falls back to a leading [tag] bracket in the text.',
            },
            note_id: { type: 'string', description: 'forget: the ledger note id to retract (full/exact — no prefix matching). Returned by record as noteId, or visible in mesh_task_history. An id that matches no live note returns success:false, code:note_not_found — do not guess/truncate an id.' },
            noteId: { type: 'string', description: 'CamelCase alias for note_id.' },
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

// 2026-09-26 tool consolidation: the Refinery config helper, the Change Impact
// config helper and the `.adhdev/mesh.json` gated write are one tool, selected
// by `kind`. refine / change_impact keep their read-only `mode`
// (schema/validate/suggest); mesh_json keeps its write/overwrite dry-run contract.
// The pre-2026-09 per-mode names (mesh_refine_config_schema & co.) stay
// dispatchable as hidden aliases with kind + mode injected (mesh-tool-dispatch.ts).
export const MESH_CONFIG_TOOL = {
    name: 'mesh_config',
    description: 'Repo Mesh repo-config helper. Select the config family with `kind` (REQUIRED):\n'
        + '• kind="refine" — the Refinery config (read-only). Use when a refine run reports a config error or you need to know which validation commands will run. `mode` (REQUIRED): '
        + 'schema = the config JSON schema and supported repo-local locations (the validation authority; heuristic command detection is suggestions-only), no other args; validate = validate a node/workspace config without running validation or merging (optional node_id, optional inline `config`); suggest = scaffold a config from project context/package scripts (never executed until saved; optional node_id). '
        + 'Never runs validation or merges — that is mesh_refine_node / mesh_refine_plan.\n'
        + '• kind="change_impact" — the Change Impact config (read-only, declarative, never executed): which package/file changes between the live daemon build and workspace HEAD need a daemon rebuild/restart vs a web-only redeploy vs nothing. Use when deciding whether a landed change needs a daemon restart. '
        + 'Same `mode` values: schema; validate (loads .adhdev/change-impact.{json,yaml,yml} or repo-mesh-change-impact.* unless inline `config`); suggest (web-* → web-only, others → daemon-runtime, docs/license markers → non-runtime; review and save before it takes effect).\n'
        + '• kind="mesh_json" — gated WRITE of `.adhdev/mesh.json` (the repo-committed coordinator prompt override/append + declarative config) from the machine-local mesh entry. Use when the user wants the coordinator prompt/config committed to the repo. '
        + 'Dry-run by default (write=false), never clobbers an existing file unless overwrite=true, validates before writing. Overwrite silently replaces the file: present a current-vs-suggested diff and get explicit approval first. REPO-COMMITTED scope. Args: node_id, workspace, write, overwrite (no `mode`).',
    inputSchema: {
        type: 'object' as const,
        properties: {
            kind: {
                type: 'string',
                enum: ['refine', 'change_impact', 'mesh_json'],
                description: 'Which config family (required). Each kind accepts only its own arguments — see the tool description.',
            },
            mode: {
                type: 'string',
                enum: ['schema', 'validate', 'suggest'],
                description: 'refine / change_impact only (required for them): schema (no other params), validate (optional node_id, optional inline config), suggest (optional node_id).',
            },
            node_id: { type: 'string', description: 'Optional node/workspace; defaults to the first mesh node. refine / change_impact: the config to load (validate) or context source (suggest), ignored by schema. mesh_json: whose workspace .adhdev/mesh.json is written (`workspace` wins when both are given).' },
            config: { type: 'object', description: 'refine / change_impact, mode=validate only: inline config object to validate instead of loading from the repo.' },
            write: { type: 'boolean', description: 'mesh_json: when true, persist .adhdev/mesh.json to the repo (commit target). Defaults false (dry-run preview).' },
            overwrite: { type: 'boolean', description: 'mesh_json: when true, replace an existing .adhdev/mesh.json. Defaults false (never clobber an existing repo mesh.json).' },
            workspace: { type: 'string', description: 'mesh_json: optional workspace path whose .adhdev/mesh.json is written. Defaults to the resolved node_id node\'s workspace.' },
        },
        required: ['kind'],
    },
};


export const MESH_INIT_TOOL = {
    name: 'mesh_init',
    description: 'Mesh onboarding for a git project: detects installed CLI providers, suggests all three repo `.adhdev/*` config families — Refinery (.adhdev/refine.json), worktree bootstrap (.adhdev/worktree_bootstrap.json) AND change-impact (.adhdev/change-impact.json) — optionally writes them, and recommends a node providerPriority. '
        + 'Also returns `currentConfig` (the saved config per domain: repo files + machine-local magiKindPanels) so you can present a current-vs-suggested diff. Suggestions never execute until saved; providerPriority is a recommendation, not auto-applied. Always dry-run unless write=true. Select with `mode`:\n'
        + '• mode="init" (default) — a fresh, never-onboarded repo. Never overwrites an existing config unless overwrite=true.\n'
        + '• mode="reinit" — re-onboard an ALREADY-initialized repo whose config needs refreshing: same suggest→validate→gated-write engine with overwrite defaulting to TRUE and a reinit contract in the response. '
        + 'Overwrite is a WHOLESALE replacement, so it must NOT silently drop operator hand-edits: the first call (write=false) is a DRY-RUN — present the per-section current-vs-suggested diff, get EXPLICIT per-section approval, then re-invoke with write=true.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            mode: {
                type: 'string',
                enum: ['init', 'reinit'],
                description: 'init (default) = first-time onboarding, existing config wins; reinit = refresh an onboarded repo, overwrite defaults to true.',
            },
            node_id: { type: 'string', description: 'Optional node/workspace to onboard. Defaults to the first mesh node with a workspace.' },
            write: { type: 'boolean', description: 'When true, persist the suggested configs to disk. Defaults false (dry-run preview only — for reinit, the preview surfaces the current-vs-suggested diff; approve per-section first).' },
            overwrite: { type: 'boolean', description: 'Replace an existing config file. Defaults false for mode=init (never clobber) and true for mode=reinit; pass false with reinit to fall back to existing-wins.' },
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
            taskKind: { type: 'string', enum: ['claim_audit', 'rca', 'design', 'freeform'], description: 'CamelCase alias for task_kind.' },
            mode: { type: 'string', enum: ['rca', 'investigation', 'claim_audit', 'design_review', 'code_audit'], description: 'Synthesis emphasis hint — affects labels only, never the agent count or schema. Distinct from task_kind (which selects the output schema).' },
            require_independent_evidence: { type: 'boolean', description: 'Default true — high-impact claims with no file:line/source evidence are routed to needs_verification.' },
            requireIndependentEvidence: { type: 'boolean', description: 'CamelCase alias for require_independent_evidence.' },
            include_stale: { type: 'boolean', description: 'Default false. By default, panel slots whose node HEAD commit differs from the coordinator reference commit are EXCLUDED (they would investigate different code). Set true to fan out to them anyway — results will be git-skewed and a warning is surfaced. If exclusion drops the panel below 2 independent targets the call errors rather than degrading to N=1; include_stale=true is one way to recover.' },
            includeStale: { type: 'boolean', description: 'CamelCase alias for include_stale.' },
            wait: { type: 'boolean', description: 'Default true — collect replica outputs and return the synthesis. Set false to dispatch async and return a consensusGroupId handle; collect later with mesh_magi_collect.' },
            wait_timeout_ms: { type: 'number', description: 'Max time to wait for replica completion before returning a partial "missing K of N" synthesis. Default 8 min, max 20 min.' },
            waitTimeoutMs: { type: 'number', description: 'CamelCase alias for wait_timeout_ms.' },
            auto_cleanup: { type: 'boolean', description: 'Default = mesh policy magiSessionCleanup (ON / stop_and_delete unless overridden). Once all replicas are terminal, stop+delete ONLY the worker sessions THIS fan-out auto-launched (marker-verified) so repeated reviews don\'t accumulate idle worker sessions. Reused/coordinator/other sessions are never touched. Set false to preserve auto-launched worker sessions for inspection. No effect on a partial (non-terminal) collection.' },
            autoCleanup: { type: 'boolean', description: 'CamelCase alias for auto_cleanup.' },
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
            consensusGroupId: { type: 'string', description: 'CamelCase alias for consensus_group_id.' },
            task_kind: { type: 'string', enum: ['claim_audit', 'rca', 'design', 'freeform'], description: 'Optional override of the task_kind used to parse replica answers. Normally recovered automatically from the original dispatch — only set this if the dispatched ledger entry was pruned and auto-recovery falls back to claim_audit incorrectly.' },
            taskKind: { type: 'string', enum: ['claim_audit', 'rca', 'design', 'freeform'], description: 'CamelCase alias for task_kind.' },
            require_independent_evidence: { type: 'boolean', description: 'Default true — high-impact claims with no file:line/source evidence are routed to needs_verification.' },
            requireIndependentEvidence: { type: 'boolean', description: 'CamelCase alias for require_independent_evidence.' },
            wait: { type: 'boolean', description: 'Default false (snapshot). Set true to block for outstanding replicas up to wait_timeout_ms before synthesizing.' },
            wait_timeout_ms: { type: 'number', description: 'When wait=true, max time to wait for remaining replica completion. Default 8 min, max 20 min.' },
            waitTimeoutMs: { type: 'number', description: 'CamelCase alias for wait_timeout_ms.' },
            auto_cleanup: { type: 'boolean', description: 'Default = mesh policy magiSessionCleanup (ON / stop_and_delete). When the collection is terminal, stop+delete ONLY the worker sessions THIS fan-out auto-launched (marker-verified). Reused/coordinator/other sessions are never touched. Set false to preserve them. No effect on a partial (non-terminal) snapshot.' },
            autoCleanup: { type: 'boolean', description: 'CamelCase alias for auto_cleanup.' },
            verbose: { type: 'boolean', description: 'Default false. When true, each synthesis.replicas[] entry also carries rawAnswer — the replica\'s raw end-user answer text (capped). Omitted by default to keep the payload small; the structured clusters already carry the parsed claims.' },
        },
        required: ['consensus_group_id'],
    },
};

// 2026-09-26 tool consolidation: the MAGI kind-panel set/list pair as one tool.
export const MESH_MAGI_KIND_PANEL_TOOL = {
    name: 'mesh_magi_kind_panel',
    description: 'Read or bind the MAGI kind→panel slot lists for THIS mesh (machine-local ~/.adhdev/meshes.json → `meshes[].magiKindPanels`). The binding is what `mesh_magi_review({ task_kind })` resolves to — the SOLE panel-resolution path. '
        + 'Use it when mesh_magi_review fails with magi_kind_not_configured, or to confirm what a task_kind resolves to before a review. SCOPE: PER MESH, machine-local (NOT repo-committed); another mesh on this machine keeps its own bindings. Select with `action` (REQUIRED):\n'
        + '• list — read-only: every configured kind binding, or just `task_kind`\'s. The response `scope` names the mesh. Args: task_kind.\n'
        + '• set — bind `task_kind` to `slots`. WHOLESALE REPLACEMENT: the slots become the kind\'s COMPLETE set (prior slots dropped, not merged), so present the current-vs-new lists (the dry-run returns `currentSlots`) and get EXPLICIT user approval before write=true. Defaults to dry-run. '
        + 'A slot\'s `nodeId`, when given, MUST name a node of this mesh — a foreign/unknown id is rejected (invalid_magi_kind_panel). Args: task_kind, slots, write.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            action: {
                type: 'string',
                enum: ['list', 'set'],
                description: 'Which panel operation to run (required). Each action accepts only its own arguments — see the tool description.',
            },
            task_kind: { type: 'string', description: 'The task_kind key, e.g. claim_audit / rca / design / freeform. Required for set; list: optional filter (omit to list all).' },
            slots: {
                type: 'array',
                description: 'set: the COMPLETE desired slot list for this kind (wholesale replacement). Each slot: { provider (REQUIRED), nodeId?, model?, capabilityTags?, n? }. Required for set.',
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
            write: { type: 'boolean', description: 'set: when true, persist the slot list (wholesale replacement) to meshes.json. Defaults false (dry-run preview of the normalized slots + currentSlots).' },
        },
        required: ['action'],
    },
};


// 2026-09-26 tool consolidation: set / list / propose on a node's capability
// slots are one tool, selected by `action` (per-action argument sets enforced in
// validate-tool-args.ts MESH_TOOL_ACTIONS).
export const MESH_NODE_SLOTS_TOOL = {
    name: 'mesh_node_slots',
    description: 'Read, draft, or change a mesh node\'s capability slots (policy.slots) — the provider/model/thinking + difficulty + capability-tag profile that task→node fitness routing and MAGI fan-out match against. '
        + 'Use it when routing keeps landing work on a poor-fit node, when a node has no slots, or after CLI agents were installed on a node. Select with `action` (REQUIRED):\n'
        + '• list — read-only: the node\'s current slots. Args: node_id.\n'
        + '• propose — read-only AUTO-DETECT: probes the node\'s installed CLI agents (get_status_metadata → availableProviders, category=cli + installed=true), maps each through a seeded provider→(model/thinkingLevel/difficulty/maxParallel) table, and returns `proposedSlots` with per-slot rationale plus `droppedSlots` / `droppedProviders` / `destructive` '
        + '(hand-tuned slots, tuned maxParallel, providers not on PATH are NOT preserved by the draft — present those before approving). Detects nothing → proposes nothing. Never writes. Args: node_id, include_magi.\n'
        + '• set — PROPOSE (dry-run, default) or APPLY (write=true) a slot list. WHOLESALE REPLACEMENT: the `slots` you pass become the COMPLETE new list; any prior slot not in it is dropped. The dry-run returns `currentSlots` vs `proposedSlots` — present the diff and get EXPLICIT user approval before write=true. Apply goes through update_mesh_node (machine-local node policy). Args: node_id, slots, reason, write.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            action: {
                type: 'string',
                enum: ['list', 'propose', 'set'],
                description: 'Which slot operation to run (required). Each action accepts only its own arguments — see the tool description.',
            },
            node_id: { type: 'string', description: 'REQUIRED — the mesh node id. All actions.' },
            nodeId: { type: 'string', description: 'CamelCase alias for node_id.' },
            slots: {
                type: 'array',
                description: 'set: the COMPLETE desired capability-slot list (wholesale replacement). Each slot: { provider (REQUIRED), model?, thinkingLevel?, difficulty?, capability?, maxParallel? }. Required for set.',
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
            reason: { type: 'string', description: 'set: optional short rationale, echoed in the dry-run so the user sees WHY the change is suggested.' },
            write: { type: 'boolean', description: 'set: when true, apply the slot list (wholesale replacement). Defaults false (dry-run preview of proposedSlots + currentSlots).' },
            include_magi: { type: 'boolean', description: 'propose: also draft a MAGI panel (one slot per detected provider, pinned to this node, models unpinned) for binding via mesh_magi_kind_panel action "set". Defaults false. Deliberately NOT a per-task_kind assignment — provider manifests carry no rca/design/claim_audit suitability data.' },
            includeMagi: { type: 'boolean', description: 'CamelCase alias for include_magi.' },
        },
        required: ['action', 'node_id'],
    },
};




// 2026-09-26 tool consolidation: the coordinator prompt APPEND get/set pair as one tool.
export const MESH_COORDINATOR_PROMPT_APPEND_TOOL = {
    name: 'mesh_coordinator_prompt_append',
    description: 'Read or write the user-level coordinator prompt APPEND text for a CLI type — the per-machine file ~/.adhdev/coordinator-prompts/<cli>.append.md on this MCP server\'s daemon, applied to every mesh this daemon coordinates. '
        + 'Use it only when the user asks to add a standing instruction to every coordinator on this machine. Select with `action` (REQUIRED):\n'
        + '• get — read the current append text. Read it before `set` so you know what you would replace. Args: cli_type.\n'
        + '• set — write (or, with empty/omitted content, clear) the append file. WHOLESALE REPLACE of the whole file, not an incremental add. Args: cli_type, content.\n'
        + 'APPEND ONLY (a safety boundary, not a missing feature): this always stacks AFTER whichever base prompt wins; it can NEVER replace the daemon\'s base coordinator prompt (the OVERRIDE file) — that stays a dashboard-only, human-gated action, so a coordinator cannot erase its own core operating rules.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            action: {
                type: 'string',
                enum: ['get', 'set'],
                description: 'get = read the append text; set = replace (or clear) it. Required.',
            },
            cli_type: { type: 'string', description: 'CLI type key, e.g. "claude-cli", "codex-cli". Defaults to "default" (applies to every CLI type without its own file).' },
            content: { type: 'string', description: 'set: the full append text to write. Omit or pass an empty string to clear (delete the file, falling back to no append at this layer).' },
        },
        required: ['action'],
    },
};


/**
 * E-T0 (design §7.1) — deposit an urgent memo into a delegated worker's
 * mailbox. Delivered on the worker's NEXT MCP tool response (report_completion,
 * progress_update, peer_context_pull, even git_status — whichever it calls
 * first), never mid-turn: this repo has no hook infrastructure to interrupt a
 * generating turn (§7.3), and T3's destructive interrupt is a different,
 * much costlier tool for a different situation (aborts the turn outright).
 *
 * ★NOT in `ALL_MESH_TOOLS` — this tool is published only when the worker-MCP
 * flag is on (server.ts gates it explicitly), so a flag-off coordinator's
 * ListTools response stays byte-identical to before E-T0 existed. See
 * `mesh-tools-session.ts`'s `meshNotifyWorker` for the implementation and
 * `commands/low-family/worker-mailbox.ts` for the daemon-side gate that backs
 * this up even if a caller invokes the tool name without it being listed.
 */
export const MESH_NOTIFY_WORKER_TOOL = {
    name: 'mesh_notify_worker',
    description: 'Send an urgent memo to a delegated worker\'s task. Delivered on the worker\'s NEXT MCP tool call '
        + '(report_completion / progress_update / peer_context_pull / git_status — whichever it calls first), '
        + 'NOT instantly — this does not interrupt a running generation turn. Use for something the worker needs '
        + 'to know before it finishes (a changed requirement, a reason to stop) that does not justify aborting its '
        + "turn outright (mesh_send_task's delivery_mode: 'interrupt' does that, destructively). Requires ADHDEV_WORKER_MCP "
        + 'to be enabled on the target daemon; refused otherwise.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID (from mesh_list_nodes) — the node the worker is running on.' },
            task_id: { type: 'string', description: 'The worker\'s task ID (from mesh_view_queue / mesh_task_history).' },
            message: { type: 'string', description: 'The urgent memo text, in your own words. Kept short — this rides inside a tool response, not a full document.' },
        },
        required: ['node_id', 'task_id', 'message'],
    },
};

/**
 * The published mesh tool registry.
 *
 * Source-shape contract for docs:verify (`scripts/verify-docs.mjs`
 * countAllMeshTools): keep this as a bare array-literal assignment. Wrapping
 * the initializer in annotateAll() broke that parser (source-shape guard).
 *
 * Annotations are applied immediately after as copies: the `*_TOOL` consts
 * above stay un-annotated and are still exported individually. `annotateAll`
 * THROWS for a tool with no classification, so adding a tool here without
 * classifying it still fails at module load instead of publishing a hint-less
 * tool. The classification itself lives in tool-annotations.ts.
 */
export const ALL_MESH_TOOLS = [
    MESH_STATUS_TOOL,
    MESH_ROUTE_PREVIEW_TOOL,
    MESH_LIST_NODES_TOOL,
    // graph-orchestration-simplification D1 — task BEFORE batch. Registry order
    // is what a client that lists tools without ranking sees first, so the
    // incremental default (`mesh_enqueue_task` + `depends_on`) leads and the
    // settled-plan batch follows it (reversal of Phase F's batch-first order).
    MESH_ENQUEUE_TASK_TOOL,
    MESH_ENQUEUE_BATCH_TOOL,
    MESH_VIEW_QUEUE_TOOL,
    // GRAPH-ORCHESTRATION Phase E — placed next to the queue/enqueue tools so a
    // coordinator that loaded the batch schema also discovers how to pass a gate.
    MESH_GRAPH_VIEW_TOOL,
    MESH_GRAPH_GATE_TOOL,
    MESH_GRAPH_NODE_PATCH_TOOL,
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
    MESH_CREATE_TOOL,
    MESH_ADD_NODE_TOOL,
    MESH_CLONE_NODE_TOOL,
    MESH_REMOVE_NODE_TOOL,
    MESH_CLEANUP_WORKTREE_NODES_TOOL,
    MESH_REFINE_NODE_TOOL,
    MESH_REFINE_BATCH_TOOL,
    MESH_CONFIG_TOOL,
    MESH_INIT_TOOL,
    MESH_REFINE_PLAN_TOOL,
    MESH_CLEANUP_SESSIONS_TOOL,
    MESH_TASK_HISTORY_TOOL,
    MESH_LEDGER_QUERY_TOOL,
    MESH_NOTE_TOOL,
    MESH_RECONCILE_LEDGER_TOOL,
    MESH_MISSION_UPSERT_TOOL,
    MESH_MISSION_LIST_TOOL,
    MESH_REVIEW_INBOX_TOOL,
    MESH_MAGI_REVIEW_TOOL,
    MESH_MAGI_COLLECT_TOOL,
    MESH_MAGI_KIND_PANEL_TOOL,
    MESH_NODE_SLOTS_TOOL,
    MESH_COORDINATOR_PROMPT_APPEND_TOOL,
];

// Replace each slot with an annotated copy. Does not mutate the `*_TOOL`
// consts (annotateAll copies). Keep this AFTER the array literal so the
// docs:verify parser still matches the assignment as an array literal.
Object.assign(ALL_MESH_TOOLS, annotateAll(ALL_MESH_TOOLS));
