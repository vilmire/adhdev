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
import { defineCommandSpecs } from '../command-registry.js';
import { findLocalWorkerOfRemoteTask, resolveRemoteWorker } from './worker-report.js';
import { LOG } from '../../logging/logger.js';

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
            const store = MeshRuntimeStore.getInstance();
            const entry = store.findQueueEntryById(meshId, taskId);
            const { depositWorkerMailboxMessage, pruneWorkerMailboxes } = await import('../../mesh/worker-mailbox.js');
            if (!entry) {
                // F7 (mailbox axis): `mesh_notify_worker` routes the deposit to the
                // daemon that owns the target NODE — for a cross-machine worker that
                // is the worker's daemon, while the queue row lives on the task's
                // owner. This daemon still knows the task authoritatively when one of
                // its own live sessions carries the assignment stamp for it. The memo
                // is kept HERE because this is the daemon the worker's MCP drains
                // from on every tool response (no per-tool-call relay to the owner).
                const worker = findLocalWorkerOfRemoteTask(_ctx, meshId, taskId);
                if (!worker) {
                    return {
                        success: false,
                        error: 'task_not_found_locally',
                        detail: `no local queue row for task ${taskId} on mesh ${meshId}, and no live worker session on this daemon is assigned it — this daemon may not own or have reconciled it`,
                    };
                }
                // The owner's terminal chokepoint cannot discard a memo held here:
                // sweep memos for remote-owned tasks no local session carries any more.
                const dropped = pruneWorkerMailboxes((m, t) => !!store.findQueueEntryById(m, t) || !!findLocalWorkerOfRemoteTask(_ctx, m, t));
                if (dropped > 0) LOG.info('WorkerMailbox', `Dropped ${dropped} undelivered memo(s) for remote-owned task(s) no local worker holds any more`);
                LOG.info('WorkerMailbox', `Memo for remote-owned task ${taskId} (owner ${worker.ownerDaemonId.slice(0, 16)}) held for its local worker session ${worker.sessionId}`);
            }

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
            // F7 (mailbox axis): a worker whose task another daemon owns has no
            // local identity; its memos are deposited HERE (see the deposit
            // handler), keyed by the task its assignment stamp names.
            const remote = identity ? null : await resolveRemoteWorker(_ctx, args);
            const target = identity
                ? { meshId: identity.meshId, taskId: identity.taskId }
                : remote?.taskId ? { meshId: remote.meshId, taskId: remote.taskId } : null;
            if (!target) {
                return { success: false, error: 'unauthenticated' };
            }
            const { drainWorkerMailboxForTask } = await import('../../mesh/worker-mailbox.js');
            const messages = drainWorkerMailboxForTask(target.meshId, target.taskId)
                .map((m) => ({ id: m.id, text: m.text }));
            return { success: true, taskId: target.taskId, messages };
        } catch (e: any) {
            return { success: false, error: e?.message || String(e) };
        }
    },
};

export const workerMailboxSpecs = defineCommandSpecs('low', workerMailboxHandlers, {
    // A coordinator's memo for its worker: the sender must coordinate the local
    // worker session assigned (meshId, taskId), else be on that mesh's roster.
    deposit_worker_mailbox: { meshSender: 'session_coordinator' },
}, { meshSender: 'authenticated_peer' });
