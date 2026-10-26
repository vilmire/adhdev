import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { claimNextTask } from '../../src/mesh/mesh-work-queue.js';
import { reserveSessionStop, sessionIsStopping } from '../../src/mesh/mesh-session-stop-fence.js';
import { runIdleSessionReapPass } from '../../src/mesh/mesh-idle-session-reaper.js';
import { reuseIdleTaskSession } from '../../src/mesh/mesh-session-reuse.js';
import { sessionLifetimeDeps } from '../../src/mesh/mesh-session-lifetime-runtime.js';
import { agentCommand } from '../../src/commands/cli-manager-agent-command.js';
import { idleSessionLifetimeCommand } from '../../src/commands/mesh-idle-session-lifetime.js';

function fixture() {
    const meshId = randomUUID(), sessionId = randomUUID(), nodeId = randomUUID(), taskId = randomUUID();
    const store = MeshRuntimeStore.getInstance(), at = Date.now();
    const state: any = { instanceId: sessionId, status: 'idle', type: 'codex-cli', settings: {
        meshNodeFor: meshId, meshNodeId: nodeId, launchedByCoordinator: true, meshActiveDispatchNonce: 1,
    } };
    const record: any = { sessionId, lifecycle: 'running', lastActivityAt: at, meta: state.settings };
    const task: any = { id: taskId, meshId, status: 'pending', readonly: true, taskMode: 'live_debug_readonly', message: 'review without a session pin', createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString() };
    const args: any = { action: 'mesh_idle_session_stop', targetSessionId: sessionId, meshContext: { meshId },
        idleSessionLifetime: { lastActivityAt: at, stopId: randomUUID(), claimFence: { taskId: null, attemptId: null, generation: null, dispatchNonce: 1 } } };
    let stops = 0;
    const control = { listSessions: async () => [record], stopSession: async () => { stops++; return { ...record, lifecycle: 'stopped' }; } };
    const host: any = { deps: { idleSessionLifetimeControl: control, getInstanceManager: () => ({ getByCategory: () => [{ getState: () => state }] }) } };
    return { meshId, sessionId, nodeId, taskId, store, state, record, task, args, host, control, stops: () => stops };
}

describe('review finding 1: stop/claim exclusion', () => {
    it('refuses a local assignment made during the host inventory await', async () => {
        const f = fixture();
        f.control.listSessions = async () => {
            f.store.insertQueueEntry({ ...f.task, status: 'assigned', assignedSessionId: f.sessionId, assignedNodeId: f.nodeId });
            return [f.record];
        };
        expect((await idleSessionLifetimeCommand(f.host, f.args)).success).toBe(false);
        expect(f.stops()).toBe(0);
    });
    it('rejects a remote generation/dispatch fence changed during the RPC await', async () => {
        const f = fixture();
        f.control.listSessions = async () => { f.state.settings.meshActiveDispatchNonce = 2; return [f.record]; };
        expect((await idleSessionLifetimeCommand(f.host, f.args)).success).toBe(false);
        expect(f.stops()).toBe(0);
    });
    it('refuses an unpinned review claim after stop is marked, until stop acknowledgement', async () => {
        const f = fixture(); f.store.insertQueueEntry(f.task);
        let entered!: () => void, finish!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const released = new Promise<void>(resolve => { finish = resolve; });
        f.control.stopSession = async () => { entered(); await released; return { ...f.record, lifecycle: 'stopped' }; };
        const stopping = idleSessionLifetimeCommand(f.host, f.args);
        await started;
        try {
            expect(claimNextTask(f.meshId, f.nodeId, f.sessionId, [], { nodeIsWorktree: true })).toBeNull();
            expect(f.store.findQueueEntryById(f.meshId, f.taskId)?.status).toBe('pending');
            const claim = vi.fn(() => true);
            expect(reuseIdleTaskSession({ instanceManager: { getByCategory: () => [{ getState: () => f.state }] } } as any,
                f.meshId, f.task, claim)).toBe('none');
            expect(claim).not.toHaveBeenCalled();
        } finally { finish(); await stopping; }
    });
});


