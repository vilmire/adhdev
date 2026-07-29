/**
 * Mesh Tools — Mesh-scoped coordinator tools for Repo Mesh orchestration
 *
 * These tools wrap existing MCP transport operations but restrict targets
 * to mesh member nodes only. The coordinator uses these to delegate work
 * to agents across the mesh via natural conversation.
 *
 * 51 tools (== ALL_MESH_TOOLS, kept in sync with the coordinator-prompt TOOLS table
 * by the 6-6 consistency test in daemon-core coordinator-prompt.test.ts):
 *   mesh_status, mesh_list_nodes, mesh_enqueue_task, mesh_view_queue,
 *   mesh_queue_cancel, mesh_queue_requeue, mesh_send_task, mesh_read_chat,
 *   mesh_read_debug, mesh_read_terminal, mesh_send_keys, mesh_launch_session, mesh_git_status, mesh_read_node_logs,
 *   mesh_fast_forward_node, mesh_restart_daemon, mesh_checkpoint, mesh_approve,
 *   mesh_plan_onboarding, mesh_create, mesh_add_node,
 *   mesh_answer_question, mesh_list_pending_approvals,
 *   mesh_clone_node, mesh_remove_node, mesh_cleanup_worktree_nodes, mesh_refine_node, mesh_refine_batch,
 *   mesh_refine_config, mesh_change_impact_config, mesh_init, mesh_reinit,
 *   mesh_write_mesh_json_config, mesh_refine_plan, mesh_cleanup_sessions,
 *   mesh_prune_stale_direct, mesh_task_history, mesh_ledger_query,
 *   mesh_record_note, mesh_forget_note, mesh_reconcile_ledger,
 *   mesh_requeue_held_events,
 *   mesh_mission_upsert, mesh_mission_list, mesh_review_inbox, mesh_magi_review,
 *   mesh_magi_collect,
 *   mesh_magi_kind_panel_set, mesh_magi_kind_panel_list
 */

// This module is a re-export barrel. The implementation was split by domain into
// mesh-tools-{status,queue,mission,session,git,refine}.ts, with shared helpers, types,
// module state and schema/identity re-exports in mesh-tools-internal.ts. The names below are
// EXACTLY the public surface mesh-tools.ts exposed before the split (verified by export diff).

export {
    ALL_MESH_TOOLS,
    MESH_APPROVE_TOOL,
    MESH_ANSWER_QUESTION_TOOL,
    MESH_CHANGE_IMPACT_CONFIG_TOOL,
    MESH_CHECKPOINT_TOOL,
    MESH_CLEANUP_SESSIONS_TOOL,
    MESH_CLEANUP_WORKTREE_NODES_TOOL,
    MESH_CREATE_TOOL,
    MESH_ADD_NODE_TOOL,
    MESH_CLONE_NODE_TOOL,
    MESH_ENQUEUE_TASK_TOOL,
    MESH_FAST_FORWARD_NODE_TOOL,
    MESH_GIT_STATUS_TOOL,
    MESH_INIT_TOOL,
    MESH_REINIT_TOOL,
    MESH_WRITE_MESH_JSON_CONFIG_TOOL,
    MESH_MAGI_KIND_PANEL_SET_TOOL,
    MESH_MAGI_KIND_PANEL_LIST_TOOL,
    MESH_LAUNCH_SESSION_TOOL,
    MESH_LIST_NODES_TOOL,
    MESH_LIST_PENDING_APPROVALS_TOOL,
    MESH_PLAN_ONBOARDING_TOOL,
    MESH_MISSION_LIST_TOOL,
    MESH_MISSION_UPSERT_TOOL,
    MESH_PRUNE_STALE_DIRECT_TOOL,
    MESH_QUEUE_CANCEL_TOOL,
    MESH_QUEUE_REQUEUE_TOOL,
    MESH_READ_CHAT_TOOL,
    MESH_READ_DEBUG_TOOL,
    MESH_READ_NODE_LOGS_TOOL,
    MESH_RECONCILE_LEDGER_TOOL,
    MESH_REQUEUE_HELD_EVENTS_TOOL,
    MESH_RECORD_NOTE_TOOL,
    MESH_FORGET_NOTE_TOOL,
    MESH_REFINE_BATCH_TOOL,
    MESH_REFINE_CONFIG_TOOL,
    MESH_REFINE_NODE_TOOL,
    MESH_REFINE_PLAN_TOOL,
    MESH_REMOVE_NODE_TOOL,
    MESH_RESTART_DAEMON_TOOL,
    MESH_REVIEW_INBOX_TOOL,
    MESH_SEND_TASK_TOOL,
    MESH_STATUS_TOOL,
    MESH_TASK_HISTORY_TOOL,
    MESH_VIEW_QUEUE_TOOL,
    chooseDispatchableSession,
    classifyRemoteDelegateRelaySafety,
    isMeshOwnedDelegateSession,
    resolveCoordinatorDaemonId,
    triggerMeshQueueAndReport,
} from './mesh-tools-internal.js';
export type {
    MeshContext,
} from './mesh-tools-internal.js';

