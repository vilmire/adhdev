/**
 * Coordinator notice for an assigned worker parked on a permission prompt the daemon cannot read.
 *
 * A prompt with a readable modal reaches the coordinator through the turn ledger and the inbox. When the
 * provider is waiting for approval but the modal could not be read (`providerApproval.evidence ===
 * 'unavailable'`, no modalKey), nothing can answer it from here and the task simply sat `assigned` with an
 * idle-looking worker for many minutes (owner report 2026-11-01). This pages the coordinator ONCE per
 * (task, session, attempt) after a short grace, names the session and the ways out. It changes no state.
 */
import type { DaemonComponents } from '../boot/daemon-components.js';
import { notifyMeshCoordinator } from './turn-ledger/deliver.js';
import { getMachineId } from '../config/config.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';

export const UNREADABLE_APPROVAL_NOTICE_AFTER_MS = 90_000;

const firstSeen = new Map<string, number>();
const noticed = new Set<string>();
const MAX_TRACKED = 500;

export function resetStuckApprovalNoticesForTests(): void { firstSeen.clear(); noticed.clear(); }

function remember(set: Set<string>, key: string): void {
    set.add(key);
    if (set.size > MAX_TRACKED) { const oldest = set.values().next().value; if (oldest !== undefined) set.delete(oldest); }
}

/** True when the session is parked on a permission prompt whose modal the daemon could not read. */
export function hasUnreadableApproval(state: any): boolean {
    const approval = state?.activeChat?.providerApproval ?? state?.providerApproval;
    return !!approval && approval.lifecycle === 'pending' && approval.evidence === 'unavailable' && approval.resolvedAt == null;
}

export function stuckApprovalCoordinatorMessage(task: { id: string; assignedSessionId?: string; assignedNodeId?: string; assignedProviderType?: string }, waitedMs: number): string {
    const sid = task.assignedSessionId ?? '?';
    const node = task.assignedNodeId;
    return `[System] Worker session ${sid}${task.assignedProviderType ? ` (${task.assignedProviderType})` : ''} for task ${task.id} has been waiting ${Math.floor(waitedMs / 60_000) || 1} min on a permission prompt the daemon cannot read, so it cannot be approved or rejected from here. The task stays assigned. `
        + `Next actions: look at the real screen with mesh_read_terminal {session_id:"${sid}"}; if the prompt is safe, answer it with mesh_send_keys; otherwise the owner can answer it in the dashboard To do drawer. `
        + `If the worker is stuck, stop it — mesh_cleanup_sessions {mode:"stop"${node ? `, node_id:"${node}"` : ''}, session_ids:["${sid}"]} — then cancel or re-enqueue the task.`;
}

/** Page once per episode. Cheap: only assigned rows with a live local instance are read. */
export function notifyStuckAssignedWorkers(
    components: Pick<DaemonComponents, 'instanceManager'> | null | undefined,
    meshId: string,
    now: number = Date.now(),
    afterMs: number = UNREADABLE_APPROVAL_NOTICE_AFTER_MS,
): number {
    const manager = components?.instanceManager as { getInstance?: (id: string) => { getState?: () => any } | undefined } | undefined;
    if (!manager?.getInstance) return 0;
    let paged = 0;
    const live = new Set<string>();
    for (const task of MeshRuntimeStore.getInstance().getQueueEntries(meshId, ['assigned'])) {
        const sessionId = task.assignedSessionId;
        if (!sessionId) continue;
        const key = `${meshId}:${task.id}:${sessionId}:${task.attemptId ?? ''}`;
        let state: any;
        try { state = manager.getInstance(sessionId)?.getState?.(); } catch { continue; }
        if (!hasUnreadableApproval(state)) { firstSeen.delete(key); continue; }
        live.add(key);
        const since = firstSeen.get(key) ?? now;
        if (!firstSeen.has(key)) firstSeen.set(key, since);
        if (noticed.has(key) || now - since < afterMs) continue;
        const coordinatorMessage = stuckApprovalCoordinatorMessage(task, now - since);
        const queued = notifyMeshCoordinator({
            event: 'mesh:worker_approval_unreadable', meshId, eventId: `worker-approval-unreadable:${key}`, nodeLabel: task.assignedNodeId || meshId,
            ...(task.assignedNodeId ? { nodeId: task.assignedNodeId } : {}),
            coordinatorMessage, queuedAt: now,
            targetCoordinatorDaemonId: getMachineId(),
            ...(task.sourceCoordinatorSessionId ? { targetCoordinatorSessionId: task.sourceCoordinatorSessionId } : {}),
            metadataEvent: { source: 'mesh_worker_approval_unreadable', taskId: task.id, sessionId, waitedMs: now - since, coordinatorMessage },
        });
        if (queued) { remember(noticed, key); paged += 1; }
    }
    for (const key of [...firstSeen.keys()]) if (key.startsWith(`${meshId}:`) && !live.has(key)) firstSeen.delete(key);
    return paged;
}