describe('owner reservation and host delivery fence', () => {
    it('blocks a review claim during recordIntentional and carries the inventory generation in the RPC', async () => {
        const f = fixture(); f.store.insertQueueEntry(f.task);
        f.store.setRemoteIdleSession(f.meshId, f.nodeId, f.sessionId, 'codex-cli', Date.now() + 60_000);
        let claimed: any = 'not attempted', stopArgs: any;
        const components: any = {
            router: { deps: { sessionHostControl: { listSessions: async () => [] } }, recordIntentionalMeshSessionStop: async () => {
                claimed = claimNextTask(f.meshId, f.nodeId, f.sessionId, [], { nodeIsWorktree: true });
            } },
            dispatchMeshCommand: async (_peer: string, _command: string, args: any) => {
                if (args.action === 'mesh_idle_session_inventory') return { success: true, sessions: [{ ...f.record, state: f.state, claimFence: f.args.idleSessionLifetime.claimFence }] };
                stopArgs = args;
                return { success: true, stoppedSessionIds: [f.sessionId] };
            },
        };
        const deps = sessionLifetimeDeps(components, { id: f.meshId, nodes: [{ id: f.nodeId, daemonId: 'daemon_mach_fence_peer', machineId: 'mach_fence_peer' }] }, Date.now());
        await deps.listSessions();
        const result = await deps.cleanupMeshSessions({ meshId: f.meshId, sessionIds: [f.sessionId], nodeId: '', node: undefined, mode: 'stop', source: 'mesh_cleanup_sessions' });
        expect(result.success).toBe(true); expect(claimed).toBeNull();
        expect(stopArgs.idleSessionLifetime.claimFence).toEqual(f.args.idleSessionLifetime.claimFence);
        expect(typeof stopArgs.idleSessionLifetime.stopId).toBe('string');
    });
    it('refuses a send_chat to the host while stopSession acknowledgement is pending', async () => {
        const f = fixture();
        let entered!: () => void, finish!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const released = new Promise<void>(resolve => { finish = resolve; });
        f.control.stopSession = async () => { entered(); await released; return { ...f.record, lifecycle: 'stopped' }; };
        const stopping = idleSessionLifetimeCommand(f.host, f.args);
        await started;
        f.host.findAdapter = () => ({ adapter: {}, key: f.sessionId });
        try {
            await expect(agentCommand(f.host, { action: 'send_chat', agentType: 'codex-cli', targetSessionId: f.sessionId, meshContext: { meshId: f.meshId } })).rejects.toThrow('session_lifetime_stopping');
        } finally { finish(); await stopping; }
    });
});


describe('pending stop intent recovery', () => {
    it('keeps a failed stop eligible when idle count falls below the cap', async () => {
        const f = fixture(); reserveSessionStop(f.store.db, f.meshId, f.sessionId, f.args.idleSessionLifetime.stopId);
        const instance = { getState: () => f.state };
        const components: any = { instanceManager: { getInstance: () => instance, getByCategory: () => [instance] },
            router: { deps: { sessionHostControl: f.control } } };
        const plan = await runIdleSessionReapPass(sessionLifetimeDeps(components, { id: f.meshId, nodes: [] }, Date.now()),
            { meshId: f.meshId, dryRun: true, policy: { delegatedSessionIdleTtlMinutes: 0, maxIdleDelegatedSessionsPerMachine: 1, stopDelegatedSessionOnAcceptedCompletion: false } });
        expect(plan.plan.reap.map(r => r.sessionId)).toEqual([f.sessionId]);
    });
    it('finishes outstanding stop intent even if new stop policies were disabled', async () => {
        const f = fixture(); reserveSessionStop(f.store.db, f.meshId, f.sessionId, f.args.idleSessionLifetime.stopId);
        const instance = { getState: () => f.state };
        const components: any = { instanceManager: { getInstance: () => instance, getByCategory: () => [instance] },
            router: { deps: { sessionHostControl: f.control } } };
        const plan = await runIdleSessionReapPass(sessionLifetimeDeps(components, { id: f.meshId, nodes: [] }, Date.now()),
            { meshId: f.meshId, dryRun: true, policy: { delegatedSessionIdleTtlMinutes: 0, maxIdleDelegatedSessionsPerMachine: 0, stopDelegatedSessionOnAcceptedCompletion: false } });
        expect(plan.plan.reap.map(r => r.sessionId)).toEqual([f.sessionId]);
    });
});

