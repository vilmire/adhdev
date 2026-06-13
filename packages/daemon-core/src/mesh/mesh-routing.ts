import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { getActiveDirectDispatches } from './mesh-work-queue.js';
import { hasUnterminalDirectDispatchLedgerEntry } from './mesh-events-stale.js';
import { readNonEmptyString } from './mesh-events-utils.js';

// ---------------------------------------------------------------------------
// R1: single-source coordinator routing resolution
//
// Worker→node→mesh→coordinator routing used to be reconstructed inline inside
// setupMeshEventForwarding by reading six settings "stamp" fields
// (meshNodeFor / meshNodeId / meshCoordinatorFor / meshCoordinatorDaemonId /
// meshCoordinatorNodeId / launchedByCoordinator) plus two ledger queries plus a
// workspace fallback, scattered across ~50 lines. Any missing stamp silently
// changed the routing decision (delegate dropped, mesh unresolved) — design
// vulnerability #2.
//
// resolveWorkerDelegateRouting() is the ONE place that interprets those inputs.
// The stamps are inputs *internal to this function*; no external branch reads
// them to make a routing decision. The forwarder consumes the typed result only.
// ---------------------------------------------------------------------------

export interface WorkerDelegateRouting {
    /** True when the source session is a mesh worker whose events must route to a coordinator. */
    isDelegate: boolean;
    /** Resolved mesh id (runtime stamp, direct-dispatch recovery, or workspace lookup). */
    meshId: string;
    /** Resolved node id within the mesh, or '' when it cannot be determined. */
    nodeId: string;
    /** Human-readable node label for the coordinator system message. */
    nodeLabel: string;
    /** Coordinator daemon anchor (prefixed id) when the worker carries one; '' otherwise. */
    coordinatorDaemonId: string;
    /** Why routing was rejected (isDelegate=false), for fail-loud diagnostics (R4). */
    rejectionReason?: 'not_cli' | 'no_workspace' | 'no_worker_envelope' | 'coordinator_not_dispatch_target' | 'mesh_unresolved';
}

interface ResolveDeps {
    /** Resolve a mesh by id (local config + inline cache). */
    getMeshById: (meshId: string) => any | undefined;
    /** Resolve a mesh by workspace path (cached repo lookup). */
    getMeshByWorkspace: (workspace: string) => any | undefined;
}

function readSettings(state: any): Record<string, unknown> {
    return state?.settings && typeof state.settings === 'object'
        ? state.settings as Record<string, unknown>
        : {};
}

/**
 * Resolve how a source CLI session's mesh events should route to a coordinator.
 *
 * This is the single authoritative interpretation of the worker envelope. It folds
 * together every signal that previously lived in inline branches:
 *  - runtime stamps (meshNodeFor / meshNodeId)
 *  - the coordinator anchor (meshCoordinatorDaemonId) and launch marker (launchedByCoordinator,
 *    meshCoordinatorNodeId) — any one proves delegation even if the node/mesh stamp was dropped
 *  - direct-dispatch recovery: a coordinator session that is itself a dispatch target
 *  - workspace→mesh fallback when no runtime mesh id survived
 *
 * Returns isDelegate=false (with a rejectionReason) instead of throwing, so the caller
 * can either ignore non-delegate events or surface a diagnostic.
 */
export function resolveWorkerDelegateRouting(
    components: DaemonComponents,
    instanceId: string,
    deps: ResolveDeps,
): WorkerDelegateRouting {
    const reject = (rejectionReason: WorkerDelegateRouting['rejectionReason']): WorkerDelegateRouting => ({
        isDelegate: false,
        meshId: '',
        nodeId: '',
        nodeLabel: '',
        coordinatorDaemonId: '',
        rejectionReason,
    });

    const sourceInstance = components.instanceManager.getInstance(instanceId);
    if (!sourceInstance || sourceInstance.category !== 'cli') return reject('not_cli');

    const state = sourceInstance.getState();
    const workspace = readNonEmptyString(state.workspace);
    if (!workspace) return reject('no_workspace');

    const settings = readSettings(state);
    const coordinatorDaemonId = readNonEmptyString(settings.meshCoordinatorDaemonId);

    // A coordinator session (meshCoordinatorFor set) is only treated as a worker delegate
    // when it is itself the target of an active direct dispatch — otherwise its own events
    // must not be routed back to a coordinator (it IS the coordinator).
    const coordinatorMeshId = readNonEmptyString(settings.meshCoordinatorFor);
    let meshIdFromDirectDispatch = '';
    if (coordinatorMeshId) {
        let hasActiveDispatch = false;
        try {
            hasActiveDispatch =
                getActiveDirectDispatches(coordinatorMeshId).some(d => d.sessionId === instanceId)
                || hasUnterminalDirectDispatchLedgerEntry(coordinatorMeshId, instanceId);
        } catch { /* best-effort */ }
        if (!hasActiveDispatch) return reject('coordinator_not_dispatch_target');
        meshIdFromDirectDispatch = coordinatorMeshId;
    }

    const meshIdFromRuntime = readNonEmptyString(settings.meshNodeFor) || meshIdFromDirectDispatch;

    // Worker-envelope proof of delegation. A worker can arrive carrying only the routing
    // anchor (meshCoordinatorDaemonId) without meshNodeFor — e.g. when the node/mesh stamp
    // was dropped on a direct dispatch or relaunch. Treat any envelope marker as proof and
    // recover the mesh id by workspace when the runtime id is absent.
    const hasWorkerEnvelope = Boolean(
        meshIdFromRuntime
        || settings.launchedByCoordinator
        || coordinatorDaemonId
        || readNonEmptyString(settings.meshCoordinatorNodeId),
    );
    if (!hasWorkerEnvelope) return reject('no_worker_envelope');

    const mesh = meshIdFromRuntime ? deps.getMeshById(meshIdFromRuntime) : deps.getMeshByWorkspace(workspace);
    const meshId = meshIdFromRuntime || readNonEmptyString(mesh?.id);
    if (!meshId) return reject('mesh_unresolved');

    const targetNode = mesh?.nodes?.find((n: any) => n.workspace === workspace);
    const runtimeNodeId = readNonEmptyString(settings.meshNodeId);
    const nodeId = readNonEmptyString(targetNode?.id) || runtimeNodeId;
    const nodeLabel = targetNode
        ? `Node '${targetNode.id}'`
        : runtimeNodeId
            ? `Node '${runtimeNodeId}'`
            : `Agent at ${workspace}`;

    return {
        isDelegate: true,
        meshId,
        nodeId,
        nodeLabel,
        coordinatorDaemonId,
    };
}
