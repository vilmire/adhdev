import { pinnedMeshNodeIdMatches } from './mesh-pinned-node-identity.js';
import { realpathSync } from 'node:fs';
import type { MeshRoutingPreferences } from '@adhdev/mesh-shared';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';
import { currentPhysicalScope, comparePhysicalOwnership } from './mesh-physical-ownership.js';

/** Stable preferences with a full eligible fallback; never used as an eligibility filter. */
export function preferEligible<T>(eligible: readonly T[], preferences: readonly string[] | undefined, key: (value: T) => string): T[] {
    const rank = (value: T) => { const i = preferences?.indexOf(key(value)) ?? -1; return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
    return [...eligible].sort((a, b) => rank(a) - rank(b));
}
export function normalizeRoutingPreferences(value: unknown): MeshRoutingPreferences {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => k !== 'nodeIds' && k !== 'providers')) throw new Error('invalid_routing_preferences');
    const result: MeshRoutingPreferences = {};
    for (const key of ['nodeIds', 'providers'] as const) {
        const entries = (value as MeshRoutingPreferences)[key];
        if (entries === undefined) continue;
        if (!Array.isArray(entries) || entries.length > 64 || entries.some(x => typeof x !== 'string' || !x.trim())) throw new Error('invalid_routing_preferences');
        result[key] = [...new Set(entries.map(x => x.trim()))];
    }
    return result;
}

export interface ReviewRoutingContext { workspace: string; machineId: string }
/** Input availability is proven locally; a remote source needs a future verified transfer contract. */
export function reviewRoutingRefusal(task: Pick<MeshWorkQueueEntry, 'review' | 'readonly' | 'taskMode'>, source: MeshWorkQueueEntry | undefined | null, provider: string | undefined, context: ReviewRoutingContext | undefined, active: readonly MeshWorkQueueEntry[] = []): string | undefined {
    if (!task.review) return undefined;
    if (!task.readonly && task.taskMode !== 'live_debug_readonly') return 'review_requires_readonly';
    if (!source?.assignedProviderType || !provider || provider === source.assignedProviderType) return 'review_independence_required';
    const scope = source.ownedPaths && currentPhysicalScope(source.ownershipScope, source.ownedPaths);
    if (source.status !== 'completed' || !scope || !context || context.machineId !== scope.machineId) return 'review_input_unavailable';
    try { if (realpathSync.native(context.workspace) !== scope.worktree) return 'review_input_unavailable'; } catch { return 'review_input_unavailable'; }
    if (active.some(writer => {
        if ((writer.status !== 'assigned' && !pendingLaunchReservation(writer)) || writer.readonly || writer.taskMode === 'live_debug_readonly') return false;
        if (pinnedMeshNodeIdMatches(writer.assignedNodeId, scope.nodeId)) return true;
        const paths = writer.ownedPaths ?? { paths: [{ path: '', subtree: true }] };
        return comparePhysicalOwnership(source.ownedPaths!, scope, paths, currentPhysicalScope(writer.ownershipScope, paths)).physicalConflict;
    })) return 'review_input_busy';
    return undefined;
}

/** Short lived launch reservations prevent a multi-task pass oversubscribing caps before claims. */
export function pendingLaunchReservation(task: MeshWorkQueueEntry, now = Date.now()): boolean {
    const al = task.autoLaunch;
    if (task.status !== 'pending' || !al || !al.nodeId || !al.providerType || (al.status !== 'started' && al.status !== 'completed')) return false;
    const age = now - Date.parse(al.updatedAt);
    return age >= -5000 && age < 90_000;
}
