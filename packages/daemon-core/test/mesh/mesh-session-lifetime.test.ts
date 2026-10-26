import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { acceptedCompletionSessionIds, sessionCheckpointPending, resetSessionStopRetries } from '../../src/mesh/mesh-session-lifetime.js';
import { reuseIdleTaskSession } from '../../src/mesh/mesh-session-reuse.js';
import { agentCommand } from '../../src/commands/cli-manager-agent-command.js';
import { idleSessionLifetimeCommand } from '../../src/commands/mesh-idle-session-lifetime.js';
import { planIdleSessionReap, runIdleSessionReapPass } from '../../src/mesh/mesh-idle-session-reaper.js';
import { sessionLifetimeDeps } from '../../src/mesh/mesh-session-lifetime-runtime.js';
import { maybeAutoLaunchOneQueueSession } from '../../src/mesh/mesh-queue-autolaunch.js';
import { resolveMeshPolicy } from '../../src/repo-mesh-types.js';

const claim = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../src/mesh/mesh-queue-assignment.js', () => ({
    tryAssignQueueTask: claim, delegatedWorkerAutoApproveSettingsForNode: vi.fn(),
    localCoordinatorDaemonId: () => 'local', readMeshNodeId: (n: any) => n.id,
    remoteSessionReadyProbe: vi.fn(), waitForLocalSessionReady: vi.fn(),
}));
vi.mock('../../src/config/config.js', async importOriginal => ({
    ...await importOriginal<typeof import('../../src/config/config.js')>(),
    getMachineId: () => 'mach_local', loadConfig: () => ({ machineId: 'mach_local' }),
}));

const meshId = 'lifetime';
const now = 1_800_000_000_000;
let tasks: any[], remotes: any[], outputs: Map<string, any>, attempts: Map<string, any>;
let journalPending = false;
const state = (extra: any = {}) => ({ instanceId: 'worker', type: 'codex-cli', status: 'idle',
    settings: { meshNodeFor: meshId, meshNodeId: 'node', launchedByCoordinator: true }, ...extra });
const record = (extra: any = {}) => ({ sessionId: 'worker', lifecycle: 'running', surfaceKind: 'live_runtime', lastActivityAt: now - 1000,
    meta: { meshNodeFor: meshId, meshNodeId: 'node', launchedByCoordinator: true }, state: state(), ...extra });
let store: any;
beforeEach(() => {
    tasks = []; remotes = []; outputs = new Map(); attempts = new Map(); journalPending = false;
    claim.mockReset().mockReturnValue(true); resetSessionStopRetries();
    store = {
        getQueueEntries: (_mesh: string, statuses?: string[]) => tasks.filter(t => !statuses || statuses.includes(t.status)),
        getRemoteIdleSessions: () => remotes, getActiveDirectDispatches: () => [],
        getLatestTaskOutput: (id: string) => outputs.get(id),
        findQueueEntryById: (_mesh: string, id: string) => tasks.find(t => t.id === id),
        turnStore: () => ({ listWorkerEventsForTask: () => [], findPresentationAttemptForSession: (id: string) => attempts.has(id) ? { attempt: attempts.get(id) } : null }),
        db: { prepare: () => ({ get: () => journalPending ? { found: 1 } : undefined }) },
    };
    vi.spyOn(MeshRuntimeStore, 'getInstance').mockReturnValue(store);
});
afterEach(() => vi.restoreAllMocks());

function accept(id = 'task') {
    tasks.push({ id, status: 'completed', assignedSessionId: 'worker' });
    outputs.set(id, { envelopeJson: JSON.stringify({ evidence: { summarySource: 'tool_report' }, source: { session_id: 'worker' } }) });
    attempts.set('worker', { meshId, taskId: id, state: 'completed', terminal: { outcome: 'completed' }, data: {} });
}

