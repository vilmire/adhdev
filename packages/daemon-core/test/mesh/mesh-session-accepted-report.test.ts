import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { commitTaskTerminal } from '../../src/mesh/mesh-task-terminal.js';
import { acceptWorkerCompletionReportForIdentity } from '../../src/mesh/worker-report.js';
import { acceptLateWorkerCompletionReport, __setWorkerLateReportNoticeSinkForTests } from '../../src/mesh/worker-report-late.js';
import { acceptedCompletionSessionIds } from '../../src/mesh/mesh-session-lifetime.js';
import { seedMeshAttempt, advanceSeededAttempt } from '../helpers/turn-attempt-seed.js';

function providerCompletedTask() {
    const meshId = `mesh_${randomUUID()}`, taskId = randomUUID(), sessionId = randomUUID();
    const store = MeshRuntimeStore.getInstance();
    const now = Date.now();
    store.insertQueueEntry({ id: taskId, meshId, message: 'read only inspection', status: 'assigned', assignedSessionId: sessionId,
        readonly: true, taskMode: 'live_debug_readonly', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() } as any);
    const attempt = seedMeshAttempt({ meshId, taskId, sessionId, stage: 'generating', nowMs: now });
    commitTaskTerminal({ meshId, taskId, sessionId, attemptId: attempt.attemptId, status: 'completed', source: 'provider_event',
        envelope: { evidence: { summarySource: 'native' }, finalSummary: 'provider finished' } });
    advanceSeededAttempt(attempt.attemptId, 'completed', { nowMs: now });
    const identity = { token: '', meshId, taskId, sessionId, attemptId: attempt.attemptId };
    const task = store.findQueueEntryById(meshId, taskId)!;
    return { meshId, task, identity, now };
}

describe('accepted report lifetime audit through real report paths', () => {
    it('records duplicate acceptance when the provider already committed the task', () => {
        const { meshId, task, identity, now } = providerCompletedTask();
        expect([...acceptedCompletionSessionIds(meshId, [{ sessionId: identity.sessionId }])]).toEqual([]);
        const result = acceptWorkerCompletionReportForIdentity(identity, { outcome: 'completed', summary: 'inspected it', touchedFiles: [] }, { nowMs: now });
        expect(result).toMatchObject({ accepted: true, duplicate: true });
        expect([...acceptedCompletionSessionIds(meshId, [{ sessionId: identity.sessionId }])]).toEqual([identity.sessionId]);
    });
    it('records accepted late evidence and preserves the provider terminal output', () => {
        const { meshId, task, identity, now } = providerCompletedTask();
        __setWorkerLateReportNoticeSinkForTests(null);
        try {
            const result = acceptLateWorkerCompletionReport({ ...identity, terminalOutcome: 'completed', terminalAtMs: now },
                { outcome: 'completed', summary: 'late authoritative report', touchedFiles: [] }, now + 1000);
            expect(result.accepted).toBe(true);
            expect([...acceptedCompletionSessionIds(meshId, [{ sessionId: identity.sessionId }])]).toEqual([identity.sessionId]);
            expect(JSON.parse(MeshRuntimeStore.getInstance().getLatestTaskOutput(task.id)!.envelopeJson).evidence.summarySource).toBe('native');
        } finally { __setWorkerLateReportNoticeSinkForTests(undefined); }
    });
    it('does not record lifetime acceptance for a refused report', () => {
        const { meshId, task, identity, now } = providerCompletedTask();
        const result = acceptWorkerCompletionReportForIdentity(identity, { outcome: 'completed', summary: 'invalid readonly changes', touchedFiles: ['wrong.ts'] }, { nowMs: now });
        expect(result.accepted).toBe(false);
        expect([...acceptedCompletionSessionIds(meshId, [{ sessionId: identity.sessionId }])]).toEqual([]);
    });
});
