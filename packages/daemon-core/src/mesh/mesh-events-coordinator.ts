// Re-export barrel (A-4 split). This module was split into three domain files —
// classification predicates (mesh-event-classify), queue task assignment / dispatch /
// auto-launch (mesh-queue-assignment), and forward-event handling / relay metadata /
// dedup (mesh-event-forwarding). The barrel preserves the exact original public export
// surface so every existing importer is unchanged. The acyclic layering is:
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
    activeReadonlyAssignedCount,
    activeWriteAssignedCount,
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
} from './mesh-event-forwarding.js';