describe('durable accepted completion', () => {
    it('reaps accepted completion after restarting the lifetime state, with TTL disabled', async () => {
        accept(); resetSessionStopRetries();
        const cleanup = vi.fn(async () => ({ success: true, stoppedSessionIds: ['worker'] }));
        const result = await runIdleSessionReapPass({ listSessions: async () => [record()], cleanupMeshSessions: cleanup },
            { meshId, now, policy: { delegatedSessionIdleTtlMinutes: 0, maxIdleDelegatedSessionsPerMachine: 0 } });
        expect(result.stoppedSessionIds).toEqual(['worker']);
        expect(result.plan.reap[0].reason).toBe('accepted_completion');
    });
    it('does not interpret refused or provider-only evidence as acceptance', () => {
        accept(); outputs.get('task').envelopeJson = JSON.stringify({ evidence: { summarySource: 'native' }, source: { session_id: 'worker' } });
        expect([...acceptedCompletionSessionIds(meshId, tasks)]).toEqual([]);
    });
    it('preserves a queued targeted follow-up, even before it can claim', async () => {
        accept(); tasks.push({ id: 'followup', status: 'pending', targetSessionId: 'worker', targetNodeId: 'node', dependsOn: ['task'] });
        const cleanup = vi.fn();
        const result = await runIdleSessionReapPass({ listSessions: async () => [record()], cleanupMeshSessions: cleanup }, { meshId, now, policy: undefined });
        expect(result.stoppedSessionIds).toEqual([]); expect(cleanup).not.toHaveBeenCalled();
    });
    it('does not retain a completed worker for a contradictory branch/node pin', async () => {
        accept(); tasks.push({ id: 'other-branch', status: 'pending', targetSessionId: 'worker', targetNodeId: 'different-worktree' });
        const result = await runIdleSessionReapPass({ listSessions: async () => [record()],
            cleanupMeshSessions: async () => ({ success: true, stoppedSessionIds: ['worker'] }) }, { meshId, now, policy: undefined });
        expect(result.stoppedSessionIds).toEqual(['worker']);
    });
    it('honors the explicit acceptance opt-out without disabling the idle cap', async () => {
        accept();
        const result = await runIdleSessionReapPass({ listSessions: async () => [record()], cleanupMeshSessions: vi.fn() },
            { meshId, now, policy: { stopDelegatedSessionOnAcceptedCompletion: false } });
        expect(result.stoppedSessionIds).toEqual([]);
    });
    it('does not let old accepted output terminate a newer or stopping attempt', () => {
        accept(); attempts.set('worker', { meshId, taskId: 'new-task', state: 'generating', data: {} });
        expect([...acceptedCompletionSessionIds(meshId, tasks)]).toEqual([]);
        expect(sessionCheckpointPending('worker')).toBe(true);
        attempts.set('worker', { meshId, taskId: 'task', terminal: {}, state: 'stopping', data: { writerStop: { confirmed: false } } });
        expect([...acceptedCompletionSessionIds(meshId, tasks)]).toEqual([]);
        expect(sessionCheckpointPending('worker')).toBe(true);
    });
    it('normalizes defaults and invalid caps', () => {
        expect(resolveMeshPolicy(undefined)).toMatchObject({ maxIdleDelegatedSessionsPerMachine: 2, stopDelegatedSessionOnAcceptedCompletion: true });
        expect(resolveMeshPolicy({ maxIdleDelegatedSessionsPerMachine: -10 }).maxIdleDelegatedSessionsPerMachine).toBe(0);
        expect(resolveMeshPolicy({ maxIdleDelegatedSessionsPerMachine: 1000 }).maxIdleDelegatedSessionsPerMachine).toBe(100);
        expect(resolveMeshPolicy({ maxIdleDelegatedSessionsPerMachine: NaN }).maxIdleDelegatedSessionsPerMachine).toBe(2);
    });
});

describe('machine cap', () => {
    it('aggregates sibling nodes on a machine and keeps separate machine budgets', () => {
        const records = [record({ sessionId: 'old', machineId: 'a', lastActivityAt: now - 3000 }),
            record({ sessionId: 'new', machineId: 'a', meta: { ...record().meta, meshNodeId: 'other-node' } }),
            record({ sessionId: 'remote', machineId: 'b' })];
        const plan = planIdleSessionReap({ meshId, records, now, ttlMs: 0, maxIdleSessions: 1, activeWorkSessionIds: new Set() });
        expect(plan.reap.map(r => r.sessionId)).toEqual(['old']);
    });
    it('counts safe idle workers across local meshes without acting on another mesh in this pass', () => {
        const plan = planIdleSessionReap({ meshId, records: [record({ sessionId: 'old', lastActivityAt: now - 5000 }),
            record({ sessionId: 'other', meta: { ...record().meta, meshNodeFor: 'another-mesh' } })],
            now, ttlMs: 0, maxIdleSessions: 1, activeWorkSessionIds: new Set() });
        expect(plan.reap.map(r => r.sessionId)).toEqual(['old']);
    });
});

