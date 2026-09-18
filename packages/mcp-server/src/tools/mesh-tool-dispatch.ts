/**
 * Mesh-mode dispatch registry.
 *
 * ★WHY THIS IS A TABLE AND NOT A SWITCH
 *
 * Publishing a mesh tool used to require edits in two unrelated places: the
 * `ALL_MESH_TOOLS` schema registry (what `ListTools` advertises) and a `switch`
 * in server.ts (what a `CallTool` actually runs). Nothing tied them together.
 * Adding a tool to the registry and forgetting the switch case produced a tool
 * that a coordinator can SEE and call, and that answers `Unknown tool: <name>`
 * at runtime — with no compile error and no failing test.
 *
 * Measured (2026-09-18) before this change: deleting the `mesh_record_note`
 * case from the switch left `tsc --noEmit` clean and all 786 mcp-server tests
 * green, while the tool stayed published. That is the silent-omission class
 * this table closes.
 *
 * The key type is `CanonicalMeshToolName` — the same dependency-free leaf list
 * (mesh-shared `mesh-tool-names.ts`) that the 6-6 consistency test already
 * pins `ALL_MESH_TOOLS`, the coordinator-prompt TOOLS table, and the barrel
 * doc comments to. Because this is a `Record<CanonicalMeshToolName, Handler>`
 * rather than a partial map, TypeScript enforces BOTH directions:
 *
 *   - a canonical tool with no handler  → TS2741 "Property 'x' is missing"
 *   - a handler for a non-canonical name → TS2353 "Object literal may only
 *     specify known properties"
 *
 * So the registry, the prompt, the docs and the executable dispatch now all
 * fail at compile time on the same list, instead of three of them agreeing
 * while the fourth silently drifts.
 *
 * ★Aliases are deliberately NOT in this table — see MESH_ALIAS_DISPATCH below.
 */
import type { CanonicalMeshToolName } from '@adhdev/daemon-core';

import type { MeshContext } from './mesh-tools.js';
import {
    meshStatus, meshRoutePreview, meshListNodes, meshSendTask, meshReadChat,
    meshEnqueueTask, meshEnqueueBatch, meshViewQueue, meshQueueCancel, meshQueueRequeue,
    meshGraphView, meshGraphGateClaim, meshGraphGateRelease, meshGraphGateAbandon, meshGraphNodePatch,
    meshReadDebug, meshReadTerminal, meshSendKeys,
    meshLaunchSession, meshGitStatus, meshReadNodeLogs, meshFastForwardNode, meshRestartDaemon,
    meshCheckpoint, meshApprove, meshAnswerQuestion, meshListPendingApprovals,
    meshPlanOnboarding, meshCreate, meshAddNode,
    meshCloneNode, meshRemoveNode, meshCleanupWorktreeNodes, meshRefineNode,
    meshRefineConfig, meshInit, meshReinit, meshRefinePlan, meshRefineBatch,
    meshChangeImpactConfig,
    meshCleanupSessions, meshPruneStaleDirect, meshTaskHistory, meshLedgerQuery,
    meshRecordNote, meshForgetNote, meshReconcileLedger, meshRequeueHeldEvents,
    meshMissionUpsert, meshMissionList, meshReviewInbox,
    meshMagiReview, meshMagiCollect,
    meshMagiKindPanelSet, meshMagiKindPanelList, meshWriteMeshJsonConfig,
    meshNodeSlotsSet, meshNodeSlotsList, meshNodeSlotsPropose,
    meshCoordinatorPromptAppendGet, meshCoordinatorPromptAppendSet,
} from './mesh-tools.js';

/**
 * Every mesh tool reduces to the same call shape: take the mesh context and the
 * raw argument bag, return the text the MCP response carries. Tools that ignore
 * their arguments simply do not name the second parameter.
 */
export type MeshToolHandler = (ctx: MeshContext, args: Record<string, any>) => Promise<string>;

/**
 * ★Exhaustive by construction. Do not widen this to `Partial<…>` or to
 * `Record<string, …>` — the whole point is that the compiler refuses an
 * incomplete table.
 */
