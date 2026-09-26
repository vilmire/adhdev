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
    'mesh_route_preview',
    'mesh_list_nodes',
    // GRAPH-ORCHESTRATION Phase F — batch before task, mirroring ALL_MESH_TOOLS.
    'mesh_enqueue_batch',
    'mesh_enqueue_task',
    'mesh_view_queue',
    // GRAPH-ORCHESTRATION Phase E — the coordinator gate + graph view surface.
    'mesh_graph_view',
    'mesh_graph_gate',
    'mesh_graph_node_patch',
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
    'mesh_create',
    'mesh_add_node',
    'mesh_clone_node',
    'mesh_remove_node',
    'mesh_cleanup_worktree_nodes',
    'mesh_refine_node',
    'mesh_refine_batch',
    'mesh_config',
    'mesh_init',
    'mesh_refine_plan',
    'mesh_cleanup_sessions',
    'mesh_task_history',
    'mesh_ledger_query',
    'mesh_note',
    'mesh_reconcile_ledger',
    'mesh_mission_upsert',
    'mesh_mission_list',
    'mesh_review_inbox',
    'mesh_magi_review',
    'mesh_magi_collect',
    'mesh_magi_kind_panel',
    'mesh_node_slots',
    'mesh_coordinator_prompt_append',
] as const;

export type CanonicalMeshToolName = typeof CANONICAL_MESH_TOOL_NAMES[number];

/** The count the `NN tools` barrel doc comments and consistency test assert against. */
export const CANONICAL_MESH_TOOL_COUNT = CANONICAL_MESH_TOOL_NAMES.length;

/**
 * Tool names retired by the 2026-09-26 tool-surface consolidation (60 → 48).
 * Every capability behind them is still reachable: each retired name maps to the
 * merged tool plus the discriminator argument that selects the same behaviour.
 *
 * mcp-server answers a call to a retired name with an error naming the
 * replacement (it does NOT forward silently — a coordinator running an old
 * prompt must learn the new spelling), and the daemon-core coordinator prompt
 * test asserts none of these names is advertised anywhere in the prompt.
 *
 * `args` is the discriminator to add; every other argument keeps its name.
 * `note` covers the one rename where an argument moved (the old
 * `mesh_graph_gate_claim({ extend_seconds })` extend-only mode).
 */
export const RETIRED_MESH_TOOLS: Readonly<Record<string, {
    readonly tool: CanonicalMeshToolName;
    readonly args: Readonly<Record<string, string>>;
    readonly note?: string;
}>> = {
    mesh_graph_gate_claim: {
        tool: 'mesh_graph_gate',
        args: { action: 'claim' },
        note: 'The extend-only form (claim with extend_seconds) is now action: "extend" with the same extend_seconds.',
    },
    mesh_graph_gate_release: { tool: 'mesh_graph_gate', args: { action: 'release' } },
    mesh_graph_gate_abandon: { tool: 'mesh_graph_gate', args: { action: 'abandon' } },
    // Never a published tool (it is the daemon command behind the extend verb),
    // but an older gate-expiry notice told coordinators to call it by this name.
    mesh_graph_gate_extend: { tool: 'mesh_graph_gate', args: { action: 'extend' } },
    mesh_node_slots_set: { tool: 'mesh_node_slots', args: { action: 'set' } },
    mesh_node_slots_list: { tool: 'mesh_node_slots', args: { action: 'list' } },
    mesh_node_slots_propose: { tool: 'mesh_node_slots', args: { action: 'propose' } },
    mesh_magi_kind_panel_set: { tool: 'mesh_magi_kind_panel', args: { action: 'set' } },
    mesh_magi_kind_panel_list: { tool: 'mesh_magi_kind_panel', args: { action: 'list' } },
    mesh_coordinator_prompt_append_get: { tool: 'mesh_coordinator_prompt_append', args: { action: 'get' } },
    mesh_coordinator_prompt_append_set: { tool: 'mesh_coordinator_prompt_append', args: { action: 'set' } },
    mesh_record_note: { tool: 'mesh_note', args: { action: 'record' } },
    mesh_forget_note: { tool: 'mesh_note', args: { action: 'forget' } },
    mesh_reinit: { tool: 'mesh_init', args: { mode: 'reinit' } },
    mesh_refine_config: { tool: 'mesh_config', args: { kind: 'refine' } },
    mesh_change_impact_config: { tool: 'mesh_config', args: { kind: 'change_impact' } },
    mesh_write_mesh_json_config: { tool: 'mesh_config', args: { kind: 'mesh_json' } },
    mesh_plan_onboarding: { tool: 'mesh_create', args: { mode: 'plan' } },
    mesh_prune_stale_direct: { tool: 'mesh_cleanup_sessions', args: { mode: 'prune_stale_direct' } },
};

/**
 * The error text for a call to a retired tool name, or null when `name` is not
 * retired. One wording shared by every MCP mode so the redirect reads the same
 * wherever an old prompt calls it.
 */
export function retiredMeshToolError(name: string): string | null {
    const entry = Object.prototype.hasOwnProperty.call(RETIRED_MESH_TOOLS, name) ? RETIRED_MESH_TOOLS[name] : undefined;
    if (!entry) return null;
    const discriminator = Object.entries(entry.args).map(([k, v]) => `${k}: "${v}"`).join(', ');
    return `Tool "${name}" was retired (merged into ${entry.tool}). Call ${entry.tool} with ${discriminator} and the same other arguments.`
        + (entry.note ? ` ${entry.note}` : '');
}
