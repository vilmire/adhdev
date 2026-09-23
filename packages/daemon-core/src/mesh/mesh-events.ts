// ---------------------------------------------------------------------------
// mesh-events — entry point
// ---------------------------------------------------------------------------
// Public API re-exported from sub-modules. After wiring-unification C (C-W3)
// the coordinator-notification half is the turn ledger's: notices are
// `turn.notify` entries on `mesh.<id>.events`, delivered by the `turn.deliver`
// cursor (`turn-ledger/deliver.ts`); the pending-events queue, its drains and
// the P2P pull are gone.
// ---------------------------------------------------------------------------

export type { MeshQueueTriggerResult } from './mesh-events-coordinator.js';
export {
    tryAssignQueueTask,
    isSessionActivelyGenerating,
    triggerMeshQueue,
    awaitInFlightAutoLaunches,
    isMeshCoordinatorEvent,
    __resetIdleAutoFastForwardForTests,
} from './mesh-events-coordinator.js';

export {
    handleMeshForwardEvent,
    setupMeshEventForwarding,
    __resetMeshWorkspaceCacheForTests,
} from './mesh-event-forwarding.js';

export {
    notifyMeshCoordinator,
    meshNoticeRuntime,
    type CoordinatorNotice,
    type PendingCoordinatorNoticeWire,
} from './turn-ledger/deliver.js';

/** The notice shape `get_pending_mesh_events` / `mesh_status` surface (field names kept for the MCP client). */
export type { PendingCoordinatorNoticeWire as PendingMeshCoordinatorEvent } from './turn-ledger/deliver.js';

/**
 * @deprecated Renamed `notifyMeshCoordinator` (C-W3). Every daemon-core PRODUCER
 * call site now uses `notifyMeshCoordinator` directly (C-W7) — this alias is
 * kept ONLY because `oss/packages/mcp-server/test/mesh-active-work-artifacts.test.ts`
 * still imports it from the `@adhdev/daemon-core` barrel (mcp-server is C-W6c's
 * file ownership, not touched here). REQUESTED EDIT for C-W6c: switch that
 * import to `notifyMeshCoordinator`, then this alias can be deleted for real.
 */
export { notifyMeshCoordinator as queuePendingMeshCoordinatorEvent } from './turn-ledger/deliver.js';

