/**
 * Mesh Tools — Mesh-scoped coordinator tools for Repo Mesh orchestration
 *
 * These tools wrap existing MCP transport operations but restrict targets
 * to mesh member nodes only. The coordinator uses these to delegate work
 * to agents across the mesh via natural conversation.
 *
 * 29 tools: mesh_status, mesh_mission_upsert, mesh_mission_list, mesh_list_nodes, mesh_enqueue_task, mesh_view_queue,
 *           mesh_queue_cancel, mesh_queue_requeue, mesh_send_task, mesh_read_chat,
 *           mesh_read_debug, mesh_launch_session, mesh_git_status,
 *           mesh_fast_forward_node, mesh_checkpoint, mesh_approve,
 *           mesh_clone_node, mesh_remove_node, mesh_refine_node,
 *           mesh_refine_config_schema, mesh_validate_refine_config,
 *           mesh_suggest_refine_config, mesh_refine_plan,
 *           mesh_cleanup_sessions, mesh_task_history, mesh_reconcile_ledger,
 *           mesh_review_inbox
 */

// This module is a re-export barrel. The implementation was split by domain into
// mesh-tools-{status,queue,mission,session,git,refine}.ts, with shared helpers, types,
// module state and schema/identity re-exports in mesh-tools-internal.ts. The names below are
// EXACTLY the public surface mesh-tools.ts exposed before the split (verified by export diff).

export {
    ALL_MESH_TOOLS,
    MESH_APPROVE_TOOL,
    MESH_CHANGE_IMPACT_CONFIG_SCHEMA_TOOL,
    MESH_CHECKPOINT_TOOL,
    MESH_CLEANUP_SESSIONS_TOOL,
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
    MESH_MISSION_LIST_TOOL,
    MESH_MISSION_UPSERT_TOOL,
    MESH_PRUNE_STALE_DIRECT_TOOL,
    MESH_QUEUE_CANCEL_TOOL,
    MESH_QUEUE_REQUEUE_TOOL,
    MESH_READ_CHAT_TOOL,
    MESH_READ_DEBUG_TOOL,
    MESH_READ_NODE_LOGS_TOOL,
    MESH_RECONCILE_LEDGER_TOOL,
    MESH_RECORD_NOTE_TOOL,
    MESH_FORGET_NOTE_TOOL,
    MESH_REFINE_BATCH_TOOL,
    MESH_REFINE_CONFIG_SCHEMA_TOOL,
    MESH_REFINE_NODE_TOOL,
    MESH_REFINE_PLAN_TOOL,
    MESH_REMOVE_NODE_TOOL,
    MESH_RESTART_DAEMON_TOOL,
    MESH_REVIEW_INBOX_TOOL,
    MESH_SEND_TASK_TOOL,
    MESH_STATUS_TOOL,
    MESH_SUGGEST_CHANGE_IMPACT_CONFIG_TOOL,
    MESH_SUGGEST_REFINE_CONFIG_TOOL,
    MESH_TASK_HISTORY_TOOL,
    MESH_VALIDATE_CHANGE_IMPACT_CONFIG_TOOL,
    MESH_VALIDATE_REFINE_CONFIG_TOOL,
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
    meshRecordNote,
    meshForgetNote,
    meshReviewInbox,
    meshTaskHistory,
} from './mesh-tools-mission.js';

export {
    MAGI_MAX_REPLICAS,
    buildInlineMagiPanel,
    buildMagiFanoutPlan,
    buildMagiTaskPrompt,
    classifyStaleReplicas,
    cleanupMagiAutoLaunchedSessions,
    collectMagiCandidateTexts,
    computeMagiCleanupTargets,
    detectQuestionOutputSchemaConflict,
    findMagiReplicaTasks,
    magiOutputContractFor,
    meshMagiCollect,
    resolveMagiAutoCleanupMode,
    meshMagiPanelList,
    meshMagiPanelSet,
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
    computeIdleDispatchAckRisk,
    meshApprove,
    meshCleanupSessions,
    meshLaunchSession,
    meshPruneStaleDirect,
    meshReadChat,
    meshReadDebug,
    meshSendTask,
} from './mesh-tools-session.js';

export {
    meshCheckpoint,
    meshCloneNode,
    meshFastForwardNode,
    meshGitStatus,
    meshReadNodeLogs,
    meshRemoveNode,
    meshRestartDaemon,
} from './mesh-tools-git.js';

export {
    meshChangeImpactConfigSchema,
    meshInit,
    meshReinit,
    meshWriteMeshJsonConfig,
    meshRefineBatch,
    meshRefineConfigSchema,
    meshRefineNode,
    meshRefinePlan,
    meshSuggestChangeImpactConfig,
    meshSuggestRefineConfig,
    meshValidateChangeImpactConfig,
    meshValidateRefineConfig,
} from './mesh-tools-refine.js';
