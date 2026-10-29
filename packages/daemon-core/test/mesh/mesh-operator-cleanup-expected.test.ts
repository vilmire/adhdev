/** B1 barrier tests: generic operator cleanupMeshSessions must carry expected
 * assignment through host stop/delete CAS — never unconditional stop then delete. */
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hostBootIdFromStartedAt, refuseCleanupExpectedStop, refuseCleanupExpectedDelete } from '@adhdev/session-host-core';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { sessionIsStopping, sessionStopPending } from '../../src/mesh/mesh-session-stop-fence.js';
import { cleanupMeshSessions } from '../../src/commands/router-worktree-cleanup.js';

function fixture(over: { bound?: boolean; lifecycle?: string } = {}) {
    const meshId = randomUUID();
    const sessionId = randomUUID();
    const nodeId = 'node-a';
    const taskId = randomUUID();
    const at = Date.now();
    const hostBootId = hostBootIdFromStartedAt(at);
    const assignment = over.bound
        ? { meshId, nodeId, taskId, attemptId: 'att-1', generation: 0, dispatchNonce: 2, ownerDaemonId: 'daemon_owner' }
        : undefined;
    const record: any = {
        sessionId,
        workspace: '/repo/worktree-a',
        lifecycle: over.lifecycle ?? 'running',
        runtimeKey: `rt-${sessionId}`,
        startedAt: at,
        meta: {
            meshNodeId: nodeId,
            meshNodeFor: meshId,
            launchedByCoordinator: true,
            ...(assignment ? { meshActiveAssignment: assignment } : {}),
        },
    };
    const expected = {
        sessionId, hostBootId, runtimeKey: record.runtimeKey, startedAt: at,
        taskId: over.bound ? taskId : null,
        attemptId: over.bound ? 'att-1' : null,
        generation: over.bound ? 0 : null,
        dispatchNonce: over.bound ? 2 : null,
    };
    let stops = 0;
    let deletes = 0;
    const control: any = {
        listSessions: async () => [record],
        resolveHostBootId: async () => hostBootId,
        getDiagnostics: async () => ({ hostBootId, hostStartedAt: at }),
        stopSession: vi.fn(async () => { throw new Error('unconditional stopSession must not be used'); }),
        deleteSession: vi.fn(async () => { throw new Error('unconditional deleteSession must not be used'); }),
        stopSessionIfExpected: async (_id: string, exp: any) => {
            const refused = refuseCleanupExpectedStop(record, exp, hostBootId, record.lifecycle === 'running');
            if (refused) throw new Error(refused);
            stops++;
            record.lifecycle = 'stopping';
            return { ...record, lifecycle: 'stopping' };
        },
        deleteSessionIfExpected: async (_id: string, exp: any, opts?: { force?: boolean }) => {
            const refused = refuseCleanupExpectedDelete(
                record, exp, hostBootId, record.lifecycle === 'running', opts?.force === true,
            );
            if (refused) throw new Error(refused);
            if (record.lifecycle === 'running') {
                stops++;
                record.lifecycle = 'stopping';
            }
            deletes++;
            // Simulate host removing the matching incarnation only.
            control.listSessions = async () => [];
            return { sessionId, deleted: true };
        },
    };
    const self: any = {
        deps: { sessionHostControl: control },
        sessionMatchesMeshNode: () => true,
        isCompletedHostedSession: (r: any) => ['stopped', 'failed', 'interrupted'].includes(r?.lifecycle),
        recordIntentionalMeshSessionStop: async () => {},
    };
    const args = {
        meshId, nodeId, node: { id: nodeId, workspace: '/repo/worktree-a' },
        mode: 'stop' as const, sessionIds: [sessionId], source: 'mesh_cleanup_sessions' as const,
    };
    return { meshId, sessionId, nodeId, taskId, record, expected, hostBootId, self, control, args, stops: () => stops, deletes: () => deletes };
}

