/**
 * Mesh Tools — Mesh-scoped coordinator tools for Repo Mesh orchestration
 *
 * These tools wrap existing MCP transport operations but restrict targets
 * to mesh member nodes only. The coordinator uses these to delegate work
 * to agents across the mesh via natural conversation.
 *
 * See ALL_MESH_TOOLS (mesh-tool-schemas.ts) for the authoritative tool list
 * and count; kept in sync with the coordinator-prompt TOOLS table by the
 * 6-6 consistency test in daemon-core coordinator-prompt.test.ts.
 */

// This module is a re-export barrel. The implementation was split by domain into
// mesh-tools-{status,queue,mission,session,git,refine}.ts, with shared helpers, types,
// module state and schema/identity re-exports in mesh-tools-internal.ts. The names below are
// EXACTLY the public surface mesh-tools.ts exposed before the split (verified by export diff).

export { triggerMeshQueueAndReport } from './mesh-tools-internal.js';
export { ALL_MESH_TOOLS, MESH_LIST_NODES_TOOL, MESH_STATUS_TOOL, MESH_ROUTE_PREVIEW_TOOL } from './mesh-tool-schemas.js';
export { MESH_INIT_TOOL, MESH_CONFIG_TOOL, MESH_NODE_SLOTS_TOOL, MESH_COORDINATOR_PROMPT_APPEND_TOOL, MESH_REFINE_BATCH_TOOL, MESH_REFINE_NODE_TOOL, MESH_REFINE_PLAN_TOOL, MESH_REVIEW_INBOX_TOOL, MESH_NOTIFY_WORKER_TOOL } from './mesh-tool-schemas-refine-config.js';
export { MESH_APPROVE_TOOL, MESH_ANSWER_QUESTION_TOOL, MESH_CLEANUP_SESSIONS_TOOL, MESH_CLEANUP_WORKTREE_NODES_TOOL, MESH_CREATE_TOOL, MESH_ADD_NODE_TOOL, MESH_CLONE_NODE_TOOL, MESH_LIST_PENDING_APPROVALS_TOOL, MESH_MISSION_LIST_TOOL, MESH_MISSION_UPSERT_TOOL, MESH_RECONCILE_LEDGER_TOOL, MESH_NOTE_TOOL, MESH_REMOVE_NODE_TOOL, MESH_TASK_HISTORY_TOOL } from './mesh-tool-schemas-admin.js';
export { MESH_CHECKPOINT_TOOL, MESH_FAST_FORWARD_NODE_TOOL, MESH_GIT_STATUS_TOOL, MESH_LAUNCH_SESSION_TOOL, MESH_READ_CHAT_TOOL, MESH_READ_DEBUG_TOOL, MESH_READ_NODE_LOGS_TOOL, MESH_RESTART_DAEMON_TOOL, MESH_SEND_TASK_TOOL } from './mesh-tool-schemas-session.js';
export { MESH_ENQUEUE_TASK_TOOL, MESH_QUEUE_CANCEL_TOOL, MESH_QUEUE_REQUEUE_TOOL, MESH_VIEW_QUEUE_TOOL } from './mesh-tool-schemas-queue.js';
export { chooseDispatchableSession, classifyRemoteDelegateRelaySafety, isMeshOwnedDelegateSession } from './mesh-tools-internal-core.js';
export { resolveCoordinatorDaemonId } from './mesh-node-identity.js';
export type {
    MeshContext,
} from './mesh-tools-internal.js';

export {
    meshListNodes,
    meshStatus,
} from './mesh-tools-status.js';

export {
    meshRoutePreview,
} from './mesh-tools-route-preview.js';

export { meshEnqueueTask, meshEnqueueBatch } from './mesh-tools-queue.js';
export { meshQueueCancel, meshQueueRequeue, meshViewQueue } from './mesh-tools-queue-manage.js';

export {
    meshMissionList,
    meshMissionUpsert,
    meshReconcileLedger,
    meshRecordNote,
    meshForgetNote,
    meshReviewInbox,
    meshTaskHistory,
    meshLedgerQuery,
} from './mesh-tools-mission.js';

export {
    meshNodeSlotsSet,
    meshNodeSlotsList,
} from './mesh-tools-slots.js';

export {
    meshNodeSlotsPropose,
} from './mesh-tools-slot-autodetect.js';

export { computeIdleDispatchAckRisk } from './mesh-direct-dispatch-attempt.js';
export { meshSendTask } from './mesh-tools-send-task.js';

export {
    meshApprove,
    meshAnswerQuestion,
    meshListPendingApprovals,
    meshCleanupSessions,
    meshLaunchSession,
    meshNotifyWorker,
    meshPruneStaleDirect,
    meshReadChat,
    meshReadDebug,
    meshReadTerminal,
    meshSendKeys,
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
    meshCoordinatorPromptAppendGet,
    meshCoordinatorPromptAppendSet,
} from './mesh-tools-coordinator-prompt.js';

// 2026-09-26 tool consolidation — the merged-tool dispatchers.
export {
    meshNodeSlots,
    meshCoordinatorPromptAppend,
    meshNote,
    meshConfig,
    meshInitOrReinit,
    meshCreateOrPlan,
    meshCleanupSessionsOrPrune,
} from './mesh-tools-merged.js';

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
