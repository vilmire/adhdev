/**
 * Mesh assignment attach/detach (verbatim move out of CliProviderInstance —
 * M-FILE-SIZE-DEBT decomposition).
 *
 * Owns the session<->mesh binding written into `settings`: which mesh/node this
 * session serves, and which task (plus its dispatch nonce and attempt identity)
 * is currently in flight on it. The distinction this cluster exists to hold is
 * SESSION-level membership vs TASK-level markers — a coordinator-LAUNCHED
 * worker keeps its membership across task completions, while an ad-hoc session
 * adopted by a direct dispatch is fully unpinned on detach.
 *
 * State lives ON THE HOST (the provider instance) exactly as before. Provenance
 * kept inline: ANTIGRAVITY-PREMATURE-COMPLETION injection stamp, WTCLAIM (A)
 * sticky meshLastNodeId, REDRIVE-DUP nonce lifetime, TURN-LEDGER Stage 5
 * attempt identity, and MESHID-DROP-ON-DETACH (Fix C).
 */

import { LOG } from '../logging/logger.js';
import { isWorkerMcpEnabled } from '../runtime-defaults.js';
import {
mergePendingMeshTaskAttachment,
meshTaskAttachments,
popCompletedMeshTaskAttachment,
pushMeshTaskAttachment,
type MeshTaskAttachment,
} from './mesh-task-attachment.js';

/** The narrow surface of CliProviderInstance the mesh binding reads/writes. */
export interface MeshAssignmentHost {
instanceId: string;
settings: Record<string, any>;
meshTaskInjectedAt: number;
meshTaskAttachmentHistory: MeshTaskAttachment[];
adapter: { updateRuntimeSettings?: (settings: Record<string, any>) => void };
}

export function attachMeshAssignment(host: MeshAssignmentHost, assignment: { meshId: string; nodeId?: string; taskId?: string; dispatchNonce?: number; attemptId?: string; coordinatorDaemonId?: string; coordinatorSessionId?: string }): void {
    if (!assignment?.meshId) return;
    // ANTIGRAVITY-PREMATURE-COMPLETION gate: stamp the injection moment for a task
    // attach so injectedTaskHasStartedGenerating() can require the producing turn to
    // START after this point (rejecting the prior turn's stale native-history tail
    // that would otherwise fire generating_completed before generating_started).
    if (assignment.taskId && assignment.taskId.trim()) {
        host.meshTaskInjectedAt = Date.now();
        if (isWorkerMcpEnabled()) { host.meshTaskAttachmentHistory = meshTaskAttachments(host.meshTaskAttachmentHistory); const { droppedTaskId } = pushMeshTaskAttachment(host.meshTaskAttachmentHistory, { taskId: assignment.taskId, attemptId: assignment.attemptId, dispatchNonce: assignment.dispatchNonce, injectedAt: host.meshTaskInjectedAt }); if (droppedTaskId) LOG.warn('MeshTaskAttach', `[${host.instanceId}] turn-aware attachment history exceeded cap — dropped task ${droppedTaskId}.`); } // WORKER-MCP T2 precursor — mesh-task-attachment.ts
    }
    host.settings = {
        ...host.settings,
        meshNodeFor: assignment.meshId,
        // WTCLAIM (A): track the bound node id under BOTH the active marker
        // (meshNodeId, cleared on detach) and a sticky marker (meshLastNodeId,
        // preserved across detach). The sticky marker lets a detached but still
        // coordinator-owned session be re-picked ONLY for the SAME node it served
        // — never auto-adopted for a sibling node (e.g. a cloned worktree) that
        // shares this daemon. See isMeshOwnedDelegateSession's post-detach gate.
        ...(assignment.nodeId ? { meshNodeId: assignment.nodeId, meshLastNodeId: assignment.nodeId } : {}),
        ...(assignment.taskId ? { meshActiveTaskId: assignment.taskId } : {}),
        // REDRIVE-DUP: task-level dispatch nonce, echoed on generating_started so the
        // coordinator can reject a stale (reclaimed) dispatch. Cleared with meshActiveTaskId
        // on detach so a subsequent unrelated turn never re-echoes a prior task's nonce.
        ...(typeof assignment.dispatchNonce === 'number' ? { meshActiveDispatchNonce: assignment.dispatchNonce } : {}),
        // TURN-LEDGER (Stage 5): the opaque attempt identity for this dispatch, echoed
        // on lifecycle events so the coordinator's reducer correlates ACKs/completion
        // proposals to (taskId, attemptId, session). Cleared with meshActiveTaskId on
        // detach so a later unrelated turn never re-echoes a prior attempt.
        ...(assignment.attemptId ? { meshActiveAttemptId: assignment.attemptId } : {}),
        ...(assignment.coordinatorDaemonId ? { meshCoordinatorDaemonId: assignment.coordinatorDaemonId } : {}),
        // Session-level routing anchor: the originating coordinator session, so this
        // worker's completion events route back to the exact session that dispatched it.
        ...(assignment.coordinatorSessionId ? { meshCoordinatorSessionId: assignment.coordinatorSessionId } : {}),
    };
    host.adapter.updateRuntimeSettings?.(host.settings);
}

