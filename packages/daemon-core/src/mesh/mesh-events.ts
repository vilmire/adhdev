// ---------------------------------------------------------------------------
// mesh-events — entry point
// ---------------------------------------------------------------------------
// Public API re-exported from sub-modules for backward compatibility.
// New code should import directly from the relevant sub-module.
// ---------------------------------------------------------------------------

export type { PendingMeshCoordinatorEvent } from './mesh-events-pending.js';
export {
    queuePendingMeshCoordinatorEvent,
    drainPendingMeshCoordinatorEvents,
    getPendingMeshCoordinatorEvents,
    clearPendingMeshCoordinatorEvents,
    serializeV2EnvelopeToWire,
    readV2EnvelopeFromWire,
    getMeshV2DrainCounters,
    isMeshProtocolV2EnforceEnabled,
} from './mesh-events-pending.js';

export {
    reconcileDirectDispatchCompletionFromTranscript,
} from './mesh-events-stale.js';

export {
    setupMeshReconcileLoop,
    runMeshReconcileTick,
    resolveCoordinatorDrainDeliverability,
    shouldHoldPendingDrainForBusyLocalCoordinator,
    getMeshV2BackstopCounters,
} from './mesh-reconcile-loop.js';

export type { MeshQueueTriggerResult } from './mesh-events-coordinator.js';
export {
    tryAssignQueueTask,
    isSessionActivelyGenerating,
    triggerMeshQueue,
    handleMeshForwardEvent,
    setupMeshEventForwarding,
    isMeshCoordinatorEvent,
    __resetIdleAutoFastForwardForTests,
    __resetMeshWorkspaceCacheForTests,
} from './mesh-events-coordinator.js';
