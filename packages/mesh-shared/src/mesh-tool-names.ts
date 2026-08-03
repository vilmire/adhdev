/**
 * Canonical Repo Mesh coordinator tool-name registry — the single source of truth
 * the three surfaces must agree on:
 *
 *   1. mcp-server `ALL_MESH_TOOLS` (the published MCP tool schemas),
 *   2. daemon-core `coordinator-prompt.ts` `TOOLS_SECTION` (what the coordinator LLM
 *      is told it can call), and
 *   3. the `NN tools` doc comments in the mesh-tools barrels.
 *
 * mcp-server does not depend on daemon-core's internal prompt, and daemon-core cannot
 * import mcp-server (dependency direction: daemon-core ← mcp-server). This dependency-
 * free leaf is the only place both can reference, so the 6-6 consistency test
 * (daemon-core coordinator-prompt.test.ts) and mcp-server both assert against THIS
 * list. Adding a new mesh tool means adding its name here first; the tests then force
 * the schema + prompt + barrel comment to catch up, which is exactly the regression
 * gate that let coordinator-prompt drift 14 tools behind the schema before.
 *
 * Order mirrors mcp-server `ALL_MESH_TOOLS` for easy visual diffing, but the consistency
 * checks are set-based (order-insensitive).
 */
export const CANONICAL_MESH_TOOL_NAMES = [
    'mesh_status',
    'mesh_list_nodes',
    'mesh_enqueue_task',
    'mesh_view_queue',
    'mesh_queue_cancel',
    'mesh_queue_requeue',
    'mesh_send_task',
    'mesh_read_chat',
    'mesh_read_debug',
    'mesh_read_terminal',
    'mesh_send_keys',
    'mesh_launch_session',
    'mesh_git_status',
    'mesh_read_node_logs',
    'mesh_fast_forward_node',
    'mesh_restart_daemon',
    'mesh_checkpoint',
    'mesh_approve',
    'mesh_answer_question',
    'mesh_list_pending_approvals',
    'mesh_plan_onboarding',
    'mesh_create',
    'mesh_add_node',
    'mesh_clone_node',
    'mesh_remove_node',
    'mesh_cleanup_worktree_nodes',
    'mesh_refine_node',
    'mesh_refine_batch',
    'mesh_refine_config',
    'mesh_change_impact_config',
    'mesh_init',
    'mesh_reinit',
    'mesh_write_mesh_json_config',
    'mesh_refine_plan',
    'mesh_cleanup_sessions',
    'mesh_prune_stale_direct',
    'mesh_task_history',
    'mesh_ledger_query',
    'mesh_record_note',
    'mesh_forget_note',
    'mesh_reconcile_ledger',
    'mesh_requeue_held_events',
    'mesh_mission_upsert',
    'mesh_mission_list',
    'mesh_review_inbox',
    'mesh_magi_review',
    'mesh_magi_collect',
    'mesh_magi_kind_panel_set',
    'mesh_magi_kind_panel_list',
    'mesh_node_slots_set',
    'mesh_node_slots_list',
    'mesh_node_slots_propose',
] as const;

export type CanonicalMeshToolName = typeof CANONICAL_MESH_TOOL_NAMES[number];

/** The count the `NN tools` barrel doc comments and consistency test assert against. */
export const CANONICAL_MESH_TOOL_COUNT = CANONICAL_MESH_TOOL_NAMES.length;
