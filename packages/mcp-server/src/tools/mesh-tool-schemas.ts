/**
 * MCP tool schema definitions for the mesh_* tool family.
 *
 * Pure data: the status-domain tool schemas plus the ALL_MESH_TOOLS registry. The
 * other domains' schemas live beside it (mesh-tool-schemas-{queue,session,admin,
 * refine-config}.ts, shared input sub-schemas in mesh-tool-input-schemas.ts); the
 * handlers are in the mesh-tools-* modules and mesh-tools.ts is the barrel.
 */

import { annotateAll } from './tool-annotations.js';
// Wiring-unification A3: every vocabulary enum is derived from the ONE tuple in
// mesh-shared via enumOf(), so the published schema cannot drift from the code.
// Tool-local enums (mission status, key names, …) stay inline.
import { enumOf, MESH_TASK_DIFFICULTIES } from '@adhdev/mesh-shared';
import { MESH_ENQUEUE_TASK_TOOL, MESH_ENQUEUE_BATCH_TOOL, MESH_VIEW_QUEUE_TOOL, MESH_QUEUE_CANCEL_TOOL, MESH_QUEUE_REQUEUE_TOOL } from './mesh-tool-schemas-queue.js';
import { MESH_SEND_TASK_TOOL, MESH_READ_CHAT_TOOL, MESH_READ_DEBUG_TOOL, MESH_READ_TERMINAL_TOOL, MESH_SEND_KEYS_TOOL, MESH_LAUNCH_SESSION_TOOL, MESH_GIT_STATUS_TOOL, MESH_READ_NODE_LOGS_TOOL, MESH_FAST_FORWARD_NODE_TOOL, MESH_RESTART_DAEMON_TOOL, MESH_CHECKPOINT_TOOL } from './mesh-tool-schemas-session.js';
import { MESH_MISSION_UPSERT_TOOL, MESH_MISSION_LIST_TOOL, MESH_APPROVE_TOOL, MESH_ANSWER_QUESTION_TOOL, MESH_LIST_PENDING_APPROVALS_TOOL, MESH_CREATE_TOOL, MESH_ADD_NODE_TOOL, MESH_CLONE_NODE_TOOL, MESH_REMOVE_NODE_TOOL, MESH_CLEANUP_WORKTREE_NODES_TOOL, MESH_CLEANUP_SESSIONS_TOOL, MESH_TASK_HISTORY_TOOL, MESH_LEDGER_QUERY_TOOL, MESH_NOTE_TOOL, MESH_RECONCILE_LEDGER_TOOL } from './mesh-tool-schemas-admin.js';
import { MESH_REFINE_NODE_TOOL, MESH_REFINE_BATCH_TOOL, MESH_CONFIG_TOOL, MESH_INIT_TOOL, MESH_REFINE_PLAN_TOOL, MESH_REVIEW_INBOX_TOOL, MESH_NODE_SLOTS_TOOL, MESH_COORDINATOR_PROMPT_APPEND_TOOL } from './mesh-tool-schemas-refine-config.js';

export const MESH_STATUS_TOOL = {
    name: 'mesh_status',
    description: 'Get the current status of all nodes in the repo mesh — health, git state, active sessions, recovery hints, and recommended next steps. Node git is the coordinator daemon\'s held state (never a live remote probe); per-node gitObservation {source, observedAt, refreshing, unreachableSince} and dataFreshness say how old it is. Use this to decide which node to send work to or how to recover from failures. '
        + 'Also reports the running daemon build per daemonId under daemonBuilds ({commit, commitShort, version, track}; track is unknown for legacy peers, never inferred from an rc suffix). staleDaemonBuilds[]/staleDaemonBuildWarning flags a live daemon built BEHIND its workspace HEAD — a merged fix not yet live (awaiting deploy/restart; a local dist rebuild does not update a cloud daemon). daemonUpgradeFailures{daemonId → {summary, recordedAt, ageLabel, targetVersion, noticePath, logPath}}/daemonUpgradeFailureWarning flags a daemon whose LAST upgrade failed and rolled back (still on the PREVIOUS version; an upgrade/restart response only ever reports "scheduled", never success). '
        + 'Do not repeatedly call this to wait for generating delegated work; wait for pendingCoordinatorEvents/completion events or an explicit user status request.',
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
            readonly: {
                type: 'boolean' as const,
                description: 'Whether to preview read-only scheduling semantics, including the reserved-last-slot capacity rule.',
            },
            target_node_id: {
                type: 'string' as const,
                description: 'Optional node pin. When omitted, preview all eligible nodes in scheduling order.',
            },
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
    // Task BEFORE batch. Registry order is what a client that lists tools
    // without ranking sees first, so the incremental default
    // (`mesh_enqueue_task` + `depends_on`) leads and the batch follows it.
    MESH_ENQUEUE_TASK_TOOL,
    MESH_ENQUEUE_BATCH_TOOL,
    MESH_VIEW_QUEUE_TOOL,
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
    MESH_NODE_SLOTS_TOOL,
    MESH_COORDINATOR_PROMPT_APPEND_TOOL,
];

// Replace each slot with an annotated copy. Does not mutate the `*_TOOL`
// consts (annotateAll copies). Keep this AFTER the array literal so the
// docs:verify parser still matches the assignment as an array literal.
Object.assign(ALL_MESH_TOOLS, annotateAll(ALL_MESH_TOOLS));
