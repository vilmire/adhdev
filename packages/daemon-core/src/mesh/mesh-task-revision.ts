import { assertSourceDependencyGraph } from './mesh-task-phase-dependencies.js';
import { normalizeRoutingPreferences } from './mesh-task-routing-contract.js';
import { normalizeOwnedPaths, findOwnershipConflicts, type MeshTaskPhase } from '@adhdev/mesh-shared';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';
import { findOpenQueueAttempt } from './mesh-queue-attempt-guard.js';
import { isTaskDispatchInFlight } from './mesh-task-inflight.js';
import { attestLocalOwnership } from './mesh-physical-ownership.js';
import { evaluateTaskOwnedPathsAdmission } from './mesh-runtime-store-claim.js';
import { validateMeshTaskModeRequest, buildMeshTaskModeViolationError } from './mesh-task-mode-guardrail.js';

export interface PendingTaskRevisionPatch {
    message?: string;
    ownedPaths?: string[];
    phase?: MeshTaskPhase;
    dependsOn?: string[];
    routingPreferences?: import('@adhdev/mesh-shared').MeshRoutingPreferences;
    review?: import('@adhdev/mesh-shared').MeshReviewConstraint;
}
/** Passed only by the authenticated host handler, never spread from request options. */
export interface TaskRevisionHostContext {
    actor: string; repoIdentity: string; machineId: string; nodeId?: string; workspace?: string;
}