export type {
    MagiTaskKind,
    MagiRcaResponse,
    MagiDesignResponse,
    MagiFreeformResponse,
    MagiKindParseResult,
} from './mesh-tools-magi.js';

export {
    meshListNodes,
    meshStatus,
} from './mesh-tools-status.js';

export {
    meshEnqueueTask,
    meshQueueCancel,
    meshQueueRequeue,
    meshViewQueue,
} from './mesh-tools-queue.js';

export {
    meshMissionList,
    meshMissionUpsert,
    meshReconcileLedger,
    meshRequeueHeldEvents,
    meshRecordNote,
    meshForgetNote,
    meshReviewInbox,
    meshTaskHistory,
    meshLedgerQuery,
} from './mesh-tools-mission.js';

export {
    MAGI_MAX_REPLICAS,
    buildMagiFanoutPlan,
    buildMagiTaskPrompt,
    classifyStaleReplicas,
    cleanupMagiAutoLaunchedSessions,
    collectMagiCandidateTexts,
    computeMagiCleanupTargets,
    detectQuestionOutputSchemaConflict,
    findMagiReplicaTasks,
    magiOutputContractFor,
    magiReadIndicatesApprovalWedge,
    meshMagiCollect,
    resolveMagiAutoCleanupMode,
    meshMagiKindPanelList,
    meshMagiKindPanelSet,
    meshMagiReview,
    normalizeMagiTaskKind,
    parseFirstMagiCandidate,
    parseFirstMagiCandidateForKind,
    parseFirstMagiCandidateWithCompactFallback,
    parseMagiResponse,
    parseMagiResponseForKind,
    sessionSharedWithAnotherReplica,
    synthesizeMagiResponses,
} from './mesh-tools-magi.js';

export {
    meshNodeSlotsSet,
    meshNodeSlotsList,
} from './mesh-tools-slots.js';

export {
    computeIdleDispatchAckRisk,
    meshApprove,
    meshAnswerQuestion,
    meshListPendingApprovals,
    meshCleanupSessions,
    meshLaunchSession,
    meshPruneStaleDirect,
    meshReadChat,
    meshReadDebug,
    meshReadTerminal,
    meshSendKeys,
    meshSendTask,
} from './mesh-tools-session.js';

export {
    meshCheckpoint,
    meshCleanupWorktreeNodes,
    meshCloneNode,
    meshFastForwardNode,
    meshGitStatus,
    meshReadNodeLogs,
    meshRemoveNode,
    meshRestartDaemon,
} from './mesh-tools-git.js';

export {
    meshPlanOnboarding,
    meshCreate,
    meshAddNode,
} from './mesh-tools-crud.js';

export {
    meshChangeImpactConfig,
    meshChangeImpactConfigSchema,
    meshInit,
    meshReinit,
    meshWriteMeshJsonConfig,
    meshRefineBatch,
    meshRefineConfig,
    meshRefineConfigSchema,
    meshRefineNode,
    meshRefinePlan,
    meshSuggestChangeImpactConfig,
    meshSuggestRefineConfig,
    meshValidateChangeImpactConfig,
    meshValidateRefineConfig,
} from './mesh-tools-refine.js';
