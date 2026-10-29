/** B1 barrier tests: cleanup expected-assignment must be verified at the host
 * stop critical section, serialized with claim/reuse/input admission. */
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { claimNextTask } from '../../src/mesh/mesh-work-queue.js';
import {
    reserveSessionStop, markSessionStopSent, sessionIsStopping, sessionStopPending,
    abortSessionStopAfterHostRefusal, readReservedCleanupExpected,
} from '../../src/mesh/mesh-session-stop-fence.js';
import { idleSessionLifetimeCommand } from '../../src/commands/mesh-idle-session-lifetime.js';
import { refuseCleanupExpectedStop, hostBootIdFromStartedAt } from '@adhdev/session-host-core';

function fixture(over: { bound?: boolean } = {}) {
    const meshId = randomUUID(), sessionId = randomUUID(), nodeId = randomUUID(), taskId = randomUUID();
    const store = MeshRuntimeStore.getInstance(), at = Date.now();
    const hostBootId = hostBootIdFromStartedAt(at);
    const settings: any = {
        meshNodeFor: meshId, meshNodeId: nodeId, launchedByCoordinator: true,
        ...(over.bound ? {
            meshActiveTaskId: taskId, meshActiveAttemptId: 'att-1', meshActiveAttemptGeneration: 0, meshActiveDispatchNonce: 2,
            meshCoordinatorDaemonId: 'daemon_owner',
        } : { meshActiveDispatchNonce: null }),
    };
    const claimFence = over.bound
        ? { taskId, attemptId: 'att-1', generation: 0, dispatchNonce: 2 }
        : { taskId: null, attemptId: null, generation: null, dispatchNonce: null };
    const record: any = {
        sessionId, lifecycle: 'running', lastActivityAt: at, runtimeKey: `rt-${sessionId}`, startedAt: at,
        meta: {
            ...settings,
            ...(over.bound ? { meshActiveAssignment: {
                meshId, nodeId, taskId, attemptId: 'att-1', generation: 0, dispatchNonce: 2, ownerDaemonId: 'daemon_owner',
            } } : {}),
        },
    };
    const expected = { sessionId, hostBootId, runtimeKey: record.runtimeKey, startedAt: at, ...claimFence };
    const state: any = { instanceId: sessionId, status: 'idle', type: 'codex-cli', settings };
    let stops = 0;
    const control = {
        listSessions: async () => [record],
        getDiagnostics: async () => ({ hostStartedAt: at }),
        stopSessionIfExpected: async (_id: string, exp: any) => {
            const refused = refuseCleanupExpectedStop(record, exp, hostBootId, true);
            if (refused) throw new Error(refused);
            stops++;
            return { ...record, lifecycle: 'stopping' };
        },
    };
    const host: any = { deps: { idleSessionLifetimeControl: control, getInstanceManager: () => ({ getByCategory: () => [{ getState: () => state }] }) } };
    const args: any = {
        action: 'mesh_idle_session_stop', targetSessionId: sessionId, meshContext: { meshId },
        idleSessionLifetime: { lastActivityAt: at, stopId: randomUUID(), claimFence, expected },
    };
    return { meshId, sessionId, nodeId, taskId, store, state, record, expected, args, host, control, hostBootId, stops: () => stops };
}

