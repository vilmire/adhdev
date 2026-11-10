/** A named session that already ended must be reported as already_ended (a valid stop proof),
 * distinct from an id the daemon has never seen (unknown); live sessions are unchanged. */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { meshRecord } from '../../src/mesh/mesh-record.js';
import { cleanupMeshSessions } from '../../src/commands/router-worktree-cleanup.js';

function harness(records: any[]) {
    const control: any = {
        listSessions: async () => records,
        resolveHostBootId: async () => 'boot-1',
        stopSessionIfExpected: async () => ({ lifecycle: 'stopped' }),
    };
    const self: any = {
        deps: { sessionHostControl: control },
        // Only records that carry the requested id match (as the real matcher does for named sessions).
        sessionMatchesMeshNode: (r: any, _n: any, _id: string, req?: Set<string>) => !req || req.has(r.sessionId),
        isCompletedHostedSession: (r: any) => ['stopped', 'failed', 'interrupted'].includes(r?.lifecycle),
        recordIntentionalMeshSessionStop: async () => {},
    };
    return self;
}

const base = (meshId: string, sessionIds: string[]) => ({
    meshId, nodeId: 'node-a', node: { id: 'node-a' }, mode: 'stop' as const, sessionIds, source: 'mesh_cleanup_sessions' as const,
});

describe('cleanupMeshSessions already_ended vs unknown', () => {
    it('reports already_ended with endedAt/reason for a session recorded as ended and absent from the host', async () => {
        const meshId = randomUUID();
        const sessionId = randomUUID();
        meshRecord(meshId, 'session_stopped', { nodeId: 'node-a', sessionId, payload: { reason: 'pty_exit' } }, { local: true });
        const result: any = await cleanupMeshSessions(harness([]), base(meshId, [sessionId]));
        expect(result.matchedCount).toBe(0);
        expect(result.alreadyEndedSessionIds).toEqual([sessionId]);
        expect(result.sessionStates[0]).toMatchObject({ sessionId, state: 'already_ended', reason: 'pty_exit', source: 'mesh_ledger' });
        expect(typeof result.sessionStates[0].endedAt).toBe('string');
        expect(result.stopProofNote).toMatch(/already_ended is an authoritative stop proof/);
        expect(result.unknownSessionIds).toBeUndefined();
    });

    it('reports unknown for an id the daemon has no record of', async () => {
        const meshId = randomUUID();
        const sessionId = randomUUID();
        const result: any = await cleanupMeshSessions(harness([]), base(meshId, [sessionId]));
        expect(result.matchedCount).toBe(0);
        expect(result.unknownSessionIds).toEqual([sessionId]);
        expect(result.sessionStates[0]).toMatchObject({ sessionId, state: 'unknown' });
        expect(result.alreadyEndedSessionIds).toBeUndefined();
    });

    it('does not mark a live matched session as ended (live behavior unchanged)', async () => {
        const meshId = randomUUID();
        const sessionId = randomUUID();
        const record = { sessionId, lifecycle: 'running', runtimeKey: 'rt', startedAt: 1, workspace: '/w', meta: { meshNodeId: 'node-a', meshNodeFor: meshId } };
        const result: any = await cleanupMeshSessions(harness([record]), base(meshId, [sessionId]));
        expect(result.matchedCount).toBe(1);
        expect(result.alreadyEndedSessionIds).toBeUndefined();
        expect(result.unknownSessionIds).toBeUndefined();
        expect(result.sessionStates).toBeUndefined();
    });
});