export const MESH_TOOL_DISPATCH: Readonly<Record<CanonicalMeshToolName, MeshToolHandler>> = {
    mesh_status: (ctx, a) => meshStatus(ctx, a as any),
    mesh_route_preview: (ctx, a) => meshRoutePreview(ctx, a as any),
    mesh_list_nodes: (ctx) => meshListNodes(ctx),
    mesh_enqueue_task: (ctx, a) => meshEnqueueTask(ctx, a as any),
    mesh_enqueue_batch: (ctx, a) => meshEnqueueBatch(ctx, a as any),
    mesh_view_queue: (ctx, a) => meshViewQueue(ctx, a as any),
    mesh_graph_view: (ctx, a) => meshGraphView(ctx, a as any),
    mesh_graph_gate_claim: (ctx, a) => meshGraphGateClaim(ctx, a as any),
    mesh_graph_gate_release: (ctx, a) => meshGraphGateRelease(ctx, a as any),
    mesh_graph_gate_abandon: (ctx, a) => meshGraphGateAbandon(ctx, a as any),
    mesh_graph_node_patch: (ctx, a) => meshGraphNodePatch(ctx, a as any),
    mesh_queue_cancel: (ctx, a) => meshQueueCancel(ctx, a as any),
    mesh_queue_requeue: (ctx, a) => meshQueueRequeue(ctx, a as any),
    mesh_send_task: (ctx, a) => meshSendTask(ctx, a as any),
    mesh_read_chat: (ctx, a) => meshReadChat(ctx, a as any),
    mesh_read_debug: (ctx, a) => meshReadDebug(ctx, a as any),
    mesh_read_terminal: (ctx, a) => meshReadTerminal(ctx, a as any),
    mesh_send_keys: (ctx, a) => meshSendKeys(ctx, a as any),
    mesh_launch_session: (ctx, a) => meshLaunchSession(ctx, a as any),
    mesh_git_status: (ctx, a) => meshGitStatus(ctx, a as any),
    mesh_read_node_logs: (ctx, a) => meshReadNodeLogs(ctx, a as any),
    mesh_fast_forward_node: (ctx, a) => meshFastForwardNode(ctx, a as any),
    mesh_restart_daemon: (ctx, a) => meshRestartDaemon(ctx, a as any),
    mesh_checkpoint: (ctx, a) => meshCheckpoint(ctx, a as any),
    mesh_approve: (ctx, a) => meshApprove(ctx, a as any),
    mesh_answer_question: (ctx, a) => meshAnswerQuestion(ctx, a as any),
    mesh_list_pending_approvals: (ctx, a) => meshListPendingApprovals(ctx, a as any),
    mesh_plan_onboarding: (ctx, a) => meshPlanOnboarding(ctx.transport, a as any, ctx.mesh.id),
    mesh_create: (ctx, a) => meshCreate(ctx.transport, a as any),
    mesh_add_node: (ctx, a) => meshAddNode(ctx.transport, { ...a, inline_mesh: ctx.mesh } as any, ctx.mesh.id),
    mesh_clone_node: (ctx, a) => meshCloneNode(ctx, a as any),
    mesh_remove_node: (ctx, a) => meshRemoveNode(ctx, a as any),
    mesh_cleanup_worktree_nodes: (ctx, a) => meshCleanupWorktreeNodes(ctx, a as any),
    mesh_refine_node: (ctx, a) => meshRefineNode(ctx, a as any),
    mesh_refine_batch: (ctx, a) => meshRefineBatch(ctx, a as any),
    mesh_refine_config: (ctx, a) => meshRefineConfig(ctx, a as any),
    mesh_change_impact_config: (ctx, a) => meshChangeImpactConfig(ctx, a as any),
    mesh_init: (ctx, a) => meshInit(ctx, a as any),
    mesh_reinit: (ctx, a) => meshReinit(ctx, a as any),
    mesh_write_mesh_json_config: (ctx, a) => meshWriteMeshJsonConfig(ctx, a as any),
    mesh_refine_plan: (ctx, a) => meshRefinePlan(ctx, a as any),
    mesh_cleanup_sessions: (ctx, a) => meshCleanupSessions(ctx, a as any),
    mesh_prune_stale_direct: (ctx, a) => meshPruneStaleDirect(ctx, a as any),
    mesh_task_history: (ctx, a) => meshTaskHistory(ctx, a as any),
    mesh_ledger_query: (ctx, a) => meshLedgerQuery(ctx, a as any),
    mesh_record_note: (ctx, a) => meshRecordNote(ctx, a as any),
    mesh_forget_note: (ctx, a) => meshForgetNote(ctx, a as any),
    mesh_reconcile_ledger: (ctx, a) => meshReconcileLedger(ctx, a as any),
    mesh_requeue_held_events: (ctx, a) => meshRequeueHeldEvents(ctx, a as any),
    mesh_mission_upsert: (ctx, a) => meshMissionUpsert(ctx, a as any),
    mesh_mission_list: (ctx, a) => meshMissionList(ctx, a as any),
    mesh_review_inbox: (ctx, a) => meshReviewInbox(ctx, a as any),
    mesh_magi_review: (ctx, a) => meshMagiReview(ctx, a as any),
    mesh_magi_collect: (ctx, a) => meshMagiCollect(ctx, a as any),
    mesh_magi_kind_panel_set: (ctx, a) => meshMagiKindPanelSet(ctx, a as any),
    mesh_magi_kind_panel_list: (ctx, a) => meshMagiKindPanelList(ctx, a as any),
    mesh_node_slots_set: (ctx, a) => meshNodeSlotsSet(ctx, a as any),
    mesh_node_slots_list: (ctx, a) => meshNodeSlotsList(ctx, a as any),
    mesh_node_slots_propose: (ctx, a) => meshNodeSlotsPropose(ctx, a as any),
    mesh_coordinator_prompt_append_get: (ctx, a) => meshCoordinatorPromptAppendGet(ctx, a as any),
    mesh_coordinator_prompt_append_set: (ctx, a) => meshCoordinatorPromptAppendSet(ctx, a as any),};

