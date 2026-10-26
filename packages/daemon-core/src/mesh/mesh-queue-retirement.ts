import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { getActiveTurnLedger } from './turn-ledger/active-ledger.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';

/** Command preflight: persist stop intent, then ask the owning host for an
 * authenticated receipt. Never infer death from the coordinator's adapter map.
 * Queue mutations remain synchronous and may proceed only after settlement. */
export async function settleQueueWriter(meshId: string, taskId: string, reason: 'superseded' | 'operator_cancel'): Promise<void> {
    const store = MeshRuntimeStore.getInstance();
    const attempt = store.turnStore().findLatestAttemptForTask(meshId, taskId);
    if (!attempt || attempt.terminal) return;
    const ledger = getActiveTurnLedger();
    if (!ledger || !daemonIdsEquivalent(attempt.ownerDaemonId, ledger.selfDaemonId)) return;
    ledger.observe({ eventId: `queue-stop:${reason}:${attempt.attemptId}:g${attempt.generation}:${Date.now()}`,
        kind: 'cancel', source: 'operator', at: Date.now(), observedBy: ledger.selfDaemonId,
        sessionId: attempt.sessionId, taskId, attemptRef: { attemptId: attempt.attemptId, generation: attempt.generation }, reason });
    await ledger.resumeStoppingWriters(attempt.attemptId);
}

export const WRITER_UNKNOWN_ERROR = 'unknown, cannot prove dead: the owning host has not confirmed session absence or exact writer quiescence; ownership remains retained';