describe('B1 operator cleanupMeshSessions expected-assignment CAS', () => {
    it('positive matching stop succeeds via stop_session_if_expected', async () => {
        const f = fixture();
        const result = await cleanupMeshSessions(f.self, f.args);
        expect(result).toMatchObject({ success: true, stoppedSessionIds: [f.sessionId] });
        expect(f.stops()).toBe(1);
        expect(f.control.stopSession).not.toHaveBeenCalled();
    });

    it('positive matching stop_and_delete deletes via delete_session_if_expected', async () => {
        const f = fixture();
        const result = await cleanupMeshSessions(f.self, { ...f.args, mode: 'stop_and_delete' });
        expect(result).toMatchObject({ success: true, deletedSessionIds: [f.sessionId] });
        expect(f.deletes()).toBe(1);
        expect(f.control.deleteSession).not.toHaveBeenCalled();
    });

    it('refuses reassignment before host stop (unbound→bound) and retains writer', async () => {
        const f = fixture();
        f.record.meta.meshActiveAssignment = {
            meshId: f.meshId, nodeId: f.nodeId, taskId: f.taskId, attemptId: 'new', generation: 0, dispatchNonce: 1, ownerDaemonId: 'daemon_owner',
        };
        // Expected captured at selection still unbound — host refuses.
        f.control.listSessions = async () => [f.record];
        // Capture happens from the listSessions record which is already bound — so
        // selection sees bound. Force unbound expected by clearing then rebinding in stop.
        f.record.meta.meshActiveAssignment = undefined;
        f.control.stopSessionIfExpected = async (_id: string, exp: any) => {
            f.record.meta.meshActiveAssignment = {
                meshId: f.meshId, nodeId: f.nodeId, taskId: 'claimed', attemptId: 'a', generation: 0, dispatchNonce: 1, ownerDaemonId: 'daemon_owner',
            };
            const refused = refuseCleanupExpectedStop(f.record, exp, f.hostBootId, true);
            if (refused) throw new Error(refused);
            return { ...f.record, lifecycle: 'stopping' };
        };
        const result = await cleanupMeshSessions(f.self, f.args);
        expect(result).toMatchObject({ success: false, retained: true });
        expect(result.errors?.[0]?.error).toBe('cleanup_expected_unbound_now_bound');
        expect(f.stops()).toBe(0);
        expect(sessionIsStopping(MeshRuntimeStore.getInstance().db, f.sessionId)).toBe(false);
        expect(f.control.stopSession).not.toHaveBeenCalled();
    });

    it('refuses reassignment during host stop await and does not report success', async () => {
        const f = fixture();
        let entered!: () => void;
        let finish!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const released = new Promise<void>(resolve => { finish = resolve; });
        f.control.stopSessionIfExpected = async (_id: string, exp: any) => {
            entered();
            await released;
            f.record.meta.meshActiveAssignment = {
                meshId: f.meshId, nodeId: f.nodeId, taskId: 'replacement', attemptId: 'a2', generation: 1, dispatchNonce: 3, ownerDaemonId: 'daemon_owner',
            };
            const refused = refuseCleanupExpectedStop(f.record, exp, f.hostBootId, true);
            if (refused) throw new Error(refused);
            return { ...f.record, lifecycle: 'stopping' };
        };
        const stopping = cleanupMeshSessions(f.self, f.args);
        await started;
        expect(sessionStopPending(MeshRuntimeStore.getInstance().db, f.sessionId)).toBe(true);
        finish();
        const result = await stopping;
        expect(result).toMatchObject({ success: false, retained: true });
        expect(result.errors?.[0]?.error).toBe('cleanup_expected_unbound_now_bound');
        expect(sessionStopPending(MeshRuntimeStore.getInstance().db, f.sessionId)).toBe(false);
    });

    it('refuses delete after stop when incarnation was replaced before delete CAS', async () => {
        const f = fixture();
        f.control.deleteSessionIfExpected = async (_id: string, exp: any) => {
            // Simulate replace after stop await: new incarnation under same sessionId.
            const replaced = { ...f.record, runtimeKey: 'rt-replaced', startedAt: f.record.startedAt + 1, lifecycle: 'running' };
            const refused = refuseCleanupExpectedDelete(replaced, exp, f.hostBootId, true, true);
            if (refused) throw new Error(refused);
            return { sessionId: f.sessionId, deleted: true };
        };
        const result = await cleanupMeshSessions(f.self, { ...f.args, mode: 'stop_and_delete' });
        expect(result).toMatchObject({ success: false, retained: true });
        expect(result.errors?.[0]?.error).toBe('cleanup_native_incarnation_mismatch');
        expect(result.deletedSessionIds).toEqual([]);
        expect(f.control.deleteSession).not.toHaveBeenCalled();
    });

    it('refuses restart/incarnation mismatch without fabricating a stop receipt', async () => {
        const f = fixture();
        f.control.stopSessionIfExpected = async (_id, exp) => {
            const refused = refuseCleanupExpectedStop(
                { ...f.record, runtimeKey: 'rt-other' }, exp, f.hostBootId, true,
            );
            if (refused) throw new Error(refused!);
            return { ...f.record, lifecycle: 'stopping' };
        };
        // Capture uses listSessions record; force mismatch by changing record after list.
        let listed = false;
        f.control.listSessions = async () => {
            if (!listed) { listed = true; return [f.record]; }
            return [{ ...f.record, runtimeKey: 'rt-other' }];
        };
        // Host compares expected (from first list) against live record in stop handler —
        // simulate live drift inside stopSessionIfExpected:
        f.control.stopSessionIfExpected = async (_id, exp) => {
            expect(exp.runtimeKey).toBe(f.record.runtimeKey);
            throw new Error('cleanup_native_incarnation_mismatch');
        };
        const result = await cleanupMeshSessions(f.self, f.args);
        expect(result).toMatchObject({ success: false, retained: true });
        expect(result.errors?.[0]?.error).toBe('cleanup_native_incarnation_mismatch');
        expect(result.stoppedSessionIds).toEqual([]);
    });

    it('refuses host boot mismatch / restart fence', async () => {
        const f = fixture();
        f.control.stopSessionIfExpected = async () => { throw new Error('cleanup_host_boot_mismatch'); };
        const result = await cleanupMeshSessions(f.self, f.args);
        expect(result).toMatchObject({ success: false, retained: true });
        expect(result.errors?.[0]?.error).toBe('cleanup_host_boot_mismatch');
        expect(f.stops()).toBe(0);
    });

    it('old host without stop_session_if_expected fails closed and retains writer', async () => {
        const f = fixture();
        delete f.control.stopSessionIfExpected;
        const result = await cleanupMeshSessions(f.self, f.args);
        expect(result).toMatchObject({ success: false, retained: true });
        expect(result.errors?.[0]?.error).toBe('cleanup_expected_stop_unsupported');
        expect(f.control.stopSession).not.toHaveBeenCalled();
    });

    it('missing expected tuple (no incarnation) fails closed', async () => {
        const f = fixture();
        f.control.listSessions = async () => [{ ...f.record, runtimeKey: undefined, startedAt: undefined }];
        const result = await cleanupMeshSessions(f.self, f.args);
        expect(result).toMatchObject({ success: false, retained: true });
        expect(result.errors?.[0]?.error).toBe('cleanup_expected_malformed');
        expect(f.control.stopSession).not.toHaveBeenCalled();
    });

    it('repeated cleanup is idempotent once already stopped', async () => {
        const f = fixture();
        const first = await cleanupMeshSessions(f.self, f.args);
        expect(first).toMatchObject({ success: true, stoppedSessionIds: [f.sessionId] });
        f.record.lifecycle = 'stopped';
        const second = await cleanupMeshSessions(f.self, f.args);
        expect(second).toMatchObject({ success: true, stoppedSessionIds: [], skippedSessionIds: [f.sessionId] });
        expect(f.stops()).toBe(1);
    });

    it('does not stop an unrelated session outside the matched set', async () => {
        const f = fixture();
        const otherId = randomUUID();
        f.control.listSessions = async () => [
            f.record,
            { ...f.record, sessionId: otherId, runtimeKey: `rt-${otherId}`, meta: { meshNodeId: 'other' } },
        ];
        f.self.sessionMatchesMeshNode = (record: any) => record.sessionId === f.sessionId;
        const result = await cleanupMeshSessions(f.self, f.args);
        expect(result.stoppedSessionIds).toEqual([f.sessionId]);
        expect(f.stops()).toBe(1);
    });

    it('bound expected refuses assignment mismatch without releasing the replacement claim', async () => {
        const f = fixture({ bound: true });
        f.control.stopSessionIfExpected = async (_id, exp) => {
            f.record.meta.meshActiveAssignment = {
                ...f.record.meta.meshActiveAssignment,
                taskId: 'replacement-task', attemptId: 'r1', generation: 1, dispatchNonce: 9,
            };
            const refused = refuseCleanupExpectedStop(f.record, exp, f.hostBootId, true);
            if (refused) throw new Error(refused);
            return { ...f.record, lifecycle: 'stopping' };
        };
        const result = await cleanupMeshSessions(f.self, f.args);
        expect(result).toMatchObject({ success: false, retained: true });
        expect(result.errors?.[0]?.error).toBe('cleanup_assignment_mismatch');
        expect(f.record.meta.meshActiveAssignment.taskId).toBe('replacement-task');
        expect(f.stops()).toBe(0);
    });
});
