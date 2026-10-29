/** B1 barrier tests: generic operator cleanupMeshSessions must carry expected
 * assignment through host stop/delete CAS — never unconditional stop then delete. */
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
    hostBootIdFromStartedAt, refuseCleanupExpectedStop, refuseCleanupExpectedDelete,
    tagCleanupAfterStopSideEffect,
} from '@adhdev/session-host-core';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { claimNextTask } from '../../src/mesh/mesh-work-queue.js';
import { reuseIdleTaskSession } from '../../src/mesh/mesh-session-reuse.js';
import {
    sessionIsStopping, sessionStopPending, readReservedCleanupExpected,
} from '../../src/mesh/mesh-session-stop-fence.js';
import { agentCommand } from '../../src/commands/cli-manager-agent-command.js';
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
            if (refused) throw new Error(tagCleanupAfterStopSideEffect(refused));
            return { sessionId: f.sessionId, deleted: true };
        };
        const result = await cleanupMeshSessions(f.self, { ...f.args, mode: 'stop_and_delete' });
        expect(result).toMatchObject({ success: false, retained: true });
        expect(result.errors?.[0]?.error).toBe('cleanup_native_incarnation_mismatch');
        expect(result.deletedSessionIds).toEqual([]);
        expect(f.control.deleteSession).not.toHaveBeenCalled();
        // After-stop refusal retains the durable fence (cannot pretend writer alive).
        expect(sessionIsStopping(MeshRuntimeStore.getInstance().db, f.sessionId)).toBe(true);
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

