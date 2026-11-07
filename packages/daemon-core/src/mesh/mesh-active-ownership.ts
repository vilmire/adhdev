import { realpathSync } from 'node:fs';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';
import { attestLocalOwnership, currentPhysicalScope } from './mesh-physical-ownership.js';
import { pinnedMeshNodeIdMatches } from './mesh-pinned-node-identity.js';
import { isTaskReadonly } from './mesh-task-predicates.js';

/** Passed only by the authenticated host handler; `sessionWorkspace` is read from the live local session. */
export interface ActiveOwnershipHostContext {
    actor: string; repoIdentity: string; machineId: string;
    nodeId?: string; workspace?: string; sessionWorkspace?: string;
}

/**
 * Attach the physical ownership scope an ASSIGNED writer is missing.
 *
 * An assigned writer without a scope is an unknown physical writer: every other
 * write task is held behind it (fail-closed). When the task did declare its paths
 * and the host can prove where it really runs, the scope can be added without
 * stopping the task — it adds information, it never narrows or widens the claim.
 *
 * Refused (the row stays an unknown writer): not assigned, stale revision, scope
 * already present (never replaced), no declared paths (nothing to attest), a node
 * this host does not pin, or a live session whose working directory is not the
 * node checkout (attesting the roster checkout would otherwise authorize a write
 * in another worktree). Same transaction and CAS as `revisePendingTask`.
 */
export function attestActiveTaskOwnership(meshId: string, taskId: string, expectedRevision: number, host: ActiveOwnershipHostContext, opts: { dryRun?: boolean } = {}): MeshWorkQueueEntry {
    if (!host?.actor || !host.repoIdentity || !host.machineId) throw new Error('authenticated_host_required');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('invalid_expected_revision');
    const store = MeshRuntimeStore.getInstance();
    return store.transaction(() => {
        const before = store.findQueueEntryById(meshId, taskId);
        if (!before) throw new Error('task_not_found');
        if (before.status !== 'assigned') throw new Error('assigned_required: pending tasks use an ordinary revision');
        if ((before.revision ?? 0) !== expectedRevision) throw new Error('stale_revision');
        if (isTaskReadonly(before)) throw new Error('write_task_required');
        if (before.ownershipScope) throw new Error('ownership_already_attested');
        if (!before.ownedPaths?.paths.length) {
            throw new Error('ownedpaths_undeclared: the running task never declared what it writes, so no scope can be proven; it stays an unknown writer until it ends');
        }
        if (!before.assignedSessionId || !host.nodeId || !host.workspace || !pinnedMeshNodeIdMatches(host.nodeId, before.assignedNodeId)) {
            throw new Error('local_pinned_physical_context_required');
        }
        try {
            if (!host.sessionWorkspace || realpathSync.native(host.sessionWorkspace) !== realpathSync.native(host.workspace)) throw new Error('mismatch');
        } catch {
            throw new Error('active_workspace_unproven: the assigned session is not running in the node checkout');
        }
        const phase = before.phase === 'integration' ? 'integration' : 'source';
        const scope = attestLocalOwnership({
            repoIdentity: host.repoIdentity, machineId: host.machineId, nodeId: host.nodeId, workspace: host.workspace, phase, paths: before.ownedPaths,
        });
        if (!currentPhysicalScope(scope, before.ownedPaths)) throw new Error('ownership_unproven: unproven_active_physical_resource');
        const next: MeshWorkQueueEntry = structuredClone(before);
        next.ownershipScope = scope;
        next.phase = phase;
        next.revisionHistory = [...(before.revisionHistory ?? []), {
            revision: expectedRevision, at: new Date().toISOString(), actor: host.actor,
            before: { message: before.message, ownedPaths: before.ownedPaths, phase: before.phase, dependsOn: before.dependsOn, ownershipScope: undefined, routingPreferences: before.routingPreferences, review: before.review },
        }];
        if (!opts.dryRun) store.updateQueueEntry(next); // dry run: every gate above ran, nothing is saved
        return next;
    });
}
