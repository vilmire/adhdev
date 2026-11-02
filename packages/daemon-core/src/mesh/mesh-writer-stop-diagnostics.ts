/**
 * Why a queue cancel was refused, in words a coordinator can act on.
 *
 * `mesh_queue_cancel` on an assigned task first asks the owning host to prove the worker is gone. When the
 * worker is alive but stuck (for example parked on a prompt nobody can answer), the host rightly refuses to
 * claim quiescence and the cancel answered only "unknown, cannot prove dead". The safety rule is unchanged
 * (a genuinely unknown host stays unknown); this only records the host's last stated reason and names the
 * way out: stop the worker session, after which the host can attest absence and the cancel goes through.
 */
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';

const lastPending = new Map<string, { reason: string; at: number }>();
const MAX_REMEMBERED = 200;

/** Called by the exact-writer-stop path whenever it answers `writer_checkpoint_pending`. */
export function noteWriterStopPending(sessionId: string | undefined, reason: string): void {
    if (!sessionId) return;
    if (lastPending.size >= MAX_REMEMBERED) {
        const oldest = lastPending.keys().next().value;
        if (oldest !== undefined) lastPending.delete(oldest);
    }
    lastPending.set(sessionId, { reason, at: Date.now() });
}

export function lastWriterStopPendingReason(sessionId: string | undefined): string | undefined {
    return sessionId ? lastPending.get(sessionId)?.reason : undefined;
}

export function resetWriterStopDiagnosticsForTests(): void { lastPending.clear(); }

/** The suffix appended to the cancel refusal text. Empty when the row names no worker session. */
export function writerCancelRefusalHint(task: Pick<MeshWorkQueueEntry, 'assignedSessionId' | 'assignedNodeId'> | null | undefined): string {
    const sessionId = task?.assignedSessionId;
    if (!sessionId) return '';
    const reason = lastWriterStopPendingReason(sessionId);
    const node = task?.assignedNodeId;
    return ` Worker session ${sessionId}${node ? ` on node ${node}` : ''} is still registered${reason ? ` (the host's last answer: ${reason})` : ''}.`
        + ` If it is stuck, stop it — mesh_cleanup_sessions {mode:"stop"${node ? `, node_id:"${node}"` : ''}, session_ids:["${sessionId}"]} — so the host can confirm it is gone, then cancel the task again.`;
}