/**
 * Hidden 1-release aliases (Part 8-4 and its change-impact symmetric) plus the
 * flag-gated `mesh_notify_worker`.
 *
 * ★These are kept OUT of MESH_TOOL_DISPATCH on purpose, and the separation is
 * load-bearing rather than stylistic: they are exactly the names that are
 * dispatchable but NOT published in `ALL_MESH_TOOLS`. Folding them into the
 * canonical table would require the table's key type to be wider than
 * `CanonicalMeshToolName`, which is the one property that makes the table
 * self-checking. Keeping them separate lets the canonical table stay exact
 * while these stay callable.
 *
 * Aliases forward to the unified handler with `mode` injected, so a
 * pre-consolidation caller keeps working. `mesh_notify_worker` is not an alias
 * — it is handled in server.ts because its behaviour depends on a runtime flag
 * read, not on a fixed argument rewrite.
 */
export const MESH_ALIAS_DISPATCH: Readonly<Record<string, MeshToolHandler>> = {
    mesh_refine_config_schema: (ctx, a) => meshRefineConfig(ctx, { ...(a as any), mode: 'schema' }),
    mesh_validate_refine_config: (ctx, a) => meshRefineConfig(ctx, { ...(a as any), mode: 'validate' }),
    mesh_suggest_refine_config: (ctx, a) => meshRefineConfig(ctx, { ...(a as any), mode: 'suggest' }),
    mesh_change_impact_config_schema: (ctx, a) => meshChangeImpactConfig(ctx, { ...(a as any), mode: 'schema' }),
    mesh_validate_change_impact_config: (ctx, a) => meshChangeImpactConfig(ctx, { ...(a as any), mode: 'validate' }),
    mesh_suggest_change_impact_config: (ctx, a) => meshChangeImpactConfig(ctx, { ...(a as any), mode: 'suggest' }),
};

/** Resolve a CallTool name to its handler, or undefined for an unknown tool. */
export function resolveMeshToolHandler(name: string): MeshToolHandler | undefined {
    return (MESH_TOOL_DISPATCH as Record<string, MeshToolHandler>)[name] ?? MESH_ALIAS_DISPATCH[name];
}