/**
 * Clear a previously-attached mesh assignment after the task reaches a
 * terminal state. Leaving meshNodeFor pinned would route this session's
 * subsequent unrelated turns (e.g. ad-hoc dashboard chats) to the
 * coordinator as if they were task completions.
 *
 * MESHID-DROP-ON-DETACH (Fix C): a coordinator-LAUNCHED worker session
 * (launchedByCoordinator) holds its mesh membership (meshNodeFor / meshNodeId /
 * meshCoordinatorDaemonId) at the SESSION level — set once at launch
 * (mesh_launch_session / queue auto-launch), independent of any single task.
 * The original detach wiped meshNodeFor + meshNodeId together with the
 * task-level meshActiveTaskId, so the FIRST task completion stripped the
 * membership and EVERY subsequent completion forwarded with meshId absent —
 * resolveWorkerDelegateRouting fell to mesh_unresolved and the coordinator
 * rejected the forward "meshId required". For a launched member we therefore
 * clear ONLY the task-level marker (meshActiveTaskId) and preserve the
 * session-level membership so its next task's completion still resolves.
 * A task-less ad-hoc turn on a preserved-membership session is NOT misrouted:
 * its completion carries no taskId and the session holds no active assignment,
 * so the forwarder's WARMUPGAP guard skips the dispatch-row flip (it only
 * injects a benign task-less notification). A NON-launched session (a plain CLI
 * session adopted by mesh_send_task --direct, launchedByCoordinator falsy)
 * keeps the original full clear so an ad-hoc session is never left pinned.
 */
export function detachMeshAssignment(host: MeshAssignmentHost): void { // WORKER-MCP T2 precursor (mesh-task-attachment.ts): restores a still-pending attachment onto the scalar; flag off is a no-op.
    const pending = isWorkerMcpEnabled() ? popCompletedMeshTaskAttachment(meshTaskAttachments(host.meshTaskAttachmentHistory)) : undefined; if (!host.settings.meshNodeFor && !host.settings.meshActiveTaskId && !host.settings.meshNodeId) return;
    // Session-level member: keep membership, drop only the task-level markers.
    if (host.settings.launchedByCoordinator === true) {
        if (!host.settings.meshActiveTaskId) return;
        // REDRIVE-DUP: clear the task-level dispatch nonce with the task marker.
        const { meshActiveTaskId, meshActiveDispatchNonce, meshActiveAttemptId, ...rest } = host.settings;
        void meshActiveTaskId; void meshActiveDispatchNonce; void meshActiveAttemptId;
        host.settings = mergePendingMeshTaskAttachment(rest, pending);
        host.adapter.updateRuntimeSettings?.(host.settings);
        return;
    }
    const { meshNodeFor, meshNodeId, meshActiveTaskId, meshActiveDispatchNonce, meshActiveAttemptId, ...rest } = host.settings;
    void meshNodeFor; void meshActiveTaskId; void meshActiveDispatchNonce; void meshActiveAttemptId;
    // WTCLAIM (A): clear the active binding but PRESERVE the last bound node id
    // (meshLastNodeId) so a later sessionless dispatch can re-adopt this idle
    // session ONLY for the node it last served. Carry the id being cleared, or
    // keep an already-present sticky marker if meshNodeId was absent.
    const lastNodeId = (typeof meshNodeId === 'string' && meshNodeId.trim())
        ? meshNodeId.trim()
        : (typeof rest.meshLastNodeId === 'string' && rest.meshLastNodeId.trim() ? rest.meshLastNodeId.trim() : undefined);
    host.settings = lastNodeId ? { ...rest, meshLastNodeId: lastNodeId } : rest;
    host.adapter.updateRuntimeSettings?.(host.settings);
}