describe('B1 cleanup expected-assignment host CAS', () => {
    it('refuses a new claim attached before the host stop critical section (unbound→bound)', async () => {
        const f = fixture();
        f.control.listSessions = async () => {
            f.record.meta.meshActiveAssignment = {
                meshId: f.meshId, nodeId: f.nodeId, taskId: f.taskId, attemptId: 'new', generation: 0, dispatchNonce: 1, ownerDaemonId: 'daemon_owner',
            };
            f.state.settings.meshActiveTaskId = f.taskId;
            f.state.settings.meshActiveAttemptId = 'new';
            f.state.settings.meshActiveAttemptGeneration = 0;
            f.state.settings.meshActiveDispatchNonce = 1;
            return [f.record];
        };
        const result = await idleSessionLifetimeCommand(f.host, f.args);
        expect(result).toMatchObject({ success: false, retained: true });
        expect(f.stops()).toBe(0);
        expect(sessionIsStopping(f.store.db, f.sessionId)).toBe(false);
    });

    it('refuses when a new claim lands during the host stop handoff await', async () => {
        const f = fixture();
        let entered!: () => void, finish!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const released = new Promise<void>(resolve => { finish = resolve; });
        f.control.stopSessionIfExpected = async () => {
            entered();
            await released;
            f.record.meta.meshActiveAssignment = {
                meshId: f.meshId, nodeId: f.nodeId, taskId: 'replacement', attemptId: 'a2', generation: 1, dispatchNonce: 3, ownerDaemonId: 'daemon_owner',
            };
            const refused = refuseCleanupExpectedStop(f.record, f.expected, f.hostBootId, true);
            if (refused) throw new Error(refused);
            return { ...f.record, lifecycle: 'stopping' };
        };
        const stopping = idleSessionLifetimeCommand(f.host, f.args);
        await started;
        // While host stop is in flight, claims remain excluded by the durable fence.
        f.store.insertQueueEntry({
            id: f.taskId, meshId: f.meshId, status: 'pending', readonly: true, taskMode: 'live_debug_readonly',
            message: 'must not claim during stop', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
        expect(claimNextTask(f.meshId, f.nodeId, f.sessionId, [], { nodeIsWorktree: true })).toBeNull();
        finish();
        const result = await stopping;
        expect(result).toMatchObject({ success: false, error: 'cleanup_expected_unbound_now_bound', retained: true });
        expect(sessionStopPending(f.store.db, f.sessionId)).toBe(false);
    });

    it('refuses restart/incarnation mismatch without fabricating a stop receipt', async () => {
        const f = fixture();
        const stale = { ...f.expected, runtimeKey: 'rt-replaced', startedAt: f.expected.startedAt + 1 };
        f.args.idleSessionLifetime.expected = stale;
        const result = await idleSessionLifetimeCommand(f.host, f.args);
        expect(result).toMatchObject({ success: false, retained: true });
        expect(f.stops()).toBe(0);
        expect(result.error === 'lifetime_safety_changed' || result.error === 'cleanup_native_incarnation_mismatch').toBe(true);
    });

    it('refuses host boot mismatch (restart fence)', async () => {
        const f = fixture();
        f.args.idleSessionLifetime.expected = { ...f.expected, hostBootId: 'hs:1' };
        const result = await idleSessionLifetimeCommand(f.host, f.args);
        expect(result).toMatchObject({ success: false, error: 'cleanup_host_boot_mismatch', retained: true });
        expect(f.stops()).toBe(0);
    });

    it('late ACK after replacement keeps the reserved expected assignment and does not retarget', async () => {
        const f = fixture();
        const stopId = f.args.idleSessionLifetime.stopId;
        reserveSessionStop(f.store.db, f.meshId, f.sessionId, stopId, f.expected);
        markSessionStopSent(f.store.db, f.sessionId, stopId);
        expect(readReservedCleanupExpected(f.store.db, f.sessionId, stopId)).toEqual(f.expected);
        // Replacement claim identity differs; abort only on proven refuse-before-stop.
        abortSessionStopAfterHostRefusal(f.store.db, f.sessionId, stopId);
        expect(sessionIsStopping(f.store.db, f.sessionId)).toBe(false);
        expect(readReservedCleanupExpected(f.store.db, f.sessionId, stopId)).toBeNull();
    });

    it('repeated cleanup is idempotent once confirmed stopped', async () => {
        const f = fixture();
        const first = await idleSessionLifetimeCommand(f.host, f.args);
        expect(first).toMatchObject({ success: true, stoppedSessionIds: [f.sessionId] });
        expect(f.stops()).toBe(1);
        f.record.lifecycle = 'stopped';
        const second = await idleSessionLifetimeCommand(f.host, {
            ...f.args,
            idleSessionLifetime: { ...f.args.idleSessionLifetime, stopId: randomUUID() },
        });
        expect(second.success).toBe(false);
        expect(f.stops()).toBe(1);
    });

    it('does not stop an unrelated writer session', async () => {
        const f = fixture({ bound: true });
        const other = {
            ...f.expected,
            sessionId: randomUUID(),
            taskId: 'other-task',
            attemptId: 'other-att',
        };
        f.args.idleSessionLifetime.expected = other;
        f.args.targetSessionId = other.sessionId;
        const result = await idleSessionLifetimeCommand(f.host, f.args);
        expect(result.success).toBe(false);
        expect(f.stops()).toBe(0);
    });

    it('unbound expected-none refuses after a later bind and retains the writer', async () => {
        const f = fixture();
        const refused = refuseCleanupExpectedStop(
            { ...f.record, meta: { ...f.record.meta, meshActiveAssignment: {
                meshId: f.meshId, nodeId: f.nodeId, taskId: 'new-task', attemptId: 'a', generation: 0, dispatchNonce: 1, ownerDaemonId: 'daemon_owner',
            } } },
            f.expected,
            f.hostBootId,
            true,
        );
        expect(refused).toBe('cleanup_expected_unbound_now_bound');
        f.control.stopSessionIfExpected = async () => { throw new Error(refused!); };
        const result = await idleSessionLifetimeCommand(f.host, f.args);
        expect(result).toMatchObject({ success: false, error: 'cleanup_expected_unbound_now_bound', retained: true });
        expect(f.stops()).toBe(0);
    });

    it('persists expected assignment with the durable stop reservation before async host stop', async () => {
        const f = fixture();
        let observed: unknown;
        f.control.stopSessionIfExpected = async (_id, exp) => {
            observed = readReservedCleanupExpected(f.store.db, f.sessionId, f.args.idleSessionLifetime.stopId);
            expect(observed).toEqual(exp);
            return { ...f.record, lifecycle: 'stopping' };
        };
        const result = await idleSessionLifetimeCommand(f.host, f.args);
        expect(result.success).toBe(true);
        expect(observed).toEqual(f.expected);
    });
});