describe('F1 stop_and_delete durable fence across host force-delete await', () => {
    it('holds sessionIsStopping through awaited host exit and refuses claim/reuse/sendinput', async () => {
        const f = fixture();
        const store = MeshRuntimeStore.getInstance();
        let entered!: () => void;
        let finish!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const released = new Promise<void>(resolve => { finish = resolve; });
        // Production-shaped force-delete: stop() then await exit then post-await CAS.
        f.control.deleteSessionIfExpected = async (_id: string, exp: any, opts?: { force?: boolean }) => {
            expect(opts?.force).toBe(true);
            expect(sessionIsStopping(store.db, f.sessionId)).toBe(true);
            expect(readReservedCleanupExpected(store.db, f.sessionId,
                (store.db.prepare('SELECT stop_id FROM mesh_session_stop_fences WHERE session_id = ?')
                    .get(f.sessionId) as { stop_id: string }).stop_id)).toEqual(exp);
            entered();
            await released;
            const refused = refuseCleanupExpectedDelete(
                f.record, exp, f.hostBootId, f.record.lifecycle === 'running', true,
            );
            if (refused) throw new Error(refused);
            f.record.lifecycle = 'stopped';
            f.control.listSessions = async () => [];
            return { sessionId: f.sessionId, deleted: true };
        };
        const deleting = cleanupMeshSessions(f.self, { ...f.args, mode: 'stop_and_delete' });
        await started;
        expect(sessionIsStopping(store.db, f.sessionId)).toBe(true);
        expect(sessionStopPending(store.db, f.sessionId)).toBe(true);

        store.insertQueueEntry({
            id: randomUUID(), meshId: f.meshId, status: 'pending', readonly: true, taskMode: 'live_debug_readonly',
            message: 'must not claim during force-delete await',
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
        expect(claimNextTask(f.meshId, f.nodeId, f.sessionId, [], { nodeIsWorktree: true })).toBeNull();

        const idleState: any = {
            instanceId: f.sessionId, status: 'idle', type: 'codex-cli',
            settings: {
                meshNodeFor: f.meshId, meshNodeId: f.nodeId, launchedByCoordinator: true,
                meshActiveDispatchNonce: null,
            },
        };
        const claim = vi.fn(() => true);
        expect(reuseIdleTaskSession(
            { instanceManager: { getByCategory: () => [{ getState: () => idleState }] } } as any,
            f.meshId,
            {
                id: randomUUID(), meshId: f.meshId, status: 'pending', readonly: true,
                taskMode: 'live_debug_readonly', message: 'reuse', createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            } as any,
            [{ id: f.nodeId }],
            claim,
        )).toBe('none');
        expect(claim).not.toHaveBeenCalled();

        const sendHost: any = {
            findAdapter: () => ({ adapter: {}, key: f.sessionId }),
            deps: { getInstanceManager: () => ({ getByCategory: () => [] }) },
        };
        await expect(agentCommand(sendHost, {
            action: 'send_chat', agentType: 'codex-cli', targetSessionId: f.sessionId,
            meshContext: { meshId: f.meshId },
        })).rejects.toThrow('session_lifetime_stopping');

        finish();
        const result = await deleting;
        expect(result).toMatchObject({ success: true, deletedSessionIds: [f.sessionId] });
        expect(f.control.deleteSession).not.toHaveBeenCalled();
        // Proven delete clears the fence — incarnation is gone.
        expect(sessionIsStopping(store.db, f.sessionId)).toBe(false);
        expect(sessionStopPending(store.db, f.sessionId)).toBe(false);
    });

    it('refuses replacement incarnation at post-await delete CAS while fence held during await', async () => {
        const f = fixture();
        const store = MeshRuntimeStore.getInstance();
        let entered!: () => void;
        let finish!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const released = new Promise<void>(resolve => { finish = resolve; });
        f.control.deleteSessionIfExpected = async (_id: string, exp: any) => {
            entered();
            await released;
            expect(sessionIsStopping(store.db, f.sessionId)).toBe(true);
            const replaced = {
                ...f.record,
                runtimeKey: 'rt-replaced',
                startedAt: f.record.startedAt + 1,
                lifecycle: 'running',
            };
            const refused = refuseCleanupExpectedDelete(replaced, exp, f.hostBootId, true, true);
            if (refused) throw new Error(tagCleanupAfterStopSideEffect(refused));
            return { sessionId: f.sessionId, deleted: true };
        };
        const deleting = cleanupMeshSessions(f.self, { ...f.args, mode: 'stop_and_delete' });
        await started;
        store.insertQueueEntry({
            id: randomUUID(), meshId: f.meshId, status: 'pending', readonly: true, taskMode: 'live_debug_readonly',
            message: 'barrier during await', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
        expect(claimNextTask(f.meshId, f.nodeId, f.sessionId, [], { nodeIsWorktree: true })).toBeNull();
        finish();
        const result = await deleting;
        expect(result).toMatchObject({ success: false, retained: true });
        expect(result.errors?.[0]?.error).toBe('cleanup_native_incarnation_mismatch');
        expect(result.deletedSessionIds).toEqual([]);
        // After-stop refusal: keep conservative stopping state (do not pretend writer alive).
        expect(sessionIsStopping(store.db, f.sessionId)).toBe(true);
    });

    it('keeps fence on uncertain transport/timeout after potential host stop side effect', async () => {
        const f = fixture();
        const store = MeshRuntimeStore.getInstance();
        f.control.deleteSessionIfExpected = async () => {
            expect(sessionIsStopping(store.db, f.sessionId)).toBe(true);
            throw new Error('host waitForRuntimeExit timed out');
        };
        const result = await cleanupMeshSessions(f.self, { ...f.args, mode: 'stop_and_delete' });
        expect(result).toMatchObject({ success: false, retained: true });
        expect(result.errors?.[0]?.error).toBe('cleanup_unconfirmed');
        expect(sessionIsStopping(store.db, f.sessionId)).toBe(true);
        store.insertQueueEntry({
            id: randomUUID(), meshId: f.meshId, status: 'pending', readonly: true, taskMode: 'live_debug_readonly',
            message: 'uncertain outcome', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
        expect(claimNextTask(f.meshId, f.nodeId, f.sessionId, [], { nodeIsWorktree: true })).toBeNull();
    });

    it('aborts fence only on proven before-action refusal and allows a later claim', async () => {
        const f = fixture();
        const store = MeshRuntimeStore.getInstance();
        f.control.deleteSessionIfExpected = async (_id, exp) => {
            expect(sessionIsStopping(store.db, f.sessionId)).toBe(true);
            throw new Error('cleanup_assignment_mismatch');
        };
        const result = await cleanupMeshSessions(f.self, { ...f.args, mode: 'stop_and_delete' });
        expect(result).toMatchObject({ success: false, retained: true });
        expect(result.errors?.[0]?.error).toBe('cleanup_assignment_mismatch');
        expect(sessionIsStopping(store.db, f.sessionId)).toBe(false);
        const taskId = randomUUID();
        store.insertQueueEntry({
            id: taskId, meshId: f.meshId, status: 'pending', readonly: true, taskMode: 'live_debug_readonly',
            message: 'after proven refuse', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
        expect(claimNextTask(f.meshId, f.nodeId, f.sessionId, [], { nodeIsWorktree: true })?.id).toBe(taskId);
    });

    it('late ACK / repeat cleanup remains idempotent with fence + matching positive delete', async () => {
        const f = fixture();
        const first = await cleanupMeshSessions(f.self, { ...f.args, mode: 'stop_and_delete' });
        expect(first).toMatchObject({ success: true, deletedSessionIds: [f.sessionId] });
        expect(f.deletes()).toBe(1);
        // Host already absent — repeat must not fabricate a fresh unconditional delete.
        f.control.deleteSessionIfExpected = async () => ({ sessionId: f.sessionId, deleted: true, alreadyAbsent: true });
        f.control.listSessions = async () => [];
        const second = await cleanupMeshSessions(f.self, { ...f.args, mode: 'stop_and_delete' });
        expect(second).toMatchObject({ success: true });
        expect(second.deletedSessionIds ?? []).toEqual([]);
        expect(f.control.deleteSession).not.toHaveBeenCalled();
    });
});

describe('F2 production-shaped delete unsupported (method present + RPC refuse)', () => {
    it('stop_and_delete: Unsupported delete_session_if_expected falls back to conditional stop; records remain', async () => {
        const f = fixture();
        // Production SessionHostController always has the method; old host RPC refuses.
        f.control.deleteSessionIfExpected = async () => {
            throw new Error('Unsupported session host request: delete_session_if_expected');
        };
        let stopped = 0;
        f.control.stopSessionIfExpected = async (_id, exp) => {
            const refused = refuseCleanupExpectedStop(f.record, exp, f.hostBootId, true);
            if (refused) throw new Error(refused);
            stopped++;
            f.record.lifecycle = 'stopping';
            return { ...f.record, lifecycle: 'stopping' };
        };
        const result = await cleanupMeshSessions(f.self, { ...f.args, mode: 'stop_and_delete' });
        expect(result).toMatchObject({
            success: true,
            deleteUnsupported: true,
            effectiveCleanup: 'stopped_only_records_remain',
            stoppedSessionIds: [f.sessionId],
        });
        expect(result.deletedSessionIds).toEqual([]);
        expect(result.recordsRemainSessionIds).toContain(f.sessionId);
        expect(stopped).toBe(1);
        expect(f.control.stopSession).not.toHaveBeenCalled();
        expect(f.control.deleteSession).not.toHaveBeenCalled();
    });

    it('delete_stopped: same production Unsupported maps to records-remain without stop', async () => {
        const f = fixture({ lifecycle: 'stopped' });
        f.control.deleteSessionIfExpected = async () => {
            throw new Error('Unsupported session host request: delete_session_if_expected');
        };
        f.control.stopSessionIfExpected = async () => {
            throw new Error('stop must not run for delete_stopped unsupported');
        };
        const result = await cleanupMeshSessions(f.self, { ...f.args, mode: 'delete_stopped' });
        expect(result).toMatchObject({
            success: true,
            deleteUnsupported: true,
            effectiveCleanup: 'delete_unsupported_records_remain',
        });
        expect(result.deletedSessionIds).toEqual([]);
        expect(result.stoppedSessionIds).toEqual([]);
        expect(result.recordsRemainSessionIds).toContain(f.sessionId);
        expect(f.control.stopSession).not.toHaveBeenCalled();
        expect(f.control.deleteSession).not.toHaveBeenCalled();
    });

    it('stop_and_delete: unsupported delete + unsupported stop fails closed and retains writer', async () => {
        const f = fixture();
        f.control.deleteSessionIfExpected = async () => {
            throw new Error('Unsupported session host request: delete_session_if_expected');
        };
        f.control.stopSessionIfExpected = async () => {
            throw new Error('Unsupported session host request: stop_session_if_expected');
        };
        const result = await cleanupMeshSessions(f.self, { ...f.args, mode: 'stop_and_delete' });
        expect(result).toMatchObject({ success: false, retained: true });
        expect(result.errors?.[0]?.error).toBe('cleanup_expected_stop_unsupported');
        expect(result.deletedSessionIds).toEqual([]);
        expect(f.control.stopSession).not.toHaveBeenCalled();
        expect(f.control.deleteSession).not.toHaveBeenCalled();
    });

    it('stop_and_delete: unsupported delete keeps fence when fallback stop outcome is uncertain', async () => {
        const f = fixture();
        const store = MeshRuntimeStore.getInstance();
        f.control.deleteSessionIfExpected = async () => {
            throw new Error('Unsupported session host request: delete_session_if_expected');
        };
        f.control.stopSessionIfExpected = async () => {
            expect(sessionIsStopping(store.db, f.sessionId)).toBe(true);
            throw new Error('transport lost after stop dispatched');
        };
        const result = await cleanupMeshSessions(f.self, { ...f.args, mode: 'stop_and_delete' });
        expect(result).toMatchObject({ success: false, retained: true });
        expect(result.errors?.[0]?.error).toBe('cleanup_unconfirmed');
        expect(sessionIsStopping(store.db, f.sessionId)).toBe(true);
        store.insertQueueEntry({
            id: randomUUID(), meshId: f.meshId, status: 'pending', readonly: true, taskMode: 'live_debug_readonly',
            message: 'uncertain fallback stop', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
        expect(claimNextTask(f.meshId, f.nodeId, f.sessionId, [], { nodeIsWorktree: true })).toBeNull();
    });
});
