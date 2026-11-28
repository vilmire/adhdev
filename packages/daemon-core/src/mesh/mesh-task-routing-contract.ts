import { daemonIdsEquivalent, meshNodeIdMatches, sessionIdsEquivalent } from '@adhdev/mesh-shared';
import { getMesh } from '../config/mesh-config.js';
import type { SessionBusyVerdict } from './mesh-candidacy-predicates.js';
import { sessionStopPending } from './mesh-session-stop-fence.js';
import { pinnedMeshNodeIdMatches } from './mesh-pinned-node-identity.js';
import { realpathSync } from 'node:fs';
import type { MeshRoutingPreferences, MeshTaskStatus, PhysicalOwnershipScope } from '@adhdev/mesh-shared';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';
import { currentPhysicalScope, comparePhysicalOwnership } from './mesh-physical-ownership.js';
import { reviewIndependenceOf } from '@adhdev/mesh-shared';
import { currentStageReviewScope, validateStageReviewRetainedGrants } from './stage-review-input.js';
import type { MeshRuntimeStore } from './mesh-runtime-store.js';
import { isStageParent } from './stage-state.js';
import { resolvePathOwnershipGate } from './mesh-path-ownership-gate.js';

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

type WriterActivity = (sessionId: string) => SessionBusyVerdict;

export interface ReviewRoutingContext {
    workspace: string; machineId: string; repoIdentity?: string;
    reviewWriterActivity?: WriterActivity;
    /** Set when the claiming node is on another machine: that machine's attestation, never a local one. */
    remoteOwnership?: (candidate: MeshWorkQueueEntry) => { scope: import('@adhdev/mesh-shared').PhysicalOwnershipScope } | { error: string };
}
/** Input availability is proven locally; a remote source needs a future verified transfer contract. */
export function reviewRoutingRefusal(task: Pick<MeshWorkQueueEntry, 'review' | 'readonly' | 'taskMode'> & Partial<MeshWorkQueueEntry>, source: MeshWorkQueueEntry | undefined | null, provider: string | undefined, context: ReviewRoutingContext | undefined, active: readonly MeshWorkQueueEntry[] = [], claimingSessionId?: string, artifactStore?: Pick<MeshRuntimeStore, 'db'>, writerStore?: Pick<MeshRuntimeStore, 'db' | 'turnStore'>): string | undefined {
    if (!task.review) return undefined;
    if (!task.readonly && task.taskMode !== 'live_debug_readonly') return 'review_requires_readonly';
    if (!source?.assignedProviderType || !provider) return 'review_independence_required';
    // Independence: different provider by default; `fresh_session` (stage fallback, R2) allows the same provider
    // but never the implementer's own session.
    if (reviewIndependenceOf(task.review) === 'different_provider') {
        if (provider === source.assignedProviderType) return 'review_independence_required';
    } else if (claimingSessionId && source.assignedSessionId && claimingSessionId === source.assignedSessionId) {
        return 'review_independence_required';
    }
    if (artifactStore && source.stageState) {
        try { validateStageReviewRetainedGrants(artifactStore, source, task.inputArtifactIds ?? []); }
        catch { return 'review_input_unavailable'; }
    }
    // A daemon-prepared reviewer workspace (light workspace pinned to the round head) cannot collide with the
    // implementer's checkout: no input-availability or busy-writer check applies.
    if (task.reviewerWorkspace && !source.stageReviewInput) return undefined;
    // A stage parent awaiting/under review is `assigned` by design (it keeps its write slot for the revise loop),
    // so it counts as available input and is never the writer that blocks its own review.
    const stageSource = isStageParent(source) && source.status === 'assigned'
        && (source.stageState!.phase === 'awaiting_review' || source.stageState!.phase === 'reviewing');
    const scope = stageSource ? currentStageReviewScope(source, task) : source.ownedPaths && currentPhysicalScope(source.ownershipScope, source.ownedPaths);
    if ((source.status !== 'completed' && !stageSource) || !scope || !context || context.machineId !== scope.machineId || (context.repoIdentity && context.repoIdentity !== scope.repoIdentity)) return 'review_input_unavailable';
    try { if (realpathSync.native(context.workspace) !== scope.worktree) return 'review_input_unavailable'; } catch { return 'review_input_unavailable'; }
    if (stageSource && source.attemptId && writerStore && !stageReviewWriterSettled(writerStore, source, context.reviewWriterActivity)) return 'review_input_busy';
    if (reviewInputBusy(source, scope, active, stageSource, writerStore, context.reviewWriterActivity)) return 'review_input_busy';
    return undefined;
}

