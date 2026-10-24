/** Owner half: successful source attach, then queue + ledger CAS in one txn.
 * A late owner CAS rolls the source stamp back only while that prepare owns it. */
import { meshNodeIdMatches } from '@adhdev/mesh-shared';
import { readMeshNodeDaemonId } from './mesh-node-identity.js';
import { getMeshWithCache } from './mesh-queue-mesh-view.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { bridgeReceiptTransaction } from './worker-bridge-transaction.js';
import { unwrapMeshRelayResult } from '../commands/mesh-relay-result.js';
import type { DeliverTaskContext } from './mesh-queue-dispatch.js';
import type { TurnEvidence } from '@adhdev/mesh-shared';
import type { DaemonComponents } from '../boot/daemon-components.js';

export async function reconcileDuplicateHolder(ctx: DeliverTaskContext, holderSessionId: string, operationId: string): Promise<boolean> {
    const ledger = ctx.components.turnLedger, ref = ctx.attemptRef;
    if (!ledger || !ref) return false;
    const before = ledger.getAttempt(ref.attemptId);
    const store = MeshRuntimeStore.getInstance(), db = store.db;
    db.exec('CREATE TABLE IF NOT EXISTS mesh_holder_reconciles (operation_id TEXT PRIMARY KEY, context_json TEXT NOT NULL, holder TEXT NOT NULL, phase TEXT NOT NULL, tries INTEGER NOT NULL)');
    const existing = db.prepare('SELECT phase,tries FROM mesh_holder_reconciles WHERE operation_id = ?').get(operationId) as { phase: string; tries: number } | undefined;
    if (!existing && (!before || before.terminal || before.state === 'stopping' || before.generation !== ref.generation)) return false;
    if (existing?.phase === 'settled' || existing?.phase === 'rolled_back') return existing.phase === 'settled';
    if ((existing?.tries ?? 0) >= 3) return false;
    const context = { ...ctx, components: undefined };
    if (!existing) db.prepare('INSERT INTO mesh_holder_reconciles VALUES (?,?,?,?,0)').run(operationId, JSON.stringify(context), holderSessionId, 'preparing');
    db.prepare('UPDATE mesh_holder_reconciles SET tries = tries + 1 WHERE operation_id = ?').run(operationId);
    const mc = { meshId: ctx.meshId, taskId: ctx.task.id, nodeId: ctx.nodeId, attemptId: ref.attemptId,
        attemptGeneration: ref.generation, dispatchNonce: ctx.task.dispatchNonce, coordinatorDaemonId: ledger.selfDaemonId,
        ...(ctx.sourceCoordinatorSessionId ? { coordinatorSessionId: ctx.sourceCoordinatorSessionId } : {}) };
    let daemonId = ctx.remoteDaemonId;
    if (ctx.transport === 'remote' && !daemonId) {
        try {
            const mesh = getMeshWithCache(ctx.components, ctx.meshId);
            const node = mesh?.nodes.find((n: { id: string }) => meshNodeIdMatches(n, ctx.nodeId));
            daemonId = node ? readMeshNodeDaemonId(node) || undefined : undefined;
        } catch { return false; }
    }
    const invoke = async (phase: 'prepare' | 'commit' | 'rollback') => {
        const args = { action: 'reconcile_mesh_holder', agentType: ctx.providerType, targetSessionId: holderSessionId,
            meshContext: mc, holderReconcile: { operationId, phase } };
        const raw = ctx.transport === 'local' ? await ctx.components.cliManager.agentCommand(args)
            : daemonId && ctx.components.dispatchMeshCommand ? await ctx.components.dispatchMeshCommand(daemonId, 'agent_command', args) : null;
        return unwrapMeshRelayResult(raw, { command: 'agent_command', peerDaemonId: daemonId });
    };
    if (existing?.phase === 'bound') {
        try {
            const reply = await invoke('commit');
            if (reply.success) db.prepare("UPDATE mesh_holder_reconciles SET phase = 'settled' WHERE operation_id = ?").run(operationId);
            return reply.success === true;
        } catch { return false; }
    }
    if (!before || before.terminal || before.state === 'stopping' || before.generation !== ref.generation) {
        try {
            const reply = await invoke('rollback');
            if (reply.success) db.prepare("UPDATE mesh_holder_reconciles SET phase = 'rolled_back' WHERE operation_id = ?").run(operationId);
        } catch { /* Explicit checkpoint pending; the assigned claim stays exclusive. */ }
        return false;
    }
    let attached = false, rebound = false;
    try {
        const proof = await invoke('prepare');
        if (!proof.success || proof.attached !== true || proof.operationId !== operationId || proof.sessionId !== holderSessionId
            || proof.meshId !== mc.meshId || proof.taskId !== mc.taskId || proof.attemptId !== mc.attemptId
            || proof.attemptGeneration !== mc.attemptGeneration || proof.dispatchNonce !== mc.dispatchNonce) return false;
        attached = true;
        bridgeReceiptTransaction(store.db, () => {
            const a = ledger.getAttempt(ref.attemptId), q = store.findQueueEntryById(ctx.meshId, ctx.task.id);
            if (!a || a.terminal || a.state === 'stopping' || a.generation !== ref.generation || a.sessionId !== before.sessionId
                || a.meshId !== ctx.meshId || a.taskId !== ctx.task.id || a.nodeId !== ctx.nodeId || a.providerType !== ctx.providerType
                || !q || q.status !== 'assigned' || q.assignedSessionId !== ctx.sessionId || q.assignedNodeId !== ctx.nodeId
                || q.assignedProviderType !== ctx.providerType
                || q.attemptId !== ref.attemptId || q.dispatchNonce !== ctx.task.dispatchNonce) throw new Error('holder_owner_CAS_changed');
            const result = ledger.observe({ eventId: operationId, kind: 'duplicate_dispatch_refusal', source: 'dispatch',
                at: Date.now(), observedBy: ledger.selfDaemonId, sessionId: ctx.sessionId, taskId: ctx.task.id,
                attemptRef: ref, holderSessionId, holderAttemptId: ref.attemptId } as TurnEvidence);
            if (result.rule !== 'R25' || result.verdict !== 'applied') throw new Error('holder_ledger_CAS_refused');
            q.assignedSessionId = holderSessionId;
            store.updateQueueEntry(q);
            db.prepare("UPDATE mesh_holder_reconciles SET phase = 'bound' WHERE operation_id = ?").run(operationId);
        });
        rebound = true;
        const commit = await invoke('commit');
        if (commit.success) db.prepare("UPDATE mesh_holder_reconciles SET phase = 'settled' WHERE operation_id = ?").run(operationId);
        return true;
    } catch { return false; }
    finally {
        if (attached && !rebound) {
            try {
                const reply = await invoke('rollback');
                if (reply.success) db.prepare("UPDATE mesh_holder_reconciles SET phase = 'rolled_back' WHERE operation_id = ?").run(operationId);
            } catch { /* Retain the durable intent for bounded boot reconciliation. */ }
        }
    }
}

/** Resume each durable in-flight attach once per boot, with the original route
 * and operation id. The per-operation retry count survives owner restarts. */
export async function resumePendingHolderReconciles(components: DaemonComponents): Promise<void> {
    const db = MeshRuntimeStore.getInstance().db;
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mesh_holder_reconciles'").get()) return;
    const rows = db.prepare("SELECT operation_id, context_json, holder FROM mesh_holder_reconciles WHERE phase IN ('preparing','bound') AND tries < 3").all() as
        Array<{ operation_id: string; context_json: string; holder: string }>;
    for (const row of rows) await reconcileDuplicateHolder({ ...JSON.parse(row.context_json), components }, row.holder, row.operation_id);
}
