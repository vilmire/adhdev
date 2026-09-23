// Re-export barrel: classification predicates (mesh-event-classify), queue task
// assignment / dispatch / auto-launch (mesh-queue-assignment) and the mesh
// provider-event path (mesh-event-forwarding). Layering (acyclic):
//   mesh-event-classify (leaf) ← mesh-queue-assignment ← mesh-event-forwarding

export {
    isMeshCoordinatorEvent,
    MESH_FORCE_INJECT_EVENTS,
    shouldForceInjectMeshEvent,
} from './mesh-event-classify.js';

export {
    __orderEligibleNodesForTests,
    __resolveSchedulingStrategyForTests,
    __resetIdleAutoFastForwardForTests,
    __scoreSlotForTaskForTests,
    activeReadonlyAssignedCount,
    activeWriteAssignedCount,
    awaitInFlightAutoLaunches,
    isSessionActivelyGenerating,
    triggerMeshQueue,
    tryAssignQueueTask,
} from './mesh-queue-assignment.js';
export type { MeshQueueTriggerResult } from './mesh-queue-assignment.js';

export {
    __resetMeshWorkspaceCacheForTests,
    buildRelayMetadataEvent,
    handleMeshForwardEvent,
    resolveForwardEventMeshId,
    setupMeshEventForwarding,
    isHollowCompletion,
} from './mesh-event-forwarding.js';
