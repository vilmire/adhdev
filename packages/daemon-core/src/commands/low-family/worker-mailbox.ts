/**
 * WORKER-MCP LOW family — E-T0 mailbox piggyback, the daemon side.
 *
 * Design SoT: docs/design/2026-08-28-worker-mcp.md §7.1 (T0), §9.1.1 (process
 * boundary), §9.2 (G lifecycle).
 *
 * Two handlers, two different callers:
 *
 *  - `deposit_worker_mailbox` is called BY A COORDINATOR (via `mesh_notify_worker`
 *    → `commandForNode`, routed to whichever daemon owns the target node — the
 *    coordinator's own daemon or a remote one, indistinguishably from here).
 *    There is no worker identity to check on this side; what there IS to check
 *    is whether THIS daemon even knows the task (see the comment below).
 *  - `worker_drain_mailbox` is called BY THE WORKER's own MCP server, on its own
 *    local/ipc transport, exactly like `worker_report_completion` — so identity
 *    resolves the same way, through the bind/token the caller presents.
 */
import type { LowFamilyContext, LowFamilyHandler } from './types.js';

export const workerMailboxHandlers: Record<string, LowFamilyHandler> = {
    /**
     * Coordinator writes an urgent memo into a worker's mailbox.
     *
     * ★ASYMMETRIC-MACHINE FIXTURE (design task constraint): the coordinator's
     * OWN daemon may not be the daemon that ever claimed this task — a mesh
     * spans machines, and `mesh_notify_worker` is routed to the daemon that
     * owns the target node, which is not necessarily local to the caller. That
     * receiving daemon might not have reconciled this exact task into its local
     * queue view yet (or the task may belong to a different mesh/daemon
     * entirely, e.g. a stale/mistyped id). Depositing blind in that case is a
     * silent no-op dressed up as success — the coordinator would believe an
     * urgent message landed when nothing will ever drain it. So this checks
     * `findQueueEntryById` against the LOCAL store before accepting, and
     * refuses with a distinguishable reason when it comes up empty, rather than
     * quietly accepting a memo destined for nobody.
     */
    deposit_worker_mailbox: async (_ctx: LowFamilyContext, args: any) => {
        try {
            const { isWorkerMcpEnabled } = await import('../../mesh/worker-mcp-isolation.js');
            if (!isWorkerMcpEnabled()) {
                return { success: false, error: 'worker_mcp_disabled' };
            }

            const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
            const taskId = typeof args?.taskId === 'string' ? args.taskId.trim() : '';
            const text = typeof args?.text === 'string' ? args.text.trim() : '';
            if (!meshId || !taskId || !text) {
                return { success: false, error: 'invalid_input', detail: 'meshId, taskId and text are all required' };
            }

            const { MeshRuntimeStore } = await import('../../mesh/mesh-runtime-store.js');
            const entry = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
            if (!entry) {
                return {
                    success: false,
                    error: 'task_not_found_locally',
                    detail: `no local queue row for task ${taskId} on mesh ${meshId} — this daemon may not own or have reconciled it`,
                };
            }

            const { depositWorkerMailboxMessage } = await import('../../mesh/worker-mailbox.js');
            const result = depositWorkerMailboxMessage({ meshId, taskId, text });
            if (!result.ok) {
                return { success: false, error: result.error, detail: result.detail };
            }
            return { success: true, messageId: result.id, pending: result.pending };
        } catch (e: any) {
            return { success: false, error: e?.message || String(e) };
        }
    },

    /**
     * Drain the caller's own pending mailbox messages. Identity resolves
     * exactly like `worker_report_completion` — a bind/token that fails to
     * resolve is reported as `unauthenticated` rather than as an empty
     * mailbox, so the mcp-server piggyback layer can tell "nothing to deliver"
     * apart from "could not even ask".
     */
    worker_drain_mailbox: async (_ctx: LowFamilyContext, args: any) => {
        try {
            const { resolveWorkerIdentity } = await import('../../mesh/worker-report.js');
            const identity = resolveWorkerIdentity({ token: args?.token, bind: args?.bind });
            if (!identity) {
                return { success: false, error: 'unauthenticated' };
            }
            const { drainWorkerMailboxForTask } = await import('../../mesh/worker-mailbox.js');
            const messages = drainWorkerMailboxForTask(identity.meshId, identity.taskId)
                .map((m) => ({ id: m.id, text: m.text }));
            return { success: true, taskId: identity.taskId, messages };
        } catch (e: any) {
            return { success: false, error: e?.message || String(e) };
        }
    },
};