describe('host safety recheck', () => {
    it.each([
        state({ status: 'generating', activeChat: { status: 'waiting_input' } }),
        state({ activeChat: { activeModal: { type: 'approval' } } }),
        state({ activeChat: { activeInteractivePrompt: { promptId: 'question' } } }),
        state({ settings: { ...state().settings, assistant: true } }),
        state({ settings: { ...state().settings, meshCoordinatorFor: meshId } }),
        undefined,
    ])('refuses a stale owner stop when host state changed: %j', async s => {
        const stop = vi.fn();
        const host: any = { deps: { idleSessionLifetimeControl: { listSessions: async () => [record()], stopSession: stop },
            getInstanceManager: () => ({ getByCategory: () => s ? [{ getState: () => s }] : [] }) } };
        const result = await idleSessionLifetimeCommand(host, { action: 'mesh_idle_session_stop', targetSessionId: 'worker', meshContext: { meshId }, idleSessionLifetime: { lastActivityAt: now - 1000 } });
        expect(result.success).toBe(false); expect(stop).not.toHaveBeenCalled();
    });
    it('wires authenticated agent_command lifetime actions to the guarded host executor', async () => {
        const stop = vi.fn(async () => ({ lifecycle: 'stopped' }));
        const host: any = { deps: { idleSessionLifetimeControl: { listSessions: async () => [record()], stopSession: stop },
            getInstanceManager: () => ({ getByCategory: () => [{ getState: () => state() }] }) } };
        const result = await agentCommand(host, { action: 'mesh_idle_session_stop', agentType: 'mesh', targetSessionId: 'worker',
            meshContext: { meshId }, idleSessionLifetime: { lastActivityAt: now - 1000 } });
        expect(result).toMatchObject({ success: true, stoppedSessionIds: ['worker'] });
        expect(stop).toHaveBeenCalledWith('worker');
    });
    it('requires a confirmed host stop and protects an outstanding physical checkpoint', async () => {
        const stop = vi.fn(async () => ({ lifecycle: 'running' }));
        const host: any = { deps: { idleSessionLifetimeControl: { listSessions: async () => [record()], stopSession: stop },
            getInstanceManager: () => ({ getByCategory: () => [{ getState: () => state() }] }) } };
        const args: any = { action: 'mesh_idle_session_stop', targetSessionId: 'worker', meshContext: { meshId }, idleSessionLifetime: { lastActivityAt: now - 1000 } };
        expect((await idleSessionLifetimeCommand(host, args)).success).toBe(false);
        expect(stop).toHaveBeenCalledOnce(); stop.mockClear(); journalPending = true;
        expect((await idleSessionLifetimeCommand(host, args)).success).toBe(false); expect(stop).not.toHaveBeenCalled();
    });
});

describe('idle reuse', () => {
    it.each([false, true])('auto-launch adopts existing same-node/provider worker before slot/spawn admission (review=%s)', async review => {
        tasks.push({ id: 'queued', status: 'pending', readonly: true, targetNodeId: 'node', ...(review ? { review: { sourceTaskId: 'prior' } } : {}) });
        const components: any = { instanceManager: { getByCategory: () => [{ getState: () => state() }] }, router: { execute: vi.fn() } };
        expect(await maybeAutoLaunchOneQueueSession(components, meshId, { id: meshId, policy: {}, nodes: [] })).toBe(true);
        expect(claim).toHaveBeenCalledWith(components, meshId, 'node', 'worker', 'codex-cli', undefined, undefined, 'auto_launch_reuse');
        expect(components.router.execute).not.toHaveBeenCalled();
    });
    it('adopts a fresh remote idle session through the same claim authority', () => {
        remotes.push({ nodeId: 'remote-node', sessionId: 'remote-worker', providerType: 'kimi' });
        expect(reuseIdleTaskSession({ instanceManager: { getByCategory: () => [] } } as any, meshId, { targetNodeId: 'remote-node' } as any, claim)).toBe('claimed');
        expect(claim.mock.calls[0].slice(2, 5)).toEqual(['remote-node', 'remote-worker', 'kimi']);
    });
    it('does not reuse protected/generating/other-node sessions', () => {
        const components: any = { instanceManager: { getByCategory: () => [{ getState: () => state({ status: 'generating', activeChat: { status: 'waiting_input' } }) }] } };
        expect(reuseIdleTaskSession(components, meshId, {} as any, claim)).toBe('none');
        remotes.push({ nodeId: 'wrong-node', sessionId: 'remote-worker', providerType: 'kimi' });
        expect(reuseIdleTaskSession(components, meshId, { targetNodeId: 'node' } as any, claim)).toBe('none');
        expect(claim).not.toHaveBeenCalled();
    });
});

