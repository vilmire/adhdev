import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { commitTaskTerminal } from '../../src/mesh/mesh-task-terminal.js';
import { seedMeshAttempt, advanceSeededAttempt } from '../helpers/turn-attempt-seed.js';
import { runIdleSessionReapPass } from '../../src/mesh/mesh-idle-session-reaper.js';
import { sessionLifetimeDeps } from '../../src/mesh/mesh-session-lifetime-runtime.js';

function fixture() {
    const store = MeshRuntimeStore.getInstance(), meshId = randomUUID(), sessionId = randomUUID(), taskId = randomUUID(), now = Date.now();
    const task: any = { id: taskId, meshId, status: 'assigned', assignedSessionId: sessionId, message: 'inspection', readonly: true,
        createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
    store.insertQueueEntry(task);
    const attempt = seedMeshAttempt({ meshId, taskId, sessionId, stage: 'generating', nowMs: now });
    commitTaskTerminal({ meshId, taskId, sessionId, status: 'completed', source: 'worker_tool_report', envelope: { evidence: { summarySource: 'tool_report' } } });
    advanceSeededAttempt(attempt.attemptId, 'completed');
    // This old terminal task must never be deserialized on a reap pass for the live worker.
    const old = randomUUID(); store.insertQueueEntry({ ...task, id: old, status: 'completed', assignedSessionId: randomUUID() });
    store.db.prepare('INSERT INTO mesh_task_outputs VALUES (?,1,?,1,?,?,?,?)').run(old, meshId, 'completed', 'not JSON', 'old', new Date(now).toISOString());
    const state: any = { instanceId: sessionId, status: 'idle', settings: { meshNodeFor: meshId, meshNodeId: 'node', launchedByCoordinator: true } };
    const record: any = { sessionId, lifecycle: 'running', lastActivityAt: now - 1000, meta: state.settings };
    const instance = { getState: () => state };
    const components: any = { instanceManager: { getInstance: () => instance, getByCategory: () => [instance] },
        router: { deps: { sessionHostControl: { listSessions: async () => [record] } } } };
    const mesh = { id: meshId, nodes: [] };
    const pass = () => runIdleSessionReapPass(sessionLifetimeDeps(components, mesh, now), { meshId, now, dryRun: true,
        policy: { delegatedSessionIdleTtlMinutes: 0, maxIdleDelegatedSessionsPerMachine: 0 } });
    return { store, pass, sessionId, taskId };
}

describe('review finding 2: reap query load', () => {
    it('uses filtered or column-only reads and ignores historical terminal envelopes', async () => {
        const f = fixture(), reads = vi.spyOn(f.store, 'getQueueEntries');
        try {
            expect((await f.pass()).plan.reap.map(r => r.sessionId)).toEqual([f.sessionId]);
            expect(reads.mock.calls.every(([, statuses]) => !!statuses?.length)).toBe(true);
        } finally { reads.mockRestore(); }
    });
    it('does not reload or parse an unchanged terminal envelope on the next pass', async () => {
        const f = fixture(), outputs = vi.spyOn(f.store, 'getLatestTaskOutput');
        try {
            expect((await f.pass()).plan.reap.map(r => r.sessionId)).toEqual([f.sessionId]);
            expect((await f.pass()).plan.reap.map(r => r.sessionId)).toEqual([f.sessionId]);
            expect(outputs).toHaveBeenCalledTimes(1);
        } finally { outputs.mockRestore(); }
    });
    it('invalidates the legacy output cache on a new immutable version', async () => {
        const f = fixture();
        expect((await f.pass()).plan.reap.map(r => r.sessionId)).toEqual([f.sessionId]);
        f.store.db.prepare(`INSERT INTO mesh_task_outputs SELECT task_id, version+1, mesh_id, attempt,
            status, ?, digest, created_at FROM mesh_task_outputs WHERE task_id = ? AND version = 1`)
            .run(JSON.stringify({ evidence: { summarySource: 'native' } }), f.taskId);
        expect((await f.pass()).plan.reap).toEqual([]);
    });

});