describe('pre-send stop reservation cleanup', () => {
    function owner(remote = false, withFence = true) {
        const f = fixture();
        const instance = { getState: () => f.state };
        const stop = vi.fn(async () => ({ success: true, stoppedSessionIds: [f.sessionId] }));
        const components: any = {
            instanceManager: { getInstance: () => instance, getByCategory: () => [instance] },
            router: { deps: { sessionHostControl: { listSessions: async () => remote ? [] : [f.record] } }, recordIntentionalMeshSessionStop: vi.fn(async () => {}) },
            cliManager: { agentCommand: stop },
            dispatchMeshCommand: vi.fn(async (_peer, _command, args) => args.action === 'mesh_idle_session_inventory'
                ? { success: true, sessions: [{ ...f.record, state: f.state, ...(withFence ? { claimFence: f.args.idleSessionLifetime.claimFence } : {}) }] }
                : stop()),
        };
        if (remote) f.store.setRemoteIdleSession(f.meshId, f.nodeId, f.sessionId, 'codex-cli', Date.now() + 60_000);
        const deps = sessionLifetimeDeps(components, { id: f.meshId, nodes: remote ? [{ id: f.nodeId, daemonId: 'daemon_mach_fence_peer', machineId: 'mach_fence_peer' }] : [] }, Date.now());
        const cleanup = () => deps.cleanupMeshSessions({ meshId: f.meshId, sessionIds: [f.sessionId], nodeId: '', node: undefined, mode: 'stop', source: 'mesh_cleanup_sessions' });
        const claimable = () => {
            expect(sessionIsStopping(f.store.db, f.sessionId)).toBe(false);
            f.store.insertQueueEntry(f.task);
            expect(claimNextTask(f.meshId, f.nodeId, f.sessionId, [], { nodeIsWorktree: true })?.id).toBe(f.taskId);
        };
        return { ...f, components, deps, cleanup, claimable, stop };
    }
    it('keeps unsupported peer inventory claimable without sending a stop', async () => {
        const f = owner(true, false); await f.deps.listSessions();
        expect((await f.cleanup()).success).toBe(false);
        expect(f.stop).not.toHaveBeenCalled(); f.claimable();
    });
    it('keeps a local session claimable when cliManager is missing', async () => {
        const f = owner(); await f.deps.listSessions(); delete f.components.cliManager;
        expect((await f.cleanup()).success).toBe(false);
        expect(f.stop).not.toHaveBeenCalled(); f.claimable();
    });
    it('releases when P2P disappears during the pre-send audit await', async () => {
        const f = owner(true); await f.deps.listSessions();
        f.components.router.recordIntentionalMeshSessionStop = async () => { delete f.components.dispatchMeshCommand; };
        expect((await f.cleanup()).success).toBe(false); f.claimable();
    });
    it('releases when the pre-send audit throws', async () => {
        const f = owner(); await f.deps.listSessions();
        f.components.router.recordIntentionalMeshSessionStop = async () => { throw new Error('audit_unavailable'); };
        await expect(f.cleanup()).rejects.toThrow('audit_unavailable'); f.claimable();
    });
    it('releases when local idle safety changes during the pre-send await', async () => {
        const f = owner(); await f.deps.listSessions();
        f.components.router.recordIntentionalMeshSessionStop = async () => { f.state.status = 'generating'; };
        expect((await f.cleanup()).success).toBe(false);
        f.state.status = 'idle'; f.claimable();
    });
    it('retains a sent-but-unacknowledged stop even if the next attempt cannot send', async () => {
        const f = owner(true); await f.deps.listSessions();
        f.components.dispatchMeshCommand = async () => { throw new Error('ack_lost'); };
        await expect(f.cleanup()).rejects.toThrow('ack_lost');
        expect(sessionIsStopping(f.store.db, f.sessionId)).toBe(true);
        delete f.components.dispatchMeshCommand;
        expect((await f.cleanup()).success).toBe(false);
        expect(sessionIsStopping(f.store.db, f.sessionId)).toBe(true);
        f.store.insertQueueEntry(f.task);
        expect(claimNextTask(f.meshId, f.nodeId, f.sessionId, [], { nodeIsWorktree: true })).toBeNull();
    });
});