/** Same physical writer fence before enqueue and inside actual reviewer admission. */
export function reviewInputBusy(source: MeshWorkQueueEntry, scope: PhysicalOwnershipScope, active: readonly MeshWorkQueueEntry[], stageSource: boolean, store?: Pick<MeshRuntimeStore, 'db' | 'turnStore'>, activity?: WriterActivity): boolean {
    return active.some(writer => {
        if (stageSource && writer.id === source.id) return false;
        if ((writer.status !== 'assigned' && !pendingLaunchReservation(writer)) || writer.readonly || writer.taskMode === 'live_debug_readonly') return false;
        const settled = () => store && stageReviewWriterSettled(store, writer, activity);
        if (pinnedMeshNodeIdMatches(writer.assignedNodeId, scope.nodeId)) return !settled();
        const paths = writer.ownedPaths ?? { paths: [{ path: '', subtree: true }] };
        const writerScope = currentPhysicalScope(writer.ownershipScope, paths);
        // Keep the existing cross-checkout routing policy for writers without declared ownership.
        const crossCheckout = (!!writer.light || !!(writer.assignedNodeId ?? writer.autoLaunch?.nodeId)) && resolvePathOwnershipGate(source.meshId) !== 'mesh_wide';
        if (crossCheckout && !writerScope && !writer.ownershipScope) return false;
        return comparePhysicalOwnership(stageSource ? { paths: [] } : source.ownedPaths ?? { paths: [] }, scope, paths, writerScope).physicalConflict
            && !settled();
    });
}

/**
 * Release only the review-input fence. An assigned stage still reserves its
 * write slot for the revision loop. A self-check can also run Git/build tools,
 * so its phase cannot prove a writer stopped.
 */
export function stageReviewWriterSettled(store: Pick<MeshRuntimeStore, 'db' | 'turnStore'>, row: MeshWorkQueueEntry, activity?: WriterActivity): boolean {
    const st = row.stageState;
    if (row.status !== 'assigned' || !isStageParent(row) || !st || st.released
        || (st.phase !== 'awaiting_review' && st.phase !== 'reviewing')
        || !row.attemptId || st.handledAttemptIds?.at(-1) !== row.attemptId
        || !row.assignedNodeId || !row.assignedSessionId || !row.assignedProviderType) return false;
    try {
        const node = getMesh(row.meshId)?.nodes?.find(n => meshNodeIdMatches({ id: n.id }, row.assignedNodeId!));
        if (row.ownershipScope && (!row.ownedPaths || !node?.workspace
            || realpathSync.native(node.workspace) !== row.ownershipScope.worktree
            || !currentPhysicalScope(row.ownershipScope, row.ownedPaths))) return false;
        const turns = store.turnStore();
        const attempt = turns.findLatestAttemptForTask(row.meshId, row.id);
        if (!node?.daemonId || !attempt || attempt.scope !== 'mesh_queue'
            || attempt.attemptId !== row.attemptId || attempt.state !== 'completed' || attempt.terminal?.outcome !== 'completed'
            || !attempt.nodeId || !meshNodeIdMatches({ id: attempt.nodeId }, row.assignedNodeId)
            || !sessionIdsEquivalent(attempt.sessionId, row.assignedSessionId)
            || attempt.providerType !== row.assignedProviderType
            || !daemonIdsEquivalent(attempt.ownerDaemonId, node.daemonId)
            || attempt.dispatchNonce !== (row.dispatchNonce ?? null)) return false;
        const stop = attempt.data.writerStop;
        if (stop && (!stop.confirmed || stop.settledBy)) return false;
        const report = attempt.data.report;
        const reported = (report?.generation === attempt.generation && report.outcome === 'completed')
            || (attempt.terminal.strength === 'tool_report' && attempt.terminal.source === 'worker_tool'
                && attempt.terminal.reason === 'worker_reported');
        const observedEnd = attempt.terminal.strength === 'genuine'
            && ['turn_end', 'transcript_final'].includes(attempt.terminal.reason);
        const runtime = activity?.(row.assignedSessionId);
        if (runtime === 'GENERATING' || (!observedEnd && !(reported && (stop?.confirmed || runtime === 'IDLE_CONFIRMED')))) return false;
        if (sessionStopPending(store.db, row.assignedSessionId) || turns.findOpenAttemptForSession(row.assignedSessionId)) return false;
        return !turns.listOpenAttempts({ meshId: row.meshId }).some(open => open.taskId === row.id);
    } catch { return false; }
}

/**
 * The only statuses a row can occupy capacity in: claimed (`assigned`) or holding a launch
 * reservation (which requires `pending`). Capacity readers filter on these in SQL instead of
 * parsing the whole queue — the terminal history (completed/failed/cancelled, ~1.6k rows /
 * 6 MB on the preview coordinator) was re-parsed per slot per node per tick and pinned the
 * daemon's event loop.
 */
export const CAPACITY_OCCUPYING_STATUSES: readonly MeshTaskStatus[] = ['assigned', 'pending'];

/** Short lived launch reservations prevent a multi-task pass oversubscribing caps before claims. */
export function pendingLaunchReservation(task: MeshWorkQueueEntry, now = Date.now()): boolean {
    const al = task.autoLaunch;
    if (task.status !== 'pending' || !al || !al.nodeId || !al.providerType || (al.status !== 'started' && al.status !== 'completed')) return false;
    const age = now - Date.parse(al.updatedAt);
    return age >= -5000 && age < 90_000;
}