/** Same transaction as claims. Refusal throws before any row, history or hold is written. */
export function revisePendingTask(meshId: string, taskId: string, expectedRevision: number, patch: PendingTaskRevisionPatch, host: TaskRevisionHostContext): MeshWorkQueueEntry {
    if (!host?.actor || !host.repoIdentity || !host.machineId) throw new Error('authenticated_host_required');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('invalid_expected_revision');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(k => !['message', 'ownedPaths', 'phase', 'dependsOn', 'routingPreferences', 'review'].includes(k))) throw new Error('unsupported_revision_patch');
    const store = MeshRuntimeStore.getInstance();
    return store.transaction(() => {
        const before = store.findQueueEntryById(meshId, taskId);
        if (!before) throw new Error('task_not_found');
        if (before.status !== 'pending') throw new Error('pending_required: active edits require a future versioned quiescent handoff');
        if ((before.revision ?? 0) !== expectedRevision) throw new Error('stale_revision');
        if (isTaskDispatchInFlight(meshId, taskId) || findOpenQueueAttempt(store.turnStore(), meshId, taskId)) throw new Error('open_attempt_revision_refused');
        const next: MeshWorkQueueEntry = structuredClone(before);
        if (patch.message !== undefined) {
            if (typeof patch.message !== 'string' || !patch.message.trim()) throw new Error('invalid_revision_message');
            if (before.input?.parts.length) throw new Error('multipart_message_revision_requires_input_contract');
            next.message = patch.message.trim();
            const mode = validateMeshTaskModeRequest(next.taskMode, next.message, next.readonly);
            if (!mode.valid) throw new Error(buildMeshTaskModeViolationError(mode));
        }
        if (patch.ownedPaths !== undefined) {
            if (!Array.isArray(patch.ownedPaths) || !patch.ownedPaths.length) throw new Error('empty_revision_ownership');
            const normalized = normalizeOwnedPaths(patch.ownedPaths);
            if (normalized.rejected.length || !normalized.declaration.paths.length) throw new Error(`invalid_revision_paths: ${JSON.stringify(normalized.rejected)}`);
            next.ownedPaths = normalized.declaration;
        }
        if (patch.phase !== undefined) {
            if (patch.phase !== 'source' && patch.phase !== 'integration') throw new Error('invalid_revision_phase');
            if (next.readonly || next.taskMode === 'live_debug_readonly') throw new Error('write_phase_required');
            next.phase = patch.phase;
        }
        if (patch.routingPreferences !== undefined) next.routingPreferences = normalizeRoutingPreferences(patch.routingPreferences);
        if (patch.review !== undefined) {
            if (!patch.review || Object.keys(patch.review).some(k => !['sourceTaskId', 'differentProvider'].includes(k)) || patch.review.differentProvider !== true || typeof patch.review.sourceTaskId !== 'string'
                || !store.findQueueEntryById(meshId, patch.review.sourceTaskId) || patch.review.sourceTaskId === taskId
                || (!next.readonly && next.taskMode !== 'live_debug_readonly')) throw new Error('invalid_review_contract');
            next.review = patch.review;
        }
        if (next.phase) {
            if (!host.nodeId || host.nodeId !== before.targetNodeId || !host.workspace || !next.ownedPaths?.paths.length) throw new Error('local_pinned_physical_context_required');
            next.ownershipScope = attestLocalOwnership({ ...host, nodeId: host.nodeId, workspace: host.workspace, phase: next.phase, paths: next.ownedPaths });
        }
        if (patch.dependsOn !== undefined) {
            if (!Array.isArray(patch.dependsOn) || patch.dependsOn.some(id => typeof id !== 'string' || !id.trim())) throw new Error('invalid_revision_dependencies');
            next.dependsOn = [...new Set(patch.dependsOn.map(id => id.trim()))];
            const queue = store.getQueueEntries(meshId);
            const adjacency = new Map(queue.map(t => [t.id, t.dependsOn ?? []]));
            if (next.dependsOn.some(id => !adjacency.has(id))) throw new Error('unknown_dependency');
            adjacency.set(taskId, next.dependsOn);
            const stack = [...next.dependsOn], seen = new Set<string>();
            while (stack.length) {
                const id = stack.pop()!;
                if (id === taskId) throw new Error('dependency_cycle_detected');
                if (seen.has(id)) continue;
                seen.add(id); stack.push(...(adjacency.get(id) ?? []));
            }
        }
        assertSourceDependencyGraph(store.getQueueEntries(meshId).map(t => t.id === taskId ? next : t));
        const admission = evaluateTaskOwnedPathsAdmission(store, meshId, next);
        const expandedPaths = patch.ownedPaths !== undefined && (next.ownedPaths?.paths ?? []).some(entry =>
            !(before.ownedPaths?.paths ?? []).some(old => old.path === entry.path && (old.subtree || !entry.subtree)
                || old.subtree && entry.path.startsWith(`${old.path}/`)));
        const expandsIntegration = patch.phase === 'integration' && before.phase !== 'integration';
        const installsPhysicalContext = !!next.ownershipScope && !before.ownershipScope;
        if (!admission.allowed && (expandedPaths || expandsIntegration || installsPhysicalContext)) throw new Error(`ownership_collision: ${admission.detail}`);
        if (next.ownedPaths && next.phase === 'source') {
            next.logicalOverlapWarnings = store.getQueueEntries(meshId).flatMap(other => {
                if (other.id === taskId || other.phase !== 'source' || !other.ownedPaths || other.status === 'cancelled' || other.status === 'failed') return [];
                return findOwnershipConflicts(next.ownedPaths!, [{ taskId: other.id, paths: other.ownedPaths }])
                    .map(c => ({ ...c, action: 'serialize_integration' as const }));
            });
        }
        next.revisionHistory = [...(before.revisionHistory ?? []), {
            revision: expectedRevision, at: new Date().toISOString(), actor: host.actor,
            before: { message: before.message, ownedPaths: before.ownedPaths, phase: before.phase, dependsOn: before.dependsOn, ownershipScope: before.ownershipScope, routingPreferences: before.routingPreferences, review: before.review },
        }];
        delete next.hold; delete next.holdNoticeId; delete next.autoLaunch;
        // updateQueueEntry owns the monotonic revision; no retries, attempts or identities change.
        store.updateQueueEntry(next);
        return next;
    });
}
