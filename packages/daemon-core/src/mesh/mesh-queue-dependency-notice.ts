/**
 * Stopped-work notices for QUEUE-level `depends_on` chains — the D1 default path
 * (`mesh_enqueue_task` + `depends_on`, and a static `mesh_enqueue_batch`), which
 * creates no graph rows, so the graph notices never saw it (live 2026-09-25:
 * a cancelled root left two chained tasks `pending` forever, silently).
 *
 * Policy (unchanged, now VISIBLE): a queue task whose dependency ends
 * `failed`/`cancelled` waits (`block`, the default — retrying the dependency
 * recovers it; user work is never cancelled silently) unless the mesh policy
 * is `on_dependency_failure: cancel`. Either way the coordinator is told once:
 *   - `queue_dependency_blocked`   — block: which task ended and why, which tasks
 *                                    (transitively) wait on it, what to do;
 *   - `queue_dependency_cancelled` — cancel: what the cascade cancelled.
 * Tasks backed by a graph node are left to the graph notices (not listed here).
 *
 * The row joins the caller's queue transaction (graph outbox, graph_id NULL) and
 * rides the same drain → `notifyMeshCoordinator` path as the graph notices, so a
 * PTY-hosted and an MCP-only coordinator both get it. Ids and reason CODES only.
 */
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { newMeshGraphOutboxId } from './mesh-graph-types.js';
import { reasonCodeOf, type MeshQueueStopRoot, type MeshQueueStopTaskRef } from './mesh-graph-stop-notice.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue.js';

/** True when the task belongs to a graph (its failure is told by the graph notices). */
function isGraphBacked(store: MeshRuntimeStore, meshId: string, taskId: string): boolean {
    try {
        return !!store.graphStore().findNodeByQueueTaskId(meshId, taskId);
    } catch {
        return false;
    }
}

/**
 * The reason CODE for a terminal queue task. An operator cancel carries the
 * operator's own words in `cancelReason`, so a cancel collapses to
 * `operator_cancel` unless a machine reason says otherwise.
 */
export function queueRootReasonCode(entry: Pick<MeshWorkQueueEntry, 'status' | 'cancelReason'>, machineReason?: string): string {
    if (machineReason) {
        const code = reasonCodeOf(machineReason);
        if (code !== 'unspecified') return code;
    }
    const fromRow = reasonCodeOf(entry.cancelReason);
    if (entry.status === 'cancelled') return fromRow === 'dependency_failed' ? fromRow : 'operator_cancel';
    return fromRow === 'unspecified' ? 'task_failed' : fromRow;
}

/** Every PENDING non-graph task that waits (transitively, via depends_on) on `rootId`. */
export function collectWaitingQueueDependents(store: MeshRuntimeStore, meshId: string, rootId: string): MeshQueueStopTaskRef[] {
    const pending = store.getQueueEntries(meshId, ['pending']);
    const out: MeshQueueStopTaskRef[] = [];
    const seen = new Set<string>([rootId]);
    let frontier = [rootId];
    while (frontier.length > 0) {
        const next: string[] = [];
        for (const current of frontier) {
            for (const entry of pending) {
                if (seen.has(entry.id) || !Array.isArray(entry.dependsOn) || !entry.dependsOn.includes(current)) continue;
                seen.add(entry.id);
                next.push(entry.id);
                if (isGraphBacked(store, meshId, entry.id)) continue;
                out.push({ taskId: entry.id, ...(current !== rootId ? { via: current } : {}) });
            }
        }
        frontier = next;
    }
    return out;
}

/**
 * Write the one queue-chain notice for a task that just ended failed/cancelled.
 * MUST run inside the caller's queue lock; the caller drains after. Returns true
 * when a row was written (nothing waits / nothing was cancelled → no notice).
 */
export function insertQueueDependencyNoticeInTxn(
    meshId: string,
    rootId: string,
    policy: 'block' | 'cancel',
    cancelled: readonly MeshWorkQueueEntry[],
    machineReason?: string,
): boolean {
    const store = MeshRuntimeStore.getInstance();
    const root = store.findQueueEntryById(meshId, rootId);
    if (!root || (root.status !== 'failed' && root.status !== 'cancelled')) return false;
    const rootRef: MeshQueueStopRoot = {
        taskId: root.id,
        outcome: root.status,
        reasonCode: queueRootReasonCode(root, machineReason),
    };
    let kind: 'queue_dependency_blocked' | 'queue_dependency_cancelled';
    let body: Record<string, unknown>;
    if (policy === 'cancel') {
        const listed = cancelled
            .filter(c => !isGraphBacked(store, meshId, c.id))
            .map(c => {
                const via = (c.cancelReason ?? '').startsWith('dependency_failed:') ? c.cancelReason!.slice('dependency_failed:'.length) : undefined;
                return { taskId: c.id, ...(via && via !== rootId ? { via } : {}) };
            });
        if (listed.length === 0) return false;
        kind = 'queue_dependency_cancelled';
        body = { cancelled: listed };
    } else {
        const waiting = collectWaitingQueueDependents(store, meshId, rootId);
        if (waiting.length === 0) return false;
        kind = 'queue_dependency_blocked';
        body = { waiting };
    }
    const generation = store.graphStore().getLatestOutput(rootId)?.version ?? 0;
    const nowIso = new Date().toISOString();
    store.graphStore().insertOutboxEvent({
        id: newMeshGraphOutboxId(),
        meshId,
        kind,
        payload: JSON.stringify({ generation, root: rootRef, ...body }),
        status: 'pending',
        attemptCount: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
    });
    return true;
}