describe('peer lifetime retry and acknowledgement', () => {
    const mesh = { id: meshId, nodes: [{ id: 'remote-node', daemonId: 'daemon_mach_peer', machineId: 'mach_peer' }] };
    const components = (dispatch: any): any => ({ instanceManager: { getByCategory: () => [] },
        router: { deps: { sessionHostControl: { listSessions: async () => [] } }, recordIntentionalMeshSessionStop: vi.fn(async () => {}) },
        dispatchMeshCommand: dispatch });
    it('retries P2P inventory with backoff, then stops the accepted remote worker', async () => {
        accept(); tasks[0].assignedNodeId = 'remote-node'; tasks[0].assignedProviderType = 'codex-cli'; tasks[0].createdAt = '2026-10-26';
        remotes.push({ nodeId: 'remote-node', sessionId: 'worker', providerType: 'codex-cli' });
        const dispatch = vi.fn().mockRejectedValueOnce(new Error('P2P unavailable')).mockImplementation(async (_peer, _command, args) =>
            args.action === 'mesh_idle_session_inventory' ? { result: { success: true, sessions: [record()] } }
                : { success: true, stoppedSessionIds: ['worker'] });
        const c = components(dispatch);
        expect((await runIdleSessionReapPass(sessionLifetimeDeps(c, mesh, now), { meshId, now, policy: undefined })).stoppedSessionIds).toEqual([]);
        await runIdleSessionReapPass(sessionLifetimeDeps(c, mesh, now + 1000), { meshId, now: now + 1000, policy: undefined });
        expect(dispatch).toHaveBeenCalledTimes(1);
        const result = await runIdleSessionReapPass(sessionLifetimeDeps(c, mesh, now + 60_000), { meshId, now: now + 60_000, policy: undefined });
        expect(result.stoppedSessionIds).toEqual(['worker']);
        expect(dispatch.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'mesh_idle_session_stop', targetSessionId: 'worker', idleSessionLifetime: { lastActivityAt: now - 1000 } });
    });
    it('does not mistake a remote stop refusal for success', async () => {
        accept(); remotes.push({ nodeId: 'remote-node', sessionId: 'worker', providerType: 'codex-cli' });
        const dispatch = vi.fn(async (_peer, _command, args) => args.action === 'mesh_idle_session_inventory'
            ? { success: true, sessions: [record()] } : { success: false, error: 'session host unavailable' });
        const c = components(dispatch);
        const result = await runIdleSessionReapPass(sessionLifetimeDeps(c, mesh, now), { meshId, now, policy: undefined });
        expect(result.stoppedSessionIds).toEqual([]);
        await runIdleSessionReapPass(sessionLifetimeDeps(c, mesh, now + 1000), { meshId, now: now + 1000, policy: undefined });
        expect(dispatch.mock.calls.filter(c => c[2].action === 'mesh_idle_session_stop')).toHaveLength(1);
    });
    it('tries a newer live anchor after a historical worker was stopped', async () => {
        remotes.push({ nodeId: 'remote-node', sessionId: 'gone', providerType: 'codex-cli' }, { nodeId: 'remote-node', sessionId: 'worker', providerType: 'codex-cli' });
        const dispatch = vi.fn(async (_peer, _command, args) => args.targetSessionId === 'gone'
            ? { success: false, error: 'mesh_session_not_mesh_owned' } : { success: true, sessions: [record()] });
        const records = await sessionLifetimeDeps(components(dispatch), mesh, now).listSessions();
        expect(records.map(r => r.sessionId)).toEqual(['worker']); expect(dispatch).toHaveBeenCalledTimes(2);
    });
});

describe('lifetime stop race', () => {
    it('rechecks a follow-up queued while remote inventory was in flight', async () => {
        remotes.push({ nodeId: 'remote-node', sessionId: 'worker', providerType: 'codex-cli' });
        const dispatch = vi.fn(async () => ({ success: true, sessions: [record()] }));
        const intentional = vi.fn();
        const c: any = { router: { deps: { sessionHostControl: { listSessions: async () => [] } }, recordIntentionalMeshSessionStop: intentional },
            dispatchMeshCommand: dispatch };
        const deps = sessionLifetimeDeps(c, { id: meshId, nodes: [{ id: 'remote-node', daemonId: 'daemon_mach_peer', machineId: 'mach_peer' }] }, now);
        await deps.listSessions();
        tasks.push({ status: 'pending', targetSessionId: 'worker', targetNodeId: 'node' });
        const result = await deps.cleanupMeshSessions({ meshId, nodeId: '', node: undefined, mode: 'stop', sessionIds: ['worker'], source: 'mesh_cleanup_sessions' });
        expect(result.success).toBe(false); expect(intentional).not.toHaveBeenCalled();
        expect(dispatch).toHaveBeenCalledTimes(1);
    });
});
