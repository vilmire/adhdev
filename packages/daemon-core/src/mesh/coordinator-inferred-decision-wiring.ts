/**
 * Production wiring for coordinator-inferred-decision.ts (kept apart so the extractor
 * stays dependency-free and unit-testable).
 */
import type { DaemonComponents } from '../boot/daemon-components.js';
import type { Unsubscribe } from '../sessions/lifecycle-bus.js';
import { recoverAttemptReport } from '../assistant/attempt-report-recovery.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { upsertStructuredMission } from './mesh-mission-structured.js';
import { INFERRED_DECISION_CONTEXT, subscribeInferredOwnerDecisions } from './coordinator-inferred-decision.js';

export function wireInferredOwnerDecisions(components: Pick<DaemonComponents, 'bus' | 'instanceManager' | 'router'>): Unsubscribe {
    return subscribeInferredOwnerDecisions({
        bus: components.bus,
        coordinatorMeshOf: (sessionId) => {
            try {
                const inst = components.instanceManager.getInstance(sessionId) as unknown as { getState?: () => { settings?: Record<string, unknown> } } | undefined;
                const meshId = inst?.getState?.()?.settings?.meshCoordinatorFor;
                return typeof meshId === 'string' && meshId.trim() ? meshId.trim() : null;
            } catch { return null; }
        },
        readFinalMessage: async (meshId, sessionId, attemptId) => {
            const runtime = MeshRuntimeStore.getInstance();
            const report = await recoverAttemptReport(
                runtime.db, runtime.turnStore().getAttempt(attemptId), meshId, sessionId,
                (cmd, args) => components.router.execute(cmd, args, 'ipc', { inProcess: true }),
            );
            return typeof report.body === 'string' && report.body ? report.body : null;
        },
        decisionRegisteredSince: (meshId, sinceMs) =>
            MeshRuntimeStore.getInstance().missionItems()
                .listMeshEvents(meshId, ['item_added'], new Date(sinceMs).toISOString(), 200)
                .some(ev => ev.payload.kind === 'decision'),
        register: (meshId, q) => {
            upsertStructuredMission(meshId, {
                toCarryOver: true,
                itemsAdd: [{
                    kind: 'decision',
                    question: q.question,
                    context: INFERRED_DECISION_CONTEXT,
                    options: q.options,
                    allowFreeText: true,
                }],
            }, { actor: 'daemon' });
        },
    });
}
